/*
 * GBA cart dumper for GB-Link Cart Doctor. The web page sends this program
 * to the GBA over the link cable, then uses it to read and write the
 * cartridge in the slot.
 *
 * Based on FIX94's GBA Link Cable Dumper v1.6 (wii-gba-link-cable-dumper,
 * MIT license, Copyright (C) 2016 FIX94). The original talked to a GameCube
 * or Wii; this version talks to the GB-Link USB adapter instead. The adapter
 * drives the link clock and swaps one 32-bit word with the GBA at a time,
 * at about 1 MHz with a 36 µs pause between words.
 *
 * The cartridge code (finding the ROM size and save type, reading and
 * writing EEPROM, SRAM and Flash saves in libSave.c, and Dark Fader's BIOS
 * dump trick) comes from the original.
 *
 * This software may be modified and distributed under the terms
 * of the MIT license. See the LICENSE file of wii-gba-link-cable-dumper.
 */
#include <gba.h>
#include <stdlib.h>
#include "libSave.h"
#include "cartops.h"
#include "ui.h"

#define REG_WAITCNT *(vu16 *)(REG_BASE + 0x204)

/* Serial control register bits for 32-bit normal mode. libgba only names
 * the multiplayer-mode bits, so these are defined here. */
#define LNK_SHIFT_EXT   0x0000  /* the adapter drives the clock */
#define LNK_SO_INACT_HI 0x0008  /* output line idles high */
#define LNK_START       0x0080  /* ready for a word; clears when it's done */
#define LNK_32BIT       0x1000  /* 32-bit words */

#define LNK_BASE (LNK_SHIFT_EXT | LNK_SO_INACT_HI | LNK_32BIT)

/*
 * Link words. "Master" is the web page, talking through the adapter.
 *
 * Every control word from the page starts with 0x4742 ("GB"). If the GBA
 * gets ready halfway through a word, it receives a garbled, bit-shifted
 * word, and that prefix stops one from being taken as a command. Words the
 * GBA sends never start with 0x4742.
 *
 * When the GBA isn't ready for a word (it's busy with the cartridge), the
 * page reads 0xFFFFFFFF and treats that as "busy".
 */
#define M_MAGIC_MASK 0xFFFF0000
#define M_MAGIC      0x47420000
#define M_POLL       0x00000000 /* "anything to say?"; also "keep going"   */
#define M_GO         0x4742600D /* "yes, run that command"                 */
#define M_CONT       0x4742C047 /* "got it, carry on"                      */
#define M_FAIL       0x4742BAD0 /* "that section was damaged, send again"  */
#define M_ABORT      0x4742AB0B /* "stop and go back to waiting"           */

#define G_READY      0x52454459 /* "REDY": waiting for a command           */
#define G_DONE       0x444F4E45 /* "DONE": finished the slow cart work     */
#define G_OKOK       0x4F4B4F4B /* "OKOK": section arrived intact          */
#define G_FAIL       0x4641494C /* "FAIL": section arrived damaged         */

/* Words used only while streaming a ROM dump (see streamRom). The page's
 * stream poll word is chosen so that no bit-shifted copy of it looks like
 * the real thing. */
#define M_SPOLL      0x47425EED /* "keep sending"                          */
#define M_FIN        0x4742F1A1 /* "I have it all, go back to waiting"     */
#define M_SEEK       0x53000000 /* + section: "carry on from this section" */
#define R_DATA       0xDA000000 /* + section: 64 words and a check follow  */
#define R_FILL       0xF1000000 /* + section: value, count, check follow   */
#define R_END        0xE0000000 /* + section count: the ROM is finished    */
#define G_SYNC       0x53594E43 /* "SYNC": lost track, tell me where to go */

/* Command numbers, sent as 0x4742 plus the number. 1-5 are the original
 * Wii dumper's commands. 6 reads the ROM and save sizes and the cartridge
 * header. 7 runs a small program from the page, used to write flash carts
 * (see cartops.h). */
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

