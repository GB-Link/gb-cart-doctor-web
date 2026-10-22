/**
 * Sends a program to a GBA over the link cable (multiboot), the same way a
 * second GBA would. Works with both the old (reconfigurable) and the new
 * (unified) GB-Link firmware.
 */

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function readAll(usb) {
    await delay(10);
    let output = 0;
    while (true) {
        try {
            const data = await usb.readBytesRaw(64);
            if (!data || data.length === 0) break;
            for (let i = 0; i < data.length; i++) output = (output << 8) | data[i];
            if (data.length < 64) break;
        } catch (e) { break; }
    }
    return output >>> 0;
}


async function Spi32(usb, val) {
    const tx = new Uint8Array([
        (val >>> 24) & 0xFF,
        (val >>> 16) & 0xFF,
        (val >>> 8) & 0xFF,
        val & 0xFF
    ]);
    await usb.writeBytes(tx);
    const rx = await usb.readBytesRaw(4, 2000);
    if (!rx || rx.length < 4) return 0;
    return ((rx[0] << 24) | (rx[1] << 16) | (rx[2] << 8) | rx[3]) >>> 0;
}

/**
 * Send several 32-bit words in one USB transfer. The GB-Link clocks them out
 * one after another and returns all the replies together, which saves a USB
 * round trip per word.
 */
async function Spi32Batch(usb, values) {
    const count = values.length;
    const txBatch = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
        const val = values[i];
        txBatch[i * 4] = (val >>> 24) & 0xFF;
        txBatch[i * 4 + 1] = (val >>> 16) & 0xFF;
        txBatch[i * 4 + 2] = (val >>> 8) & 0xFF;
        txBatch[i * 4 + 3] = val & 0xFF;
    }
    await usb.writeBytes(txBatch);

    // The reply can arrive split over several USB packets.
    const expectedBytes = count * 4;
    const chunks = [];
    let totalReceived = 0;
    while (totalReceived < expectedBytes) {
        const chunk = await usb.readBytesRaw(expectedBytes - totalReceived, 2000);
        if (!chunk || chunk.length === 0) return null;
        chunks.push(chunk);
        totalReceived += chunk.length;
    }

    const rxBatch = new Uint8Array(totalReceived);
    let offset = 0;
    for (const chunk of chunks) {
        rxBatch.set(chunk, offset);
        offset += chunk.length;
    }

    const results = [];
    for (let i = 0; i < count; i++) {
        results.push(((rxBatch[i * 4] << 24) | (rxBatch[i * 4 + 1] << 16) |
            (rxBatch[i * 4 + 2] << 8) | rxBatch[i * 4 + 3]) >>> 0);
    }
    return results;
}

// Most words per USB batch: 14 × 4 = 56 bytes. Staying under the 64-byte USB
// packet size avoids the extra empty packet a full 64-byte write needs.
const BATCH_WORDS = 14;

