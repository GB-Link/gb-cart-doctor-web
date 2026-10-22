/**
 * Tests the link protocol between the page and the GBA cart dumper, one
 * 32-bit word at a time, without hardware.
 *
 * The page's real code (web/gba_cart.js) talks to a JavaScript model of the
 * dumper that follows source/gba_cart_dumper/source/main.c step by step.
 * Between them sits a pretend GB-Link that behaves like the firmware: each
 * word sent swaps one word back, a USB write carries at most 64 bytes, and
 * if the GBA isn't ready for a word, it reads back as 0xFFFFFFFF and the
 * page's word is lost.
 *
 * Run:  node web/test/gba_protocol_sim.mjs
 */

import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { GbaCartClient, GBA_CART: C } = require("../gba_cart.js");

// ---------------------------------------------------------------------------
// Model of the dumper. Keep it in step with main.c.
// ---------------------------------------------------------------------------

const BUSY_WORD = 0xFFFFFFFF;

// The model is a generator: each yield is the word the GBA has ready for the
// next exchange, and the value it gets back is the word the page sent.
// Yielding { busy: n } means the GBA is busy and misses the next n words.

// Repeat the "done" word until the page says continue or abort.
function* doneGate() {
    while (true) {
        const rx = yield C.G_DONE;
        if (rx === C.M_CONT) return true;
        if (rx === C.M_ABORT) return false;
    }
}

// Send sections of 64 words plus an XOR check word. The page then answers
// whether to move on or send the section again.
function* streamToMaster(words) {
    let off = 0;
    while (off < words.length) {
        let x = 0;
        for (let w = 0; w < 64; w++) {
            x = (x ^ words[off + w]) >>> 0;
            const rx = yield words[off + w] >>> 0;
            if (rx === C.M_ABORT) return false;
        }
        yield x;
        const verdict = yield 0;
        if (verdict === C.M_CONT) off += 64;
        else if (verdict !== C.M_FAIL) return false;
    }
    return true;
}

// Runs of sections that are 64 copies of one word (findFillRuns in main.c).
function fillRuns(words) {
    const runs = [];
    for (let s = 0; s < words.length / 64; s++) {
        const v = words[s * 64];
        let w = 1;
        while (w < 64 && words[s * 64 + w] === v) w++;
        if (w < 64) continue;
        const last = runs[runs.length - 1];
        if (last && last.value === v && last.start + last.count === s) last.count++;
        else runs.push({ start: s, count: 1, value: v });
    }
    return runs;
}

const rotl1 = (c) => ((c << 1) | (c >>> 31)) >>> 0;

// Send the ROM as records: a data section, a fill run, and finally an end
// record. The page polls for every word; any other word asks the dumper to
// seek to a section, finish or abort.
function* streamRom(words, guardPolls) {
    const sections = words.length / 64;
    const runs = fillRuns(words);
    let s = 0, fi = 0;
    while (true) {
        let record;
        if (s >= sections) {
            record = [(C.R_END << 24 | sections) >>> 0];
        } else if (fi < runs.length && runs[fi].start === s) {
            const r = runs[fi];
            const h = (C.R_FILL << 24 | s) >>> 0;
            record = [h, r.value, r.count, (rotl1((rotl1(h) ^ r.value) >>> 0) ^ r.count) >>> 0];
        } else {
            const h = (C.R_DATA << 24 | s) >>> 0;
            let c = h;
            record = [h];
            for (let w = 0; w < 64; w++) {
                const v = words[s * 64 + w];
                c = (rotl1(c) ^ v) >>> 0;
                record.push(v);
            }
            record.push(c);
        }
        let rx = C.M_SPOLL;
        for (const w of record) {
            rx = (yield w) >>> 0;
            if (rx !== C.M_SPOLL) break;
        }
        if (rx === C.M_SPOLL) {
            if (s < sections) {
                if (fi < runs.length && runs[fi].start === s) s += runs[fi++].count;
                else s++;
            }
            continue;
        }
        while (true) {
            if (rx === C.M_FIN) return true;
            if (rx === C.M_ABORT || rx === C.M_POLL) return false;
            if (((rx & 0xFF000000) >>> 0) === C.M_SEEK && (rx & 0xFFFFFF) <= sections) {
                s = rx & 0xFFFFFF;
                fi = runs.findIndex((r) => r.start >= s);
                if (fi < 0) fi = runs.length;
                break;
            }
            yield { busy: guardPolls };
            do rx = (yield C.G_SYNC) >>> 0; while (rx === C.M_SPOLL);
        }
    }
}

