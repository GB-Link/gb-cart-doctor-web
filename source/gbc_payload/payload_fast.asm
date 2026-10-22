; GB Cart Doctor GBC payload.
;
; The GBA switches itself into GBC mode and starts this program. It shows a
; menu with the inserted cartridge and takes its commands from the web page
; over the link cable: dump the ROM, dump the save, restore a save, or load
; the cart agent (agent.asm) for flash writing and other cart work.
;
; The whole program is copied into video RAM and runs from there, so the
; cartridge slot is free for the cart being read. That is why calls and jumps
; inside it are written as _VRAM+label.
;
; The GBC is the serial slave: the GB-Link clocks every byte, and the GBC can
; only answer with the byte it has loaded in rSB at that moment.

    INCLUDE "hardware.inc"

; Transfer types sent in the header that starts a dump or restore.
rROM_TRANSFER EQU $1
rSRAM_TRANSFER EQU $2
rRESTORE_TRANSFER EQU $3                ; save restore: page -> cartridge
rSLAVE_MODE EQU $82
rOK  EQU $1
rFAIL EQU $0
rBASE_VAL EQU $10
rCHECK_VAL EQU $40
rROM_BANK_SIZE EQU $40
rSRAM_SUB_BANK_SIZE EQU $8
rSRAM_MBC2_BANK_SIZE EQU $2
CART_RUMBLE_ENABLE EQU $8

; Which way a save transfer goes: 0 = dump (cartridge -> page), 1 = restore
; (page -> cartridge). $FF80-$FF83 are shared: the menu's code lives there
; while the menu runs, and transfers reuse them as variables. So this flag
; must be set only after the menu has handed over to a transfer, or copying
; the menu code back would overwrite it.
rRESTORE_FLAG EQU $FF83

; First byte of every transfer header.
rFAST_MAGIC EQU $F5

; Commands from the web page. The menu ignores the GBA's buttons.
;   CMD_DUMP_ROM, CMD_DUMP_SAVE and CMD_RESTORE start a transfer. Inside the
;   payload each is passed on as a button bit (A, B or SELECT), which is how
;   the transfer code tells them apart.
;   CMD_ABORT, sent in place of an acknowledgement, stops a dump or restore
;   and goes back to the menu.
;   CMD_ENTER starts the loader. It offers LOADER_TAG until the page sends
;   LOADER_GO, then receives the cart agent: the length (low byte, high byte),
;   the length again with all bits flipped, the agent itself, and a two-byte
;   Fletcher checksum (for each byte sum1 += byte, sum2 += sum1). If anything
;   doesn't match, it goes back to offering LOADER_TAG.
CMD_DUMP_ROM EQU $C1
CMD_DUMP_SAVE EQU $C2
CMD_RESTORE EQU $C3
CMD_ENTER EQU $C5
CMD_ABORT EQU $CA
LOADER_TAG EQU $5C
LOADER_GO EQU $A5
AGENT_BASE EQU $C100                   ; where the agent is loaded, in work RAM
AGENT_MAX EQU $0E00                    ; size limit for the agent

; Menu screen. Tiles use the $8800 addressing mode, so tile n (0-127) is at
; $9000+n*16. The font sits at tiles $20-$7E, so ASCII text can be written
; straight into the map. There are two background maps, and the menu switches
; between them: $9800 shows "No cartridge", $9C00 "Cartridge ready".
LCDC_NO_CART EQU LCDCF_ON | LCDCF_BG8800 | LCDCF_BG9800 | LCDCF_OBJOFF | LCDCF_WINOFF | LCDCF_BGON
LCDC_CART EQU LCDCF_ON | LCDCF_BG8800 | LCDCF_BG9C00 | LCDCF_OBJOFF | LCDCF_WINOFF | LCDCF_BGON
FONT_TILES EQU $9200
ICON_TILES EQU $9010
TITLE_CELL EQU $9C00+7*32+2            ; where the cart's title goes, 16 cells
; Checksum of the Nintendo logo at $0104, worked out the same way the menu
; checks the inserted cart (sum1 += byte, sum2 += sum1, both 8-bit). A cart
; whose logo doesn't match is treated as missing.
LOGO_SUM1 EQU $46
LOGO_SUM2 EQU $F6


; Runs once the program is in video RAM (from $8000): screen off, then on to
; start.
    SECTION "Init", ROM0[$0]
    xor a
    ld  [rLCDC],a
    jp  _VRAM+start

    SECTION "Entrypoint", ROM0[$100]
    nop
    jp  launch

; Copy the first 4 KB of the program into video RAM ($8000-$8FFF) and run
; it from there.
    SECTION "Launcher", ROM0[$150]
launch:
    xor a
    ld  [rLCDC],a
    ld  hl,$8000
    ld  de,0
