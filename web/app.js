/**
 * GBA Cart Dumper — Web Interface
 * Sends multiboot ROM to GBA, then receives cart dump via GBC link protocol.
 */

const usb = new UsbConnection();
let dumpReceiver = null;
let romData = null;

function log(message, type = "info") {
    const logEl = document.getElementById("log");
    const entry = document.createElement("div");
    const time = new Date().toLocaleTimeString();
    entry.className = `log-${type}`;
    entry.textContent = `[${time}] ${message}`;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
    document.getElementById("status").textContent = text;
}

let dumpRunning = false;

function updateButtons() {
    const connected = usb.isConnected;
    document.getElementById("connectBtn").textContent = connected ? "Disconnect" : "Connect USB Adapter";
    document.getElementById("startBtn").disabled = !connected || !romData || dumpRunning;
    document.getElementById("dumpOnlyBtn").disabled = !connected || dumpRunning;
    document.getElementById("cancelBtn").disabled = !dumpReceiver;
}

function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

async function loadMultibootROM() {
    try {
        const resp = await fetch("gba-switch-to-gbc_mb.gba");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        romData = new Uint8Array(await resp.arrayBuffer());
        log(`Multiboot ROM loaded: ${formatSize(romData.length)}`);
        updateButtons();
    } catch (e) {
        log("Failed to load multiboot ROM. Make sure gba-switch-to-gbc_mb.gba is in the web folder.", "error");
    }
}

async function toggleConnect() {
    if (usb.isConnected) {
        if (dumpReceiver) dumpReceiver.cancel();
        await usb.disconnect();
        log("Disconnected.");
        setStatus("Disconnected");
    } else {
        try {
            setStatus("Connecting...");
            await usb.connect();
            const fwType = usb.isNewFirmware ? "GBLink Unified" : "Reconfigurable";
            log(`Connected! Firmware: ${fwType}`, "success");
            setStatus("Connected");
        } catch (e) {
            log(`Connection failed: ${e.message}`, "error");
            setStatus("Connection failed");
        }
    }
    updateButtons();
}

async function startDump() {
    if (!usb.isConnected || !romData) return;

    document.getElementById("startBtn").disabled = true;
    document.getElementById("downloadSection").style.display = "none";
    const progressBar = document.getElementById("progressFill");
    const progressText = document.getElementById("progressText");
    progressBar.style.width = "0%";

    try {
        // Phase 1: Multiboot
        setStatus("Sending multiboot ROM...");
        log("--- Phase 1: Multiboot ---");

        if (usb.isNewFirmware) {
            await usb.setMode(MODE.GB_LINK);
            await delay(100);
        }
        await usb.setTimingConfig(36, 4);

        if (!usb.isNewFirmware) {
            await delay(10);
            while (true) {
                try {
                    const data = await usb.readBytesRaw(64);
                    if (!data || data.length === 0) break;
                    if (data.length < 64) break;
                } catch (e) { break; }
            }
        }

        const mbResult = await GBAMultiboot.multiboot(usb, romData, log);
        if (!mbResult) {
            log("Multiboot failed!", "error");
            setStatus("Multiboot failed");
            updateButtons();
            return;
        }

        // Phase 2: Wait for GBC mode and reconfigure for 8-bit SPI
        setStatus("Waiting for GBA to switch to GBC mode...");
        log("--- Phase 2: Dump ---");
        log("Reconfiguring for GBC link (8-bit SPI)...");

        // Wait for GBA to boot the ROM and switch to GBC mode
        await delay(2000);

        // Reconfigure timing: 1 byte per SPI exchange (already in GB Link mode from multiboot).
        // Do NOT drain stale USB data — on new firmware, timed-out transferIn requests
        // leave stale pending reads that silently consume real SPI responses.
        await usb.setTimingConfig(50, 1);
        await delay(100);

        await runDumpLoop();

    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("Error");
        dumpReceiver = null;
    }
    dumpRunning = false;
    updateButtons();
}

async function startDumpOnly() {
    if (!usb.isConnected) return;

    dumpRunning = true;
    updateButtons();

    const progressBar = document.getElementById("progressFill");
    const progressText = document.getElementById("progressText");
    progressBar.style.width = "0%";

    try {
        log("--- Dump Only (multiboot already sent) ---");

        if (usb.isNewFirmware) {
            await usb.setMode(MODE.GB_LINK);
            await delay(100);
        }
        await usb.setTimingConfig(50, 1);
        await delay(100);

        await runDumpLoop();

    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("Error");
        dumpReceiver = null;
    }
    dumpRunning = false;
    updateButtons();
}

async function runDumpLoop() {
    const progressBar = document.getElementById("progressFill");
    const progressText = document.getElementById("progressText");
    let dumpCount = 0;

    while (usb.isConnected) {
        setStatus("Waiting for dump...");
        progressBar.style.width = "0%";
        progressText.textContent = dumpCount === 0 ? "Waiting for first dump..." : "Ready for next dump — swap cartridge and press a button on the GBA";

        dumpReceiver = new DumpReceiver(usb, log);
        updateButtons();

        const startTime = Date.now();
        const result = await dumpReceiver.receiveDump((done, total, bank, banks) => {
            setStatus("Receiving dump...");
            const pct = Math.floor((done / total) * 100);
            progressBar.style.width = `${pct}%`;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const rate = done > 0 ? (done * SECTION_SIZE) / elapsed : 0;
            const remaining = rate > 0 ? Math.floor(((total - done) * SECTION_SIZE) / rate) : 0;
            const elapsedStr = formatTime(elapsed);
            const etaStr = done > 2 ? formatTime(remaining) : "calculating...";
            progressText.textContent = `Bank ${bank + 1}/${banks} — ${pct}% — ${elapsedStr} elapsed — ETA: ${etaStr}`;
        });

        dumpReceiver = null;
        updateButtons();

        if (result) {
            dumpCount++;
            log(`Dump #${dumpCount} complete!`, "success");
            progressBar.style.width = "100%";
            progressText.textContent = "Complete!";
            offerDownload(result.data, result.type);
        } else {
            setStatus("Dump cancelled or failed");
            break;
        }
    }
}

function offerDownload(data, type) {
    const ext = type === "ROM" ? ".gb" : ".sav";
    const filename = `dump_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}${ext}`;

    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    const section = document.getElementById("downloadSection");
    section.style.display = "block";

    const link = document.createElement("a");
    link.className = "btn btn-success";
    link.href = url;
    link.download = filename;
    link.textContent = `${filename} (${formatSize(data.length)})`;
    section.appendChild(link);

    log(`Ready to download: ${filename} (${formatSize(data.length)})`, "success");
}

function cancelDump() {
    if (dumpReceiver) {
        dumpReceiver.cancel();
        log("Cancelling...", "error");
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

// SECTION_SIZE defined in dump_receiver.js

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("connectBtn").addEventListener("click", toggleConnect);
    document.getElementById("startBtn").addEventListener("click", startDump);
    document.getElementById("dumpOnlyBtn").addEventListener("click", startDumpOnly);
    document.getElementById("cancelBtn").addEventListener("click", cancelDump);

    if (!navigator.usb) {
        document.getElementById("browserWarning").style.display = "block";
    }

    loadMultibootROM();
    updateButtons();
});
