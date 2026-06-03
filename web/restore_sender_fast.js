/**
 * Fast GBC SRAM Restore Sender
 *
 * Inverse of FastDumpReceiver: writes a .sav back into the cartridge's SRAM.
 * The GBC payload (payload_fast.asm, SELECT branch) announces a restore with
 * a header, then receives each 256-byte section + checksum and writes it to
 * SRAM, ACKing OK/FAIL. We are the SPI master and clock every byte.
 *
 * Header (GBC -> us): [MAGIC=0xF5, type=3 (RESTORE), size_index, checksum]
 * Section (us -> GBC): [256 data bytes, XOR checksum] ; GBC replies OK/FAIL
 *
 * Direction note: GB link SPI is bidirectional. On the data bytes we care
 * about what WE send (the inbound byte is the GBC's echo and is ignored); on
 * the ACK we care about what the GBC sends back.
 */

const RESTORE_MAGIC = 0xF5;
const RESTORE_TRANSFER = 3;           // matches rRESTORE_TRANSFER in payload_fast.asm
const RESTORE_SECTION_SIZE = 0x100;   // 256 bytes per section
const RESTORE_OK = 0x01;
const RESTORE_FAIL = 0x00;

// SRAM size-index tables — must match the dump side (dump_receiver_fast.js)
// and the cart's header byte $0149.
const RESTORE_SRAM_BANK_SIZES = [0, 8, 0x20, 0x20, 0x20, 0x20, 2];
const RESTORE_SRAM_BANKS = [0, 1, 1, 4, 16, 8, 1];

class FastRestoreSender {
    constructor(usb, saveData, log = console.log) {
        this.usb = usb;
        this.saveData = saveData;      // Uint8Array of the .sav to write
        this.log = log;
        this.cancelled = false;
    }

    cancel() {
        this.cancelled = true;
    }

    // Total SRAM bytes implied by a size index (for matching the loaded file).
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

    // Send a batch and discard the inbound echo (used for section data).
    async spiSendBatch(txBytes) {
        const tx = txBytes instanceof Uint8Array ? txBytes : new Uint8Array(txBytes);
        await this.usb.writeBytes(tx);
        // Drain the matching number of echo bytes so reads stay aligned with
        // sends — same balance rule as the dump path.
        let drained = 0;
        while (drained < tx.length) {
            const rx = await this.usb.readBytesRaw(tx.length - drained, 10000);
            if (!rx || rx.length === 0) return false;
            drained += rx.length;
        }
        return true;
    }

    // Poll until the GBC announces the restore header, validate it, and ACK.
    // Returns { sizeIdx } on success, or { error } / null.
    async readHeader() {
        this.log("Waiting for restore to start (press SELECT on the GBA)...");

        while (!this.cancelled) {
            const rx = await this.spiExchange(0x00);
            if (rx !== RESTORE_MAGIC) {
                continue; // GBC still in init (SB=0x10) — keep polling
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
                // The cart entered a dump (A/B/START) instead of a restore
                // (SELECT). Refuse rather than clobber the save.
                this.log(`Expected a restore but the GBA started a dump (type ${type}). Press SELECT, not A/B/START.`, "error");
                await this.spiExchange(RESTORE_FAIL);
                return { error: "not-restore" };
            }

            // Validate the loaded file against the cart's SRAM size BEFORE we
            // OK the header — NAK (loop) if it doesn't match so we never write
            // a mismatched save into a real battery.
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

    // Send one 256-byte section + checksum, then read the GBC's OK/FAIL.
    // Returns true if accepted, false if the GBC asked for a resend.
    async sendSection(offset) {
        const section = this.saveData.subarray(offset, offset + RESTORE_SECTION_SIZE);
        let checksum = 0;
        for (let i = 0; i < section.length; i++) checksum = (checksum ^ section[i]) & 0xFF;

        // Send the 256 data bytes in sub-64-byte chunks (USB max packet),
        // discarding echoes — same chunking the dump path uses.
        const CHUNK = 56;
        for (let i = 0; i < RESTORE_SECTION_SIZE; i += CHUNK) {
            if (this.cancelled) return false;
            const ok = await this.spiSendBatch(section.subarray(i, Math.min(i + CHUNK, RESTORE_SECTION_SIZE)));
            if (!ok) return false;
        }

        // Send the checksum byte (its echo is drained), then clock one more
        // exchange whose RETURN byte is the GBC's OK/FAIL verdict on the section.
        await this.spiSendBatch(new Uint8Array([checksum]));
        const ack = await this.spiExchange(0x00);
        return ack === RESTORE_OK;
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
            if (this.cancelled) return null;

            // Retry the section until the GBC accepts it (checksum match), but
            // cap the attempts. A genuine checksum NAK clears in a retry or two;
            // a long run of failures means a hard timeout / desync, where the
            // byte stream can no longer be realigned by resending — bail instead
            // of spinning forever (and writing more garbage into the battery).
            const MAX_SECTION_RETRIES = 8;
            let accepted = false;
            for (let attempt = 0; attempt < MAX_SECTION_RETRIES && !accepted; attempt++) {
                if (this.cancelled) return null;
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
