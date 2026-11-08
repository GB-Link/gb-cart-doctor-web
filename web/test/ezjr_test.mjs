/**
 * Tests the EZ Flash Jr SD card support (web/ezjr_sd.js) without hardware.
 *
 *   - EzJrSd runs against a simulated EZ Flash Jr: a stand-in for the cart
 *     agent that runs its programs against a model of the cart's FPGA
 *     registers and sector buffer. The register writes must match ezgb's
 *     stage1 (github.com/lukesau/ezgb, stage1/src/fpga.c) exactly.
 *   - FatVolume reads files written by the operating system's own FAT driver,
 *     then writes, replaces and deletes files and folders. The result must
 *     pass fsck and read back correctly through the operating system.
 *
 * Run:  node web/test/ezjr_test.mjs [filter]
 * The FAT tests build their disk images with macOS's hdiutil and newfs_msdos;
 * on other systems they are skipped.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { EzJrSd, EzProgram, FatVolume, FatImageDevice } = require("../ezjr_sd.js");
const { GBOP, GbResult } = require("../gb_cart.js");

const filter = process.argv[2] || "";
const isMac = process.platform === "darwin";
const workDir = mkdtempSync(join(tmpdir(), "ezjr-"));
let passed = 0, failed = 0, skipped = 0;

async function test(name, fn, { skip = false } = {}) {
    if (filter && !name.includes(filter)) return;
    if (skip) { skipped++; console.log(`  skip  ${name}`); return; }
    try {
        await fn();
        passed++;
        console.log(`  ok    ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL  ${name}\n        ${e.stack.split("\n").slice(0, 3).join("\n        ")}`);
    }
}

const text = (b) => new TextDecoder().decode(b);
const bytes = (s) => new TextEncoder().encode(s);
const pattern = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + Math.floor(i / 251)) & 0xFF);

// ---------------------------------------------------------------- simulated cart

/**
 * The cart agent with an EZ Flash Jr inserted. Runs the agent programs
 * EzJrSd builds (WR, RD, WAIT, DELAY, WRBLK) against a model of the FPGA:
 * register writes only count between the unlock and lock writes, and SD
 * commands need the sector window on.
 */
class SimEzJr {
    constructor(image, { firmware = 5 } = {}) {
        this.image = image;
        this.firmware = firmware;
        this.unlock = 0;
        this.sdMap = 0;
        this.sramMap = 0;
        this.lba = [0, 0, 0, 0];
        this.buffer = new Uint8Array(2048);
        this.busy = false;
        this.stuck = false;           // SD commands never finish
        this.log = [];                // register writes, for sequence checks
    }

    write(addr, v) {
        if (addr >= 0x7F00 && addr <= 0x7FFF) {
            const low = addr & 0xFF;
            if (low === 0x00 && v === 0xE1) { this.unlock = 1; return; }
            if (low === 0x10 && v === 0xE2 && this.unlock === 1) { this.unlock = 2; return; }
            if (low === 0x20 && v === 0xE3 && this.unlock === 2) { this.unlock = 3; return; }
            if (low === 0xF0 && v === 0xE4) { this.unlock = 0; return; }
            if (this.unlock !== 3) throw new Error(`write $${addr.toString(16)} while locked`);
            this.log.push([addr, v]);
            if (low === 0x30) this.sdMap = v;
            else if (low === 0xC0) this.sramMap = v;
            else if (low >= 0xB0 && low <= 0xB3) this.lba[low - 0xB0] = v;
            else if (low === 0xB4) this.command(v);
            else throw new Error(`unexpected FPGA register $${addr.toString(16)}`);
            return;
        }
        if (addr >= 0xA000 && addr < 0xA800) {
            if (!(this.sdMap & 1)) throw new Error("write to $A000 with the SD window off");
            this.buffer[addr - 0xA000] = v;
            return;
        }
        throw new Error(`unexpected write $${addr.toString(16)}`);
    }

