/**
 * Talks to the GBA cart dumper (web/gba-cart-dumper_mb.gba, source in
 * source/gba_cart_dumper/) once it is running on the GBA. The dumper is a
 * port of FIX94's GBA Link Cable Dumper that uses the normal 32-bit link
 * cable mode instead of the GameCube port. The GB-Link stays in the same
 * mode and timing it used to send the dumper (36 µs between words, 4 bytes
 * per word) at the GBA's own 3.3 V; the 5 V needed for GBC carts doesn't
 * apply here.
 *
 * Every transfer swaps one 32-bit word each way: we send a word and get back
 * whatever the GBA had loaded into its serial register beforehand. While the
 * GBA is busy with the cartridge it loads nothing, and we read 0xFFFFFFFF.
 *
 * Slow jobs (probing the cart, reading the save) end with the GBA repeating
 * G_DONE until we answer M_CONT. That way a word that got cut in half while
 * the GBA was loading it can never move things along by mistake.
 *
 * Bulk data moves in 256-byte sections. Each ends with an XOR checksum, then
 * one more exchange to say whether it arrived intact; a bad section is sent
 * again. ROM dumps use a faster stream of records instead (_streamRecords).
 */

"use strict";

// Words starting M_ are sent by the page; words starting G_ are the GBA's
// answers. Most of them spell something in ASCII ("REDY", "DONE", "OKOK").
const GBA_CART = {
    M_MAGIC: 0x47420000,
    M_POLL: 0x00000000,
    M_GO: 0x4742600D,
    M_CONT: 0x4742C047,
    M_FAIL: 0x4742BAD0,
    M_ABORT: 0x4742AB0B,

    G_READY: 0x52454459,
    G_DONE: 0x444F4E45,
    G_OKOK: 0x4F4B4F4B,
    G_FAIL: 0x4641494C,
    BUSY: 0xFFFFFFFF,

    // ROM dump stream: the GBA sends records tagged R_DATA (one section),
    // R_FILL (a run of sections that repeat one word) or R_END. M_SEEK asks
    // it to restart from a given section. See streamRom in main.c.
    M_SPOLL: 0x47425EED,
    M_FIN: 0x4742F1A1,
    M_SEEK: 0x53000000,
    R_DATA: 0xDA,
    R_FILL: 0xF1,
    R_END: 0xE0,
    G_SYNC: 0x53594E43,

    CMD_DUMP_ROM: 1,
    CMD_DUMP_SAVE: 2,
    CMD_RESTORE: 3,
    CMD_ERASE: 4,
    CMD_DUMP_BIOS: 5,
    CMD_INFO: 6,
    CMD_CART_RUN: 7,

    SECTION_BYTES: 0x100,
    SECTION_WORDS: 0x40,
    BIOS_BYTES: 0x4000,
    RUN_MAX_BYTES: 0x20000,    // largest cart op program the GBA can hold
    RUN_RESULT_BYTES: 0x4000,  // largest result it can send back
};

// Most words per USB write: 14 × 4 = 56 bytes, as in multiboot.js. That stays
// under the 64-byte USB packet limit on both WebUSB and WebSerial.
const GBA_BATCH_WORDS = 14;

class GbaCartError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "GbaCartError";
        this.code = code; // timeout | no-cart | no-save | size-mismatch |
                          // desync | checksum | cancelled | link
    }
}

class GbaCartClient {
    constructor(usb, log = console.log) {
        this.usb = usb;
        this.log = log;
        this.cancelRequested = false;
    }