.copy_to_vram
    ld  a,[de]
    inc de
    ld  [hl+],a
    ld  a,h
    cp  a,$90
    jr  nz,.copy_to_vram
    jp  _VRAM

    SECTION "Start",ROM0[$200]

start:
    xor a
	ld	[rSCX],a
	ld	[rSCY],a
    ld  sp,$FFFE
    ld  a,$80
    ld  [rBCPS],a
    ld  [$FF4C],a                      ; KEY0: run in full GBC mode
    ld  a,rBASE_VAL
    ld  [rSB],a

; Set up the menu: palettes, font, icon tiles and both screens.
.init_palette
    ld  b,menuPaletteEnd-menuPalette
    ld  hl,_VRAM+menuPalette
.palette_loop_bg
    ld  a,[hl+]
    ld  [rBCPD],a
    dec b
    jr  nz,.palette_loop_bg

.init_font                             ; the font has one bit per pixel; writing
                                       ; each byte twice makes colour 0 or 3
    ld  hl,_VRAM+fontData
    ld  de,FONT_TILES
    ld  bc,fontDataEnd-fontData
.font_loop
    ld  a,[hl+]
    ld  [de],a
    inc de
    ld  [de],a
    inc de
    dec bc
    ld  a,b
    or  a,c
    jr  nz,.font_loop
    ld  hl,_VRAM+iconTiles
    ld  de,ICON_TILES
    ld  b,iconTilesEnd-iconTiles
.icon_loop
    ld  a,[hl+]
    ld  [de],a
    inc de
    dec b
    jr  nz,.icon_loop

; Fill both maps with spaces in palette 0, then draw their text. The palette
; of each cell lives in VRAM bank 1, but this code runs from bank 0, so the
; routines that switch banks run from high RAM.
.init_maps
    call _VRAM+.load_hram
    call $FF80+hram_clear_attrs-hram_code
    ld  hl,_SCRN0
.fill_loop
    ld  a," "
    ld  [hl+],a
    ld  a,h
    cp  a,HIGH(_SCRN1)+4
    jr  nz,.fill_loop
    ld  hl,_VRAM+textCommon
    ld  b,HIGH(_SCRN0)
    call _VRAM+.draw_text
    ld  hl,_VRAM+textCommon
    ld  b,HIGH(_SCRN1)
    call _VRAM+.draw_text
    ld  hl,_VRAM+textNoCart
    ld  b,HIGH(_SCRN0)
    call _VRAM+.draw_text
    ld  hl,_VRAM+textCart
    ld  b,HIGH(_SCRN1)
    call _VRAM+.draw_text

; Start (or go back to) the menu. Transfers jump here when they finish.
.copy_to_hram
    call _VRAM+.load_hram
    jp  $FF80

; Copy the menu loop into high RAM. It ends below the stack at $FFFE.
.load_hram
    ld  hl,_VRAM+hram_code
    ld  c,LOW($FF80)
.copy_hram_loop
    ld  a,[hl+]
    ld  [$ff00+c],a
    inc c
    ld  a,c
    cp  a,LOW($FF80+hram_code_end-hram_code)
    jr  nz,.copy_hram_loop
    ret

; Draw a list of text at hl into the map whose high address byte is b.
; Each entry is: map offset (high byte first), palette, characters, 0.
; The list ends with $FF.
.draw_text
    ld  a,[hl+]
    cp  a,$FF
    ret z
    add a,b
    ld  d,a
    ld  a,[hl+]
    ld  e,a
    ld  a,[hl+]
    ld  c,a
.draw_char
    ld  a,[hl+]
    or  a,a
    jr  z,.draw_text
    ld  [de],a
    call $FF80+hram_put_attr-hram_code
    inc de
    jr  .draw_char

; Start a transfer. b holds the command as a button bit: A = dump the ROM,
; B = dump the save, SELECT = restore a save.
.prepare_ROM_dumper
    ld  a,b
    and a,PADF_SELECT
    jp  nz,_VRAM+.prepare_SRAM_restore
    xor a
    ld  [rRESTORE_FLAG],a               ; dumping
    ld  a,b
    and a,PADF_A|PADF_START
    jp  z,_VRAM+.prepare_SRAM_dumper
    push bc

.send_start_rom
    ; Send the 4-byte header: magic, transfer type, size code from the cart
    ; header, and a check byte (the other three XORed together).
    ld  a,[$0148]
    ld  h,a
    ld  a,$1F
    and a,h
    ld  h,a                            ; h = ROM size code

    ld  a,rFAST_MAGIC
    call _VRAM+.send_raw_byte          ; byte 0: magic
    ld  a,rROM_TRANSFER
    call _VRAM+.send_raw_byte          ; byte 1: transfer type
    ld  a,h
    call _VRAM+.send_raw_byte          ; byte 2: size code
    ld  a,rFAST_MAGIC
    xor rROM_TRANSFER
    xor h
    call _VRAM+.send_raw_byte          ; byte 3: check byte

    ; Send it again until the page acknowledges it.
    call _VRAM+.recv_raw_byte
    cp  a,CMD_ABORT
    jp  z,_VRAM+.abort_transfer
    cp  a,rOK
    jr  nz,.send_start_rom

