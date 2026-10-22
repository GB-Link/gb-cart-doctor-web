/**
 * Tests writing GBA flash carts without hardware. The page's real code
 * (web/gba_flash.js), which detects the chip and plans the erases and writes,
 * drives the dumper's real cart operations (source/gba_cart_dumper/source/
 * cartops.c, built for the PC) against simulated flash chips from
 * web/test/flashsim/flashsim.c.
 *
 * Run:  node web/test/flashcart_test.mjs [filter]
 * Needs a C compiler (cc).
 */

import { strict as assert } from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { GbaFlashcart } = require("../gba_flash.js");
const { FLASHCART_PROFILES } = require("../flashcart_profiles.js");

const here = dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "flashsim-"));
const simBin = join(workDir, "flashsim");
execFileSync("cc", ["-O2", "-Wall", "-DCARTOPS_SIM", `-I${join(here, "flashsim")}`, "-o", simBin,
    join(here, "flashsim", "flashsim.c"),
    join(here, "..", "..", "source", "gba_cart_dumper", "source", "cartops.c")], { stdio: "inherit" });

/**
 * Runs one flashsim process. Offers runOps() like the page's GBA client,
 * plus calls to read back the chip and its counters.
 */
class SimCart {
    constructor(args) {
        this.proc = spawn(simBin, args, { stdio: ["pipe", "pipe", "inherit"] });
        this.buf = Buffer.alloc(0);
        this.waiter = null;
        this.runs = 0;
        this.uploaded = 0;
        this.proc.stdout.on("data", (d) => {
            this.buf = Buffer.concat([this.buf, d]);
            if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
        });
    }
    async _read(n) {
        while (this.buf.length < n) await new Promise((r) => (this.waiter = r));
        const out = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        return Buffer.from(out);
    }
    async runOps(buf) {
        assert.equal(buf.length % 256, 0, "op buffer not section-aligned");
        assert.ok(buf.length <= 0x20000, "op buffer too large");
        this.runs++;
        this.uploaded += buf.length;
        const head = Buffer.alloc(5);
        head[0] = "R".charCodeAt(0);
        head.writeUInt32LE(buf.length, 1);
        this.proc.stdin.write(Buffer.concat([head, Buffer.from(buf)]));
        const n = (await this._read(4)).readUInt32LE(0);
        const words = await this._read(n * 4);
        return new Uint32Array(words.buffer.slice(words.byteOffset, words.byteOffset + n * 4));
    }
    async dump(off, len) {
        const head = Buffer.alloc(9);
        head[0] = "D".charCodeAt(0);
        head.writeUInt32LE(off, 1);
        head.writeUInt32LE(len, 5);
        this.proc.stdin.write(head);
        return this._read(len);
    }
    async stats() {
        this.proc.stdin.write(Buffer.from("S"));
        const n = (await this._read(4)).readUInt32LE(0);
        const b = await this._read(n * 4);
        const v = (i) => b.readUInt32LE(i * 4);
        return { prog: v(0), buf: v(1), erase: v(2), chip: v(3), errors: v(4), overprog: v(5) };
    }
    close() { this.proc.stdin.end(); }
}