    read(addr) {
        if (addr >= 0xA000 && addr < 0xA800) {
            if (this.sramMap === 4) return this.firmware;
            if (this.sdMap === 3) return this.busy ? 0xE1 : 0x01;
            if (this.sdMap === 1) return this.buffer[addr - 0xA000];
        }
        return 0xFF;
    }

    command(v) {
        if (!(this.sdMap & 1)) throw new Error("SD command with the SD window off");
        const lba = (this.lba[0] | (this.lba[1] << 8) | (this.lba[2] << 16) | (this.lba[3] << 24)) >>> 0;
        const n = v & 0x7F;
        if (n < 1 || n > 4) throw new Error(`bad sector count ${n}`);
        const off = lba * 512;
        if (off + n * 512 > this.image.length) throw new Error("SD command past the end of the card");
        if (v & 0x80) this.image.set(this.buffer.subarray(0, n * 512), off);
        else this.buffer.set(this.image.subarray(off, off + n * 512));
        this.busy = this.stuck;       // real commands take time; finishing instantly keeps the tests fast
    }

    /** GbCartClient.run() */
    async run(prog) {
        const b = prog.build();
        const out = [];
        let i = 0, executed = 0;
        const w = () => { const v = b[i] | (b[i + 1] << 8); i += 2; return v; };
        while (i < b.length) {
            const op = b[i++];
            if (op === GBOP.WR) { const a = w(); this.write(a, b[i++]); }
            else if (op === GBOP.RD) { const a = w(), n = w(); for (let k = 0; k < n; k++) out.push(this.read(a + k)); }
            else if (op === GBOP.WAIT) {
                const a = w(), mask = b[i++], val = b[i++]; w();
                const v = this.read(a);
                out.push(v);
                if ((v & mask) !== val) return new GbResult(GBOP.ST_TIMEOUT, executed, Uint8Array.from(out));
            } else if (op === GBOP.DELAY) { w(); }
            else if (op === GBOP.WRBLK) { const a = w(), n = w(); for (let k = 0; k < n; k++) this.write(a + k, b[i++]); }
            else throw new Error(`op ${op} not simulated`);
            executed++;
        }
        return new GbResult(GBOP.ST_OK, executed, Uint8Array.from(out));
    }
}

// ---------------------------------------------------------------- disk images

/**
 * Builds a FAT image with macOS's own tools and fills it through the system's
 * FAT driver, so the files in it come from an independent implementation.
 */
function makeImage(name, sizeMb, fatType, sectorsPerCluster) {
    const img = join(workDir, `${name}.img`);
    const mnt = join(workDir, `${name}-mnt`);
    writeFileSync(img, Buffer.alloc(sizeMb * 1024 * 1024));
    const dev = execFileSync("hdiutil", ["attach", "-imagekey", "diskimage-class=CRawDiskImage", "-nomount", img], { encoding: "utf8" }).split(/\s/)[0];
    try {
        execFileSync("newfs_msdos", ["-F", String(fatType), "-c", String(sectorsPerCluster), "-v", "TESTCARD", dev], { stdio: "ignore" });
    } finally {
        // A failed format must not leave the image attached for the next run.
        execFileSync("hdiutil", ["detach", dev], { stdio: "ignore" });
    }
    mkdirSync(mnt);
    execFileSync("hdiutil", ["attach", "-imagekey", "diskimage-class=CRawDiskImage", "-mountpoint", mnt, img], { stdio: "ignore" });
    try {
        writeFileSync(join(mnt, "HELLO.TXT"), "hello from macOS\n");
        writeFileSync(join(mnt, "readme.md"), "lower case short name\n");
        writeFileSync(join(mnt, "Pokemon Crystal (USA, Europe).gbc"), "long name file\n");
        writeFileSync(join(mnt, "big.bin"), pattern(102400));
        writeFileSync(join(mnt, "empty.txt"), "");
        mkdirSync(join(mnt, "SAVER"));
        mkdirSync(join(mnt, "Games", "Nested Folder"), { recursive: true });
        writeFileSync(join(mnt, "Games", "Nested Folder", "deep file.txt"), "nested\n");
        for (let i = 0; i < 40; i++) writeFileSync(join(mnt, "SAVER", `save number ${i}.sav`), String(i));
    } finally {
        execFileSync("sync");
        execFileSync("hdiutil", ["detach", mnt], { stdio: "ignore" });
    }
    return new Uint8Array(readFileSync(img));
}