; Pick how to switch ROM banks, stored in $FF82: 0 = simple, 1 = MBC1,
; 2 = MBC5. $FF80/$FF81 hold the next bank number (low and high part).
.check_mbc1_rom
    xor a
    ld  [$FF82],a
    ld  a,[$0147]
    ld  b,a
    cp  a,CART_ROM_MBC1
    jr  c,.transfer_size_rom
    ld  a,CART_ROM_MBC1_RAM_BAT
    cp  a,b
    jr  c,.check_mbc5_rom
    ld  a,$1                           ; MBC1 splits the bank number in two
    ld  [$FF82],a
    jr  .transfer_size_rom

.check_mbc5_rom
    ld  a,b
    cp  a,CART_ROM_MBC5
    jr  c,.transfer_size_rom
    ld  a,CART_ROM_MBC5_RUM_RAM_BAT
    cp  a,b
    jr  c,.transfer_size_rom
    ld  a,$2                           ; MBC5 has a 9-bit bank number
    ld  [$FF82],a

; Look up how many banks to send, then send them 4 at a time.
.transfer_size_rom
    ld  b,$00
    ld  a,h
    and a,$1F
    ld  c,a
    push hl
    ld  hl,_VRAM+romSizes
    add hl,bc
    ld  a,[hl]
    pop hl
    ld  b,a
    xor a
    ld  [$FF80],a
    ld  [$FF81],a
    ld  de,$0000
.ROM_banks_continue_transfer
    call _VRAM+.transfer_4_ROM_banks
    ld  a,b
    cp  a,$00
    jr  nz,.ROM_banks_continue_transfer
    pop bc

.prepare_SRAM_dumper
    ld  a,b
    and a,PADF_B|PADF_START
    jp  z,_VRAM+.SRAM_banks_transfer_end

.send_start_sram
    call _VRAM+.load_sram_size_index    ; h = save size code

    ; Send the 4-byte header, as for the ROM.
    ld  a,rFAST_MAGIC
    call _VRAM+.send_raw_byte          ; byte 0: magic
    ld  a,rSRAM_TRANSFER
    call _VRAM+.send_raw_byte          ; byte 1: transfer type
    ld  a,h
    call _VRAM+.send_raw_byte          ; byte 2: size code
    ld  a,rFAST_MAGIC
    xor rSRAM_TRANSFER
    xor h
    call _VRAM+.send_raw_byte          ; byte 3: check byte

    call _VRAM+.recv_raw_byte
    cp  a,CMD_ABORT
    jp  z,_VRAM+.abort_transfer
    cp  a,rOK
    jr  nz,.send_start_sram
    jp  _VRAM+.check_mbc1_sram          ; skip the restore setup below

; Restore a save: the page sends it and the payload writes it to the cart.
.prepare_SRAM_restore
    ld  a,$1
    ld  [rRESTORE_FLAG],a               ; restoring
    call _VRAM+.load_sram_size_index    ; h = save size code

    ; Send the 4-byte header announcing a restore.
    ld  a,rFAST_MAGIC
    call _VRAM+.send_raw_byte          ; byte 0: magic
    ld  a,rRESTORE_TRANSFER
    call _VRAM+.send_raw_byte          ; byte 1: transfer type
    ld  a,h
    call _VRAM+.send_raw_byte          ; byte 2: size code
    ld  a,rFAST_MAGIC
    xor rRESTORE_TRANSFER
    xor h
    call _VRAM+.send_raw_byte          ; byte 3: check byte

    ; Anything but rOK means the page refused the restore (for example, the
    ; save file is the wrong size for this cart), so go back to the menu.
    ; Sending the header again would hang, as the page has stopped listening.
    call _VRAM+.recv_raw_byte
    cp  a,rOK
    jp  nz,_VRAM+.copy_to_hram
    ; The rest is shared with the save dump; rRESTORE_FLAG decides the
    ; direction.

; Pick how to switch save RAM banks, stored in $FF82: 0 = simple (MBC1 is
; also put in RAM banking mode), 1 = MBC2, 2 = MBC5 with rumble.
.check_mbc1_sram
    xor a
    ld  [$FF82],a
    ld  a,[$0147]
    ld  b,a
    cp  a,CART_ROM_MBC1
    jr  c,.transfer_size_sram
    ld  a,CART_ROM_MBC1_RAM_BAT
    cp  a,b
    jr  c,.check_mbc2_sram
    ld  a,$1                           ; MBC1: switch to RAM banking mode
    ld  [$6000],a
    jr  .transfer_size_sram

