/**
 * Receives a ROM or save dump from the GBC payload.
 *
 * The GBC sends the cartridge in 256-byte sections. Each section is followed
 * by one checksum byte (all 256 bytes XORed together), and the page answers
 * every section with one byte:
 *   0x01  got it, send the next section
 *   0x00  it arrived damaged, send it again
 *   0xCA  stop the dump
 *
 * Before the first section the GBC sends a 4-byte header:
 *   0xF5, transfer type (1 = ROM, 2 = save), size code, checksum
 * The size code is the cartridge header's ROM or RAM size byte, which the
 * tables below turn into a number of banks.
 *
 * The dump starts when a button is pressed on the GBA, or, if `trigger` is
 * set, when the page sends that command byte (CMD_DUMP_ROM or CMD_DUMP_SAVE).
 * The page keeps sending it until the header arrives.
 */

const FAST_MAGIC = 0xF5;
const FAST_ROM_TRANSFER = 1;
const FAST_SRAM_TRANSFER = 2;
const FAST_SECTION_SIZE = 0x100;   // bytes per section
const FAST_ROM_BANK_SIZE = 0x40;   // sections per 16 KB ROM bank
const FAST_OK = 0x01;
const FAST_FAIL = 0x00;
const FAST_ABORT = 0xCA;   // the payload's CMD_ABORT

const FAST_ROM_BANKS = [2,4,8,16,32,64,128,256,512,0,0,0,0,0,0,0,0,0,72,80,96];
const FAST_SRAM_BANK_SIZES = [0,8,0x20,0x20,0x20,0x20,2];
const FAST_SRAM_BANKS = [0,1,1,4,16,8,1];

class FastDumpReceiver {
    constructor(usb, log = console.log, { trigger = null, headerTimeoutMs = 0 } = {}) {
        this.usb = usb;
        this.log = log;
        this.cancelled = false;
        this.trigger = trigger;
        this.headerTimeoutMs = headerTimeoutMs;
        this.timedOut = false;
    }

    cancel() {
        this.cancelled = true;
    }

    async spiExchange(txByte) {
        await this.usb.writeBytes(new Uint8Array([txByte & 0xFF]));
        const rx = await this.usb.readBytesRaw(1, 5000);
        return rx.length > 0 ? rx[0] : 0;
    }

