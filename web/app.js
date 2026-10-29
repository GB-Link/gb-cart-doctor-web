/**
 * GB-Link Cart Doctor web page.
 * Sends a small program to the GBA over the link cable, then uses it to read,
 * back up, restore and write GB, GBC and GBA cartridges.
 */

let usb = new UsbConnection();
let romData = null;           // the program that switches the GBA into GBC mode

// --- GB/GBC cartridge state ---
let gbAgent = null;           // the small cartridge program uploaded into the GBC
let gbClient = null;          // GbCartClient while that program is running
let gbReceiver = null;        // FastDumpReceiver or FastRestoreSender during a transfer
let gbHeader = null;          // last cartridge header read
let gbBusy = false;           // a GB operation is holding the link
let gbReady = false;          // the GBC homebrew answered, so the action buttons are enabled
let gbRestoreData = null;     // the .sav file picked for Restore Save
let gbRestoreName = "";       // its file name
let gbFlasher = null;         // GbFlashcart while a flash cart operation runs
let gbFlashRom = null;        // { name, data } of the ROM to write to a flash cart
let gbFlashDetected = null;   // last GbFlashcart.detect() result
let gbOpLabel = "";           // the GB operation running, for the activity headline
let gbLinkConfigured = false; // the link is set up for GBC mode (5V, one byte at a time)

// --- GBA cartridge state ---
let gbaRomData = null;        // the GBA cart dumper program
let gbaClient = null;         // GbaCartClient once the dumper is running on the GBA
let gbaBusy = false;          // a GBA operation is holding the link
let gbaReady = false;         // the dumper answered, so the action buttons are enabled
let gbaRestoreData = null;    // the .sav file picked for Restore Save
let gbaRestoreName = "";      // its file name
let gbaCartInfo = null;       // last cartridge info read, used to name saved files
let gbaFlasher = null;        // GbaFlashcart while a flash cart operation runs
let gbaFlashRom = null;       // { name, data } of the ROM to write to a flash cart
let gbaFlashDetected = null;  // last GbaFlashcart.detect() result
// The GBA protocol needs 3.3V + 32-bit timing; the GB/GBC side needs 5V +
// byte timing. Each side's configure function clears the other's flag, so the
// next action on the other side reconfigures the link first.
let gbaLinkConfigured = false;
// Whether the adapter has been put in GB_LINK mode on this connection. It is
// only done once: switching modes while a GBA or GBC program is waiting on its
// serial port can send a stray clock pulse, which shifts every byte after it.
let linkModeSet = false;

// Which system is on screen: "gb", "gba", or null before one is picked.
// It only changes what is shown; the GBA dumper keeps running if you switch away.
let cartMode = null;

function setCartMode(mode) {
    if (mode !== "gb" && mode !== "gba") return;
    // Don't swap the visible controls out from under a running operation
    // (the selector buttons are also disabled while one runs).
    if (gbBusy || gbaBusy) return;
    cartMode = mode;
    try { localStorage.setItem("cartDoctorMode", mode); } catch (e) { /* private browsing */ }
    document.body.dataset.system = mode;
    document.getElementById("pickHint").hidden = true;
    document.getElementById("gbSections").hidden = mode !== "gb";
    document.getElementById("gbaSections").hidden = mode !== "gba";
    document.getElementById("modeGbBtn").setAttribute("aria-selected", String(mode === "gb"));
    document.getElementById("modeGbaBtn").setAttribute("aria-selected", String(mode === "gba"));
    updateButtons();
}

// Prefer WebUSB; fall back to WebSerial (Firefox 151+, or Chromium with WebUSB disabled).
const hasUsb = ('usb' in navigator);
const hasSerial = ('serial' in navigator);
const transport = hasUsb ? 'usb' : (hasSerial ? 'serial' : null);

let logLines = 0;
let logErrors = 0;

function log(message, type = "info") {
    const logEl = document.getElementById("log");
    const entry = document.createElement("div");
    const time = new Date().toLocaleTimeString();
    entry.className = `log-${type}`;
    entry.textContent = `[${time}] ${message}`;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
    logLines++;
    if (type === "error") logErrors++;
    const count = document.getElementById("logCount");
    count.textContent = logErrors ? `${logLines} lines, ${logErrors} error${logErrors === 1 ? "" : "s"}` : `${logLines} lines`;
    count.classList.toggle("has-errors", logErrors > 0);
}

// The headline on the activity card. tone is "busy", "ok", "warn", "error" or
// "idle"; if left out, it shows busy while an operation is running.
let progressPct = 0;

function setStatus(text, tone) {
    document.getElementById("statusText").textContent = text;
    document.getElementById("activityCard").dataset.tone = tone || ((gbBusy || gbaBusy) ? "busy" : "idle");
    showProgressBar();
}

// The progress bar appears while something runs and stays afterwards to show
// how far it got.
function setProgress(pct, text) {
    if (pct !== null) {
        progressPct = pct;
        document.getElementById("progressFill").style.width = `${pct}%`;
    }
    if (text !== undefined) document.getElementById("progressText").textContent = text;
    showProgressBar();
}

function showProgressBar() {
    const card = document.getElementById("activityCard");
    card.querySelector(".progress").hidden = card.dataset.tone !== "busy" && progressPct === 0;
}

// Ask before an operation that overwrites something on the cartridge.
function confirmAction(title, body, okLabel) {
    const dialog = document.getElementById("confirmDialog");
    document.getElementById("confirmTitle").textContent = title;
    document.getElementById("confirmBody").textContent = body;
    document.getElementById("confirmOk").textContent = okLabel;
    dialog.returnValue = "";
    return new Promise((resolve) => {
        dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
        dialog.showModal();
    });
}

// Sets one column's setup checklist: each step is done, current or still to come.
function setSteps(sectionId, done) {
    const steps = document.querySelectorAll(`#${sectionId} .step`);
    let current = true;
    steps.forEach((step, i) => {
        step.classList.toggle("done", done[i]);
        step.classList.toggle("current", !done[i] && current);
        if (!done[i]) current = false;
    });
}

