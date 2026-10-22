#ifndef UI_H
#define UI_H

#include <gba_base.h>
#include <gba_types.h>

/* What the dumper is doing, or last did. Shown under the cartridge. */
enum {
	ACT_WAITING,
	ACT_CONNECTED,
	ACT_READING,
	ACT_SCANNING,
	ACT_SEND_ROM,
	ACT_READ_SAVE,
	ACT_SEND_SAVE,
	ACT_RECV_SAVE,
	ACT_WRITE_SAVE,
	ACT_ERASE_SAVE,
	ACT_READ_BIOS,
	ACT_SEND_BIOS,
	ACT_FLASH_DETECT,
	ACT_FLASH_ERASE,
	ACT_FLASH_WRITE,
	ACT_FLASH_VERIFY,
	ACT_CART_READ,
	ACT_ROM_DONE,
	ACT_SAVE_DONE,
	ACT_RESTORED,
	ACT_ERASED,
	ACT_BIOS_DONE,
	ACT_FLASH_DONE,
	ACT_FLASH_FAILED,
	ACT_STOPPED,
	ACT_NO_CART,
	ACT_NO_SAVE,
};

void uiInit(void);
/* Show what the dumper is doing. Hides the progress bar. */
void uiActivity(u32 act);
u32 uiCurrentActivity(void);
/* Show the progress bar at done out of total. done * 224 must fit in
 * 32 bits. */
void IWRAM_CODE uiProgress(u32 done, u32 total);
/* Show the sizes a command found. romSize < 0 means there is no
 * cartridge; saveSize < 0 means the save wasn't checked. */
void uiCartSizes(s32 romSize, s32 saveSize);
/* Call when a word arrives from the web page while waiting. */
void uiLinkWord(void);
/* Call over and over while waiting for the web page. Keeps the cartridge
 * on screen up to date. */
void uiIdle(void);

#endif
