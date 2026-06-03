/**
 * GBLink Cart Doctor — Web Interface
 * Sends multiboot ROM to GBA, then receives cart dump via GBC link protocol.
 */

let usb = new UsbConnection();
let dumpReceiver = null;
let restoreSender = null;
let romData = null;
let restoreData = null;   // Uint8Array of a loaded .sav awaiting restore

// Prefer WebUSB; fall back to WebSerial (Firefox 151+, or Chromium with WebUSB disabled).
const hasUsb = ('usb' in navigator);
const hasSerial = ('serial' in navigator);
const transport = hasUsb ? 'usb' : (hasSerial ? 'serial' : null);

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
// Cooperative cancel for the dump path. Checked between every phase (multiboot,
// settle delay, poll loop) so a restore can stop a dump that is still in setup
// — not just one parked in the idle header poll. dumpReceiver.cancel() only
// unwinds the receiver; this also short-circuits the phases before it exists.
let dumpCancelRequested = false;

function updateButtons() {
    const connected = usb.isConnected;
    const connectBtn = document.getElementById("connectBtn");
    const connectLabel = transport === 'serial' ? "Connect Serial" : "Connect USB";
    connectBtn.textContent = connected ? "Disconnect" : connectLabel;
    connectBtn.disabled = !transport;
    document.getElementById("startBtn").disabled = !connected || !romData || dumpRunning || !!restoreSender;
    document.getElementById("dumpOnlyBtn").disabled = !connected || dumpRunning || !!restoreSender;
    // Restore may take over an idle (polling) dump loop, so it is NOT gated on
    // dumpRunning — only on an in-flight restore.
    document.getElementById("restoreBtn").disabled = !connected || !restoreData || !!restoreSender;
    // Cancel is available for the whole dump session (incl. the uncancellable-mid-flight
    // multiboot, where it takes effect once multiboot returns) as well as for an
    // active receiver or restore — so a wedged setup is never a dead end.
    document.getElementById("cancelBtn").disabled = !dumpRunning && !dumpReceiver && !restoreSender;
}

function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

