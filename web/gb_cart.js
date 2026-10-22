/**
 * Lets the web page control a GB or GBC cartridge.
 *
 * The GBC payload (source/gbc_payload/payload_fast.asm) shows a button menu
 * and also listens to the link cable. When the page sends CMD_ENTER, a small
 * loader in the payload answers, and the page uploads the "cart agent"
 * (source/gbc_payload/agent.asm, built as web/gbc-agent.bin) into the GBC's
 * work RAM. After that the page sends the agent short programs (GbProgram):
 * lists of steps such as "write this byte" or "read these bytes", and the
 * agent sends back the results. Reading the cartridge header and writing
 * flash carts (gb_flash.js) both work this way.
 *
 * ROM dumps, save dumps and save restores don't use the agent. For those the
 * page starts the payload's own transfer code instead (see
 * dump_receiver_fast.js and restore_sender_fast.js).
 *
 * How the link works: the GB-Link drives the serial clock and the GBC
 * follows it, so every byte the page sends swaps with one byte from the GBC.
 * The GB-Link pauses after each byte so the GBC has time to get the next one
 * ready. Every block of data carries a Fletcher checksum, and a block that
 * arrives damaged is sent again.
 */

"use strict";

const GBLINK = {
    CMD_DUMP_ROM: 0xC1, CMD_DUMP_SAVE: 0xC2, CMD_RESTORE: 0xC3,   // same as pressing A, B or SELECT in the menu
    CMD_ENTER: 0xC5, LOADER_TAG: 0x5C, LOADER_GO: 0xA5,
    TAG_READY: 0xA7, TAG_DONE: 0xD7, GO1: 0x5A, GO2: 0x96, ACK_OK: 0x01, NAK: 0x00,
    AGENT_MAX: 0xE00, PROG_MAX: 0xEFF, RESULT_MAX: 0xB00 - 5, FRAME_MAX: 0xB00 - 2,
    AGENT_VERSION: 1,
    CHUNK: 56,              // bytes sent per USB write, so each fits in one 64-byte USB packet
};

const GBOP = {
    END: 0, WR: 1, RD: 2, WAIT: 3, DELAY: 4, TMPL: 5, PROG: 6, CRC: 7, BLANK: 8,
    WRBLK: 9, INFO: 10, EXIT: 11,
    ST_OK: 0, ST_TIMEOUT: 1, ST_BAD: 2,
    // Step kinds for a flash write sequence (tmpl). Bit 0 set: write the byte
    // being programmed instead of a fixed value. Bit 1 set: write it to that
    // byte's own address instead of a fixed address.
    K_ABS_IMM: 0, K_ABS_PD: 1, K_PA_IMM: 2, K_PA_PD: 3,
    TMPL_STEPS: 10,
    NONE: 0xFFFF,
};

class GbLinkError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "GbLinkError";
        this.code = code; // "no-answer", "link", "rejected", "old-agent" or "cancelled"
    }
}

// ---------------------------------------------------------------- programs

/**
 * One program for the agent: a list of steps it runs in order. Each step
 * method returns a handle that GbResult uses to find that step's output.
 */
class GbProgram {
    constructor() {
        this.bytes = [];
        this.ops = 0;
        this.resultBytes = 0;
    }

    get length() { return this.bytes.length; }
    /** How many more program bytes fit, and how many more result bytes. */
    get room() { return GBLINK.PROG_MAX - 1 - this.bytes.length; }
    get resultRoom() { return GBLINK.RESULT_MAX - this.resultBytes; }

    _op(code, args, results = 0) {
        const handle = { index: this.ops, at: this.resultBytes, length: results };
        this.bytes.push(code, ...args);
        this.ops++;
        this.resultBytes += results;
        if (this.bytes.length > GBLINK.PROG_MAX - 1) throw new Error("GB program too large");
        if (this.resultBytes > GBLINK.RESULT_MAX) throw new Error("GB program reads too much");
        return handle;
    }

    static _w(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }

