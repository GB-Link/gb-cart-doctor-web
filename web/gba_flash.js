/**
 * Writes ROMs to GBA flash carts and reproduction carts.
 *
 * This file builds small programs of cartridge operations (command writes,
 * reads, waiting on the chip's status, and a write-and-check loop) and the
 * dumper on the GBA runs them (source/gba_cart_dumper/source/cartops.c).
 * All the knowledge about particular carts lives here, taken from FlashGBX's
 * cart profiles (web/flashcart_profiles.js):
 *   - Detection works like FlashGBX: try each profile's "read flash ID"
 *     command, compare the IDs, read the chip's self-description (CFI), and
 *     tell apart profiles that share an ID by their size.
 *   - Carts that match no profile get Burn2Slot's scan
 *     (github.com/vrodin/Burn2Slot, MIT). It finds AMD-style chips wired in
 *     any of six data-line orders with any of six command address layouts,
 *     as well as Intel-style chips.
 *   - Writing erases only the sectors the ROM covers, skipping any that
 *     already hold the right data, then writes and checks 64 KB at a time.
 */

"use strict";

// Must match cartops.h on the GBA. Each op is four 32-bit words: the op
// number and three arguments. W16/RD16 write and read 16-bit words; W8S/RD8S
// use the 8-bit SRAM area. ST_ values are the program's final status, K_
// values say how a profile's command address (absolute, sector, program
// address) and value (immediate, buffer size, program data) are filled in,
// and SHOW_ values pick what the GBA screen says.
const CARTOP = {
    END: 0, W16: 1, W8S: 2, RD16: 3, RD8S: 4, WAIT: 5, DELAY: 6, CFG: 7,
    PROG: 8, VERIFY: 9, CRC32: 10, SHOW: 11, SRCMD: 12,
    BLANK: 0xFFFFFFFF, SAME: 0xFFFFFFFF,
    ST_OK: 0, ST_TIMEOUT: 1, ST_BAD_OP: 2, ST_OVERFLOW: 3,
    SET_AMD: 1, SET_INTEL: 2,
    K_NONE: 0, K_ABS: 1, K_SA: 2, K_PA: 3,
    K_IMM: 1, K_BS: 2, K_PD: 3,
    SHOW_DETECT: 1, SHOW_ERASE: 2, SHOW_WRITE: 3, SHOW_VERIFY: 4, SHOW_DONE: 5, SHOW_FAIL: 6,
    BUF_MAX: 0x20000,
    RESULT_WORDS: 0x1000 - 2,
};

const FLASH_CHUNK = 0x10000;        // bytes written and checked per program
const ERASE_TIMEOUT_MS = 30000;     // one sector erase
const UNIT_TIMEOUT_MS = 250;        // one word or write buffer
const BANK_WINDOW = 0x2000000;      // the GBA sees 32 MB of ROM at a time

class FlashcartError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "FlashcartError";
        this.code = code; // no-flash | too-big | timeout | verify | unsupported | payload
    }
}

// ---------------------------------------------------------------- op programs

/**
 * Builds one cart op program for the GBA. Each op that reads something
 * returns a handle used to find its words in the CartOpResult.
 */
class CartOpProgram {
    constructor() {
        this.ops = [];
        this.blobs = [];
        this.resultWords = 0;
    }

    get length() { return this.ops.length; }

    _op(op, a = 0, b = 0, c = 0, words = 0) {
        const handle = { index: this.ops.length, at: this.resultWords, words };
        this.ops.push([op, a, b, c]);
        this.resultWords += words;
        return handle;
    }

    /** Add a block of data to the program; returns a reference for prog/verify/cfg. */
    attach(bytes) {
        this.blobs.push(bytes);
        return { blob: this.blobs.length - 1, length: bytes.length };
    }

    w16(addr, value) { return this._op(CARTOP.W16, addr, value & 0xFFFF); }
    w8s(addr, value) { return this._op(CARTOP.W8S, addr, value & 0xFF); }
    rd16(addr, bytes) { return this._op(CARTOP.RD16, addr, bytes, 0, Math.ceil(bytes / 4)); }
    rd8s(addr, bytes) { return this._op(CARTOP.RD8S, addr, bytes, 0, Math.ceil(bytes / 4)); }
    wait(addr, value, mask, ms) {
        return this._op(CARTOP.WAIT, addr, ((mask & 0xFFFF) << 16 | (value & 0xFFFF)) >>> 0, ms, 1);
    }
    delay(us) { return this._op(CARTOP.DELAY, us); }
    cfg(ref) { return this._op(CARTOP.CFG, ref, ref.length); }
    prog(ref, addr, bytes) { return this._op(CARTOP.PROG, ref, addr, bytes, 2); }
    verify(ref, addr, bytes) { return this._op(CARTOP.VERIFY, ref === null ? CARTOP.BLANK : ref, addr, bytes, 2); }
    crc32(addr, bytes) { return this._op(CARTOP.CRC32, addr, bytes, 0, 1); }
    show(id, pct = 0) { return this._op(CARTOP.SHOW, id, Math.max(0, Math.min(100, Math.floor(pct)))); }
    srcmd(addr, value) { return this._op(CARTOP.SRCMD, addr, value === null ? 0xFFFFFFFF : value & 0xFFFF); }

    /** Lay out the ops, then the data, padded to a multiple of 256 bytes. */
    build() {
        const opsBytes = (this.ops.length + 1) * 16;
        const offsets = [];
        let size = opsBytes;
        for (const b of this.blobs) {
            offsets.push(size);
            size = (size + b.length + 3) & ~3;
        }
        size = (size + 0xFF) & ~0xFF;
        if (size > CARTOP.BUF_MAX) throw new Error("Cart op program too large");
        if (this.resultWords > CARTOP.RESULT_WORDS) throw new Error("Cart op program reads too much");
        const buf = new Uint8Array(size);
        const dv = new DataView(buf.buffer);
        const resolve = (v) => (v && typeof v === "object") ? offsets[v.blob] : v;
        this.ops.forEach((op, i) => {
            for (let k = 0; k < 4; k++) dv.setUint32(i * 16 + k * 4, resolve(op[k]) >>> 0, true);
        });
        this.blobs.forEach((b, i) => buf.set(b, offsets[i]));
        return buf;
    }
}

