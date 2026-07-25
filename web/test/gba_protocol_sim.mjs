/**
 * Word-accurate simulation of the GBA cart-dumper payload protocol.
 *
 * Drives the real web driver (web/gba_cart.js) against a generator-based
 * model of the payload state machine (source/gba_cart_dumper/source/main.c)
 * behind a fake transport with the firmware's semantics: lockstep 4-byte
 * exchanges, 64-byte write ceiling, un-armed slave reads as 0xFFFFFFFF and
 * loses the master's word.
 *
 * Run:  node web/test/gba_protocol_sim.mjs
 */

import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { GbaCartClient, GBA_CART: C } = require("../gba_cart.js");

// ---------------------------------------------------------------------------
// Payload model (mirrors main.c exactly — see that file for the state machine)
// ---------------------------------------------------------------------------

const BUSY_WORD = 0xFFFFFFFF;

function* doneGate() {
    while (true) {
        const rx = yield C.G_DONE;
        if (rx === C.M_CONT) return true;
        if (rx === C.M_ABORT) return false;
    }
}

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

function* payloadProgram(env) {
    const echoWord = (cmd) => (~(C.M_MAGIC | cmd)) >>> 0;
    while (true) {
        let rx = yield C.G_READY;
        if (((rx & 0xFFFF0000) >>> 0) !== C.M_MAGIC) continue;
        const cmd = rx & 0xFFFF;
        if (cmd === 0 || cmd > C.CMD_INFO) continue;
        rx = yield echoWord(cmd);
        if (rx !== C.M_GO) continue;

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
            yield* streamToMaster(env.romWordsAll());
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
            return BUSY_WORD; // un-armed: master's word is lost
        }
        const armed = this.pending.value >>> 0;
        this.pending = this.gen.next(masterWord >>> 0);
        return armed;
    }
}

// ---------------------------------------------------------------------------
// Fake transport with GBLink-Firmware gbLink-mode semantics
// ---------------------------------------------------------------------------

class FakeUsb {
    constructor(gba, opts = {}) {
        this.gba = gba;
        this.rxQueue = [];
        this.exchanges = 0;
        this.corruptRxAt = opts.corruptRxAt ?? -1; // flip a GBA->host word once
        this.corruptTxAt = opts.corruptTxAt ?? -1; // flip a host->GBA word once
    }
    async writeBytes(tx) {
        assert.equal(tx.length % 4, 0, "non-word-aligned write");
        assert.ok(tx.length <= 64, "write exceeds the 64-byte endpoint/frame cap");
        for (let i = 0; i < tx.length; i += 4) {
            this.exchanges++;
            let w = ((tx[i] << 24) | (tx[i + 1] << 16) | (tx[i + 2] << 8) | tx[i + 3]) >>> 0;
            if (this.exchanges === this.corruptTxAt) w = (w ^ 0x00400000) >>> 0;
            let r = this.gba.exchange(w) >>> 0;
            if (this.exchanges === this.corruptRxAt) r = (r ^ 0x00010000) >>> 0;
            this.rxQueue.push((r >>> 24) & 0xFF, (r >>> 16) & 0xFF, (r >>> 8) & 0xFF, r & 0xFF);
        }
    }
    async readBytesRaw(len) {
        return new Uint8Array(this.rxQueue.splice(0, len));
    }
}

// ---------------------------------------------------------------------------
// Cart environments
// ---------------------------------------------------------------------------

function makeEnv({ romMB = 1, savesize = 0x8000, title = "TESTGAME", code = "ABCD", maker = "01" } = {}) {
    const romBytes = romMB > 0 ? romMB * 1024 * 1024 : 0;
    const rom = new Uint8Array(Math.max(romBytes, 0xC0));
    for (let i = 0; i < rom.length; i++) rom[i] = (i * 7 + 13) & 0xFF;
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
    // Exchange numbers: handshake+gate polls first; corrupt a word deep in
    // the first ROM stream section.
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
    // Payload must be back in idle: a follow-up info read works.
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

test("stale DONE gate is kicked by the next operation", async () => {
    const env = makeEnv({ savesize: 0x200 });
    const { client, gba } = makeClient(env);
    // Drive the payload into a DONE gate by hand: command 2 accepted, then
    // abandon it (as if the web page had been reloaded mid-operation).
    gba.exchange(C.M_MAGIC | C.CMD_DUMP_SAVE);
    gba.exchange(C.M_GO);
    for (let i = 0; i < 10; i++) gba.exchange(C.M_POLL); // run out the probe busy
    // Payload is now re-arming G_DONE forever. A fresh operation must recover.
    const info = await client.readInfo();
    assert.equal(info.noCart, false);
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
