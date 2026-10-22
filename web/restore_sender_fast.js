/**
 * Writes a .sav file back into a GB/GBC cartridge's save RAM.
 *
 * This is the dump in reverse (see dump_receiver_fast.js). The GBC payload
 * first sends a 4-byte header:
 *   0xF5, transfer type (3 = restore), the cart's RAM size code, checksum
 * The page then sends the save in 256-byte sections, each followed by a
 * checksum byte (all 256 bytes XORed together). The GBC writes each section
 * to the cart and answers 0x01 (OK) or 0x00 (damaged, send it again).
 *
 * The restore starts when SELECT is pressed on the GBA, or, if `trigger` is
 * set, when the page sends that command byte (CMD_RESTORE). The page keeps
 * sending it until the header arrives. To cancel, the page sends a section
 * with the wrong checksum 0xCA, which sends the GBA back to its menu.
 *
 * Every byte sent over the link swaps with a byte from the GBC. While sending
 * section data the bytes coming back mean nothing and are thrown away; only
 * the GBC's OK/damaged answer is read.
 */

const RESTORE_MAGIC = 0xF5;
const RESTORE_TRANSFER = 3;           // matches rRESTORE_TRANSFER in payload_fast.asm
const RESTORE_SECTION_SIZE = 0x100;   // bytes per section
const RESTORE_OK = 0x01;
const RESTORE_FAIL = 0x00;
const RESTORE_ABORT = 0xCA;           // the payload's CMD_ABORT

// Save sizes for each RAM size code (cartridge header byte $0149). These
// must match the tables in dump_receiver_fast.js.
const RESTORE_SRAM_BANK_SIZES = [0, 8, 0x20, 0x20, 0x20, 0x20, 2];
const RESTORE_SRAM_BANKS = [0, 1, 1, 4, 16, 8, 1];

class FastRestoreSender {
    constructor(usb, saveData, log = console.log, { trigger = null, headerTimeoutMs = 0 } = {}) {
        this.usb = usb;
        this.saveData = saveData;      // the .sav file's bytes
        this.log = log;
        this.cancelled = false;
        this.trigger = trigger;
        this.headerTimeoutMs = headerTimeoutMs;
        this.timedOut = false;
    }

    cancel() {
        this.cancelled = true;
    }

    // The save size in bytes for a RAM size code, to check the file against.
    static expectedBytesForSizeIndex(sizeIdx) {
        const sectionsPerBank = RESTORE_SRAM_BANK_SIZES[sizeIdx] || 0;
        const banks = RESTORE_SRAM_BANKS[sizeIdx] || 0;
        return banks * sectionsPerBank * RESTORE_SECTION_SIZE;
    }

    async spiExchange(txByte) {
        await this.usb.writeBytes(new Uint8Array([txByte & 0xFF]));
        const rx = await this.usb.readBytesRaw(1, 5000);
        return rx.length > 0 ? rx[0] : 0;
    }

    // Send bytes and throw away the bytes that come back.
    async spiSendBatch(txBytes) {
        const tx = txBytes instanceof Uint8Array ? txBytes : new Uint8Array(txBytes);
        await this.usb.writeBytes(tx);
        // Still read one byte back for every byte sent, or later reads
        // would pick up these leftover bytes.
        let drained = 0;
        while (drained < tx.length) {
            const rx = await this.usb.readBytesRaw(tx.length - drained, 10000);
            if (!rx || rx.length === 0) return false;
            drained += rx.length;
        }
        return true;
    }