// The GBA's reply: how many ops ran, the final status, then each read's words.
class CartOpResult {
    constructor(words) {
        this.words = words;
        this.executed = words[0];
        this.status = words[1];
    }
    get ok() { return this.status === CARTOP.ST_OK; }
    ran(handle) { return handle.index < this.executed; }
    get(handle) { return this.words.subarray(2 + handle.at, 2 + handle.at + handle.words); }
    word(handle, k = 0) { return this.words[2 + handle.at + k]; }
    bytes(handle, n) {
        const w = this.get(handle);
        const out = new Uint8Array(w.length * 4);
        const dv = new DataView(out.buffer);
        w.forEach((v, i) => dv.setUint32(i * 4, v, true));
        return out.subarray(0, n);
    }
}

// ---------------------------------------------------------------- helpers

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
        t[i] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

const hex = (v, n = 0) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(n, "0");
const hexBytes = (b) => Array.from(b, x => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const isAllFF = (b) => { for (let i = 0; i < b.length; i++) if (b[i] !== 0xFF) return false; return true; };
const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function swapBitPair(v, p, q) {
    return (((v >> p) ^ (v >> q)) & 1) ? v ^ ((1 << p) | (1 << q)) : v;
}

/**
 * Parse the chip's CFI table (its description of its own size, sectors and
 * write buffer) from a 0x400-byte read. Follows FlashGBX's CFI.Parse.
 */
function parseCfi(raw) {
    if (!raw || raw.length < 0x400) return null;
    const b = Uint8Array.from(raw);
    const magic = String.fromCharCode(b[0x20], b[0x22], b[0x24]);
    let swaps;
    if (magic === "QRY") swaps = [];
    else if (magic === "RQZ") swaps = [[0, 1]];
    else if (b[0x20] === 0x92 && b[0x22] === 0x91 && b[0x24] === 0x9A) swaps = [[0, 1], [6, 7]];
    else return null;
    for (const [p, q] of swaps) for (let i = 0; i < b.length; i++) b[i] = swapBitPair(b[i], p, q);
    if (b[0x36] === 0xFF && b[0x48] === 0xFF) return null;

    let pri = (b[0x2A] | (b[0x2C] << 8)) * 2;
    if (pri + 0x3C >= 0x400) pri = 0x80;
    const info = { swaps, deviceSize: 2 ** b[0x4E], regions: [] };
    const bufExp = (b[0x56] << 8) | b[0x54];
    if (bufExp > 1) info.bufferSize = 2 ** bufExp;
    const n = Math.min(4, b[0x58]);
    for (let i = 0; i < n; i++) {
        const count = ((b[0x5C + i * 8] << 8) | b[0x5A + i * 8]) + 1;
        const size = ((b[0x60 + i * 8] << 8) | b[0x5E + i * 8]) * 256;
        info.regions.push([size, count]);
    }
    info.bootFlag = 0;
    if (String.fromCharCode(b[pri], b[pri + 2], b[pri + 4]) === "PRI" &&
        b[pri + 0x1E] !== 0 && b[pri + 0x1E] !== 0xFF) {
        info.bootFlag = b[pri + 0x1E];
    }
    return info;
}

// ------------------------------------------------- Burn2Slot fallback detection

// The unlock addresses AMD-style chips use, in the six layouts carts wire
// them in, and the two data-line orders some boards scramble D0-D15 into.
const B2S_SEQS = [
    [0x555, 0x2AA, 0x555, 0x555, 0x2AA, 0x555],
    [0xAAA, 0x555, 0xAAA, 0xAAA, 0x555, 0xAAA],
    [0xAAA, 0x554, 0xAAA, 0xAAA, 0x554, 0xAAA],
    [0x5555, 0x2AAA, 0x5555, 0x5555, 0x2AAA, 0x5555],
    [0xAAAA, 0x5554, 0xAAAA, 0xAAAA, 0x5554, 0xAAAA],
    [0x1554, 0xAAA, 0x1554, 0x1554, 0xAAA, 0x1554],
];   // in 16-bit words, so doubled to get byte addresses
const B2S_BUS1 = [15, 7, 14, 6, 13, 5, 12, 4, 0, 8, 1, 9, 2, 10, 3, 11];
const B2S_BUS2 = [0, 8, 1, 9, 6, 14, 7, 15, 2, 10, 3, 11, 4, 12, 5, 13];

function b2sSwapTo(bus, v) { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >> i) & 1) << bus[i]; return r; }
function b2sSwapFrom(bus, v) { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >> bus[i]) & 1) << i; return r; }
function b2sBusOut(bus, v) {
    switch (bus) {
        case 1: return swapBitPair(v, 0, 1);
        case 2: return b2sSwapTo(B2S_BUS1, v);
        case 3: return b2sSwapTo(B2S_BUS2, v);
        case 4: return ((v << 8) | v) & 0xFFFF;
        case 5: return swapBitPair(((v << 8) | v) & 0xFFFF, 0, 1);
        default: return v;
    }
}
function b2sBusIn(bus, v) {
    switch (bus) {
        case 1: case 5: return swapBitPair(v, 0, 1);
        case 2: return b2sSwapFrom(B2S_BUS1, v);
        case 3: return b2sSwapFrom(B2S_BUS2, v);
        default: return v;
    }
}
const B2S_WIRING_NAMES = ["straight", "D0/D1 swapped", "data lines reordered (type 1)",
    "data lines reordered (type 2)", "8-bit, doubled", "8-bit, doubled, D0/D1 swapped"];