    async spiBatch(txBytes) {
        const tx = txBytes instanceof Uint8Array ? txBytes : new Uint8Array(txBytes);
        await this.usb.writeBytes(tx);

        // The reply can arrive in several pieces.
        const expected = tx.length;
        const chunks = [];
        let totalReceived = 0;
        while (totalReceived < expected) {
            const chunk = await this.usb.readBytesRaw(expected - totalReceived, 10000);
            if (!chunk || chunk.length === 0) return null;
            chunks.push(chunk);
            totalReceived += chunk.length;
        }

        const result = new Uint8Array(totalReceived);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    async readHeader() {
        // Keep sending a byte and reading one back until the GBC answers with
        // 0xF5, the first header byte. Until the dump starts it answers 0x10.

        if (this.trigger === null) this.log("Waiting for dump to start...");
        const started = Date.now();

        // Troubleshooting log, off by default. Set window.CART_DOCTOR_DEBUG =
        // true before starting a dump to log, about once a second, which byte
        // values came back and how long each exchange took. A working link
        // shows 0xF5 and the header bytes. Nothing but 0x00 and 0xFF means the
        // GBC isn't following the GB-Link's clock at all (for example, the
        // link is at the wrong voltage). A value that is 0xF5 with its bits
        // rotated means the two sides are out of step by a few bits.
        const debug = (typeof window !== "undefined" && !!window.CART_DOCTOR_DEBUG);
        const diag = {
            hist: new Map(),          // how often each byte value came back since the last report
            polls: 0,
            latencySum: 0,
            latencyMax: 0,
            lastReport: Date.now(),
        };
        const rotL = (b, n) => ((b << n) | (b >> (8 - n))) & 0xFF;
        const now = () => (typeof performance !== "undefined" && performance.now)
            ? performance.now() : Date.now();
        let sawStructured = false;
        const diagReport = () => {
            if (diag.polls === 0) return;
            const sorted = [...diag.hist.entries()].sort((a, b) => b[1] - a[1]);
            const top = sorted.slice(0, 4)
                .map(([v, c]) => `0x${v.toString(16).padStart(2, "0")}×${c}`)
                .join(", ");
            const avg = (diag.latencySum / diag.polls).toFixed(1);
            this.log(`[diag] ${diag.polls} polls: ${top} | latency avg ${avg}ms max ${diag.latencyMax.toFixed(0)}ms`);
            // Is one of the common values just 0xF5 with its bits rotated?
            for (const [v] of sorted.slice(0, 4)) {
                if (v === FAST_MAGIC) continue;
                for (let n = 1; n < 8; n++) {
                    if (rotL(v, n) === FAST_MAGIC) {
                        this.log(`[diag] 0x${v.toString(16).padStart(2, "0")} == 0xF5 left-rotated ${n} bit(s) -> likely bit-framing desync`, "error");
                        break;
                    }
                }
            }
            diag.hist.clear();
            diag.polls = 0;
            diag.latencySum = 0;
            diag.latencyMax = 0;
            diag.lastReport = Date.now();
        };

        while (!this.cancelled) {
            let rx;
            const out = this.trigger !== null ? this.trigger : 0x00;
            if (this.headerTimeoutMs && Date.now() - started > this.headerTimeoutMs) {
                this.timedOut = true;
                return null;
            }
            if (debug) {
                const t0 = now();
                rx = await this.spiExchange(out);
                const dt = now() - t0;
                diag.hist.set(rx, (diag.hist.get(rx) || 0) + 1);
                diag.polls++;
                diag.latencySum += dt;
                if (dt > diag.latencyMax) diag.latencyMax = dt;
                if (!sawStructured && rx !== 0x00 && rx !== 0xFF) {
                    sawStructured = true;
                    this.log(`[diag] first non-rail byte: 0x${rx.toString(16).padStart(2, "0")} — GBC is now shifting structured data`, "success");
                }
                if (Date.now() - diag.lastReport >= 1000) diagReport();
            } else {
                rx = await this.spiExchange(out);
            }

            if (rx === FAST_MAGIC) {
                if (debug) {
                    diagReport(); // log what came before the header first
                    this.log(`[diag] saw magic 0xF5 -> reading header`, "success");
                }
                // Read the other three header bytes.
                const type = await this.spiExchange(0x00);
                const sizeIdx = await this.spiExchange(0x00);
                const checksum = await this.spiExchange(0x00);

                const expected = (FAST_MAGIC ^ type ^ sizeIdx) & 0xFF;
                if (checksum !== expected) {
                    this.log(`Header checksum failed: got 0x${checksum.toString(16)}, expected 0x${expected.toString(16)}`, "error");
                    await this.spiExchange(FAST_FAIL);
                    continue;
                }
                // Only accept ROM and save dumps. Any other header (such as
                // type 3, a save restore) is refused so the GBC goes back to
                // its menu instead of waiting for data this code never sends.
                // Seeing one here means the GBA is running an old payload.
                if (type !== FAST_ROM_TRANSFER && type !== FAST_SRAM_TRANSFER) {
                    this.log(`GBA is running an outdated payload (got restore header type ${type} during a dump). Click "Send Multiboot" to update the GBA, then retry.`, "error");
                    await this.spiExchange(FAST_FAIL);
                    continue;
                }
                await this.spiExchange(FAST_OK);
                return { type, sizeIdx };
            }
        }
        // Cancelled. If the GBC already sent its header it is waiting for an
        // answer, so send the stop byte to send the GBA back to its menu.
        await this.usb.writeBytes(new Uint8Array(5).fill(FAST_ABORT));
        let drained = 0;
        while (drained < 5) {
            const rx = await this.usb.readBytesRaw(5 - drained, 5000);
            if (!rx || rx.length === 0) break;
            drained += rx.length;
        }
        return null;
    }

    async readSection() {
        // Clock in the 256 data bytes in pieces small enough for one USB
        // packet each, then read the checksum byte on its own.
        const CHUNK = 56; // keeps each write under the 64-byte USB packet size
        const sectionData = new Uint8Array(256);
        let checksum = 0;

        for (let offset = 0; offset < 256; offset += CHUNK) {
            const n = Math.min(CHUNK, 256 - offset);
            const tx = new Uint8Array(n);
            await this.usb.writeBytes(tx);

            // The reply can arrive in several pieces.
            let received = 0;
            while (received < n) {
                const rx = await this.usb.readBytesRaw(n - received, 10000);
                if (!rx || rx.length === 0) return null;
                sectionData.set(rx, offset + received);
                for (let i = 0; i < rx.length; i++) {
                    checksum = (checksum ^ rx[i]) & 0xFF;
                }
                received += rx.length;
            }
        }

        const checksumByte = await this.spiExchange(0x00);

        if (this.cancelled) {
            await this.spiExchange(FAST_ABORT);
            return null;
        }
        if (checksum === checksumByte) {
            await this.spiExchange(FAST_OK);
            return sectionData;
        } else {
            this.log(`Section checksum failed: got 0x${checksumByte.toString(16)}, expected 0x${checksum.toString(16)}. Retrying...`, "error");
            await this.spiExchange(FAST_FAIL);
            return null;
        }
    }

    async receiveDump(onProgress = null) {
        this.cancelled = false;

        const header = await this.readHeader();
        if (!header || this.cancelled) return null;

        const { type, sizeIdx } = header;

        let typeName, sectionsPerBank, banks;
        if (type === FAST_ROM_TRANSFER) {
            typeName = "ROM";
            sectionsPerBank = FAST_ROM_BANK_SIZE;
            banks = FAST_ROM_BANKS[sizeIdx] || 0;
        } else if (type === FAST_SRAM_TRANSFER) {
            typeName = "SRAM";
            sectionsPerBank = FAST_SRAM_BANK_SIZES[sizeIdx] || 0;
            banks = FAST_SRAM_BANKS[sizeIdx] || 0;
        } else {
            this.log(`Unknown transfer type: ${type}`, "error");
            return null;
        }

        if (banks === 0 || sectionsPerBank === 0) {
            this.log("Nothing to dump!", "error");
            return null;
        }

        const totalSections = banks * sectionsPerBank;
        const totalBytes = totalSections * FAST_SECTION_SIZE;
        this.log(`Dumping ${typeName}: ${banks} bank(s), ${sectionsPerBank} section(s)/bank, ${(totalBytes / 1024).toFixed(0)} KB total`);

        const result = new Uint8Array(totalBytes);
        let sectionsRead = 0;
        let byteOffset = 0;

        for (let bank = 0; bank < banks; bank++) {
            for (let section = 0; section < sectionsPerBank; section++) {
                // On cancel, readSection sends the stop byte after the
                // current section, which ends the dump on the GBA too.
                let sectionData = null;
                while (sectionData === null) {
                    sectionData = await this.readSection();
                    if (this.cancelled) return null;
                }

                result.set(sectionData, byteOffset);
                byteOffset += 256;
                sectionsRead++;

                if (onProgress) {
                    onProgress(sectionsRead, totalSections, bank, banks);
                }
            }
            this.log(`Bank ${bank + 1}/${banks} complete`);
        }

        this.log(`Dump complete! ${byteOffset} bytes received.`, "success");
        return { data: result.slice(0, byteOffset), type: typeName };
    }
}

window.FastDumpReceiver = FastDumpReceiver;
