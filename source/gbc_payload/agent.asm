; GB Cart Doctor cart agent.
;
; A small program that runs on the GBC and does cartridge work for the web
; page. The page uploads it into GBC work RAM through the payload's loader
; (payload_fast.asm, .loader), then sends it short lists of operations to
; run: write a byte, read a range, wait for a flash chip, program flash,
; checksum a range, check that a range is blank. The agent knows nothing
; about mappers or flash chips; the page decides every step (see
; web/gb_cart.js and web/gb_flash.js).
;
; How the two sides talk. The GBC is the serial slave: the GB-Link clocks
; every byte, and the GBC can only answer with the byte it has loaded.
;   Sync:    the agent keeps offering a tag byte (TAG_READY when it wants a
;            program, TAG_DONE when it has a result) until the page sends
;            GO1 and then GO2 back while that tag is loaded.
;   Program: after READY the page sends the length N (low byte, high byte),
;            the length again with all bits flipped, the N operation bytes,
;            and a two-byte checksum. If anything doesn't match, the agent
;            ignores the program and goes back to READY.
;   Result:  after DONE the agent sends the length N, a status byte, how many
;            operations ran (2 bytes), the result bytes and a two-byte
;            checksum. The page answers ACK_OK, or anything else to ask for
;            the result again.
; The checksum is a Fletcher sum: for each byte, sum1 += byte and
; sum2 += sum1, both kept to 8 bits.
;
; Built with: rgbasm -i inc/ -o agent.o agent.asm && rgblink -x -o agent.bin agent.o

    INCLUDE "hardware.inc"

AGENT_VERSION EQU 1

TAG_READY   EQU $A7
TAG_DONE    EQU $D7
GO1         EQU $5A
GO2         EQU $96
ACK_OK      EQU $01
SLAVE_START EQU $80

ST_OK       EQU 0
ST_TIMEOUT  EQU 1
ST_BAD      EQU 2

PROG_BUF    EQU $D000              ; where the page's program is received
PROG_MAX    EQU $0F00              ; size limit, so the program and its checksum
                                   ; end before echo RAM at $E000
CRC_TABLE   EQU $9000              ; 4 x 256 bytes, kept in video RAM (free while
                                   ; the screen is off)
RES_BUF     EQU $9400              ; where the result is built before sending
RES_END     EQU $9F00              ; result limit; the checksum goes just after the
                                   ; result. This runs into the menu's background
                                   ; map at $9C00, which the menu redraws on exit
TMPL_CODE   EQU $CF00              ; flash write routine built by op_tmpl
PROG_HEAD   EQU $CFF0              ; the program's 4 length bytes as received
TMPL_STEPS  EQU 10
POLL_LIMIT  EQU 1600               ; about 20 ms to wait for one flash byte

; Variables in high RAM
hResLo      EQU $FF80              ; next free byte in the result
hResHi      EQU $FF81
hStatus     EQU $FF82
hExecLo     EQU $FF83
hExecHi     EQU $FF84
hExit       EQU $FF85
hDiv        EQU $FF86
hTimeLo     EQU $FF87
hTimeHi     EQU $FF88
hNextLo     EQU $FF89              ; the operation after the current one
hNextHi     EQU $FF8A
hCntLo      EQU $FF8B
hCntHi      EQU $FF8C
hBlocks     EQU $FF8D
hRetLo      EQU $FF8E              ; where to return to the payload menu
hRetHi      EQU $FF8F
hCrc        EQU $FF90              ; 4 bytes, the running CRC32, low byte first

    SECTION "agent", ROM0[$0]
LOAD "agent_ram", WRAM0[$C100]

; The loader jumps here with hl = the address of the payload's menu, which
; the agent returns to when the page sends EXIT.
agent_start:
    di
    ld  sp,$FFFE
    ld  a,l
    ldh [hRetLo],a
    ld  a,h
    ldh [hRetHi],a
    call make_crc_table

main:
    ld  a,TAG_READY
    call sync
    call recv_program
    jr  c,main
    call run_program