/** Make a profile, in FlashGBX's format, for an AMD-style chip that Burn2Slot's scan found. */
function b2sAmdProfile(seqType, bus, cfi, flashId) {
    const s = B2S_SEQS[seqType].map(w => w * 2);
    const v = (x) => b2sBusOut(bus, x);
    const p = {
        id: "B2S_AMD",
        names: [`AMD-style flash, ${B2S_WIRING_NAMES[bus]} (Burn2Slot detection)`],
        command_set: "AMD",
        synthetic: true,
        flash_ids: [Array.from(flashId)],
        commands: {
            reset: [[s[0], v(0xAA)], [s[1], v(0x55)], [s[2], v(0xF0)]],
            read_identifier: [[s[0], v(0xAA)], [s[1], v(0x55)], [s[2], v(0x90)]],
            sector_erase: [[s[0], v(0xAA)], [s[1], v(0x55)], [s[2], v(0x80)],
                [s[3], v(0xAA)], [s[4], v(0x55)], ["SA", v(0x30)]],
            sector_erase_wait_for: [[null, null, null], [null, null, null], [null, null, null],
                [null, null, null], [null, null, null], ["SA", 0xFFFF, 0xFFFF]],
            single_write: [[s[0], v(0xAA)], [s[1], v(0x55)], [s[2], v(0xA0)], ["PA", "PD"]],
            single_write_wait_for: [[null, null, null], [null, null, null], [null, null, null], [null, null, null]],
        },
    };
    if (cfi && cfi.regions.length) {
        p.sector_size = cfi.bootFlag === 3 ? cfi.regions.slice().reverse() : cfi.regions;
        p.flash_size = cfi.deviceSize;
    } else {
        // No sector map, so erase every 64 KB like Burn2Slot does. If the
        // real sectors are bigger some get erased twice, which is harmless
        // because all erasing happens before any writing.
        p.sector_size = 0x10000;
    }
    return p;
}

// ---------------------------------------------------------------- the engine

class GbaFlashcart {
    /**
     * @param client  anything with runOps(Uint8Array, timeoutMs, onWait)
     *                returning a Uint32Array: a GbaCartClient, or a
     *                simulator in the tests
     */
    constructor(client, { profiles = null, log = () => {} } = {}) {
        this.client = client;
        this.profiles = profiles ||
            (typeof FLASHCART_PROFILES !== "undefined" ? FLASHCART_PROFILES : []);
        this.log = log;
        this.detected = null;
        this.cancelRequested = false;
    }

    cancel() { this.cancelRequested = true; }

    _checkCancel() {
        if (this.cancelRequested) throw new FlashcartError("cancelled", "Cancelled");
    }

    async exec(prog, timeoutMs = 60000, onWait) {
        const buf = prog.build();
        let words;
        // If the link garbles a run, send it again. Every program is safe to
        // repeat: erasing twice, or writing the same data twice, changes
        // nothing on flash memory.
        for (let attempt = 1; ; attempt++) {
            this._checkCancel();
            try {
                words = await this.client.runOps(buf, timeoutMs, onWait);
                break;
            } catch (e) {
                const linkError = e && (e.code === "desync" || e.code === "checksum");
                if (!linkError || attempt >= 3) throw e;
                this.log(`Link error (${e.message}) — retrying.`, "error");
            }
        }
        const r = new CartOpResult(words);
        if (r.status === CARTOP.ST_BAD_OP || r.status === CARTOP.ST_OVERFLOW) {
            throw new FlashcartError("payload",
                `The GBA rejected cart op ${r.executed} (status ${r.status}). Is the dumper up to date?`);
        }
        return r;
    }

    static commandSet(p) {
        if (p.command_set) return String(p.command_set).toUpperCase();
        const rid = p.commands && p.commands.read_identifier;
        return rid && rid[0] && rid[0][1] === 0x90 ? "INTEL" : "";
    }

    static flashableProfiles(profiles) {
        return profiles.filter(p => {
            const set = GbaFlashcart.commandSet(p);
            const c = p.commands || {};
            return (set === "AMD" || set === "INTEL" || set === "SHARP") &&
                (c.single_write || c.buffer_write || c.page_write) &&
                (c.sector_erase || c.chip_erase);
        });
    }

    static _writeCmds(prog, cmds, base = 0) {
        for (const c of cmds || []) {
            if (c[0] === null || c[0] === undefined) continue;
            prog.w16(base + c[0], c[1]);
        }
    }

    // ------------------------------------------------------------ detection

    /**
     * Identify the flash chip and pick a profile. Returns
     * { profile, candidates, flashId, cfi, method } or throws no-flash.
     */
    async detect() {
        this.cancelRequested = false;
        const profiles = GbaFlashcart.flashableProfiles(this.profiles);
        this.detected = null;

        // 1. Read the plain ROM, and check for the M29W640 chip first like
        //    FlashGBX does, since other profiles' commands can corrupt it.
        let prog = new CartOpProgram();
        prog.show(CARTOP.SHOW_DETECT, 0);
        const romH = prog.rd16(0, 8);
        const m29 = profiles.filter(p => p.m29w640).map(p => {
            GbaFlashcart._writeCmds(prog, p.commands.reset);
            const before = prog.rd16(0, 8);
            GbaFlashcart._writeCmds(prog, p.commands.read_identifier);
            const after = prog.rd16(0, 8);
            GbaFlashcart._writeCmds(prog, p.commands.reset);
            return { p, before, after };
        });
        let r = await this.exec(prog);
        const rom = r.bytes(romH, 8);
        for (const m of m29) {
            const before = r.bytes(m.before, 8), after = r.bytes(m.after, 8);
            const id = m.p.flash_ids[0];
            if (!sameBytes(before, after) && sameBytes(after.subarray(0, id.length), id)) {
                return this._finishDetect([m.p], after, "M29W640 check");
            }
        }

        // 2. FlashGBX's ID scan: reset and unlock with every profile's
        //    commands, then try each different "read ID" command and keep
        //    the ones that change what address 0 reads.
        const resets = [], groups = [];
        for (const p of profiles) {
            const c = p.commands;
            if (p.m29w640) continue;
            if (c.reset && !resets.some(x => jsonEq(x, c.reset))) resets.push(c.reset);
            if (c.unlock) {
                if (!resets.some(x => jsonEq(x, c.unlock))) resets.push(c.unlock);
            }
            if (c.read_identifier && c.read_identifier.length &&
                !groups.some(g => jsonEq(g.rid, c.read_identifier))) {
                groups.push({ rid: c.read_identifier, reset: c.reset || [] });
            }
        }
        groups.sort((a, b) => a.rid[0][0] - b.rid[0][0]);
        prog = new CartOpProgram();
        for (const c of resets) for (const cmd of c) prog.w16(cmd[0], cmd[1]);
        for (const g of groups) {
            GbaFlashcart._writeCmds(prog, g.reset);
            GbaFlashcart._writeCmds(prog, g.rid);
            g.handle = prog.rd16(0, 8);
            GbaFlashcart._writeCmds(prog, g.reset);
        }
        prog.w16(0, 0xFF);
        prog.w16(0, 0xF0);
        r = await this.exec(prog);
        const methods = [];
        for (const g of groups) {
            const cmp = r.bytes(g.handle, 8);
            if (!sameBytes(cmp, rom)) methods.push({ rid: g.rid, reset: g.reset, id: cmp });
        }
        for (const m of methods) {
            this.log(`Flash ID via ${hex(m.rid[0][0])}/${hex(m.rid[0][1])}: ${hexBytes(m.id)}`);
        }

        const candidates = [];
        for (const p of profiles) {
            if (!p.flash_ids || !p.flash_ids.length || !p.commands.read_identifier) continue;
            const m = methods.find(m => jsonEq(m.rid, p.commands.read_identifier));
            if (!m) continue;
            if (p.flash_ids.some(id => sameBytes(m.id.subarray(0, id.length), id))) candidates.push(p);
        }

        if (candidates.length) {
            const m = methods.find(m => jsonEq(m.rid, candidates[0].commands.read_identifier));
            return this._finishDetect(candidates, m.id, "FlashGBX profiles", methods);
        }

        // 3. Nothing matched: try Burn2Slot's scan.
        const b2s = await this._detectBurn2Slot(rom, profiles);
        if (b2s) return b2s;

        const seen = methods.length ? methods.map(m => hexBytes(m.id)).join(", ") : "none";
        throw new FlashcartError("no-flash",
            "No writable flash chip found. Either this isn't a flash cart, or its chip isn't " +
            `one the profiles know (flash IDs seen: ${seen}).`);
    }