    wr(addr, value) { return this._op(GBOP.WR, [...GbProgram._w(addr), value & 0xFF]); }
    rd(addr, n) { return this._op(GBOP.RD, [...GbProgram._w(addr), ...GbProgram._w(n)], n); }
    /** Keep reading addr until (byte & mask) == value, giving up after ms. */
    wait(addr, mask, value, ms) {
        const t = Math.max(1, Math.min(0xFFFF, Math.ceil(ms / 15.625)));
        return this._op(GBOP.WAIT, [...GbProgram._w(addr), mask & 0xFF, value & 0xFF, ...GbProgram._w(t)], 1);
    }
    delay(ms) { return this._op(GBOP.DELAY, GbProgram._w(ms)); }
    /**
     * Set the write sequence the flash chip needs before each byte is
     * programmed. steps: [{ kind, addr, value }], kind is one of GBOP.K_*.
     */
    tmpl(steps) {
        if (steps.length > GBOP.TMPL_STEPS) throw new Error("Flash write sequence too long");
        const args = [steps.length];
        for (const s of steps) args.push(s.kind, (s.value || 0) & 0xFF, ...GbProgram._w(s.addr || 0));
        return this._op(GBOP.TMPL, args);
    }
    prog(addr, data) { return this._op(GBOP.PROG, [...GbProgram._w(addr), ...GbProgram._w(data.length), ...data], 4); }
    crc(addr, n) { return this._op(GBOP.CRC, [...GbProgram._w(addr), ...GbProgram._w(n)], 4); }
    blank(addr, n) { return this._op(GBOP.BLANK, [...GbProgram._w(addr), ...GbProgram._w(n)], 2); }
    wrblk(addr, data) { return this._op(GBOP.WRBLK, [...GbProgram._w(addr), ...GbProgram._w(data.length), ...data]); }
    info() { return this._op(GBOP.INFO, [], 2); }
    exit() { return this._op(GBOP.EXIT, []); }

    build() {
        if (!this.bytes.length) throw new Error("Empty GB program");
        return Uint8Array.from(this.bytes);
    }
}

class GbResult {
    constructor(status, executed, data) {
        this.status = status;
        this.executed = executed;
        this.data = data;
    }
    get ok() { return this.status === GBOP.ST_OK; }
    ran(handle) { return handle.index < this.executed; }
    bytes(handle) { return this.data.subarray(handle.at, handle.at + handle.length); }
    byte(handle, k = 0) { return this.data[handle.at + k]; }
    word(handle, k = 0) { return this.data[handle.at + k] | (this.data[handle.at + k + 1] << 8); }
    u32(handle) {
        const d = this.data, i = handle.at;
        return (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;
    }
}

function fletcher(bytes, s = [0, 0]) {
    let a = s[0], b = s[1];
    for (let i = 0; i < bytes.length; i++) {
        a = (a + bytes[i]) & 0xFF;
        b = (b + a) & 0xFF;
    }
    return [a, b];
}

// ---------------------------------------------------------------- the client

class GbCartClient {
    /**
     * @param usb  a UsbConnection or SerialConnection
     */
    constructor(usb, log = () => {}) {
        this.usb = usb;
        this.log = log;
        this.cancelled = false;
        this.retries = 0;
    }

    cancel() { this.cancelled = true; }

    _checkCancel() {
        if (this.cancelled) throw new GbLinkError("cancelled", "Cancelled");
    }

    // ------------------------------------------------------------ link

    /** Send bytes over the link and return the bytes the GBC sent back. */
    async xchg(bytes) {
        const tx = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
        const rx = new Uint8Array(tx.length);
        for (let off = 0; off < tx.length; off += GBLINK.CHUNK) {
            const part = tx.subarray(off, Math.min(tx.length, off + GBLINK.CHUNK));
            await this.usb.writeBytes(part);
            let got = 0;
            while (got < part.length) {
                const r = await this.usb.readBytesRaw(part.length - got, 5000);
                if (!r || r.length === 0) {
                    throw new GbLinkError("link", "The GB-Link stopped answering. Unplug it and connect again.");
                }
                rx.set(r.subarray(0, part.length - got), off + got);
                got += r.length;
            }
        }
        return rx;
    }