.result
    ld  a,TAG_DONE
    call sync
    call send_result
    call recv
    cp  ACK_OK
    jr  nz,.result
    ldh a,[hExit]
    and a
    jr  z,main
    ldh a,[hRetLo]
    ld  l,a
    ldh a,[hRetHi]
    ld  h,a
    jp  hl

; ------------------------------------------------------------------ link
;
; The GB-Link clocks the next byte only a short, fixed gap after the last
; one, so every loop re-arms the serial port as soon as a byte completes and
; only then deals with it. Re-arming doesn't lose the byte just received: it
; stays in rSB until the next clock starts.

; Send a and return the byte the page sent at the same time.
xfer:
    ldh [rSB],a
    ld  a,SLAVE_START
    ldh [rSC],a
.wait
    ldh a,[rSC]
    add a,a
    jr  c,.wait
    ldh a,[rSB]
    ret

recv:
    xor a
    jr  xfer

; Keep offering tag a until the page answers GO1 and then GO2.
sync:
    ld  b,a
.again
    ld  a,b
    ldh [rSB],a
    ld  a,SLAVE_START
    ldh [rSC],a
.wait1
    ldh a,[rSC]
    add a,a
    jr  c,.wait1
    ldh a,[rSB]
    cp  GO1
    jr  nz,.again
    ld  a,b
    ldh [rSB],a
    ld  a,SLAVE_START
    ldh [rSC],a
.wait2
    ldh a,[rSC]
    add a,a
    jr  c,.wait2
    ldh a,[rSB]
    cp  GO2
    jr  nz,.again
    ret

; Receive bc bytes (bc > 0) to hl, echoing each one back.
recv_block:
    ld  a,SLAVE_START
    ldh [rSC],a
    inc b
    inc c
    jr  .count
.wait
    ldh a,[rSC]
    add a,a
    jr  c,.wait
    ld  a,SLAVE_START
    ldh [rSC],a
    ldh a,[rSB]
    ld  [hl+],a
.count
    dec c
    jr  nz,.wait
    dec b
    jr  nz,.wait
    ret

; Fletcher sum of bc bytes (bc > 0) at hl into de.
sum_block:
    ld  de,0
    inc b
    inc c
    jr  .count
.byte
    ld  a,[hl+]
    add a,e
    ld  e,a
    add a,d
    ld  d,a
.count
    dec c
    jr  nz,.byte
    dec b
    jr  nz,.byte
    ret

; Receive a program into PROG_BUF. Returns carry set if it was rejected.
recv_program:
    ld  hl,PROG_HEAD
    ld  bc,4
    call recv_block
    ld  hl,PROG_HEAD
    ld  a,[hl+]
    ld  c,a
    ld  a,[hl+]
    ld  b,a
    ld  a,[hl+]
    cpl
    cp  c
    jr  nz,.bad
    ld  a,[hl]
    cpl
    cp  b
    jr  nz,.bad
    ld  a,b
    or  c
    jr  z,.bad
    ld  a,b
    cp  HIGH(PROG_MAX)
    jr  nc,.bad
    push bc
    inc bc
    inc bc                         ; the program plus its 2 checksum bytes
    ld  hl,PROG_BUF
    call recv_block
    pop bc
    ld  hl,PROG_BUF
    call sum_block
    ld  a,[hl+]
    cp  e
    jr  nz,.bad
    ld  a,[hl-]
    cp  d
    jr  nz,.bad
    ld  [hl],0                     ; mark the end of the program (op 0)
    and a
    ret
.bad
    scf
    ret

; Send the result and its checksum (seal_frame put the checksum after it).
; The next byte is loaded before waiting, so it is ready when the clock comes.
send_result:
    ldh a,[hResLo]
    sub LOW(RES_BUF-2)
    ld  c,a
    ldh a,[hResHi]
    sbc HIGH(RES_BUF-2)
    ld  b,a
    ld  hl,RES_BUF
    ld  e,[hl]
    inc hl
    inc b
    inc c
    jr  .count
