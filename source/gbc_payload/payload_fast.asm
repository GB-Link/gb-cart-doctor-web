    INCLUDE "hardware.inc"             ; system defines

rROM_TRANSFER EQU $1
rSRAM_TRANSFER EQU $2
rSLAVE_MODE EQU $82
rOK  EQU $1
rFAIL EQU $0
rBASE_VAL EQU $10
rCHECK_VAL EQU $40
rROM_BANK_SIZE EQU $40
rSRAM_SUB_BANK_SIZE EQU $8
rSRAM_MBC2_BANK_SIZE EQU $2
CART_RUMBLE_ENABLE EQU $8

; Fast protocol marker — master sends this to signal fast mode
rFAST_MAGIC EQU $F5


    SECTION "Init", ROM0[$0]
    xor a
    ld  [rLCDC],a
    jp  _VRAM+start

    SECTION "Entrypoint", ROM0[$100]
    nop
    jp  launch

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

    SECTION "Start",ROM0[$200]         ; start vector, followed by header data applied by rgbfix.exe

start:
	ld	[rSCX],a
	ld	[rSCY],a
    ld  sp,$FFFE                       ; setup stack
    ld  a,$10                          ; read P15 - returns a, b, select, start
    ld  [rP1],a
    ld  a,$80
    ld  [rBCPS],a
    ld  [rOCPS],a
    ld  [$FF4C],a                      ; set as GBC+DMG
    ld  a,rBASE_VAL
    ld  [rSB],a

.init_palette
    ld  b,$10
    ld  hl,_VRAM+palette
.palette_loop_obj
    ld  a,[hl+]
    ld  [rOCPD],a
    dec b
    jr  nz,.palette_loop_obj
    ld  b,$8
.palette_loop_bg
    ld  a,[hl+]
    ld  [rBCPD],a
    dec b
    jr  nz,.palette_loop_bg
    ld  a,$FC
    ld  [rBGP],a

.init_arrangements
    ld hl,_VRAM+emptyTile
    ld b,[hl]
    ld de,$0240
    ld hl,$9C00
.arrangements_loop
    ld  a,b
    ld [hl+],a
    dec de
    ld  a,d
    or  a,e
    jr  nz,.arrangements_loop

.copy_to_hram
    ld  hl,_VRAM+hram_code
    ld  c,$80
.copy_hram_loop
    ld  a,[hl+]
    ld  [$ff00+c],a
    inc c
    jr  nz,.copy_hram_loop

.jump_to_hram
    jp  $FF80

.prepare_ROM_dumper
    ld  a,b
    and a,PADF_A|PADF_START
    jp  z,_VRAM+.prepare_SRAM_dumper
    push bc

.send_start_rom
    ; Send header: [magic, transfer_type, size_index, checksum]
    ld  a,[$0148]
    ld  h,a
    ld  a,$1F
    and a,h
    ld  h,a                            ; h = size index

    ; Send 4-byte header via fast protocol
    ld  a,rFAST_MAGIC
    call _VRAM+.send_raw_byte          ; byte 0: magic
    ld  a,rROM_TRANSFER
    call _VRAM+.send_raw_byte          ; byte 1: transfer type
    ld  a,h
    call _VRAM+.send_raw_byte          ; byte 2: size index
    ; checksum = magic ^ type ^ size
    ld  a,rFAST_MAGIC
    xor rROM_TRANSFER
    xor h
    call _VRAM+.send_raw_byte          ; byte 3: checksum

    ; Wait for ack
    call _VRAM+.recv_raw_byte
    cp  a,rOK
    jr  nz,.send_start_rom

.check_mbc1_rom
    xor a
    ld  [$FF82],a                      ; which type of function one should use
    ld  a,[$0147]
    ld  b,a
    cp  a,CART_ROM_MBC1
    jr  c,.transfer_size_rom
    ld  a,CART_ROM_MBC1_RAM_BAT
    cp  a,b
    jr  c,.check_mbc5_rom
    ld  a,$1                           ; MBC1 has separate ROM addressing bits
    ld  [$FF82],a
    jr  .transfer_size_rom

.check_mbc5_rom
    ld  a,b
    cp  a,CART_ROM_MBC5
    jr  c,.transfer_size_rom
    ld  a,CART_ROM_MBC5_RUM_RAM_BAT
    cp  a,b
    jr  c,.transfer_size_rom
    ld  a,$2                           ; MBC5 can access up to 0x1E0 different banks
    ld  [$FF82],a

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
    ld  a,[$0149]
    ld  h,a                            ; h = SRAM size index

    ; Send 4-byte header
    ld  a,rFAST_MAGIC
    call _VRAM+.send_raw_byte          ; byte 0: magic
    ld  a,rSRAM_TRANSFER
    call _VRAM+.send_raw_byte          ; byte 1: transfer type
    ld  a,h
    call _VRAM+.send_raw_byte          ; byte 2: size index
    ld  a,rFAST_MAGIC
    xor rSRAM_TRANSFER
    xor h
    call _VRAM+.send_raw_byte          ; byte 3: checksum

    ; Wait for ack
    call _VRAM+.recv_raw_byte
    cp  a,rOK
    jr  nz,.send_start_sram

.check_mbc1_sram
    xor a
    ld  [$FF82],a                      ; which type of function one should use
    ld  a,[$0147]
    ld  b,a
    cp  a,CART_ROM_MBC1
    jr  c,.transfer_size_sram
    ld  a,CART_ROM_MBC1_RAM_BAT
    cp  a,b
    jr  c,.check_mbc5_rumble_sram
    ld  a,$1                           ; enable SRAM advanced banking mode
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
    ld  h,a                            ; MBC2 carts have 0x200 SRAM bytes of 4 bits
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
    ld  a,$2                           ; Rumble breaks the SRAM addressing bits in half
    ld  [$FF82],a

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
; Bank transfer routines (unchanged logic, using fast SPI)
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
    ld  [$0000],a                      ; disable cart SRAM to avoid damage
    ret