/** Puts a FAT image inside an MBR-partitioned card at sector 2048. */
function wrapInMbr(img) {
    const start = 2048;     // where most tools put the first partition, as on a store-bought card
    const out = new Uint8Array(start * 512 + img.length);
    out.set(img, start * 512);
    out[446 + 4] = 0x0C;
    new DataView(out.buffer).setUint32(446 + 8, start, true);
    new DataView(out.buffer).setUint32(446 + 12, img.length / 512, true);
    out[510] = 0x55; out[511] = 0xAA;
    return out;
}

function fsck(image) {
    const p = join(workDir, "fsck.img");
    writeFileSync(p, image);
    // fsck_msdos exits non-zero on any problem, and execFileSync turns that into a throw.
    return execFileSync("fsck_msdos", ["-n", p], { encoding: "utf8" });
}

/** Mounts an image read-only with macOS's FAT driver and reads files back. */
function osRead(image, paths) {
    const p = join(workDir, "check.img"), mnt = join(workDir, "check-mnt");
    writeFileSync(p, image);
    mkdirSync(mnt, { recursive: true });
    execFileSync("hdiutil", ["attach", "-readonly", "-imagekey", "diskimage-class=CRawDiskImage", "-mountpoint", mnt, p], { stdio: "ignore" });
    try {
        const out = { root: readdirSync(mnt) };
        for (const f of paths) out[f] = existsSync(join(mnt, f)) ? new Uint8Array(readFileSync(join(mnt, f))) : null;
        return out;
    } finally {
        execFileSync("hdiutil", ["detach", mnt], { stdio: "ignore" });
    }
}

// ---------------------------------------------------------------- tests

console.log("EZ Flash Jr sectors");

const sample = () => Uint8Array.from({ length: 64 * 512 }, (_, i) => (i * 13 + (i >> 9)) & 0xFF);

await test("detects the firmware version", async () => {
    const sd = new EzJrSd(new SimEzJr(sample(), { firmware: 4 }));
    assert.deepEqual(await sd.detect(), { firmware: 4 });
});

await test("reports a cart that isn't an EZ Flash Jr", async () => {
    const cart = new SimEzJr(sample());
    cart.firmware = 0xFF;
    await assert.rejects(new EzJrSd(cart).detect({ timeoutMs: 10 }), /No EZ Flash Jr/);
});

await test("a one-sector read writes the same registers as ezgb's stage1", async () => {
    const cart = new SimEzJr(sample());
    await new EzJrSd(cart, { sectorsPerCommand: 1 }).readSectors(4, 1);
    assert.deepEqual(cart.log, [
        [0x7F30, 1], [0x7FB0, 4], [0x7FB1, 0], [0x7FB2, 0], [0x7FB3, 0], [0x7FB4, 1],
        [0x7F30, 3], [0x7F30, 1], [0x7F30, 0]]);
});

await test("reads and writes across 4-sector commands", async () => {
    const img = sample();
    const cart = new SimEzJr(img);
    const sd = new EzJrSd(cart);
    assert.deepEqual(await sd.readSectors(3, 9), img.slice(3 * 512, 12 * 512));
    const data = Uint8Array.from({ length: 6 * 512 }, (_, i) => (i * 5) & 0xFF);
    await sd.writeSectors(10, data);
    assert.deepEqual(img.slice(10 * 512, 16 * 512), data);
    assert.ok(cart.log.some(([a, v]) => a === 0x7FB4 && v === 0x84), "a 4-sector write command");
});

await test("a stuck SD card gives a clear error and turns the window off", async () => {
    const cart = new SimEzJr(sample());
    cart.stuck = true;
    await assert.rejects(new EzJrSd(cart).readSectors(0, 1), /stayed busy/);
    assert.equal(cart.sdMap, 0);
});