.byte
    ld  a,e
    ldh [rSB],a
    ld  a,SLAVE_START
    ldh [rSC],a
    ld  e,[hl]
    inc hl
.wait
    ldh a,[rSC]
    add a,a
    jr  c,.wait
.count
    dec c
    jr  nz,.byte
    dec b
    jr  nz,.byte
    ret

; ------------------------------------------------------------------ programs

; Run the program in PROG_BUF. Each operation is one byte (its number in
; op_table) followed by its arguments.

run_program:
    ld  a,LOW(RES_BUF+5)
    ldh [hResLo],a
    ld  a,HIGH(RES_BUF+5)
    ldh [hResHi],a
    xor a
    ldh [hStatus],a
    ldh [hExecLo],a
    ldh [hExecHi],a
    ldh [hExit],a
    ld  hl,PROG_BUF
.next
    ld  a,[hl+]
    and a
    jr  z,.end
    cp  NUM_OPS
    jr  nc,.bad_op
    push hl
    add a,a
    ld  e,a
    ld  d,0
    ld  hl,op_table-2
    add hl,de
    ld  a,[hl+]
    ld  h,[hl]
    ld  l,a
    ld  b,h
    ld  c,l
    pop hl
    push bc
    ret                            ; jump to the handler; hl = its arguments
.bad_op
    ld  a,ST_BAD
    ldh [hStatus],a
.end
    ; Fill in the result header: length, status, operations run.
    ldh a,[hResLo]
    sub LOW(RES_BUF+2)
    ld  [RES_BUF],a
    ldh a,[hResHi]
    sbc HIGH(RES_BUF+2)
    ld  [RES_BUF+1],a
    ldh a,[hStatus]
    ld  [RES_BUF+2],a
    ldh a,[hExecLo]
    ld  [RES_BUF+3],a
    ldh a,[hExecHi]
    ld  [RES_BUF+4],a
    ; fall through

; Add the checksum after the result, so it is ready before the page asks.
seal_frame:
    ldh a,[hResLo]
    sub LOW(RES_BUF)
    ld  c,a
    ldh a,[hResHi]
    sbc HIGH(RES_BUF)
    ld  b,a
    ld  hl,RES_BUF
    call sum_block
    ld  a,e
    ld  [hl+],a
    ld  [hl],d
    ret

; Each handler jumps here when done, with hl = the next operation.
op_done:
    ldh a,[hExecLo]
    inc a
    ldh [hExecLo],a
    jr  nz,run_program.next
    ldh a,[hExecHi]
    inc a
    ldh [hExecHi],a
    jr  run_program.next

; Stop the program early with status a.
op_stop:
    ldh [hStatus],a
    jr  run_program.end

op_table:
    dw  op_wr, op_rd, op_wait, op_delay, op_tmpl, op_prog
    dw  op_crc, op_blank, op_wrblk, op_info, op_exit
NUM_OPS EQU (@-op_table)/2+1

; Make room for bc more result bytes and return where they go in hl.
; Returns carry set if the result is full.
res_reserve:
    ldh a,[hResLo]
    ld  l,a
    ldh a,[hResHi]
    ld  h,a
    push hl
    add hl,bc
    jr  c,.full
    ld  a,h
    cp  HIGH(RES_END)
    jr  c,.ok
    jr  nz,.full
    ld  a,l
    and a
    jr  nz,.full
.ok
    ld  a,l
    ldh [hResLo],a
    ld  a,h
    ldh [hResHi],a
    pop hl
    and a
    ret
.full
    pop hl
    scf
    ret

; Read an address (de) and a count (bc) from the op arguments at hl.
args_addr_count:
    ld  a,[hl+]
    ld  e,a
    ld  a,[hl+]
    ld  d,a
    ld  a,[hl+]
    ld  c,a
    ld  a,[hl+]
    ld  b,a
    ret

save_next:
    ld  a,l
    ldh [hNextLo],a
    ld  a,h
    ldh [hNextHi],a
    ret

load_next:
    ldh a,[hNextLo]
    ld  l,a
    ldh a,[hNextHi]
    ld  h,a
    ret

