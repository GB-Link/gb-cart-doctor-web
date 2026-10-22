/*
 * The dumper's screen: a title bar, the cartridge in the slot, what the
 * dumper is doing (with a progress bar), and a short footer.
 *
 * Two tile layers are used: text on BG0 and the coloured panels behind it
 * on BG1. They share one set of tiles, laid out so that each ASCII
 * character's tile number is its character code.
 */
#include <gba.h>
#include "ui.h"
#include "ui_gfx.h"

#define TEXT_MAP  ((vu16 *)SCREEN_BASE_BLOCK(31))
#define PANEL_MAP ((vu16 *)SCREEN_BASE_BLOCK(30))

/* The other tiles, which sit before the font (see tools/make_gba_ui.py). */
#define T_ICON   1
#define T_SOLID  7
#define T_LINE   8
#define T_BAR    9  /* plus the number of filled pixels, 0-8 */

/* Text colours. In each palette, colour 1 is the text colour. */
#define P_INK    0
#define P_WHITE  1
#define P_ORANGE 2
#define P_GREEN  3
#define P_GREY   4
#define P_BLUE   5
#define P_RED    6
#define P_MUTED  7
/* Panel and icon colours. */
#define P_HEADER 8
#define P_BAND   9
#define P_RULE   10
#define P_BAR    11
#define P_CART   12
#define P_NOCART 13
#define P_NOBAND 14

static const u16 palettes[][5] = {
	[P_INK]    = { 0, RGB8(16, 24, 72) },
	[P_WHITE]  = { 0, RGB8(255, 255, 255) },
	[P_ORANGE] = { 0, RGB8(224, 80, 16) },
	[P_GREEN]  = { 0, RGB8(24, 144, 24) },
	[P_GREY]   = { 0, RGB8(88, 100, 136) },
	[P_BLUE]   = { 0, RGB8(32, 72, 176) },
	[P_RED]    = { 0, RGB8(200, 24, 24) },
	[P_MUTED]  = { 0, RGB8(56, 88, 152) },
	[P_HEADER] = { 0, RGB8(32, 64, 160) },
	[P_BAND]   = { 0, RGB8(192, 216, 248) },
	[P_RULE]   = { 0, RGB8(184, 192, 216) },
	[P_BAR]    = { 0, RGB8(208, 216, 232), RGB8(32, 96, 200) },
	[P_CART]   = { 0, RGB8(56, 64, 88), RGB8(176, 184, 200), RGB8(48, 104, 216), RGB8(112, 120, 144) },
	[P_NOBAND] = { 0, RGB8(236, 238, 244) },
	[P_NOCART] = { 0, RGB8(168, 176, 192), RGB8(232, 236, 240), RGB8(216, 220, 228), RGB8(200, 204, 216) },
};

#define ROW_STATUS   4
#define ROW_BAND     7
#define BAND_ROWS    5
#define ROW_TITLE    8
#define ROW_SIZES    10
#define ROW_ACTIVITY 13
#define ROW_BAR      14
#define ROW_RULE     16
#define ROW_FOOTER   17

#define BAR_X     1
#define BAR_TILES 28
#define BAR_UNITS (BAR_TILES * 8)