.check_mbc2_sram
    ld  a,b
    cp  a,CART_ROM_MBC2
    jr  c,.transfer_size_sram
    ld  a,CART_ROM_MBC2_BAT
    cp  a,b
    jr  c,.check_mbc5_rumble_sram
    ld  a,$6
    ld  h,a                            ; MBC2 has 512 half-bytes of built-in RAM
    ld  a,$1
    ld  [$FF82],a
    jr  .transfer_size_sram

.check_mbc5_rumble_sram
    ld  a,b
    cp  a,CART_ROM_MBC5_RUM
    jr  c,.transfer_size_sram
    ld  a,CART_ROM_MBC5_RUM_RAM_BAT
    cp  a,b
    jr  c,.transfer_size_sram
    ld  a,$2                           ; rumble carts use bit 3 of the RAM bank
                                       ; number for the motor
    ld  [$FF82],a

; Look up how many banks to transfer (none if the cart has no save).
.transfer_size_sram
    ld  b,$00
    ld  a,h
    and a,$07
    ld  c,a
    push hl
    ld  hl,_VRAM+sramSizes
    add hl,bc
    ld  a,[hl]
    pop hl
    ld  b,a
    xor a
    ld  [$FF80],a
    ld  [$FF81],a
    ld  a,b
    cp  a,$FF
    jr  z,.SRAM_banks_transfer_end
    ld  e,$00
.SRAM_banks_continue_transfer
    call _VRAM+.transfer_4_SRAM_sub_banks
    ld  a,b
    cp  a,$00
    jr  nz,.SRAM_banks_continue_transfer
.SRAM_banks_transfer_end

    jp  _VRAM+.copy_to_hram

; ============================================================
; Return in h the save size code for the transfer header. This is normally
; the cart header's $0149, but MBC2 carts put $00 there even though they have
; 512 half-bytes of RAM built in. For them it returns 6, which the page and
; .check_mbc2_sram both treat as the MBC2 size. Changes a.
; ============================================================
.load_sram_size_index
    ld  a,[$0147]                      ; cartridge type
    cp  a,CART_ROM_MBC2
    jr  z,.lssi_mbc2
    cp  a,CART_ROM_MBC2_BAT
    jr  z,.lssi_mbc2
    ld  a,[$0149]
    ld  h,a
    ret
.lssi_mbc2
    ld  a,$6
    ld  h,a
    ret

; ============================================================
; Bank switching. Each call moves four 16 KB ROM banks, or one 8 KB save RAM
; bank as four 2 KB pieces, and counts b down by one. The caller repeats
; until b reaches 0.
; ============================================================

.transfer_4_SRAM_sub_banks
    ld  c,$4
    ld  a,[$FF82]
    cp  a,$00
    jr  z,.transfer_4_SRAM_sub_banks_simple
    cp  a,$02
    jr  z,.transfer_4_SRAM_sub_banks_mbc5_rumble
    jr  .transfer_SRAM_sub_bank_mbc2

.transfer_4_SRAM_sub_banks_simple
    ld  a,[$FF80]
    ld  [$4000],a
    inc a
    ld  [$FF80],a
    ld  d,$A0
    ld  a,CART_RAM_ENABLE
    ld  [$0000],a
.transfer_4_SRAM_sub_banks_simple_loop
    call _VRAM+.transfer_SRAM_sub_bank
    ld  a,b
    cp  a,$00
    jr  z,.end_SRAM_transfer_simple
    dec c
    jr  nz,.transfer_4_SRAM_sub_banks_simple_loop
    dec b
.end_SRAM_transfer_simple
    xor a
    ld  [$0000],a                      ; disable save RAM again to protect it
    ret

.transfer_SRAM_sub_bank_mbc2
    ld  d,$A0
    ld  a,CART_RAM_ENABLE
    ld  [$0000],a
    call _VRAM+.transfer_SRAM_MBC2_bank
    ld  b,$00
    xor a
    ld  [$0000],a                      ; disable save RAM again to protect it
    ret

.transfer_4_SRAM_sub_banks_mbc5_rumble
    ld  a,[$FF80]
    ld  d,a
    ld  a,[$FF81]
    or  a,d
    ld  [$4000],a
    ld  a,[$FF80]
    inc a
    cp  a,CART_RUMBLE_ENABLE
    jr  nz,.save_next_sram_rumble_bank
    ld  a,[$FF81]
    add a,CART_RUMBLE_ENABLE*2
    ld  [$FF81],a
    xor a
.save_next_sram_rumble_bank
    ld  [$FF80],a
    ld  d,$A0
    ld  a,CART_RAM_ENABLE
    ld  [$0000],a
