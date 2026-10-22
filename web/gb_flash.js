/**
 * Writes ROMs to GB/GBC flash carts.
 *
 * All the cart work is done by the cart agent on the GBC (see gb_cart.js):
 * each step here builds a small program of cart reads and writes and runs it.
 *
 * What we know about each flash cart comes from FlashGBX's GB profiles
 * (web/gb_flashcart_profiles.js). Only carts whose flash is written through
 * the cartridge's normal write (/WR) pin are included, because that is the
 * only write signal a GBC can drive.
 *
 *   - Finding the chip works like FlashGBX: try every profile's "read chip ID"
 *     command, match the IDs it returns, read the chip's CFI data, and use the
 *     chip size to choose between profiles that share an ID. A chip that
 *     answers but has no matching profile uses the generic profile for that
 *     command.
 *   - Banks are switched the way FlashGBX does it for the cart's mapper chip.
 *     Profiles marked "manual" use the mapper named in the ROM's header.
 *   - Writing skips sectors that already hold the right data, writes blank
 *     sectors without erasing them, and erases the rest first. Every byte is
 *     read back to check it.
 */

"use strict";

const gbShared = (typeof module !== "undefined" && module.exports)
    ? Object.assign({}, require("./gba_flash.js"), require("./gb_cart.js"))
    : { parseCfi, FlashcartError, GbaFlashcart, GbProgram, GBOP, gbCrc32 };

const GBF_CHUNK = 0x800;            // ROM bytes written per agent program
const GBF_ERASE_MS = 20000;         // longest wait for one sector to erase
const GBF_BANK = 0x4000;

