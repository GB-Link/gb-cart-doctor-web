/**
 * The EZ Flash Jr tab: a file browser for the microSD card inside an EZ Flash Jr.
 *
 * Works like the other Game Boy actions: each action runs through runGbOp()
 * and gbWithAgent() from app.js, so the cart agent is uploaded for it and the
 * GBC goes back to its menu afterwards. The card is mounted again for every
 * action (a few sector reads), so swapping cards or carts between actions is
 * safe.
 *
 * The EZ Flash Jr only answers if it was inserted after the GBA switched to
 * GBC mode: its SD interface works in the mode it powers up in.
 */

"use strict";

// Computers leave these on any card they mount; on a Game Boy card they only hide the ROMs.
const EZJR_CLUTTER = /^(\._.*|\.DS_Store|\.Spotlight-V100|\.fseventsd|\.Trashes|\.TemporaryItems|System Volume Information|desktop\.ini|Thumbs\.db)$/i;

let ezjrFirmware = null;    // 4 or 5 once an EZ Flash Jr has answered
let ezjrCard = null;        // FatVolume.info() of the card
let ezjrCwd = "/";
let ezjrEntries = null;     // the folder listing on screen

// ---------------------------------------------------------------- hooks used by app.js

/** The cart in the slot is a detected EZ Flash Jr. */
function ezjrCartFound() {
    return ezjrFirmware !== null;
}

/** A new GBC session: forget the cart. */
function ezjrReset() {
    ezjrFirmware = null;
    ezjrCard = null;
    ezjrCwd = "/";
    ezjrEntries = null;
    ezjrRender();
}

/**
 * Read Cartridge found no game header, or the EZ Flash Jr boot loader's
 * (title BOOTLOADER). Check for an EZ Flash Jr. Returns true if it is one.
 */
async function ezjrProbeAfterRead() {
    let firmware = null;
    try {
        firmware = await gbWithAgent(async (client) => {
            const v = await new EzJrSd(client).readFirmwareVersion();
            return v === 4 || v === 5 ? v : null;
        });
    } catch (e) {
        // Not an error for the user: Read Cartridge's own answer stands.
        log(`EZ Flash Jr check failed: ${e.message}`);
        return false;
    }
    if (firmware === null) return false;
    ezjrFirmware = firmware;
    ezjrCard = null;
    ezjrEntries = null;
    ezjrRenderCart();
    ezjrRender();
    setStatus("EZ Flash Jr found", "ok");
    log(`EZ Flash Jr found (firmware ${firmware}). Open the EZ Flash Jr tab to manage its SD card.`, "success");
    return true;
}

function ezjrUpdateButtons(actionsOff, linkBusy) {
    const writable = document.getElementById("ezjrWrites").checked;
    const open = ezjrEntries !== null;
    document.getElementById("ezjrOpenBtn").disabled = actionsOff;
    document.getElementById("ezjrRefreshBtn").disabled = actionsOff || !open;
    document.getElementById("ezjrUploadBtn").disabled = actionsOff || !open || !writable;
    document.getElementById("ezjrMkdirBtn").disabled = actionsOff || !open || !writable;
    document.getElementById("ezjrFolderName").disabled = actionsOff || !open || !writable;
    document.getElementById("ezjrSectors").disabled = linkBusy;
    document.getElementById("ezjrVerify").disabled = linkBusy;
    document.getElementById("ezjrDrop").classList.toggle("disabled", actionsOff || !writable);
    document.querySelectorAll("#ezjrRows button").forEach((b) => {
        b.disabled = actionsOff || (b.dataset.write === "1" && !writable);
    });
}

// ---------------------------------------------------------------- running actions

/**
 * Runs fn(volume, client) with the card mounted. Checks that the cart is an
 * EZ Flash Jr first.
 */