.transfer_4_SRAM_sub_banks_mbc5_rumble_loop
    call _VRAM+.transfer_SRAM_sub_bank
    ld  a,b
    cp  a,$00
    jr  z,.end_transfer_4_SRAM_sub_banks_mbc5_rumble
    dec c
    jr  nz,.transfer_4_SRAM_sub_banks_mbc5_rumble_loop
    dec b
.end_transfer_4_SRAM_sub_banks_mbc5_rumble
    xor a
    ld  [$0000],a                      ; disable save RAM again to protect it
    ret

.transfer_4_ROM_banks
    ld  c,$2
    ld  a,[$FF82]
    cp  a,$00
    jr  z,.transfer_4_ROM_banks_simple
    cp  a,$02
    jr  z,.transfer_4_ROM_banks_mbc5
    jr  .transfer_4_ROM_banks_mbc1

.transfer_4_ROM_banks_simple
    ld  a,[$FF80]
    ld  [$2100],a
    inc a
    ld  [$FF80],a
    call _VRAM+.transfer_ROM_bank
    ld  a,[$FF80]
    ld  [$2100],a
    inc a
    ld  [$FF80],a
    ld  d,$40
    call _VRAM+.transfer_ROM_bank
    ld  d,$40
    ld  a,b
    cp  a,$00
    jr  z,.end_ROM_transfer_simple
    dec c
    jr  nz,.transfer_4_ROM_banks_simple
    dec b
.end_ROM_transfer_simple
    ret

.transfer_4_ROM_banks_mbc5
    ld  a,[$FF80]
    ld  [$2100],a
    inc a
    ld  [$FF80],a
    ld  a,[$FF81]
    ld  [$3100],a
    call _VRAM+.transfer_ROM_bank
    ld  a,[$FF80]
    ld  [$2100],a
    inc a
    ld  [$FF80],a
    ld  a,[$FF81]
    ld  [$3100],a
    ld  a,[$FF80]
    cp  a,$00
    jr  nz,.keep_transfering_mbc5
    ld  a,[$FF81]
    inc a
    ld  [$FF81],a

.keep_transfering_mbc5
    ld  d,$40
    call _VRAM+.transfer_ROM_bank
    ld  d,$40
    ld  a,b
    cp  a,$00
    jr  z,.end_ROM_transfer_mbc5
    dec c
    jr  nz,.transfer_4_ROM_banks_mbc5
    dec b
.end_ROM_transfer_mbc5
    ret

.transfer_4_ROM_banks_mbc1
    ld  a,[$FF80]
    ld  [$2100],a
    inc a
    ld  [$FF80],a
    ld  a,[$FF81]
    ld  [$4000],a
    call _VRAM+.transfer_ROM_bank
    ld  a,[$FF80]
    ld  [$2100],a
    inc a
    ld  [$FF80],a
    ld  a,[$FF81]
    ld  [$4000],a
    ld  a,[$FF80]
    cp  a,$20
    jr  nz,.keep_transfering_mbc1
    xor a
    ld  [$FF80],a
    ld  a,[$FF81]
    inc a
    ld  [$FF81],a

.keep_transfering_mbc1
    ld  d,$40
    call _VRAM+.transfer_ROM_bank
    ld  d,$40
    ld  a,[$FF80]
    cp  a,$00
    jr  nz,.past_advanced_mode
    ld  d,$00
    inc a
    ld  [$6000],a
.past_advanced_mode
    ld  a,b
    cp  a,$00
    jr  z,.end_ROM_transfer_mbc1
    dec c
    jr  nz,.transfer_4_ROM_banks_mbc1
    dec b
.end_ROM_transfer_mbc1
    ret

; Transfer one 16 KB ROM bank, one 2 KB piece of save RAM, or MBC2's
; 512 bytes, starting at de.
.transfer_ROM_bank
    push bc
    ld  l,rROM_BANK_SIZE
    call _VRAM+.transfer_bank
    pop bc
    ret

.transfer_SRAM_sub_bank
    push bc
    ld  l,rSRAM_SUB_BANK_SIZE
    call _VRAM+.transfer_bank
    pop bc
    ret

.transfer_SRAM_MBC2_bank
    push bc
    ld  l,rSRAM_MBC2_BANK_SIZE
    call _VRAM+.transfer_bank
    pop bc
    ret

; ============================================================
; Transfer l sections of 256 bytes starting at de. Each section is followed
; by a check byte (all 256 bytes XORed together). If the check fails, both
; sides go back and repeat that section. rRESTORE_FLAG picks the direction.
; ============================================================
.transfer_bank
.transfer_section
    xor a
    ld  c,a                            ; c = check byte
    ld  b,a                            ; b = bytes left (0 means 256)
    ld  a,[rRESTORE_FLAG]
    and a,a
    jr  nz,.restore_byte
