/*
 * GBA Cart Dumper payload for GBLink Cart Doctor.
 *
 * Ported from FIX94's GBA Link Cable Dumper v1.6 (wii-gba-link-cable-dumper,
 * MIT license, Copyright (C) 2016 FIX94) — the JOY-bus link to a GameCube/Wii
 * is replaced by a 32-bit normal-mode SIO (SPI slave) link to the GBLink USB
 * adapter, which clocks one 32-bit word per exchange at ~1 MHz with a 36 µs
 * inter-word gap (the same transport the multiboot upload itself uses).
 *
 * Cartridge access (ROM size probe, save type probe, EEPROM/SRAM/Flash
 * read/write in libSave.c, Dark Fader's BIOS dump trick) is kept from the
 * original.
 *
 * This software may be modified and distributed under the terms
 * of the MIT license. See the LICENSE file of wii-gba-link-cable-dumper.
 */
#include <gba.h>
#include <stdio.h>
#include <stdlib.h>
#include "libSave.h"

#define REG_WAITCNT *(vu16 *)(REG_BASE + 0x204)

/* SIOCNT bits for normal 32-bit mode. Local names — libgba's gba_sio.h
 * covers multiplayer mode but not these. */
#define LNK_SHIFT_EXT   0x0000  /* bit0 = 0: external shift clock (slave) */
#define LNK_SO_INACT_HI 0x0008  /* bit3: SO high while inactive */
#define LNK_START       0x0080  /* bit7: start/busy */
#define LNK_32BIT       0x1000  /* bit12: 32-bit transfers */

#define LNK_BASE (LNK_SHIFT_EXT | LNK_SO_INACT_HI | LNK_32BIT)

/*
 * Protocol words. Master->GBA control words carry 0x4742 ("GB") in the high
 * half so a torn word (the master clocking while we arm mid-word) can never
 * be mistaken for a command; GBA->master magics deliberately avoid that high
 * half. While we are unarmed (busy with the cart) the master reads a constant
 * 0xFFFFFFFF (SO inactive high), which the web client treats as "busy".
 */
#define M_MAGIC_MASK 0xFFFF0000
#define M_MAGIC      0x47420000
#define M_POLL       0x00000000 /* also "continue" inside a dump stream    */
#define M_GO         0x4742600D /* commit a command after the echo check   */
#define M_CONT       0x4742C047 /* leave a DONE gate / section verdict: ok */
#define M_FAIL       0x4742BAD0 /* section verdict: checksum bad, resend   */
#define M_ABORT      0x4742AB0B /* abandon the operation, return to idle   */

#define G_READY      0x52454459 /* "REDY" — idle, listening for a command  */
#define G_DONE       0x444F4E45 /* "DONE" — slow phase finished, gate open */
#define G_OKOK       0x4F4B4F4B /* "OKOK" — restore section checksum ok    */
#define G_FAIL       0x4641494C /* "FAIL" — restore section checksum bad   */

/* Command numbers (low half of a 0x4742xxxx word). 1-5 match the original
 * Wii dumper vocabulary; 6 is new (cart info: sizes + header). */
#define CMD_DUMP_ROM  1
#define CMD_DUMP_SAVE 2
#define CMD_RESTORE   3
#define CMD_ERASE     4
#define CMD_DUMP_BIOS 5
#define CMD_INFO      6
#define CMD_MAX       6

#define SECTION_BYTES 0x100
#define SECTION_WORDS (SECTION_BYTES / 4)

u8 save_data[0x20000] __attribute__ ((section (".sbss")));

s32 getGameSize(void)
{
	if(*(vu32*)(0x08000004) != 0x51AEFF24)
		return -1;
	s32 i;
	for(i = (1<<20); i < (1<<25); i<<=1)
	{
		vu16 *rompos = (vu16*)(0x08000000+i);
		int j;
		bool romend = true;
		for(j = 0; j < 0x1000; j++)
		{
			if(rompos[j] != j)
			{
				romend = false;
				break;
			}
		}
		if(romend) break;
	}
	return i;
}

/* Unarmed: the master reads the SO-inactive level (0xFFFFFFFF) and knows we
 * are busy. Any clocking it does while we are unarmed is ignored by the
 * hardware — no data shifts without the start bit. */
static void linkIdle(void)
{
	REG_SIOCNT = LNK_BASE;
}

static void linkInit(void)
{
	REG_RCNT = 0; /* normal serial mode */
	linkIdle();
}

/* Arm one word and block until the master has clocked the exchange.
 * Returns the word the master sent. */