async function ezjrWithCard(fn) {
    return gbWithAgent(async (client) => {
        const sd = new EzJrSd(client, {
            sectorsPerCommand: Number(document.getElementById("ezjrSectors").value),
            verifyWrites: document.getElementById("ezjrVerify").checked,
        });
        // A cart that just went in may still be starting its SD card, so the first
        // check waits longer. Checking on every action catches a swapped cart.
        const { firmware } = await sd.detect({ timeoutMs: ezjrFirmware ? 1500 : 5000 });
        if (ezjrFirmware !== firmware) {
            ezjrFirmware = firmware;
            log(`EZ Flash Jr found (firmware ${firmware}).`, "success");
        }
        const vol = await FatVolume.mount(sd);
        ezjrCard = vol.info();
        ezjrRenderCart();
        return fn(vol, client);
    });
}

/** Cancel stops the transfer between blocks; app.js's Cancel button calls client.cancel(). */
function ezjrCancelled(client) {
    return () => client.cancelled;
}

/**
 * Finish the current job without listening to Cancel: used for the short
 * writes to the FAT and folders, which must not stop half way.
 */
function ezjrUncancellable() {
    // cancelOp() in app.js reaches the agent only through gbClient.
    gbClient = null;
}

const ezjrJoin = (dir, name) => (dir === "/" ? "" : dir) + "/" + name;