    /**
     * Wait until the agent signals one of `tags` (for example "ready for a
     * program" or "result waiting"), then answer it so both sides agree what
     * comes next. Returns the tag, or throws if nothing arrives in time.
     */
    async _sync(tags, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            this._checkCancel();
            const r = await this.xchg([0x00, GBLINK.GO1, GBLINK.GO2]);
            if (r[1] === r[2] && tags.includes(r[2])) return r[2];
            if (r[2] === GBLINK.LOADER_TAG && !tags.includes(GBLINK.LOADER_TAG)) {
                return GBLINK.LOADER_TAG;   // the agent has exited and the loader is back
            }
            if (Date.now() > deadline) {
                throw new GbLinkError("no-answer", "The GBC stopped answering.");
            }
        }
    }

    /** Read one block of results from the agent. Returns null if it arrived damaged. */
    async _readFrame() {
        const head = await this.xchg([0, 0]);
        const n = head[0] | (head[1] << 8);
        if (n < 3 || n > GBLINK.FRAME_MAX) return null;
        const body = await this.xchg(new Uint8Array(n + 2));
        const sum = fletcher(body.subarray(0, n), fletcher(head));
        if (sum[0] !== body[n] || sum[1] !== body[n + 1]) return null;
        return new GbResult(body[0], body[1] | (body[2] << 8), body.slice(3, n));
    }

    /** Collect a result the agent is still waiting to deliver, and tell it we got it. */
    async _drain() {
        for (let i = 0; i < 4; i++) {
            const f = await this._readFrame();
            await this.xchg([f ? GBLINK.ACK_OK : GBLINK.NAK]);
            if (f) return f;
            await this._sync([GBLINK.TAG_DONE], 5000);
        }
        throw new GbLinkError("link", "The link to the GBC keeps failing. Check the cable.");
    }

    async _sendProgram(buf) {
        const n = buf.length;
        await this.xchg([n & 0xFF, n >> 8, ~n & 0xFF, (~n >> 8) & 0xFF]);
        const sum = fletcher(buf);
        const out = new Uint8Array(n + 2);
        out.set(buf);
        out[n] = sum[0];
        out[n + 1] = sum[1];
        await this.xchg(out);
    }

    /**
     * Run a program on the agent and return its GbResult. If the program
     * gets damaged on the way there, or the result on the way back, it is
     * sent or read again.
     */
    async run(prog, timeoutMs = 30000) {
        const buf = prog instanceof Uint8Array ? prog : prog.build();
        let tag = await this._sync([GBLINK.TAG_READY, GBLINK.TAG_DONE], 5000);
        let failures = 0;
        for (;;) {
            this._checkCancel();
            if (tag === GBLINK.LOADER_TAG) {
                throw new GbLinkError("no-answer", "The GBC left browser control. Click Read Cartridge to start again.");
            }
            if (tag === GBLINK.TAG_DONE) {
                // The agent still holds an earlier result because our "got it" reply was lost.
                await this._drain();
                tag = await this._sync([GBLINK.TAG_READY, GBLINK.TAG_DONE], 5000);
                continue;
            }
            await this._sendProgram(buf);
            tag = await this._sync([GBLINK.TAG_DONE, GBLINK.TAG_READY], timeoutMs);
            if (tag === GBLINK.TAG_READY) {
                if (++failures > 4) throw new GbLinkError("link", "The GBC keeps rejecting programs. Check the cable.");
                this.retries++;
                continue;
            }
            for (let i = 0; ; i++) {
                const f = await this._readFrame();
                if (f) {
                    await this.xchg([GBLINK.ACK_OK]);
                    if (f.status === GBOP.ST_BAD) {
                        throw new GbLinkError("rejected", `The GBC refused operation ${f.executed + 1} of the program.`);
                    }
                    return f;
                }
                if (i >= 4) throw new GbLinkError("link", "Results from the GBC keep arriving damaged. Check the cable.");
                this.retries++;
                await this.xchg([GBLINK.NAK]);
                await this._sync([GBLINK.TAG_DONE], 5000);
            }
        }
    }

