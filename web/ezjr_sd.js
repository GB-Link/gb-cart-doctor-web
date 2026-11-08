/**
 * EZ Flash Jr microSD card support: list, download, upload and delete files
 * on the card inside an EZ Flash Jr, without taking it out.
 *
 * Two parts, both run through the cart agent like gb_flash.js:
 *   - EzJrSd reads and writes raw 512-byte sectors through the cart's FPGA.
 *   - FatVolume is a small FAT16/FAT32 filesystem (long names, create,
 *     replace, delete, folders) on top of any sector device.
 * FatImageDevice is a sector device over a disk image in memory, used by the
 * tests.
 *
 * The page side (the EZ Flash Jr tab) is in ezjr_ui.js.
 */

"use strict";

const ezjrShared = (typeof module !== "undefined" && module.exports)
    ? require("./gb_cart.js")
    : { GbProgram, GBOP };

const FAT_SECTOR = 512;

// ================================================================ EZ Flash Jr sectors

/** The FPGA's sector buffer is 2 KB, so one command moves at most 4 sectors. */
const EZJR_MAX_SECTORS = 4;

const EZJR_REG = {
    UNLOCK1: 0x7F00, UNLOCK2: 0x7F10, UNLOCK3: 0x7F20, LOCK: 0x7FF0,
    SD_MAP: 0x7F30, LBA0: 0x7FB0, COUNT: 0x7FB4, SRAM_MAP: 0x7FC0,
};
const EZJR_WINDOW = 0xA000;
const EZJR_STATUS_DONE = 0x01;

/**
 * Every $7Fxx register this file may write. Anything else is refused, in
 * particular $7FD2, which starts a write to the FPGA's configuration flash
 * and has bricked a cart (ezgb docs/game-slot-access.md).
 */
const EZJR_ALLOWED_REGS = new Set([
    EZJR_REG.UNLOCK1, EZJR_REG.UNLOCK2, EZJR_REG.UNLOCK3, EZJR_REG.LOCK, EZJR_REG.SD_MAP,
    EZJR_REG.LBA0, EZJR_REG.LBA0 + 1, EZJR_REG.LBA0 + 2, EZJR_REG.LBA0 + 3, EZJR_REG.COUNT, EZJR_REG.SRAM_MAP,
]);

class EzJrError extends Error {
    constructor(message) { super(message); this.name = 'EzJrError'; }
}

/** A ezjrShared.GbProgram with helpers for the EZ Flash Jr's FPGA registers. */
class EzProgram extends ezjrShared.GbProgram {
    reg(addr, value) {
        if (!EZJR_ALLOWED_REGS.has(addr)) throw new Error(`Refusing to write FPGA register $${addr.toString(16)}`);
        return this.wr(addr, value);
    }
    // Any other write to $0000-$7FFF re-locks the FPGA (ezgb unlock.v), so nothing
    // may sit between unlock and lock except the register writes themselves.
    unlock() {
        this.reg(EZJR_REG.UNLOCK1, 0xE1);
        this.reg(EZJR_REG.UNLOCK2, 0xE2);
        this.reg(EZJR_REG.UNLOCK3, 0xE3);
    }
    lock() { this.reg(EZJR_REG.LOCK, 0xE4); }
    /** One register write inside its own unlock/lock (stage1's fpga_set). */
    set(addr, value) {
        this.unlock();
        this.reg(addr, value);
        this.lock();
    }
    /** Start an SD command: LBA, then the count register, which triggers it. */
    command(lba, count) {
        this.unlock();
        for (let i = 0; i < 4; i++) this.reg(EZJR_REG.LBA0 + i, (lba >>> (8 * i)) & 0xFF);
        // Writing the count starts the command, so it has to come after the LBA.
        this.reg(EZJR_REG.COUNT, count);
        this.lock();
    }
}

class EzJrSd {
    /**
     * @param client  a connected GbCartClient (or anything with run(ezjrShared.GbProgram))
     * @param opts.sectorsPerCommand  1-4 (default 4)
     * @param opts.verifyWrites  read every written sector back and compare (default true)
     * @param opts.busyTimeoutMs  how long one SD command may stay busy (default 3000)
     */
    constructor(client, { sectorsPerCommand = EZJR_MAX_SECTORS, verifyWrites = true, busyTimeoutMs = 3000 } = {}) {
        this.client = client;
        this.sectorsPerCommand = Math.max(1, Math.min(EZJR_MAX_SECTORS, sectorsPerCommand));
        this.verifyWrites = verifyWrites;
        this.busyTimeoutMs = busyTimeoutMs;
    }

    /**
     * Read the FPGA firmware version: 4 or 5 on an EZ Flash Jr. Returns the
     * byte read, which is something else on other carts (or no cart).
     */
    async readFirmwareVersion() {
        const p = new EzProgram();
        p.set(EZJR_REG.SRAM_MAP, 4);
        const h = p.rd(EZJR_WINDOW, 1);
        p.set(EZJR_REG.SRAM_MAP, 0);
        const res = await this.client.run(p);
        return res.byte(h);
    }