// Receive sections of 64 words plus a check word, answering OK or FAIL.
function* streamFromMaster(totalBytes) {
    const out = new Uint8Array(totalBytes);
    const dv = new DataView(out.buffer);
    let off = 0;
    while (off < totalBytes) {
        let x = 0;
        const words = [];
        for (let w = 0; w < 64; w++) {
            const v = (yield 0) >>> 0;
            words.push(v);
            x = (x ^ v) >>> 0;
        }
        const theirs = (yield 0) >>> 0;
        const ok = theirs === x;
        const ack = yield (ok ? C.G_OKOK : C.G_FAIL);
        if (ack !== C.M_CONT) return null;
        if (ok) {
            for (let w = 0; w < 64; w++) dv.setUint32(off + w * 4, words[w], true);
            off += 0x100;
        }
    }
    return out;
}

// The dumper's main loop: wait for a command, echo it, then carry it out.
function* payloadProgram(env) {
    const echoWord = (cmd) => (~(C.M_MAGIC | cmd)) >>> 0;
    while (true) {
        let rx = yield C.G_READY;
        if (((rx & 0xFFFF0000) >>> 0) !== C.M_MAGIC) continue;
        const cmd = rx & 0xFFFF;
        if (cmd === 0 || cmd > C.CMD_CART_RUN) continue;
        rx = yield echoWord(cmd);
        if (rx !== C.M_GO) continue;

        if (cmd === C.CMD_CART_RUN) {
            const len = (yield 0) >>> 0;
            const chk = (yield len) >>> 0;
            if (chk !== (~len >>> 0) || len === 0 || len > 0x20000 || len % 0x100) continue;
            const prog = yield* streamFromMaster(len);
            if (prog === null) continue;
            yield { busy: env.runBusyPolls };
            const result = env.runOps(prog);
            if (!(yield* doneGate())) continue;
            const bytes = (result.length * 4 + 0xFF) & ~0xFF;
            yield bytes;
            const padded = new Uint32Array(bytes / 4);
            padded.set(result);
            yield* streamToMaster(padded);
            continue;
        }

        if (cmd === C.CMD_DUMP_BIOS) {
            yield { busy: env.biosBusyPolls };
            if (!(yield* doneGate())) continue;
            yield* streamToMaster(env.biosWords());
            continue;
        }

        yield { busy: env.probeBusyPolls };
        const gamesize = env.gamesize() >>> 0;
        const savesize = env.savesize() >>> 0;
        if (!(yield* doneGate())) continue;
        yield gamesize;
        if (cmd !== C.CMD_DUMP_ROM) yield savesize;
        if (gamesize === 0xFFFFFFFF) continue;

        if (cmd === C.CMD_INFO) {
            for (let i = 0; i < 48; i++) yield env.romWord(i * 4);
        } else if (cmd === C.CMD_DUMP_ROM) {
            yield* streamRom(env.romWordsAll(), env.guardPolls);
        } else if (cmd === C.CMD_DUMP_SAVE) {
            if (savesize === 0) continue;
            yield { busy: env.saveReadBusyPolls };
            if (!(yield* doneGate())) continue;
            yield* streamToMaster(env.saveWords());
        } else if (cmd === C.CMD_RESTORE || cmd === C.CMD_ERASE) {
            if (savesize === 0) continue;
            const go = yield 0;
            if (go !== C.M_GO) continue;
            let staged;
            if (cmd === C.CMD_RESTORE) {
                staged = yield* streamFromMaster(savesize);
                if (staged === null) continue;
            } else {
                staged = new Uint8Array(savesize);
            }
            yield { busy: env.saveWriteBusyPolls };
            env.commitSave(staged);
            if (!(yield* doneGate())) continue;
        }
    }
}