    async _readCfi(readCfi, reset, base = 0) {
        const prog = new CartOpProgram();
        GbaFlashcart._writeCmds(prog, readCfi, base);
        const h = prog.rd16(base, 0x400);
        GbaFlashcart._writeCmds(prog, reset, base);
        const r = await this.exec(prog);
        return r.bytes(h, 0x400);
    }

    async _finishDetect(candidates, flashId, method, methods = []) {
        const first = candidates[0];
        const readCfi = (first.commands.read_cfi) ||
            [[methods.length ? methods[0].rid[0][0] : 0, 0x98]];
        const reset = first.commands.reset || [];
        let cfi = null;
        try {
            cfi = parseCfi(await this._readCfi(readCfi, reset));
        } catch (e) {
            if (e instanceof FlashcartError || e.code === "cancelled") throw e;
            cfi = null;
        }

        let profile = first;
        const sizes = new Set(candidates.map(p => p.flash_size).filter(s => s));
        if (sizes.size > 1) profile = await this._pickBySize(candidates, cfi) || first;

        this.detected = { profile, candidates, flashId, cfi, method };
        return this.detected;
    }

    /** Pick between profiles that share a flash ID by chip size, as FlashGBX does. */
    async _pickBySize(candidates, cfi) {
        const first = candidates[0];
        if (first.flash_bank_select_type === 1) {
            const maxBanks = Math.floor(first.flash_size / BANK_WINDOW) + 1;
            const prog = new CartOpProgram();
            const probes = [];
            for (let bank = 0; bank === 0 || bank < maxBanks; bank = bank ? bank << 1 : 1) {
                this._selectBank(prog, first, bank);
                probes.push({ bank, lo: prog.crc32(0, 0x1000), hi: prog.crc32(0x1FFF000, 0x1000) });
            }
            this._selectBank(prog, first, 0);
            const r = await this.exec(prog);
            const sig = (pr) => r.word(pr.lo) + ":" + r.word(pr.hi);
            let banks = 1;
            for (let i = 1; i < probes.length; i++) {
                if (sig(probes[i]) === sig(probes[0])) break;
                banks = probes[i].bank << 1;
            }
            return candidates.find(p => p.flash_size === BANK_WINDOW * banks);
        }
        if (cfi && cfi.deviceSize) {
            const p = candidates.find(p => p.flash_size === cfi.deviceSize);
            if (p) return p;
        }
        // A small chip repeats itself across the address space, so the
        // first place the header shows up again gives its size.
        const prog = new CartOpProgram();
        const head = prog.rd16(0xA0, 16);
        const probes = [];
        for (let a = 0x10000; a < BANK_WINDOW; a *= 2) probes.push({ a, h: prog.rd16(a + 0xA0, 16) });
        const r = await this.exec(prog);
        const want = r.bytes(head, 16);
        let size = BANK_WINDOW;
        for (const pr of probes) if (sameBytes(r.bytes(pr.h, 16), want)) { size = pr.a; break; }
        return candidates.find(p => p.flash_size === size);
    }

