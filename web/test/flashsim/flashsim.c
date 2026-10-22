/*
 * A simulated GBA flash cart, for testing flash writing on a PC.
 *
 * Runs the dumper's real cart operations (source/gba_cart_dumper/source/
 * cartops.c) against simulated NOR flash chips, so the page's flash cart code
 * (web/gba_flash.js) can be tested end to end without hardware. It models:
 *   - AMD-style chips: unlock cycles at configurable addresses, ID mode,
 *     CFI, sector and chip erase, single-word and write-buffer programming,
 *     status reads while busy (bit 7 inverted, bit 6 toggling), and bit 5
 *     set when a program fails (bits can only go from 1 to 0).
 *   - Intel/Sharp-style chips: read, ID, CFI and status modes, block lock
 *     bits, block erase, word and buffered programming, status register.
 *   - Cart wiring: swapped data lines (D0/D1, D6/D7, and Burn2Slot's two
 *     full reorderings), two 8-bit chips sharing the 16-bit bus ("double
 *     die"), two interleaved chips (Flash2Advance), and 32 MB banks selected
 *     through SRAM registers.
 *
 * Usage: flashsim key=value ... (the keys are in parseArgs). Requests on stdin:
 *   'R' u32 len, bytes   -> u32 words, words   (run an op buffer)
 *   'D' u32 off, u32 len -> bytes               (linear cart image, banks
 *                                                 concatenated, as the GBA reads it)
 *   'S'                  -> u32 count, stats
 * All integers little-endian.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "gba_types.h"
#include "../../../source/gba_cart_dumper/source/cartops.h"

enum { AMD, INTEL, ROM };

enum {
	A_READ, A_U1, A_U2, A_PROG, A_AUTO, A_CFI, A_E1, A_E2, A_E3,
	A_BCOUNT, A_BLOAD, A_BCONFIRM, A_FAULT,
	I_ARRAY, I_ID, I_CFI, I_SR, I_PROG, I_ERASE, I_LOCK, I_BCOUNT, I_BLOAD, I_BCONFIRM,
};

typedef struct {
	u16 *mem;          /* word contents as stored (chip-side bit order) */
	u8 *locked;        /* per sector, Intel only */
	int st;            /* command state */
	int busy;          /* status reads left before the operation completes */
	u16 busyData;      /* AMD: data being programmed (for DQ7)            */
	int busyErase;
	u16 toggle;
	u16 sr;            /* Intel status register (without the ready bit)   */
	u32 bufBase, bufCount, bufLoaded;
	u32 bufAddr[2048];
	u16 bufData[2048];
} Chip;

static struct {
	int type, cfi, interleave, lanes, idShift, banks, lockedInit, bootTop, bootBottom;
	u32 size;          /* bytes per chip */
	u32 cfiSize;       /* size CFI reports, 0 = the real size */
	int mirror;        /* past the chip: 1 = repeats the chip, 0 = open bus */
	u32 sector;        /* bytes */
	u32 buf;           /* write buffer bytes, 0 = none */
	u16 mfr, dev, dev2, dev3;
	u32 u1, u2;        /* AMD unlock word addresses */
	int busyProg, busyBuf, busyErase, busyChip;
	char wiring[16];
	unsigned seed;
	int fillFF;
} cfgS = {
	.type = AMD, .cfi = 1, .interleave = 0, .lanes = 1, .banks = 1,
	.size = 0x1000000, .sector = 0x10000, .buf = 0,
	.mfr = 0x01, .dev = 0x227E, .dev2 = 0x2221, .dev3 = 0x2201,
	.u1 = 0x555, .u2 = 0x2AA,
	.busyProg = 3, .busyBuf = 12, .busyErase = 1500, .busyChip = 40000,
	.wiring = "none", .seed = 1,
};

static Chip *chips;
static int nChips;
static u8 sram[0x10000];
static int bank;
static long sProg, sBuf, sErase, sChip, sErrors, sOverprog;
static unsigned long tickCalls;

/* ------------------------------------------------------------ data wiring */
/* Burn2Slot's two data line orders: chip pin i is wired to GBA line BUSn[i]. */
static const u8 BUS1[] = {15, 7, 14, 6, 13, 5, 12, 4, 0, 8, 1, 9, 2, 10, 3, 11};
static const u8 BUS2[] = {0, 8, 1, 9, 6, 14, 7, 15, 2, 10, 3, 11, 4, 12, 5, 13};