class FakeGba {
    constructor(env) {
        this.gen = payloadProgram(env);
        this.pending = this.gen.next();
        this.busyLeft = 0;
    }
    exchange(masterWord) {
        if (this.busyLeft === 0 &&
            this.pending.value !== null &&
            typeof this.pending.value === "object") {
            this.busyLeft = this.pending.value.busy;
        }
        if (this.busyLeft > 0) {
            this.busyLeft--;
            if (this.busyLeft === 0) this.pending = this.gen.next(undefined);
            return BUSY_WORD; // not ready: the page's word is lost
        }
        const armed = this.pending.value >>> 0;
        this.pending = this.gen.next(masterWord >>> 0);
        return armed;
    }
}

// ---------------------------------------------------------------------------
// Pretend GB-Link, behaving like the firmware's GB-Link mode
// ---------------------------------------------------------------------------

class FakeUsb {
    constructor(gba, opts = {}) {
        this.gba = gba;
        this.rxQueue = [];
        this.exchanges = 0;
        this.corruptRxAt = opts.corruptRxAt ?? -1; // damage one word from the GBA
        this.corruptTxAt = opts.corruptTxAt ?? -1; // damage one word to the GBA
        this.corruptRxEvery = opts.corruptRxEvery ?? 0; // ... or every Nth word
        this.corruptTxEvery = opts.corruptTxEvery ?? 0;
        this.dropEvery = opts.dropEvery ?? 0;     // GBA misses every Nth word
        this.dropAt = opts.dropAt ?? -1;          // ... or just this one
        this.endAt = -1;                          // where the first end record went
        this.from = opts.from ?? 0;               // repeating faults start after this
    }
    periodic(every) {
        return every > 0 && this.exchanges > this.from && this.exchanges % every === 0;
    }
    async writeBytes(tx) {
        assert.equal(tx.length % 4, 0, "non-word-aligned write");
        assert.ok(tx.length <= 64, "write exceeds the 64-byte endpoint/frame cap");
        for (let i = 0; i < tx.length; i += 4) {
            this.exchanges++;
            let w = ((tx[i] << 24) | (tx[i + 1] << 16) | (tx[i + 2] << 8) | tx[i + 3]) >>> 0;
            if (this.exchanges === this.corruptTxAt || this.periodic(this.corruptTxEvery)) {
                w = (w ^ 0x00400000) >>> 0;
            }
            const drop = this.exchanges === this.dropAt || this.periodic(this.dropEvery);
            let r = drop ? BUSY_WORD : this.gba.exchange(w) >>> 0;
            if (this.endAt < 0 && w === C.M_SPOLL && (r >>> 24) === C.R_END) this.endAt = this.exchanges;
            if (this.exchanges === this.corruptRxAt || this.periodic(this.corruptRxEvery)) {
                r = (r ^ 0x00010000) >>> 0;
            }
            this.rxQueue.push((r >>> 24) & 0xFF, (r >>> 16) & 0xFF, (r >>> 8) & 0xFF, r & 0xFF);
        }
    }
    async readBytesRaw(len) {
        return new Uint8Array(this.rxQueue.splice(0, len));
    }
}

// ---------------------------------------------------------------------------
// Simulated cartridges
// ---------------------------------------------------------------------------