.transfer_SRAM_sub_bank_mbc2
    ld  d,$A0
    ld  a,CART_RAM_ENABLE
    ld  [$0000],a
    call _VRAM+.transfer_SRAM_MBC2_bank
    ld  b,$00
    xor a
    ld  [$0000],a                      ; disable cart SRAM to avoid damage
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
    ld  [$0000],a                      ; disable cart SRAM to avoid damage
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
; Fast section transfer: 256 raw bytes + 1 checksum byte
; Section retries on checksum failure.
; l = number of sections to transfer
; de = source address (auto-increments through 256-byte pages)
; ============================================================
.transfer_bank
.transfer_section
    ; Send 256 bytes, accumulate XOR checksum in c
    xor a
    ld  c,a                            ; c = checksum = 0
    ; b counts 256 bytes (wraps from 0)
    ld  b,a
.transfer_byte
    ld  a,[de]
    xor c
    ld  c,a                            ; checksum ^= byte
    ld  a,[de]
    call _VRAM+.send_raw_byte          ; send data byte
    inc de
    dec b
    jr  nz,.transfer_byte

    ; Send checksum
    ld  a,c
    call _VRAM+.send_raw_byte

    ; Wait for ack from master
    call _VRAM+.recv_raw_byte
    cp  a,rOK
    jr  z,.section_ok
    ; Retry: rewind de by 256
    ld  a,d
    dec a
    ld  d,a
    jr  .transfer_section
.section_ok
    dec l
    jr  nz,.transfer_section
    ret

; ============================================================
; Fast SPI: send/receive single raw bytes (no nybble split)
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
; Legacy slow SPI (kept for compatibility — used if fast
; protocol is not detected, but currently unused)
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

SECTION "HRAM_NO_BANK_SWITCHING",ROM0
hram_code_no_bank:
    ld  a,LCDCF_ON | LCDCF_BG8000 | LCDCF_BG9C00 | LCDCF_OBJ8 | LCDCF_OBJOFF | LCDCF_WINOFF | LCDCF_BGON
    ld  [rLCDC],a
    ld  hl,$0000

SECTION "HRAM",ROM0
hram_code:
    ld  a,LCDCF_ON | LCDCF_BG8000 | LCDCF_BG9C00 | LCDCF_OBJ8 | LCDCF_OBJOFF | LCDCF_WINOFF | LCDCF_BGON
    ld  [rLCDC],a
.main_loop
.inner_loop
    xor a
    ld  [rIF],a
    inc a
    ld  [rIE],a
    jr  .wait_interrupt

.check_logo
    ld  hl,$0104                       ; Start of the Nintendo logo
    ld  b,$30                          ; Nintendo logo's size
    ld  de,_VRAM+logoData
.check_logo_loop
    call $FF80+.wait_VRAM_accessible-hram_code
    ld  a,[de]
    cp  [hl]
    jr  nz,.failure
    inc de
    inc hl
    dec b
    jr  nz,.check_logo_loop

.check_header
    ld  b,$19
    ld  a,b
.check_header_loop
    add [hl]
    inc l
    dec b
    jr  nz,.check_header_loop
    add [hl]
    jr  nz,.failure

.success
    ld  a,$1
    call $FF80+.change_arrangements-hram_code
    ld  a,[rP1]                        ; read input
    cpl
    and a,PADF_A|PADF_B|PADF_START
    ld  b,a
    jr  z,.main_loop
    call $FF80+.wait_VRAM_accessible-hram_code
    xor a
    ld  [rLCDC],a
    jp  _VRAM+start.prepare_ROM_dumper

.failure
    xor a
    call $FF80+.change_arrangements-hram_code
    jr  .main_loop

.wait_VRAM_accessible
    push hl
    ld  hl,rSTAT
.wait
    bit 1,[hl]                         ; Wait until Mode is 0
    jr  nz,.wait
    pop hl
    ret

.change_arrangements
    and a,$1
    jr  z,.load_waiting_arrangements

    ld  de,_VRAM+confirmedArrangements
    jr  .chosen_arrangements

.load_waiting_arrangements
    ld  de,_VRAM+waitArrangements

.chosen_arrangements
    ld  b,$C0                          ; Arrangements' size
    ld  hl,$9C00+$C0
.change_arrangements_loop
    call $FF80+.wait_VRAM_accessible-hram_code
    ld   a,[de]
    add  a,$80
    ld   [hl+],a
    inc  de
    dec  b
    jr   nz,.change_arrangements_loop
    ret

.wait_interrupt
    ld  a,[rIF]
    and a,$1
    jr  z,.wait_interrupt
    jr  .check_logo

    SECTION "LOGO",ROM0
logoData:
INCBIN "logo.bin"

    SECTION "ROM_SIZES",ROM0
romSizes:
DB $00,$01,$02,$04,$08,$10,$20,$40,$80,$00,$00,$00,$00,$00,$00,$00,$00,$00,$12,$14,$18

    SECTION "SRAM_SIZES",ROM0
sramSizes:
DB $FF,$00,$01,$04,$10,$08,$00

    SECTION "Base_Arrangement",ROM0
emptyTile:
DB $67+$80
waitArrangements:
INCBIN "ui_arrangements_wait.bin"
confirmedArrangements:
INCBIN "ui_arrangements_confirmed.bin"

    SECTION "Palette",ROM0
palette:
INCBIN "palette.bin"

SECTION "Graphics",ROM0[$800]
INCBIN "ui_graphics.bin"