await test("refuses FPGA registers outside the allowlist ($7FD2 writes the config flash)", async () => {
    const p = new EzProgram();
    assert.throws(() => p.reg(0x7FD2, 1), /Refusing/);
    assert.throws(() => p.reg(0x7FE0, 0x80), /Refusing/);
    p.reg(0x7F30, 1);
});

console.log("FAT filesystem");

let images = null;
if (isMac && !filter.startsWith("EZ")) {
    try {
        images = { fat32: makeImage("fat32", 64, 32, 1), fat16: makeImage("fat16", 32, 16, 4) };
        images.mbr = wrapInMbr(images.fat32);
    } catch (e) {
        // On macOS the images should always build; a skip here would hide a broken test.
        failed++;
        console.log(`  FAIL  couldn't build the disk images: ${e.message}`);
    }
}
const noImages = !images;
if (noImages) console.log("  (FAT tests need macOS to build their disk images)");

for (const kind of ["fat32", "fat16", "mbr"]) {
    await test(`${kind}: lists and reads files written by macOS`, async () => {
        const vol = await FatVolume.mount(new FatImageDevice(images[kind].slice()));
        assert.equal(vol.type, kind === "fat16" ? "FAT16" : "FAT32");
        const names = (await vol.readdir("/")).map((e) => e.name);
        for (const n of ["HELLO.TXT", "readme.md", "Pokemon Crystal (USA, Europe).gbc", "big.bin", "empty.txt", "SAVER", "Games"]) {
            assert.ok(names.includes(n), `${n} listed`);
        }
        assert.equal(text(await vol.readFile("/hello.txt")), "hello from macOS\n");
        assert.equal(text(await vol.readFile("/Pokemon Crystal (USA, Europe).gbc")), "long name file\n");
        assert.equal(text(await vol.readFile("/Games/Nested Folder/deep file.txt")), "nested\n");
        assert.deepEqual(await vol.readFile("/big.bin"), pattern(102400));
        assert.equal((await vol.readFile("/empty.txt")).length, 0);
        assert.equal((await vol.readdir("/SAVER")).filter((e) => e.name.startsWith("save number")).length, 40);
    }, { skip: noImages });
}

for (const kind of ["fat32", "fat16"]) {
    await test(`${kind}: writes pass fsck and read back through macOS`, async () => {
        const dev = new FatImageDevice(images[kind].slice());
        const vol = await FatVolume.mount(dev);
        const big = pattern(50000);
        await vol.writeFile("/Super Mario Land 2 - 6 Golden Coins.gb", big);
        await vol.writeFile("/TETRIS.GB", bytes("tetris"));
        await vol.writeFile("/tiny.txt", bytes("lower"));
        await vol.mkdir("/New Folder");
        await vol.writeFile("/New Folder/inside file.sav", pattern(3000));
        for (let i = 0; i < 30; i++) await vol.writeFile(`/New Folder/entry with a long name ${i}.txt`, bytes(`#${i}`));
        await vol.writeFile("/HELLO.TXT", bytes("replaced"), { overwrite: true });
        await assert.rejects(vol.writeFile("/HELLO.TXT", new Uint8Array(1)), /exists/);
        await vol.remove("/big.bin");
        await vol.remove("/Games/Nested Folder/deep file.txt");
        await assert.rejects(vol.remove("/Games/Nested Folder"), /not empty/);   // macOS's ._ file is still there
        await vol.remove("/Games/Nested Folder/._deep file.txt");
        await vol.remove("/Games/Nested Folder");

        const again = await FatVolume.mount(new FatImageDevice(dev.bytes));
        assert.deepEqual(await again.readFile("/Super Mario Land 2 - 6 Golden Coins.gb"), big);
        assert.equal(await again.stat("/big.bin"), null);
        assert.equal((await again.readdir("/New Folder")).length, 31);
        if (kind === "fat32") assert.equal(await again.countFree(), again.freeCount, "FSInfo free count matches the FAT");

        fsck(dev.bytes);
        const os = osRead(dev.bytes, ["Super Mario Land 2 - 6 Golden Coins.gb", "HELLO.TXT", "tiny.txt",
            "New Folder/inside file.sav", "New Folder/entry with a long name 29.txt"]);
        assert.deepEqual(os["Super Mario Land 2 - 6 Golden Coins.gb"], big);
        assert.equal(text(os["HELLO.TXT"]), "replaced");
        assert.equal(text(os["tiny.txt"]), "lower");
        assert.deepEqual(os["New Folder/inside file.sav"], pattern(3000));
        assert.equal(text(os["New Folder/entry with a long name 29.txt"]), "#29");
        assert.ok(!os.root.includes("big.bin"));
    }, { skip: noImages });
}