bad_args:
    ld  a,ST_BAD
    jr  op_stop

; CRC and BLANK work on whole 256-byte blocks, so the address (de) and
; count (bc) must both be multiples of 256 and the count can't be 0.
check_blocks:
    ld  a,c
    or  e
    jr  nz,.bad
    or  b
    ret nz
.bad
    pop hl                         ; skip returning to the caller
    jr  bad_args

; WR address(2) value(1): write one byte.
op_wr:
    ld  a,[hl+]
    ld  e,a
    ld  a,[hl+]
    ld  d,a
    ld  a,[hl+]
    ld  [de],a
    jp  op_done

; RD address(2) count(2): read count bytes into the result.
op_rd:
    call args_addr_count
    call save_next
    ld  a,b
    or  c
    jr  z,bad_args
    call res_reserve
    jr  c,bad_args
.copy
    ld  a,[de]
    inc de
    ld  [hl+],a
    dec bc
    ld  a,b
    or  c
    jr  nz,.copy
    call load_next
    jp  op_done

; WAIT address(2) mask(1) value(1) time(2): read the address until
; (byte AND mask) == value, giving up after time/64 seconds with ST_TIMEOUT.
; Adds the last byte read to the result. Time is measured with the DIV
; timer, which wraps 64 times a second.
op_wait:
    ld  a,[hl+]
    ld  e,a
    ld  a,[hl+]
    ld  d,a
    ld  a,[hl+]
    ld  b,a
    ld  a,[hl+]
    ld  c,a
    ld  a,[hl+]
    ldh [hTimeLo],a
    ld  a,[hl+]
    ldh [hTimeHi],a
    call save_next
    ldh a,[rDIV]
    ldh [hDiv],a
.poll
    ld  a,[de]
    ld  h,a
    and b
    cp  c
    jr  z,.match
    ldh a,[rDIV]
    ld  l,a
    ldh a,[hDiv]
    cp  l
    ld  a,l
    ldh [hDiv],a
    jr  c,.poll                    ; DIV went up
    jr  z,.poll                    ; DIV unchanged
    ldh a,[hTimeLo]                ; DIV wrapped round: 1/64 s has passed
    sub 1
    ldh [hTimeLo],a
    ldh a,[hTimeHi]
    sbc 0
    ldh [hTimeHi],a
    jr  nc,.poll
    call .store
    ld  a,ST_TIMEOUT
    jp  op_stop
.match
    call .store
    call load_next
    jp  op_done
.store
    push hl
    ld  bc,1
    call res_reserve
    pop bc
    jr  c,.full
    ld  [hl],b
    ret
.full
    pop hl                         ; skip returning to the caller
    jp  bad_args

; DELAY ms(2): wait roughly that many milliseconds.
op_delay:
    ld  a,[hl+]
    ld  c,a
    ld  a,[hl+]
    ld  b,a
.ms
    ld  a,b
    or  c
    jr  z,.done
    ld  a,255
.inner
    dec a
    jr  nz,.inner
    dec bc
    jr  .ms
.done
    jp  op_done

; TMPL steps(1), then for each step kind(1) value(1) address(2).
; Builds a small routine at TMPL_CODE that writes one byte to flash; PROG
; calls it for every byte. Flash chips need a fixed sequence of command
; writes before each byte, and this lets the page describe that sequence.
; In kind, bit 0 set means write the data byte (otherwise write value), and
; bit 1 set means write to the byte's own address (otherwise to address).
op_tmpl:
    ld  a,[hl+]
    ld  b,a
    cp  TMPL_STEPS+1
    jp  nc,bad_args
    ld  de,TMPL_CODE
    and a
    jr  z,.finish
.step
    ld  a,[hl+]
    ld  c,a
    bit 0,c
    jr  nz,.data
    ld  a,$3E                      ; ld a,value
    ld  [de],a
    inc de
    ld  a,[hl+]
    ld  [de],a
    inc de
    jr  .where
