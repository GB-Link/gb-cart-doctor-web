/**
 * GBLink Cart Doctor — Web Interface
 * Sends multiboot ROM to GBA, then receives cart dump via GBC link protocol.
 */

let usb = new UsbConnection();
let dumpReceiver = null;
let restoreSender = null;
let romData = null;
let restoreData = null;   // Uint8Array of a loaded .sav awaiting restore

// --- GBA cartridge state ---
let gbaRomData = null;        // gba-cart-dumper_mb.gba multiboot image
let gbaClient = null;         // GbaCartClient once a payload session exists
let gbaBusy = false;          // a GBA operation is holding the link
let gbaReady = false;         // payload answered a ping; action buttons live
let gbaRestoreData = null;    // Uint8Array of a loaded GBA .sav
let gbaCartInfo = null;       // last readInfo() result (names the downloads)
// The GBA protocol needs 3.3V + 32-bit timing. GB/GBC dumps/restores switch
// the link to 5V + byte timing, so their entry points clear this flag and the
// next GBA action reconfigures the link first.
let gbaLinkConfigured = false;

// Which workflow is on screen: "gb" | "gba" | null (nothing picked yet).
// Purely presentational — a GBA payload session survives switching away.
let cartMode = null;

function setCartMode(mode) {
    if (mode !== "gb" && mode !== "gba") return;
    // Don't swap the visible controls out from under a running operation
    // (the selector buttons are also disabled while one runs).
    if (dumpRunning || restoreSender || gbaBusy) return;
    cartMode = mode;
    try { localStorage.setItem("cartDoctorMode", mode); } catch (e) { /* private browsing */ }
    document.getElementById("gbSections").style.display = mode === "gb" ? "block" : "none";
    document.getElementById("gbaSections").style.display = mode === "gba" ? "block" : "none";
    document.getElementById("modeGbBtn").classList.toggle("active", mode === "gb");
    document.getElementById("modeGbaBtn").classList.toggle("active", mode === "gba");
    updateButtons();
}

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
    document.getElementById("startBtn").disabled = !connected || !romData || dumpRunning || !!restoreSender || gbaBusy;
    document.getElementById("dumpOnlyBtn").disabled = !connected || dumpRunning || !!restoreSender || gbaBusy;
    // Restore may take over an idle (polling) dump loop, so it is NOT gated on
    // dumpRunning — only on an in-flight restore (or a GBA op on the link).
    document.getElementById("restoreBtn").disabled = !connected || !restoreData || !!restoreSender || gbaBusy;
    // Cancel is available for the whole dump session (incl. the uncancellable-mid-flight
    // multiboot, where it takes effect once multiboot returns) as well as for an
    // active receiver or restore — so a wedged setup is never a dead end.
    document.getElementById("cancelBtn").disabled = !dumpRunning && !dumpReceiver && !restoreSender && !gbaBusy;

    // GBA section: sending the dumper (or adopting a running one) needs an
    // idle link; the action buttons additionally need a live payload session.
    const linkBusy = dumpRunning || !!restoreSender || gbaBusy;
    document.getElementById("modeGbBtn").disabled = linkBusy;
    document.getElementById("modeGbaBtn").disabled = linkBusy;
    document.getElementById("gbaSendBtn").disabled = !connected || !gbaRomData || linkBusy;
    document.getElementById("gbaLoadedBtn").disabled = !connected || linkBusy;
    const gbaActionsOff = !connected || linkBusy || !gbaReady;
    document.getElementById("gbaInfoBtn").disabled = gbaActionsOff;
    document.getElementById("gbaDumpRomBtn").disabled = gbaActionsOff;
    document.getElementById("gbaDumpSaveBtn").disabled = gbaActionsOff;
    document.getElementById("gbaBiosBtn").disabled = gbaActionsOff;
    document.getElementById("gbaEraseBtn").disabled = gbaActionsOff;
    document.getElementById("gbaRestoreBtn").disabled = gbaActionsOff || !gbaRestoreData;
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

