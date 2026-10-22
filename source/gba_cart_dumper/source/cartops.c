/*
 * Runs the cartridge programs sent by the web page. cartops.h describes the
 * buffer and the write profile.
 *
 * Flash writing works the way FlashGBX drives its cart readers. A profile
 * lists the commands the chip needs to write one unit (a single word, or
 * one write buffer). Placeholders stand for the unit's start address (SA),
 * its addresses and data (PA, PD) and the buffer count (BS), and any step
 * can wait for the chip afterwards. If the profile doesn't wait after the
 * data itself, a standard check runs: AMD-style chips are read until the
 * last word reads back as written, Intel/Sharp-style chips until their
 * status register says ready.
 */
#include "cartops.h"

#ifndef CARTOPS_SIM
#include <gba_base.h>
#include <gba_timers.h>
#include "ui.h"

#define REG_WAITCNT_OPS *(vu16 *)(REG_BASE + 0x204)

static inline u16 romRd(u32 a) { return *(vu16 *)(0x08000000 + a); }
static inline void romWr(u32 a, u16 v) { *(vu16 *)(0x08000000 + a) = v; }
static inline u8 sramRd(u32 a) { return *(vu8 *)(0x0E000000 + a); }
static inline void sramWr(u32 a, u8 v) { *(vu8 *)(0x0E000000 + a) = v; }

/* A 32-bit clock at 16384 ticks a second: timer 2 counts at 16.78 MHz / 1024
 * and timer 3 counts each time timer 2 wraps. */
static void ticksInit(void)
{
	REG_TM2CNT_H = 0;
	REG_TM3CNT_H = 0;
	REG_TM2CNT_L = 0;
	REG_TM3CNT_L = 0;
	REG_TM3CNT_H = TIMER_START | TIMER_COUNT;
	REG_TM2CNT_H = TIMER_START | 3;
}

static inline u32 ticks(void)
{
	u16 hi, lo;
	do {
		hi = REG_TM3CNT_L;
		lo = REG_TM2CNT_L;
	} while (hi != REG_TM3CNT_L);
	return ((u32)hi << 16) | lo;
}

static void show(u32 id, u32 pct)
{
	static const u8 acts[] = {
		ACT_CONNECTED, ACT_FLASH_DETECT, ACT_FLASH_ERASE, ACT_FLASH_WRITE,
		ACT_FLASH_VERIFY, ACT_FLASH_DONE, ACT_FLASH_FAILED,
	};
	if (id >= sizeof(acts))
		return;
	if (uiCurrentActivity() != acts[id])
		uiActivity(acts[id]);
	if (id >= 2 && id <= 4)
		uiProgress(pct, 100);
}

#define FAST IWRAM_CODE __attribute__((noinline))
#else
u16 sim_rom_rd(u32 a);
void sim_rom_wr(u32 a, u16 v);
u8 sim_sram_rd(u32 a);
void sim_sram_wr(u32 a, u8 v);
u32 sim_ticks(void);
#define romRd(a) sim_rom_rd(a)
#define romWr(a, v) sim_rom_wr((a), (v))
#define sramRd(a) sim_sram_rd(a)
#define sramWr(a, v) sim_sram_wr((a), (v))
#define ticks() sim_ticks()
static void ticksInit(void) {}
static void show(u32 id, u32 pct) { (void)id; (void)pct; }
#define FAST
#endif

#define ROM_MASK 0x01FFFFFE

typedef struct {
	u32 kinds, addr, value, waitAddr, waitValue, waitMask;
} Entry;

static struct {
	u32 set, unit, bs, srMask, srValue, timeoutMs, count;
	bool waitAfterData; /* a profile poll follows the PA/PD step */
	Entry e[CFG_MAX_ENTRIES];
} cfg;

static u32 crcTable[256];

/* Set by OP_SRCMD: a command to write before every OP_WAIT read. Some Sharp
 * chips need it (FlashGBX's wait_read_status_register). */
static bool srCmdOn;
static u32 srCmdAddr;
static u16 srCmdValue;

void cartOpsInit(void)
{
	u32 i, j;
	for (i = 0; i < 256; i++) {
		u32 c = i;
		for (j = 0; j < 8; j++)
			c = (c & 1) ? (c >> 1) ^ 0xEDB88320 : c >> 1;
		crcTable[i] = c;
	}
	ticksInit();
}

static u32 msToTicks(u32 ms)
{
	return ms * 16 + (ms * 384) / 1000 + 1;
}

/* Read until the masked value matches twice in a row. A chip that finishes
 * during a read can show the right top bit while the other bits still hold
 * its status. */
FAST static bool pollRom(u32 addr, u16 value, u16 mask, u32 limit, u16 *last)
{
	u32 t0 = ticks();
	u16 v;
	value &= mask;
	for (;;) {
		v = romRd(addr);
		if ((v & mask) == value) {
			v = romRd(addr);
			if ((v & mask) == value)
				break;
		}
		if (ticks() - t0 > limit) {
			*last = v;
			return false;
		}
	}
	*last = v;
	return true;
}