static u16 swapPair(u16 d, int p, int q)
{
	if (((d >> p) ^ (d >> q)) & 1)
		d ^= (u16)((1 << p) | (1 << q));
	return d;
}
static u16 permTo(const u8 *b, u16 d)
{
	u16 r = 0;
	for (int i = 0; i < 16; i++) r |= (u16)(((d >> i) & 1) << b[i]);
	return r;
}
static u16 permFrom(const u8 *b, u16 d)
{
	u16 r = 0;
	for (int i = 0; i < 16; i++) r |= (u16)(((d >> b[i]) & 1) << i);
	return r;
}
/* GBA data bus -> chip pins */
static u16 toChip(u16 v)
{
	if (!strcmp(cfgS.wiring, "d01")) return swapPair(v, 0, 1);
	if (!strcmp(cfgS.wiring, "d67")) return swapPair(v, 6, 7);
	if (!strcmp(cfgS.wiring, "d01d67")) return swapPair(swapPair(v, 0, 1), 6, 7);
	if (!strcmp(cfgS.wiring, "b2s1")) return permFrom(BUS1, v);
	if (!strcmp(cfgS.wiring, "b2s2")) return permFrom(BUS2, v);
	return v;
}
/* chip pins -> GBA data bus */
static u16 fromChip(u16 v)
{
	if (!strcmp(cfgS.wiring, "b2s1")) return permTo(BUS1, v);
	if (!strcmp(cfgS.wiring, "b2s2")) return permTo(BUS2, v);
	return toChip(v); /* the pair swaps are their own inverse */
}

/* --------------------------------------------------------------- geometry */
static u32 chipWords(void) { return cfgS.size / 2; }

/* sector containing word address w: start word, length in words */
static void sectorOf(u32 w, u32 *start, u32 *len)
{
	const u32 big = cfgS.sector / 2, small = 0x1000; /* 8 KB boot sectors */
	const u32 total = chipWords();
	if (cfgS.bootBottom && w < 8 * small) { *start = w & ~(small - 1); *len = small; return; }
	if (cfgS.bootTop && w >= total - 8 * small) { *start = w & ~(small - 1); *len = small; return; }
	*start = w & ~(big - 1);
	*len = big;
}
static int sectorIndex(u32 w)
{
	u32 s, l;
	sectorOf(w, &s, &l);
	return (int)(s / 0x1000);
}

static int log2u(u32 v) { int n = 0; while ((1u << n) < v) n++; return n; }

/* The chip's CFI (Common Flash Interface) table, one word per address. */
static u16 cfiWord(u32 w)
{
	const u32 big = cfgS.sector;
	const u32 nBig = (cfgS.size - ((cfgS.bootTop || cfgS.bootBottom) ? 0x10000 : 0)) / big;
	const int boot = cfgS.bootTop || cfgS.bootBottom;
	switch (w) {
	case 0x10: return 'Q';
	case 0x11: return 'R';
	case 0x12: return 'Y';
	case 0x13: return cfgS.type == AMD ? 2 : 1;
	case 0x15: return 0x40;
	case 0x1B: return 0x27;
	case 0x1C: return 0x36;
	case 0x1F: return 4;
	case 0x20: return cfgS.buf ? 6 : 0;
	case 0x21: return 9;
	case 0x22: return 0x10;
	case 0x23: case 0x24: case 0x25: case 0x26: return 4;
	case 0x27: return (u16)log2u(cfgS.cfiSize ? cfgS.cfiSize : cfgS.size);
	case 0x28: return 1;
	case 0x2A: return cfgS.buf ? (u16)log2u(cfgS.buf) : 0;
	case 0x2C: return boot ? 2 : 1;
	}
	if (w >= 0x2D && w < 0x35) {
		/* AMD chips list the boot sectors first even when they sit at the
		 * top, and a flag in the extended table says to reverse the list.
		 * Intel chips list regions in address order. */
		u32 r = (w - 0x2D) / 4, k = (w - 0x2D) % 4;
		u32 count, size;
		int smallFirst = boot && (cfgS.type == AMD || cfgS.bootBottom);
		if (!boot) { if (r) return 0; count = nBig; size = big; }
		else if ((r == 0) == smallFirst) { count = 8; size = 0x2000; }
		else { count = nBig; size = big; }
		if (r > 1) return 0;
		u32 c1 = count - 1, s256 = size / 256;
		return (u16)(k == 0 ? c1 & 0xFF : k == 1 ? c1 >> 8 : k == 2 ? s256 & 0xFF : s256 >> 8);
	}
	switch (w) {
	case 0x40: return 'P';
	case 0x41: return 'R';
	case 0x42: return 'I';
	case 0x4F: return cfgS.type == AMD ? (cfgS.bootTop ? 3 : cfgS.bootBottom ? 2 : 0) : 0;
	}
	return 0;
}