function updateButtons() {
    const connected = usb.isConnected;
    const connectBtn = document.getElementById("connectBtn");
    const connectLabel = transport === 'serial' ? "Connect Serial" : "Connect USB";
    document.getElementById("connectLabel").textContent = connected ? "Disconnect" : connectLabel;
    connectBtn.classList.toggle("btn-primary", !connected);
    connectBtn.disabled = !transport;
    const linkBusy = gbBusy || gbaBusy;
    document.getElementById("cancelBtn").disabled = !linkBusy;
    const pill = document.getElementById("connState");
    pill.dataset.state = !connected ? "off" : linkBusy ? "busy" : "on";
    document.getElementById("connText").textContent = !connected ? "Not connected" : linkBusy ? "Working" : "Connected";

    setSteps("gbSections", [connected, connected && gbReady, connected && gbReady && !!(gbHeader && gbHeader.headerOk)]);
    setSteps("gbaSections", [connected, connected && gbaReady, connected && gbaReady && !!gbaCartInfo]);
    for (const id of ["restoreFile", "gbFlashFile", "gbaRestoreFile", "gbaFlashFile"]) {
        document.getElementById(id).closest(".drop").classList.toggle("disabled", linkBusy);
    }
    updateRestoreNotes();

    // Game Boy: loading the homebrew needs the link to be free; the action
    // buttons also need the GBC homebrew to be running.
    document.getElementById("startBtn").disabled = !connected || !romData || linkBusy;
    document.getElementById("dumpOnlyBtn").disabled = !connected || !gbAgent || linkBusy;
    const gbActionsOff = !connected || linkBusy || !gbReady;
    document.getElementById("gbInfoBtn").disabled = gbActionsOff;
    document.getElementById("gbDumpRomBtn").disabled = gbActionsOff;
    document.getElementById("gbDumpSaveBtn").disabled = gbActionsOff;
    document.getElementById("restoreBtn").disabled = gbActionsOff || !gbRestoreData;
    document.getElementById("gbFlashDetectBtn").disabled = gbActionsOff;
    document.getElementById("gbFlashWriteBtn").disabled = gbActionsOff || !gbFlashRom;
    document.getElementById("gbFlashProfile").disabled = linkBusy;
    document.getElementById("gbFlashEraseRest").disabled = linkBusy;

    // GBA: sending the dumper (or using one already running) needs the link
    // to be free; the action buttons also need the dumper to have answered.
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
    document.getElementById("gbaFlashDetectBtn").disabled = gbaActionsOff;
    document.getElementById("gbaFlashWriteBtn").disabled = gbaActionsOff || !gbaFlashRom;
    document.getElementById("gbaFlashProfile").disabled = linkBusy;
    document.getElementById("gbaFlashEraseRest").disabled = linkBusy;
}

function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

// Two sizes to compare, in exact bytes when rounding would make them look the same.
function formatSizes(a, b) {
    if (a === b || formatSize(a) !== formatSize(b)) return [formatSize(a), formatSize(b)];
    return [`${a.toLocaleString()} bytes`, `${b.toLocaleString()} bytes`];
}