function makeRom(size, seed) {
    const rom = new Uint8Array(size);
    let x = (seed * 2654435761) >>> 0 || 1;
    for (let i = 0; i < size; i++) {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        rom[i] = x & 0xFF;
    }
    // A blank (0xFF) stretch like a real ROM's padding, so skipping blank
    // areas gets tested.
    if (size > 0x60000) rom.fill(0xFF, 0x40000, 0x50000);
    return rom;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/**
 * Detect the chip, write a ROM and read it back. `expect` is the profile id
 * detection must pick. Then write the same ROM again, which should skip every
 * sector, and a copy with one byte changed, which should rewrite one sector.
 */
async function roundTrip(args, expect, romSize, { rewrite = true, check, chipsPerSector = 1 } = {}) {
    const cart = new SimCart(args);
    try {
        const fc = new GbaFlashcart(cart, { profiles: FLASHCART_PROFILES });
        const det = await fc.detect();
        assert.equal(det.profile.id, expect,
            `picked ${det.profile.id} (candidates ${det.candidates.map(p => p.id).join(", ")})`);
        const rom = makeRom(romSize, romSize ^ 0x5A);
        const res = await fc.writeRom(rom);
        const got = await cart.dump(0, rom.length);
        assert.ok(Buffer.from(rom).equals(got), "cart image differs from the ROM");
        const st = await cart.stats();
        assert.equal(st.errors, 0, `chip saw ${st.errors} bad command sequences`);
        assert.equal(st.overprog, 0, `chip saw ${st.overprog} writes to unerased words`);
        if (check) await check({ cart, fc, det, res, st });
        if (rewrite) {
            const again = await fc.writeRom(rom);
            assert.equal(again.written, 0, "an unchanged ROM was rewritten");
            const rom2 = rom.slice();
            rom2[rom2.length >> 1] ^= 0xA5;
            const before = (await cart.stats()).erase;
            const third = await fc.writeRom(rom2);
            const after = await cart.stats();
            assert.equal(after.erase - before, chipsPerSector, "a one-byte change should erase one sector");
            assert.equal(after.overprog, 0);
            assert.ok(third.written > 0);
            const got2 = await cart.dump(0, rom2.length);
            assert.ok(Buffer.from(rom2).equals(got2), "cart image differs after the partial rewrite");
        }
        return { det, res, cart };
    } finally {
        cart.close();
    }
}

// ---------------------------------------------------------------- profiles

test("AMD S29GL256, buffered writes, CFI buffer size", () => roundTrip(
    ["type=amd", "mfr=0x01", "dev=0x227E", "size=0x2000000", "sector=0x20000", "buf=64"],
    "AGB_S29GL256", 0x300000));

test("AMD MSP55LV128 behind D0/D1-swapped wiring", () => roundTrip(
    ["type=amd", "wiring=d01", "mfr=0x04", "dev=0x227E", "size=0x1000000", "sector=0x10000", "buf=64"],
    "AGB_MSP55LV128", 0x280000));

test("AMD 29LV128DB, single-word writes, bottom boot sectors from CFI", () => roundTrip(
    ["type=amd", "mfr=0xC2", "dev=0x227A", "size=0x1000000", "sector=0x10000", "boot=bottom"],
    "AGB_29LV128DB", 0x90000));

test("AMD 29LV128DT, D0/D1 swapped, top boot sectors (CFI regions reversed)", () => roundTrip(
    ["type=amd", "wiring=d01", "mfr=0xC2", "dev=0x227E", "size=0x1000000", "sector=0x10000", "boot=top"],
    "AGB_29LV128DT", 0x90000, {
        check: async ({ fc, det }) => {
            const s = GbaFlashcart.sectorList(det.profile, det.cfi, 0x1000000);
            assert.deepEqual(s[s.length - 1], [0xFFE000, 0x2000], "top boot sectors not at the top");
        },
    }));

test("Intel 128W30B, single writes, locked boot blocks", () => roundTrip(
    ["type=intel", "mfr=0x8A", "dev=0x8857", "size=0x1000000", "sector=0x10000", "boot=bottom", "locked=1"],
    "AGB_128W30B", 0x90000));

test("Intel 4050M0Y0Q0, buffered (0xEA) writes, partitions", () => roundTrip(
    ["type=intel", "mfr=0x8A", "dev=0x8902", "size=0x2000000", "sector=0x20000", "buf=64"],
    "AGB_4050M0Y0Q0", 0x300000));

test("Intel M36L0R806 with D0/D1 and D6/D7 swapped (status bit 6)", () => roundTrip(
    ["type=intel", "wiring=d01d67", "mfr=0x20", "dev=0x880E", "size=0x2000000", "sector=0x20000", "buf=64"],
    "AGB_M36L0R806_2", 0x200000));

test("Flash2Advance 256M: two interleaved Intel chips", () => roundTrip(
    ["type=intel", "interleave=1", "mfr=0x89", "dev=0x18", "size=0x1000000", "sector=0x20000", "buf=32"],
    "AGB_Flash2Advance_256M", 0x200000, { chipsPerSector: 2 }));

test("MSP55LV100G: two 8-bit dies on the byte lanes", () => roundTrip(
    ["type=amd", "lanes=2", "idshift=1", "wiring=d01", "mfr=0x01", "dev=0x7E", "u1=0x2AAA", "u2=0x1555",
        "size=0x2000000", "sector=0x40000", "buf=32", "cfi=0"],
    "AGB_MSP55LV100G", 0x300000, { chipsPerSector: 2 }));

test("MSP55LV100S: byte-lane dies, two 32 MB banks, image across the bank boundary", () => roundTrip(
    ["type=amd", "lanes=2", "wiring=d01", "mfr=0x01", "dev=0x7E", "u1=0x555", "u2=0x2AA",
        "size=0x2000000", "sector=0x40000", "buf=32", "cfi=0", "banks=2"],
    "AGB_MSP55LV100S", 0x2000000 + 0x100000, {
        rewrite: false,
        check: async ({ cart }) => {
            const tail = await cart.dump(0x2000000, 0x100000);
            assert.ok(tail.some(b => b !== 0xFF), "second bank was not written");
        },
    }));

test("Sharp development cart: same ID as two 16 MB profiles, told apart by CFI size", () => roundTrip(
    ["type=intel", "mfr=0xB0", "dev=0xE2", "size=0x800000", "sector=0x10000"],
    "AGB_Dev_E201843", 0x90000));

test("Intel 6600M0U0BE: same ID as a 512 MB profile, told apart by counting banks", () => roundTrip(
    ["type=intel", "mfr=0x8A", "dev=0x88B0", "size=0x2000000", "sector=0x40000", "buf=1024", "banks=8", "fill=ff"],
    "AGB_6600M0U0BE", 0x100000, { rewrite: false }));

// ---------------------------------------------------------------- Burn2Slot fallback

test("old data after the ROM is erased, other banks are left alone", async () => {
    const cart = new SimCart(["type=intel", "mfr=0x8A", "dev=0x88B0", "size=0x2000000", "sector=0x40000",
        "buf=1024", "banks=8"]);
    try {
        const fc = new GbaFlashcart(cart, { profiles: FLASHCART_PROFILES });
        await fc.detect();
        const bank1 = await cart.dump(0x2000000, 0x80000);
        const rom = makeRom(0x100000, 7);
        const res = await fc.writeRom(rom);
        assert.ok(Buffer.from(rom).equals(await cart.dump(0, rom.length)));
        assert.equal(res.cleared, (0x2000000 - 0x100000) / 0x40000);
        const rest = await cart.dump(0x100000, 0x2000000 - 0x100000);
        assert.ok(rest.every(b => b === 0xFF), "old data left after the ROM");
        assert.ok(bank1.equals(await cart.dump(0x2000000, 0x80000)), "another bank was touched");
        const again = await fc.writeRom(rom);
        assert.equal(again.cleared, 0);
        assert.equal(again.written, 0);
    } finally {
        cart.close();
    }
});

// The BX2006_TSOPBGA_0106 board: FlashGBX lists it as 8 MB, but its chip is
// 16 MB. CFI says so, and the GBA reads different data from 8 to 16 MB.
test("M29W640 board with a 16 MB chip: old data past 8 MB is erased too", async () => {
    const cart = new SimCart(["type=amd", "wiring=d01", "mfr=0x20", "dev=0x227E", "size=0x1000000", "sector=0x10000", "buf=64"]);
    try {
        const fc = new GbaFlashcart(cart, { profiles: FLASHCART_PROFILES });
        const det = await fc.detect();
        assert.equal(det.profile.id, "AGB_M29W640");
        assert.equal(det.cfi.deviceSize, 0x1000000);
        const rom = makeRom(0x2A658, 3);
        const res = await fc.writeRom(rom);
        assert.ok(Buffer.from(rom).equals(await cart.dump(0, rom.length)));
        const rest = await cart.dump(0x30000, 0x1000000 - 0x30000);
        assert.ok(rest.every(b => b === 0xFF), "old data left after the ROM");
        assert.ok(res.cleared > 128, `${res.cleared} sectors cleared`);
    } finally {
        cart.close();
    }
});

for (const past of ["open bus", "mirror"]) {
    test(`a chip that reports more than it has (${past} past the listed size) keeps the listed size`, async () => {
        const cart = new SimCart(["type=amd", "wiring=d01", "mfr=0x20", "dev=0x227E", "size=0x800000",
            "cfisize=0x1000000", "sector=0x10000", "buf=64", `mirror=${past === "mirror" ? 1 : 0}`]);
        try {
            const fc = new GbaFlashcart(cart, { profiles: FLASHCART_PROFILES });
            await fc.detect();
            const rom = makeRom(0x2A658, 3);
            const res = await fc.writeRom(rom);
            assert.equal(res.cleared, 0x800000 / 0x10000 - 3);
            assert.ok(Buffer.from(rom).equals(await cart.dump(0, rom.length)));
            const again = await fc.writeRom(rom);
            assert.equal(again.cleared, 0);
            assert.equal(again.written, 0);
        } finally {
            cart.close();
        }
    });
}

test("eraseRest: false keeps the data after the ROM", async () => {
    const cart = new SimCart(["type=amd", "mfr=0x01", "dev=0x227E", "size=0x2000000", "sector=0x20000", "buf=64"]);
    try {
        const fc = new GbaFlashcart(cart, { profiles: FLASHCART_PROFILES });
        await fc.detect();
        const before = await cart.dump(0x100000, 0x100000);
        const res = await fc.writeRom(makeRom(0x100000, 9), { eraseRest: false });
        assert.equal(res.cleared, 0);
        assert.ok(before.equals(await cart.dump(0x100000, 0x100000)));
    } finally {
        cart.close();
    }
});

test("Burn2Slot scan: unknown AMD chip, reordered data lines, 0x5555/0x2AAA layout", () => roundTrip(
    ["type=amd", "wiring=b2s1", "u1=0x5555", "u2=0x2AAA", "mfr=0x01", "dev=0x22CA",
        "size=0x1000000", "sector=0x20000", "cfi=0"],
    "B2S_AMD", 0x180000, { rewrite: false }));

test("Burn2Slot scan: unknown AMD chip, straight wiring, CFI sectors", () => roundTrip(
    ["type=amd", "mfr=0x01", "dev=0x22CB", "size=0x800000", "sector=0x10000"],
    "B2S_AMD", 0x180000));

test("Burn2Slot scan: unknown Intel chip uses the generic Intel profile + CFI", () => roundTrip(
    ["type=intel", "mfr=0x89", "dev=0x8899", "size=0x800000", "sector=0x20000"],
    "B2S_INTEL", 0x180000));

// ---------------------------------------------------------------- failures

test("a mask-ROM cart is reported as not a flash cart", async () => {
    const cart = new SimCart(["type=rom", "size=0x800000"]);
    try {
        const fc = new GbaFlashcart(cart, { profiles: FLASHCART_PROFILES });
        await assert.rejects(fc.detect(), (e) => e.code === "no-flash");
    } finally { cart.close(); }
});

test("a ROM bigger than the chip is refused before anything is erased", async () => {
    const cart = new SimCart(["type=amd", "mfr=0x01", "dev=0x227E", "size=0x2000000", "sector=0x20000", "buf=64"]);
    try {
        const fc = new GbaFlashcart(cart, { profiles: FLASHCART_PROFILES });
        await fc.detect();
        await assert.rejects(fc.writeRom(new Uint8Array(0x2000002)), (e) => e.code === "too-big");
        assert.equal((await cart.stats()).erase, 0);
    } finally { cart.close(); }
});

test("a chip that never finishes programming times out with an address", async () => {
    const cart = new SimCart(["type=amd", "mfr=0x01", "dev=0x227E", "size=0x2000000", "sector=0x20000",
        "buf=64", "busybuf=100000000", "busyprog=100000000"]);
    try {
        const fc = new GbaFlashcart(cart, { profiles: FLASHCART_PROFILES });
        await fc.detect();
        await assert.rejects(fc.writeRom(makeRom(0x20000, 3)), (e) => e.code === "timeout" && /0x/.test(e.message));
    } finally { cart.close(); }
});

test("manual profile choice without detection reads CFI itself", async () => {
    const cart = new SimCart(["type=intel", "mfr=0x89", "dev=0x8899", "size=0x800000", "sector=0x20000"]);
    try {
        const fc = new GbaFlashcart(cart, { profiles: FLASHCART_PROFILES });
        const generic = FLASHCART_PROFILES.find(p => p.id === "AGB_Generic_0_90");
        const rom = makeRom(0x60000, 9);
        await fc.writeRom(rom, { profile: generic });
        assert.ok(Buffer.from(rom).equals(await cart.dump(0, rom.length)));
    } finally { cart.close(); }
});

// ---------------------------------------------------------------- runner

const filter = process.argv[2];
let pass = 0, fail = 0;
for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    const t0 = Date.now();
    try {
        await t.fn();
        pass++;
        console.log(`  ok   ${t.name} (${Date.now() - t0} ms)`);
    } catch (e) {
        fail++;
        console.log(`  FAIL ${t.name}\n       ${e.stack || e}`);
    }
}
rmSync(workDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
