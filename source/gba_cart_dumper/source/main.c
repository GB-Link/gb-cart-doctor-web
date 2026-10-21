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
#include "cartops.h"

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

/* ROM dump stream (streamRom). The master's poll word has no rotational
 * symmetry, so a shifted (torn) poll can never read as a valid one. */
#define M_SPOLL      0x47425EED /* stream poll: keep sending                */
#define M_FIN        0x4742F1A1 /* stream complete, return to idle          */
#define M_SEEK       0x53000000 /* | section: resume the stream there       */
#define R_DATA       0xDA000000 /* | section: 64 data words + check follow  */
#define R_FILL       0xF1000000 /* | section: value, count, check follow    */
#define R_END        0xE0000000 /* | section count: nothing left to send    */
#define G_SYNC       0x53594E43 /* "SYNC" — lost word alignment, need a seek */

/* Command numbers (low half of a 0x4742xxxx word). 1-5 match the original
 * Wii dumper vocabulary; 6 is new (cart info: sizes + header); 7 runs a
 * cart op program from the browser (flash cart writing, see cartops.h). */
#define CMD_DUMP_ROM  1
#define CMD_DUMP_SAVE 2
#define CMD_RESTORE   3
#define CMD_ERASE     4
#define CMD_DUMP_BIOS 5
#define CMD_INFO      6
#define CMD_CART_RUN  7
#define CMD_MAX       7

#define SECTION_BYTES 0x100
#define SECTION_WORDS (SECTION_BYTES / 4)

u8 save_data[0x20000] __attribute__ ((section (".sbss"), aligned (4)));

#define OPS_RESULT_WORDS 0x1000
static u32 opsResult[OPS_RESULT_WORDS] __attribute__ ((section (".sbss")));

/* The ROM ends where the cart stops answering (open bus reads back the
 * address) or, on carts whose chip is smaller than the 32 MB window, where
 * its contents repeat: the whole 0xC0-byte header shows up again. */
static bool romMirrorsAt(s32 i)
{
	vu32 *rom = (vu32*)0x08000000;
	vu32 *at = (vu32*)(0x08000000 + i);
	int j;
	for(j = 0; j < 0xC0 / 4; j++)
		if(at[j] != rom[j])
			return false;
	return true;
}