static const struct { const char *text; u8 pal; } activities[] = {
	[ACT_WAITING]      = { "Waiting for the web page", P_GREY },
	[ACT_CONNECTED]    = { "Connected to the web page", P_BLUE },
	[ACT_READING]      = { "Reading the cartridge", P_BLUE },
	[ACT_SCANNING]     = { "Scanning the ROM", P_BLUE },
	[ACT_SEND_ROM]     = { "Sending the ROM", P_BLUE },
	[ACT_READ_SAVE]    = { "Reading the save", P_BLUE },
	[ACT_SEND_SAVE]    = { "Sending the save", P_BLUE },
	[ACT_RECV_SAVE]    = { "Receiving the save", P_BLUE },
	[ACT_WRITE_SAVE]   = { "Writing the save", P_BLUE },
	[ACT_ERASE_SAVE]   = { "Erasing the save", P_BLUE },
	[ACT_READ_BIOS]    = { "Reading the BIOS", P_BLUE },
	[ACT_SEND_BIOS]    = { "Sending the BIOS", P_BLUE },
	[ACT_FLASH_DETECT] = { "Finding the flash chip", P_BLUE },
	[ACT_FLASH_ERASE]  = { "Erasing the flash chip", P_BLUE },
	[ACT_FLASH_WRITE]  = { "Writing the ROM", P_BLUE },
	[ACT_FLASH_VERIFY] = { "Checking the ROM", P_BLUE },
	[ACT_CART_READ]    = { "Cartridge read", P_GREEN },
	[ACT_ROM_DONE]     = { "ROM dumped", P_GREEN },
	[ACT_SAVE_DONE]    = { "Save dumped", P_GREEN },
	[ACT_RESTORED]     = { "Save restored", P_GREEN },
	[ACT_ERASED]       = { "Save erased", P_GREEN },
	[ACT_BIOS_DONE]    = { "BIOS dumped", P_GREEN },
	[ACT_FLASH_DONE]   = { "ROM written", P_GREEN },
	[ACT_FLASH_FAILED] = { "Writing the ROM failed", P_RED },
	[ACT_STOPPED]      = { "Stopped", P_ORANGE },
	[ACT_NO_CART]      = { "No cartridge found", P_ORANGE },
	[ACT_NO_SAVE]      = { "This cartridge has no save", P_ORANGE },
};

static u32 activity;
static u32 barUnits;
static bool barShown;

/* The cartridge shown on screen. name holds the title, then the game code
 * from name[13]. The sizes are -1 until a command has measured them. */
static struct {
	bool present;
	char name[18];
	s32 romSize;
	s32 saveSize;
} cart;

static u32 quietFrames;
static bool lastVblank;

static void put(int x, int y, int pal, const char *s)
{
	vu16 *p = TEXT_MAP + y * 32 + x;
	while(*s)
		*p++ = (u8)*s++ | pal << 12;
}

static void clearText(int x, int y, int w)
{
	vu16 *p = TEXT_MAP + y * 32 + x;
	while(w--)
		*p++ = ' ';
}

static void panel(int x, int y, int w, int h, u16 entry)
{
	int i, j;
	for(j = 0; j < h; j++)
		for(i = 0; i < w; i++)
			PANEL_MAP[(y + j) * 32 + x + i] = entry;
}

static char *putNum(char *p, u32 v)
{
	char tmp[10];
	int n = 0;
	do {
		tmp[n++] = '0' + v % 10;
		v /= 10;
	} while(v);
	while(n)
		*p++ = tmp[--n];
	return p;
}

static char *putStr(char *p, const char *s)
{
	while(*s)
		*p++ = *s++;
	return p;
}

static char *putSize(char *p, u32 bytes)
{
	if(bytes >= 0x100000)
		return putStr(putNum(p, bytes >> 20), " MB");
	if(bytes >= 0x400)
		return putStr(putNum(p, bytes >> 10), " KB");
	return putStr(putNum(p, bytes), " B");
}

static void drawIcon(bool present)
{
	int pal = present ? P_CART : P_NOCART;
	int i;
	for(i = 0; i < 6; i++)
		PANEL_MAP[(ROW_STATUS + i / 3) * 32 + 1 + i % 3] = (T_ICON + i) | pal << 12;
}