.transfer_byte
    ld  a,[de]
    xor c
    ld  c,a
    ld  a,[de]
    call _VRAM+.send_raw_byte
    inc de
    dec b
    jr  nz,.transfer_byte

    ; Send the check byte, then wait for the page to accept the section.
    ld  a,c
    call _VRAM+.send_raw_byte

    call _VRAM+.recv_raw_byte
    cp  a,rOK
    jr  z,.section_ok
    cp  a,CMD_ABORT
    jr  z,.abort_transfer
    jr  .section_retry
.restore_byte
    call _VRAM+.recv_raw_byte
    ld  [de],a                         ; write it to save RAM
    xor c
    ld  c,a
    inc de
    dec b
    jr  nz,.restore_byte

    ; Compare the page's check byte with the one worked out here.
    call _VRAM+.recv_raw_byte
    cp  a,c
    jr  nz,.restore_nak
    ld  a,rOK
    call _VRAM+.send_raw_byte          ; accept the section
    jr  .section_ok
.restore_nak
    cp  a,CMD_ABORT                    ; the page stops a restore by sending
    jr  z,.abort_transfer              ; CMD_ABORT in place of the check byte
    ld  a,rFAIL
    call _VRAM+.send_raw_byte          ; ask the page to send it again
.section_retry
    ; Go back 256 bytes and repeat the section.
    ld  a,d
    dec a
    ld  d,a
    jr  .transfer_section
.section_ok
    dec l
    jr  nz,.transfer_section
    ret

; Stop a dump or restore and go back to the menu.
.abort_transfer
    ld  sp,$FFFE
    xor a
    ld  [$0000],a                      ; disable save RAM
    jp  _VRAM+.copy_to_hram

; ============================================================
; Called by the menu loop at the start of every vertical blank. This code
; lives in video RAM, which the CPU can only reach while the screen isn't
; drawing, so it has to finish before the vertical blank ends.
; First it checks for a command from the web page; the page keeps sending a
; command until something happens, so checking once a frame is enough. Then
; it updates the screen for the cartridge: de = its logo checksum, c = 0 if
; its header checksum is right.
; ============================================================
.menu_frame
    ld  a,[rSC]
    add a,a
    jr  c,.menu_cart                   ; nothing received since the last frame
    ld  a,[rSB]
    ld  b,PADF_A
    cp  a,CMD_DUMP_ROM
    jr  z,.menu_button
    ld  b,PADF_B
    cp  a,CMD_DUMP_SAVE
    jr  z,.menu_button
    ld  b,PADF_SELECT
    cp  a,CMD_RESTORE
    jr  z,.menu_button
    cp  a,CMD_ENTER
    jr  z,.menu_enter
    ld  a,rSLAVE_MODE
    ld  [rSC],a
.menu_cart
    ld  a,e
    cp  a,LOGO_SUM1
    jr  nz,.menu_no_cart
    ld  a,d
    cp  a,LOGO_SUM2
    jr  nz,.menu_no_cart
    ld  a,c
    or  a,a
    jr  nz,.menu_no_cart
    ld  a,LCDC_CART
    ld  [rLCDC],a
    ld  hl,$0134                       ; title: 16 characters, 15 on GBC carts
    ld  de,TITLE_CELL
    ld  bc,$1010                       ; b = cells to fill, c = title length
    ld  a,[$0143]
    add a,a
    jr  nc,.title_loop
    dec c
.title_loop
    ld  a,c
    or  a,a
    jr  z,.title_blank
    dec c
    ld  a,[hl+]
    or  a,a
    jr  nz,.title_check
    ld  c,a                            ; a 0 byte ends the title
    jr  .title_blank
.title_check                           ; show anything unprintable as a space
    cp  a," "
    jr  c,.title_blank
    cp  a,$7F
    jr  c,.title_put
.title_blank
    ld  a," "
.title_put
    ld  [de],a
    inc e
    dec b
    jr  nz,.title_loop
    ret
.menu_no_cart
    ld  a,LCDC_NO_CART
    ld  [rLCDC],a
    ret
.menu_button                           ; b = the command, as a button bit
    xor a
    ld  [rLCDC],a                      ; screen off (safe: still in vertical blank)
    ld  sp,$FFFE
    jp  _VRAM+.prepare_ROM_dumper
.menu_enter
    xor a
    ld  [rLCDC],a

; ============================================================
; Receive the cart agent from the web page into work RAM and run it.
; Entered from .menu_frame with the screen off. The upload format is
; described with CMD_ENTER at the top of this file.
; ============================================================
.loader
    ld  sp,$FFFE