s32 getGameSize(void)
{
	if(*(vu32*)(0x08000004) != 0x51AEFF24)
		return -1;
	s32 i;
	for(i = (1<<16); i < (1<<25); i<<=1)
	{
		if(romMirrorsAt(i))
			break;
		if(i < (1<<20))
			continue;
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
static inline __attribute__((always_inline)) void linkIdle(void)
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
static inline __attribute__((always_inline)) u32 linkXfer(u32 out)
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
static inline __attribute__((always_inline)) void linkDesyncGuard(void)
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

/* A run of consecutive sections that each hold one repeated word (erased
 * flash, padding). The ROM dump sends a run as one short fill record. */
typedef struct { u32 start, count, value; } FillRun;
#define MAX_FILL_RUNS (sizeof(save_data) / sizeof(FillRun))

static u32 IWRAM_CODE __attribute__((noinline)) findFillRuns(u32 sections, FillRun *runs, u32 maxRuns)
{
	u32 n = 0, s;
	for(s = 0; s < sections; s++)
	{
		const u32 *p = (const u32 *)(0x08000000 + s * SECTION_BYTES);
		u32 v = p[0], w;
		for(w = 1; w < SECTION_WORDS; w++)
			if(p[w] != v)
				break;
		if(w < SECTION_WORDS)
			continue;
		if(n && runs[n-1].value == v && runs[n-1].start + runs[n-1].count == s)
			runs[n-1].count++;
		else if(n < maxRuns)
		{
			runs[n].start = s;
			runs[n].count = 1;
			runs[n].value = v;
			n++;
		}
	}
	return n;
}

/* Index of the first run starting at or after section s. */
static inline __attribute__((always_inline)) u32 fillRunFrom(const FillRun *runs, u32 n, u32 s)
{
	u32 lo = 0, hi = n;
	while(lo < hi)
	{
		u32 mid = (lo + hi) >> 1;
		if(runs[mid].start < s)
			lo = mid + 1;
		else
			hi = mid;
	}
	return lo;
}

#define ROT1(c) (((c) << 1) | ((c) >> 31))

/*
 * Stream the ROM as self-describing records, with no per-section round trip:
 *   data: R_DATA|section, 64 words, check
 *   fill: R_FILL|section, value, count, check
 *   end:  R_END|sections, repeated until the master finishes
 * check folds every record word with c = rotl(c, 1) ^ word, so a dropped or
 * repeated word fails it. The master polls with M_SPOLL and steers with
 * M_SEEK|section (resume at a section after a bad record), M_FIN or
 * M_ABORT, which may arrive in any exchange. A plain M_POLL means the master
 * is back to idle polling (the page was reloaded mid-dump): stop too.
 * Returns true on M_FIN.
 */
static bool IWRAM_CODE __attribute__((noinline)) streamRom(u32 sections, const FillRun *runs, u32 nruns)
{
	u32 s = 0, fi = 0, rx;
#define SEND(v) do { rx = linkXfer(v); if(rx != M_SPOLL) goto command; } while(0)
	while(1)
	{
		if(s >= sections)
		{
			SEND(R_END | sections);
			continue;
		}
		if(fi < nruns && runs[fi].start == s)
		{
			const FillRun *r = &runs[fi];
			u32 h = R_FILL | s;
			u32 c = ROT1(ROT1(h) ^ r->value) ^ r->count;
			SEND(h);
			SEND(r->value);
			SEND(r->count);
			SEND(c);
			s += r->count;
			fi++;
			continue;
		}
		{
			const vu32 *p = (const vu32 *)(0x08000000 + s * SECTION_BYTES);
			u32 h = R_DATA | s, c = h, w;
			SEND(h);
			for(w = 0; w < SECTION_WORDS; w++)
			{
				u32 v = p[w];
				c = ROT1(c) ^ v;
				SEND(v);
			}
			SEND(c);
			s++;
			continue;
		}
command:
		while(1)
		{
			if(rx == M_FIN)
				return true;
			if(rx == M_ABORT || rx == M_POLL)
				return false;
			if((rx & 0xFF000000) == M_SEEK && (rx & 0xFFFFFF) < sections)
			{
				s = rx & 0xFFFFFF;
				fi = fillRunFrom(runs, nruns, s);
				break;
			}
			/* Not a stream word: we armed mid-word and every exchange
			 * since is shifted. Realign, then wait for a seek. */
			linkDesyncGuard();
			do
				rx = linkXfer(G_SYNC);
			while(rx == M_SPOLL);
		}
	}
#undef SEND
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

	iprintf("\x1b[2;2HGBA Cart Doctor payload v1.3\n");
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

	cartOpsInit();
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

		if(cmd == CMD_CART_RUN)
		{
			/* Length, then its complement: a torn word can never start
			 * a transfer. The browser checks our echo of the length. */
			u32 len = linkXfer(0);
			u32 chk = linkXfer(len);
			if(chk != ~len || len == 0 || len > sizeof(save_data)
				|| (len % SECTION_BYTES))
				continue;
			if(!streamFromMaster(save_data, len))
				continue;
			linkIdle();
			u32 words = cartOpsRun(save_data, len, opsResult, OPS_RESULT_WORDS);
			if(!linkDoneGate())
				continue;
			u32 bytes = (words * 4 + SECTION_BYTES - 1) & ~(SECTION_BYTES - 1);
			linkXfer(bytes);
			streamToMaster((const u8 *)opsResult, bytes);
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
		u32 fillRuns = 0;
		if(cmd == CMD_DUMP_ROM && gamesize > 0)
		{
			status("Scanning ROM...");
			fillRuns = findFillRuns((u32)gamesize / SECTION_BYTES,
				(FillRun *)save_data, MAX_FILL_RUNS);
		}

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
			if(streamRom((u32)gamesize / SECTION_BYTES,
				(const FillRun *)save_data, fillRuns))
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