async function loadGbaDumperROM() {
    try {
        const resp = await fetch("gba-cart-dumper_mb.gba", { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        gbaRomData = new Uint8Array(await resp.arrayBuffer());
        let h = 0;
        for (let i = 0; i < gbaRomData.length; i++) h = ((h * 31) + gbaRomData[i]) >>> 0;
        log(`GBA dumper ROM loaded: ${formatSize(gbaRomData.length)} (build ${h.toString(16).padStart(8, '0')})`);
        updateButtons();
    } catch (e) {
        log("Failed to load the GBA dumper ROM (gba-cart-dumper_mb.gba) — GBA cartridge features disabled.", "error");
    }
}

function resetGbaSession() {
    // The client wraps a specific transport object — a reconnect (which
    // constructs a new UsbConnection/SerialConnection) invalidates it.
    if (gbaClient) gbaClient.cancel();
    gbaClient = null;
    gbaReady = false;
    gbaCartInfo = null;
    gbaLinkConfigured = false;
    const panel = document.getElementById("gbaCartPanel");
    if (panel) panel.style.display = "none";
}

async function toggleConnect(kind = 'usb') {
    if (usb.isConnected) {
        if (dumpReceiver) dumpReceiver.cancel();
        resetGbaSession();
        await usb.disconnect();
        log("Disconnected.");
        setStatus("Disconnected");
    } else {
        try {
            resetGbaSession();
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
    gbaLinkConfigured = false; // this path moves the link to 5V / byte timing
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
        // Multiboot uses the GBA-native serial, which expects a 3.3V link. A
        // prior dump/restore leaves the device at 5V, so reset to 3.3V here so
        // every multiboot runs at the validated voltage regardless of what ran
        // before. (GBC-mode dump/restore re-switch to 5V in their own phases.)
        await usb.setVoltage('3v3');
        await delay(100);
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
                // The GBC-mode transfer is clocked by the GB-Link as SPI master,
                // and the GBA-in-GBC-mode serial slave will not sync to that clock
                // at 3.3V — bytes never shift (the poll sees only 0x00/0xFF). A
                // real GB/GBC link is 5V, so drive the dump at 5V for adequate
                // clock/data edge margin. Multiboot above stays at 3.3V (it uses
                // the GBA-native serial, which clocks fine at 3.3V).
                await usb.setVoltage('5v');
                log("Switched link to 5V for GBC dump");
                await delay(100);
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
    gbaLinkConfigured = false; // this path moves the link to 5V / byte timing
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
        // Drive the GBC dump at 5V (real GB/GBC link voltage). See the matching
        // note in startDump() — 3.3V will not clock the GBC-mode serial slave.
        await usb.setVoltage('5v');
        log("Switched link to 5V for GBC dump");
        await delay(100);
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

// "TITLE [CODEMK]" from the last cart info, sanitized for filenames — the
// same shape the Wii dumper used. Falls back to a timestamp.
function gbaCartBaseName() {
    if (gbaCartInfo && (gbaCartInfo.title || gbaCartInfo.code)) {
        const raw = `${gbaCartInfo.title || "UNTITLED"} [${gbaCartInfo.code || ""}${gbaCartInfo.maker || ""}]`;
        return raw.replace(/[\\/:*?"<>|]/g, "_").replace(/[\x00-\x1F\x7F]/g, "_");
    }
    return `gba_dump_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}`;
}

function offerDownload(data, type) {
    let filename;
    if (type === "GBA_ROM") {
        filename = `${gbaCartBaseName()}.gba`;
    } else if (type === "GBA_SAVE") {
        filename = `${gbaCartBaseName()}.sav`;
    } else if (type === "GBA_BIOS") {
        filename = "gba_bios.bin";
    } else {
        const ext = type === "ROM" ? ".gb" : ".sav";
        filename = `dump_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}${ext}`;
    }

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
    if (gbaBusy && gbaClient) {
        gbaClient.cancel();
        log("Cancelling GBA operation...", "error");
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
    gbaLinkConfigured = false; // this path moves the link to 5V / byte timing
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
        // Restore clocks the GBC the same way a dump does, so it needs the same
        // 5V link. In the normal flow the dump path already switched to 5V, but
        // set it explicitly here so Restore does not depend on that having run.
        await usb.setVoltage('5v');
        log("Switched link to 5V for GBC restore");
        await delay(100);
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

// ============================== GBA cartridges ==============================

// Put the link in the state the GBA payload protocol needs: GB_LINK module,
// 3.3V (GBA-native serial — the 5V requirement is GBC-mode only), 32-bit
// words at multiboot pacing. Cheap to skip when nothing changed it since.
async function gbaConfigureLink(force = false) {
    if (gbaLinkConfigured && !force) return;
    if (usb.isNewFirmware) {
        await usb.setMode(MODE.GB_LINK);
        await delay(100);
    }
    await usb.setVoltage('3v3');
    await delay(100);
    await usb.setTimingConfig(36, 4);
    await delay(50);
    gbaLinkConfigured = true;
}

function headerInfoFromBytes(bytes) {
    const ascii = (from, len) => {
        let s = "";
        for (let i = from; i < from + len; i++) {
            const c = bytes[i];
            if (!c) break;
            s += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : "_";
        }
        return s.trim();
    };
    const title = ascii(0xA0, 12), code = ascii(0xAC, 4), maker = ascii(0xB0, 2);
    if (!title && !code) return null;
    return { title, code, maker };
}

function renderGbaCartPanel(text) {
    const panel = document.getElementById("gbaCartPanel");
    panel.style.display = "block";
    panel.textContent = text; // cart-controlled strings: never innerHTML
}

async function gbaReadInfoInner() {
    setStatus("Reading cartridge...");
    const info = await gbaClient.readInfo();
    if (info.noCart) {
        gbaCartInfo = null;
        renderGbaCartPanel("No cartridge detected. Insert a GBA cartridge " +
            "(slowly, or use the kapton-tape trick if the GBA resets), then click \"Read Cartridge\".");
        setStatus("No GBA cartridge");
        log("No GBA cartridge detected.");
        return;
    }
    gbaCartInfo = info;
    const saveTxt = info.savesize > 0 ? formatSize(info.savesize) : "none detected";
    renderGbaCartPanel(`${info.title || "(no title)"} [${info.code}${info.maker}] — ` +
        `ROM: ${formatSize(info.gamesize)} — Save: ${saveTxt}`);
    setStatus("Cartridge identified");
    log(`GBA cart: ${info.title} [${info.code}${info.maker}] — ROM ${formatSize(info.gamesize)}, save ${saveTxt}`, "success");
}

// Shared wrapper for the GBA action buttons: claims the link, resets the
// progress UI, funnels cancel/errors into the log.
async function runGbaOp(label, fn) {
    if (!usb.isConnected || !gbaReady || !gbaClient || dumpRunning || restoreSender || gbaBusy) return;
    gbaBusy = true;
    gbaClient.cancelRequested = false;
    updateButtons();
    document.getElementById("progressFill").style.width = "0%";
    document.getElementById("progressText").textContent = `${label}...`;
    try {
        await gbaConfigureLink();
        setStatus(`${label}...`);
        await fn();
    } catch (e) {
        if (e && e.code === "cancelled") {
            log(`${label} cancelled.`, "error");
            setStatus("Cancelled");
        } else {
            log(`${label} failed: ${e.message}`, "error");
            setStatus(`${label} failed`);
        }
    }
    gbaBusy = false;
    updateButtons();
}

function gbaProgress(label, startTime) {
    const progressBar = document.getElementById("progressFill");
    const progressText = document.getElementById("progressText");
    return (done, total) => {
        const pct = Math.floor((done / total) * 100);
        progressBar.style.width = `${pct}%`;
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = elapsed > 0 ? done / elapsed : 0;
        const remaining = rate > 0 ? Math.floor((total - done) / rate) : 0;
        const eta = done > 0x2000 ? formatTime(remaining) : "calculating...";
        progressText.textContent =
            `${label} — ${pct}% (${formatSize(done)} / ${formatSize(total)}) — ETA: ${eta}`;
    };
}

async function sendGbaDumper() {
    if (!usb.isConnected || !gbaRomData || dumpRunning || restoreSender || gbaBusy) return;
    gbaBusy = true;
    gbaReady = false;
    gbaCartInfo = null;
    updateButtons();
    document.getElementById("progressFill").style.width = "0%";
    try {
        log("--- GBA: sending cart dumper payload ---");
        setStatus("Sending GBA dumper...");
        if (usb.isNewFirmware) {
            await usb.setMode(MODE.GB_LINK);
            await delay(100);
        }
        // Same 3.3V multiboot preamble as the GB/GBC path.
        await usb.setVoltage('3v3');
        await delay(100);
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

        const ok = await GBAMultiboot.multiboot(usb, gbaRomData, log);
        if (!ok) {
            log("GBA dumper multiboot failed.", "error");
            setStatus("Multiboot failed");
        } else {
            gbaLinkConfigured = true; // multiboot ran at exactly this config
            gbaClient = new GbaCartClient(usb, log);
            await delay(800); // let the payload boot
            setStatus("Checking payload...");
            if (await gbaClient.ping(5000)) {
                gbaReady = true;
                log("GBA dumper is running.", "success");
                await gbaReadInfoInner(); // shows "no cartridge" until one is inserted
            } else {
                log("The payload did not answer — check the cable and try again.", "error");
                setStatus("Payload not responding");
            }
        }
    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("Error");
    }
    gbaBusy = false;
    updateButtons();
}

async function gbaAlreadyLoaded() {
    if (!usb.isConnected || dumpRunning || restoreSender || gbaBusy) return;
    gbaBusy = true;
    updateButtons();
    try {
        log("--- GBA: adopting an already-running dumper payload ---");
        await gbaConfigureLink(true);
        gbaClient = new GbaCartClient(usb, log);
        setStatus("Looking for the GBA dumper...");
        if (await gbaClient.ping(5000)) {
            gbaReady = true;
            log("GBA dumper found.", "success");
            await gbaReadInfoInner();
        } else {
            gbaReady = false;
            log("No running GBA dumper payload found. Use \"Send Multiboot\" first.", "error");
            setStatus("No payload found");
        }
    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("Error");
    }
    gbaBusy = false;
    updateButtons();
}

async function gbaReadInfo() {
    await runGbaOp("Read cartridge", gbaReadInfoInner);
}

async function gbaDumpRom() {
    await runGbaOp("GBA ROM dump", async () => {
        const t0 = Date.now();
        const { data } = await gbaClient.dumpRom(gbaProgress("Dumping ROM", t0));
        // The dump starts with the cart header — recover names for the
        // download even if Read Cartridge was never clicked.
        if (!gbaCartInfo) gbaCartInfo = headerInfoFromBytes(data);
        log(`GBA ROM dump complete: ${formatSize(data.length)} in ${formatTime(Math.floor((Date.now() - t0) / 1000))}.`, "success");
        setStatus("ROM dump complete");
        document.getElementById("progressText").textContent = "Complete!";
        offerDownload(data, "GBA_ROM");
    });
}

async function gbaDumpSave() {
    await runGbaOp("GBA save dump", async () => {
        const t0 = Date.now();
        const { data } = await gbaClient.dumpSave(gbaProgress("Dumping save", t0));
        log(`GBA save dump complete: ${formatSize(data.length)}.`, "success");
        setStatus("Save dump complete");
        document.getElementById("progressText").textContent = "Complete!";
        offerDownload(data, "GBA_SAVE");
    });
}

async function gbaDumpBios() {
    await runGbaOp("GBA BIOS dump", async () => {
        const t0 = Date.now();
        const { data } = await gbaClient.dumpBios(gbaProgress("Dumping BIOS", t0));
        log(`GBA BIOS dump complete: ${formatSize(data.length)}.`, "success");
        setStatus("BIOS dump complete");
        document.getElementById("progressText").textContent = "Complete!";
        offerDownload(data, "GBA_BIOS");
    });
}

async function gbaRestoreSave() {
    if (!gbaRestoreData) return;
    if (!window.confirm(
        `This will OVERWRITE the save on the inserted GBA cartridge with the loaded ` +
        `${formatSize(gbaRestoreData.length)} file. This cannot be undone. Continue?`)) {
        return;
    }
    await runGbaOp("GBA save restore", async () => {
        const t0 = Date.now();
        log("Uploading save, then writing to the cartridge — flash carts can take a minute.");
        await gbaClient.restoreSave(gbaRestoreData, gbaProgress("Uploading save", t0));
        log("GBA save restored. Power-cycle the cartridge and check in-game.", "success");
        setStatus("Restore complete");
        document.getElementById("progressText").textContent = "Restore complete!";
    });
}

async function gbaEraseSave() {
    if (!window.confirm(
        "This will ERASE (zero-fill) the save on the inserted GBA cartridge. " +
        "This cannot be undone. Continue?")) {
        return;
    }
    await runGbaOp("GBA save erase", async () => {
        const { savesize } = await gbaClient.eraseSave();
        log(`GBA save erased (${formatSize(savesize)} zero-filled).`, "success");
        setStatus("Save erased");
        document.getElementById("progressText").textContent = "Save erased.";
    });
}

function loadGbaRestoreFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        gbaRestoreData = new Uint8Array(reader.result);
        log(`GBA save loaded: ${file.name} (${formatSize(gbaRestoreData.length)})`);
        updateButtons();
    };
    reader.onerror = () => {
        log("Failed to read the GBA save file.", "error");
        gbaRestoreData = null;
        updateButtons();
    };
    reader.readAsArrayBuffer(file);
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

    document.getElementById("gbaSendBtn").addEventListener("click", sendGbaDumper);
    document.getElementById("gbaLoadedBtn").addEventListener("click", gbaAlreadyLoaded);
    document.getElementById("gbaInfoBtn").addEventListener("click", gbaReadInfo);
    document.getElementById("gbaDumpRomBtn").addEventListener("click", gbaDumpRom);
    document.getElementById("gbaDumpSaveBtn").addEventListener("click", gbaDumpSave);
    document.getElementById("gbaBiosBtn").addEventListener("click", gbaDumpBios);
    document.getElementById("gbaRestoreBtn").addEventListener("click", gbaRestoreSave);
    document.getElementById("gbaEraseBtn").addEventListener("click", gbaEraseSave);
    document.getElementById("gbaRestoreFile").addEventListener("change", (e) => {
        loadGbaRestoreFile(e.target.files[0]);
    });

    document.getElementById("modeGbBtn").addEventListener("click", () => setCartMode("gb"));
    document.getElementById("modeGbaBtn").addEventListener("click", () => setCartMode("gba"));
    let savedMode = null;
    try { savedMode = localStorage.getItem("cartDoctorMode"); } catch (e) { /* private browsing */ }
    if (savedMode === "gb" || savedMode === "gba") setCartMode(savedMode);

    if (!transport) {
        document.getElementById("browserWarning").style.display = "block";
    }

    loadMultibootROM();
    loadGbaDumperROM();
    updateButtons();
});