/* ------------------------------------------------------------ AMD model */
/* Programming can only turn bits from 1 to 0. Asking for more fails the way
 * a real chip does: it reports an error until it is reset. */
static void amdProgram(Chip *c, u32 w, u16 v, int busy)
{
	u16 old = c->mem[w];
	c->mem[w] = old & v;
	if ((old & v) != v) {
		sOverprog++;
		c->st = A_FAULT;
		c->busyData = v;
		return;
	}
	c->busy = busy;
	c->busyData = v;
	c->busyErase = 0;
}

static void eraseWords(Chip *c, u32 start, u32 len)
{
	for (u32 i = 0; i < len && start + i < chipWords(); i++) c->mem[start + i] = 0xFFFF;
}

static void amdWrite(Chip *c, u32 w, u16 pin)
{
	const u16 cmd = pin & 0xFF;
	switch (c->st) {
	case A_PROG:
		amdProgram(c, w, pin, cfgS.busyProg);
		sProg++;
		if (c->st != A_FAULT) c->st = A_READ;
		return;
	case A_BCOUNT: {
		u32 s, l;
		sectorOf(w, &s, &l);
		c->bufCount = (u32)pin + 1;
		if (s != c->bufBase || c->bufCount > cfgS.buf / 2) { sErrors++; c->st = A_READ; return; }
		c->bufLoaded = 0;
		c->st = A_BLOAD;
		return;
	}
	case A_BLOAD: {
		const u32 page = cfgS.buf / 2;
		if (c->bufLoaded && (w & ~(page - 1)) != (c->bufAddr[0] & ~(page - 1))) {
			sErrors++; c->st = A_READ; return;
		}
		c->bufAddr[c->bufLoaded] = w;
		c->bufData[c->bufLoaded] = pin;
		if (++c->bufLoaded == c->bufCount) c->st = A_BCONFIRM;
		return;
	}
	case A_BCONFIRM: {
		u32 s, l;
		sectorOf(w, &s, &l);
		if (cmd != 0x29 || s != c->bufBase) { sErrors++; c->st = A_READ; return; }
		c->st = A_READ;
		for (u32 i = 0; i < c->bufCount; i++) {
			amdProgram(c, c->bufAddr[i], c->bufData[i], cfgS.busyBuf);
			if (c->st == A_FAULT) return;
		}
		c->busyData = c->bufData[c->bufCount - 1];
		sBuf++;
		return;
	}
	default:
		break;
	}
	if (cmd == 0xF0) { c->st = A_READ; return; }
	switch (c->st) {
	case A_FAULT:
		return;
	case A_READ: case A_AUTO: case A_CFI:
		if (w == cfgS.u1 && cmd == 0xAA) c->st = A_U1;
		else if (w == 0x55 && cmd == 0x98 && cfgS.cfi && c->st != A_CFI) c->st = A_CFI;
		return;
	case A_U1:
		c->st = (w == cfgS.u2 && cmd == 0x55) ? A_U2 : A_READ;
		return;
	case A_U2:
		if (cmd == 0x25 && cfgS.buf) {
			u32 s, l;
			sectorOf(w, &s, &l);
			c->bufBase = s;
			c->st = A_BCOUNT;
			return;
		}
		if (w != cfgS.u1) { c->st = A_READ; return; }
		c->st = cmd == 0x90 ? A_AUTO : cmd == 0xA0 ? A_PROG : cmd == 0x80 ? A_E1 : A_READ;
		return;
	case A_E1:
		c->st = (w == cfgS.u1 && cmd == 0xAA) ? A_E2 : A_READ;
		return;
	case A_E2:
		c->st = (w == cfgS.u2 && cmd == 0x55) ? A_E3 : A_READ;
		return;
	case A_E3:
		if (cmd == 0x30) {
			u32 s, l;
			sectorOf(w, &s, &l);
			eraseWords(c, s, l);
			c->busy = cfgS.busyErase;
			c->busyErase = 1;
			sErase++;
		} else if (cmd == 0x10 && w == cfgS.u1) {
			eraseWords(c, 0, chipWords());
			c->busy = cfgS.busyChip;
			c->busyErase = 1;
			sChip++;
		}
		c->st = A_READ;
		return;
	}
}