    /**
     * Check that an EZ Flash Jr is inserted and answering. Retries for a
     * while because the FPGA initializes the SD card after power-up.
     */
    async detect({ timeoutMs = 5000, onAttempt = () => {} } = {}) {
        const deadline = Date.now() + timeoutMs;
        let v;
        for (let attempt = 1; ; attempt++) {
            v = await this.readFirmwareVersion();
            onAttempt(attempt, v);
            if (v === 4 || v === 5) break;
            if (Date.now() > deadline) {
                throw new EzJrError(
                    `No EZ Flash Jr found (version register read $${v.toString(16).padStart(2, '0')}). ` +
                    'Insert the cart after the GBA has switched to GBC mode, and make sure it is seated all the way.');
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        // A first sector read proves the SD path works (and that a card is in).
        await this.readSectors(0, 1);
        return { firmware: v };
    }

    /** Read `count` sectors starting at `lba`. Returns a Uint8Array. */
    async readSectors(lba, count = 1) {
        const out = new Uint8Array(count * FAT_SECTOR);
        for (let done = 0; done < count;) {
            const n = Math.min(this.sectorsPerCommand, count - done);
            out.set(await this._readChunk(lba + done, n), done * FAT_SECTOR);
            done += n;
        }
        return out;
    }

    /** Write whole sectors starting at `lba`. data.length must be a multiple of 512. */
    async writeSectors(lba, data) {
        if (data.length % FAT_SECTOR) throw new Error('Write length must be a multiple of 512 bytes');
        const count = data.length / FAT_SECTOR;
        for (let done = 0; done < count;) {
            const n = Math.min(this.sectorsPerCommand, count - done);
            const chunk = data.subarray(done * FAT_SECTOR, (done + n) * FAT_SECTOR);
            await this._writeChunk(lba + done, chunk);
            if (this.verifyWrites) {
                const back = await this._readChunk(lba + done, n);
                for (let i = 0; i < chunk.length; i++) {
                    if (back[i] !== chunk[i]) {
                        throw new EzJrError(`Write check failed at sector ${lba + done + Math.floor(i / FAT_SECTOR)}: the card returned different data.`);
                    }
                }
            }
            done += n;
        }
    }

    async _readChunk(lba, n) {
        // stage1/src/fpga.c sd_read, for n sectors.
        const p = new EzProgram();
        // The FPGA only raises its "done" flag while window bit 0 is on (ezgb gb_regs.v),
        // so the window must be on before the command starts.
        p.set(EZJR_REG.SD_MAP, 1);
        p.command(lba, n);
        p.set(EZJR_REG.SD_MAP, 3);
        // Wait for $01 rather than "not $E1": right after a window switch the bus can
        // briefly read $FF, which would look finished.
        p.wait(EZJR_WINDOW, 0xFF, EZJR_STATUS_DONE, this.busyTimeoutMs);
        p.set(EZJR_REG.SD_MAP, 1);
        const h = p.rd(EZJR_WINDOW, n * FAT_SECTOR);
        p.set(EZJR_REG.SD_MAP, 0);
        const res = await this._run(p, `reading sector ${lba}`);
        return res.bytes(h).slice();
    }

    async _writeChunk(lba, data) {
        // stage1/src/fpga.c sd_write (the kernel's DiskWrite_B2), for n sectors.
        const n = data.length / FAT_SECTOR;
        const p = new EzProgram();
        p.set(EZJR_REG.SD_MAP, 1);
        p.set(EZJR_REG.SD_MAP, 3);
        // Writes to $A000 still land in the sector buffer while reads show the status;
        // this is the order the kernel uses.
        p.wrblk(EZJR_WINDOW, data);
        p.command(lba, 0x80 | n);
        p.wait(EZJR_WINDOW, 0xFF, EZJR_STATUS_DONE, this.busyTimeoutMs);
        p.delay(11);                       // the kernel waits this long after a write; its reason isn't documented, so we copy it
        p.set(EZJR_REG.SD_MAP, 0);
        await this._run(p, `writing sector ${lba}`);
    }

    async _run(p, what) {
        const res = await this.client.run(p);
        if (res.status === ezjrShared.GBOP.ST_TIMEOUT) {
            // No retry: a command that never finishes (FW4 with no card, FW5 after a CRC
            // error) leaves the FPGA mid-command, and sending another would hang the same way.
            // Put the window back so the cart isn't left showing the SD status.
            const off = new EzProgram();
            off.set(EZJR_REG.SD_MAP, 0);
            await this.client.run(off).catch(() => {});
            throw new EzJrError(`The SD card stayed busy while ${what}. Is a microSD card inserted in the EZ Flash Jr?`);
        }
        if (!res.ok) throw new EzJrError(`The GBC agent stopped while ${what} (status ${res.status}).`);
        return res;
    }
}

// ================================================================ FAT filesystem

/*
 * Sector cache for FAT and folder sectors: reads go through it, writes stay
 * in memory until flush(), which writes neighbouring dirty sectors together.
 * File data bypasses it.
 */
class FatBlockCache {
    constructor(device, { maxRun = 16 } = {}) {
        this.device = device;
        this.sectors = new Map();   // lba -> Uint8Array(512)
        this.dirty = new Set();
        this.maxRun = maxRun;       // bounds the buffer; the device splits it into 4-sector commands anyway
    }

    async read(lba) {
        let s = this.sectors.get(lba);
        if (!s) {
            s = (await this.device.readSectors(lba, 1)).slice(0, FAT_SECTOR);
            this.sectors.set(lba, s);
        }
        return s;
    }

    /** Fetch several sectors into the cache with one device read. */
    async prefetch(lba, count) {
        let start = lba;
        const end = lba + count;
        while (start < end) {
            while (start < end && this.sectors.has(start)) start++;
            let stop = start;
            while (stop < end && !this.sectors.has(stop)) stop++;
            if (stop > start) {
                const data = await this.device.readSectors(start, stop - start);
                for (let i = 0; i < stop - start; i++) {
                    this.sectors.set(start + i, data.slice(i * FAT_SECTOR, (i + 1) * FAT_SECTOR));
                }
            }
            start = stop;
        }
    }

    /** Mark a sector (already fetched with read()) as changed. */
    markDirty(lba) {
        if (!this.sectors.has(lba)) throw new Error(`Sector ${lba} is not cached`);
        this.dirty.add(lba);
    }

    async flush() {
        const lbas = [...this.dirty].sort((a, b) => a - b);
        for (let i = 0; i < lbas.length;) {
            let j = i + 1;
            while (j < lbas.length && lbas[j] === lbas[j - 1] + 1 && j - i < this.maxRun) j++;
            const buf = new Uint8Array((j - i) * FAT_SECTOR);
            for (let k = i; k < j; k++) buf.set(this.sectors.get(lbas[k]), (k - i) * FAT_SECTOR);
            await this.device.writeSectors(lbas[i], buf);
            for (let k = i; k < j; k++) this.dirty.delete(lbas[k]);
            i = j;
        }
    }

    async readDirect(lba, count) {
        return this.device.readSectors(lba, count);
    }

    async writeDirect(lba, data) {
        const count = data.length / FAT_SECTOR;
        // A deleted folder's cluster can be reused for file data. Keep any cached copy in
        // step, or a later folder read would still see the old entries.
        for (let i = 0; i < count; i++) {
            if (this.sectors.has(lba + i)) {
                this.sectors.set(lba + i, data.slice(i * FAT_SECTOR, (i + 1) * FAT_SECTOR));
                this.dirty.delete(lba + i);
            }
        }
        await this.device.writeSectors(lba, data);
    }
}

class FatError extends Error {
    constructor(message, code = 'fat') { super(message); this.name = 'FatError'; this.code = code; }
}

const FAT_ATTR = { RO: 0x01, HIDDEN: 0x02, SYSTEM: 0x04, VOLUME: 0x08, DIR: 0x10, ARCHIVE: 0x20, LFN: 0x0F };
const FAT_PARTITION_TYPES = new Set([0x01, 0x04, 0x06, 0x0B, 0x0C, 0x0E]);
const FAT_LFN_CHARS = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]; // byte offsets of the 13 UTF-16 chars
const FAT_INVALID_NAME = /[\\/:*?"<>|\x00-\x1F]/;
const FAT_SHORT_OK = /^[A-Z0-9!#$%&'()\-@^_`{}~]$/;

const fatU16 = (b, o) => b[o] | (b[o + 1] << 8);
const fatU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const fatW16 = (b, o, v) => { b[o] = v & 0xFF; b[o + 1] = (v >>> 8) & 0xFF; };
const fatW32 = (b, o, v) => { fatW16(b, o, v & 0xFFFF); fatW16(b, o + 2, v >>> 16); };

function fatDosDateTime(d) {
    // FAT dates can't go before 1980; a file with an older timestamp gets 1980.
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date, time };
}

function fatFromDos(date, time) {
    if (!date) return null;
    return new Date(1980 + (date >> 9), ((date >> 5) & 0x0F) - 1, date & 0x1F,
        time >> 11, (time >> 5) & 0x3F, (time & 0x1F) * 2);
}

function fatLfnChecksum(short11) {
    let sum = 0;
    for (let i = 0; i < 11; i++) sum = ((((sum & 1) << 7) | (sum >> 1)) + short11[i]) & 0xFF;
    return sum;
}

function fatSplitPath(path) {
    return path.split('/').filter((p) => p && p !== '.');
}

/** Turn a long name into an 8.3 basis (upper case, invalid chars replaced). */
function fatShortBasis(name) {
    let clean = name.toUpperCase().replace(/ /g, '');
    while (clean.startsWith('.')) clean = clean.slice(1);
    const dot = clean.lastIndexOf('.');
    let base = dot > 0 ? clean.slice(0, dot) : clean;
    let ext = dot > 0 ? clean.slice(dot + 1) : '';
    const fix = (s) => [...s.replace(/\./g, '')].map((c) => (FAT_SHORT_OK.test(c) ? c : '_')).join('');
    const lossy = fix(base) !== base.replace(/\./g, '') || fix(ext) !== ext;
    base = fix(base);
    ext = fix(ext);
    return { base: base || '_', ext: ext.slice(0, 3), lossy: lossy || base.length > 8 || ext.length > 3 || dot !== clean.lastIndexOf('.') };
}

/**
 * If `name` is a plain 8.3 name (each part all upper or all lower case),
 * return the 11-byte short name and the NT case bits, so no LFN is needed.
 */
function fatExactShort(name) {
    const m = /^([^.]{1,8})(?:\.([^.]{1,3}))?$/.exec(name);
    if (!m) return null;
    const [, base, ext = ''] = m;
    const caseBits = (part, bit) => {
        if (part === part.toUpperCase()) return 0;
        if (part === part.toLowerCase()) return bit;
        return -1;
    };
    const b = caseBits(base, 0x08), e = caseBits(ext, 0x10);
    if (b < 0 || e < 0) return null;
    const up = (base + (ext ? '.' + ext : '')).toUpperCase();
    if (![...up.replace('.', '')].every((c) => FAT_SHORT_OK.test(c))) return null;
    return { short11: fatPack11(base.toUpperCase(), ext.toUpperCase()), nt: b | e };
}

function fatPack11(base, ext) {
    const out = new Uint8Array(11).fill(0x20);
    for (let i = 0; i < Math.min(8, base.length); i++) out[i] = base.charCodeAt(i);
    for (let i = 0; i < Math.min(3, ext.length); i++) out[8 + i] = ext.charCodeAt(i);
    // A first byte of $E5 means "deleted", so a real $E5 is stored as $05.
    if (out[0] === 0xE5) out[0] = 0x05;
    return out;
}

function fatShortToString(b, nt = 0) {
    let base = String.fromCharCode(...b.subarray(0, 8)).trimEnd();
    let ext = String.fromCharCode(...b.subarray(8, 11)).trimEnd();
    if (base.charCodeAt(0) === 0x05) base = '\xE5' + base.slice(1);
    if (nt & 0x08) base = base.toLowerCase();
    if (nt & 0x10) ext = ext.toLowerCase();
    return ext ? `${base}.${ext}` : base;
}

class FatVolume {
    constructor(cache) {
        this.cache = cache;
    }

    /** Mount the first FAT volume on the device. */
    static async mount(device) {
        const cache = new FatBlockCache(device);
        const vol = new FatVolume(cache);
        await vol._mount();
        return vol;
    }

    async _mount() {
        const s0 = (await this.cache.readDirect(0, 1)).slice();
        let start = 0;
        if (!this._looksLikeBoot(s0)) {
            if (s0[510] !== 0x55 || s0[511] !== 0xAA) throw new FatError('The card has no partition table or FAT volume.');
            let found = null;
            for (let i = 0; i < 4; i++) {
                const e = 446 + i * 16;
                const type = s0[e + 4];
                if (type === 0xEE) throw new FatError('The card uses GPT partitioning. Format it as FAT32 with an MBR partition table.');
                // 0x07 is exFAT (or NTFS). Accept it here so the boot sector check below can say
                // "exFAT" instead of "no FAT partition".
                if (FAT_PARTITION_TYPES.has(type) || type === 0x07) { found = { type, lba: fatU32(s0, e + 8) }; break; }
            }
            if (!found) throw new FatError('No FAT partition found on the card.');
            start = found.lba;
        }
        const bs = start ? (await this.cache.readDirect(start, 1)).slice() : s0;
        if (String.fromCharCode(...bs.subarray(3, 11)) === 'EXFAT   ') {
            throw new FatError('The card is formatted as exFAT. The EZ Flash Jr needs FAT32.');
        }
        if (!this._looksLikeBoot(bs)) throw new FatError('The partition does not contain a FAT boot sector.');

        const bytesPerSector = fatU16(bs, 11);
        if (bytesPerSector !== FAT_SECTOR) throw new FatError(`Unsupported sector size ${bytesPerSector}.`);
        this.sectorsPerCluster = bs[13];
        this.reservedSectors = fatU16(bs, 14);
        this.numFats = bs[16];
        this.rootEntries = fatU16(bs, 17);
        this.totalSectors = fatU16(bs, 19) || fatU32(bs, 32);
        this.fatSize = fatU16(bs, 22) || fatU32(bs, 36);
        this.rootDirSectors = Math.ceil((this.rootEntries * 32) / FAT_SECTOR);
        this.fatStart = start + this.reservedSectors;
        this.rootStart = this.fatStart + this.numFats * this.fatSize; // FAT16 fixed root
        this.dataStart = this.rootStart + this.rootDirSectors;
        const dataSectors = this.totalSectors - (this.dataStart - start);
        this.clusterCount = Math.floor(dataSectors / this.sectorsPerCluster);
        this.clusterBytes = this.sectorsPerCluster * FAT_SECTOR;

        if (this.clusterCount < 4085) throw new FatError('FAT12 volumes are not supported. Format the card as FAT32.');
        this.type = this.clusterCount < 65525 ? 'FAT16' : 'FAT32';
        this.rootCluster = this.type === 'FAT32' ? fatU32(bs, 44) : 0;
        this.eoc = this.type === 'FAT32' ? 0x0FFFFFF8 : 0xFFF8;

        this.freeCount = null;
        this.nextFree = 2;
        this.fsInfoSector = null;
        if (this.type === 'FAT32') {
            const fsi = fatU16(bs, 48);
            if (fsi && fsi < this.reservedSectors) {
                const s = await this.cache.read(start + fsi);
                if (fatU32(s, 0) === 0x41615252 && fatU32(s, 484) === 0x61417272) {
                    this.fsInfoSector = start + fsi;
                    const free = fatU32(s, 488), next = fatU32(s, 492);
                    // Some formatters leave FSInfo stale or unset; out-of-range values mean "unknown".
                    if (free !== 0xFFFFFFFF && free <= this.clusterCount) this.freeCount = free;
                    if (next >= 2 && next < this.clusterCount + 2) this.nextFree = next;
                }
            }
        }
    }

    _looksLikeBoot(b) {
        return (b[0] === 0xEB || b[0] === 0xE9) && fatU16(b, 11) >= 512 && b[13] > 0 &&
            (b[13] & (b[13] - 1)) === 0 && b[16] > 0 && b[510] === 0x55 && b[511] === 0xAA;
    }

    info() {
        return {
            type: this.type,
            totalBytes: this.clusterCount * this.clusterBytes,
            freeBytes: this.freeCount == null ? null : this.freeCount * this.clusterBytes,
        };
    }

    clusterLba(c) { return this.dataStart + (c - 2) * this.sectorsPerCluster; }

    // ------------------------------------------------------------ FAT table

    _fatPos(c) {
        const off = this.type === 'FAT32' ? c * 4 : c * 2;
        return { sector: Math.floor(off / FAT_SECTOR), off: off % FAT_SECTOR };
    }

    async getFat(c) {
        const { sector, off } = this._fatPos(c);
        const s = await this.cache.read(this.fatStart + sector);
        return this.type === 'FAT32' ? fatU32(s, off) & 0x0FFFFFFF : fatU16(s, off);
    }

    async setFat(c, value) {
        const { sector, off } = this._fatPos(c);
        for (let f = 0; f < this.numFats; f++) {
            const lba = this.fatStart + f * this.fatSize + sector;
            const s = await this.cache.read(lba);
            // The top 4 bits of a FAT32 entry are reserved and must be kept.
            if (this.type === 'FAT32') fatW32(s, off, (fatU32(s, off) & 0xF0000000) | (value & 0x0FFFFFFF));
            else fatW16(s, off, value);
            this.cache.markDirty(lba);
        }
    }

    isEnd(v) { return v >= this.eoc; }

    async chain(first) {
        const out = [];
        let c = first;
        while (c >= 2 && c < this.clusterCount + 2) {
            out.push(c);
            // A corrupt FAT can loop; stop instead of hanging the page.
            if (out.length > this.clusterCount) throw new FatError('Cluster chain loops. Run a disk check on the card.');
            const next = await this.getFat(c);
            if (this.isEnd(next) || next < 2) break;
            c = next;
        }
        return out;
    }

    /**
     * Find `n` free clusters without claiming them. Starts at the FSInfo
     * hint so it rarely scans much of the FAT.
     */
    async findFree(n, exclude = new Set()) {
        const found = [];
        const total = this.clusterCount + 2;
        let c = this.nextFree;
        for (let scanned = 0; found.length < n && scanned < this.clusterCount; scanned++) {
            if (c >= total) c = 2;
            if (!exclude.has(c)) {
                // Every read is a round trip over the link, so fetch 8 FAT sectors at a time.
                const { sector, off } = this._fatPos(c);
                if (off === 0) await this.cache.prefetch(this.fatStart + sector, Math.min(8, this.fatSize - sector));
                if ((await this.getFat(c)) === 0) found.push(c);
            }
            c++;
        }
        if (found.length < n) throw new FatError('The card is full.', 'full');
        return found;
    }

    /**
     * Count free clusters by reading the whole FAT. Slow over the link on a
     * big card (the FAT of a 32 GB card is a few MB), so the UI only does it
     * on request. Updates FSInfo's free count on FAT32.
     */
    async countFree({ onProgress = () => {}, isCancelled = () => false } = {}) {
        const perSector = FAT_SECTOR / (this.type === 'FAT32' ? 4 : 2);
        const last = this.clusterCount + 1;
        let free = 0;
        for (let sector = 0; sector * perSector <= last; sector += 64) {
            if (isCancelled()) throw new FatError('Cancelled', 'cancelled');
            const n = Math.min(64, this.fatSize - sector);
            const data = await this.cache.readDirect(this.fatStart + sector, n);
            for (let i = 0; i < n * perSector; i++) {
                const c = sector * perSector + i;
                if (c < 2 || c > last) continue;
                const v = this.type === 'FAT32' ? fatU32(data, i * 4) & 0x0FFFFFFF : fatU16(data, i * 2);
                if (v === 0) free++;
            }
            onProgress(Math.min(last, (sector + n) * perSector), last);
        }
        this.freeCount = free;
        await this._writeFsInfo();
        await this.cache.flush();
        return free;
    }

    async _claimed(clusters) {
        if (this.freeCount != null) this.freeCount -= clusters.length;
        if (clusters.length) this.nextFree = clusters[clusters.length - 1] + 1;
        await this._writeFsInfo();
    }

    async _freed(n) {
        if (this.freeCount != null) this.freeCount += n;
        await this._writeFsInfo();
    }

    async _writeFsInfo() {
        if (!this.fsInfoSector) return;
        const s = await this.cache.read(this.fsInfoSector);
        fatW32(s, 488, this.freeCount == null ? 0xFFFFFFFF : this.freeCount);
        fatW32(s, 492, this.nextFree >= this.clusterCount + 2 ? 2 : this.nextFree);
        this.cache.markDirty(this.fsInfoSector);
    }

    // ------------------------------------------------------------ directories

    /** The sector LBAs of a directory (cluster 0 = FAT16 fixed root). */
    async _dirSectors(dirCluster) {
        if (dirCluster === 0 && this.type === 'FAT16') {
            return Array.from({ length: this.rootDirSectors }, (_, i) => this.rootStart + i);
        }
        const out = [];
        for (const c of await this.chain(dirCluster || this.rootCluster)) {
            const lba = this.clusterLba(c);
            for (let i = 0; i < this.sectorsPerCluster; i++) out.push(lba + i);
        }
        return out;
    }

    /**
     * Read every entry in a directory. Each entry records the slots it uses
     * so it can be deleted. Also returns the free slots, for adding entries.
     */
    async _readDir(dirCluster) {
        const sectors = await this._dirSectors(dirCluster);
        const entries = [];
        const free = [];          // si (sector index) lets _findRun see runs that cross cluster boundaries
        let lfn = [], lfnSum = -1, lfnSlots = [];
        let ended = false;
        for (let si = 0; si < sectors.length; si++) {
            if (!ended && si % this.sectorsPerCluster === 0) {
                await this.cache.prefetch(sectors[si], Math.min(this.sectorsPerCluster, sectors.length - si));
            }
            const lba = sectors[si];
            const s = ended ? null : await this.cache.read(lba);
            for (let off = 0; off < FAT_SECTOR; off += 32) {
                // Everything after a $00 entry is free by definition, so the rest of the folder
                // isn't read: that saves link time on folders with few files.
                if (ended || s[off] === 0x00) { ended = true; free.push({ lba, off, si }); continue; }
                if (s[off] === 0xE5) { free.push({ lba, off, si }); lfn = []; lfnSlots = []; continue; }
                const attr = s[off + 11];
                if ((attr & 0x3F) === FAT_ATTR.LFN) {
                    const ord = s[off] & 0x3F;
                    if (s[off] & 0x40) { lfn = []; lfnSlots = []; lfnSum = s[off + 13]; }
                    let part = '';
                    for (const p of FAT_LFN_CHARS) {
                        const ch = fatU16(s, off + p);
                        if (ch === 0 || ch === 0xFFFF) break;
                        part += String.fromCharCode(ch);
                    }
                    lfn[ord - 1] = part;
                    lfnSlots.push({ lba, off });
                    continue;
                }
                const short11 = s.slice(off, off + 11);
                const slots = [...lfnSlots, { lba, off }];
                // Long-name entries left behind when another system deleted or renamed a file
                // don't match the checksum; fall back to the 8.3 name then.
                const longName = lfn.length && lfnSum === fatLfnChecksum(short11) && !lfn.includes(undefined) ? lfn.join('') : null;
                lfn = []; lfnSlots = [];
                if (attr & FAT_ATTR.VOLUME) continue;
                const shortName = fatShortToString(short11, s[off + 12]);
                if (shortName === '.' || shortName === '..') continue;
                entries.push({
                    name: longName || shortName,
                    shortName: fatShortToString(short11),
                    short11,
                    isDir: !!(attr & FAT_ATTR.DIR),
                    attr,
                    size: fatU32(s, off + 28),
                    firstCluster: (this.type === 'FAT32' ? (fatU16(s, off + 20) << 16) : 0) | fatU16(s, off + 26),
                    modified: fatFromDos(fatU16(s, off + 24), fatU16(s, off + 22)),
                    slots,
                });
            }
        }
        return { entries, free, sectors };
    }

    /** Find an entry by path. Returns null if missing. The root is { isDir, firstCluster: root }. */
    async stat(path) {
        const parts = fatSplitPath(path);
        let cur = { name: '/', isDir: true, firstCluster: this.type === 'FAT32' ? this.rootCluster : 0, root: true };
        for (const part of parts) {
            if (!cur.isDir) return null;
            const { entries } = await this._readDir(cur.firstCluster);
            const want = part.toUpperCase();
            // FAT names are case-insensitive. The 8.3 alias also matches, since some tools show only that.
            const next = entries.find((e) => e.name.toUpperCase() === want || e.shortName === want);
            if (!next) return null;
            cur = next;
        }
        return cur;
    }

    async _dirOf(path) {
        const e = await this.stat(path);
        if (!e) throw new FatError(`Folder not found: ${path}`, 'missing');
        if (!e.isDir) throw new FatError(`Not a folder: ${path}`, 'notdir');
        return e;
    }

    /** List a folder: [{ name, isDir, size, modified, hidden }] */
    async readdir(path = '/') {
        const dir = await this._dirOf(path);
        const { entries } = await this._readDir(dir.firstCluster);
        return entries.map((e) => ({
            name: e.name, isDir: e.isDir, size: e.isDir ? 0 : e.size, modified: e.modified,
            hidden: !!(e.attr & (FAT_ATTR.HIDDEN | FAT_ATTR.SYSTEM)),
        }));
    }

    // ------------------------------------------------------------ files

    /** Group clusters into runs of consecutive clusters. */
    _runs(clusters) {
        const runs = [];
        for (const c of clusters) {
            const last = runs[runs.length - 1];
            if (last && last.start + last.count === c) last.count++;
            else runs.push({ start: c, count: 1 });
        }
        return runs;
    }

    async readFile(path, { onProgress = () => {}, isCancelled = () => false, chunkSectors = 32 } = {}) {
        const e = await this.stat(path);
        if (!e) throw new FatError(`File not found: ${path}`, 'missing');
        if (e.isDir) throw new FatError(`${path} is a folder.`, 'isdir');
        const out = new Uint8Array(e.size);
        if (!e.size) return out;
        const clusters = (await this.chain(e.firstCluster)).slice(0, Math.ceil(e.size / this.clusterBytes));
        let pos = 0;
        for (const run of this._runs(clusters)) {
            let lba = this.clusterLba(run.start);
            let left = Math.min(run.count * this.sectorsPerCluster, Math.ceil((e.size - pos) / FAT_SECTOR));
            while (left > 0 && pos < e.size) {
                if (isCancelled()) throw new FatError('Cancelled', 'cancelled');
                const n = Math.min(chunkSectors, left);
                const data = await this.cache.readDirect(lba, n);
                const take = Math.min(data.length, e.size - pos);
                out.set(data.subarray(0, take), pos);
                pos += take; lba += n; left -= n;
                onProgress(pos, e.size);
            }
        }
        if (pos < e.size) throw new FatError(`${path} is shorter on the card than its size says. Run a disk check.`);
        return out;
    }

    /**
     * Create (or replace, with overwrite) a file and write `data` into it.
     * onCommit() is called once the data is written, just before the FAT and
     * folder entry are; isCancelled() is not checked after that.
     */
    async writeFile(path, data, { overwrite = false, modified = new Date(), onProgress = () => {}, isCancelled = () => false, onCommit = () => {}, chunkSectors = 32 } = {}) {
        const parts = fatSplitPath(path);
        const name = parts.pop();
        this._checkName(name);
        const dir = await this._dirOf('/' + parts.join('/'));
        const existing = await this.stat(path);
        if (existing) {
            if (existing.isDir) throw new FatError(`A folder named ${name} already exists.`, 'exists');
            if (!overwrite) throw new FatError(`${name} already exists.`, 'exists');
        }

        const n = Math.ceil(data.length / this.clusterBytes);
        // The data goes into clusters the FAT still marks free, so if anything below fails
        // the card is as it was. Replacing a file needs room for both copies for that reason.
        // Empty files get no cluster: first cluster 0 is how FAT marks them.
        const clusters = n ? await this.findFree(n) : [];
        let pos = 0;
        for (const run of this._runs(clusters)) {
            let lba = this.clusterLba(run.start);
            let left = Math.min(run.count * this.sectorsPerCluster, Math.ceil((data.length - pos) / FAT_SECTOR));
            while (left > 0) {
                if (isCancelled()) throw new FatError('Cancelled', 'cancelled');
                const k = Math.min(chunkSectors, left);
                const buf = new Uint8Array(k * FAT_SECTOR);
                buf.set(data.subarray(pos, Math.min(data.length, pos + buf.length)));
                await this.cache.writeDirect(lba, buf);
                pos = Math.min(data.length, pos + buf.length); lba += k; left -= k;
                onProgress(pos, data.length);
            }
        }

        // The data is on the card. From here on, finish the job: a half-written
        // FAT or folder entry is worse than an unwanted file.
        if (isCancelled()) throw new FatError('Cancelled', 'cancelled');
        onCommit();

        if (existing) await this._remove(existing, { flush: false });

        // FAT before folder entry: chained clusters without an entry are only lost space,
        // but an entry pointing at unchained clusters is a corrupt file.
        for (let i = 0; i < clusters.length; i++) {
            await this.setFat(clusters[i], i + 1 < clusters.length ? clusters[i + 1] : 0x0FFFFFFF);
        }
        await this._claimed(clusters);
        await this.cache.flush();

        await this._addEntry(dir, name, { attr: FAT_ATTR.ARCHIVE, firstCluster: clusters[0] || 0, size: data.length, modified });
        await this.cache.flush();
        onProgress(data.length, data.length);
    }

    async mkdir(path, { modified = new Date() } = {}) {
        const parts = fatSplitPath(path);
        const name = parts.pop();
        this._checkName(name);
        const parent = await this._dirOf('/' + parts.join('/'));
        if (await this.stat(path)) throw new FatError(`${name} already exists.`, 'exists');

        const [c] = await this.findFree(1);
        const { date, time } = fatDosDateTime(modified);
        const parentCluster = parent.root ? 0 : parent.firstCluster;
        const first = new Uint8Array(FAT_SECTOR);
        const dot = (off, short, cl) => {
            first.set(fatPack11(short, ''), off);
            first[off + 11] = FAT_ATTR.DIR;
            fatW16(first, off + 22, time); fatW16(first, off + 24, date); fatW16(first, off + 18, date);
            fatW16(first, off + 14, time); fatW16(first, off + 16, date);
            fatW16(first, off + 20, cl >>> 16); fatW16(first, off + 26, cl & 0xFFFF);
        };
        dot(0, '.', c);
        // ".." points to cluster 0 when the parent is the root folder, even on FAT32.
        dot(32, '..', parentCluster);
        const buf = new Uint8Array(this.clusterBytes);
        buf.set(first);
        await this.cache.writeDirect(this.clusterLba(c), buf);
        await this.setFat(c, 0x0FFFFFFF);
        await this._claimed([c]);
        await this.cache.flush();
        await this._addEntry(parent, name, { attr: FAT_ATTR.DIR, firstCluster: c, size: 0, modified });
        await this.cache.flush();
    }

    /** Delete a file or an empty folder. */
    /** Rename a file or folder in place (same folder). */
    async rename(path, newName) {
        this._checkName(newName);
        const e = await this.stat(path);
        if (!e) throw new FatError(`Not found: ${path}`, 'missing');
        if (e.root) throw new FatError('Cannot rename the root folder.');
        if (newName === e.name) return;
        const parts = fatSplitPath(path);
        parts.pop();
        const dir = await this._dirOf('/' + parts.join('/'));
        // A case-only change ("tetris.gb" to "Tetris.gb") finds the file itself, which is fine.
        const clash = await this.stat('/' + [...parts, newName].join('/'));
        if (clash && !this._sameEntry(clash, e)) throw new FatError(`${newName} already exists.`, 'exists');

        const last = e.slots[e.slots.length - 1];
        const old = (await this.cache.read(last.lba)).slice(last.off, last.off + 32);
        // New entry first, then the old one goes, in one flush. An interruption can
        // leave two names for the same file (a disk check fixes that), never none.
        await this._addEntry(dir, newName, { copyFrom: old, exclude: e });
        for (const { lba, off } of e.slots) {
            const s = await this.cache.read(lba);
            s[off] = 0xE5;
            this.cache.markDirty(lba);
        }
        await this.cache.flush();
    }

    _sameEntry(a, b) {
        const x = a.slots[a.slots.length - 1], y = b.slots[b.slots.length - 1];
        return x.lba === y.lba && x.off === y.off;
    }

    async remove(path) {
        const e = await this.stat(path);
        if (!e) throw new FatError(`Not found: ${path}`, 'missing');
        if (e.root) throw new FatError('Cannot delete the root folder.');
        if (e.isDir) {
            const { entries } = await this._readDir(e.firstCluster);
            if (entries.length) throw new FatError(`The folder ${e.name} is not empty.`, 'notempty');
        }
        await this._remove(e, { flush: true });
    }

    async _remove(e, { flush }) {
        // Entry first, then the clusters: an interruption leaves lost clusters, never a broken file.
        for (const { lba, off } of e.slots) {
            const s = await this.cache.read(lba);
            s[off] = 0xE5;
            this.cache.markDirty(lba);
        }
        if (flush) await this.cache.flush();
        const clusters = e.firstCluster ? await this.chain(e.firstCluster) : [];
        for (const c of clusters) await this.setFat(c, 0);
        await this._freed(clusters.length);
        if (flush) await this.cache.flush();
    }

    _checkName(name) {
        if (!name || name === '.' || name === '..') throw new FatError('Invalid name.', 'name');
        if (FAT_INVALID_NAME.test(name)) throw new FatError(`Names can't contain \\ / : * ? " < > |`, 'name');
        if (name.length > 255) throw new FatError('Name is too long (255 characters max).', 'name');
        if (/[ .]$/.test(name)) throw new FatError("Names can't end with a space or a dot.", 'name');
    }

    /** Pick a unique 8.3 name for `name` in a directory. */
    _makeShort(name, entries, exclude = null) {
        const exact = fatExactShort(name);
        // The entry being renamed doesn't count: "TETRIS.GB" may become "tetris.gb".
        const others = exclude ? entries.filter((e) => !this._sameEntry(e, exclude)) : entries;
        const taken = new Set(others.map((e) => String.fromCharCode(...e.short11)));
        // Plain 8.3 names are stored without long-name entries, using the lowercase flags
        // Windows uses, so every FAT reader shows them the same.
        if (exact && !taken.has(String.fromCharCode(...exact.short11))) return { ...exact, needLfn: false };
        const { base, ext } = fatShortBasis(name);
        for (let i = 1; i < 1000000; i++) {
            const tail = `~${i}`;
            const s11 = fatPack11(base.slice(0, 8 - tail.length) + tail, ext);
            if (!taken.has(String.fromCharCode(...s11))) return { short11: s11, nt: 0, needLfn: true };
        }
        throw new FatError('Too many similar names in this folder.');
    }

    async _addEntry(dir, name, { attr, firstCluster, size, modified, copyFrom = null, exclude = null }) {
        const dirCluster = dir.root ? (this.type === 'FAT32' ? this.rootCluster : 0) : dir.firstCluster;
        let { entries, free } = await this._readDir(dirCluster);
        const { short11, nt, needLfn } = this._makeShort(name, entries, exclude);
        const lfnCount = needLfn ? Math.ceil(name.length / 13) : 0;
        const need = lfnCount + 1;

        let slots = this._findRun(free, need);
        if (!slots) {
            if (dirCluster === 0) throw new FatError('The root folder is full.', 'full');
            await this._growDir(dirCluster);
            ({ free } = await this._readDir(dirCluster));
            slots = this._findRun(free, need);
            if (!slots) throw new FatError('Could not make room in the folder.');
        }

        const sum = fatLfnChecksum(short11);
        for (let i = 0; i < lfnCount; i++) {
            const ord = lfnCount - i;                     // stored last part first
            const { lba, off } = slots[i];
            const s = await this.cache.read(lba);
            s.fill(0, off, off + 32);
            s[off] = ord | (i === 0 ? 0x40 : 0);
            s[off + 11] = FAT_ATTR.LFN;
            s[off + 13] = sum;
            const chunk = name.slice((ord - 1) * 13, ord * 13);
            FAT_LFN_CHARS.forEach((p, k) => {
                // The FAT spec ends a long name with one $0000, then pads with $FFFF.
                const ch = k < chunk.length ? chunk.charCodeAt(k) : (k === chunk.length ? 0 : 0xFFFF);
                fatW16(s, off + p, ch);
            });
            this.cache.markDirty(lba);
        }
        const { lba, off } = slots[lfnCount];
        const s = await this.cache.read(lba);
        s.fill(0, off, off + 32);
        s.set(short11, off);
        if (copyFrom) {
            // A rename keeps everything but the name: attributes, dates, first cluster, size.
            s.set(copyFrom.subarray(11, 32), off + 11);
            s[off + 12] = nt;
            this.cache.markDirty(lba);
            return;
        }
        s[off + 11] = attr;
        s[off + 12] = nt;
        const { date, time } = fatDosDateTime(modified);
        fatW16(s, off + 14, time); fatW16(s, off + 16, date); fatW16(s, off + 18, date);
        fatW16(s, off + 20, this.type === 'FAT32' ? firstCluster >>> 16 : 0);
        fatW16(s, off + 22, time); fatW16(s, off + 24, date);
        fatW16(s, off + 26, firstCluster & 0xFFFF);
        fatW32(s, off + 28, size);
        this.cache.markDirty(lba);
    }

    /** Consecutive free slots (in directory order). */
    _findRun(free, need) {
        let run = [];
        for (const slot of free) {
            const prev = run[run.length - 1];
            const adjacent = prev && (
                (slot.si === prev.si && slot.off === prev.off + 32) ||
                (slot.si === prev.si + 1 && slot.off === 0 && prev.off === FAT_SECTOR - 32));
            run = adjacent ? [...run, slot] : [slot];
            if (run.length === need) return run;
        }
        return null;
    }

    async _growDir(dirCluster) {
        const chain = await this.chain(dirCluster);
        const [c] = await this.findFree(1);
        // Zeroed, because leftover bytes in a folder cluster would read as entries.
        await this.cache.writeDirect(this.clusterLba(c), new Uint8Array(this.clusterBytes));
        await this.setFat(c, 0x0FFFFFFF);
        await this.setFat(chain[chain.length - 1], c);
        await this._claimed([c]);
        await this.cache.flush();
    }
}

/** A sector device over a disk image in memory (tests). */
class FatImageDevice {
    constructor(buffer) {
        this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        this.sectorCount = Math.floor(this.bytes.length / FAT_SECTOR);
    }

    _check(lba, count) {
        if (lba < 0 || lba + count > this.sectorCount) throw new Error(`Sector ${lba}+${count} is outside the image`);
    }

    async readSectors(lba, count = 1) {
        this._check(lba, count);
        return this.bytes.slice(lba * FAT_SECTOR, (lba + count) * FAT_SECTOR);
    }

    async writeSectors(lba, data) {
        if (data.length % FAT_SECTOR) throw new Error('Write length must be a multiple of 512 bytes');
        this._check(lba, data.length / FAT_SECTOR);
        this.bytes.set(data, lba * FAT_SECTOR);
    }
}

if (typeof window !== "undefined") {
    Object.assign(window, { EzJrSd, EzJrError, FatVolume, FatError, FatImageDevice, fatSplitPath });
}
if (typeof module !== "undefined" && module.exports) {
    module.exports = { EzJrSd, EzJrError, EzProgram, EZJR_MAX_SECTORS, FatVolume, FatError, FatBlockCache, FatImageDevice, fatSplitPath };
}