function makeEnv({ romMB = 1, savesize = 0x8000, title = "TESTGAME", code = "ABCD", maker = "01", fills = [] } = {}) {
    const romBytes = romMB > 0 ? romMB * 1024 * 1024 : 0;
    const rom = new Uint8Array(Math.max(romBytes, 0xC0));
    for (let i = 0; i < rom.length; i++) rom[i] = (i * 7 + 13) & 0xFF;
    for (const [at, len, value] of fills) rom.fill(value, at, at + len);
    const put = (s, at) => { for (let i = 0; i < s.length; i++) rom[at + i] = s.charCodeAt(i); };
    if (romBytes > 0) {
        rom.fill(0, 0xA0, 0xC0);
        put(title, 0xA0);
        put(code, 0xAC);
        put(maker, 0xB0);
    }
    const romDv = new DataView(rom.buffer);

    const save = new Uint8Array(savesize);
    for (let i = 0; i < savesize; i++) save[i] = (i * 31 + 5) & 0xFF;

    const bios = new Uint8Array(0x4000);
    for (let i = 0; i < bios.length; i++) bios[i] = (i * 13 + 99) & 0xFF;

    const wordsOf = (bytes) => {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const out = new Uint32Array(bytes.length / 4);
        for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true);
        return out;
    };

    return {
        rom, save, bios,
        committed: null,
        probeBusyPolls: 3,
        guardPolls: 2,
        saveReadBusyPolls: 3,
        saveWriteBusyPolls: 4,
        biosBusyPolls: 2,
        gamesize: () => (romBytes > 0 ? romBytes : 0xFFFFFFFF),
        savesize: () => (romBytes > 0 ? savesize : 0),
        romWord: (off) => romDv.getUint32(off, true),
        romWordsAll: () => wordsOf(rom),
        saveWords: function () { return wordsOf(this.save); },
        biosWords: () => wordsOf(bios),
        commitSave: function (data) { this.committed = data; this.save = data.slice(); },
        runBusyPolls: 3,
        runs: [],
        // Stand-in for cartops.c: returns 1 (ran), status 0, the sum of the
        // buffer's words, and its length.
        runOps: function (prog) {
            this.runs.push(prog);
            const w = wordsOf(prog);
            let sum = 0;
            for (const v of w) sum = (sum + v) >>> 0;
            return Uint32Array.of(1, 0, sum, prog.length);
        },
    };
}