    cancel() {
        this.cancelRequested = true;
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _echoWord(cmd) {
        return (~(GBA_CART.M_MAGIC | cmd)) >>> 0;
    }

    _checkCancel() {
        if (this.cancelRequested) throw new GbaCartError("cancelled", "Cancelled");
    }

    /**
     * Send a list of words and return the GBA's reply to each. Each USB write
     * of up to 14 words is followed by reading back the same number of bytes.
     */
    async _xferBatch(words) {
        const results = [];
        for (let i = 0; i < words.length; i += GBA_BATCH_WORDS) {
            const chunk = words.slice(i, i + GBA_BATCH_WORDS);
            const tx = new Uint8Array(chunk.length * 4);
            for (let w = 0; w < chunk.length; w++) {
                const val = chunk[w];
                tx[w * 4] = (val >>> 24) & 0xFF;
                tx[w * 4 + 1] = (val >>> 16) & 0xFF;
                tx[w * 4 + 2] = (val >>> 8) & 0xFF;
                tx[w * 4 + 3] = val & 0xFF;
            }
            await this.usb.writeBytes(tx);

            // The reply can arrive split over several USB packets, so keep
            // reading until it is all here.
            const expected = chunk.length * 4;
            const rx = new Uint8Array(expected);
            let got = 0;
            while (got < expected) {
                const part = await this.usb.readBytesRaw(expected - got, 3000);
                if (!part || part.length === 0) {
                    throw new GbaCartError("link", "USB read timeout — link lost?");
                }
                rx.set(part.subarray(0, Math.min(part.length, expected - got)), got);
                got += part.length;
            }
            for (let w = 0; w < chunk.length; w++) {
                results.push(((rx[w * 4] << 24) | (rx[w * 4 + 1] << 16) |
                    (rx[w * 4 + 2] << 8) | rx[w * 4 + 3]) >>> 0);
            }
        }
        return results;
    }

    async _xfer(word) {
        const r = await this._xferBatch([word]);
        return r[0];
    }

    /**
     * Poll until the GBA says it is idle and ready (G_READY). This works from
     * any leftover state: if the GBA is stuck repeating G_DONE we send
     * M_ABORT, and if it was left halfway through sending a section it
     * finishes within about 66 polls, sees a poll where it expected our
     * answer, and gives up on its own.
     */
    async _pollReady(timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            this._checkCancel();
            const w = await this._xfer(GBA_CART.M_POLL);
            if (w === GBA_CART.G_READY) return;
            if (w === GBA_CART.G_DONE) await this._xfer(GBA_CART.M_ABORT);
            await this._delay(25);
        }
        throw new GbaCartError("timeout",
            "GBA dumper not responding. Is the payload running and the cable connected?");
    }

    /**
     * Send a command and make sure the GBA got it. The reply to the command
     * word must be G_READY, which shows the GBA was listening. The reply to
     * the following M_GO must be the command word with every bit flipped,
     * which shows it read the right command. The GBA only starts on M_GO.
     */
    async _command(cmd, readyTimeoutMs = 10000) {
        for (let attempt = 0; attempt < 5; attempt++) {
            this._checkCancel();
            await this._pollReady(readyTimeoutMs);
            const r1 = await this._xfer((GBA_CART.M_MAGIC | cmd) >>> 0);
            if (r1 !== GBA_CART.G_READY) continue;
            const r2 = await this._xfer(GBA_CART.M_GO);
            if (r2 === this._echoWord(cmd)) return;
            // Wrong reply: the GBA missed the command or got a garbled copy,
            // ignored our M_GO and is idle again. Just try again.
        }
        throw new GbaCartError("desync", "Command handshake failed after retries");
    }