    // ------------------------------------------------------------ session

    /**
     * Take control of the payload. Wakes its loader and uploads the agent,
     * or reuses an agent that is already running from an earlier session.
     */
    async connect(agent, timeoutMs = 5000) {
        this.cancelled = false;
        if (agent.length > GBLINK.AGENT_MAX) throw new Error("Cart agent too large");
        const deadline = Date.now() + timeoutMs;
        let uploads = 0;
        const seen = new Map();     // bytes the GBA sent back, listed in the error message
        for (;;) {
            this._checkCancel();
            const r = await this.xchg(new Uint8Array(8).fill(GBLINK.CMD_ENTER));
            for (const b of r) seen.set(b, (seen.get(b) || 0) + 1);
            const last = r[7];
            if (last === GBLINK.TAG_READY && r[6] === GBLINK.TAG_READY) {
                const res = await this.run(this._infoProgram());
                if (res.byte(this._infoHandle) === GBLINK.AGENT_VERSION) return { adopted: true };
                const p = new GbProgram();
                p.exit();
                await this.run(p);
                continue;
            }
            if (last === GBLINK.TAG_DONE && r[6] === GBLINK.TAG_DONE) {
                await this._sync([GBLINK.TAG_DONE], 2000);
                await this._drain();
                continue;
            }
            if (last === GBLINK.LOADER_TAG && r[6] === GBLINK.LOADER_TAG) {
                if (++uploads > 3) throw new GbLinkError("link", "Uploading to the GBC keeps failing. Make sure the cartridge is inserted, and check the cable.");
                await this._upload(agent);
                const tag = await this._sync([GBLINK.TAG_READY, GBLINK.LOADER_TAG], 3000).catch(() => null);
                if (tag === GBLINK.TAG_READY) {
                    // The agent is running. Give it a harmless program first so it
                    // has no stale state when the real work starts.
                    await this._sendProgram(this._infoProgram().build());
                    await this._sync([GBLINK.TAG_DONE], 3000);
                    const f = await this._drain();
                    if (f.data[0] !== GBLINK.AGENT_VERSION) throw new GbLinkError("old-agent", "The cart agent didn't start.");
                    return { adopted: false };
                }
                continue;
            }
            if (Date.now() > deadline) {
                const answers = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
                    .map(([v, n]) => `${v.toString(16).toUpperCase().padStart(2, "0")}×${n}`).join(", ");
                throw new GbLinkError("no-answer",
                    "The GBA isn't answering. Send the multiboot again and wait for the GBA to switch to GBC mode " +
                    `(an older homebrew can't be controlled from the browser). The GBA answered: ${answers}.`);
            }
        }
    }

    _infoProgram() {
        const p = new GbProgram();
        this._infoHandle = p.info();
        return p;
    }

    async _upload(agent) {
        const r = await this.xchg([GBLINK.LOADER_GO]);
        if (r[0] !== GBLINK.LOADER_TAG) return;
        const n = agent.length;
        await this.xchg([n & 0xFF, n >> 8, ~n & 0xFF, (~n >> 8) & 0xFF]);
        const sum = fletcher(agent);
        const out = new Uint8Array(n + 2);
        out.set(agent);
        out[n] = sum[0];
        out[n + 1] = sum[1];
        await this.xchg(out);
    }

    /** Hand the GBA back to its button menu. */
    async disconnect() {
        const p = new GbProgram();
        p.exit();
        await this.run(p);
    }
}

// ---------------------------------------------------------------- cartridges

const GB_ROM_BANKS = { 0x52: 72, 0x53: 80, 0x54: 96 };
const GB_RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