static u16 amdRead(Chip *c, u32 w)
{
	if (c->st == A_FAULT) {
		c->toggle ^= 0x40;
		return (u16)((~c->busyData & 0x80) | c->toggle | 0x20);
	}
	if (c->busy) {
		c->busy--;
		c->toggle ^= 0x40;
		u16 dq7 = c->busyErase ? 0 : (u16)(~c->busyData & 0x80);
		return (u16)(dq7 | c->toggle);
	}
	if (c->st == A_AUTO) {
		/* With idshift each ID word appears twice, as on carts that wire
		 * the GBA's address line A1 to the chip's A0. */
		switch (cfgS.idShift ? (w & 0xFF) >> 1 : w & 0xFF) {
		case 0: return cfgS.mfr;
		case 1: return cfgS.dev;
		case 0x0E: return cfgS.dev2;
		case 0x0F: return cfgS.dev3;
		default: return 0;
		}
	}
	if (c->st == A_CFI) return cfiWord(w & 0xFF);
	return c->mem[w];
}

/* ---------------------------------------------------------- Intel model */
static void intelWrite(Chip *c, u32 w, u16 pin)
{
	const u16 cmd = pin & 0xFF;
	int sec = sectorIndex(w);
	switch (c->st) {
	case I_PROG:
		c->st = I_SR;
		sProg++;
		if (c->locked[sec]) { c->sr |= 0x12; return; }
		if ((c->mem[w] & pin) != pin) { sOverprog++; c->sr |= 0x10; }
		c->mem[w] &= pin;
		c->busy = cfgS.busyProg;
		return;
	case I_ERASE:
		c->st = I_SR;
		if (cmd != 0xD0) { c->sr |= 0x30; sErrors++; return; }
		if (c->locked[sec]) { c->sr |= 0x22; return; }
		{ u32 s, l; sectorOf(w, &s, &l); eraseWords(c, s, l); }
		c->busy = cfgS.busyErase;
		sErase++;
		return;
	case I_LOCK:
		c->st = I_SR;
		if (cmd == 0xD0) c->locked[sec] = 0;
		else if (cmd == 0x01) c->locked[sec] = 1;
		else { c->sr |= 0x30; sErrors++; }
		return;
	case I_BCOUNT:
		c->bufCount = (u32)pin + 1;
		if (c->bufCount > cfgS.buf / 2) { c->sr |= 0x30; sErrors++; c->st = I_SR; return; }
		c->bufLoaded = 0;
		c->st = I_BLOAD;
		return;
	case I_BLOAD: {
		const u32 page = cfgS.buf / 2;
		if (c->bufLoaded && (w & ~(page - 1)) != (c->bufAddr[0] & ~(page - 1))) {
			c->sr |= 0x30; sErrors++; c->st = I_SR; return;
		}
		c->bufAddr[c->bufLoaded] = w;
		c->bufData[c->bufLoaded] = pin;
		if (++c->bufLoaded == c->bufCount) c->st = I_BCONFIRM;
		return;
	}
	case I_BCONFIRM:
		c->st = I_SR;
		if (cmd != 0xD0) { c->sr |= 0x30; sErrors++; return; }
		if (c->locked[sectorIndex(c->bufAddr[0])]) { c->sr |= 0x12; return; }
		for (u32 i = 0; i < c->bufCount; i++) {
			u32 a = c->bufAddr[i];
			if ((c->mem[a] & c->bufData[i]) != c->bufData[i]) { sOverprog++; c->sr |= 0x10; }
			c->mem[a] &= c->bufData[i];
		}
		c->busy = cfgS.busyBuf;
		sBuf++;
		return;
	default:
		break;
	}
	switch (cmd) {
	case 0xFF: c->st = I_ARRAY; return;
	case 0xF0: c->st = I_ARRAY; return;
	case 0x90: c->st = I_ID; return;
	case 0x98: if (cfgS.cfi) c->st = I_CFI; return;
	case 0x70: c->st = I_SR; return;
	case 0x50: c->sr = 0; return;
	case 0x40: case 0x10: c->st = I_PROG; return;
	case 0x20: c->st = I_ERASE; return;
	case 0x60: c->st = I_LOCK; return;
	case 0xE8: case 0xEA:
		if (!cfgS.buf) { sErrors++; return; }
		c->st = I_BCOUNT;
		return;
	default:
		return;
	}
}