const gbfHex = (v, n = 0) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(n, "0");
const gbfHexBytes = (b) => Array.from(b, x => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");
const gbfSame = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const gbfAllFF = (b) => { for (let i = 0; i < b.length; i++) if (b[i] !== 0xFF) return false; return true; };
const gbfJsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The cart's mapper (bank switching chip), driven the way FlashGBX does it
 * when flashing. select(bank) returns the writes that switch to `bank` and
 * the address where that bank then appears.
 */
class GbFlashMapper {
    constructor(kind, startAddr) {
        this.kind = kind;
        this.startAddr = startAddr;   // where bank 0 appears, if the profile says
        this.flashBank = -1;
        this.max = { mbc1: 0x200000, simple: 0x400000, gbd: 0x100000, mbcx: 0x2000000 }[kind] || 0x800000;
        this.name = { mbc1: "MBC1", simple: "MBC3-style", gbd: "MAC-GBD", mbcx: "MBCX", mbc5: "MBC5" }[kind];
    }

    /** Use the profile's mapper, or for "manual" profiles the one named in the ROM header. */
    static forProfile(p, romType) {
        let kind = "mbc5";
        let m = p.mbc;
        if (m === "manual") m = romType;
        if (typeof m === "number") {
            if (m >= 0x01 && m <= 0x03) kind = "mbc1";
            else if ((m >= 0x05 && m <= 0x06) || (m >= 0x0F && m <= 0x13) || m === 0xFF || m === 0x110) kind = "simple";
            else if (m === 0xFC) kind = "gbd";
            else if (m === 0x206) kind = "mbcx";
        }
        return new GbFlashMapper(kind, p.start_addr);
    }

    select(bank) {
        const w = [];
        let start;
        switch (this.kind) {
        case "mbc1":
            w.push([0x6000, 1], [0x2000, bank & 0xFF], [0x4000, (bank >> 5) & 0xFF]);
            start = (bank & 0x1F) ? 0x4000 : 0;
            break;
        case "simple":
            w.push([0x2100, bank & 0xFF]);
            start = bank ? 0x4000 : 0;
            break;
        case "gbd":
            w.push([0x2000, bank & 0xFF]);
            start = bank ? 0x4000 : 0;
            break;
        case "mbcx": {
            const fb = bank >> 9, b = bank & 0x1FF;
            if (b === 0 || fb !== this.flashBank) {
                w.push([0x0000, 0x05], [0x4000, 0x82], [0xA000, fb], [0x0000, 0x00], ["delay", 100]);
                this.flashBank = fb;
            }
            w.push([0x3000, b >> 8], [0x2100, b & 0xFF]);
            start = 0x4000;
            break;
        }
        default:
            w.push([0x3000, (bank >> 8) & 0xFF], [0x2100, bank & 0xFF]);
            start = bank ? 0x4000 : 0;
        }
        if (bank === 0 && typeof this.startAddr === "number") start = this.startAddr;
        return { writes: w, start };
    }

    /**
     * Some bank numbers look like flash commands to the chip. FlashGBX writes
     * an extra 0 after switching to one of those, and so do we.
     */
    get separates() { return this.kind === "mbc5" || this.kind === "mbcx"; }

    /**
     * The MBC1 treats every write to $4000-$7FFF as a bank change, including
     * writes meant for the flash chip. So after each such write the bank is
     * switched back. (The flash chip ignores these writes while it is busy
     * programming or erasing.)
     */
    get reselects() { return this.kind === "mbc1"; }
}

class GbFlashcart {
    /**
     * @param client  a connected GbCartClient
     */
    constructor(client, { profiles = null, log = () => {} } = {}) {
        this.client = client;
        this.profiles = profiles ||
            (typeof GB_FLASHCART_PROFILES !== "undefined" ? GB_FLASHCART_PROFILES : []);
        this.log = log;
        this.detected = null;
        this.cancelRequested = false;
    }

    cancel() { this.cancelRequested = true; }

    _checkCancel() {
        if (this.cancelRequested) throw new gbShared.FlashcartError("cancelled", "Cancelled");
    }

    async exec(prog, timeoutMs = 60000) {
        this._checkCancel();
        return this.client.run(prog, timeoutMs);
    }

    static _cmds(prog, cmds) {
        for (const c of cmds || []) {
            if (c[0] === null || c[0] === undefined) continue;
            prog.wr(c[0], c[1]);
        }
    }

    static _writes(prog, writes) {
        for (const [a, v] of writes) {
            if (a === "delay") prog.delay(v);
            else prog.wr(a, v);
        }
    }

    /** Put the mapper back to its power-on state: bank 1 at $4000, cart RAM off. */
    static _mapperDefaults(prog) {
        prog.wr(0x0000, 0x00);
        prog.wr(0x3000, 0x00);
        prog.wr(0x2100, 0x01);
    }

    // ------------------------------------------------------------ detection

    /**
     * Identify the flash chip and pick a profile. Returns
     * { profile, candidates, flashId, cfi, method }, or throws "no-flash".
     */
    async detect() {
        this.cancelRequested = false;
        this.detected = null;
        const profiles = this.profiles.filter(p => !p.manual_select);

        let prog = new gbShared.GbProgram();
        GbFlashcart._mapperDefaults(prog);
        const romH = prog.rd(0, 8);
        const m29 = profiles.filter(p => p.m29w640).map(p => {
            GbFlashcart._cmds(prog, p.commands.reset);
            const before = prog.rd(0, 8);
            GbFlashcart._cmds(prog, p.commands.read_identifier);
            const after = prog.rd(0, 8);
            GbFlashcart._cmds(prog, p.commands.reset);
            return { p, before, after };
        });
        let r = await this.exec(prog);
        const rom = r.bytes(romH);
        for (const m of m29) {
            const before = r.bytes(m.before), after = r.bytes(m.after);
            const id = m.p.flash_ids[0];
            if (!gbfSame(before, after) && gbfSame(after.subarray(0, id.length), id)) {
                return this._finishDetect([m.p], after, "M29W640 check");
            }
        }

        // Same approach as FlashGBX: send every profile's reset command, then
        // try each different "read chip ID" command. A command worked if
        // address 0 reads differently afterwards (it shows the ID instead of
        // the ROM).
        const resets = [], groups = [];
        for (const p of profiles) {
            const c = p.commands;
            if (p.m29w640) continue;
            if (c.reset && !resets.some(x => gbfJsonEq(x, c.reset))) resets.push(c.reset);
            if (c.read_identifier && c.read_identifier.length && c.read_identifier[0][0] <= 0x7000 &&
                !groups.some(g => gbfJsonEq(g.rid, c.read_identifier))) {
                groups.push({ rid: c.read_identifier, reset: c.reset || [] });
            }
        }
        groups.sort((a, b) => a.rid[0][0] - b.rid[0][0]);
        prog = new gbShared.GbProgram();
        for (const c of resets) GbFlashcart._cmds(prog, c);
        for (const g of groups) {
            GbFlashcart._mapperDefaults(prog);
            GbFlashcart._cmds(prog, g.reset);
            GbFlashcart._cmds(prog, g.rid);
            g.handle = prog.rd(0, 8);
            GbFlashcart._cmds(prog, g.reset);
        }
        GbFlashcart._mapperDefaults(prog);
        prog.wr(0, 0xFF);
        prog.wr(0, 0xF0);
        r = await this.exec(prog);
        const methods = [];
        for (const g of groups) {
            const cmp = r.bytes(g.handle);
            if (!gbfSame(cmp, rom)) methods.push({ rid: g.rid, id: Uint8Array.from(cmp) });
        }
        for (const m of methods) {
            this.log(`Flash ID via ${gbfHex(m.rid[0][0])}/${gbfHex(m.rid[0][1])}: ${gbfHexBytes(m.id)}`);
        }

        const candidates = [];
        for (const p of profiles) {
            if (!p.flash_ids || !p.flash_ids.length || !p.commands.read_identifier) continue;
            const m = methods.find(m => gbfJsonEq(m.rid, p.commands.read_identifier));
            if (!m) continue;
            if (p.flash_ids.some(id => gbfSame(m.id.subarray(0, id.length), id))) candidates.push(p);
        }
        if (candidates.length) {
            const m = methods.find(m => gbfJsonEq(m.rid, candidates[0].commands.read_identifier));
            return this._finishDetect(candidates, m.id, "FlashGBX profiles");
        }

        // The chip answered an ID command but no profile lists its ID:
        // fall back to the generic profile that uses that command.
        for (const m of methods) {
            const generic = profiles.find(p => p.id.startsWith("DMG_Generic_") &&
                gbfJsonEq(p.commands.read_identifier, m.rid));
            if (generic) return this._finishDetect([generic], m.id, "generic flash commands");
        }

        const seen = methods.length ? methods.map(m => gbfHexBytes(m.id)).join(", ") : "none";
        throw new gbShared.FlashcartError("no-flash",
            "No writable flash chip found. Either this isn't a flash cart, its flash is written through the " +
            `cartridge's AUDIO pin (a GBC can't drive that), or its chip isn't one the profiles know (flash IDs seen: ${seen}).`);
    }

    async _readCfi(p, rid) {
        const readCfi = p.commands.read_cfi || [[rid ? rid[0][0] : 0, 0x98]];
        const prog = new gbShared.GbProgram();
        GbFlashcart._mapperDefaults(prog);
        GbFlashcart._cmds(prog, p.commands.reset);
        GbFlashcart._cmds(prog, readCfi);
        const h = prog.rd(0, 0x400);
        GbFlashcart._cmds(prog, p.commands.reset);
        const r = await this.exec(prog);
        return gbShared.parseCfi(r.bytes(h));
    }

    async _finishDetect(candidates, flashId, method) {
        const first = candidates[0];
        let cfi = null;
        try {
            cfi = await this._readCfi(first, first.commands.read_identifier);
        } catch (e) {
            if (e.code === "cancelled" || e.name === "GbLinkError") throw e;
        }
        let profile = first;
        const sizes = new Set(candidates.map(p => p.flash_size).filter(s => s));
        if (sizes.size > 1 && cfi && cfi.deviceSize) {
            profile = candidates.find(p => p.flash_size === cfi.deviceSize) || first;
        }
        this.detected = { profile, candidates, flashId, cfi, method };
        return this.detected;
    }

    // ------------------------------------------------------------ helpers

    /** Split a range of flash into pieces that each sit inside one bank. */
    static _pieces(off, len) {
        const out = [];
        for (let a = off; a < off + len;) {
            const bank = Math.floor(a / GBF_BANK);
            const n = Math.min(off + len, (bank + 1) * GBF_BANK) - a;
            out.push({ bank, off: a, n });
            a += n;
        }
        return out;
    }

    /** Add the bank switch to prog and return the address where the bank starts. */
    _select(prog, bank) {
        const s = this.mapper.select(bank);
        GbFlashcart._writes(prog, s.writes);
        if (this.mapper.separates && this.separatorValues.has(bank & 0xFF)) prog.wr(0x4000, 0x00);
        return s.start;
    }

    /** Bank numbers that look like flash commands (same list FlashGBX uses). */
    static _conflictValues(p) {
        const values = new Set();
        for (const key of ["single_write", "buffer_write", "page_write", "sector_erase", "chip_erase"]) {
            for (const c of (p.commands[key] || [])) {
                if (Array.isArray(c) && c.length >= 2 && typeof c[1] === "number") { values.add(c[1] & 0xFF); break; }
            }
        }
        return values;
    }

    /** The command sequence the chip needs to write one byte, for GbProgram.tmpl. */
    _template(p, bank) {
        const steps = [];
        for (const c of p.commands.single_write) {
            const pa = c[0] === "PA", pd = c[1] === "PD";
            if (!pa && typeof c[0] !== "number") {
                throw new gbShared.FlashcartError("unsupported", `Unknown address "${c[0]}" in the profile`);
            }
            if (!pd && typeof c[1] !== "number") {
                throw new gbShared.FlashcartError("unsupported", `Unknown value "${c[1]}" in the profile`);
            }
            steps.push({ kind: (pd ? 1 : 0) | (pa ? 2 : 0), addr: pa ? 0 : c[0], value: pd ? 0 : c[1] });
        }
        if (this.mapper.reselects) {
            for (const [a, v] of this.mapper.select(bank).writes) {
                steps.push({ kind: gbShared.GBOP.K_ABS_IMM, addr: a, value: v });
            }
        }
        const waits = p.commands.single_write_wait_for || [];
        if (waits.some(w => w && w[0] !== null && w[0] !== undefined)) {
            throw new gbShared.FlashcartError("unsupported", "This profile's write sequence waits in a way the GBC agent doesn't support.");
        }
        return steps;
    }

    static _resolve(a, sa) {
        if (a === null || a === undefined) return null;
        if (typeof a === "number") return a;
        if (a === "SA") return sa;
        const m = /^SA\+(\d+)$/.exec(a);
        if (m) return sa + Number(m[1]);
        throw new gbShared.FlashcartError("unsupported", `Unknown address "${a}" in the profile`);
    }

    /** Add the steps that erase the sector at `off` to prog. Returns the handles of its wait steps. */
    _eraseSector(prog, p, off) {
        const c = p.commands;
        const bank = Math.floor(off / GBF_BANK);
        const sa = this._select(prog, bank) + (off % GBF_BANK);
        GbFlashcart._cmds(prog, c.reset);
        const waits = [];
        c.sector_erase.forEach((cmd, i) => {
            const a = GbFlashcart._resolve(cmd[0], sa);
            if (a !== null) prog.wr(a, cmd[1]);
            if (a !== null && a >= 0x4000 && this.mapper.reselects) GbFlashcart._writes(prog, this.mapper.select(bank).writes);
            const w = c.sector_erase_wait_for && c.sector_erase_wait_for[i];
            if (w && w[0] !== null && w[0] !== undefined) {
                waits.push(prog.wait(GbFlashcart._resolve(w[0], sa), w[2] & 0xFF, w[1] & 0xFF, GBF_ERASE_MS));
            }
        });
        GbFlashcart._cmds(prog, c.reset);
        return waits;
    }

    // ------------------------------------------------------------ writing

    /**
     * Write `rom` (Uint8Array) from flash offset 0.
     * opts: { profile, skipUnchanged = true, eraseRest = true,
     *         onProgress(done, total, phase) }
     * Returns { written, skipped, cleared, sectors, mapper, seconds }.
     */
    async writeRom(rom, opts = {}) {
        this.cancelRequested = false;
        const det = this.detected || {};
        const p = opts.profile || det.profile;
        if (!p) throw new gbShared.FlashcartError("no-flash", "Detect the flash cart first");
        const cfi = det.profile === p ? det.cfi : await this._readCfi(p, p.commands.read_identifier).catch(() => null);
        const onProgress = opts.onProgress || (() => {});
        const skipUnchanged = opts.skipUnchanged !== false;
        const t0 = Date.now();

        this.mapper = GbFlashMapper.forProfile(p, rom.length > 0x147 ? rom[0x147] : 0);
        this.separatorValues = GbFlashcart._conflictValues(p);
        const chipSize = p.flash_size || (cfi && cfi.deviceSize) || 0;
        const capacity = Math.min(chipSize || this.mapper.max, this.mapper.max);
        if (rom.length > capacity) {
            throw new gbShared.FlashcartError("too-big",
                `The ROM is ${rom.length} bytes but the cart takes ${capacity} bytes.`);
        }
        const total = Math.max(0x8000, Math.ceil(rom.length / GBF_BANK) * GBF_BANK);
        const image = new Uint8Array(total).fill(0xFF);
        image.set(rom);

        const sectors = gbShared.GbaFlashcart.sectorList(p, cfi, total);
        if (!sectors && !p.commands.chip_erase) {
            throw new gbShared.FlashcartError("unsupported",
                "Couldn't read the chip's sector layout (CFI), and this profile has no chip erase.");
        }
        this.log(`Profile: ${p.names[0]} — ${this.mapper.name} banking, ` +
            (sectors ? `${sectors.length} sector${sectors.length === 1 ? "" : "s"}` : "chip erase"));

        let prog = new gbShared.GbProgram();
        this._select(prog, 0);
        GbFlashcart._cmds(prog, p.commands.reset);
        await this.exec(prog);

        const dataOf = (s) => {
            const out = new Uint8Array(s[1]).fill(0xFF);
            if (s[0] < total) out.set(image.subarray(s[0], Math.min(total, s[0] + s[1])));
            return out;
        };

        // Check what each sector holds now: blank, the right data, or something else.
        const all = sectors || [[0, total]];
        const state = await this._survey(all, dataOf, skipUnchanged, onProgress);
        let skipped = 0;
        const erase = [], write = [];
        all.forEach((s, i) => {
            const want = dataOf(s), blankWanted = gbfAllFF(want);
            if (state[i] === "same" || (state[i] === "blank" && blankWanted)) { skipped++; return; }
            if (state[i] !== "blank") erase.push(s);
            if (!blankWanted) write.push(s);
        });
        if (skipped && sectors) this.log(`${skipped} sector${skipped === 1 ? " already holds" : "s already hold"} the right data — skipping.`);

        // Sectors after the end of the ROM may still hold an older, bigger ROM.
        let cleared = 0;
        if (sectors && opts.eraseRest !== false) {
            const limit = Math.min(chipSize, this.mapper.max);
            if (!limit) {
                this.log("The chip size is unknown, so data after the ROM is left as it is.");
            } else {
                const end = sectors.length ? sectors[sectors.length - 1][0] + sectors[sectors.length - 1][1] : 0;
                const rest = gbShared.GbaFlashcart.sectorList(p, cfi, limit).filter(s => s[0] >= end);
                const restState = await this._survey(rest, null, false, onProgress);
                rest.forEach((s, i) => { if (restState[i] !== "blank") { erase.push(s); cleared++; } });
                if (cleared) {
                    this.log(`${cleared} sector${cleared === 1 ? "" : "s"} after the ROM still hold old data — erasing ${cleared === 1 ? "it" : "them"} too.`);
                }
            }
        }

        if (!sectors) {
            if (erase.length) await this._chipErase(p);
        } else {
            await this._eraseSectors(p, erase, onProgress);
        }

        // Write the ROM and check every byte.
        const ranges = [];
        for (const s of (sectors ? write : (erase.length || write.length ? [[0, total]] : []))) {
            const end = Math.min(s[0] + s[1], total);
            for (const piece of GbFlashcart._pieces(s[0], end - s[0])) {
                for (let a = piece.off; a < piece.off + piece.n; a += GBF_CHUNK) {
                    const n = Math.min(GBF_CHUNK, piece.off + piece.n - a);
                    if (!gbfAllFF(image.subarray(a, a + n))) ranges.push([a, n]);
                }
            }
        }
        const totalBytes = ranges.reduce((n, r) => n + r[1], 0);
        let done = 0;
        let templateBank = -1;
        for (const [start, n] of ranges) {
            this._checkCancel();
            const bank = Math.floor(start / GBF_BANK);
            const needTemplate = templateBank < 0 || (this.mapper.reselects && bank !== templateBank);
            let ok = await this._writeRange(p, start, image.subarray(start, start + n), needTemplate);
            templateBank = bank;
            if (!ok) {
                const redo = sectors ? sectors.filter(s => s[0] <= start && s[0] + s[1] > start) : null;
                if (!redo || !redo.length) throw this.lastVerifyError;
                this.log(`Verify failed near ${gbfHex(this.lastFailAddr)} — erasing and rewriting once.`, "error");
                await this._eraseSectors(p, redo, () => {});
                const s = redo[0];
                for (const piece of GbFlashcart._pieces(s[0], Math.min(s[0] + s[1], total) - s[0])) {
                    for (let a = piece.off; a < piece.off + piece.n; a += GBF_CHUNK) {
                        const m = Math.min(GBF_CHUNK, piece.off + piece.n - a);
                        if (gbfAllFF(image.subarray(a, a + m))) continue;
                        if (!await this._writeRange(p, a, image.subarray(a, a + m), true)) throw this.lastVerifyError;
                    }
                }
                templateBank = -1;
            }
            done += n;
            onProgress(done, totalBytes, "write");
        }

        prog = new gbShared.GbProgram();
        GbFlashcart._cmds(prog, p.commands.reset);
        this._select(prog, 0);
        GbFlashcart._mapperDefaults(prog);
        await this.exec(prog);
        return {
            written: totalBytes, skipped, cleared, mapper: this.mapper.name,
            sectors: sectors ? erase.length : null,
            seconds: (Date.now() - t0) / 1000,
        };
    }

    /**
     * Report each sector as "blank", "same" (already holds the right data) or
     * "other". Checking for blank is quick. Sectors that aren't blank get a
     * CRC32 check: first over their first 1 KB, and only if that matches,
     * over the whole sector.
     */
    async _survey(list, dataOf, compare, onProgress) {
        const state = new Array(list.length).fill("other");
        const blankParts = list.map(s => GbFlashcart._pieces(s[0], s[1]));
        await this._batch(list.map((s, i) => i), (prog, i) => {
            const hs = [];
            for (const piece of blankParts[i]) {
                const base = this._select(prog, piece.bank);
                hs.push(prog.blank(base + piece.off % GBF_BANK, piece.n));
            }
            return hs;
        }, (r, i, hs) => {
            if (hs.every(h => r.word(h) === gbShared.GBOP.NONE)) state[i] = "blank";
        }, (k) => onProgress(k, list.length, "compare"), 64);
        if (!compare || !dataOf) return state;

        const crcOf = async (idx, lenOf) => {
            const match = new Set();
            await this._batch(idx, (prog, i) => {
                const s = list[i];
                const hs = [];
                for (const piece of GbFlashcart._pieces(s[0], lenOf(s))) {
                    const base = this._select(prog, piece.bank);
                    hs.push({ h: prog.crc(base + piece.off % GBF_BANK, piece.n), piece });
                }
                return hs;
            }, (r, i, hs) => {
                const want = dataOf(list[i]);
                if (hs.every(x => r.u32(x.h) === gbShared.gbCrc32(want.subarray(x.piece.off - list[i][0], x.piece.off - list[i][0] + x.piece.n)))) {
                    match.add(i);
                }
            }, () => {}, 4);
            return match;
        };
        const candidates = list.map((s, i) => i).filter(i => state[i] !== "blank");
        const head = await crcOf(candidates, (s) => Math.min(s[1], 0x400));
        const full = await crcOf([...head].filter(i => list[i][1] > 0x400), (s) => s[1]);
        for (const i of head) if (list[i][1] <= 0x400 || full.has(i)) state[i] = "same";
        return state;
    }

    /** Pack the steps for several items into each agent program, up to maxItems per program. */
    async _batch(items, emit, collect, progress, maxItems) {
        for (let k = 0; k < items.length;) {
            this._checkCancel();
            const prog = new gbShared.GbProgram();
            const batch = [];
            while (k < items.length && batch.length < maxItems && prog.room > 200 && prog.resultRoom > 64) {
                batch.push({ i: items[k], hs: emit(prog, items[k]) });
                k++;
            }
            const r = await this.exec(prog, 120000);
            for (const b of batch) collect(r, b.i, b.hs);
            progress(k);
        }
    }

    async _eraseSectors(p, list, onProgress) {
        for (let k = 0; k < list.length;) {
            this._checkCancel();
            const prog = new gbShared.GbProgram();
            const batch = [];
            while (k < list.length && batch.length < 8) {
                batch.push({ s: list[k], waits: this._eraseSector(prog, p, list[k][0]) });
                k++;
            }
            const r = await this.exec(prog, batch.length * GBF_ERASE_MS + 30000);
            if (!r.ok) {
                const failed = batch.find(b => b.waits.some(w => w.index === r.executed));
                const at = failed ? failed.s[0] : batch[0].s[0];
                await this._reset(p);
                throw new gbShared.FlashcartError("timeout",
                    `Erasing the sector at ${gbfHex(at)} timed out. Clean the cart contacts and check the profile.`);
            }
            onProgress(k, list.length, "erase");
        }
    }

    async _chipErase(p) {
        const c = p.commands;
        const timeout = (p.chip_erase_timeout || 300) * 1000;
        const prog = new gbShared.GbProgram();
        this._select(prog, 0);
        GbFlashcart._cmds(prog, c.reset);
        c.chip_erase.forEach((cmd, i) => {
            if (cmd[0] !== null && cmd[0] !== undefined) prog.wr(cmd[0], cmd[1]);
            const w = c.chip_erase_wait_for && c.chip_erase_wait_for[i];
            if (w && w[0] !== null && w[0] !== undefined) prog.wait(w[0], w[2] & 0xFF, w[1] & 0xFF, timeout);
        });
        GbFlashcart._cmds(prog, c.reset);
        this.log("Erasing the whole flash chip — this can take a few minutes.");
        const r = await this.exec(prog, timeout + 60000);
        if (!r.ok) {
            await this._reset(p);
            throw new gbShared.FlashcartError("timeout", "Erasing the flash chip timed out. Clean the cart contacts and check the profile.");
        }
    }

    async _reset(p) {
        try {
            const prog = new gbShared.GbProgram();
            GbFlashcart._cmds(prog, p.commands.reset);
            await this.exec(prog, 10000);
        } catch (e) { /* ignore: the caller is about to report the original error */ }
    }

    /** Write one range inside a bank and check it. Returns false if a byte reads back wrong. */
    async _writeRange(p, start, data, template) {
        const bank = Math.floor(start / GBF_BANK);
        const prog = new gbShared.GbProgram();
        if (template) prog.tmpl(this._template(p, bank));
        const addr = this._select(prog, bank) + (start % GBF_BANK);
        const h = prog.prog(addr, data);
        const r = await this.exec(prog, 120000);
        const off = r.word(h, 0);
        if (r.status === gbShared.GBOP.ST_TIMEOUT) {
            await this._reset(p);
            throw new gbShared.FlashcartError("timeout",
                `Writing at ${gbfHex(start + off)} timed out (status ${gbfHex(r.byte(h, 2), 2)}). ` +
                "Clean the cart contacts, or pick another profile.");
        }
        if (off === gbShared.GBOP.NONE) return true;
        this.lastFailAddr = start + off;
        this.lastVerifyError = new gbShared.FlashcartError("verify",
            `Verify failed at ${gbfHex(start + off)}: read ${gbfHex(r.byte(h, 2), 2)}, expected ${gbfHex(r.byte(h, 3), 2)}.`);
        return false;
    }
}

if (typeof window !== "undefined") {
    window.GbFlashcart = GbFlashcart;
    window.GbFlashMapper = GbFlashMapper;
}
if (typeof module !== "undefined" && module.exports) {
    module.exports = { GbFlashcart, GbFlashMapper };
}
