/**
 * GBA cartridge protocol driver for GBLink Cart Doctor.
 *
 * Host side of the SIO32 protocol spoken by web/gba-cart-dumper_mb.gba
 * (source/gba_cart_dumper/) — a port of FIX94's GBA Link Cable Dumper whose
 * JOY-bus link is replaced with 32-bit normal-mode SIO. The firmware stays in
 * GB_LINK mode with the multiboot timing config (36 µs between words, 4 bytes
 * per transfer) and 3.3V — the GBA-native serial level; the 5V requirement of
 * the GBC-mode dump does not apply here.
 *
 * Every transaction is one full-duplex 32-bit exchange: we send a word, we
 * receive whatever the payload had pre-armed. While the payload is busy with
 * the cartridge it is un-armed and we read a constant 0xFFFFFFFF ("busy").
 * Slow phases end with a DONE gate (payload re-arms G_DONE until it receives
 * M_CONT) so a word torn by arming mid-clock can never advance the protocol.
 * Bulk data moves in 256-byte sections, each closed by an XOR32 checksum and
 * a verdict exchange; bad sections are re-sent.
 */

"use strict";

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

    CMD_DUMP_ROM: 1,
    CMD_DUMP_SAVE: 2,
    CMD_RESTORE: 3,
    CMD_ERASE: 4,
    CMD_DUMP_BIOS: 5,
    CMD_INFO: 6,

    SECTION_BYTES: 0x100,
    SECTION_WORDS: 0x40,
    BIOS_BYTES: 0x4000,
};

// Max words per USB write: 14 × 4 = 56 bytes, same convention as multiboot.js
// (below the 64-byte endpoint/frame cap on both WebUSB and WebSerial).
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
     * Exchange a batch of 32-bit words (lockstep: one USB write, then read
     * back exactly as many response bytes). Splits into 14-word USB writes.
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

            // The firmware answers each write with the same number of bytes,
            // possibly split across USB packets/frames — accumulate.
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
     * Hunt for the idle payload. Sends polls until G_READY comes back.
     * Converges from any stale state: a stuck DONE gate is kicked with
     * M_ABORT, and a payload abandoned mid-stream runs out of its section
     * within ~66 polls and aborts itself on the unexpected verdict word.
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
     * Deliver a command with the echo-confirm handshake. The response to the
     * command word must be G_READY (proves the payload was armed and received
     * it); the response to M_GO must be the bitwise-NOT echo (proves it
     * decoded the right command). Payload acts only on M_GO.
     */
    async _command(cmd, readyTimeoutMs = 10000) {
        for (let attempt = 0; attempt < 5; attempt++) {
            this._checkCancel();
            await this._pollReady(readyTimeoutMs);
            const r1 = await this._xfer((GBA_CART.M_MAGIC | cmd) >>> 0);
            if (r1 !== GBA_CART.G_READY) continue;
            const r2 = await this._xfer(GBA_CART.M_GO);
            if (r2 === this._echoWord(cmd)) return;
            // Wrong echo: the payload never saw the command (or saw a torn
            // word) — our M_GO read as a stray control word and it is idle
            // again. Just retry.
        }
        throw new GbaCartError("desync", "Command handshake failed after retries");
    }

    /**
     * Wait out a slow payload phase (cart probe, save read, save write...).
     * The payload is un-armed (busy) until it opens the DONE gate; we
     * acknowledge with M_CONT which is its cue to start the next lockstep
     * phase.
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

    /** Read `count` payload-armed words by clocking polls. */
    async _readWords(count) {
        return this._xferBatch(new Array(count).fill(GBA_CART.M_POLL));
    }

    /**
     * Receive `totalBytes` (multiple of 256) from the payload. Per section:
     * 64 data words + XOR32, then our verdict (M_CONT/M_FAIL). The payload
     * checks every received word for M_ABORT, so cancel is immediate.
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
     * Send `data` (length multiple of 256) to the payload. Per section: 64
     * data words + our XOR32, then one ack exchange that simultaneously
     * returns the payload's verdict (G_OKOK/G_FAIL) and carries our M_CONT
     * ("proceed per your verdict") or M_ABORT.
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

    /** True if the payload answers from its idle loop within timeoutMs. */
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
     * Probe the cartridge: sizes + the 0xC0-byte header. Returns
     * { noCart } or { gamesize, savesize, title, code, maker, header }.
     */
    async readInfo() {
        await this._command(GBA_CART.CMD_INFO);
        await this._waitDone(60000); // full ROM scan + possible EEPROM probe
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
        await this._waitDone(30000); // ROM size probe
        const sizes = await this._readWords(1);
        const gamesize = sizes[0];
        if (gamesize === 0xFFFFFFFF) {
            throw new GbaCartError("no-cart", "No GBA cartridge detected");
        }
        const data = await this._streamIn(gamesize, onProgress);
        return { data, gamesize };
    }

    /** Dump the cartridge save. Returns { data, savesize }. */
    async dumpSave(onProgress) {
        await this._command(GBA_CART.CMD_DUMP_SAVE);
        await this._waitDone(60000); // size probe incl. possible EEPROM read
        const sizes = await this._readWords(2);
        if (sizes[0] === 0xFFFFFFFF) {
            throw new GbaCartError("no-cart", "No GBA cartridge detected");
        }
        const savesize = sizes[1];
        if (savesize === 0) {
            throw new GbaCartError("no-save", "This cartridge has no save memory");
        }
        await this._waitDone(120000); // payload reads the save into RAM
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
            // GO slot: anything but M_GO sends the payload back to idle
            // without touching the cart.
            await this._xfer(GBA_CART.M_ABORT);
            throw new GbaCartError("size-mismatch",
                `Save file is ${data.length} bytes but the cart expects ${savesize}`);
        }
        await this._xfer(GBA_CART.M_GO);
        await this._streamOut(data, onProgress);
        // EEPROM writes take seconds; a 128KB flash chip-erase + program can
        // take a minute or more.
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

    /** Dump the 16 KB GBA BIOS (no cartridge needed). Returns { data }. */
    async dumpBios(onProgress) {
        await this._command(GBA_CART.CMD_DUMP_BIOS);
        await this._waitDone(30000); // payload buffers the BIOS first
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