static u16 intelRead(Chip *c, u32 w)
{
	switch (c->st) {
	case I_ID: return (w & 0xFF) == 0 ? cfgS.mfr : (w & 0xFF) == 1 ? cfgS.dev : 0;
	case I_CFI: return cfiWord(w & 0xFF);
	case I_ARRAY: return c->mem[w];
	case I_BCOUNT: return 0x80; /* the write buffer is free */
	default:
		if (c->busy) { c->busy--; return c->sr; }
		return (u16)(c->sr | 0x80);
	}
}

/* ------------------------------------------------------------ cart bus */
/* Map a GBA ROM byte address (current bank) to a chip and word. With two
 * byte lanes the returned chip is the low lane's; the high lane is next. */
static Chip *route(u32 a, u32 *w)
{
	a &= 0x1FFFFFE;
	if (cfgS.interleave) {
		u32 wa = a >> 2;
		if (wa >= chipWords()) return NULL;
		*w = wa;
		return &chips[bank * 2 + ((a >> 1) & 1)];
	}
	if (a >= cfgS.size && !cfgS.mirror) return NULL;
	*w = (a % cfgS.size) >> 1;
	return &chips[bank * cfgS.lanes];
}

static u16 chipRead(Chip *c, u32 w)
{
	if (cfgS.type == ROM) return c->mem[w];
	return cfgS.type == AMD ? amdRead(c, w) : intelRead(c, w);
}

static void chipWrite(Chip *c, u32 w, u16 v)
{
	if (cfgS.type == AMD) amdWrite(c, w, v);
	else if (cfgS.type == INTEL) intelWrite(c, w, v);
}

u16 sim_rom_rd(u32 a)
{
	u32 w;
	Chip *c = route(a, &w);
	if (!c) return (u16)(a >> 1); /* open bus */
	if (cfgS.lanes == 2)
		return fromChip((u16)((chipRead(c, w) & 0xFF) | (chipRead(c + 1, w) & 0xFF) << 8));
	return fromChip(chipRead(c, w));
}

void sim_rom_wr(u32 a, u16 v)
{
	u32 w;
	Chip *c = route(a, &w);
	if (!c) return;
	v = toChip(v);
	if (cfgS.lanes == 2) {
		chipWrite(c, w, v & 0xFF);
		chipWrite(c + 1, w, v >> 8);
	} else {
		chipWrite(c, w, v);
	}
}

u8 sim_sram_rd(u32 a) { return sram[a & 0xFFFF]; }

void sim_sram_wr(u32 a, u8 v)
{
	sram[a & 0xFFFF] = v;
	/* Banks switch the way FlashGBX's bank type 1 does it: the bank number
	 * times 16 goes to SRAM byte 2, then 0x40 to byte 3 and 0 to byte 4. The
	 * switch takes effect on the write to byte 4. */
	if (cfgS.banks > 1 && (a & 0xFFFF) == 4)
		bank = (sram[2] >> 4) % cfgS.banks;
}

/* A clock for the timeouts in cartops.c: one tick every 8 reads of it. */
u32 sim_ticks(void) { return (u32)(tickCalls++ / 8); }

/* -------------------------------------------------------------- harness */
static u32 parseNum(const char *s) { return (u32)strtoul(s, NULL, 0); }

