/**
 * GBC Cart Dump Receiver — WebUSB port of dump_reader.py
 *
 * Protocol: The GBA multiboot payload switches the GBA to GBC mode,
 * then dumps the inserted GB/GBC cartridge over the link cable.
 * Data is sent as pairs of nybbles (4-bit values) with echo verification.
 */

const ROM_TRANSFER_VAL = 1;
const SRAM_TRANSFER_VAL = 2;
const ROM_BANK_SIZE = 0x40;    // 64 sections per bank (256 bytes each = 16KB)
const SECTION_SIZE = 0x100;     // 256 bytes per section
const NORMAL_NYBBLE = 0x10;
const CHECK_NYBBLE = 0x40;

// Cart header byte → number of ROM banks
const ROM_BANKS = [2,4,8,16,32,64,128,256,512,0,0,0,0,0,0,0,0,0,72,80,96];
// SRAM type → sections per bank
const SRAM_BANK_SIZES = [0,8,0x20,0x20,0x20,0x20,2];
// SRAM type → number of banks
const SRAM_BANKS = [0,1,1,4,16,8,1];

class DumpReceiver {
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

    async readSection(data) {
        const buf = [];
        let checked = false;
        let half = false;

        while (!checked) {
            if (this.cancelled) return null;

            for (let i = 0; i < 2; i++) {
                let accepted = false;
                while (!accepted) {
                    if (this.cancelled) return null;
                    const recv = await this.spiExchange(data[i]);
                    const highRecv = recv & 0xF0;

                    if (highRecv === CHECK_NYBBLE || highRecv === NORMAL_NYBBLE) {
                        if (highRecv === CHECK_NYBBLE) {
                            if (half) checked = true;
                            half = true;
                        }
                        accepted = true;
                        data[i] = recv & 0x0F;
                    }
                }
            }

            const val = (data[1] | (data[0] << 4));
            if (checked) {
                if (val === 0) {
                    checked = false;
                    buf.length = 0;
                }
            } else {
                buf.push(val);
                if (half) {
                    await this.spiExchange(data[0]);
                }
            }
            half = false;
        }

        return buf.slice(0, buf.length - 1);
    }

    async receiveDump(onProgress = null) {
        this.cancelled = false;
        this.log("Waiting for dump to start...");

        const data = [0, 0];
        const header = await this.readSection(data);
        if (!header || this.cancelled) return null;

        // Strip leading zeros — the adapter clocks SPI while waiting for the user
        // to press dump on the GBA, accumulating 0x00 bytes (from SB=0x10 init value).
        // Real header starts with transfer type (1=ROM, 2=SRAM), never 0.
        while (header.length > 2 && header[0] === 0) {
            header.shift();
        }
        if (header.length > 2) {
            this.log("Transfer was previously interrupted. Please reset the GameBoy!", "error");
            return null;
        }
        if (header.length < 2) {
            this.log("Invalid header received.", "error");
            return null;
        }

        const transferType = header[0];
        const transferSize = header[1];

        let typeName, size, banks;
        if (transferType === ROM_TRANSFER_VAL) {
            typeName = "ROM";
            size = ROM_BANK_SIZE;
            banks = ROM_BANKS[transferSize] || 0;
        } else if (transferType === SRAM_TRANSFER_VAL) {
            typeName = "SRAM";
            size = SRAM_BANK_SIZES[transferSize] || 0;
            banks = SRAM_BANKS[transferSize] || 0;
        } else {
            this.log(`Unknown transfer type: ${transferType}`, "error");
            return null;
        }

        if (banks === 0 || size === 0) {
            this.log("Nothing to dump!", "error");
            return null;
        }

        const totalSections = banks * size;
        const totalBytes = totalSections * SECTION_SIZE;
        this.log(`Dumping ${typeName}: ${banks} bank(s), ${size} section(s)/bank, ${(totalBytes / 1024).toFixed(0)} KB total`);

        const result = [];
        let sectionsRead = 0;

        for (let bank = 0; bank < banks; bank++) {
            for (let section = 0; section < size; section++) {
                if (this.cancelled) return null;

                const sectionData = await this.readSection(data);
                if (!sectionData || this.cancelled) return null;
                result.push(...sectionData);

                sectionsRead++;
                if (onProgress) {
                    onProgress(sectionsRead, totalSections, bank, banks);
                }
            }
            this.log(`Bank ${bank + 1}/${banks} complete`);
        }

        this.log(`Dump complete! ${result.length} bytes received.`, "success");
        return { data: new Uint8Array(result), type: typeName };
    }
}

window.DumpReceiver = DumpReceiver;