.data
    ld  a,$1A                      ; ld a,[de]
    ld  [de],a
    inc de
    inc hl
.where
    bit 1,c
    jr  nz,.here
    ld  a,$EA                      ; ld [addr],a
    ld  [de],a
    inc de
    ld  a,[hl+]
    ld  [de],a
    inc de
    ld  a,[hl+]
    ld  [de],a
    inc de
    jr  .stepped
.here
    ld  a,$77                      ; ld [hl],a
    ld  [de],a
    inc de
    inc hl
    inc hl
.stepped
    dec b
    jr  nz,.step
.finish
    ld  a,$C9                      ; ret
    ld  [de],a
    jp  op_done

; PROG address(2) count(2) data(count): write data to flash. Every byte that
; isn't $FF (erased flash already reads $FF) goes through the TMPL_CODE
; routine, then the agent waits until it reads back. Afterwards the whole
; range is compared. Adds to the result the offset of the first wrong byte
; ($FFFF if none), the byte read there, and the byte expected. A byte that
; never reads back stops the program with ST_TIMEOUT.
op_prog:
    call args_addr_count
    push de                        ; flash address
    ld  d,h
    ld  e,l                        ; de = the data
    add hl,bc
    call save_next
    pop hl                         ; hl = flash address
    ld  a,b
    or  c
    jp  z,bad_args
    ld  a,c
    ldh [hCntLo],a
    ld  a,b
    ldh [hCntHi],a
    push hl
    push de
.byte
    ld  a,[de]
    inc a
    jr  z,.skip
    call TMPL_CODE
    push bc
    ld  bc,POLL_LIMIT
.poll
    ld  a,[de]
    cp  [hl]
    jr  z,.written
    dec bc
    ld  a,b
    or  c
    jr  nz,.poll
    pop bc
    pop bc                         ; start of the data
    pop bc                         ; start of the flash range
    call .report
    ld  a,ST_TIMEOUT
    jp  op_stop
.written
    pop bc
.skip
    inc de
    inc hl
    dec bc
    ld  a,b
    or  c
    jr  nz,.byte
    pop de
    pop hl
    ldh a,[hCntLo]
    ld  c,a
    ldh a,[hCntHi]
    ld  b,a
    push hl
.verify
    ld  a,[de]
    cp  [hl]
    jr  nz,.wrong
    inc de
    inc hl
    dec bc
    ld  a,b
    or  c
    jr  nz,.verify
    pop bc
    ld  hl,$FFFF
    ld  de,0
    call .result
    call load_next
    jp  op_done
.wrong
    pop bc
    call .report
    call load_next
    jp  op_done
; Report a wrong byte: hl = its flash address, de = its data,
; bc = the start of the flash range.
.report
    ld  a,[de]
    push af
    ld  a,[hl]
    push af
    ld  a,l
    sub c
    ld  l,a
    ld  a,h
    sbc b
    ld  h,a
    pop af
    ld  d,a                        ; read
    pop af
    ld  e,a                        ; wanted
; Add hl (the offset), d (byte read) and e (byte expected) to the result.
.result
    push hl
    push de
    ld  bc,4
    call res_reserve
    pop de
    pop bc
    jr  c,.full
    ld  a,c
    ld  [hl+],a
    ld  a,b
    ld  [hl+],a
    ld  a,d
    ld  [hl+],a
    ld  [hl],e
    ret
.full
    pop hl
    jp  bad_args

; CRC address(2) count(2): add the CRC32 of the range to the result.
op_crc:
    call args_addr_count
    call save_next
    call check_blocks
    ld  a,b
    ldh [hBlocks],a
    ld  a,$FF
    ldh [hCrc],a
    ldh [hCrc+1],a
    ldh [hCrc+2],a
    ldh [hCrc+3],a
    ld  b,d
    ld  c,e                        ; bc = data
    ld  hl,hCrc