    async _detectBurn2Slot(rom, profiles) {
        // Try Intel-style chips first, as Burn2Slot does.
        let prog = new CartOpProgram();
        prog.w16(0, 0xFF);
        prog.w16(0, 0x50);
        prog.w16(0, 0x90);
        const intel = prog.rd16(0, 4);
        prog.w16(0, 0xFF);
        let r = await this.exec(prog);
        const iid = r.bytes(intel, 4);
        const maker = iid[0] | (iid[1] << 8), dev = iid[2] | (iid[3] << 8);
        if (!sameBytes(iid, rom.subarray(0, 4)) &&
            ([0x8902, 0x8904, 0x887D, 0x887E].includes(dev) || (dev >> 8) === 0x88 ||
                (dev === 0xB0 && maker === 0xB0) || maker === 0x1C)) {
            const generic = profiles.find(p => p.id === "AGB_Generic_0_90");
            if (generic) {
                const p = Object.assign({}, generic, {
                    id: "B2S_INTEL",
                    names: ["Intel-style flash (Burn2Slot detection)"],
                    flash_ids: [Array.from(iid)],
                    synthetic: true,
                });
                return this._finishDetect([p], iid, "Burn2Slot Intel scan");
            }
        }

        // Then AMD-style chips, with every address layout and data wiring.
        // A wrong guess can leave the chip halfway through an unlock
        // sequence, so each try starts by sending reset (0xF0) in every
        // wiring.
        const resetAll = (prog) => {
            for (let bus = 0; bus < 6; bus++) prog.w16(0, b2sBusOut(bus, 0xF0));
        };
        prog = new CartOpProgram();
        const tries = [];
        for (let seq = 0; seq < B2S_SEQS.length; seq++) {
            const s = B2S_SEQS[seq];
            for (let bus = 0; bus < 6; bus++) {
                const out = (v) => b2sBusOut(bus, v);
                resetAll(prog);
                prog.w16(s[0] * 2, out(0xAA));
                prog.w16(s[1] * 2, out(0x55));
                prog.w16(s[2] * 2, out(0x90));
                tries.push({ seq, bus, h: prog.rd16(0, 4) });
            }
        }
        resetAll(prog);
        r = await this.exec(prog);
        for (const t of tries) {
            const raw = r.bytes(t.h, 4);
            if (sameBytes(raw, rom.subarray(0, 4))) continue;
            const id = b2sBusIn(t.bus, raw[2] | (raw[3] << 8));
            if ((id >> 8) === 0x22 || id === 0x7E7E || id === 0x57 || id === 0xF8) {
                // Read the CFI table through the same wiring, as Burn2Slot's
                // chipSize() does.
                const out = (v) => b2sBusOut(t.bus, v);
                const s = B2S_SEQS[t.seq];
                const cfiRaw = await this._readCfi([[0, out(0x50)], [0, out(0xFF)], [0xAA, out(0x98)]],
                    [[s[0] * 2, out(0xAA)], [s[1] * 2, out(0x55)], [s[2] * 2, out(0xF0)]]);
                const decoded = new Uint8Array(0x400);
                for (let i = 0; i < 0x400; i += 2) {
                    const w = b2sBusIn(t.bus, cfiRaw[i] | (cfiRaw[i + 1] << 8));
                    decoded[i] = w & 0xFF;
                    decoded[i + 1] = w >> 8;
                }
                const cfi = parseCfi(decoded);
                const p = b2sAmdProfile(t.seq, t.bus, cfi, raw);
                this.detected = { profile: p, candidates: [p], flashId: raw, cfi, method: "Burn2Slot AMD scan" };
                return this.detected;
            }
        }
        return null;
    }

    // ------------------------------------------------------------ write plan

    /**
     * Work out how to write with this profile: one word at a time or a
     * buffer at a time, how many bytes per write, and the setup words the
     * GBA needs (sent with the CFG op).
     */
    static writePlan(p, cfi) {
        const c = p.commands;
        const set = GbaFlashcart.commandSet(p);
        const bufferSize = p.buffer_size || (cfi && cfi.bufferSize) || 0;
        let method, cmds, waits;
        if (c.buffer_write && bufferSize > 0) {
            method = "buffered"; cmds = c.buffer_write; waits = c.buffer_write_wait_for;
        } else if (c.page_write && bufferSize > 0) {
            method = "paged"; cmds = c.page_write; waits = c.page_write_wait_for;
        } else if (c.single_write) {
            method = "single"; cmds = c.single_write; waits = c.single_write_wait_for;
        } else {
            throw new FlashcartError("unsupported", "This flash cart profile has no write method the GBA can use.");
        }
        const unit = method === "single" ? 2 : bufferSize;
        // Two interleaved chips (Flash2Advance) split each buffer between them.
        const chips = (cmds.some(x => x[0] === "SA+2")) ? 2 : 1;
        let bs = method === "single" ? 0 : unit / 2 / chips - 1;
        // "double_die" carts have two 8-bit chips, one on each half of the
        // data bus, so each gets the buffer size in its own byte.
        if (p.double_die) bs = (bs << 8) | bs;
        const srMask = p.status_register_mask !== undefined ? p.status_register_mask : 0x80;
        const srValue = p.status_register_value !== undefined ? p.status_register_value : 0x80;

        const addrKind = (a) => {
            if (a === null || a === undefined) return [CARTOP.K_NONE, 0];
            if (typeof a === "number") return [CARTOP.K_ABS, a];
            if (a === "PA") return [CARTOP.K_PA, 0];
            if (a === "SA") return [CARTOP.K_SA, 0];
            const m = /^SA\+(\d+)$/.exec(a);
            if (m) return [CARTOP.K_SA, Number(m[1])];
            throw new FlashcartError("unsupported", `Unknown address "${a}" in the profile`);
        };
        const valKind = (v) => {
            if (v === null || v === undefined) return [CARTOP.K_NONE, 0];
            if (typeof v === "number") return [CARTOP.K_IMM, v];
            if (v === "BS") return [CARTOP.K_BS, 0];
            if (v === "PD") return [CARTOP.K_PD, 0];
            throw new FlashcartError("unsupported", `Unknown value "${v}" in the profile`);
        };

        const words = [
            set === "AMD" ? CARTOP.SET_AMD : CARTOP.SET_INTEL,
            unit, bs, ((srValue & 0xFFFF) << 16 | (srMask & 0xFFFF)) >>> 0,
            UNIT_TIMEOUT_MS, cmds.length,
        ];
        if (cmds.length > 12) throw new FlashcartError("unsupported", "Profile write sequence too long");
        cmds.forEach((cmd, i) => {
            const w = (waits && waits[i]) || [null, null, null];
            const [ak, a] = addrKind(cmd[0]);
            const [vk, v] = valKind(cmd[1]);
            const [wak, wa] = addrKind(w[0]);
            const [wvk, wv] = w[0] === null || w[0] === undefined ? [CARTOP.K_NONE, 0] : valKind(w[1]);
            words.push((ak | (vk << 8) | (wak << 16) | (wvk << 24)) >>> 0, a, v, wa, wv,
                w[2] === null || w[2] === undefined ? 0xFFFF : w[2]);
        });
        const cfg = new Uint8Array(words.length * 4);
        const dv = new DataView(cfg.buffer);
        words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
        return { method, unit, bs, cfg, bufferSize };
    }