    /**
     * Wait for a slow job on the GBA to finish (probing the cart, reading or
     * writing the save). The GBA reads as busy until it starts repeating
     * G_DONE; we answer M_CONT, which tells it to carry on with the next step.
     */
    async _waitDone(timeoutMs, onWait) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            this._checkCancel();
            const w = await this._xfer(GBA_CART.M_POLL);
            if (w === GBA_CART.G_DONE) {
                await this._xfer(GBA_CART.M_CONT);
                return;
            }
            if (w === GBA_CART.G_READY) {
                throw new GbaCartError("desync",
                    "Payload returned to idle mid-operation");
            }
            if (onWait) onWait(Date.now() - started);
            await this._delay(200);
        }
        throw new GbaCartError("timeout", "Timed out waiting for the GBA");
    }

    /** Read `count` words from the GBA by sending that many polls. */
    async _readWords(count) {
        return this._xferBatch(new Array(count).fill(GBA_CART.M_POLL));
    }

    /**
     * Receive `totalBytes` (a multiple of 256) from the GBA. Each section is
     * 64 data words and an XOR checksum, then we answer M_CONT if it checked
     * out or M_FAIL to have it sent again. The GBA stops as soon as it sees
     * M_ABORT, so cancelling takes effect right away.
     */
    async _streamIn(totalBytes, onProgress) {
        const out = new Uint8Array(totalBytes);
        const dv = new DataView(out.buffer);
        const sections = totalBytes / GBA_CART.SECTION_BYTES;
        const sectionTx = new Array(GBA_CART.SECTION_WORDS + 1).fill(GBA_CART.M_POLL);
        let retries = 0;

        for (let s = 0; s < sections;) {
            if (this.cancelRequested) {
                await this._xfer(GBA_CART.M_ABORT);
                throw new GbaCartError("cancelled", "Cancelled");
            }
            const resp = await this._xferBatch(sectionTx);
            let xsum = 0;
            const base = s * GBA_CART.SECTION_BYTES;
            for (let w = 0; w < GBA_CART.SECTION_WORDS; w++) {
                xsum = (xsum ^ resp[w]) >>> 0;
            }
            if (xsum === resp[GBA_CART.SECTION_WORDS]) {
                for (let w = 0; w < GBA_CART.SECTION_WORDS; w++) {
                    dv.setUint32(base + w * 4, resp[w], true);
                }
                await this._xfer(GBA_CART.M_CONT);
                s++;
                retries = 0;
                if (onProgress) onProgress(base + GBA_CART.SECTION_BYTES, totalBytes);
            } else {
                retries++;
                if (retries > 50) {
                    await this._xfer(GBA_CART.M_ABORT);
                    throw new GbaCartError("checksum",
                        `Section ${s} failed checksum ${retries} times — aborting`);
                }
                await this._xfer(GBA_CART.M_FAIL);
            }
        }
        return out;
    }

    /**
     * Receive a ROM dump. The GBA sends `totalBytes` as 256-byte sections
     * without waiting for us: each one as a data record, or a run of sections
     * that repeat one word as a single fill record. We take records strictly
     * in order. When one is bad or missing, the next batch starts with
     * M_SEEK to send the GBA back to the first section we still need, and we
     * skip everything until that section's record arrives.
     */
    async _streamRecords(totalBytes, onProgress) {
        const C = GBA_CART;
        const sections = totalBytes / C.SECTION_BYTES;
        const out = new Uint8Array(totalBytes);
        const dv = new DataView(out.buffer);
        const rotl1 = (c) => ((c << 1) | (c >>> 31)) >>> 0;
        let next = 0;      // first section we don't have yet
        let rec = null;    // record being collected: { header, words, need }
        let seek = false;  // start the next batch with M_SEEK | next
        let failures = 0;  // bad records since the last good one

        const fail = () => {
            rec = null;
            seek = true;
            failures++;
        };
        const accept = (header, words) => {
            let c = header;
            for (let i = 0; i < words.length - 1; i++) c = (rotl1(c) ^ words[i]) >>> 0;
            if (c !== words[words.length - 1]) return false;
            const base = next * C.SECTION_BYTES;
            if ((header >>> 24) === C.R_DATA) {
                for (let w = 0; w < C.SECTION_WORDS; w++) dv.setUint32(base + w * 4, words[w], true);
                next++;
            } else {
                const [value, count] = words;
                if (count === 0 || count > sections - next) return false;
                for (let off = base; off < base + count * C.SECTION_BYTES; off += 4) {
                    dv.setUint32(off, value, true);
                }
                next += count;
            }
            failures = 0;
            if (onProgress) onProgress(next * C.SECTION_BYTES, totalBytes);
            return true;
        };

        while (true) {
            if (this.cancelRequested) {
                await this._xfer(C.M_ABORT);
                throw new GbaCartError("cancelled", "Cancelled");
            }
            if (failures > 50) {
                await this._xfer(C.M_ABORT);
                if (next === 0) {
                    throw new GbaCartError("desync",
                        "The GBA did not answer the ROM dump handshake");
                }
                throw new GbaCartError("checksum",
                    `ROM section ${next} failed ${failures} times — aborting`);
            }
            const tx = new Array(GBA_BATCH_WORDS).fill(C.M_SPOLL);
            let first = 0;
            if (seek) {
                // The reply to the seek word itself still comes from the old
                // position, so skip it.
                tx[0] = (C.M_SEEK | next) >>> 0;
                first = 1;
                seek = false;
            }
            const rx = await this._xferBatch(tx);
            for (let i = first; i < rx.length && !seek; i++) {
                const w = rx[i];
                if (rec) {
                    rec.words.push(w);
                    if (rec.words.length === rec.need) {
                        const ok = accept(rec.header, rec.words);
                        rec = null;
                        if (!ok) fail();
                    }
                    continue;
                }
                const tag = w >>> 24, index = w & 0xFFFFFF;
                if (tag === C.R_DATA && index === next) {
                    rec = { header: w, words: [], need: C.SECTION_WORDS + 1 };
                } else if (tag === C.R_FILL && index === next) {
                    rec = { header: w, words: [], need: 3 };
                } else if (tag === C.R_END && index === sections && next === sections) {
                    await this._xfer(C.M_FIN);
                    return out;
                } else {
                    fail();
                }
            }
        }
    }

    /**
     * Send `data` (a multiple of 256 bytes) to the GBA. Each section is 64
     * data words and our XOR checksum. One more exchange follows: we send
     * M_CONT (or M_ABORT to cancel) and get back G_OKOK if the section
     * arrived intact or G_FAIL if it needs sending again.
     */
    async _streamOut(data, onProgress) {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const sections = data.length / GBA_CART.SECTION_BYTES;
        let retries = 0;

        for (let s = 0; s < sections;) {
            const base = s * GBA_CART.SECTION_BYTES;
            const tx = new Array(GBA_CART.SECTION_WORDS + 1);
            let xsum = 0;
            for (let w = 0; w < GBA_CART.SECTION_WORDS; w++) {
                const v = dv.getUint32(base + w * 4, true);
                tx[w] = v;
                xsum = (xsum ^ v) >>> 0;
            }
            tx[GBA_CART.SECTION_WORDS] = xsum;
            await this._xferBatch(tx);

            const ackWord = this.cancelRequested ? GBA_CART.M_ABORT : GBA_CART.M_CONT;
            const verdict = await this._xfer(ackWord);
            if (this.cancelRequested) throw new GbaCartError("cancelled", "Cancelled");

            if (verdict === GBA_CART.G_OKOK) {
                s++;
                retries = 0;
                if (onProgress) onProgress(base + GBA_CART.SECTION_BYTES, data.length);
            } else if (verdict === GBA_CART.G_FAIL) {
                retries++;
                if (retries > 8) {
                    throw new GbaCartError("checksum",
                        `Section ${s} rejected ${retries} times — aborting restore`);
                }
            } else {
                throw new GbaCartError("desync",
                    `Unexpected restore verdict 0x${verdict.toString(16)}`);
            }
        }
    }

    /** True if the GBA dumper answers as idle within timeoutMs. */
    async ping(timeoutMs = 3000) {
        try {
            await this._pollReady(timeoutMs);
            return true;
        } catch (e) {
            if (e.code === "cancelled") throw e;
            return false;
        }
    }

    /**
     * Read the cartridge's ROM and save sizes and its 0xC0-byte header.
     * Returns { noCart } or { gamesize, savesize, title, code, maker, header }.
     */
    async readInfo() {
        await this._command(GBA_CART.CMD_INFO);
        await this._waitDone(60000); // ROM size scan, and EEPROM size if there is one
        const sizes = await this._readWords(2);
        const gamesize = sizes[0], savesize = sizes[1];
        if (gamesize === 0xFFFFFFFF) return { noCart: true };

        const hdrWords = await this._readWords(0xC0 / 4);
        const header = new Uint8Array(0xC0);
        const hv = new DataView(header.buffer);
        for (let w = 0; w < hdrWords.length; w++) hv.setUint32(w * 4, hdrWords[w], true);

        const ascii = (from, len) => {
            let sName = "";
            for (let i = from; i < from + len; i++) {
                const ch = header[i];
                if (ch === 0) break;
                sName += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : "_";
            }
            return sName.trim();
        };
        return {
            noCart: false,
            gamesize,
            savesize,
            title: ascii(0xA0, 12),
            code: ascii(0xAC, 4),
            maker: ascii(0xB0, 2),
            header,
        };
    }

    /** Dump the full cartridge ROM. Returns { data, gamesize }. */
    async dumpRom(onProgress) {
        await this._command(GBA_CART.CMD_DUMP_ROM);
        await this._waitDone(60000); // ROM size, and a scan for runs of repeated data
        const sizes = await this._readWords(1);
        const gamesize = sizes[0];
        if (gamesize === 0xFFFFFFFF) {
            throw new GbaCartError("no-cart", "No GBA cartridge detected");
        }
        const data = await this._streamRecords(gamesize, onProgress);
        return { data, gamesize };
    }

    /** Dump the cartridge save. Returns { data, savesize }. */
    async dumpSave(onProgress) {
        await this._command(GBA_CART.CMD_DUMP_SAVE);
        await this._waitDone(60000); // sizes, which can mean reading an EEPROM
        const sizes = await this._readWords(2);
        if (sizes[0] === 0xFFFFFFFF) {
            throw new GbaCartError("no-cart", "No GBA cartridge detected");
        }
        const savesize = sizes[1];
        if (savesize === 0) {
            throw new GbaCartError("no-save", "This cartridge has no save memory");
        }
        await this._waitDone(120000); // the GBA copies the save into its RAM
        const data = await this._streamIn(savesize, onProgress);
        return { data, savesize };
    }

    /**
     * Write `data` into the cartridge save memory. Refused unless data.length
     * exactly matches the detected save size.
     */
    async restoreSave(data, onProgress) {
        await this._command(GBA_CART.CMD_RESTORE);
        await this._waitDone(60000);
        const sizes = await this._readWords(2);
        if (sizes[0] === 0xFFFFFFFF) {
            throw new GbaCartError("no-cart", "No GBA cartridge detected");
        }
        const savesize = sizes[1];
        if (savesize === 0) {
            throw new GbaCartError("no-save", "This cartridge has no save memory");
        }
        if (data.length !== savesize) {
            // The GBA is waiting for M_GO. Anything else sends it back to
            // idle without touching the cart.
            await this._xfer(GBA_CART.M_ABORT);
            throw new GbaCartError("size-mismatch",
                `Save file is ${data.length} bytes but the cart expects ${savesize}`);
        }
        await this._xfer(GBA_CART.M_GO);
        await this._streamOut(data, onProgress);
        // EEPROM writes take seconds; erasing and writing a 128 KB flash save
        // can take a minute or more.
        await this._waitDone(180000);
        return { savesize };
    }

    /** Zero-fill the cartridge save memory. Returns { savesize }. */
    async eraseSave() {
        await this._command(GBA_CART.CMD_ERASE);
        await this._waitDone(60000);
        const sizes = await this._readWords(2);
        if (sizes[0] === 0xFFFFFFFF) {
            throw new GbaCartError("no-cart", "No GBA cartridge detected");
        }
        const savesize = sizes[1];
        if (savesize === 0) {
            throw new GbaCartError("no-save", "This cartridge has no save memory");
        }
        await this._xfer(GBA_CART.M_GO);
        await this._waitDone(180000);
        return { savesize };
    }

    /**
     * Run a cart op program on the GBA: a list of cartridge reads and writes
     * built by web/gba_flash.js and carried out by cartops.c on the GBA.
     * `buf` is a multiple of 256 bytes. We send its length followed by the
     * length with every bit flipped, and the GBA echoes the length back if
     * both agree. Then the program goes over in checksummed sections, the
     * GBA runs it, and the result words come back as a Uint32Array.
     */
    async runOps(buf, timeoutMs = 60000, onWait) {
        const len = buf.length;
        if (len === 0 || len % GBA_CART.SECTION_BYTES || len > GBA_CART.RUN_MAX_BYTES) {
            throw new GbaCartError("link", `Bad cart op buffer size ${len}`);
        }
        await this._command(GBA_CART.CMD_CART_RUN);
        const echo = await this._xferBatch([len, (~len) >>> 0]);
        if (echo[1] !== len) {
            throw new GbaCartError("desync", "The GBA did not take the cart op program");
        }
        await this._streamOut(buf);
        await this._waitDone(timeoutMs, onWait);
        const [bytes] = await this._readWords(1);
        if (bytes === 0 || bytes % GBA_CART.SECTION_BYTES || bytes > GBA_CART.RUN_RESULT_BYTES) {
            throw new GbaCartError("desync", `Bad cart op result size ${bytes}`);
        }
        const out = await this._streamIn(bytes);
        const dv = new DataView(out.buffer);
        const words = new Uint32Array(bytes / 4);
        for (let i = 0; i < words.length; i++) words[i] = dv.getUint32(i * 4, true);
        return words;
    }

    /** Dump the 16 KB GBA BIOS (no cartridge needed). Returns { data }. */
    async dumpBios(onProgress) {
        await this._command(GBA_CART.CMD_DUMP_BIOS);
        await this._waitDone(30000); // the GBA copies the BIOS into RAM first
        const data = await this._streamIn(GBA_CART.BIOS_BYTES, onProgress);
        return { data };
    }
}

if (typeof window !== "undefined") {
    window.GbaCartClient = GbaCartClient;
    window.GbaCartError = GbaCartError;
    window.GBA_CART = GBA_CART;
}
if (typeof module !== "undefined" && module.exports) {
    module.exports = { GbaCartClient, GbaCartError, GBA_CART, GBA_BATCH_WORDS };
}
