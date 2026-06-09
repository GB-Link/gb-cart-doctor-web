/**
 * Fast GBC Cart Dump Receiver
 *
 * Protocol: raw bytes + per-section XOR checksum (no nybble splitting).
 * Each section is 256 data bytes + 1 checksum byte, sent in a single
 * USB batch for ~50-60x speedup over the nybble+echo protocol.
 *
 * Header: [MAGIC=0xF5, type, size_index, checksum] (4 bytes)
 * Section: [256 data bytes, XOR checksum] (257 bytes)
 * Ack: master sends 0x01 (OK) or 0x00 (retry)
 */

const FAST_MAGIC = 0xF5;
const FAST_ROM_TRANSFER = 1;
const FAST_SRAM_TRANSFER = 2;
const FAST_SECTION_SIZE = 0x100;   // 256 bytes per section
const FAST_ROM_BANK_SIZE = 0x40;   // 64 sections per bank
const FAST_OK = 0x01;
const FAST_FAIL = 0x00;

const FAST_ROM_BANKS = [2,4,8,16,32,64,128,256,512,0,0,0,0,0,0,0,0,0,72,80,96];
const FAST_SRAM_BANK_SIZES = [0,8,0x20,0x20,0x20,0x20,2];
const FAST_SRAM_BANKS = [0,1,1,4,16,8,1];

class FastDumpReceiver {
    constructor(usb, log = console.log) {
        this.usb = usb;
        this.log = log;
        this.cancelled = false;
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

        // Read all response bytes (may come in chunks)
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
        // The GBC sends 4 header bytes: [MAGIC, type, size_index, checksum]
        // We need to clock 4 SPI exchanges. While the GBC is in init state,
        // SB=0x10 so we'll read 0x10 until the dump starts.
        // Poll until we see the magic byte.

        this.log("Waiting for dump to start...");

        // Optional diagnostics. Set window.CART_DOCTOR_DEBUG = true (before
        // starting a dump) to log, ~once a second, a histogram of the bytes the
        // poll receives, per-poll latency, a 0xF5 bit-rotation check, and the
        // first non-"rail" byte (anything other than 0x00/0xFF). This is how the
        // 3.3V-vs-5V GBC-clocking bug was found: a healthy poll shows 0xF5 and
        // header bytes, whereas ONLY 0x00/0xFF means the GBC slave never shifted
        // in sync with the device's master clock. Off by default (no log spam).
        const debug = (typeof window !== "undefined" && !!window.CART_DOCTOR_DEBUG);
        const diag = {
            hist: new Map(),          // byte value -> count since last report
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
            // Bit-framing check: is a dominant value just 0xF5 rotated?
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
            if (debug) {
                const t0 = now();
                rx = await this.spiExchange(0x00);
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
                rx = await this.spiExchange(0x00);
            }

            if (rx === FAST_MAGIC) {
                if (debug) {
                    diagReport(); // flush so the pre-magic signature logs in order
                    this.log(`[diag] saw magic 0xF5 -> reading header`, "success");
                }
                // Got magic! Read remaining 3 bytes
                const type = await this.spiExchange(0x00);
                const sizeIdx = await this.spiExchange(0x00);
                const checksum = await this.spiExchange(0x00);

                // Verify checksum
                const expected = (FAST_MAGIC ^ type ^ sizeIdx) & 0xFF;
                if (checksum !== expected) {
                    this.log(`Header checksum failed: got 0x${checksum.toString(16)}, expected 0x${expected.toString(16)}`, "error");
                    await this.spiExchange(FAST_FAIL);
                    continue;
                }
                // Only ACK transfers we actually handle. A type-3 (restore)
                // header means the user pressed SELECT — NAK it so the GBC stays
                // on its menu instead of being pushed into restore-receive mode
                // (which would hang waiting for 32 KB the dump loop never sends).
                if (type !== FAST_ROM_TRANSFER && type !== FAST_SRAM_TRANSFER) {
                    // A restore header (type 3) during a dump with no SELECT
                    // pressed means the GBA is running an OLD payload. Reloading
                    // the page is not enough — re-run "Send Multiboot" to push
                    // the current payload to the GBA, then try again.
                    this.log(`GBA is running an outdated payload (got restore header type ${type} during a dump). Click "Send Multiboot" to update the GBA, then retry.`, "error");
                    await this.spiExchange(FAST_FAIL);
                    continue;
                }
                await this.spiExchange(FAST_OK);
                return { type, sizeIdx };
            }
            // Not magic yet — GBC still in init, keep polling
        }
        return null;
    }

    async readSection() {
        // Send/receive 256 data bytes in chunks that fit the firmware's
        // USB receive buffer, then read the checksum byte separately.
        const CHUNK = 56; // stay under 64-byte USB max packet (avoids ZLP issues)
        const sectionData = new Uint8Array(256);
        let checksum = 0;

        for (let offset = 0; offset < 256; offset += CHUNK) {
            const n = Math.min(CHUNK, 256 - offset);
            const tx = new Uint8Array(n);
            await this.usb.writeBytes(tx);

            // Read response (may arrive in sub-chunks)
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

        // Read checksum byte
        const checksumByte = await this.spiExchange(0x00);

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
                if (this.cancelled) return null;

                let sectionData = null;
                while (sectionData === null) {
                    if (this.cancelled) return null;
                    sectionData = await this.readSection();
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