    /** The sectors [[offset, size], ...] covering `bytes`, or null if the chip can only be erased whole. */
    static sectorList(p, cfi, bytes) {
        let map = p.sector_size;
        if ((map === undefined || p.sector_size_from_cfi) && p.commands.sector_erase) {
            if (cfi && cfi.regions.length) {
                map = cfi.bootFlag === 3 ? cfi.regions.slice().reverse() : cfi.regions;
            } else if (map === undefined) {
                map = null;
            }
        }
        if (!p.commands.sector_erase || !map) return null;
        const out = [];
        let pos = 0;
        if (Array.isArray(map)) {
            for (const [size, count] of map) {
                for (let i = 0; i < count && pos < bytes; i++, pos += size) out.push([pos, size]);
            }
            // If the map runs out early, the remaining sectors repeat the last size.
            const last = map[map.length - 1][0];
            while (pos < bytes) { out.push([pos, last]); pos += last; }
        } else {
            for (; pos < bytes; pos += map) out.push([pos, map]);
        }
        return out;
    }

    _selectBank(prog, p, bank) {
        if (p.flash_bank_select_type === 1) {
            prog.w8s(2, (bank & 0xF) << 4);
            prog.w8s(3, 0x40);
            prog.w8s(4, 0x00);
        } else if (p.flash_bank_select_type === 2) {   // Flash2Advance Ultra
            const bank1 = bank < 4 ? 0 : 0x10, bank2 = (bank % 4) * 0x400;
            prog.w16(0x987654 * 2, 0x5354);
            prog.w16(0xE12345 * 2, 0xA55A);
            prog.w8s(6, bank1);
            prog.w16(0x987654 * 2, 0x5354);
            prog.w16(0xB5AC97 * 2, bank2);
            prog.w16(0x987654 * 2, 0x5354);
            prog.w16(0xF12345 * 2, 0x9413);
        }
    }

    /** Send the reset commands to the part of the chip that holds `addr`. */
    static _localReset(prog, p, addr) {
        const base = p.reset_every ? addr - (addr % p.reset_every) : 0;
        GbaFlashcart._writeCmds(prog, p.commands.reset, base);
    }

    static _fullReset(prog, p, limit) {
        const reset = p.commands.reset || [];
        if (p.reset_every) {
            for (let j = 0; j < Math.min(limit, BANK_WINDOW); j += p.reset_every) {
                GbaFlashcart._writeCmds(prog, reset, j);
            }
        } else {
            GbaFlashcart._writeCmds(prog, reset);
        }
    }

    static _resolve(a, sa) {
        if (a === null || a === undefined) return null;
        if (typeof a === "number") return a;
        if (a === "SA") return sa;
        const m = /^SA\+(\d+)$/.exec(a);
        if (m) return sa + Number(m[1]);
        throw new FlashcartError("unsupported", `Unknown address "${a}" in the profile`);
    }

    static _eraseSector(prog, p, sa) {
        const c = p.commands;
        GbaFlashcart._localReset(prog, p, sa);
        if (p.wait_read_status_register && c.read_status_register) {
            prog.srcmd(c.read_status_register[0][0], c.read_status_register[0][1]);
        }
        const waits = [];
        c.sector_erase.forEach((cmd, i) => {
            const a = GbaFlashcart._resolve(cmd[0], sa);
            if (a !== null) prog.w16(a, cmd[1]);
            const w = c.sector_erase_wait_for && c.sector_erase_wait_for[i];
            if (w && w[0] !== null && w[0] !== undefined) {
                waits.push(prog.wait(GbaFlashcart._resolve(w[0], sa), w[1], w[2], ERASE_TIMEOUT_MS));
            }
        });
        if (p.wait_read_status_register) prog.srcmd(0, null);
        GbaFlashcart._localReset(prog, p, sa);
        return waits;
    }

    // ------------------------------------------------------------ writing