.loader_sync
    ld  a,LOADER_TAG
    call _VRAM+.send_raw_byte
    ld  a,[rSB]
    cp  a,LOADER_GO
    jr  nz,.loader_sync
    call _VRAM+.recv_raw_byte
    ld  c,a
    call _VRAM+.recv_raw_byte
    ld  b,a
    call _VRAM+.recv_raw_byte
    cpl
    cp  a,c
    jr  nz,.loader_sync
    call _VRAM+.recv_raw_byte
    cpl
    cp  a,b
    jr  nz,.loader_sync
    ld  a,b
    or  a,c
    jr  z,.loader_sync
    ld  a,b
    cp  a,HIGH(AGENT_MAX)
    jr  nc,.loader_sync
    ld  hl,AGENT_BASE
    ld  de,$0000
    ; The page sends the next byte only a short, fixed gap after the last
    ; one, so the serial port is re-armed as soon as each byte arrives and
    ; only then is the byte stored. It stays in rSB until the next clock.
    ld  a,rSLAVE_MODE
    ld  [rSC],a
.loader_wait
    ld  a,[rSC]
    add a,a
    jr  c,.loader_wait
    ld  a,rSLAVE_MODE
    ld  [rSC],a
    ld  a,[rSB]
    ld  [hl],a
    ld  a,[hl+]                        ; checksum what was actually stored, so a
                                       ; failed write is caught too
    add a,e
    ld  e,a
    add a,d
    ld  d,a
    dec bc
    ld  a,b
    or  a,c
    jr  nz,.loader_wait
    call _VRAM+.recv_raw_byte
    cp  a,e
    jr  nz,.loader_sync
    call _VRAM+.recv_raw_byte
    cp  a,d
    jr  nz,.loader_sync
    ld  hl,_VRAM+start                 ; the agent jumps here when it exits
    jp  AGENT_BASE

; ============================================================
; Send or receive one byte. The page clocks it; these wait until it has.
; ============================================================
.send_raw_byte
    ld  [rSB],a
    ld  a,rSLAVE_MODE
    ld  [rSC],a
.send_raw_wait
    ld  a,[rSC]
    bit 7,a
    jr  nz,.send_raw_wait
    ret

.recv_raw_byte
    ld  a,$00
    ld  [rSB],a
    ld  a,rSLAVE_MODE
    ld  [rSC],a
.recv_raw_wait
    ld  a,[rSC]
    bit 7,a
    jr  nz,.recv_raw_wait
    ld  a,[rSB]
    ret

; ============================================================
; Older half-byte transfer routines from the original dumper. Nothing calls
; them.
; ============================================================
.send_byte
    push hl
    ld  l,rBASE_VAL
    call _VRAM+.send_generic_byte
    pop hl
    ret

.send_check_byte
    push hl
    ld  l,rCHECK_VAL
    call _VRAM+.send_generic_byte
    pop hl
    ret

.send_generic_byte
    push bc
    ld  h,a
    call _VRAM+.send_nybble
    ld  b,a
    swap b
    call _VRAM+.send_nybble
    or a,b
    pop bc
    ret

.send_nybble
    swap h
    ld  a,h
    and a,$0F
    or  a,l
    ld  [rSB],a
    ld  a,rSLAVE_MODE
    ld  [rSC],a
.wait_end
    ld  a,[rSC]
    bit 7,a
    jr  nz,.wait_end
    ld  c,$FF
.wait_sync
    dec c
    jr  nz,.wait_sync
    ld  a,[rSB]
    and a,$0F
    ret

SECTION "HRAM",ROM0
; The menu loop. It is copied to high RAM and runs from there, because the
; CPU can't read video RAM (where the rest of the program is) while the
; screen is drawing. Each frame it checks the inserted cartridge, waits for
; the vertical blank, and calls .menu_frame.
hram_code:
    ld  a,LCDC_NO_CART
    ld  [rLCDC],a
.main_loop
    ld  hl,$0104                       ; checksum the cart's Nintendo logo
    ld  de,$0000
    ld  b,$30
.logo_loop
    ld  a,[hl+]
    add a,e
    ld  e,a
    add a,d
    ld  d,a
    dec b
    jr  nz,.logo_loop
    ld  b,$19                          ; a correct header checksum makes $19 plus
                                       ; the bytes $0134-$014D add up to 0
    ld  a,b
.header_loop
    add [hl]
    inc l
    dec b
    jr  nz,.header_loop
    add [hl]
    ld  c,a
    xor a
    ld  [rIF],a
.wait_vblank
    ld  a,[rIF]
    rrca
    jr  nc,.wait_vblank
    call _VRAM+start.menu_frame
    jr  .main_loop

; Helpers for drawing the menu, run from high RAM because they switch the
; video RAM bank away from the one this program runs in.