for (const kind of ["fat32", "fat16"]) {
    await test(`${kind}: renames keep the data and dates, and pass fsck and macOS`, async () => {
        const dev = new FatImageDevice(images[kind].slice());
        const vol = await FatVolume.mount(dev);
        const before = await vol.stat("/big.bin");
        await vol.rename("/Pokemon Crystal (USA, Europe).gbc", "Crystal.gbc");
        await vol.rename("/HELLO.TXT", "hello.txt");                                      // case only
        await vol.rename("/readme.md", "A much longer name for the readme file.md");
        await vol.rename("/big.bin", "BIG.BIN");
        await vol.rename("/Games", "My Games");
        await assert.rejects(vol.rename("/BIG.BIN", "empty.txt"), /exists/);
        await assert.rejects(vol.rename("/BIG.BIN", "a/b"), /can't contain/);
        await assert.rejects(vol.rename("/missing.gb", "x.gb"), /Not found/);

        const again = await FatVolume.mount(new FatImageDevice(dev.bytes));
        const names = (await again.readdir("/")).map((e) => e.name);
        for (const n of ["Crystal.gbc", "hello.txt", "A much longer name for the readme file.md", "BIG.BIN", "My Games"]) {
            assert.ok(names.includes(n), `${n} listed`);
        }
        for (const n of ["Pokemon Crystal (USA, Europe).gbc", "HELLO.TXT", "readme.md", "big.bin", "Games"]) {
            assert.ok(!names.includes(n), `${n} gone`);
        }
        assert.equal(text(await again.readFile("/Crystal.gbc")), "long name file\n");
        assert.equal(text(await again.readFile("/My Games/Nested Folder/deep file.txt")), "nested\n");
        const after = await again.stat("/BIG.BIN");
        assert.deepEqual(await again.readFile("/BIG.BIN"), pattern(102400));
        assert.equal(after.modified.getTime(), before.modified.getTime(), "modified date kept");
        assert.equal(after.firstCluster, before.firstCluster);

        fsck(dev.bytes);
        const os = osRead(dev.bytes, ["Crystal.gbc", "hello.txt", "A much longer name for the readme file.md", "My Games/Nested Folder/deep file.txt"]);
        assert.equal(text(os["Crystal.gbc"]), "long name file\n");
        assert.equal(text(os["hello.txt"]), "hello from macOS\n");
        assert.equal(text(os["A much longer name for the readme file.md"]), "lower case short name\n");
        assert.equal(text(os["My Games/Nested Folder/deep file.txt"]), "nested\n");
        assert.ok(os.root.includes("hello.txt") && !os.root.includes("HELLO.TXT"), "macOS sees the new case");
    }, { skip: noImages });
}

await test("the filesystem works end to end through the simulated cart", async () => {
    const cart = new SimEzJr(images.fat32.slice());
    const sd = new EzJrSd(cart);
    await sd.detect();
    const vol = await FatVolume.mount(sd);
    await vol.writeFile("/from the gba.txt", bytes("hi"));
    const again = await FatVolume.mount(sd);
    assert.equal(text(await again.readFile("/from the gba.txt")), "hi");
    fsck(cart.image);
}, { skip: noImages });

rmSync(workDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