function makeClient(env, opts) {
    const gba = new FakeGba(env);
    const usb = new FakeUsb(gba, opts);
    const client = new GbaCartClient(usb, () => {});
    return { client, usb, gba };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("readInfo parses sizes and header", async () => {
    const env = makeEnv({ romMB: 4, savesize: 0x2000 });
    const { client } = makeClient(env);
    const info = await client.readInfo();
    assert.equal(info.noCart, false);
    assert.equal(info.gamesize, 4 * 1024 * 1024);
    assert.equal(info.savesize, 0x2000);
    assert.equal(info.title, "TESTGAME");
    assert.equal(info.code, "ABCD");
    assert.equal(info.maker, "01");
});

test("readInfo reports a missing cart", async () => {
    const env = makeEnv({ romMB: 0 });
    const { client } = makeClient(env);
    const info = await client.readInfo();
    assert.equal(info.noCart, true);
});

test("dumpRom returns byte-exact data", async () => {
    const env = makeEnv({ romMB: 1 });
    const { client } = makeClient(env);
    let last = 0;
    const { data } = await client.dumpRom((done) => { last = done; });
    assert.equal(data.length, env.rom.length);
    assert.deepEqual(data, env.rom);
    assert.equal(last, env.rom.length);
});

test("dumpRom recovers from a corrupted section via resend", async () => {
    const env = makeEnv({ romMB: 1 });
    // Exchange 40 lands inside the first ROM section, after the handshake
    // and the busy polls.
    const { client } = makeClient(env, { corruptRxAt: 40 });
    const { data } = await client.dumpRom(() => {});
    assert.deepEqual(data, env.rom);
});

test("dumpSave returns byte-exact data", async () => {
    const env = makeEnv({ savesize: 0x2000 });
    const { client } = makeClient(env);
    const { data, savesize } = await client.dumpSave(() => {});
    assert.equal(savesize, 0x2000);
    assert.deepEqual(data, env.save);
});

test("dumpSave rejects a cart without save memory", async () => {
    const env = makeEnv({ savesize: 0 });
    const { client } = makeClient(env);
    await assert.rejects(client.dumpSave(() => {}), (e) => e.code === "no-save");
    // The dumper must be waiting for commands again, so another read works.
    const info = await client.readInfo();
    assert.equal(info.noCart, false);
});

test("restoreSave writes byte-exact data to the cart", async () => {
    const env = makeEnv({ savesize: 0x8000 });
    const { client } = makeClient(env);
    const file = new Uint8Array(0x8000);
    for (let i = 0; i < file.length; i++) file[i] = (i * 101 + 7) & 0xFF;
    await client.restoreSave(file, () => {});
    assert.ok(env.committed, "payload never committed the save");
    assert.deepEqual(env.committed, file);
});

test("restoreSave survives an upload corruption via payload NAK + resend", async () => {
    const env = makeEnv({ savesize: 0x200 });
    const { client } = makeClient(env, { corruptTxAt: 45 });
    const file = new Uint8Array(0x200);
    for (let i = 0; i < file.length; i++) file[i] = (i * 3 + 1) & 0xFF;
    await client.restoreSave(file, () => {});
    assert.deepEqual(env.committed, file);
});

test("restoreSave refuses a size mismatch without touching the cart", async () => {
    const env = makeEnv({ savesize: 0x8000 });
    const { client } = makeClient(env);
    const file = new Uint8Array(0x2000);
    await assert.rejects(client.restoreSave(file, () => {}), (e) => e.code === "size-mismatch");
    assert.equal(env.committed, null);
    const info = await client.readInfo();
    assert.equal(info.savesize, 0x8000);
});

test("eraseSave zero-fills the cart save", async () => {
    const env = makeEnv({ savesize: 0x10000 });
    const { client } = makeClient(env);
    const { savesize } = await client.eraseSave();
    assert.equal(savesize, 0x10000);
    assert.deepEqual(env.committed, new Uint8Array(0x10000));
});

test("dumpBios returns the 16KB image", async () => {
    const env = makeEnv({});
    const { client } = makeClient(env);
    const { data } = await client.dumpBios(() => {});
    assert.equal(data.length, 0x4000);
    assert.deepEqual(data, env.bios);
});

test("cancel mid-dump aborts, payload recovers to idle", async () => {
    const env = makeEnv({ romMB: 1 });
    const { client } = makeClient(env);
    await assert.rejects(
        client.dumpRom((done) => { if (done >= 0x1000) client.cancel(); }),
        (e) => e.code === "cancelled");
    client.cancelRequested = false;
    const info = await client.readInfo();
    assert.equal(info.noCart, false);
    assert.equal(info.title, "TESTGAME");
});

function opBuffer(bytes, seed) {
    const b = new Uint8Array(bytes);
    for (let i = 0; i < b.length; i++) b[i] = (i * seed + 7) & 0xFF;
    return b;
}
function wordSum(b) {
    const dv = new DataView(b.buffer);
    let s = 0;
    for (let i = 0; i < b.length; i += 4) s = (s + dv.getUint32(i, true)) >>> 0;
    return s;
}

test("runOps delivers the buffer byte-exact and returns the result words", async () => {
    const env = makeEnv({});
    const { client } = makeClient(env);
    const buf = opBuffer(0x1300, 3);
    const words = await client.runOps(buf);
    assert.equal(words.length, 64);   // padded to one section
    assert.equal(words[2], wordSum(buf));
    assert.equal(words[3], buf.length);
    assert.deepEqual(env.runs[0], buf);
});

test("runOps survives an upload corruption via resend", async () => {
    const env = makeEnv({});
    const { client } = makeClient(env, { corruptTxAt: 40 });
    const buf = opBuffer(0x400, 5);
    const words = await client.runOps(buf);
    assert.equal(words[2], wordSum(buf));
    assert.deepEqual(env.runs[0], buf);
});

test("runOps rejects a torn length without running anything", async () => {
    const env = makeEnv({});
    const { client, usb } = makeClient(env);
    await client.ping();
    // Damage the length word, which comes after the ready poll and the two
    // handshake words.
    usb.corruptTxAt = usb.exchanges + 4;
    await assert.rejects(client.runOps(opBuffer(0x100, 9)), (e) => e.code === "desync");
    assert.equal(env.runs.length, 0);
    const words = await client.runOps(opBuffer(0x100, 9));
    assert.equal(env.runs.length, 1);
    assert.equal(words[3], 0x100);
});

test("stale DONE gate is kicked by the next operation", async () => {
    const env = makeEnv({ savesize: 0x200 });
    const { client, gba } = makeClient(env);
    // Start a save dump by hand and leave the dumper waiting at its "done"
    // word, as if the page had been reloaded in the middle of it.
    gba.exchange(C.M_MAGIC | C.CMD_DUMP_SAVE);
    gba.exchange(C.M_GO);
    for (let i = 0; i < 10; i++) gba.exchange(C.M_POLL); // wait out the cart probe
    // The dumper now repeats its "done" word. The next operation must still
    // get through.
    const info = await client.readInfo();
    assert.equal(info.noCart, false);
});

// A 4 MB image laid out like a real one: 1 MB of game, a stretch of zeros,
// and an erased (0xFF) tail, plus one lone uniform section and a short
// stretch that isn't uniform.
const PADDED = {
    romMB: 4,
    fills: [[0x80000, 0x100, 0x00], [0x100000, 0x10000, 0x00], [0x110000, 0x2F0000, 0xFF],
        [0x200000, 0x80, 0x12]],
};

test("dumpRom sends uniform runs as fill records", async () => {
    const env = makeEnv(PADDED);
    const { client, usb } = makeClient(env);
    let last = 0;
    const { data } = await client.dumpRom((done) => { last = done; });
    assert.deepEqual(data, env.rom);
    assert.equal(last, env.rom.length);
    // Only about 1.1 MB of the 4 MB should go as data records.
    assert.ok(usb.exchanges < env.rom.length / 4 * 0.3, `${usb.exchanges} exchanges`);
});

test("dumpRom stays byte-exact through periodic reply corruption", async () => {
    const env = makeEnv(PADDED);
    const { client } = makeClient(env, { corruptRxEvery: 997, from: 20 });
    const { data } = await client.dumpRom(() => {});
    assert.deepEqual(data, env.rom);
});

test("dumpRom resyncs when the payload misreads a poll", async () => {
    const env = makeEnv(PADDED);
    const { client } = makeClient(env, { corruptTxEvery: 1499, from: 20 });
    const { data } = await client.dumpRom(() => {});
    assert.deepEqual(data, env.rom);
});

test("dumpRom recovers from words the payload missed", async () => {
    const env = makeEnv(PADDED);
    const { client } = makeClient(env, { dropEvery: 1201, from: 20 });
    const { data } = await client.dumpRom(() => {});
    assert.deepEqual(data, env.rom);
    const info = await client.readInfo();
    assert.equal(info.title, "TESTGAME");
});

test("dumpRom recovers from a missed end record", async () => {
    const env = makeEnv({ romMB: 1 });
    const clean = makeClient(env);
    await clean.client.dumpRom(() => {});
    const { client } = makeClient(env, { dropAt: clean.usb.endAt });
    const { data } = await client.dumpRom(() => {});
    assert.deepEqual(data, env.rom);
});

test("an abandoned ROM stream is aborted by the next operation", async () => {
    const env = makeEnv({ romMB: 1 });
    const { client, gba } = makeClient(env);
    gba.exchange(C.M_MAGIC | C.CMD_DUMP_ROM);
    gba.exchange(C.M_GO);
    for (let i = 0; i < 10; i++) gba.exchange(C.M_POLL);  // cart probe
    gba.exchange(C.M_CONT);                                 // past the "done" word
    for (let i = 0; i < 100; i++) gba.exchange(C.M_SPOLL); // part way through...
    const info = await client.readInfo();                  // ...the page reloads
    assert.equal(info.title, "TESTGAME");
    const { data } = await client.dumpRom(() => {});
    assert.deepEqual(data, env.rom);
});

const failures = [];
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`  ok    ${name}`);
    } catch (e) {
        failures.push(name);
        console.error(`  FAIL  ${name}`);
        console.error(`        ${e.message}`);
    }
}
console.log(failures.length === 0
    ? `\nAll ${tests.length} protocol simulation tests passed.`
    : `\n${failures.length}/${tests.length} tests FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