.byte
    ld  a,[bc]
    xor [hl]
    ld  e,a
    ld  d,HIGH(CRC_TABLE)
    inc l
    ld  a,[de]
    xor [hl]
    dec l
    ld  [hl+],a
    inc d
    inc l
    ld  a,[de]
    xor [hl]
    dec l
    ld  [hl+],a
    inc d
    inc l
    ld  a,[de]
    xor [hl]
    dec l
    ld  [hl+],a
    inc d
    ld  a,[de]
    ld  [hl],a
    ld  l,LOW(hCrc)
    inc c
    jr  nz,.byte
    inc b
    ldh a,[hBlocks]
    dec a
    ldh [hBlocks],a
    jr  nz,.byte
    ld  bc,4
    call res_reserve
    jp  c,bad_args
    ld  c,LOW(hCrc)
    ld  b,4
.out
    ld  a,[$FF00+c]
    cpl
    ld  [hl+],a
    inc c
    dec b
    jr  nz,.out
    call load_next
    jp  op_done

; BLANK address(2) count(2): check the range is erased (all $FF). Adds the
; offset of the first 256-byte block that isn't, or $FFFF if all are.
op_blank:
    call args_addr_count
    call save_next
    call check_blocks
    ld  h,d
    ld  l,e
.block
    ld  d,$FF
.byte
    ld  a,[hl+]
    and d
    ld  d,a
    ld  a,[hl+]
    and d
    ld  d,a
    ld  a,l
    and a
    jr  nz,.byte
    ld  a,d
    inc a
    jr  nz,.found
    dec b
    jr  nz,.block
    ld  de,$FFFF
    jr  .out
.found
    ld  a,h
    dec a
    ld  d,a                        ; high byte of the block just checked
    call load_next
    dec hl
    dec hl
    dec hl                         ; back to the high byte of the BLANK address
    ld  a,d
    sub [hl]
    ld  d,a
    ld  e,0
.out
    ld  bc,2
    push de
    call res_reserve
    pop de
    jp  c,bad_args
    ld  a,e
    ld  [hl+],a
    ld  [hl],d
    call load_next
    jp  op_done

; WRBLK address(2) count(2) data(count): copy data to the address, used
; for writing cartridge save RAM.
op_wrblk:
    call args_addr_count
    ld  a,b
    or  c
    jp  z,bad_args
.copy
    ld  a,[hl+]
    ld  [de],a
    inc de
    dec bc
    ld  a,b
    or  c
    jr  nz,.copy
    jp  op_done

; INFO: add the agent version (2 bytes) to the result.
op_info:
    call save_next
    ld  bc,2
    call res_reserve
    jp  c,bad_args
    ld  a,AGENT_VERSION
    ld  [hl+],a
    xor a
    ld  [hl],a
    call load_next
    jp  op_done

; EXIT: go back to the payload menu once the page has the result.
op_exit:
    ld  a,1
    ldh [hExit],a
    jp  op_done

; ------------------------------------------------------------------ CRC32

; Build the lookup table for the standard CRC32 (the one zip files use).
; Each of the 256 entries is 4 bytes, stored in four 256-byte rows so a
; byte can index them directly: row 0 holds the lowest byte of every entry,
; row 3 the highest.
make_crc_table:
    ld  hl,CRC_TABLE
.entry
    ld  e,l                        ; e,d,c,b = the entry, low byte first
    ld  d,0
    ld  c,0
    ld  b,0
    ld  a,8
.bit
    srl b
    rr  c
    rr  d
    rr  e
    jr  nc,.no_xor
    push af
    ld  a,b
    xor $ED
    ld  b,a
    ld  a,c
    xor $B8
    ld  c,a
    ld  a,d
    xor $83
    ld  d,a
    ld  a,e
    xor $20
    ld  e,a
    pop af
.no_xor
    dec a
    jr  nz,.bit
    ld  [hl],e
    inc h
    ld  [hl],d
    inc h
    ld  [hl],c
    inc h
    ld  [hl],b
    ld  a,h
    sub 3
    ld  h,a
    inc l
    jr  nz,.entry
    ret

agent_end:
ENDL

ASSERT agent_end <= TMPL_CODE, "agent overlaps the write sequence buffer"
