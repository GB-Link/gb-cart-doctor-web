/*
 * Runs small cartridge programs sent by the web page. This is how the page
 * writes ROMs to flash carts.
 *
 * The page works out everything specific to the cart (which flash chip,
 * which commands it takes, sector sizes, bank switching) from FlashGBX's
 * cart profiles. This side just carries out the steps: write and read the
 * cartridge, wait for the chip, and run the write and check loops that need
 * to go at full speed.
 *
 * The page sends one buffer: a list of steps, each four 32-bit words
 * { op, a, b, c } (little-endian), ending with OP_END, followed by any data
 * the steps use. Steps that use data (OP_CFG, OP_PROG, OP_VERIFY) give its
 * byte offset in the buffer.
 *
 * The result starts with the number of steps run and a status (0 for ok,
 * otherwise one of ST_*), followed by whatever each step reports, in order.
 * Running stops at the first step that fails.
 */
#ifndef CARTOPS_H
#define CARTOPS_H

#include <gba_types.h>

#define OP_END      0
#define OP_W16      1  /* a = ROM byte address, b = value                        */
#define OP_W8S      2  /* a = SRAM address, b = value                            */
#define OP_RD16     3  /* a = ROM byte address, b = bytes; reports the data,
                          padded to whole words                                 */
#define OP_RD8S     4  /* a = SRAM address, b = bytes; reports the data, padded
                          to whole words                                        */
#define OP_WAIT     5  /* a = ROM byte address, b = mask << 16 | value, c = ms:
                          wait until the masked read matches; reports the last
                          value read, and fails with ST_TIMEOUT                 */
#define OP_DELAY    6  /* a = microseconds                                        */
#define OP_CFG      7  /* a = offset of a write profile (see below), b = bytes    */
#define OP_PROG     8  /* a = data offset, b = ROM byte address, c = bytes:
                          write the data to flash; reports 0 0, or the address
                          and chip status where it failed, with ST_TIMEOUT      */
#define OP_VERIFY   9  /* a = data offset (OPV_BLANK to expect erased 0xFFFF),
                          b = ROM byte address, c = bytes: compare; reports the
                          byte offset of the first difference (or OPV_SAME),
                          then got << 16 | expected                             */
#define OP_CRC32   10  /* a = ROM byte address, b = bytes; reports the CRC-32    */
#define OP_SHOW    11  /* a = message id, b = percent: update the GBA screen     */
#define OP_SRCMD   12  /* a = ROM byte address, b = value to write before every
                          OP_WAIT read (some Sharp chips need it); b > 0xFFFF
                          turns it off                                          */

#define OPV_BLANK   0xFFFFFFFF
#define OPV_SAME    0xFFFFFFFF

#define ST_OK       0
#define ST_TIMEOUT  1
#define ST_BAD_OP   2
#define ST_OVERFLOW 3

/*
 * Write profile (OP_CFG): how to write one piece ("unit") of data to the
 * flash chip. 32-bit words:
 *   [0] chip family: 1 = AMD style (read the data back until it matches),
 *       2 = Intel/Sharp style (read a status register until it says ready)
 *   [1] unit size in bytes: 2 when the chip takes one word at a time,
 *       otherwise the size of its write buffer
 *   [2] the value to write for "BS" (the buffer's word count minus one)
 *   [3] Intel/Sharp status: mask | ready value << 16
 *   [4] how long one unit may take, in ms
 *   [5] number of steps (at most CFG_MAX_ENTRIES), then 6 words per step:
 *       kinds (address kind | value kind << 8 | wait address kind << 16 |
 *       wait value kind << 24), address, value, wait address, wait value,
 *       wait mask
 */
#define CFG_SET_AMD    1
#define CFG_SET_INTEL  2
#define CFG_MAX_ENTRIES 12

/* Address kinds */
#define K_NONE  0   /* no write, or no wait                                  */
#define K_ABS   1   /* this exact ROM byte address                           */
#define K_SA    2   /* the unit's start address plus this offset             */
#define K_PA    3   /* every word of the unit (writes), its last word (waits) */
/* Value kinds */
#define K_IMM   1   /* this value                                            */
#define K_BS    2   /* the buffer count word                                 */
#define K_PD    3   /* the unit's data (writes), its last word (waits)       */

void cartOpsInit(void);
u32 cartOpsRun(const u8 *buf, u32 len, u32 *result, u32 resultWords);

#endif