static bool loadCfg(const u32 *w, u32 words)
{
	u32 i;
	if (words < 6)
		return false;
	cfg.set = w[0];
	cfg.unit = w[1];
	cfg.bs = w[2];
	cfg.srMask = w[3] & 0xFFFF;
	cfg.srValue = w[3] >> 16;
	cfg.timeoutMs = w[4];
	cfg.count = w[5];
	if (cfg.count > CFG_MAX_ENTRIES || words < 6 + cfg.count * 6)
		return false;
	if (cfg.unit < 2 || (cfg.unit & 1) || cfg.unit > 0x1000)
		return false;
	cfg.waitAfterData = false;
	bool seenData = false;
	for (i = 0; i < cfg.count; i++) {
		const u32 *s = w + 6 + i * 6;
		Entry *e = &cfg.e[i];
		e->kinds = s[0];
		e->addr = s[1];
		e->value = s[2];
		e->waitAddr = s[3];
		e->waitValue = s[4];
		e->waitMask = s[5];
		if ((e->kinds & 0xFF) == K_PA && ((e->kinds >> 8) & 0xFF) == K_PD)
			seenData = true;
		if (seenData && ((e->kinds >> 16) & 0xFF) != K_NONE)
			cfg.waitAfterData = true;
	}
	return cfg.count > 0;
}

/* Write `bytes` (a whole number of units) to flash at ROM byte address
 * `addr`. Units that are all 0xFFFF are skipped, since erased flash already
 * reads that way. On failure, returns false with the unit's address in
 * *failAddr and the chip's last status in *lastRead. */
FAST static bool progRange(const u16 *data, u32 addr, u32 bytes,
	u32 *failAddr, u16 *lastRead)
{
	const u32 unit = cfg.unit, limit = msToTicks(cfg.timeoutMs);
	u32 off;
	for (off = 0; off < bytes; off += unit) {
		const u16 *d = data + off / 2;
		const u32 n = unit / 2;
		u32 i, k;
		for (i = 0; i < n && d[i] == 0xFFFF; i++) ;
		if (i == n)
			continue;

		const u32 sa = (addr + off) & ROM_MASK;
		u32 lastPA = sa;
		u16 lastPD = d[0];
		for (k = 0; k < cfg.count; k++) {
			const Entry *e = &cfg.e[k];
			const u32 ak = e->kinds & 0xFF, vk = (e->kinds >> 8) & 0xFF;
			const u32 wak = (e->kinds >> 16) & 0xFF, wvk = e->kinds >> 24;
			if (ak == K_PA && vk == K_PD) {
				for (i = 0; i < n; i++)
					romWr(sa + i * 2, d[i]);
				lastPA = sa + (n - 1) * 2;
				lastPD = d[n - 1];
			} else if (ak != K_NONE) {
				u32 a = ak == K_ABS ? e->addr : sa + e->addr;
				u16 v = vk == K_BS ? (u16)cfg.bs
					: vk == K_PD ? d[0] : (u16)e->value;
				romWr(a & ROM_MASK, v);
			}
			if (wak != K_NONE) {
				/* Waiting on the data always reads the last word
				 * written, since that is where the chip reports. */
				u32 a = (wvk == K_PD || wak == K_PA) ? lastPA
					: wak == K_ABS ? e->waitAddr : sa + e->waitAddr;
				u16 v = wvk == K_PD ? lastPD : (u16)e->waitValue;
				if (!pollRom(a & ROM_MASK, v, (u16)e->waitMask, limit, lastRead)) {
					*failAddr = sa;
					return false;
				}
			}
		}
		if (!cfg.waitAfterData) {
			bool ok = cfg.set == CFG_SET_INTEL
				? pollRom(lastPA, (u16)cfg.srValue, (u16)cfg.srMask, limit, lastRead)
				: pollRom(lastPA, lastPD, 0xFFFF, limit, lastRead);
			if (!ok) {
				*failAddr = sa;
				return false;
			}
		}
	}
	return true;
}

/* Returns the byte offset of the first difference, or OPV_SAME. With no
 * data, checks that the range is erased (all 0xFFFF). */
FAST static u32 verifyRange(const u16 *data, u32 addr, u32 bytes, u32 *gotExp)
{
	u32 i;
	for (i = 0; i < bytes / 2; i++) {
		u16 want = data ? data[i] : 0xFFFF;
		u16 got = romRd((addr + i * 2) & ROM_MASK);
		if (got != want) {
			*gotExp = ((u32)got << 16) | want;
			return i * 2;
		}
	}
	*gotExp = 0;
	return OPV_SAME;
}