static u32 linkXfer(u32 out)
{
	REG_SIODATA32 = out;
	REG_SIOCNT = LNK_BASE | LNK_START;
	while(REG_SIOCNT & LNK_START) ;
	return REG_SIODATA32;
}

/* If we arm while the master is mid-word, the shift counter desyncs and every
 * later exchange is bit-shifted. Recovery: after an invalid word, stay unarmed
 * longer than one master word (~33 µs at ~1 MHz) so any in-flight word runs
 * out against an unarmed (deaf) slave, then re-arm in the quiet gap. The web
 * client polls idle/busy states at millisecond cadence, so the gap is wide. */
static void linkDesyncGuard(void)
{
	linkIdle();
	volatile int g;
	for(g = 0; g < 600; g++) ; /* ~100-200 µs */
}

/* Busy -> data gate. Re-arm G_DONE until the master explicitly acknowledges
 * with M_CONT: a torn G_DONE just makes the master poll again, and we do not
 * advance state on a word the master never saw. Returns false on M_ABORT. */
static bool linkDoneGate(void)
{
	while(1)
	{
		u32 rx = linkXfer(G_DONE);
		if(rx == M_CONT)
			return true;
		if(rx == M_ABORT)
			return false;
		/* M_POLL (or a torn word): master hasn't seen DONE yet */
	}
}

/* Stream len bytes to the master in 256-byte sections, each followed by an
 * XOR32 checksum word and a verdict word from the master (M_CONT = next
 * section, M_FAIL = resend this section, anything else = abort). */
static bool streamToMaster(const u8 *base, u32 len)
{
	u32 off = 0;
	while(off < len)
	{
		u32 xsum = 0;
		u32 w;
		for(w = 0; w < SECTION_WORDS; w++)
		{
			u32 v = *(vu32*)(base + off + w*4);
			xsum ^= v;
			if(linkXfer(v) == M_ABORT)
				return false;
		}
		linkXfer(xsum);
		u32 verdict = linkXfer(0);
		if(verdict == M_CONT)
			off += SECTION_BYTES;
		else if(verdict != M_FAIL)
			return false;
	}
	return true;
}

/* Receive len bytes from the master in 256-byte sections. After each section
 * the master sends its XOR32; we answer G_OKOK/G_FAIL while the master sends
 * M_CONT ("proceed per your verdict") or M_ABORT in the same exchange. On
 * G_FAIL + M_CONT the master resends the section and we overwrite it. */
static bool streamFromMaster(u8 *base, u32 len)
{
	u32 off = 0;
	while(off < len)
	{
		u32 xsum = 0;
		u32 w;
		for(w = 0; w < SECTION_WORDS; w++)
		{
			u32 v = linkXfer(0);
			*(vu32*)(base + off + w*4) = v;
			xsum ^= v;
		}
		u32 theirs = linkXfer(0);
		bool ok = (theirs == xsum);
		u32 ack = linkXfer(ok ? G_OKOK : G_FAIL);
		if(ack != M_CONT)
			return false;
		if(ok)
			off += SECTION_BYTES;
	}
	return true;
}

static void readSave(u32 savesize)
{
	switch (savesize){
	case 0x200:
		GetSave_EEPROM_512B(save_data);
		break;
	case 0x2000:
		GetSave_EEPROM_8KB(save_data);
		break;
	case 0x8000:
		GetSave_SRAM_32KB(save_data);
		break;
	case 0x10000:
		GetSave_FLASH_64KB(save_data);
		break;
	case 0x20000:
		GetSave_FLASH_128KB(save_data);
		break;
	default:
		break;
	}
}

static void writeSave(u32 savesize)
{
	switch (savesize){
	case 0x200:
		PutSave_EEPROM_512B(save_data);
		break;
	case 0x2000:
		PutSave_EEPROM_8KB(save_data);
		break;
	case 0x8000:
		PutSave_SRAM_32KB(save_data);
		break;
	case 0x10000:
		PutSave_FLASH_64KB(save_data);
		break;
	case 0x20000:
		PutSave_FLASH_128KB(save_data);
		break;
	default:
		break;
	}
}

static void dumpBiosToBuffer(void)
{
	u32 i;
	for (i = 0; i < 0x4000; i+=4)
	{
		/* the lower bits are inaccurate, so just get it four times :) */
		u32 a = MidiKey2Freq((WaveData *)(i-4), 180-12, 0) * 2;
		u32 b = MidiKey2Freq((WaveData *)(i-3), 180-12, 0) * 2;
		u32 c = MidiKey2Freq((WaveData *)(i-2), 180-12, 0) * 2;
		u32 d = MidiKey2Freq((WaveData *)(i-1), 180-12, 0) * 2;
		/* Same packing as the original dumper: over the JOY bus this word
		 * reached the host low byte first, and the GBLink SIO32 path hands
		 * the host this same u32, which the web client writes out
		 * little-endian — so the byte order on disk is identical. */
		*(vu32*)(save_data + i) =
			((a>>24<<24) | (d>>24<<16) | (c>>24<<8) | (b>>24));
	}
}

