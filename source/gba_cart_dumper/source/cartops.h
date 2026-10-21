/*
 * Cartridge op interpreter for writing ROMs to flash carts.
 *
 * The browser sends a small program of cart bus operations plus any data the
 * program refers to, in one buffer. Every cart-specific decision (which flash
 * chip, which command words, sector sizes, bank switching) is made in the
 * browser from FlashGBX's cart profiles; this side only executes bus writes,
 * reads, status polls and the program/verify loops that must run at bus speed.
 *
 * Buffer layout: a list of ops, each four little-endian u32 words
 * { op, a, b, c }, terminated by OP_END. Ops that take data (OP_CFG, OP_PROG,
 * OP_VERIFY) point at a byte offset inside the same buffer.
 *
 * Result layout: u32 opsExecuted, u32 status (0 = ok, else ST_*), then the
 * words each op appends, in order. Execution stops at the first failing op.
 */
#ifndef CARTOPS_H
#define CARTOPS_H

#include <gba_types.h>

#define OP_END      0
#define OP_W16      1  /* a = ROM byte address, b = value                        */
#define OP_W8S      2  /* a = SRAM address, b = value                            */
#define OP_RD16     3  /* a = ROM byte address, b = bytes -> data, padded to 4    */
#define OP_RD8S     4  /* a = SRAM address, b = bytes -> data, padded to 4        */
#define OP_WAIT     5  /* a = ROM byte address, b = mask<<16 | value, c = ms
                          -> last value read; fails with ST_TIMEOUT              */
#define OP_DELAY    6  /* a = microseconds                                        */
#define OP_CFG      7  /* a = offset of a write profile (see below), b = bytes    */
#define OP_PROG     8  /* a = data offset, b = ROM byte address, c = bytes
                          -> 0, or the failing address with ST_TIMEOUT           */
#define OP_VERIFY   9  /* a = data offset (OPV_BLANK: expect 0xFFFF), b = ROM byte
                          address, c = bytes -> mismatch byte offset or OPV_SAME,
                          then got<<16 | expected                                */
#define OP_CRC32   10  /* a = ROM byte address, b = bytes -> CRC-32              */
#define OP_SHOW    11  /* a = message id, b = percent: progress on the GBA screen */
#define OP_SRCMD   12  /* a = ROM byte address, b = value written before every
                          OP_WAIT poll read; b > 0xFFFF turns it off             */

#define OPV_BLANK   0xFFFFFFFF
#define OPV_SAME    0xFFFFFFFF

#define ST_OK       0
#define ST_TIMEOUT  1
#define ST_BAD_OP   2
#define ST_OVERFLOW 3

/*
 * Write profile (OP_CFG), u32 words:
 *   [0] command set: 1 = AMD (data polling), 2 = Intel/Sharp (status register)
 *   [1] unit bytes: 2 for single-word programming, else the write-buffer size
 *   [2] value written for "BS" (buffer word count - 1, per chip)
 *   [3] status register mask | ready value << 16 (Intel/Sharp)
 *   [4] timeout per unit, ms
 *   [5] entry count (max CFG_MAX_ENTRIES), then 6 words per entry:
 *       kinds (addr | val << 8 | waitAddr << 16 | waitVal << 24),
 *       addr, value, waitAddr, waitValue, waitMask
 */
#define CFG_SET_AMD    1
#define CFG_SET_INTEL  2
#define CFG_MAX_ENTRIES 12

#define K_NONE  0
#define K_ABS   1   /* absolute ROM byte address                             */
#define K_SA    2   /* unit start + offset                                   */
#define K_PA    3   /* every word of the unit (writes) / last word (waits)   */
#define K_IMM   1   /* immediate value                                       */
#define K_BS    2   /* buffer count word                                     */
#define K_PD    3   /* the unit's data (writes) / last word's data (waits)   */

void cartOpsInit(void);
u32 cartOpsRun(const u8 *buf, u32 len, u32 *result, u32 resultWords);

#endif