const GB_CART_TYPES = {
    0x00: "ROM only", 0x01: "MBC1", 0x02: "MBC1+RAM", 0x03: "MBC1+RAM+BATTERY",
    0x05: "MBC2", 0x06: "MBC2+BATTERY", 0x08: "ROM+RAM", 0x09: "ROM+RAM+BATTERY",
    0x0B: "MMM01", 0x0C: "MMM01+RAM", 0x0D: "MMM01+RAM+BATTERY",
    0x0F: "MBC3+TIMER+BATTERY", 0x10: "MBC3+TIMER+RAM+BATTERY", 0x11: "MBC3",
    0x12: "MBC3+RAM", 0x13: "MBC3+RAM+BATTERY",
    0x19: "MBC5", 0x1A: "MBC5+RAM", 0x1B: "MBC5+RAM+BATTERY", 0x1C: "MBC5+RUMBLE",
    0x1D: "MBC5+RUMBLE+RAM", 0x1E: "MBC5+RUMBLE+RAM+BATTERY",
    0x20: "MBC6", 0x22: "MBC7", 0xFC: "Pocket Camera", 0xFD: "TAMA5", 0xFE: "HuC3", 0xFF: "HuC1",
};

/** Decode a GB/GBC cartridge header from the 0x50 bytes starting at $0100. */
function parseGbHeader(h) {
    let sum = 0;
    for (let i = 0x34; i <= 0x4C; i++) sum = (sum - h[i] - 1) & 0xFF;
    const cgb = h[0x43] & 0x80;
    const titleBytes = h.subarray(0x34, cgb ? 0x43 : 0x44);
    let title = "";
    for (const b of titleBytes) {
        if (b === 0) break;
        title += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : "";
    }
    const type = h[0x47];
    const romCode = h[0x48];
    const banks = romCode <= 8 ? 2 << romCode : (GB_ROM_BANKS[romCode] || 0);
    let ramSize = GB_RAM_SIZES[h[0x49]] || 0;
    if (type === 0x05 || type === 0x06) ramSize = 0x200;
    const hasRam = [0x02, 0x03, 0x06, 0x08, 0x09, 0x0C, 0x0D, 0x10, 0x12, 0x13, 0x1A, 0x1B, 0x1D, 0x1E, 0xFC, 0xFE, 0xFF].includes(type) ||
        type === 0x05;
    return {
        title: title.trim(),
        cgb: cgb ? (h[0x43] === 0xC0 ? "only" : "yes") : "no",
        type, typeName: GB_CART_TYPES[type] || `unknown (0x${type.toString(16).toUpperCase().padStart(2, "0")})`,
        romBanks: banks, romSize: banks * 0x4000,
        ramSize: hasRam ? ramSize : 0,
        headerOk: sum === h[0x4D],
        rumble: type >= 0x1C && type <= 0x1E,
    };
}

/** Reads the cartridge header through a connected GbCartClient. */
class GbCart {
    constructor(client, log = () => {}) {
        this.client = client;
        this.log = log;
        this.header = null;
    }

    async readHeader() {
        const p = new GbProgram();
        p.wr(0x0000, 0x00);
        p.wr(0x6000, 0x00);
        const h = p.rd(0x0100, 0x50);
        const r = await this.client.run(p);
        const raw = r.bytes(h);
        this.header = parseGbHeader(raw);
        this.header.raw = raw;
        return this.header;
    }
}

const GB_CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
        t[i] = c >>> 0;
    }
    return t;
})();

function gbCrc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = GB_CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

if (typeof window !== "undefined") {
    Object.assign(window, { GbCartClient, GbCart, GbProgram, GbResult, GbLinkError, GBLINK, GBOP, parseGbHeader, gbCrc32 });
}
if (typeof module !== "undefined" && module.exports) {
    module.exports = { GbCartClient, GbCart, GbProgram, GbResult, GbLinkError, GBLINK, GBOP, parseGbHeader, gbCrc32, fletcher };
}