static void drawCart(void)
{
	int y;
	for(y = ROW_STATUS; y <= ROW_SIZES + 1; y++)
		clearText(0, y, 30);
	panel(0, ROW_BAND, 30, BAND_ROWS, 0);
	drawIcon(cart.present);
	if(!cart.present)
	{
		put(5, ROW_STATUS, P_ORANGE, "No cartridge");
		panel(0, ROW_BAND, 30, BAND_ROWS, T_SOLID | P_NOBAND << 12);
		put(2, ROW_TITLE, P_INK, "Insert a GBA cartridge.");
		put(2, ROW_TITLE + 1, P_GREY, "Blank flash carts show this");
		put(2, ROW_TITLE + 2, P_GREY, "screen too.");
		return;
	}
	put(5, ROW_STATUS, P_GREEN, "Cartridge ready");
	panel(0, ROW_BAND, 30, BAND_ROWS, T_SOLID | P_BAND << 12);
	put(2, ROW_TITLE, P_INK, cart.name);
	put(24, ROW_TITLE, P_MUTED, cart.name + 13);
	if(cart.romSize > 0)
	{
		char line[32], *p = putSize(line, cart.romSize);
		p = putStr(p, " ROM, ");
		if(cart.saveSize < 0)
			p = putStr(p, "save not read");
		else if(cart.saveSize == 0)
			p = putStr(p, "no save");
		else
		{
			p = putSize(p, cart.saveSize);
			p = putStr(p, cart.saveSize <= 0x2000 ? " EEPROM"
				: cart.saveSize == 0x8000 ? " SRAM" : " flash");
			p = putStr(p, " save");
		}
		*p = 0;
		put(2, ROW_SIZES, P_MUTED, line);
	}
}

/* Read the title and game code. Returns false when there is no valid
 * header: the Nintendo logo must start in the right place and the header
 * checksum at 0xBD must match. */
static bool readHeader(char *name)
{
	vu8 *h = (vu8 *)0x08000000;
	u32 i, sum = 0;
	if(*(vu32 *)0x08000004 != 0x51AEFF24)
		return false;
	for(i = 0xA0; i < 0xBD; i++)
		sum += h[i];
	if((u8)(-(sum + 0x19)) != h[0xBD])
		return false;
	/* 12 characters of title, a 0, then the 4-character game code */
	for(i = 0; i < 12; i++)
	{
		u8 c = h[0xA0 + i];
		name[i] = (c >= 0x20 && c < 0x7F) ? c : ' ';
	}
	name[12] = 0;
	for(i = 0; i < 4; i++)
	{
		u8 c = h[0xAC + i];
		name[13 + i] = (c >= 0x20 && c < 0x7F) ? c : ' ';
	}
	name[17] = 0;
	return true;
}

static bool sameName(const char *a, const char *b)
{
	int i;
	for(i = 0; i < 18; i++)
		if(a[i] != b[i])
			return false;
	return true;
}

static void watchCart(void)
{
	char name[18];
	bool present = readHeader(name);
	if(present == cart.present && (!present || sameName(name, cart.name)))
		return;
	cart.present = present;
	if(present)
	{
		int i;
		for(i = 0; i < 18; i++)
			cart.name[i] = name[i];
	}
	cart.romSize = -1;
	cart.saveSize = -1;
	drawCart();
	if(activity != ACT_WAITING && activity != ACT_CONNECTED)
		uiActivity(ACT_CONNECTED);
}

void uiInit(void)
{
	u32 i, b;
	vu16 *vram = (vu16 *)VRAM;

	REG_DISPCNT = LCDC_OFF;
	for(i = 0; i < 0x10000 / 2; i++)
		vram[i] = 0;
	/* Expand the 1-bit font to 4 bits per pixel, drawn in colour 1. */
	for(i = 0; i < 95 * 8; i++)
	{
		u32 row = 0;
		for(b = 0; b < 8; b++)
			if(uiFont[i] & (0x80 >> b))
				row |= 1 << (b * 4);
		((vu32 *)CHAR_BASE_ADR(0))[(0x20 * 8) + i] = row;
	}
	for(i = 0; i < sizeof(uiTiles) / 4; i++)
		((vu32 *)CHAR_BASE_ADR(0))[8 + i] = ((const u32 *)uiTiles)[i];

	BG_PALETTE[0] = RGB5(31, 31, 31);
	for(i = 0; i < sizeof(palettes) / sizeof(palettes[0]); i++)
		for(b = 1; b < 5; b++)
			BG_PALETTE[i * 16 + b] = palettes[i][b];

	for(i = 0; i < 32 * 32; i++)
	{
		TEXT_MAP[i] = ' ';
		PANEL_MAP[i] = 0;
	}
	panel(0, 0, 30, 3, T_SOLID | P_HEADER << 12);
	put(1, 1, P_WHITE, "GB-Link Cart Doctor");
	panel(1, ROW_RULE, 28, 1, T_LINE | P_RULE << 12);
	put(1, ROW_FOOTER, P_GREY, "Use the web page to dump,");
	put(1, ROW_FOOTER + 1, P_GREY, "restore or write cartridges.");

	cart.present = readHeader(cart.name);
	cart.romSize = -1;
	cart.saveSize = -1;
	drawCart();
	uiActivity(ACT_WAITING);

	REG_BG0CNT = BG_SIZE_0 | SCREEN_BASE(31) | CHAR_BASE(0) | BG_PRIORITY(0);
	REG_BG1CNT = BG_SIZE_0 | SCREEN_BASE(30) | CHAR_BASE(0) | BG_PRIORITY(1);
	REG_DISPCNT = MODE_0 | BG0_ON | BG1_ON;
}