/* Find where the ROM ends. Past the end, an empty cartridge bus reads back
 * its own address. A chip smaller than the 32 MB address space repeats
 * instead, so the 0xC0-byte header shows up again at its size. */
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

/* Stop listening. The page now reads 0xFFFFFFFF and knows we're busy. Any
 * word it clocks in the meantime is ignored by the hardware. */
static inline __attribute__((always_inline)) void linkIdle(void)
{
	REG_SIOCNT = LNK_BASE;
}

static void linkInit(void)
{
	REG_RCNT = 0; /* normal serial mode */
	linkIdle();
}

/* Get ready to swap one word ("arm" the link), then wait until the page
 * has clocked it. Returns the word the page sent. */
static inline __attribute__((always_inline)) u32 linkXfer(u32 out)
{
	REG_SIODATA32 = out;
	REG_SIOCNT = LNK_BASE | LNK_START;
	while(REG_SIOCNT & LNK_START) ;
	return REG_SIODATA32;
}

/* Like linkXfer, but keeps the screen up to date (cartridge in or out)
 * while it waits. Used while waiting for a command. */
static u32 linkXferIdle(u32 out)
{
	REG_SIODATA32 = out;
	REG_SIOCNT = LNK_BASE | LNK_START;
	while(REG_SIOCNT & LNK_START)
		uiIdle();
	return REG_SIODATA32;
}

/* If we get ready halfway through a word, every word after it arrives
 * bit-shifted. To get back in step after a garbled word, stop listening for
 * longer than one word takes (about 33 µs), so any word in flight passes us
 * by, then listen again in the quiet gap. The page only polls every
 * millisecond or so while waiting, so there is plenty of room. */
static inline __attribute__((always_inline)) void linkDesyncGuard(void)
{
	linkIdle();
	volatile int g;
	for(g = 0; g < 600; g++) ; /* ~100-200 µs */
}

/* After slow cartridge work, say DONE until the page answers M_CONT. If the
 * page missed the DONE it just polls again, so we only move on once we know
 * it has seen it. Returns false if the page cancels. */
static bool linkDoneGate(void)
{
	while(1)
	{
		u32 rx = linkXfer(G_DONE);
		if(rx == M_CONT)
			return true;
		if(rx == M_ABORT)
			return false;
		/* a poll or a garbled word: the page hasn't seen DONE yet */
	}
}

/* Send len bytes to the page in 256-byte sections. Each section ends with
 * an XOR checksum, and the page answers M_CONT (next section), M_FAIL (send
 * it again) or anything else (stop). The page waits for that answer to
 * reach the browser before carrying on, which leaves time to draw the
 * progress bar. */
static bool streamToMaster(const u8 *base, u32 len, bool progress)
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
		{
			off += SECTION_BYTES;
			if(progress)
				uiProgress(off, len);
		}
		else if(verdict != M_FAIL)
			return false;
	}
	return true;
}

/* Receive len bytes from the page in 256-byte sections. After each section
 * the page sends its XOR checksum, and we answer G_OKOK or G_FAIL. In that
 * same exchange the page sends M_CONT to carry on or M_ABORT to stop. After
 * a G_FAIL the page sends the section again and we overwrite it. */
static bool streamFromMaster(u8 *base, u32 len, bool progress)
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
		{
			off += SECTION_BYTES;
			if(progress)
				uiProgress(off, len);
		}
	}
	return true;
}

/* A run of sections that are all one repeated word, such as erased flash
 * or padding. The ROM dump sends each run as one short fill record instead
 * of the full data. */
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
 * Send the whole ROM without waiting for an answer after each section. Each
 * record says where it belongs:
 *   data: R_DATA + section, the 64 words, check
 *   fill: R_FILL + section, value, count, check
 *   end:  R_END + section count, repeated until the page is finished
 * The check word mixes in every word of the record (rotate left by one,
 * then XOR), so a lost or doubled word makes it wrong.
 *
 * While all is well the page keeps sending M_SPOLL. Any exchange can carry
 * something else instead: M_SEEK + section to carry on from a section after
 * a damaged record, M_FIN when it has everything, or M_ABORT. A plain M_POLL
 * means the page was reloaded during the dump, so we stop as well. Returns
 * true when the page sends M_FIN.
 *
 * Words are only 36 µs apart, which is too short to draw the progress bar
 * between them. So the bar is drawn right after the next word is made
 * ready, while it waits for the page to clock it.
 */