static void parseArgs(int argc, char **argv)
{
	for (int i = 1; i < argc; i++) {
		char *eq = strchr(argv[i], '=');
		if (!eq) continue;
		*eq = 0;
		const char *k = argv[i], *v = eq + 1;
		if (!strcmp(k, "type")) cfgS.type = !strcmp(v, "intel") ? INTEL : !strcmp(v, "rom") ? ROM : AMD;
		else if (!strcmp(k, "size")) cfgS.size = parseNum(v);
		else if (!strcmp(k, "sector")) cfgS.sector = parseNum(v);
		else if (!strcmp(k, "buf")) cfgS.buf = parseNum(v);
		else if (!strcmp(k, "mfr")) cfgS.mfr = (u16)parseNum(v);
		else if (!strcmp(k, "dev")) cfgS.dev = (u16)parseNum(v);
		else if (!strcmp(k, "dev2")) cfgS.dev2 = (u16)parseNum(v);
		else if (!strcmp(k, "dev3")) cfgS.dev3 = (u16)parseNum(v);
		else if (!strcmp(k, "u1")) cfgS.u1 = parseNum(v);
		else if (!strcmp(k, "u2")) cfgS.u2 = parseNum(v);
		else if (!strcmp(k, "cfi")) cfgS.cfi = (int)parseNum(v);
		else if (!strcmp(k, "cfisize")) cfgS.cfiSize = parseNum(v);
		else if (!strcmp(k, "mirror")) cfgS.mirror = (int)parseNum(v);
		else if (!strcmp(k, "boot")) { cfgS.bootTop = !strcmp(v, "top"); cfgS.bootBottom = !strcmp(v, "bottom"); }
		else if (!strcmp(k, "wiring")) snprintf(cfgS.wiring, sizeof(cfgS.wiring), "%s", v);
		else if (!strcmp(k, "interleave")) cfgS.interleave = (int)parseNum(v);
		else if (!strcmp(k, "lanes")) cfgS.lanes = (int)parseNum(v);
		else if (!strcmp(k, "idshift")) cfgS.idShift = (int)parseNum(v);
		else if (!strcmp(k, "banks")) cfgS.banks = (int)parseNum(v);
		else if (!strcmp(k, "locked")) cfgS.lockedInit = (int)parseNum(v);
		else if (!strcmp(k, "seed")) cfgS.seed = parseNum(v);
		else if (!strcmp(k, "fill")) cfgS.fillFF = !strcmp(v, "ff");
		else if (!strcmp(k, "busyprog")) cfgS.busyProg = (int)parseNum(v);
		else if (!strcmp(k, "busybuf")) cfgS.busyBuf = (int)parseNum(v);
		else if (!strcmp(k, "busyerase")) cfgS.busyErase = (int)parseNum(v);
		else if (!strcmp(k, "busychip")) cfgS.busyChip = (int)parseNum(v);
		else { fprintf(stderr, "flashsim: unknown option %s\n", k); exit(2); }
	}
}

static int readFull(void *p, size_t n) { return fread(p, 1, n, stdin) == n; }
static void writeU32(u32 v) { fwrite(&v, 4, 1, stdout); }

/* What the GBA reads at linear offset `off` (banks concatenated) in read mode. */
static u16 peek(u32 off)
{
	u32 bankBytes = cfgS.interleave ? cfgS.size * 2 : cfgS.size;
	u32 b = off / bankBytes, a = off % bankBytes, w;
	int save = bank;
	bank = (int)b;
	Chip *c = route(a, &w);
	bank = save;
	if (!c) return 0xFFFF;
	if (cfgS.lanes == 2) return fromChip((u16)((c[0].mem[w] & 0xFF) | (c[1].mem[w] & 0xFF) << 8));
	return fromChip(c->mem[w]);
}

int main(int argc, char **argv)
{
	parseArgs(argc, argv);
	nChips = cfgS.banks * (cfgS.interleave ? 2 : cfgS.lanes);
	chips = calloc((size_t)nChips, sizeof(Chip));
	srand(cfgS.seed);
	for (int i = 0; i < nChips; i++) {
		Chip *c = &chips[i];
		c->mem = malloc(cfgS.size);
		c->locked = calloc(chipWords() / 0x1000 + 1, 1);
		for (u32 w = 0; w < chipWords(); w++)
			c->mem[w] = cfgS.fillFF ? 0xFFFF : (u16)rand();
		if (cfgS.lockedInit) memset(c->locked, 1, chipWords() / 0x1000 + 1);
		c->st = cfgS.type == AMD ? A_READ : I_ARRAY;
	}
	cartOpsInit();

	static u8 buf[0x20000];
	static u32 result[0x1000];
	for (;;) {
		int op = getchar();
		if (op == EOF) break;
		if (op == 'R') {
			u32 len;
			if (!readFull(&len, 4) || len > sizeof(buf) || !readFull(buf, len)) break;
			u32 words = cartOpsRun(buf, len, result, 0x1000);
			writeU32(words);
			fwrite(result, 4, words, stdout);
		} else if (op == 'D') {
			u32 off, len;
			if (!readFull(&off, 4) || !readFull(&len, 4)) break;
			for (u32 i = 0; i < len; i += 2) {
				u16 v = peek(off + i);
				fwrite(&v, 2, 1, stdout);
			}
		} else if (op == 'S') {
			writeU32(6);
			writeU32((u32)sProg); writeU32((u32)sBuf); writeU32((u32)sErase);
			writeU32((u32)sChip); writeU32((u32)sErrors); writeU32((u32)sOverprog);
		} else {
			break;
		}
		fflush(stdout);
	}
	return 0;
}