; Set every cell of both maps to palette 0 (VRAM bank 1, $9800-$9FFF).
hram_clear_attrs:
    ld  a,1
    ld  [rVBK],a
    xor a
    ld  hl,_SCRN0
.clear_loop
    ld  [hl+],a
    bit 5,h                            ; stop at $A000
    jr  z,.clear_loop
    ld  [rVBK],a
    ret

; Set the palette of the map cell at de to c.
hram_put_attr:
    ld  a,1
    ld  [rVBK],a
    ld  a,c
    ld  [de],a
    xor a
    ld  [rVBK],a
    ret
hram_code_end:

; How many groups of 4 ROM banks to send for each ROM size code ($0148).
; 0 means a 32 KB cart's 2 banks. Codes $52-$54 land at $12-$14 once masked.
    SECTION "ROM_SIZES",ROM0
romSizes:
DB $00,$01,$02,$04,$08,$10,$20,$40,$80,$00,$00,$00,$00,$00,$00,$00,$00,$00,$12,$14,$18

; How many 8 KB save RAM banks to transfer for each save size code ($0149).
; $FF means no save, and 0 means a single 2 KB piece (or MBC2's 512 bytes).
    SECTION "SRAM_SIZES",ROM0
sramSizes:
DB $FF,$00,$01,$04,$10,$08,$00

; ============================================================
; Menu screen data
; ============================================================
RGB: MACRO                             ; red, green, blue, each 0-31
    dw (\1) | (\2) << 5 | (\3) << 10
ENDM

; Text entry for .draw_text: row, column, palette, text
TEXT: MACRO
    db HIGH(\1*32+\2), LOW(\1*32+\2), \3, \4, 0
ENDM

    SECTION "Menu_Palette",ROM0
; Eight background palettes of four colours each. The note on the last
; colour of each palette says what it is used for.
menuPalette:
    RGB 31,31,31
    RGB 20,21,24
    RGB 10,11,14
    RGB  3, 4, 9                       ; 0: text
    RGB  4, 8,19
    RGB  8,12,22
    RGB 20,22,28
    RGB 31,31,31                       ; 1: title bar
    RGB 31,31,31
    RGB 20,21,24
    RGB 10,11,14
    RGB  2,17, 6                       ; 2: cartridge ready
    RGB 31,31,31
    RGB 20,21,24
    RGB 10,11,14
    RGB 27, 9, 2                       ; 3: no cartridge
    RGB 24,27,31
    RGB 20,21,24
    RGB 10,11,14
    RGB  2, 4,12                       ; 4: the cart's title
    RGB 31,31,31
    RGB 22,23,25
    RGB  6,13,27
    RGB  5, 6, 9                       ; 5: cartridge icon
    RGB 31,31,31
    RGB 29,29,30
    RGB 27,27,28
    RGB 21,21,23                       ; 6: cartridge icon, no cartridge
    RGB 31,31,31
    RGB 24,25,27
    RGB 10,11,14
    RGB 13,14,17                       ; 7: notes
menuPaletteEnd:

    SECTION "Menu_Font",ROM0
fontData:                              ; made by tools/make_gbc_ui.py
INCBIN "ui_font.bin"
fontDataEnd:
iconTiles:
INCBIN "ui_tiles.bin"
iconTilesEnd:

    SECTION "Menu_Text",ROM0
; Text on both screens. The raw db rows place tiles directly: 5 is the
; divider line, 1-4 the cartridge icon.
textCommon:
    TEXT 0,0,1,"                    "
    TEXT 1,0,1," GB-Link Cart Doctor"
    TEXT 2,0,1,"                    "
    db HIGH(13*32+1), LOW(13*32+1), 7, 5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5, 0
    TEXT 14,1,7,"The screen turns"
    TEXT 15,1,7,"off while the web"
    TEXT 16,1,7,"page is working."
    db $FF
textNoCart:
    db HIGH(4*32+1), LOW(4*32+1), 6, 1,2, 0
    db HIGH(5*32+1), LOW(5*32+1), 6, 3,4, 0
    TEXT 4,4,3,"No cartridge"
    TEXT 7,1,0,"Insert a GB or GBC"
    TEXT 8,1,0,"cartridge. Blank"
    TEXT 9,1,0,"flash carts show"
    TEXT 10,1,0,"this screen too."
    db $FF
textCart:
    db HIGH(4*32+1), LOW(4*32+1), 5, 1,2, 0
    db HIGH(5*32+1), LOW(5*32+1), 5, 3,4, 0
    TEXT 4,4,2,"Cartridge ready"
    TEXT 6,0,4,"                    "
    TEXT 7,0,4,"                    "
    TEXT 8,0,4,"                    "
    TEXT 10,1,0,"Dump, restore or"
    TEXT 11,1,0,"flash it from the"
    TEXT 12,1,0,"web page."
    db $FF