function ezjrSortEntries(list) {
    return list.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

async function ezjrList(vol, path) {
    ezjrEntries = ezjrSortEntries(await vol.readdir(path));
    ezjrCwd = path;     // only after the read worked, so a failed folder keeps you where you were
    ezjrRender();
}

async function ezjrOpen() {
    await runGbOp("Opening the SD card", async () => {
        await ezjrWithCard((vol) => ezjrList(vol, "/"));
        const free = ezjrCard.freeBytes == null ? "" : `, ${formatSize(ezjrCard.freeBytes)} free`;
        setStatus("SD card open", "ok");
        setProgress(100, `${ezjrCard.type}, ${ezjrSizeText(ezjrCard.totalBytes)}${free}`);
        log(`SD card: ${ezjrCard.type}, ${ezjrSizeText(ezjrCard.totalBytes)}${free}.`, "success");
    });
}

async function ezjrRefresh(path = ezjrCwd) {
    await runGbOp("Reading the folder", async () => {
        await ezjrWithCard((vol) => ezjrList(vol, path));
        setStatus("Folder read", "ok");
        setProgress(0, "");
    });
}

async function ezjrDownload(entry) {
    await runGbOp(`Downloading ${entry.name}`, async () => {
        const t0 = Date.now();
        const data = await ezjrWithCard((vol, client) => vol.readFile(ezjrJoin(ezjrCwd, entry.name), {
            onProgress: gbaProgress("Downloaded", t0),
            isCancelled: ezjrCancelled(client),
        }));
        setStatus("File downloaded", "ok");
        setProgress(100, `${entry.name}, ${formatSize(data.length)} in ${formatTime(Math.floor((Date.now() - t0) / 1000))}. It's in Files, ready to save.`);
        offerDownload(data, "SD_FILE", entry.name);
    });
}

async function ezjrDelete(entry) {
    const what = entry.isDir ? `the folder "${entry.name}"` : `"${entry.name}"`;
    const ok = await confirmAction(`Delete ${entry.isDir ? "folder" : "file"}?`,
        `This deletes ${what} from the microSD card. It can't be undone.${entry.isDir ? " Only empty folders can be deleted." : ""}`,
        "Delete");
    if (!ok) return;
    await runGbOp(`Deleting ${entry.name}`, async () => {
        await ezjrWithCard(async (vol) => {
            ezjrUncancellable();
            await vol.remove(ezjrJoin(ezjrCwd, entry.name));
            ezjrCard = vol.info();
            ezjrRenderCart();
            await ezjrList(vol, ezjrCwd);
        });
        setStatus("Deleted", "ok");
        setProgress(100, `${entry.name} was deleted.`);
        log(`Deleted ${ezjrJoin(ezjrCwd, entry.name)} from the SD card.`, "success");
    });
}

async function ezjrMkdir() {
    const input = document.getElementById("ezjrFolderName");
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    await runGbOp(`Creating ${name}`, async () => {
        await ezjrWithCard(async (vol) => {
            ezjrUncancellable();
            await vol.mkdir(ezjrJoin(ezjrCwd, name));
            await ezjrList(vol, ezjrCwd);
        });
        input.value = "";
        setStatus("Folder created", "ok");
        setProgress(100, `Created ${name}.`);
        log(`Created folder ${ezjrJoin(ezjrCwd, name)} on the SD card.`, "success");
    });
}

async function ezjrRename(entry, newName) {
    newName = newName.trim();
    if (!newName || newName === entry.name) { ezjrRender(); return; }
    const ext = (n) => (n.includes(".") ? n.split(".").pop().toLowerCase() : "");
    const base = (n) => (n.includes(".") ? n.slice(0, n.lastIndexOf(".")) : n);
    // The EZ Flash Jr finds a game's save by the ROM's name (Tetris.gb uses
    // /SAVER/Tetris.sav), so a renamed ROM takes its save along or loses it.
    const isRom = !entry.isDir && ["gb", "gbc"].includes(ext(entry.name)) && ["gb", "gbc"].includes(ext(newName));
    await runGbOp(`Renaming ${entry.name}`, async () => {
        let saveNote = "";
        await ezjrWithCard(async (vol) => {
            ezjrUncancellable();
            await vol.rename(ezjrJoin(ezjrCwd, entry.name), newName);
            if (isRom && base(newName) !== base(entry.name)) {
                const oldSave = `/SAVER/${base(entry.name)}.sav`, newSave = `${base(newName)}.sav`;
                const save = await vol.stat(oldSave);
                if (save && !save.isDir) {
                    if (await vol.stat(`/SAVER/${newSave}`)) {
                        saveNote = ` Its save wasn't renamed: /SAVER/${newSave} already exists.`;
                    } else {
                        await vol.rename(oldSave, newSave);
                        saveNote = ` Its save is now /SAVER/${newSave}; dated save backups keep their old names.`;
                    }
                }
            }
            await ezjrList(vol, ezjrCwd);
        });
        setStatus("Renamed", "ok");
        setProgress(100, `${entry.name} is now ${newName}.${saveNote}`);
        log(`Renamed ${ezjrJoin(ezjrCwd, entry.name)} to ${newName}.${saveNote}`, "success");
    });
    // After a failed rename the row still holds the editor; draw the listing again.
    ezjrRender();
}

/** Swap the row's name for a text box: Enter renames, Esc or leaving the box cancels. */
function ezjrStartRename(entry, nameCell) {
    const input = el("input", "sd-input sd-rename");
    input.type = "text";
    input.value = entry.name;
    input.maxLength = 255;
    let finished = false;
    const finish = (save) => {
        if (finished) return;
        finished = true;
        if (save) ezjrRename(entry, input.value);
        else ezjrRender();
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(false));
    nameCell.replaceChildren(input);
    input.focus();
    // Select the name without its extension, the part people usually change.
    const dot = entry.isDir ? -1 : entry.name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
}

async function ezjrUpload(files) {
    files = [...files];
    if (!files.length || ezjrEntries === null || !document.getElementById("ezjrWrites").checked) return;

    // Ask about replacing files first, so the transfer can run unattended.
    const plan = [];
    for (const file of files) {
        // FAT names ignore case: "tetris.gb" would replace "TETRIS.GB".
        const existing = ezjrEntries.find((e) => e.name.toUpperCase() === file.name.toUpperCase());
        if (existing && existing.isDir) {
            log(`Skipped ${file.name}: there's a folder with that name.`, "error");
            continue;
        }
        if (existing && !(await confirmAction("Replace file?", `"${existing.name}" is already on the card in this folder. Replace it with the one you picked?`, "Replace"))) {
            continue;
        }
        plan.push({ file, overwrite: !!existing });
    }
    if (!plan.length) return;

    const total = plan.reduce((n, p) => n + p.file.size, 0);
    await runGbOp(plan.length === 1 ? `Uploading ${plan[0].file.name}` : `Uploading ${plan.length} files`, async () => {
        const t0 = Date.now();
        const progress = gbaProgress("Uploaded", t0);
        let before = 0;
        await ezjrWithCard(async (vol, client) => {
            for (const { file, overwrite } of plan) {
                const data = new Uint8Array(await file.arrayBuffer());
                setStatus(`Uploading ${file.name}...`, "busy");
                await vol.writeFile(ezjrJoin(ezjrCwd, file.name), data, {
                    overwrite,
                    modified: new Date(file.lastModified || Date.now()),
                    onProgress: (done) => progress(before + done, total),
                    isCancelled: ezjrCancelled(client),
                    // Once the data is written, Cancel must not stop the FAT and folder
                    // entry half way; hide the client from cancelOp() until this file is done.
                    onCommit: () => { gbClient = null; },
                });
                gbClient = client;
                before += data.length;
                log(`Uploaded ${file.name} (${formatSize(data.length)}) to ${ezjrCwd}.`, "success");
            }
            ezjrCard = vol.info();
            ezjrRenderCart();
            await ezjrList(vol, ezjrCwd);
        });
        setStatus("Upload complete", "ok");
        setProgress(100, `${plan.length === 1 ? plan[0].file.name : `${plan.length} files`}, ${formatSize(total)} in ${formatTime(Math.floor((Date.now() - t0) / 1000))}.`);
    });
}

// ---------------------------------------------------------------- drawing

function ezjrSizeText(bytes) {
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : formatSize(bytes);
}

function ezjrRenderCart() {
    if (ezjrFirmware === null) return;
    const facts = [["Firmware", `FW${ezjrFirmware}`]];
    if (ezjrCard) {
        facts.push(["SD card", `${ezjrCard.type}, ${ezjrSizeText(ezjrCard.totalBytes)}`]);
        facts.push(["Free", ezjrCard.freeBytes == null ? "Unknown" : ezjrSizeText(ezjrCard.freeBytes)]);
    } else {
        facts.push(["SD card", "Open the EZ Flash Jr tab"]);
    }
    renderCart("gbCartPanel", {
        kind: "cart",
        // The title the cart reports (its boot loader's, BOOTLOADER), like any other
        // cartridge. Opening the tab before Read Cartridge leaves no header to show.
        title: gbHeader && gbHeader.headerOk && gbHeader.title ? gbHeader.title : "EZ Flash Jr",
        tags: [["EZ Flash Jr", "tag-system"], ["microSD", ""]],
        facts,
    });
}

function ezjrRender() {
    const browser = document.getElementById("ezjrBrowser");
    if (!browser) return;
    browser.hidden = ezjrEntries === null;
    if (ezjrEntries === null) return;

    const crumbs = document.getElementById("ezjrCrumbs");
    crumbs.replaceChildren();
    const parts = fatSplitPath(ezjrCwd);
    const crumb = (label, path, last) => {
        if (last) { crumbs.append(el("span", "sd-crumb-here", label)); return; }
        const b = el("button", "sd-crumb", label);
        b.addEventListener("click", () => ezjrRefresh(path));
        crumbs.append(b, el("span", "sd-crumb-sep", "/"));
    };
    crumb("SD card", "/", parts.length === 0);
    parts.forEach((p, i) => crumb(p, "/" + parts.slice(0, i + 1).join("/"), i === parts.length - 1));

    const showHidden = document.getElementById("ezjrShowHidden").checked;
    const shown = ezjrEntries.filter((e) => showHidden || !(EZJR_CLUTTER.test(e.name) || e.hidden));
    const rows = [];
    if (parts.length) {
        const tr = el("tr", "sd-row");
        const td = el("td", "", "");
        td.colSpan = 4;
        const up = el("button", "sd-name sd-dir", "");
        up.append(el("span", "sd-icon", "↩"), el("span", "", "Up one folder"));
        up.addEventListener("click", () => ezjrRefresh("/" + parts.slice(0, -1).join("/")));
        td.append(up);
        tr.append(td);
        rows.push(tr);
    }
    for (const e of shown) rows.push(ezjrRow(e));
    document.getElementById("ezjrRows").replaceChildren(...rows);
    const empty = document.getElementById("ezjrEmpty");
    empty.hidden = shown.length > 0;
    empty.textContent = ezjrEntries.length ? "Only hidden files in this folder." : "This folder is empty.";
    updateButtons();
}

function ezjrIcon(e) {
    if (e.isDir) return "📁";
    const ext = e.name.split(".").pop().toLowerCase();
    if (ext === "gb" || ext === "gbc") return "🎮";
    if (ext === "sav" || ext === "srm") return "💾";
    return "📄";
}

function ezjrRow(e) {
    const tr = el("tr", "sd-row");
    const nameCell = el("td");
    const name = el(e.isDir ? "button" : "span", e.isDir ? "sd-name sd-dir" : "sd-name");
    name.append(el("span", "sd-icon", ezjrIcon(e)), el("span", "", e.name));   // names come from the card: textContent only
    if (e.isDir) name.addEventListener("click", () => ezjrRefresh(ezjrJoin(ezjrCwd, e.name)));
    nameCell.append(name);
    const size = el("td", "sd-size", e.isDir ? "" : formatSize(e.size));
    const date = el("td", "sd-date", e.modified ? e.modified.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");
    const act = el("td", "sd-actions");
    if (!e.isDir) {
        const dl = el("button", "btn btn-sm btn-ghost", "Download");
        dl.addEventListener("click", () => ezjrDownload(e));
        act.append(dl);
    }
    const ren = el("button", "btn btn-sm btn-ghost", "Rename");
    ren.dataset.write = "1";
    ren.addEventListener("click", () => ezjrStartRename(e, nameCell));
    act.append(ren);
    const del = el("button", "btn btn-sm btn-danger-ghost", "Delete");
    del.dataset.write = "1";
    del.addEventListener("click", () => ezjrDelete(e));
    act.append(del);
    tr.append(nameCell, size, date, act);
    return tr;
}

// ---------------------------------------------------------------- setup

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("ezjrOpenBtn").addEventListener("click", ezjrOpen);
    document.getElementById("ezjrRefreshBtn").addEventListener("click", () => ezjrRefresh());
    document.getElementById("ezjrMkdirBtn").addEventListener("click", ezjrMkdir);
    document.getElementById("ezjrFolderName").addEventListener("keydown", (e) => { if (e.key === "Enter") ezjrMkdir(); });
    document.getElementById("ezjrUploadBtn").addEventListener("click", () => document.getElementById("ezjrUploadInput").click());
    document.getElementById("ezjrUploadInput").addEventListener("change", (e) => {
        const files = [...e.target.files];
        e.target.value = "";
        ezjrUpload(files);
    });
    document.getElementById("ezjrWrites").addEventListener("change", updateButtons);
    document.getElementById("ezjrShowHidden").addEventListener("change", ezjrRender);

    const drop = document.getElementById("ezjrDrop");
    drop.addEventListener("dragover", (e) => {
        if (drop.classList.contains("disabled") || ezjrEntries === null || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        drop.classList.add("dragging");
    });
    // dragleave also fires when moving onto a child element; only clear when leaving the box.
    drop.addEventListener("dragleave", (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("dragging"); });
    drop.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("dragging");
        if (!drop.classList.contains("disabled")) ezjrUpload(e.dataTransfer.files);
    });
});