    // Wait for the GBC's restore header, check it, and accept it.
    // Returns { sizeIdx } on success, { error } if refused, or null if
    // cancelled or timed out.
    async readHeader() {
        if (this.trigger === null) this.log("Waiting for restore to start (press SELECT on the GBA)...");
        const started = Date.now();

        while (!this.cancelled) {
            const out = this.trigger !== null ? this.trigger : 0x00;
            if (this.headerTimeoutMs && Date.now() - started > this.headerTimeoutMs) {
                this.timedOut = true;
                return null;
            }
            const rx = await this.spiExchange(out);
            if (rx !== RESTORE_MAGIC) {
                continue; // the restore hasn't started yet
            }

            const type = await this.spiExchange(0x00);
            const sizeIdx = await this.spiExchange(0x00);
            const checksum = await this.spiExchange(0x00);

            const expected = (RESTORE_MAGIC ^ type ^ sizeIdx) & 0xFF;
            if (checksum !== expected) {
                this.log(`Header checksum failed: got 0x${checksum.toString(16)}, expected 0x${expected.toString(16)}`, "error");
                await this.spiExchange(RESTORE_FAIL);
                continue;
            }
            if (type !== RESTORE_TRANSFER) {
                // The GBA started a dump instead of a restore. Refuse it so
                // nothing gets written to the save.
                this.log(`Expected a restore but the GBA started a dump (type ${type}). Press SELECT, not A/B/START.`, "error");
                await this.spiExchange(RESTORE_FAIL);
                return { error: "not-restore" };
            }

            // Check the file is the same size as the cart's save before
            // accepting the header, so a wrong file is never written.
            const expectedBytes = FastRestoreSender.expectedBytesForSizeIndex(sizeIdx);
            if (expectedBytes === 0) {
                this.log(`Cart reports no SRAM (size index ${sizeIdx}) — nothing to restore.`, "error");
                await this.spiExchange(RESTORE_FAIL);
                return { error: "no-sram" };
            }
            if (this.saveData.length !== expectedBytes) {
                this.log(`Save size mismatch: file is ${this.saveData.length} bytes but this cart's SRAM is ${expectedBytes} bytes. Aborting to protect the save.`, "error");
                await this.spiExchange(RESTORE_FAIL);
                return { error: "size-mismatch", expectedBytes };
            }

            await this.spiExchange(RESTORE_OK);
            return { sizeIdx };
        }
        return null;
    }

    // Send one section and its checksum, then read the GBC's answer.
    // Returns true if accepted, false if the GBC asked for it again.
    async sendSection(offset) {
        const section = this.saveData.subarray(offset, offset + RESTORE_SECTION_SIZE);
        let checksum = 0;
        for (let i = 0; i < section.length; i++) checksum = (checksum ^ section[i]) & 0xFF;

        // Send the data in pieces small enough for one 64-byte USB packet each.
        const CHUNK = 56;
        for (let i = 0; i < RESTORE_SECTION_SIZE; i += CHUNK) {
            const ok = await this.spiSendBatch(section.subarray(i, Math.min(i + CHUNK, RESTORE_SECTION_SIZE)));
            if (!ok) return false;
        }

        // Send the checksum byte, then one more byte: what comes back for
        // that one is the GBC's answer for this section.
        await this.spiSendBatch(new Uint8Array([checksum]));
        const ack = await this.spiExchange(0x00);
        return ack === RESTORE_OK;
    }

    // Stop a restore in progress: a section with the wrong checksum 0xCA
    // sends the GBA back to its menu.
    async abort() {
        await this.spiSendBatch(new Uint8Array(RESTORE_SECTION_SIZE));
        await this.spiSendBatch(new Uint8Array([RESTORE_ABORT]));
    }

    async sendRestore(onProgress = null) {
        this.cancelled = false;

        const header = await this.readHeader();
        if (!header || this.cancelled) return null;
        if (header.error) return null;

        const totalBytes = this.saveData.length;
        const totalSections = totalBytes / RESTORE_SECTION_SIZE;
        this.log(`Restoring SRAM: ${(totalBytes / 1024).toFixed(0)} KB (${totalSections} sections)`);

        let sectionsSent = 0;
        for (let offset = 0; offset < totalBytes; offset += RESTORE_SECTION_SIZE) {
            if (this.cancelled) {
                await this.abort();
                return null;
            }

            // Resend the section until the GBC accepts it, up to a limit. A
            // damaged section normally gets through on the next try. Many
            // failures in a row mean the two sides have lost track of where
            // they are, and resending won't fix that, so stop rather than
            // keep writing bad data into the save.
            const MAX_SECTION_RETRIES = 8;
            let accepted = false;
            for (let attempt = 0; attempt < MAX_SECTION_RETRIES && !accepted; attempt++) {
                if (this.cancelled) {
                    await this.abort();
                    return null;
                }
                accepted = await this.sendSection(offset);
                if (!accepted) {
                    this.log(`Section at 0x${offset.toString(16)} rejected — resending (attempt ${attempt + 1}/${MAX_SECTION_RETRIES})...`, "error");
                }
            }
            if (!accepted) {
                this.log(`Section at 0x${offset.toString(16)} failed after ${MAX_SECTION_RETRIES} attempts — aborting restore. The link likely desynced; reconnect and try again.`, "error");
                return null;
            }

            sectionsSent++;
            if (onProgress) onProgress(sectionsSent, totalSections);
        }

        this.log(`Restore complete! ${totalBytes} bytes written to SRAM.`, "success");
        return { bytes: totalBytes };
    }
}

window.FastRestoreSender = FastRestoreSender;