static bool IWRAM_CODE __attribute__((noinline)) streamRom(u32 sections, const FillRun *runs, u32 nruns)
{
	u32 s = 0, fi = 0, rx;
	bool draw = false;
#define SEND(v) do { \
		REG_SIODATA32 = (v); \
		REG_SIOCNT = LNK_BASE | LNK_START; \
		if(draw) { draw = false; uiProgress(s, sections); } \
		while(REG_SIOCNT & LNK_START) ; \
		rx = REG_SIODATA32; \
		if(rx != M_SPOLL) goto command; \
	} while(0)
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
			draw = true;
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
			draw = true;
			continue;
		}
command:
		while(1)
		{
			if(rx == M_FIN)
				return true;
			if(rx == M_ABORT || rx == M_POLL)
				return false;
			if((rx & 0xFF000000) == M_SEEK && (rx & 0xFFFFFF) <= sections)
			{
				s = rx & 0xFFFFFF;
				fi = fillRunFrom(runs, nruns, s);
				break;
			}
			/* A garbled word: we're out of step with the page. Get
			 * back in step, then wait for it to say where to resume. */
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
		/* Only the top byte of each result is accurate, so read
		 * four times, one byte each. */
		u32 a = MidiKey2Freq((WaveData *)(i-4), 180-12, 0) * 2;
		u32 b = MidiKey2Freq((WaveData *)(i-3), 180-12, 0) * 2;
		u32 c = MidiKey2Freq((WaveData *)(i-2), 180-12, 0) * 2;
		u32 d = MidiKey2Freq((WaveData *)(i-1), 180-12, 0) * 2;
		/* Packed the same way as the original dumper, so the saved
		 * BIOS file has the same byte order. */
		*(vu32*)(save_data + i) =
			((a>>24<<24) | (d>>24<<16) | (c>>24<<8) | (b>>24));
	}
}