static void status(const char *msg)
{
	iprintf("%s\n", msg);
}

int main(void) {
	consoleDemoInit();

	iprintf("\x1b[2;2HGBA Cart Doctor payload v1.0\n");
	iprintf("\x1b[3;2H(FIX94's dumper, SIO32 port)\n");
	iprintf("\x1b[5;2HControlled from the browser -\n");
	iprintf("\x1b[6;2Hkeep the link cable connected.\n");
	iprintf("\x1b[8;0H");

	/* Everything is polled; no interrupt source is ever enabled. */
	REG_IME = 0;

	/* disable this, needs power */
	SNDSTAT = 0;
	SNDBIAS = 0;
	/* Set up waitstates for EEPROM access etc. */
	REG_WAITCNT = 0x0317;

	linkInit();

	while (1) {
		/* Idle: armed with G_READY, waiting for a command word. */
		u32 rx = linkXfer(G_READY);
		if((rx & M_MAGIC_MASK) != M_MAGIC)
		{
			/* Not a command — a poll (0) is normal, anything else may
			 * be a torn word, so realign before re-arming. */
			if(rx != M_POLL)
				linkDesyncGuard();
			continue;
		}
		u32 cmd = rx & 0xFFFF;
		if(cmd == 0 || cmd > CMD_MAX)
			continue; /* ping (0), or a stray control word — stay idle */

		/* Echo-confirm: prove we decoded the command before acting. The
		 * master commits with M_GO, anything else cancels. */
		if(linkXfer(~(M_MAGIC | cmd)) != M_GO)
			continue;

		if(cmd == CMD_DUMP_BIOS)
		{
			status("Dumping BIOS...");
			linkIdle();
			dumpBiosToBuffer();
			if(!linkDoneGate())
				continue;
			streamToMaster(save_data, 0x4000);
			status("BIOS dump finished.");
			continue;
		}

		/* All cart commands re-probe the cartridge — the user may have
		 * swapped carts since the last operation. */
		linkIdle();
		if(cmd == CMD_INFO)
			status("Reading cartridge...");
		s32 gamesize = getGameSize();
		u32 savesize = (cmd == CMD_DUMP_ROM) ? 0
			: SaveSize(save_data, gamesize);

		if(!linkDoneGate())
			continue;
		linkXfer((u32)gamesize);
		if(cmd != CMD_DUMP_ROM)
			linkXfer(savesize);

		if(gamesize == -1)
		{
			status("No cartridge found.");
			continue;
		}

		if(cmd == CMD_INFO)
		{
			u32 i;
			for(i = 0; i < 0xC0; i += 4)
				linkXfer(*(vu32*)(0x08000000 + i));
			status("Cartridge identified.");
		}
		else if(cmd == CMD_DUMP_ROM)
		{
			status("Dumping ROM...");
			if(streamToMaster((const u8*)0x08000000, (u32)gamesize))
				status("ROM dump finished.");
			else
				status("ROM dump aborted.");
		}
		else if(cmd == CMD_DUMP_SAVE)
		{
			if(savesize == 0)
				continue;
			status("Reading save from cart...");
			linkIdle();
			readSave(savesize);
			if(!linkDoneGate())
				continue;
			if(streamToMaster(save_data, savesize))
				status("Save dump finished.");
			else
				status("Save dump aborted.");
		}
		else if(cmd == CMD_RESTORE || cmd == CMD_ERASE)
		{
			if(savesize == 0)
				continue;
			/* The master validates sizes and commits with M_GO. */
			if(linkXfer(0) != M_GO)
				continue;
			if(cmd == CMD_RESTORE)
			{
				status("Receiving save data...");
				if(!streamFromMaster(save_data, savesize))
				{
					status("Restore aborted.");
					continue;
				}
			}
			else
			{
				u32 i;
				for(i = 0; i < savesize; i += 4)
					*(vu32*)(save_data + i) = 0;
			}
			status("Writing save to cart...");
			linkIdle();
			writeSave(savesize);
			if(!linkDoneGate())
				continue;
			status(cmd == CMD_RESTORE ?
				"Save restored." : "Save erased.");
		}
	}
}