    /**
     * Write `rom` (a Uint8Array) to the start of the flash. Only the sectors
     * the ROM covers are erased, plus (with eraseRest) any sector after it,
     * within the 32 MB the GBA can see, that isn't already blank.
     * opts: { profile, skipUnchanged = true, eraseRest = true,
     *         onProgress(done, total, phase) }
     * Returns { written, skipped, cleared, sectors, method, seconds }.
     */
    async writeRom(rom, opts = {}) {
        this.cancelRequested = false;
        const det = this.detected || {};
        const p = opts.profile || det.profile;
        if (!p) throw new FlashcartError("no-flash", "Detect the flash cart first");
        const cfi = det.cfi || await this._readProfileCfi(p);
        const onProgress = opts.onProgress || (() => {});
        const skipUnchanged = opts.skipUnchanged !== false;
        const t0 = Date.now();

        const chipSize = await this._chipSize(p, cfi);
        const capacity = chipSize || BANK_WINDOW;
        if (rom.length > capacity) {
            throw new FlashcartError("too-big",
                `The ROM is ${rom.length} bytes but the cart holds ${capacity} bytes.`);
        }
        const plan = GbaFlashcart.writePlan(p, cfi);
        const unitPad = Math.max(plan.unit, 2);
        const total = Math.ceil(rom.length / unitPad) * unitPad;
        const image = new Uint8Array(total).fill(0xFF);
        image.set(rom);

        const bankSize = p.flash_bank_size || BANK_WINDOW;
        const sectors = GbaFlashcart.sectorList(p, cfi, total);
        if (!sectors && !p.commands.chip_erase) {
            throw new FlashcartError("unsupported",
                "Couldn't read the chip's sector layout (CFI), and this profile has no chip erase.");
        }
        this.log(`Profile: ${p.names[0]} — ${plan.method} writes` +
            (plan.method === "single" ? "" : ` (${plan.unit}-byte buffer)`) +
            (sectors ? `, ${sectors.length} sector${sectors.length === 1 ? "" : "s"} to erase` : ", chip erase"));

        // Start from a known state: reset every part of the chip and unlock it.
        let prog = new CartOpProgram();
        this._selectBank(prog, p, 0);
        GbaFlashcart._fullReset(prog, p, capacity);
        if (p.commands.unlock_read) {
            for (const [addr, len, count] of p.commands.unlock_read) {
                for (let i = 0; i < count; i++) prog.rd16(addr, Math.max(2, len));
            }
        }
        GbaFlashcart._writeCmds(prog, p.commands.unlock);
        await this.exec(prog);

        const sectorData = (s) => {
            const out = new Uint8Array(s[1]).fill(0xFF);
            if (s[0] < total) out.set(image.subarray(s[0], Math.min(total, s[0] + s[1])));
            return out;
        };
        const bankOf = (off) => Math.floor(off / bankSize);

        // Skip sectors whose checksum already matches the ROM.
        let todo = sectors ? sectors.slice() : null;
        let skipped = 0;
        if (todo && skipUnchanged) {
            const keep = [];
            for (let i = 0; i < todo.length;) {
                this._checkCancel();
                prog = new CartOpProgram();
                const bank = bankOf(todo[i][0]);
                this._selectBank(prog, p, bank);
                const batch = [];
                while (i < todo.length && batch.length < 256 && bankOf(todo[i][0]) === bank) {
                    batch.push({ s: todo[i], h: prog.crc32(todo[i][0] % bankSize, todo[i][1]) });
                    i++;
                }
                prog.show(CARTOP.SHOW_VERIFY, (i / todo.length) * 100);
                const r = await this.exec(prog, 300000);
                for (const b of batch) {
                    if (r.word(b.h) === crc32(sectorData(b.s))) skipped++;
                    else keep.push(b.s);
                }
                onProgress(i, todo.length, "compare");
            }
            todo = keep;
            if (skipped) this.log(`${skipped} sector${skipped === 1 ? " already holds" : "s already hold"} the right data — skipping.`);
        }

        // Leftovers from a bigger ROM written earlier would end up in a dump
        // of this one, so erase anything after the ROM that isn't blank.
        // Only the first 32 MB is touched; other banks of a multi-game cart
        // are left alone. This needs the chip size, because past its end a
        // chip reads as a copy of its start.
        let cleared = 0;
        if (todo && opts.eraseRest !== false && !chipSize) {
            this.log("The chip size is unknown, so data after the ROM is left as it is.");
        } else if (todo && opts.eraseRest !== false) {
            const last = sectors[sectors.length - 1];
            const romEnd = last ? last[0] + last[1] : 0;
            const rest = GbaFlashcart.sectorList(p, cfi, Math.min(chipSize, bankSize))
                .filter(s => s[0] >= romEnd);
            for (let i = 0; i < rest.length;) {
                this._checkCancel();
                prog = new CartOpProgram();
                this._selectBank(prog, p, 0);
                const batch = [];
                while (i < rest.length && batch.length < 256) {
                    batch.push({ s: rest[i], h: prog.verify(null, rest[i][0], rest[i][1]) });
                    i++;
                }
                prog.show(CARTOP.SHOW_VERIFY, (i / rest.length) * 100);
                const r = await this.exec(prog, 300000);
                for (const b of batch) {
                    if (r.word(b.h, 0) !== CARTOP.SAME) {
                        todo.push(b.s);
                        cleared++;
                    }
                }
                onProgress(i, rest.length, "compare");
            }
            if (cleared) {
                this.log(`${cleared} sector${cleared === 1 ? "" : "s"} after the ROM still hold old data — erasing ${cleared === 1 ? "it" : "them"} too.`);
            }
        }

        if (todo) {
            for (let i = 0; i < todo.length;) {
                this._checkCancel();
                prog = new CartOpProgram();
                const bank = bankOf(todo[i][0]);
                this._selectBank(prog, p, bank);
                const batch = [];
                while (i < todo.length && batch.length < 8 && bankOf(todo[i][0]) === bank) {
                    batch.push({ s: todo[i], waits: GbaFlashcart._eraseSector(prog, p, todo[i][0] % bankSize) });
                    i++;
                }
                prog.show(CARTOP.SHOW_ERASE, (i / todo.length) * 100);
                const r = await this.exec(prog, batch.length * ERASE_TIMEOUT_MS + 30000);
                if (!r.ok) {
                    const failed = batch.find(b => b.waits.some(w => w.index === r.executed - 1));
                    const at = failed ? failed.s[0] : batch[0].s[0];
                    await this._showFail();
                    throw new FlashcartError("timeout",
                        `Erasing the sector at ${hex(at)} timed out. Clean the cart contacts and check the profile.`);
                }
                onProgress(i, todo.length, "erase");
            }
        } else {
            await this._chipErase(p);
        }

        // Write and check, 64 KB per program, never crossing a bank.
        const ranges = [];
        const addRange = (start, end) => {
            for (let a = start; a < end;) {
                const bankEnd = (bankOf(a) + 1) * bankSize;
                const n = Math.min(end, bankEnd, a + FLASH_CHUNK) - a;
                ranges.push([a, n]);
                a += n;
            }
        };
        if (todo) {
            // Join neighbouring sectors, stopping at the end of the ROM.
            let cur = null;
            for (const s of todo) {
                const start = s[0], end = Math.min(s[0] + s[1], total);
                if (start >= end) continue;
                if (cur && cur[1] === start) cur[1] = end;
                else { if (cur) addRange(cur[0], cur[1]); cur = [start, end]; }
            }
            if (cur) addRange(cur[0], cur[1]);
        } else {
            addRange(0, total);
        }

        const totalBytes = ranges.reduce((n, r) => n + r[1], 0);
        let done = 0, written = 0;
        for (const [start, n] of ranges) {
            this._checkCancel();
            const data = image.subarray(start, start + n);
            const ok = await this._writeRange(p, plan, bankSize, start, data, (done + n) / totalBytes * 100);
            if (!ok) {
                // Try once more: erase the bad sectors again and rewrite them.
                const redo = sectors ? sectors.filter(s => s[0] < start + n && s[0] + s[1] > start) : null;
                if (!redo) {
                    await this._showFail();
                    throw this.lastVerifyError;
                }
                this.log(`Verify failed near ${hex(this.lastFailAddr)} — erasing and rewriting once.`, "error");
                for (const s of redo) {
                    prog = new CartOpProgram();
                    this._selectBank(prog, p, bankOf(s[0]));
                    GbaFlashcart._eraseSector(prog, p, s[0] % bankSize);
                    const r = await this.exec(prog, ERASE_TIMEOUT_MS + 30000);
                    if (!r.ok) {
                        await this._showFail();
                        throw new FlashcartError("timeout", `Erasing the sector at ${hex(s[0])} timed out.`);
                    }
                }
                const lo = redo[0][0], hi = Math.min(total, redo[redo.length - 1][0] + redo[redo.length - 1][1]);
                for (let a = lo; a < hi;) {
                    const m = Math.min(hi, (bankOf(a) + 1) * bankSize, a + FLASH_CHUNK) - a;
                    if (!await this._writeRange(p, plan, bankSize, a, image.subarray(a, a + m), (done + n) / totalBytes * 100)) {
                        await this._showFail();
                        throw this.lastVerifyError;
                    }
                    a += m;
                }
            }
            done += n;
            if (!isAllFF(data)) written += n;
            onProgress(done, totalBytes, "write");
        }

        prog = new CartOpProgram();
        GbaFlashcart._fullReset(prog, p, capacity);
        this._selectBank(prog, p, 0);
        prog.show(CARTOP.SHOW_DONE);
        await this.exec(prog);
        return {
            written, skipped, cleared, method: plan.method,
            sectors: todo ? todo.length : null,
            seconds: (Date.now() - t0) / 1000,
        };
    }