int main(void) {
	/* No interrupts: everything is done by polling. */
	REG_IME = 0;

	/* Sound off to save power. */
	SNDSTAT = 0;
	SNDBIAS = 0;
	/* Cartridge timing that suits EEPROM saves and the rest. */
	REG_WAITCNT = 0x0317;

	cartOpsInit();
	linkInit();
	uiInit();

	while (1) {
		/* Wait for a command, answering every poll with READY. */
		u32 rx = linkXferIdle(G_READY);
		uiLinkWord();
		if((rx & M_MAGIC_MASK) != M_MAGIC)
		{
			/* Not a command. A poll (0) is normal; anything else may
			 * be a garbled word, so get back in step first. */
			if(rx != M_POLL)
				linkDesyncGuard();
			continue;
		}
		u32 cmd = rx & 0xFFFF;
		if(cmd == 0 || cmd > CMD_MAX)
			continue; /* a ping (0) or a stray control word */

		/* Send the command back inverted so the page can check we heard
		 * it right. It answers M_GO to go ahead; anything else cancels. */
		if(linkXfer(~(M_MAGIC | cmd)) != M_GO)
			continue;

		if(cmd == CMD_DUMP_BIOS)
		{
			uiActivity(ACT_READ_BIOS);
			linkIdle();
			dumpBiosToBuffer();
			if(!linkDoneGate())
			{
				uiActivity(ACT_STOPPED);
				continue;
			}
			uiActivity(ACT_SEND_BIOS);
			uiActivity(streamToMaster(save_data, 0x4000, true) ?
				ACT_BIOS_DONE : ACT_STOPPED);
			continue;
		}

		if(cmd == CMD_CART_RUN)
		{
			/* The page sends the program's length, then the length
			 * inverted, so a garbled word can't start a transfer. It
			 * also checks the length we send back. The program updates
			 * the screen itself. */
			u32 len = linkXfer(0);
			u32 chk = linkXfer(len);
			if(chk != ~len || len == 0 || len > sizeof(save_data)
				|| (len % SECTION_BYTES))
				continue;
			if(!streamFromMaster(save_data, len, false))
				continue;
			linkIdle();
			u32 words = cartOpsRun(save_data, len, opsResult, OPS_RESULT_WORDS);
			if(!linkDoneGate())
				continue;
			u32 bytes = (words * 4 + SECTION_BYTES - 1) & ~(SECTION_BYTES - 1);
			linkXfer(bytes);
			streamToMaster((const u8 *)opsResult, bytes, false);
			continue;
		}

		/* Every cartridge command checks the cartridge again, in case
		 * it was swapped since last time. */
		linkIdle();
		uiActivity(ACT_READING);
		s32 gamesize = getGameSize();
		u32 savesize = (cmd == CMD_DUMP_ROM) ? 0
			: SaveSize(save_data, gamesize);
		uiCartSizes(gamesize, cmd == CMD_DUMP_ROM ? -1 : (s32)savesize);
		u32 fillRuns = 0;
		if(cmd == CMD_DUMP_ROM && gamesize > 0)
		{
			uiActivity(ACT_SCANNING);
			fillRuns = findFillRuns((u32)gamesize / SECTION_BYTES,
				(FillRun *)save_data, MAX_FILL_RUNS);
		}

		if(!linkDoneGate())
		{
			uiActivity(ACT_STOPPED);
			continue;
		}
		linkXfer((u32)gamesize);
		if(cmd != CMD_DUMP_ROM)
			linkXfer(savesize);

		if(gamesize == -1)
		{
			uiActivity(ACT_NO_CART);
			continue;
		}

		if(cmd == CMD_INFO)
		{
			u32 i;
			for(i = 0; i < 0xC0; i += 4)
				linkXfer(*(vu32*)(0x08000000 + i));
			uiActivity(ACT_CART_READ);
		}
		else if(cmd == CMD_DUMP_ROM)
		{
			uiActivity(ACT_SEND_ROM);
			uiActivity(streamRom((u32)gamesize / SECTION_BYTES,
				(const FillRun *)save_data, fillRuns) ?
				ACT_ROM_DONE : ACT_STOPPED);
		}
		else if(savesize == 0)
		{
			uiActivity(ACT_NO_SAVE);
		}
		else if(cmd == CMD_DUMP_SAVE)
		{
			uiActivity(ACT_READ_SAVE);
			linkIdle();
			readSave(savesize);
			if(!linkDoneGate())
			{
				uiActivity(ACT_STOPPED);
				continue;
			}
			uiActivity(ACT_SEND_SAVE);
			uiActivity(streamToMaster(save_data, savesize, true) ?
				ACT_SAVE_DONE : ACT_STOPPED);
		}
		else if(cmd == CMD_RESTORE || cmd == CMD_ERASE)
		{
			/* The page checks the sizes, then sends M_GO to go ahead. */
			if(linkXfer(0) != M_GO)
			{
				uiActivity(ACT_STOPPED);
				continue;
			}
			if(cmd == CMD_RESTORE)
			{
				uiActivity(ACT_RECV_SAVE);
				if(!streamFromMaster(save_data, savesize, true))
				{
					uiActivity(ACT_STOPPED);
					continue;
				}
			}
			else
			{
				u32 i;
				for(i = 0; i < savesize; i += 4)
					*(vu32*)(save_data + i) = 0;
			}
			uiActivity(cmd == CMD_RESTORE ? ACT_WRITE_SAVE : ACT_ERASE_SAVE);
			linkIdle();
			writeSave(savesize);
			if(!linkDoneGate())
			{
				uiActivity(ACT_STOPPED);
				continue;
			}
			uiActivity(cmd == CMD_RESTORE ? ACT_RESTORED : ACT_ERASED);
		}
	}
}