FAST static u32 crcRange(u32 addr, u32 bytes)
{
	u32 c = 0xFFFFFFFF, i;
	for (i = 0; i < bytes; i += 2) {
		u16 v = romRd((addr + i) & ROM_MASK);
		c = crcTable[(c ^ v) & 0xFF] ^ (c >> 8);
		c = crcTable[(c ^ (v >> 8)) & 0xFF] ^ (c >> 8);
	}
	return ~c;
}

static void delayUs(u32 us)
{
	u32 limit = (u32)(((unsigned long long)us * 16384 + 999999) / 1000000) + 1;
	u32 t0 = ticks();
	while (ticks() - t0 < limit) ;
}

u32 cartOpsRun(const u8 *buf, u32 len, u32 *result, u32 resultWords)
{
	u32 out = 2, executed = 0, status = ST_OK, pc;
#define PUT(v) do { if (out >= resultWords) { status = ST_OVERFLOW; goto done; } \
	result[out++] = (v); } while (0)
#define IN_BUF(off, n) ((off) <= len && (n) <= len - (off))

	srCmdOn = false;
#ifndef CARTOPS_SIM
	const u16 waitcnt = REG_WAITCNT_OPS;
	REG_WAITCNT_OPS = waitcnt & ~0x001C; /* slowest ROM timing, safe for flash */
#endif

	for (pc = 0; pc + 16 <= len; pc += 16) {
		const u32 *op = (const u32 *)(buf + pc);
		const u32 a = op[1], b = op[2], c = op[3];
		u32 i;
		if (op[0] == OP_END)
			break;
		switch (op[0]) {
		case OP_W16:
			romWr(a & ROM_MASK, (u16)b);
			break;
		case OP_W8S:
			sramWr(a & 0xFFFF, (u8)b);
			break;
		case OP_RD16:
			for (i = 0; i < b; i += 4) {
				u32 lo = romRd((a + i) & ROM_MASK);
				u32 hi = i + 2 < b ? romRd((a + i + 2) & ROM_MASK) : 0;
				PUT(lo | (hi << 16));
			}
			break;
		case OP_RD8S:
			for (i = 0; i < b; i += 4) {
				u32 w = 0, j;
				for (j = 0; j < 4 && i + j < b; j++)
					w |= (u32)sramRd((a + i + j) & 0xFFFF) << (j * 8);
				PUT(w);
			}
			break;
		case OP_WAIT: {
			u16 last;
			bool ok;
			if (srCmdOn) {
				const u32 limit = msToTicks(c), t0 = ticks();
				const u16 mask = (u16)(b >> 16), want = (u16)b & mask;
				do {
					romWr(srCmdAddr, srCmdValue);
					romRd(a & ROM_MASK);
					last = romRd(a & ROM_MASK);
					ok = (last & mask) == want;
				} while (!ok && ticks() - t0 <= limit);
			} else {
				romRd(a & ROM_MASK); /* throwaway read, as FlashGBX does for bootleg carts */
				ok = pollRom(a & ROM_MASK, (u16)b, (u16)(b >> 16), msToTicks(c), &last);
			}
			PUT(last);
			if (!ok) {
				status = ST_TIMEOUT;
				executed++;
				goto done;
			}
			break;
		}
		case OP_DELAY:
			delayUs(a);
			break;
		case OP_CFG:
			if (!IN_BUF(a, b) || (a & 3) || !loadCfg((const u32 *)(buf + a), b / 4)) {
				status = ST_BAD_OP;
				goto done;
			}
			break;
		case OP_PROG: {
			u32 failAddr = 0;
			u16 last = 0;
			if (!IN_BUF(a, c) || (a & 1) || (b & 1) || cfg.count == 0 || c % cfg.unit) {
				status = ST_BAD_OP;
				goto done;
			}
			if (!progRange((const u16 *)(buf + a), b, c, &failAddr, &last)) {
				PUT(failAddr);
				PUT(last);
				status = ST_TIMEOUT;
				executed++;
				goto done;
			}
			PUT(0);
			PUT(0);
			break;
		}
		case OP_VERIFY: {
			u32 gotExp;
			const u16 *data = a == OPV_BLANK ? 0 : (const u16 *)(buf + a);
			if ((data && (!IN_BUF(a, c) || (a & 1))) || (b & 1) || (c & 1)) {
				status = ST_BAD_OP;
				goto done;
			}
			PUT(verifyRange(data, b, c, &gotExp));
			PUT(gotExp);
			break;
		}
		case OP_CRC32:
			PUT(crcRange(a, b));
			break;
		case OP_SHOW:
			show(a, b);
			break;
		case OP_SRCMD:
			srCmdOn = b <= 0xFFFF;
			srCmdAddr = a & ROM_MASK;
			srCmdValue = (u16)b;
			break;
		default:
			status = ST_BAD_OP;
			goto done;
		}
		executed++;
	}
done:
#ifndef CARTOPS_SIM
	REG_WAITCNT_OPS = waitcnt;
#endif
	result[0] = executed;
	result[1] = status;
	return out;
#undef PUT
#undef IN_BUF
}