async function loadMultibootROM() {
    try {
        // Bypass the HTTP cache — a stale cached ROM is silently the old build.
        const resp = await fetch("gba-switch-to-gbc_mb.gba", { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        romData = new Uint8Array(await resp.arrayBuffer());
        // Log a short fingerprint so we can confirm which build is actually
        // being multibooted (the GBA runs the LAST-multibooted payload; reloads
        // alone don't update it — only "Send Multiboot" does).
        let h = 0;
        for (let i = 0; i < romData.length; i++) h = ((h * 31) + romData[i]) >>> 0;
        log(`Multiboot ROM loaded: ${formatSize(romData.length)} (build ${h.toString(16).padStart(8, '0')})`);
        updateButtons();
    } catch (e) {
        log("Failed to load multiboot ROM. Make sure gba-switch-to-gbc_mb.gba is in the web folder.", "error");
    }
}

async function toggleConnect(kind = 'usb') {
    if (usb.isConnected) {
        if (dumpReceiver) dumpReceiver.cancel();
        await usb.disconnect();
        log("Disconnected.");
        setStatus("Disconnected");
    } else {
        try {
            usb = (kind === 'serial') ? new SerialConnection() : new UsbConnection();
            setStatus("Connecting...");
            await usb.connect();
            const fwType = (kind === 'serial')
                ? "GBLink Unified (WebSerial)"
                : (usb.isNewFirmware ? "GBLink Unified" : "Reconfigurable");
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
    if (!usb.isConnected || !romData || dumpRunning) return;

    // Mark the session busy so the Restore button (and a second dump) stay
    // disabled — runDumpLoop() is an infinite poll, and a concurrent restore
    // would clock the same GBC and corrupt both streams.
    dumpRunning = true;
    dumpCancelRequested = false;
    updateButtons();
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
            // Fall through to the shared dumpRunning=false cleanup below — an
            // early return here would leave the session wedged as "busy".
        } else if (!dumpCancelRequested) {
            // Phase 2: Wait for GBC mode and reconfigure for 8-bit SPI
            setStatus("Waiting for GBA to switch to GBC mode...");
            log("--- Phase 2: Dump ---");
            log("Reconfiguring for GBC link (8-bit SPI)...");

            // Wait for GBA to boot the ROM and switch to GBC mode
            await delay(2000);

            // Reconfigure timing for fast protocol: 1 byte per SPI exchange, 50µs
            // inter-byte delay (the GBC needs time to prepare each byte).
            // Do NOT drain stale USB data — on new firmware, timed-out transferIn
            // requests leave stale pending reads that silently consume real SPI
            // responses.
            if (!dumpCancelRequested) {
                await usb.setTimingConfig(50, 1);
                await delay(100);
                await runDumpLoop();
            }
        }

    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("Error");
        dumpReceiver = null;
    }
    dumpRunning = false;
    updateButtons();
}

async function startDumpOnly() {
    if (!usb.isConnected || dumpRunning) return;

    dumpRunning = true;
    dumpCancelRequested = false;
    updateButtons();

    const progressBar = document.getElementById("progressFill");
    const progressText = document.getElementById("progressText");
    progressBar.style.width = "0%";

    try {
        log("--- Listening (homebrew already loaded, multiboot skipped) ---");

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

    while (usb.isConnected && !dumpCancelRequested) {
        setStatus("Waiting for dump...");
        progressBar.style.width = "0%";
        progressText.textContent = dumpCount === 0 ? "Waiting for first dump..." : "Ready for next dump — swap cartridge and press a button on the GBA";

        dumpReceiver = new FastDumpReceiver(usb, log);
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
    // Stop the dump in whatever phase it is in (setup or idle poll), not only
    // when a receiver object exists.
    dumpCancelRequested = true;
    if (dumpReceiver) {
        dumpReceiver.cancel();
        log("Cancelling...", "error");
    }
    if (restoreSender) {
        restoreSender.cancel();
        log("Cancelling restore...", "error");
    }
}

function loadRestoreFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        restoreData = new Uint8Array(reader.result);
        log(`Save loaded: ${file.name} (${formatSize(restoreData.length)})`);
        updateButtons();
    };
    reader.onerror = () => {
        log("Failed to read save file.", "error");
        restoreData = null;
        updateButtons();
    };
    reader.readAsArrayBuffer(file);
}

// Signal a running dump loop to stop and wait for it to fully unwind, so the
// restore has exclusive use of the single link to the GBC. Returns true once the
// dump has fully stopped, false if it did not within the timeout (in which case
// the caller must NOT take the link — both would clock the GBC at once).
// Multiboot cannot be interrupted mid-flight, so allow several seconds for the
// current phase to finish; dumpRunning is cleared when startDump/startDumpOnly
// returns.
async function stopDumpLoop() {
    if (!dumpRunning) return true;
    dumpCancelRequested = true;
    if (dumpReceiver) dumpReceiver.cancel();
    for (let i = 0; i < 240 && dumpRunning; i++) await delay(50); // up to ~12s
    return !dumpRunning;
}

async function startRestore() {
    if (!usb.isConnected || !restoreData || restoreSender) return;

    // Writing is destructive — make the user confirm.
    if (!window.confirm(
        `This will OVERWRITE the save on the inserted cartridge with the loaded ` +
        `${formatSize(restoreData.length)} file. This cannot be undone. Continue?`)) {
        return;
    }

    // Claim the restore gate SYNCHRONOUSLY here — BEFORE the stopDumpLoop() await
    // below — so a second Restore click cannot slip past the guard at the top of
    // this function while we are stopping the dump, which would start two writers
    // on the one link. (confirm() is blocking, so no click interleaves before
    // this assignment.)
    restoreSender = new FastRestoreSender(usb, restoreData, log);
    updateButtons();

    // If a dump poll loop is running (e.g. right after multiboot), stop it
    // first — two loops clocking the same GBC corrupt both streams. Bail if it
    // refuses to stop rather than fighting it for the link.
    if (dumpRunning) {
        log("Stopping dump loop to begin restore...");
        const stopped = await stopDumpLoop();
        if (!stopped) {
            log("Could not stop the running dump in time — press Cancel, then Restore.", "error");
            setStatus("Dump still running");
            restoreSender = null;
            updateButtons();
            return;
        }
    }

    const progressBar = document.getElementById("progressFill");
    const progressText = document.getElementById("progressText");
    progressBar.style.width = "0%";

    try {
        log("--- Restore Save (write to cart) ---");

        if (usb.isNewFirmware) {
            await usb.setMode(MODE.GB_LINK);
            await delay(100);
        }
        // Same fast-protocol timing the dump uses: 1 byte/exchange, 50µs gap.
        await usb.setTimingConfig(50, 1);
        await delay(100);

        setStatus("Waiting for restore — press SELECT on the GBA...");
        progressText.textContent = "Press SELECT on the GBA to begin restore";

        const startTime = Date.now();
        const result = await restoreSender.sendRestore((done, total) => {
            setStatus("Writing save to cart...");
            const pct = Math.floor((done / total) * 100);
            progressBar.style.width = `${pct}%`;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            progressText.textContent = `Restoring — ${pct}% — ${formatTime(elapsed)} elapsed`;
        });

        restoreSender = null;

        if (result) {
            progressBar.style.width = "100%";
            progressText.textContent = "Restore complete!";
            setStatus("Restore complete");
            log("Save restored successfully. Power-cycle the cartridge to verify.", "success");
        } else {
            setStatus("Restore cancelled or failed");
        }
    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("Error");
        restoreSender = null;
    }
    // Note: the restore does not own dumpRunning — stopDumpLoop() above already
    // cleared it. Touching it here would be wrong if the dump weren't stopped.
    updateButtons();
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
    document.getElementById("connectBtn").addEventListener("click", () => toggleConnect(transport));
    document.getElementById("startBtn").addEventListener("click", startDump);
    document.getElementById("dumpOnlyBtn").addEventListener("click", startDumpOnly);
    document.getElementById("restoreBtn").addEventListener("click", startRestore);
    document.getElementById("cancelBtn").addEventListener("click", cancelDump);
    document.getElementById("restoreFile").addEventListener("change", (e) => {
        loadRestoreFile(e.target.files[0]);
    });

    if (!transport) {
        document.getElementById("browserWarning").style.display = "block";
    }

    loadMultibootROM();
    updateButtons();
});