u32 uiCurrentActivity(void)
{
	return activity;
}

void uiActivity(u32 act)
{
	activity = act;
	clearText(1, ROW_ACTIVITY, 29);
	put(1, ROW_ACTIVITY, activities[act].pal, activities[act].text);
	if(barShown)
	{
		panel(BAR_X, ROW_BAR, BAR_TILES, 1, 0);
		barShown = false;
	}
}

void IWRAM_CODE uiProgress(u32 done, u32 total)
{
	u32 units = total ? (u32)Div(done * BAR_UNITS, total) : 0;
	u32 i, from, to, pct;
	vu16 *t;
	if(units > BAR_UNITS)
		units = BAR_UNITS;
	if(!barShown)
	{
		barShown = true;
		barUnits = 0;
		for(i = 0; i < BAR_TILES; i++)
			PANEL_MAP[ROW_BAR * 32 + BAR_X + i] = T_BAR | P_BAR << 12;
	}
	else if(units == barUnits)
		return;
	from = (units < barUnits ? units : barUnits) / 8;
	to = (units > barUnits ? units : barUnits) / 8;
	if(to >= BAR_TILES)
		to = BAR_TILES - 1;
	for(i = from; i <= to; i++)
	{
		s32 f = (s32)units - (s32)i * 8;
		f = f < 0 ? 0 : f > 8 ? 8 : f;
		PANEL_MAP[ROW_BAR * 32 + BAR_X + i] = (T_BAR + f) | P_BAR << 12;
	}
	barUnits = units;
	pct = units * 100 / BAR_UNITS;
	t = TEXT_MAP + ROW_ACTIVITY * 32 + 25;
	t[0] = (pct >= 100 ? '1' : ' ') | P_INK << 12;
	t[1] = (pct >= 10 ? '0' + pct / 10 % 10 : ' ') | P_INK << 12;
	t[2] = ('0' + pct % 10) | P_INK << 12;
	t[3] = '%' | P_INK << 12;
}

void uiCartSizes(s32 romSize, s32 saveSize)
{
	if(romSize < 0)
	{
		if(cart.present)
		{
			cart.present = false;
			drawCart();
		}
		return;
	}
	if(!cart.present)
		cart.present = readHeader(cart.name);
	cart.romSize = romSize;
	if(saveSize >= 0)
		cart.saveSize = saveSize;
	drawCart();
}

void uiLinkWord(void)
{
	quietFrames = 0;
	if(activity == ACT_WAITING)
		uiActivity(ACT_CONNECTED);
}

void uiIdle(void)
{
	bool vblank = REG_DISPSTAT & LCDC_VBL_FLAG;
	if(vblank == lastVblank)
		return;
	lastVblank = vblank;
	if(!vblank)
		return;
	/* Leave the cartridge alone while the web page is using it: a flash
	 * write is many short commands in a row. Once the link has been quiet
	 * for half a second, check the cartridge about eight times a second. */
	if(++quietFrames < 30 || (quietFrames & 7))
		return;
	watchCart();
}