    /**
     * The chip's size: the profile's, or what the chip itself reports (CFI).
     * Some boards carry a bigger chip than their profile lists, and then the
     * chip's own size is used. The listed size wins if the space past it
     * reads as a copy of the start, or as nothing connected (the GBA then
     * reads back the address itself), or if the start is blank so there is
     * no way to tell.
     */
    async _chipSize(p, cfi) {
        const listed = p.flash_size, reported = cfi && cfi.deviceSize;
        if (!listed || !reported || reported <= listed || listed >= BANK_WINDOW) {
            return listed || reported || 0;
        }
        const prog = new CartOpProgram();
        this._selectBank(prog, p, 0);
        const a = prog.rd16(0, 0xC0), b = prog.rd16(listed, 0xC0);
        const r = await this.exec(prog);
        const start = r.bytes(a, 0xC0), past = r.bytes(b, 0xC0);
        const openBus = past.every((x, i) => x === (((listed + (i & ~1)) >> (1 + (i & 1) * 8)) & 0xFF));
        if (start.every(x => x === 0xFF) || sameBytes(start, past) || openBus) return listed;
        this.log(`The chip reports ${reported >> 20} MB, more than the ${listed >> 20} MB listed for this cart type — using the chip's size.`);
        return reported;
    }

    /** Read the CFI table for a profile the user picked by hand, like FlashGBX's ReadCFI. */
    async _readProfileCfi(p) {
        const set = GbaFlashcart.commandSet(p);
        const readCfi = p.commands.read_cfi ||
            (set === "INTEL" ? [[0, 0x98]] : set === "AMD" ? [[0xAA, 0x98]] : null);
        if (!readCfi) return null;
        return parseCfi(await this._readCfi(readCfi, p.commands.reset || []));
    }

    async _showFail() {
        try {
            const prog = new CartOpProgram();
            prog.show(CARTOP.SHOW_FAIL);
            await this.exec(prog, 10000);
        } catch (e) { /* the error that got us here matters more */ }
    }

    async _chipErase(p) {
        const c = p.commands;
        const timeout = (p.chip_erase_timeout || 300) * 1000;
        const prog = new CartOpProgram();
        this._selectBank(prog, p, 0);
        GbaFlashcart._fullReset(prog, p, p.flash_size || BANK_WINDOW);
        if (p.wait_read_status_register && c.read_status_register) {
            prog.srcmd(c.read_status_register[0][0], c.read_status_register[0][1]);
        }
        c.chip_erase.forEach((cmd, i) => {
            if (cmd[0] !== null && cmd[0] !== undefined) prog.w16(cmd[0], cmd[1]);
            const w = c.chip_erase_wait_for && c.chip_erase_wait_for[i];
            if (w && w[0] !== null && w[0] !== undefined) prog.wait(w[0], w[1], w[2], timeout);
        });
        if (p.wait_read_status_register) prog.srcmd(0, null);
        GbaFlashcart._fullReset(prog, p, p.flash_size || BANK_WINDOW);
        prog.show(CARTOP.SHOW_ERASE, 100);
        this.log("Erasing the whole flash chip — this can take a few minutes.");
        const r = await this.exec(prog, timeout + 60000);
        if (!r.ok) {
            await this._showFail();
            throw new FlashcartError("timeout", "Erasing the flash chip timed out. Clean the cart contacts and check the profile.");
        }
    }

    /** Write and check one range inside a bank. Returns false if the check fails. */
    async _writeRange(p, plan, bankSize, start, data, pct) {
        const addr = start % bankSize;
        const prog = new CartOpProgram();
        this._selectBank(prog, p, Math.floor(start / bankSize));
        prog.show(CARTOP.SHOW_WRITE, pct);
        let vh, ph = null;
        if (isAllFF(data)) {
            vh = prog.verify(null, addr, data.length);
        } else {
            const cfg = prog.attach(plan.cfg);
            const ref = prog.attach(data);
            prog.cfg(cfg);
            ph = prog.prog(ref, addr, data.length);
            GbaFlashcart._localReset(prog, p, addr);
            vh = prog.verify(ref, addr, data.length);
        }
        const r = await this.exec(prog, 180000);
        if (ph && r.status === CARTOP.ST_TIMEOUT) {
            const at = start + (r.word(ph, 0) - addr);
            await this._showFail();
            throw new FlashcartError("timeout",
                `Writing at ${hex(at)} timed out (status ${hex(r.word(ph, 1), 4)}). ` +
                "Clean the cart contacts, or pick another profile.");
        }
        const off = r.word(vh, 0);
        if (off === CARTOP.SAME) return true;
        const ge = r.word(vh, 1);
        this.lastFailAddr = start + off;
        this.lastVerifyError = new FlashcartError("verify",
            `Verify failed at ${hex(start + off)}: read ${hex(ge >>> 16, 4)}, expected ${hex(ge & 0xFFFF, 4)}.`);
        return false;
    }
}

if (typeof window !== "undefined") {
    window.GbaFlashcart = GbaFlashcart;
    window.FlashcartError = FlashcartError;
    window.CartOpProgram = CartOpProgram;
}
if (typeof module !== "undefined" && module.exports) {
    module.exports = { GbaFlashcart, FlashcartError, CartOpProgram, CartOpResult, CARTOP, parseCfi, crc32 };
}