async function loadMultibootROM() {
    try {
        // Skip the browser cache so an old copy of the program is never sent.
        const resp = await fetch("gba-switch-to-gbc_mb.gba", { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        romData = new Uint8Array(await resp.arrayBuffer());
        // Log a short checksum so you can tell which build gets sent. The GBA
        // keeps running whatever was sent last; reloading the page doesn't
        // change that, only "Send Multiboot" does.
        let h = 0;
        for (let i = 0; i < romData.length; i++) h = ((h * 31) + romData[i]) >>> 0;
        log(`Multiboot ROM loaded: ${formatSize(romData.length)} (build ${h.toString(16).padStart(8, '0')})`);
        updateButtons();
    } catch (e) {
        log("Failed to load multiboot ROM. Make sure gba-switch-to-gbc_mb.gba is in the web folder.", "error");
    }
}

async function loadGbAgent() {
    try {
        const resp = await fetch("gbc-agent.bin", { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        gbAgent = new Uint8Array(await resp.arrayBuffer());
        updateButtons();
    } catch (e) {
        log("Failed to load the GBC cart agent (gbc-agent.bin) — GB/GBC cartridge features disabled.", "error");
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

const SVG_NS = "http://www.w3.org/2000/svg";

function svgIcon(name, cls) {
    const svg = document.createElementNS(SVG_NS, "svg");
    if (cls) svg.setAttribute("class", cls);
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `#${name}`);
    svg.append(use);
    return svg;
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // text from the cartridge: never use innerHTML
    return e;
}

// Fills in the cartridge card. state.kind is "empty" (nothing read yet),
// "missing" (no cartridge found; has a title and text) or "cart" (has a title,
// tags as [text, class] pairs and facts as [label, value] pairs).
function renderCart(panelId, state) {
    const panel = document.getElementById(panelId);
    panel.replaceChildren();
    if (state.kind !== "cart") {
        const box = el("div", state.kind === "missing" ? "cart-missing" : "cart-empty");
        const text = el("div");
        text.append(el("b", "", state.title), el("p", "", state.text));
        box.append(svgIcon(state.kind === "missing" ? "i-warn" : "i-cart"), text);
        panel.append(box);
        return;
    }
    const body = el("div");
    const tags = el("div", "cart-tags");
    for (const [text, cls] of state.tags) tags.append(el("span", `tag ${cls}`, text));
    const facts = el("dl", "cart-facts");
    for (const [label, value] of state.facts) {
        const fact = el("div", "fact");
        fact.append(el("dt", "", label), el("dd", "", value));
        facts.append(fact);
    }
    body.append(el("div", "cart-title", state.title), tags, facts);
    const wrap = el("div", "cart-info");
    wrap.append(el("div", "cart-art"), body);
    panel.append(wrap);
}

const CART_NOT_READ = {
    kind: "empty",
    title: "No cartridge read yet",
    text: "Once the homebrew is running, insert a cartridge and click Read Cartridge.",
};

// Shows which flash cart was found, or why none was (det.error).
function renderFlashResult(panelId, det) {
    const panel = document.getElementById(panelId);
    panel.hidden = false;
    panel.classList.toggle("bad", !!det.error);
    panel.replaceChildren();
    const text = el("div");
    if (det.error) {
        text.textContent = det.error;
        panel.append(svgIcon("i-warn", "ic"), text);
        return;
    }
    const id = Array.from(det.flashId.subarray(0, 4), b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    let sub = `Flash ID ${id} · ${flashSizeText(det)}`;
    if (det.candidates.length > 1) {
        sub += ` · also matches ${det.candidates.filter(p => p !== det.profile).map(p => p.names[0]).join("; ")}`;
    }
    text.append(el("b", "", det.profile.names[0]), el("small", "", sub)); // set as text, not HTML
    panel.append(svgIcon("i-chip", "ic"), text);
}

function saveTypeName(bytes) {
    if (bytes === 0x200 || bytes === 0x2000) return "EEPROM";
    if (bytes === 0x8000) return "SRAM";
    if (bytes >= 0x10000) return "flash";
    return "";
}

// The note under each restore file box: whether the chosen save file is the
// right size for the cartridge.
function updateRestoreNotes() {
    const note = (id, data, size, clockRecord = 0) => {
        const p = document.getElementById(id);
        p.className = "file-note";
        p.textContent = "";
        if (!data || !size) return;
        if (data.length === size || clockRecord) {
            p.classList.add("ok");
            p.textContent = `Matches the cartridge's ${formatSize(size)} save memory.` +
                (clockRecord ? ` ${clockRecordNote(clockRecord)}` : "");
        } else {
            const [cart, file] = formatSizes(size, data.length);
            p.classList.add("bad");
            p.textContent = `The cartridge's save memory is ${cart}; this file is ${file}.`;
        }
    };
    const gbOk = gbHeader && gbHeader.headerOk;
    const gbFit = gbOk && gbRestoreData ? gbSaveForCart(gbRestoreData, gbHeader) : null;
    note("gbRestoreNote", gbRestoreData, gbOk ? gbHeader.ramSize : 0, gbFit ? gbFit.clockRecord : 0);
    note("gbaRestoreNote", gbaRestoreData, gbaCartInfo ? gbaCartInfo.savesize : 0);
}

function describeClock([seconds, minutes, hours, dayLow, dayHigh]) {
    const time = `day ${dayLow + (dayHigh & 1) * 256}, ${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return dayHigh & 0x40 ? `The cartridge's clock is stopped at ${time}.` : `The cartridge's clock reads ${time}.`;
}

function clockRecordNote(bytes) {
    return `The last ${bytes} bytes are the clock record an emulator adds; they are left out, and the cartridge keeps its own clock.`;
}

function resetGbaSession() {
    // The client is tied to one connection object. Reconnecting creates a new
    // one, so the old client can't be used any more.
    if (gbaClient) gbaClient.cancel();
    gbaClient = null;
    gbaReady = false;
    gbaCartInfo = null;
    gbaFlashDetected = null;
    gbaLinkConfigured = false;
    document.getElementById("gbaFlashPanel").hidden = true;
    renderCart("gbaCartPanel", CART_NOT_READ);
}

async function toggleConnect(kind = 'usb') {
    linkModeSet = false;
    if (usb.isConnected) {
        resetGbSession();
        resetGbaSession();
        await usb.disconnect();
        log("Disconnected.");
        setStatus("Not connected", "idle");
        setProgress(0, "Idle");
    } else {
        try {
            resetGbSession();
            resetGbaSession();
            usb = (kind === 'serial') ? new SerialConnection() : new UsbConnection();
            setStatus("Connecting...", "busy");
            await usb.connect();
            const fwType = (kind === 'serial')
                ? "GBLink Unified (WebSerial)"
                : (usb.isNewFirmware ? "GBLink Unified" : "Reconfigurable");
            log(`Connected! Firmware: ${fwType}`, "success");
            setStatus("Connected", "ok");
            setProgress(0, cartMode ? "Next: load the homebrew." : "Next: choose the kind of cartridge.");
        } catch (e) {
            log(`Connection failed: ${e.message}`, "error");
            setStatus("Connection failed", "error");
            setProgress(0, e.message);
        }
    }
    updateButtons();
}

// A file name like "TITLE [CODEMK]" (title, game code and maker code) from
// the last cartridge info, with unsafe characters removed. Uses a timestamp
// if no cartridge info has been read.
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
    } else if (type === "GB_ROM") {
        const cgb = gbHeader && gbHeader.cgb !== "no";
        filename = `${gbCartBaseName()}${cgb ? ".gbc" : ".gb"}`;
    } else {
        filename = `${gbCartBaseName()}.sav`;
    }

    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const kinds = { GBA_ROM: "ROM", GB_ROM: "ROM", GBA_SAVE: "SAV", GB_SAVE: "SAV", GBA_BIOS: "BIOS" };

    const item = document.createElement("li");
    item.className = "file";
    const kind = document.createElement("span");
    kind.className = "file-kind";
    kind.textContent = kinds[type] || "SAV";
    const meta = document.createElement("span");
    meta.className = "file-meta";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = filename; // the name comes from the cartridge: never use innerHTML
    name.title = filename;
    const sub = document.createElement("span");
    sub.className = "file-sub";
    sub.textContent = `${formatSize(data.length)} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    meta.append(name, sub);
    const link = document.createElement("a");
    link.className = "btn btn-sm";
    link.href = url;
    link.download = filename;
    link.innerHTML = '<svg class="ic"><use href="#i-download"/></svg>Save';
    item.append(kind, meta, link);

    document.getElementById("filesEmpty").hidden = true;
    document.getElementById("fileList").prepend(item);
    log(`Ready to save: ${filename} (${formatSize(data.length)})`, "success");
}

function cancelOp() {
    if (gbBusy) {
        if (gbFlasher) gbFlasher.cancel();
        if (gbClient) gbClient.cancel();
        if (gbReceiver) gbReceiver.cancel();
        log("Cancelling...", "error");
    }
    if (gbaBusy && gbaClient) {
        if (gbaFlasher) gbaFlasher.cancel();
        gbaClient.cancel();
        log("Cancelling GBA operation...", "error");
    }
}

// ============================== GB/GBC cartridges ==============================

// Sets up the link for GBC mode: GB_LINK mode at 5V (in GBC mode the GBA
// doesn't respond to the GB-Link's clock at 3.3V), sending one byte at a time
// with a short gap after each so the GBC is ready for the next one.
const GB_BYTE_GAP_US = 50;

async function gbConfigureLink(force = false) {
    if (gbLinkConfigured && !force) return;
    if (usb.isNewFirmware && !linkModeSet) {
        await usb.setMode(MODE.GB_LINK);
        await delay(100);
        linkModeSet = true;
    }
    await usb.setVoltage('5v');
    await delay(100);
    await usb.setTimingConfig(GB_BYTE_GAP_US, 1);
    await delay(50);
    gbLinkConfigured = true;
    gbaLinkConfigured = false;
}

function resetGbSession() {
    if (gbClient) gbClient.cancel();
    if (gbReceiver) gbReceiver.cancel();
    gbClient = null;
    gbReceiver = null;
    gbHeader = null;
    gbReady = false;
    gbFlashDetected = null;
    gbLinkConfigured = false;
    renderCart("gbCartPanel", CART_NOT_READ);
    document.getElementById("gbFlashPanel").hidden = true;
}

// Uploads the cartridge program to the GBC, runs fn(client) with it, then
// returns the GBC to its menu. The program is uploaded again for every
// operation.
async function gbWithAgent(fn) {
    if (!gbAgent) throw new Error("The GBC cart agent (gbc-agent.bin) didn't load — reload the page.");
    const client = new GbCartClient(usb, log);
    gbClient = client;
    let connected = false;
    try {
        await client.connect(gbAgent);
        connected = true;
        return await fn(client);
    } finally {
        if (connected) {
            client.cancelled = false;
            try { await client.disconnect(); } catch (e) { /* report the operation's error, not this one */ }
        }
        gbClient = null;
    }
}

async function gbReadInfoInner({ clock = false } = {}) {
    setStatus("Reading the cartridge...", "busy");
    let h;
    try {
        h = await gbWithAgent(async (client) => {
            const cart = new GbCart(client, log);
            const header = await cart.readHeader();
            if (clock && header.headerOk) {
                header.clockRegs = await cart.readClock();
                header.clockTime = Math.floor(Date.now() / 1000);
            }
            return header;
        });
    } catch (e) {
        gbHeader = null;
        renderCart("gbCartPanel", { kind: "missing", title: "Couldn't read the cartridge", text: "Make sure it's inserted all the way, then read it again." });
        throw e;
    }
    gbReady = true;
    gbHeader = h;
    if (!h.headerOk) {
        renderCart("gbCartPanel", {
            kind: "missing",
            title: "No cartridge found",
            text: "Insert a GB or GBC cartridge, then read it again. Blank flash carts have no header and show up like this too: use the Flash Cart tab for them.",
        });
        setStatus("No cartridge found", "warn");
        log("No GB/GBC cartridge header found.");
        return h;
    }
    const save = h.ramSize ? formatSize(h.ramSize) : "None";
    const tags = [[h.cgb === "only" ? "Game Boy Color only" : h.cgb === "yes" ? "Game Boy Color" : "Game Boy", "tag-system"]];
    if (/BATTERY/.test(h.typeName)) tags.push(["Battery save", ""]);
    if (/TIMER/.test(h.typeName)) tags.push(["Clock", ""]);
    if (h.rumble) tags.push(["Rumble", ""]);
    const mapper = h.typeName.split("+")[0];
    renderCart("gbCartPanel", {
        kind: "cart",
        title: h.title || "(no title)",
        tags,
        facts: [["ROM", formatSize(h.romSize)], ["Save", save], ["Mapper", mapper === "ROM only" || mapper === "ROM" ? "None" : mapper]],
    });
    setStatus("Cartridge read", "ok");
    log(`GB cart: ${h.title || "(no title)"} — ${h.typeName}, ROM ${formatSize(h.romSize)}, save ${save}`, "success");
    return h;
}

// Runs a Game Boy action button's work: marks the link busy, resets the
// progress display, and reports errors or a cancel in the log.
async function runGbOp(label, fn) {
    if (!usb.isConnected || !gbReady || gbBusy || gbaBusy) return;
    gbBusy = true;
    gbOpLabel = label;
    updateButtons();
    setProgress(0, "");
    try {
        await gbConfigureLink();
        setStatus(`${label}...`, "busy");
        await fn();
    } catch (e) {
        if (e && e.code === "cancelled") {
            log(`${label} cancelled.`, "error");
            setStatus("Cancelled", "warn");
            setProgress(null, `${label} was cancelled.`);
        } else {
            let hint = "";
            if (e && e.code === "no-answer") {
                hint = " Click \"Already Loaded\" to reconnect, or \"Send Multiboot\" if the GBA was reset.";
            }
            log(`${label} failed: ${e.message}${hint}`, "error");
            setStatus(`${label} failed`, "error");
            setProgress(null, `${e.message}${hint}`);
        }
    }
    gbBusy = false;
    updateButtons();
}

async function sendGbMultiboot() {
    if (!usb.isConnected || !romData || gbBusy || gbaBusy) return;
    gbBusy = true;
    resetGbSession();
    gbaLinkConfigured = false;
    updateButtons();
    setProgress(0, "");
    try {
        setStatus("Sending the homebrew...", "busy");
        log("--- GB/GBC: sending the GBC homebrew ---");
        if (usb.isNewFirmware) {
            await usb.setMode(MODE.GB_LINK);
            await delay(100);
            linkModeSet = true;
        }
        // Sending the program uses the GBA's own link mode at 3.3V. Once the
        // GBA is in GBC mode the link runs at 5V (see gbConfigureLink).
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
        const ok = await GBAMultiboot.multiboot(usb, romData, log);
        if (!ok) {
            log("Multiboot failed!", "error");
            setStatus("Multiboot failed", "error");
            setProgress(0, "The GBA didn't take the homebrew. Turn it off and on again with no cartridge in, then send it again.");
        } else {
            // The cartridge is inserted after the GBA switches to GBC mode, so
            // nothing is read until you click Read Cartridge.
            setStatus("Waiting for the GBA to switch to GBC mode...", "busy");
            setProgress(100, "");
            await delay(2000);
            await gbConfigureLink(true);
            gbReady = true;
            setStatus("Homebrew running", "ok");
            setProgress(100, "Insert the cartridge, then click Read Cartridge.");
            log("Homebrew sent. Once the GBA shows its GBC menu, insert the cartridge and click \"Read Cartridge\".", "success");
        }
    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("Sending the homebrew failed", "error");
        setProgress(null, e.message);
    }
    gbBusy = false;
    updateButtons();
}

async function gbAlreadyLoaded() {
    if (!usb.isConnected || gbBusy || gbaBusy) return;
    gbBusy = true;
    resetGbSession();
    updateButtons();
    setProgress(0, "");
    try {
        log("--- GB/GBC: connecting to the running GBC homebrew ---");
        await gbConfigureLink(true);
        await gbReadInfoInner();
        log("GBC homebrew found.", "success");
    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("The homebrew isn't answering", "error");
        setProgress(0, `${e.message} Send the multiboot again if the GBA was turned off or reset.`);
    }
    gbBusy = false;
    updateButtons();
}

async function gbReadInfo() {
    await runGbOp("Reading the cartridge", gbReadInfoInner);
}

// The title from the cartridge header, made safe for a file name.
function gbCartBaseName() {
    const h = gbHeader;
    const title = h && h.headerOk && h.title ? h.title : `gb_dump_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`;
    return title.replace(/[\\/:*?"<>|]/g, "_").replace(/[\x00-\x1F\x7F]/g, "_");
}

// Reads the cartridge header first and stops if there is no cartridge. The
// dump itself gets the ROM and save sizes from the cartridge.
async function gbCheckedHeader(options) {
    const h = await gbReadInfoInner(options);
    if (!h.headerOk) throw new Error("No cartridge header — insert the cartridge and try again.");
    setStatus(`${gbOpLabel}...`, "busy");
    return h;
}

// Starts one of the GBC homebrew's built-in transfers from the page, the same
// way picking it from its menu would, and runs it.
async function gbFastTransfer(transfer, run) {
    gbReceiver = transfer;
    try {
        const res = await run();
        if (!res && transfer.timedOut) {
            throw new Error("The GBA didn't start the transfer. Click \"Already Loaded\", or send the multiboot again.");
        }
        if (!res && transfer.cancelled) {
            const e = new Error("Cancelled");
            e.code = "cancelled";
            throw e;
        }
        if (!res) throw new Error("The transfer failed — see the log above.");
        return res;
    } finally {
        gbReceiver = null;
    }
}

function gbSectionProgress(label, t0) {
    const show = gbaProgress(label, t0);
    return (done, total) => show(done * 256, total * 256);
}

async function gbDumpRom() {
    await runGbOp("Dumping the ROM", async () => {
        const h = await gbCheckedHeader();
        const t0 = Date.now();
        const rx = new FastDumpReceiver(usb, log, { trigger: GBLINK.CMD_DUMP_ROM, headerTimeoutMs: 5000 });
        const res = await gbFastTransfer(rx, () => rx.receiveDump(gbSectionProgress("Received", t0)));
        log(`GB ROM dump complete: ${formatSize(res.data.length)} in ${formatTime(Math.floor((Date.now() - t0) / 1000))}.`, "success");
        if (res.data.length !== h.romSize) log(`The cart sent ${formatSize(res.data.length)}; its header says ${formatSize(h.romSize)}.`, "error");
        setStatus("ROM dumped", "ok");
        setProgress(100, `${formatSize(res.data.length)} — it's in Files, ready to save.`);
        offerDownload(res.data, "GB_ROM");
    });
}

async function gbDumpSave() {
    await runGbOp("Dumping the save", async () => {
        // The clock is read along with the header; the record keeps the time it was read at
        const h = await gbCheckedHeader({ clock: true });
        if (!h.ramSize) throw new Error("This cartridge has no save memory.");
        const t0 = Date.now();
        const rx = new FastDumpReceiver(usb, log, { trigger: GBLINK.CMD_DUMP_SAVE, headerTimeoutMs: 5000 });
        const res = await gbFastTransfer(rx, () => rx.receiveDump(gbSectionProgress("Received", t0)));
        log(`GB save dump complete: ${formatSize(res.data.length)}.`, "success");
        let data = res.data;
        if (h.clockRegs) {
            data = new Uint8Array(res.data.length + 48);
            data.set(res.data);
            data.set(gbClockRecord(h.clockRegs, h.clockTime), res.data.length);
            log(`${describeClock(h.clockRegs)} It's added after the save, the way emulators keep it.`);
        } else if (h.typeName.startsWith("MBC3+TIMER")) {
            log("The cartridge's clock didn't answer, so the save has no clock record.", "error");
        }
        setStatus("Save dumped", "ok");
        setProgress(100, `${formatSize(data.length)} — it's in Files, ready to save.`);
        offerDownload(data, "GB_SAVE");
    });
}

async function gbRestoreSave() {
    if (!gbRestoreData) return;
    if (!await confirmAction("Overwrite the save?",
        `The save on the inserted cartridge will be replaced with ${gbRestoreName} ` +
        `(${formatSize(gbRestoreData.length)}). This can't be undone.`, "Restore Save")) {
        return;
    }
    await runGbOp("Restoring the save", async () => {
        const h = await gbCheckedHeader();
        if (!h.ramSize) throw new Error("This cartridge has no save memory.");
        const fit = gbSaveForCart(gbRestoreData, h);
        if (!fit) {
            const [file, cart] = formatSizes(gbRestoreData.length, h.ramSize);
            throw new Error(`The save file is ${file} but this cartridge's save memory is ${cart}.`);
        }
        if (fit.clockRecord) log(clockRecordNote(fit.clockRecord));
        const t0 = Date.now();
        const tx = new FastRestoreSender(usb, fit.save, log, { trigger: GBLINK.CMD_RESTORE, headerTimeoutMs: 5000 });
        await gbFastTransfer(tx, () => tx.sendRestore(gbSectionProgress("Sent", t0)));
        log("Save restored. Power-cycle the cartridge to check it in-game.", "success");
        setStatus("Save restored", "ok");
        setProgress(100, "Turn the GBA off and on with the cartridge to check it in-game.");
    });
}

function loadGbRestoreFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        gbRestoreData = new Uint8Array(reader.result);
        gbRestoreName = file.name;
        log(`Save loaded: ${file.name} (${formatSize(gbRestoreData.length)})`);
        updateButtons();
    };
    reader.onerror = () => {
        log("Failed to read save file.", "error");
        gbRestoreData = null;
        updateButtons();
    };
    reader.readAsArrayBuffer(file);
}

// ------------------------------------------------------- GB flash carts

function fillGbFlashProfileList() {
    const select = document.getElementById("gbFlashProfile");
    if (typeof GB_FLASHCART_PROFILES === "undefined") return;
    const profiles = GB_FLASHCART_PROFILES.slice().sort((a, b) => a.names[0].localeCompare(b.names[0]));
    for (const p of profiles) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.names[0];
        select.appendChild(opt);
    }
}

function selectedGbFlashProfile() {
    const id = document.getElementById("gbFlashProfile").value;
    return id ? GB_FLASHCART_PROFILES.find(p => p.id === id) : null;
}

async function gbFlashDetectInner(flasher) {
    setStatus("Detecting the flash cart...", "busy");
    const det = await flasher.detect();
    gbFlashDetected = det;
    renderFlashResult("gbFlashPanel", det);
    log(`Flash cart: ${det.profile.names[0]}, ${flashSizeText(det)} (${det.method}).`, "success");
    setStatus("Flash cart found", "ok");
    setProgress(100, det.profile.names[0]);
    return det;
}

async function gbFlashDetect() {
    await runGbOp("Detecting the flash cart", async () => {
        try {
            await gbWithAgent(async (client) => {
                gbFlasher = new GbFlashcart(client, { log });
                await gbFlashDetectInner(gbFlasher);
            });
        } catch (e) {
            gbFlashDetected = null;
            if (e.code === "no-flash") renderFlashResult("gbFlashPanel", { error: e.message });
            throw e;
        } finally {
            gbFlasher = null;
        }
    });
}

async function gbFlashWrite() {
    if (!gbFlashRom) return;
    const manual = selectedGbFlashProfile();
    if (!await confirmAction("Write this ROM to the flash cart?",
        `The ROM on the inserted flash cart will be replaced with ${gbFlashRom.name} ` +
        `(${formatSize(gbFlashRom.data.length)}).`, "Write ROM")) {
        return;
    }
    await runGbOp("Writing the flash cart", async () => {
        try {
            const t0 = Date.now();
            const res = await gbWithAgent(async (client) => {
                const flasher = new GbFlashcart(client, { log });
                gbFlasher = flasher;
                if (!manual) await gbFlashDetectInner(flasher);
                else log(`Using the chosen cart type: ${manual.names[0]}`);
                setStatus("Writing the flash cart...", "busy");
                return flasher.writeRom(gbFlashRom.data, {
                    profile: manual || undefined,
                    eraseRest: document.getElementById("gbFlashEraseRest").checked,
                    onProgress: flashProgress(),
                });
            });
            gbHeader = null;
            const took = formatTime(Math.floor((Date.now() - t0) / 1000));
            const skipped = res.skipped ? `, ${res.skipped} unchanged sector${res.skipped === 1 ? "" : "s"} skipped` : "";
            const cleared = res.cleared ? `, ${res.cleared} sector${res.cleared === 1 ? "" : "s"} of old data erased` : "";
            log(`Flash cart written and verified: ${gbFlashRom.name} in ${took} (${res.mapper} banking)${skipped}${cleared}. ` +
                "Power-cycle the GBA to play.", "success");
            setStatus("ROM written and checked", "ok");
            setProgress(100, `${gbFlashRom.name} in ${took}. Turn the GBA off and on to play it.`);
        } catch (e) {
            if (e.code === "cancelled") {
                log("The cart now holds a partly written ROM. Write it again to finish — the parts already written are skipped.", "error");
            }
            throw e;
        } finally {
            gbFlasher = null;
        }
    });
}

function loadGbFlashFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        gbFlashRom = { name: file.name, data: new Uint8Array(reader.result) };
        log(`ROM loaded for the flash cart: ${file.name} (${formatSize(gbFlashRom.data.length)})`);
        updateButtons();
    };
    reader.onerror = () => {
        log("Failed to read the ROM file.", "error");
        gbFlashRom = null;
        updateButtons();
    };
    reader.readAsArrayBuffer(file);
}

// Shows flash cart progress: the current step, the percentage, and the time
// left while writing.
function flashProgress() {
    const phases = { compare: "Checking what's already on the cart", erase: "Erasing", write: "Writing the ROM" };
    let writeStart = 0;
    return (done, total, phase) => {
        const pct = total ? Math.floor(done / total * 100) : 100;
        let eta = "";
        if (phase === "write") {
            if (!writeStart) writeStart = Date.now();
            const elapsed = (Date.now() - writeStart) / 1000;
            if (done > 0 && elapsed > 2) eta = `, about ${formatTime(Math.floor((total - done) / (done / elapsed)))} left`;
        }
        setProgress(pct, `${phases[phase] || phase}: ${pct}%${eta}`);
    };
}

// ============================== GBA cartridges ==============================

// Sets up the link for the GBA dumper: GB_LINK mode at 3.3V (only GBC mode
// needs 5V), sending 32-bit words at the same speed as multiboot. Skipped if
// the link is already set up this way.
async function gbaConfigureLink(force = false) {
    if (gbaLinkConfigured && !force) return;
    if (usb.isNewFirmware) {
        await usb.setMode(MODE.GB_LINK);
        await delay(100);
        linkModeSet = true;
    }
    await usb.setVoltage('3v3');
    await delay(100);
    await usb.setTimingConfig(36, 4);
    await delay(50);
    gbaLinkConfigured = true;
    gbLinkConfigured = false;
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

async function gbaReadInfoInner() {
    setStatus("Reading the cartridge...", "busy");
    const info = await gbaClient.readInfo();
    if (info.noCart) {
        gbaCartInfo = null;
        renderCart("gbaCartPanel", {
            kind: "missing",
            title: "No cartridge found",
            text: "Insert a GBA cartridge, then read it again. Blank flash carts have no header and show up like this too: use the Flash Cart tab for them.",
        });
        setStatus("No cartridge found", "warn");
        log("No GBA cartridge detected.");
        return;
    }
    gbaCartInfo = info;
    const saveTxt = info.savesize > 0 ? `${formatSize(info.savesize)} ${saveTypeName(info.savesize)}` : "None found";
    renderCart("gbaCartPanel", {
        kind: "cart",
        title: info.title || "(no title)",
        tags: [["Game Boy Advance", "tag-system"]],
        facts: [["ROM", formatSize(info.gamesize)], ["Save", saveTxt],
            ["Game code", info.code || "—"], ["Maker", info.maker || "—"]],
    });
    setStatus("Cartridge read", "ok");
    log(`GBA cart: ${info.title} [${info.code}${info.maker}] — ROM ${formatSize(info.gamesize)}, save ${saveTxt}`, "success");
}

// Runs a GBA action button's work: marks the link busy, resets the progress
// display, and reports errors or a cancel in the log.
async function runGbaOp(label, fn) {
    if (!usb.isConnected || !gbaReady || !gbaClient || gbBusy || gbaBusy) return;
    gbaBusy = true;
    gbaClient.cancelRequested = false;
    updateButtons();
    setProgress(0, "");
    try {
        await gbaConfigureLink();
        setStatus(`${label}...`, "busy");
        await fn();
    } catch (e) {
        if (e && e.code === "cancelled") {
            log(`${label} cancelled.`, "error");
            setStatus("Cancelled", "warn");
            setProgress(null, `${label} was cancelled.`);
        } else {
            log(`${label} failed: ${e.message}`, "error");
            setStatus(`${label} failed`, "error");
            setProgress(null, e.message);
        }
    }
    gbaBusy = false;
    updateButtons();
}

function gbaProgress(label, startTime) {
    return (done, total) => {
        const pct = Math.floor((done / total) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = elapsed > 0 ? done / elapsed : 0;
        const remaining = rate > 0 ? Math.floor((total - done) / rate) : 0;
        const eta = done > 0x2000 ? `about ${formatTime(remaining)} left` : "working out the time left";
        setProgress(pct, `${label}: ${pct}%, ${formatSize(done)} of ${formatSize(total)}, ${eta}`);
    };
}

async function sendGbaDumper() {
    if (!usb.isConnected || !gbaRomData || gbBusy || gbaBusy) return;
    gbaBusy = true;
    gbaReady = false;
    gbaCartInfo = null;
    updateButtons();
    setProgress(0, "");
    try {
        log("--- GBA: sending cart dumper payload ---");
        setStatus("Sending the dumper...", "busy");
        if (usb.isNewFirmware) {
            await usb.setMode(MODE.GB_LINK);
            await delay(100);
        }
        // Sent at 3.3V, the same way as the GB/GBC homebrew.
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
            setStatus("Multiboot failed", "error");
            setProgress(0, "The GBA didn't take the dumper. Turn it off and on again with no cartridge in, then send it again.");
        } else {
            gbaLinkConfigured = true; // multiboot left the link set up this way
            gbaClient = new GbaCartClient(usb, log);
            setProgress(100, "");
            await delay(800); // give the dumper time to start
            setStatus("Waiting for the dumper...", "busy");
            if (await gbaClient.ping(5000)) {
                gbaReady = true;
                log("GBA dumper is running.", "success");
                await gbaReadInfoInner(); // shows "no cartridge" until one is inserted
            } else {
                log("The payload did not answer — check the cable and try again.", "error");
                setStatus("The dumper isn't answering", "error");
                setProgress(0, "Check the cable, then send the dumper again.");
            }
        }
    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("Sending the dumper failed", "error");
        setProgress(null, e.message);
    }
    gbaBusy = false;
    updateButtons();
}

async function gbaAlreadyLoaded() {
    if (!usb.isConnected || gbBusy || gbaBusy) return;
    gbaBusy = true;
    updateButtons();
    setProgress(0, "");
    try {
        log("--- GBA: adopting an already-running dumper payload ---");
        await gbaConfigureLink(true);
        gbaClient = new GbaCartClient(usb, log);
        setStatus("Looking for the dumper...", "busy");
        if (await gbaClient.ping(5000)) {
            gbaReady = true;
            log("GBA dumper found.", "success");
            await gbaReadInfoInner();
        } else {
            gbaReady = false;
            log("No running GBA dumper payload found. Use \"Send Multiboot\" first.", "error");
            setStatus("The dumper isn't running", "error");
            setProgress(0, "Send it with \"Send Multiboot\" first.");
        }
    } catch (e) {
        log(`Error: ${e.message}`, "error");
        setStatus("Connecting to the dumper failed", "error");
        setProgress(null, e.message);
    }
    gbaBusy = false;
    updateButtons();
}

async function gbaReadInfo() {
    await runGbaOp("Reading the cartridge", gbaReadInfoInner);
}

// A flash cart doesn't mark where the game ends, so the dump covers the whole
// chip. If the end of the dump is erased space (0xFF bytes) reaching back
// past a power-of-two size, it's a flash cart with room to spare, and this
// returns the length up to the last byte that isn't 0xFF. Otherwise it's a
// retail ROM padded with 0xFF to its chip size, and the full length is kept.
function trimErasedTail(data) {
    let end = data.length;
    while (end > 0 && data[end - 1] === 0xFF) end--;
    if (end === 0) return data.length;
    let size = 1;
    while (size < end) size *= 2;
    return size < data.length ? end : data.length;
}

async function gbaDumpRom() {
    await runGbaOp("Dumping the ROM", async () => {
        const t0 = Date.now();
        let data;
        try {
            ({ data } = await gbaClient.dumpRom(gbaProgress("Received", t0)));
        } catch (e) {
            e.message += olderPayloadHint(e);
            throw e;
        }
        // The dump starts with the cartridge header, so the file can be named
        // even if Read Cartridge was never clicked.
        if (!gbaCartInfo) gbaCartInfo = headerInfoFromBytes(data);
        log(`GBA ROM dump complete: ${formatSize(data.length)} in ${formatTime(Math.floor((Date.now() - t0) / 1000))}.`, "success");
        const romSize = trimErasedTail(data);
        if (romSize < data.length) {
            log(`The last ${formatSize(data.length - romSize)} is erased flash (all 0xFF) — saving the ROM's ${romSize.toLocaleString()} bytes.`);
            data = data.subarray(0, romSize);
        }
        setStatus("ROM dumped", "ok");
        setProgress(100, `${formatSize(data.length)} — it's in Files, ready to save.`);
        offerDownload(data, "GBA_ROM");
    });
}

async function gbaDumpSave() {
    await runGbaOp("Dumping the save", async () => {
        const t0 = Date.now();
        const { data } = await gbaClient.dumpSave(gbaProgress("Received", t0));
        log(`GBA save dump complete: ${formatSize(data.length)}.`, "success");
        setStatus("Save dumped", "ok");
        setProgress(100, `${formatSize(data.length)} — it's in Files, ready to save.`);
        offerDownload(data, "GBA_SAVE");
    });
}

async function gbaDumpBios() {
    await runGbaOp("Dumping the BIOS", async () => {
        const t0 = Date.now();
        const { data } = await gbaClient.dumpBios(gbaProgress("Received", t0));
        log(`GBA BIOS dump complete: ${formatSize(data.length)}.`, "success");
        setStatus("BIOS dumped", "ok");
        setProgress(100, `${formatSize(data.length)} — it's in Files, ready to save.`);
        offerDownload(data, "GBA_BIOS");
    });
}

async function gbaRestoreSave() {
    if (!gbaRestoreData) return;
    if (!await confirmAction("Overwrite the save?",
        `The save on the inserted cartridge will be replaced with ${gbaRestoreName} ` +
        `(${formatSize(gbaRestoreData.length)}). This can't be undone.`, "Restore Save")) {
        return;
    }
    await runGbaOp("Restoring the save", async () => {
        const t0 = Date.now();
        log("Uploading save, then writing to the cartridge — flash carts can take a minute.");
        await gbaClient.restoreSave(gbaRestoreData, gbaProgress("Sent", t0));
        log("GBA save restored. Power-cycle the cartridge and check in-game.", "success");
        setStatus("Save restored", "ok");
        setProgress(100, "Turn the GBA off and on with the cartridge to check it in-game.");
    });
}

async function gbaEraseSave() {
    if (!await confirmAction("Erase the save?",
        "The save memory on the inserted cartridge will be filled with zeros. This can't be undone.",
        "Erase Save")) {
        return;
    }
    await runGbaOp("Erasing the save", async () => {
        const { savesize } = await gbaClient.eraseSave();
        log(`GBA save erased (${formatSize(savesize)} zero-filled).`, "success");
        setStatus("Save erased", "ok");
        setProgress(100, `${formatSize(savesize)} filled with zeros.`);
    });
}

function loadGbaRestoreFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        gbaRestoreData = new Uint8Array(reader.result);
        gbaRestoreName = file.name;
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

// ------------------------------------------------------- GBA flash carts

function fillFlashProfileList() {
    const select = document.getElementById("gbaFlashProfile");
    if (typeof GbaFlashcart === "undefined" || typeof FLASHCART_PROFILES === "undefined") return;
    const profiles = GbaFlashcart.flashableProfiles(FLASHCART_PROFILES)
        .slice().sort((a, b) => a.names[0].localeCompare(b.names[0]));
    for (const p of profiles) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.names[0];
        select.appendChild(opt);
    }
}

function selectedFlashProfile() {
    const id = document.getElementById("gbaFlashProfile").value;
    return id ? FLASHCART_PROFILES.find(p => p.id === id) : null;
}

function flashSizeText(det) {
    const listed = det.profile.flash_size, reported = det.cfi && det.cfi.deviceSize;
    let size = formatSize(listed || reported || 0);
    if (listed && reported && reported !== listed) {
        size = `${formatSize(listed)} (the chip reports ${formatSize(reported)})`;
    }
    return listed || reported ? size : "size unknown";
}

// If the GBA is running an older dumper that doesn't know this command,
// suggest sending this version.
function olderPayloadHint(e) {
    if (e && e.code === "desync" && /handshake/i.test(e.message)) {
        return " The GBA may be running an older dumper — click \"Send Multiboot\" to load this version.";
    }
    return "";
}

async function gbaFlashDetectInner(flasher) {
    setStatus("Detecting the flash cart...", "busy");
    const det = await flasher.detect();
    gbaFlashDetected = det;
    renderFlashResult("gbaFlashPanel", det);
    log(`Flash cart: ${det.profile.names[0]}, ${flashSizeText(det)} (${det.method}).`, "success");
    setStatus("Flash cart found", "ok");
    setProgress(100, det.profile.names[0]);
    return det;
}

async function gbaFlashDetect() {
    await runGbaOp("Detecting the flash cart", async () => {
        gbaFlasher = new GbaFlashcart(gbaClient, { log });
        try {
            await gbaFlashDetectInner(gbaFlasher);
        } catch (e) {
            gbaFlashDetected = null;
            if (e.code === "no-flash") renderFlashResult("gbaFlashPanel", { error: e.message });
            e.message += olderPayloadHint(e);
            throw e;
        } finally {
            gbaFlasher = null;
        }
    });
}

async function gbaFlashWrite() {
    if (!gbaFlashRom) return;
    const manual = selectedFlashProfile();
    if (!await confirmAction("Write this ROM to the flash cart?",
        `The ROM on the inserted flash cart will be replaced with ${gbaFlashRom.name} ` +
        `(${formatSize(gbaFlashRom.data.length)}).`, "Write ROM")) {
        return;
    }
    await runGbaOp("Writing the flash cart", async () => {
        const flasher = new GbaFlashcart(gbaClient, { log });
        gbaFlasher = flasher;
        try {
            if (!manual) {
                await gbaFlashDetectInner(flasher);
            } else {
                log(`Using the chosen cart type: ${manual.names[0]}`);
            }
            const t0 = Date.now();
            setStatus("Writing the flash cart...", "busy");
            const res = await flasher.writeRom(gbaFlashRom.data, {
                profile: manual || undefined,
                eraseRest: document.getElementById("gbaFlashEraseRest").checked,
                onProgress: flashProgress(),
            });
            const took = formatTime(Math.floor((Date.now() - t0) / 1000));
            const skipped = res.skipped ? `, ${res.skipped} unchanged sector${res.skipped === 1 ? "" : "s"} skipped` : "";
            const cleared = res.cleared ? `, ${res.cleared} sector${res.cleared === 1 ? "" : "s"} of old data erased` : "";
            log(`Flash cart written and verified: ${gbaFlashRom.name} in ${took}${skipped}${cleared}. ` +
                "Power-cycle the GBA to play.", "success");
            setStatus("ROM written and checked", "ok");
            setProgress(100, `${gbaFlashRom.name} in ${took}. Turn the GBA off and on to play it.`);
        } catch (e) {
            if (e.code === "cancelled") {
                log("The cart now holds a partly written ROM. Write it again to finish — the parts already written are skipped.", "error");
            } else {
                e.message += olderPayloadHint(e);
            }
            throw e;
        } finally {
            gbaFlasher = null;
        }
    });
}

function loadGbaFlashFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        gbaFlashRom = { name: file.name, data: new Uint8Array(reader.result) };
        log(`ROM loaded for the flash cart: ${file.name} (${formatSize(gbaFlashRom.data.length)})`);
        updateButtons();
    };
    reader.onerror = () => {
        log("Failed to read the ROM file.", "error");
        gbaFlashRom = null;
        updateButtons();
    };
    reader.readAsArrayBuffer(file);
}

// The action tabs (Back Up / Restore / Flash Cart). The last tab picked is
// remembered.
function initTabs() {
    document.querySelectorAll(".tabs").forEach((list) => {
        const group = list.dataset.tabs;
        const select = (name) => {
            list.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
            document.querySelectorAll(`.tab-panel[data-tabs="${group}"]`).forEach(p => { p.hidden = p.dataset.panel !== name; });
            try { localStorage.setItem(`cartDoctorTab-${group}`, name); } catch (e) { /* private browsing */ }
        };
        list.addEventListener("click", (e) => {
            const tab = e.target.closest(".tab");
            if (tab) select(tab.dataset.tab);
        });
        let saved = null;
        try { saved = localStorage.getItem(`cartDoctorTab-${group}`); } catch (e) { /* private browsing */ }
        select(saved && list.querySelector(`.tab[data-tab="${saved}"]`) ? saved : "backup");
    });
}

// File boxes: show the chosen file's name, and accept files dragged onto them.
function initDropZones() {
    document.querySelectorAll(".drop").forEach((zone) => {
        const input = zone.querySelector("input[type=file]");
        const title = zone.querySelector(".drop-title");
        const sub = zone.querySelector(".drop-sub");
        const emptyTitle = title.textContent;
        const emptySub = sub.innerHTML;
        input.addEventListener("change", () => {
            const file = input.files[0];
            zone.classList.toggle("has-file", !!file);
            if (file) {
                title.textContent = file.name;
                sub.textContent = `${formatSize(file.size)} · click to choose another`;
            } else {
                title.textContent = emptyTitle;
                sub.innerHTML = emptySub;
            }
        });
        zone.addEventListener("dragover", (e) => {
            e.preventDefault();
            zone.classList.add("dragging");
        });
        zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
        zone.addEventListener("drop", (e) => {
            e.preventDefault();
            zone.classList.remove("dragging");
            if (zone.classList.contains("disabled") || !e.dataTransfer.files.length) return;
            input.files = e.dataTransfer.files;
            input.dispatchEvent(new Event("change"));
        });
    });
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

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("connectBtn").addEventListener("click", () => toggleConnect(transport));
    document.getElementById("startBtn").addEventListener("click", sendGbMultiboot);
    document.getElementById("dumpOnlyBtn").addEventListener("click", gbAlreadyLoaded);
    document.getElementById("gbInfoBtn").addEventListener("click", gbReadInfo);
    document.getElementById("gbDumpRomBtn").addEventListener("click", gbDumpRom);
    document.getElementById("gbDumpSaveBtn").addEventListener("click", gbDumpSave);
    document.getElementById("restoreBtn").addEventListener("click", gbRestoreSave);
    document.getElementById("cancelBtn").addEventListener("click", cancelOp);
    document.getElementById("restoreFile").addEventListener("change", (e) => {
        loadGbRestoreFile(e.target.files[0]);
    });
    document.getElementById("gbFlashDetectBtn").addEventListener("click", gbFlashDetect);
    document.getElementById("gbFlashWriteBtn").addEventListener("click", gbFlashWrite);
    document.getElementById("gbFlashFile").addEventListener("change", (e) => {
        loadGbFlashFile(e.target.files[0]);
    });
    fillGbFlashProfileList();

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
    document.getElementById("gbaFlashDetectBtn").addEventListener("click", gbaFlashDetect);
    document.getElementById("gbaFlashWriteBtn").addEventListener("click", gbaFlashWrite);
    document.getElementById("gbaFlashFile").addEventListener("change", (e) => {
        loadGbaFlashFile(e.target.files[0]);
    });
    fillFlashProfileList();

    document.getElementById("modeGbBtn").addEventListener("click", () => setCartMode("gb"));
    document.getElementById("modeGbaBtn").addEventListener("click", () => setCartMode("gba"));
    let savedMode = null;
    try { savedMode = localStorage.getItem("cartDoctorMode"); } catch (e) { /* private browsing */ }
    if (savedMode === "gb" || savedMode === "gba") setCartMode(savedMode);

    if (!transport) {
        document.getElementById("browserWarning").hidden = false;
    }

    initTabs();
    initDropZones();
    renderCart("gbCartPanel", CART_NOT_READ);
    renderCart("gbaCartPanel", CART_NOT_READ);
    setStatus("Not connected", "idle");

    loadMultibootROM();
    loadGbAgent();
    loadGbaDumperROM();
    updateButtons();
});