async function multiboot(usb, romData, log = console.log) {
    const fdata = new Uint8Array(romData);
    let fsize = fdata.length;

    if (fsize > 0x40000) {
        log("File size Error Max 256KB", "error");
        return false;
    }

    log(`ROM size: ${fsize} bytes (${(fsize / 1024).toFixed(1)} KB)`);

    const paddedData = new Uint8Array(fsize + 0x10);
    paddedData.set(fdata);

    log("Configuring firmware for GBA multiboot...");

    if (usb.isNewFirmware) {
        // New firmware: switch to GB Link mode before setting the timing.
        await usb.setMode(MODE.GB_LINK);
        await delay(100); // give the firmware time to switch
    }

    // 36 µs between transfers, 4 bytes (one 32-bit word) per transfer.
    await usb.setTimingConfig(36, 4);

    // Old firmware sends the timing setup over the data channel, and the reply
    // to it has to be read and thrown away. New firmware takes it on the
    // command channel and sends nothing back. Reading anyway would leave an
    // unfinished USB read waiting, and that read would swallow the GBA's
    // first real reply.
    if (!usb.isNewFirmware) {
        await readAll(usb);
    }

    log("Waiting for GBA... Turn on your GBA with the link cable connected.");

    let recv, attempts = 0;
    do {
        const raw = await Spi32(usb, 0x6202);
        recv = raw >>> 16;
        await delay(10);
        attempts++;
        if (attempts <= 5 || attempts % 100 === 0) {
            log(`SPI poll #${attempts}: sent 0x6202, got 0x${raw.toString(16).padStart(8, '0')} (upper=0x${recv.toString(16)})`, "info");
        }
        if (attempts > 6000) { log("Timeout", "error"); return false; }
    } while (recv !== 0x7202);

    log("GBA detected! Starting transfer...", "success");

    await Spi32(usb, 0x6102);

    // Send the ROM header (the first 0xC0 bytes) unencrypted, 16 bits at a time.
    const headerWords = [];
    for (let i = 0; i < 0xC0; i += 2) {
        headerWords.push(paddedData[i] | (paddedData[i + 1] << 8));
    }
    for (let i = 0; i < headerWords.length; i += BATCH_WORDS) {
        const batch = headerWords.slice(i, i + BATCH_WORDS);
        const results = await Spi32Batch(usb, batch);
        if (!results) { log("Header transfer failed", "error"); return false; }
    }

    await Spi32(usb, 0x6200);
    await Spi32(usb, 0x6202);
    await Spi32(usb, 0x63D1);

    const token = await Spi32(usb, 0x63D1);
    if ((token >>> 24) !== 0x73) { log("Failed handshake!", "error"); return false; }

    log("Handshake successful!", "success");

    // Agree on the encryption seed and checksum values with the GBA BIOS.
    let crcA = (token >>> 16) & 0xFF;
    let seed = (0xFFFF00D1 | (crcA << 8)) >>> 0;
    crcA = (crcA + 0x0F) & 0xFF;

    await Spi32(usb, 0x6400 | crcA);

    fsize += 0x0F;
    fsize &= ~0x0F;

    const token2 = await Spi32(usb, ((fsize - 0x190) / 4) >>> 0);
    const crcB = (token2 >>> 16) & 0xFF;
    let crcC = 0xC387;

    log(`Sending data (${fsize} bytes)...`);

    // Send the rest of the program, encrypted, a batch at a time.
    let lastProgress = -1;
    for (let i = 0xC0; i < fsize;) {
        const wordsInBatch = Math.min(BATCH_WORDS, (fsize - i) / 4);
        const batchValues = [];

        for (let w = 0; w < wordsInBatch; w++) {
            const offset = i + w * 4;

            let dat = paddedData[offset] |
                (paddedData[offset + 1] << 8) |
                (paddedData[offset + 2] << 16) |
                ((paddedData[offset + 3] << 24) >>> 0);
            dat = dat >>> 0;

            // Fold the word into the checksum the BIOS checks at the end.
            let tmp = dat;
            for (let b = 0; b < 32; b++) {
                const bit = (crcC ^ tmp) & 1;
                crcC = (crcC >>> 1) ^ (bit ? 0xC37B : 0);
                tmp = tmp >>> 1;
            }

            // Encrypt it. The multiply needs BigInt: the product doesn't fit
            // in a JavaScript number exactly.
            seed = Number((BigInt(seed) * 0x6F646573n + 1n) & 0xFFFFFFFFn);
            dat = (seed ^ dat ^ ((0xFE000000 - offset) >>> 0) ^ 0x43202F2F) >>> 0;

            batchValues.push(dat);
        }

        const responses = await Spi32Batch(usb, batchValues);
        if (!responses) {
            log(`Read timeout during batch transfer at byte ${i}`, "error");
            return false;
        }

        // The GBA answers each word with the low 16 bits of its offset.
        for (let w = 0; w < wordsInBatch; w++) {
            const offset = i + w * 4;
            const chk = (responses[w] >>> 16) & 0xFFFF;
            if (chk !== (offset & 0xFFFF)) {
                log(`Transmission error at byte ${offset}: expected 0x${(offset & 0xFFFF).toString(16)}, got 0x${chk.toString(16)}`, "error");
                return false;
            }
        }

        i += wordsInBatch * 4;

        const progress = Math.floor(((i - 0xC0) / (fsize - 0xC0)) * 10);
        if (progress > lastProgress) {
            log(`Progress: ${progress * 10}%`, "info");
            lastProgress = progress;
        }
    }

    log("Data sent successfully!", "success");

    // Finish the checksum with the handshake values.
    let tmp = ((0xFFFF0000 | (crcB << 8) | crcA) >>> 0);
    for (let b = 0; b < 32; b++) {
        const bit = (crcC ^ tmp) & 1;
        crcC = (crcC >>> 1) ^ (bit ? 0xC37B : 0);
        tmp = tmp >>> 1;
    }

    // Tell the GBA we're done, wait for it to agree, then send the checksum.
    log("Waiting for GBA acknowledgment...");
    await Spi32(usb, 0x0065);

    do {
        recv = (await Spi32(usb, 0x0065)) >>> 16;
        await delay(10);
    } while (recv !== 0x0075);

    await Spi32(usb, 0x0066);
    await Spi32(usb, crcC & 0xFFFF);

    log("Multiboot complete! ROM loaded.", "success");
    await delay(1000);
    return true;
}

window.GBAMultiboot = { multiboot };
