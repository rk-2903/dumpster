// Doc panel: a markdown editor pinned beside the page, bound to one "active"
// Doc bucket. Two layers, deliberately separate:
//
// 1. ENTRIES (unchanged): page selections, screenshots, and hotkey captures
//    still create entries and cloud-sync exactly as before. Nothing here
//    touches that flow.
// 2. BODY (new, local-first): each bucket has a free-form markdown body
//    (src/docBody.js). New entries are auto-appended to it, and the user can
//    write/edit anything around them — GitHub-style Write/Preview with a
//    formatting toolbar. Body sync to Google Docs is a later phase.
//
// Capture happens elsewhere (page dock, selection pill, right-click menu,
// Alt+Shift+S) and flows in via dumpSignal; the bottom bar holds Share and
// Open Doc for the active bucket's synced Google Doc.

import { getBuckets, ensureSeeded, addBucket, getLastBucketId, setLastBucketId, signalDump } from "./src/buckets.js";
import { addEntry, makeEntry, putImage, getImage, getEntriesByBucket, updateEntry, STATUSES } from "./src/db.js";
import { enqueueUpsert } from "./src/outbox.js";
import { captureVisible, cropBlob } from "./src/capture.js";
import { regionSelectOverlay } from "./src/regionSelect.js";
import { ytGrabTranscript } from "./src/ytTranscript.js";
import { createVoiceInput, voiceSupported } from "./src/voiceInput.js";
import { getToken, getConnection } from "./src/googleAuth.js";
import { createDocsProvider } from "./src/docsSync.js";
import { track, pingActive, flush } from "./src/telemetry.js";
import { renderMarkdown } from "./src/markdown.js";
import { getBody, setBody, ingestNewEntries, seedIfEmpty } from "./src/docBody.js";

const els = {
  bucket: document.getElementById("bucket"),
  newBucket: document.getElementById("new-bucket"),
  openViewer: document.getElementById("open-viewer"),
  fmtBlock: document.getElementById("fmt-block"),
  fmtBold: document.getElementById("fmt-bold"),
  fmtItalic: document.getElementById("fmt-italic"),
  fmtCode: document.getElementById("fmt-code"),
  fmtUl: document.getElementById("fmt-ul"),
  fmtOl: document.getElementById("fmt-ol"),
  modeWrite: document.getElementById("mode-write"),
  modePreview: document.getElementById("mode-preview"),
  editor: document.getElementById("editor"),
  preview: document.getElementById("preview"),
  capRegion: document.getElementById("cap-region"),
  capOcr: document.getElementById("cap-ocr"),
  capTs: document.getElementById("cap-ts"),
  capTsMenu: document.getElementById("cap-ts-menu"),
  voiceBtn: document.getElementById("voice-btn"),
  voiceLang: document.getElementById("voice-lang"),
  voiceMenu: document.getElementById("voice-menu"),
  voiceLive: document.getElementById("voice-live"),
  shareDoc: document.getElementById("share-doc"),
  openDoc: document.getElementById("open-doc"),
  saveState: document.getElementById("save-state"),
  dropOverlay: document.getElementById("drop-overlay"),
  dropLabel: document.getElementById("drop-label"),
  // Doc | Sheet switcher + sheet mini-tracker
  kindDoc: document.getElementById("kind-doc"),
  kindSheet: document.getElementById("kind-sheet"),
  fmtRow: document.getElementById("fmt-row"),
  docMain: document.getElementById("doc-main"),
  docBar: document.getElementById("doc-bar"),
  sheetBucket: document.getElementById("sheet-bucket"),
  sheetMain: document.getElementById("sheet-main"),
  sheetInput: document.getElementById("sheet-input"),
  sheetAdd: document.getElementById("sheet-add"),
  sheetRows: document.getElementById("sheet-rows"),
  sheetEmpty: document.getElementById("sheet-empty"),
  sheetBar: document.getElementById("sheet-bar"),
  exportDoc: document.getElementById("export-doc"),
  exportMenu: document.getElementById("export-menu"),
  exportPdf: document.getElementById("export-pdf"),
  exportDocx: document.getElementById("export-docx"),
  exportMd: document.getElementById("export-md"),
  shareSheet: document.getElementById("share-sheet"),
  openSheet: document.getElementById("open-sheet"),
  exportSheet: document.getElementById("export-sheet"),
  sheetExportMenu: document.getElementById("sheet-export-menu"),
  exportXlsx: document.getElementById("export-xlsx"),
  exportJson: document.getElementById("export-json"),
  pickBackdrop: document.getElementById("pick-backdrop"),
  pickAll: document.getElementById("pick-all"),
  pickList: document.getElementById("pick-list"),
  pickCancel: document.getElementById("pick-cancel"),
  pickGo: document.getElementById("pick-go"),
  cloudOpen: document.getElementById("cloud-open"),
  cloudDot: document.getElementById("cloud-dot"),
  toast: document.getElementById("toast"),
};

let activeBucket = null; // id of the doc this panel edits
let mode = "preview"; // "write" | "preview" — preview is the live view
let saveTimer = null;
let imageUrls = new Map(); // entryId → object URL (revoked on re-render)
let panelKind = "doc"; // "doc" | "sheet" — which surface the panel shows
let activeSheet = null; // id of the sheet bucket the tracker shows

async function init() {
  await ensureSeeded();
  pingActive();
  flush();
  await refreshBuckets();

  els.newBucket.addEventListener("click", onNewBucket);
  els.bucket.addEventListener("change", () => switchBucket(els.bucket.value));
  els.openViewer.addEventListener("click", () => chrome.runtime.openOptionsPage());

  // Doc | Sheet switcher — restore the last-used surface.
  els.kindDoc.addEventListener("click", () => setKind("doc"));
  els.kindSheet.addEventListener("click", () => setKind("sheet"));
  els.sheetBucket.addEventListener("change", () => switchSheet(els.sheetBucket.value));
  els.sheetAdd.addEventListener("click", onSheetAdd);
  els.sheetInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSheetAdd();
    }
  });
  chrome.storage.local.get("panelKind", (o) => setKind(o.panelKind === "sheet" ? "sheet" : "doc"));

  els.modeWrite.addEventListener("click", () => setMode("write"));
  els.modePreview.addEventListener("click", () => setMode("preview"));
  // Double-click anywhere in the rendered preview → jump into edit mode.
  els.preview.addEventListener("dblclick", () => {
    setMode("write");
    els.editor.focus();
  });

  // Toolbar → markdown edits at the cursor.
  els.fmtBlock.addEventListener("change", () => {
    applyBlockFormat(els.fmtBlock.value);
    els.fmtBlock.value = "p"; // stateless control
  });
  els.fmtBold.addEventListener("click", () => wrapSelection("**"));
  els.fmtItalic.addEventListener("click", () => wrapSelection("*"));
  els.fmtCode.addEventListener("click", () => wrapSelection("`"));
  els.fmtUl.addEventListener("click", () => prefixLines("- "));
  els.fmtOl.addEventListener("click", () => prefixLines("1. "));

  // Autosave the body while typing; keep the preview warm.
  els.editor.addEventListener("input", () => {
    els.saveState.textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await setBody(activeBucket, els.editor.value);
      els.saveState.textContent = "Saved";
    }, 500);
  });

  els.capRegion.addEventListener("click", () => onRegionCapture("shot"));
  els.capOcr.addEventListener("click", () => onRegionCapture("ocr"));
  els.capTs.addEventListener("click", (e) => {
    e.stopPropagation();
    els.capTsMenu.hidden = !els.capTsMenu.hidden;
  });
  els.capTsMenu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tsec]");
    if (!b) return;
    els.capTsMenu.hidden = true;
    onTranscriptCapture(Number(b.dataset.tsec) || 0);
  });
  els.shareDoc.addEventListener("click", onShareDoc);
  els.openDoc.addEventListener("click", onOpenDoc);

  // Export: PDF / DOCX / Markdown for the doc, Excel / JSON for the tracker.
  els.exportDoc.addEventListener("click", (e) => {
    e.stopPropagation();
    els.sheetExportMenu.hidden = true;
    els.exportMenu.hidden = !els.exportMenu.hidden;
  });
  els.exportSheet.addEventListener("click", (e) => {
    e.stopPropagation();
    els.exportMenu.hidden = true;
    els.sheetExportMenu.hidden = !els.sheetExportMenu.hidden;
  });
  document.addEventListener("click", () => {
    els.exportMenu.hidden = true;
    els.sheetExportMenu.hidden = true;
    els.capTsMenu.hidden = true;
    els.voiceMenu.hidden = true;
  });
  setupVoice();
  els.exportPdf.addEventListener("click", onExportPdf);
  els.exportDocx.addEventListener("click", onExportDocx);
  els.exportMd.addEventListener("click", onExportMd);
  els.exportXlsx.addEventListener("click", onExportXlsx);
  els.exportJson.addEventListener("click", onExportJson);
  els.shareSheet.addEventListener("click", onShareSheet);
  els.openSheet.addEventListener("click", onOpenSheet);

  // Export picker (choose which trackers go into the file).
  els.pickAll.addEventListener("change", () => {
    pickBoxes().forEach((b) => (b.checked = els.pickAll.checked));
    syncPickAll();
  });
  els.pickCancel.addEventListener("click", closeExportPicker);
  els.pickGo.addEventListener("click", onExportGo);
  els.pickBackdrop.addEventListener("click", (e) => {
    if (e.target === els.pickBackdrop) closeExportPicker();
  });

  // Live updates: new captures (from the pill/dock/hotkey/context menu) signal
  // via dumpSignal; bucket list changes keep the picker fresh.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.buckets) {
      refreshBuckets(els.bucket.value);
      refreshSheetBuckets(els.sheetBucket.value);
    }
    if (changes.dumpSignal) {
      onNewCaptures();
      if (panelKind === "sheet") renderSheetRows(); // e.g. right-click dumps
    }
  });

  // The icon click that opened this panel granted activeTab for the current
  // tab — arm the page helper there (this used to be the popup's job).
  chrome.storage.local.get("selectionHelper", (o) => {
    if (o.selectionHelper !== false) injectSelectionHelper();
  });

  setupImageDrop();
  setupCloudChip();
}

// ---- Cloud chip: live sync status; click opens the Cloud dialog ----
// Connect/Disconnect live in the workspace's Cloud modal — the chip deep-links
// there (#cloud auto-opens it) and mirrors state: hollow = not connected,
// green = synced, amber = syncing, red = sync error.
function setupCloudChip() {
  const apply = (conn, state) => {
    const connected = conn?.connected === true;
    els.cloudDot.dataset.state = !connected ? "" : state === "error" ? "error" : state === "syncing" ? "syncing" : "synced";
    els.cloudOpen.title = !connected
      ? "Cloud sync: not connected — click to set up"
      : state === "error"
        ? "Cloud sync error — click for details"
        : state === "syncing"
          ? "Syncing…"
          : "Cloud sync: connected (click to manage / disconnect)";
  };
  chrome.storage.local.get(["gconnection", "syncState"], (o) => apply(o.gconnection, o.syncState));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || (!ch.gconnection && !ch.syncState)) return;
    chrome.storage.local.get(["gconnection", "syncState"], (o) => apply(o.gconnection, o.syncState));
  });
  els.cloudOpen.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dumpster.html#cloud") });
  });
}

// ---- Drag an image into the panel → appended at the end of the active doc ----
// OS file drags carry real bytes and go through the normal screenshot flow.
// Page-image drags often carry only a URL: we fetch it when the site's CORS
// allows (the panel has no broad host permissions), else save the link.
function setupImageDrop() {
  let depth = 0; // dragenter/leave fire per child; count to know when we truly left

  const looksDroppable = (dt) =>
    !!dt && ([...(dt.items || [])].some((i) => i.kind === "file") || dt.types?.includes("text/uri-list"));

  document.addEventListener("dragenter", async (e) => {
    if (!looksDroppable(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    const docs = (await getBuckets()).filter((b) => b.kind === "doc");
    const name = docs.find((b) => b.id === activeBucket)?.name;
    els.dropLabel.textContent = name ? `Drop image to add to “${name}”` : "Create a Doc bucket first";
    els.dropOverlay.hidden = false;
  });
  document.addEventListener("dragover", (e) => {
    if (!looksDroppable(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) els.dropOverlay.hidden = true;
  });
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    els.dropOverlay.hidden = true;
    if (!activeBucket) return showToast("Create a Doc bucket first", true);
    try {
      await handleDrop(e.dataTransfer);
    } catch (err) {
      showToast(`Drop failed: ${err.message}`, true);
    }
  });
}

async function handleDrop(dt) {
  // 1) Real files (from the OS, or page drags that include bytes).
  const files = [...(dt?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    for (const f of files) await saveEntry({ content: "", blob: f });
    showToast(`Added ${files.length === 1 ? "image" : files.length + " images"} to the doc`);
    return;
  }

  // 2) URL-only drags (an <img> dragged off a page).
  const uri = (dt?.getData("text/uri-list") || dt?.getData("text/plain") || "").split("\n")[0].trim();
  if (!/^https?:\/\//i.test(uri)) return showToast("That didn't contain an image", true);
  try {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) throw new Error("not an image");
    await saveEntry({ content: "", blob });
    showToast("Added image to the doc");
  } catch {
    // Site blocked the fetch (CORS/hotlinking) — keep the reference instead.
    await saveEntry({ content: uri });
    showToast("Image blocked by the site — saved its link instead");
  }
}

async function injectSelectionHelper() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/selectionMenu.js"] });
  } catch {
    /* restricted page (chrome://, Web Store) or no grant — helper stays off */
  }
}

// ---- Active doc ----

async function refreshBuckets(selectId) {
  const docs = (await getBuckets()).filter((b) => b.kind === "doc");
  const last = await getLastBucketId();
  const chosen = selectId || (docs.some((b) => b.id === last) ? last : docs[0]?.id);
  els.bucket.innerHTML = "";
  for (const b of docs) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    els.bucket.appendChild(opt);
  }
  const none = !docs.length;
  els.editor.disabled = none;
  els.shareDoc.disabled = none;
  els.openDoc.disabled = none;
  els.capRegion.disabled = none;
  els.capOcr.disabled = none;
  els.capTs.disabled = none;
  if (chosen) {
    els.bucket.value = chosen;
    if (chosen !== activeBucket) await switchBucket(chosen);
  }
}

async function switchBucket(bucketId) {
  if (!bucketId) return;
  // Flush any pending edit of the previous doc before switching away.
  if (activeBucket && saveTimer) {
    clearTimeout(saveTimer);
    await setBody(activeBucket, els.editor.value);
  }
  activeBucket = bucketId;
  await setLastBucketId(bucketId); // captures elsewhere follow the active doc
  await seedIfEmpty(bucketId); // first open: build body from existing entries
  els.editor.value = await getBody(bucketId);
  els.saveState.textContent = "Saved";
  await renderPreview();
}

async function onNewBucket() {
  const sheet = panelKind === "sheet";
  const name = prompt(`Name your new ${sheet ? "Sheet" : "Doc"} bucket:`);
  if (!name || !name.trim()) return;
  const bucket = await addBucket(name.trim(), sheet ? "sheet" : "doc");
  if (sheet) {
    await refreshSheetBuckets(bucket.id);
    els.sheetInput.focus();
    return;
  }
  await refreshBuckets(bucket.id);
  setMode("write");
  els.editor.focus();
}

// ---- Sheet mode: a mini tracker for Sheet buckets ----
// Quick-add entries and flip statuses without leaving the page; the full
// table/board stays in the workspace (↗). Rows sync exactly like any dump.

function setKind(kind) {
  panelKind = kind === "sheet" ? "sheet" : "doc";
  const sheet = panelKind === "sheet";
  els.kindDoc.setAttribute("aria-selected", String(!sheet));
  els.kindSheet.setAttribute("aria-selected", String(sheet));
  els.bucket.hidden = sheet;
  els.fmtRow.hidden = sheet;
  els.docMain.hidden = sheet;
  els.docBar.hidden = sheet;
  els.sheetBucket.hidden = !sheet;
  els.sheetMain.hidden = !sheet;
  els.sheetBar.hidden = !sheet;
  chrome.storage.local.set({ panelKind });
  if (sheet) refreshSheetBuckets(activeSheet);
}

const statusTone = (s) => (s === "Done" ? "green" : s === "In Process" ? "amber" : "gray");

async function refreshSheetBuckets(selectId) {
  const sheets = (await getBuckets()).filter((b) => b.kind === "sheet");
  const stored = await new Promise((r) => chrome.storage.local.get("panelSheetBucket", (o) => r(o.panelSheetBucket)));
  const chosen =
    [selectId, activeSheet, stored].find((id) => sheets.some((b) => b.id === id)) || sheets[0]?.id;
  els.sheetBucket.innerHTML = "";
  for (const b of sheets) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    els.sheetBucket.appendChild(opt);
  }
  els.sheetInput.disabled = !sheets.length;
  els.sheetAdd.disabled = !sheets.length;
  if (chosen) {
    els.sheetBucket.value = chosen;
    await switchSheet(chosen);
  } else {
    els.sheetRows.innerHTML = "";
    els.sheetEmpty.hidden = false;
  }
}

async function switchSheet(bucketId) {
  if (!bucketId) return;
  activeSheet = bucketId;
  chrome.storage.local.set({ panelSheetBucket: bucketId });
  await renderSheetRows();
}

async function renderSheetRows() {
  if (!activeSheet) return;
  const rows = (await getEntriesByBucket(activeSheet)).slice(0, 30); // newest-first
  els.sheetRows.innerHTML = "";
  els.sheetEmpty.hidden = rows.length > 0;
  for (const e of rows) {
    const row = document.createElement("div");
    row.className = "sheet-row";

    const txt = document.createElement("span");
    txt.className = "txt";
    if (/^https?:\/\/\S+$/.test(e.content || "")) {
      const a = document.createElement("a");
      a.href = e.content;
      a.textContent = e.content;
      a.target = "_blank";
      a.rel = "noreferrer";
      txt.appendChild(a);
    } else {
      txt.textContent = e.content || "(empty)";
    }
    if (e.sourceTitle || e.sourceUrl) {
      const src = document.createElement("span");
      src.className = "src";
      src.textContent = e.sourceTitle || e.sourceUrl;
      txt.appendChild(src);
    }

    const pill = document.createElement("select");
    pill.className = "status-pill";
    for (const s of STATUSES) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      pill.appendChild(opt);
    }
    pill.value = e.status || STATUSES[0];
    pill.dataset.tone = statusTone(pill.value);
    pill.addEventListener("change", async () => {
      pill.dataset.tone = statusTone(pill.value);
      await updateEntry(e.id, { status: pill.value });
      await enqueueUpsert(e.id);
      await signalDump(); // live-refresh an open workspace tab
      track("feature", { name: "panel-status" });
    });

    row.append(txt, pill);
    els.sheetRows.appendChild(row);
  }
}

async function onSheetAdd() {
  const text = els.sheetInput.value.trim();
  if (!text || !activeSheet) {
    els.sheetInput.focus();
    return;
  }
  const tab = await getActiveTab();
  const entry = makeEntry({
    bucketId: activeSheet,
    content: text,
    sourceUrl: tab?.url || "",
    sourceTitle: tab?.title || "",
  });
  await addEntry(entry);
  await setLastBucketId(activeSheet);
  await enqueueUpsert(entry.id);
  await signalDump();
  els.sheetInput.value = "";
  els.sheetInput.focus();
  await renderSheetRows();
  track("feature", { name: "panel-sheet-add" });
}

// New entries landed (selection pill, dock, hotkey, context menu, or our own
// capture buttons): append them to the body and refresh what's on screen.
// Order matters when the user is mid-keystroke: flush their pending edit to
// storage FIRST, then ingest (which appends at the end), then reload the
// textarea — otherwise the next autosave would overwrite the captured entry.
async function onNewCaptures() {
  if (!activeBucket) return;
  const editing = document.activeElement === els.editor;
  if (editing) {
    clearTimeout(saveTimer);
    await setBody(activeBucket, els.editor.value);
    els.saveState.textContent = "Saved";
  }
  const changed = await ingestNewEntries(activeBucket);
  if (!changed) return;
  const body = await getBody(activeBucket);
  if (editing && body.startsWith(els.editor.value)) {
    // Mid-edit: append the delta through the undo-aware path so the user's
    // Cmd/Ctrl+Z history (and cursor) survive the capture landing.
    const at = els.editor.value.length;
    const caret = els.editor.selectionStart;
    replaceRange(at, at, body.slice(at), caret, caret);
  } else {
    els.editor.value = body; // not editing — a fresh undo history is fine
  }
  await renderPreview();
}

// ---- Write / Preview ----

function setMode(next) {
  mode = next;
  const writing = mode === "write";
  els.editor.hidden = !writing;
  els.preview.hidden = writing;
  els.modeWrite.setAttribute("aria-selected", String(writing));
  els.modePreview.setAttribute("aria-selected", String(!writing));
  if (writing) els.editor.focus();
  else renderPreview();
}

async function renderPreview() {
  // Rebuild object URLs for screenshots each render; revoke the old ones.
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  const prev = imageUrls;
  imageUrls = new Map();

  const md = document.activeElement === els.editor ? els.editor.value : await getBody(activeBucket);
  // Resolve image ids referenced in the markdown up front (renderer is sync).
  const ids = [...String(md).matchAll(/dumpster:img:([\w-]+)/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    try {
      const blob = await getImage(id);
      if (blob) imageUrls.set(id, URL.createObjectURL(blob));
    } catch {
      /* image gone — renderer falls back to alt text */
    }
  }
  prev.clear();
  els.preview.innerHTML = renderMarkdown(md, { imageUrl: (id) => imageUrls.get(id) });
  els.preview.classList.toggle("is-empty", !els.preview.innerHTML.trim());
}

// Live preview: debounce re-renders while typing in Write mode too, so
// flipping to Preview is always current (and Preview mode is instant).
let previewTimer = null;
els?.editor?.addEventListener?.("input", () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (mode === "preview") renderPreview();
  }, 300);
});

// ---- Toolbar editing helpers (textarea markdown) ----

// Route programmatic edits through execCommand("insertText") so the
// textarea's NATIVE undo stack survives — Cmd/Ctrl+Z then undoes toolbar
// formatting and appended captures just like typing. Assigning .value
// directly would wipe the history. Falls back to a plain splice where
// execCommand is unavailable (e.g. the test harness).
function replaceRange(start, end, text, selStart, selEnd) {
  els.editor.focus();
  els.editor.setSelectionRange(start, end);
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (!inserted) {
    const v = els.editor.value;
    els.editor.value = v.slice(0, start) + text + v.slice(end);
    els.editor.dispatchEvent(new Event("input", { bubbles: true })); // execCommand fires this itself
  }
  els.editor.setSelectionRange(selStart, selEnd);
}

function wrapSelection(marker) {
  setMode("write");
  const { selectionStart: s, selectionEnd: e, value: v } = els.editor;
  const sel = v.slice(s, e) || "text";
  const wrapped = `${marker}${sel}${marker}`;
  replaceRange(s, e, wrapped, s + marker.length, s + marker.length + sel.length);
}

function lineBounds() {
  const { selectionStart: s, selectionEnd: e, value: v } = els.editor;
  const start = v.lastIndexOf("\n", s - 1) + 1;
  let end = v.indexOf("\n", e);
  if (end === -1) end = v.length;
  return { start, end };
}

function applyBlockFormat(kind) {
  setMode("write");
  const { start, end } = lineBounds();
  const line = els.editor.value.slice(start, end).replace(/^#{1,3}\s+/, "");
  const next = kind === "h1" ? `# ${line}` : kind === "h2" ? `## ${line}` : line;
  replaceRange(start, end, next, start + next.length, start + next.length);
}

function prefixLines(prefix) {
  setMode("write");
  const { start, end } = lineBounds();
  const block = els.editor.value.slice(start, end);
  const next = block
    .split("\n")
    .map((l, i) => (prefix === "1. " ? `${i + 1}. ${l.replace(/^(\d+[.)]|[-*])\s+/, "")}` : `${prefix}${l.replace(/^(\d+[.)]|[-*])\s+/, "")}`))
    .join("\n");
  replaceRange(start, end, next, start, start + next.length);
}

// ---- Captures (unchanged entry flow) ----

function getActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null))
  );
}

async function saveEntry({ content, blob, format, sourceUrl, sourceTitle, feature }) {
  const bucketId = activeBucket;
  const tab = await getActiveTab();
  const entry = makeEntry({
    bucketId,
    content,
    sourceUrl: sourceUrl ?? (tab?.url || ""),
    sourceTitle: sourceTitle ?? (tab?.title || ""),
  });
  if (format) entry.format = format;
  if (blob) {
    entry.hasImage = true;
    await putImage(entry.id, blob);
  }
  await addEntry(entry);
  await setLastBucketId(bucketId);
  await signalDump(); // also triggers our own onNewCaptures → body + preview
  await enqueueUpsert(entry.id);
  track("feature", { name: feature || (blob ? "panel-screenshot" : "panel-note") });
  return entry;
}

// ---- Toolbar captures: region screenshot / OCR grab ----
// A click inside the panel is NOT one of the gestures that grants activeTab
// for the page (icon click / menu / hotkey are), and captureVisibleTab
// rejects per-origin grants outright — it demands "<all_urls>" or a live
// activeTab. So the first capture asks Chrome's one-time "allow on all
// websites" prompt; after approval, panel capture works everywhere. The crop
// lands at the end of the doc, exactly like a text selection from the pill.

const ALL_URLS = { origins: ["<all_urls>"] };
// Chrome hard-blocks scripting these even with <all_urls> granted.
const UNSCRIPTABLE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

async function ensureCaptureAccess(tab) {
  const url = tab?.url || "";
  if (!/^https?:\/\//i.test(url) || UNSCRIPTABLE.test(url)) return "unsupported";
  try {
    if (await chrome.permissions.contains(ALL_URLS)) return "ok";
    // Ask immediately, while the button click's activation is still fresh —
    // a single prompt, ever; the grant persists.
    return (await chrome.permissions.request(ALL_URLS)) ? "ok" : "declined";
  } catch {
    return "declined"; // request needs a gesture — fall through to activeTab
  }
}

async function onRegionCapture(kind) {
  const tab = await getActiveTab();
  const access = await ensureCaptureAccess(tab);
  if (access === "unsupported") return showToast("This page can't be captured", true);
  let stage = "select"; // which step failed, for a precise error message
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: regionSelectOverlay,
    });
    const rect = res?.result;
    if (!rect) return; // cancelled (Esc / tiny drag)
    await new Promise((r) => setTimeout(r, 80)); // let the overlay's removal paint
    stage = "capture";
    const blob = await captureVisible(tab?.windowId);
    stage = "crop";
    const crop = await cropBlob(blob, rect, rect.dpr || 1);
    stage = "save";

    if (kind === "ocr") {
      const { connected } = await getConnection();
      if (!connected) return showToast("Connect Google for OCR", true);
      els.capOcr.disabled = true;
      try {
        const text = ((await createDocsProvider({ getToken }).ocrImage(crop).catch(() => "")) || "").trim();
        if (!text) return showToast("No text found in that region", true);
        await saveEntry({ content: text, format: "p" });
        showToast("Text added to the doc");
      } finally {
        els.capOcr.disabled = false;
      }
      return;
    }
    await saveEntry({ content: "", blob: crop }); // image only, no caption
    showToast("Screenshot added");
  } catch (err) {
    console.warn(`[dumpster] panel capture failed at "${stage}":`, err);
    const detail = String(err?.message || err).slice(0, 110);
    showToast(
      access === "declined"
        ? "Capture needs site access — approve the one-time prompt, or press Alt+Shift+S"
        : `Capture failed (${stage}): ${detail}`,
      true
    );
  }
}

// ---- Toolbar capture: YouTube transcript (last 30s / 60s / full) ----
// Injects ytGrabTranscript into the active tab (needs the same one-time
// all-sites grant as region capture — scripting only, no pixels). The result
// is saved like the dock's version: [m:ss] bullet lines with a source URL
// that deep-links to watch?v=…&t=<sec>s.
async function onTranscriptCapture(windowSec) {
  const tab = await getActiveTab();
  if (!/^https:\/\/([\w-]+\.)?youtube\.com\//i.test(tab?.url || "")) {
    return showToast("Open a YouTube video first", true);
  }
  const access = await ensureCaptureAccess(tab);
  if (access === "unsupported") return showToast("This page can't be captured", true);
  els.capTs.disabled = true;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: ytGrabTranscript,
      args: [windowSec],
    });
    const r = res?.result;
    if (!r?.ok) return showToast(r?.error || "No transcript on this video", true);
    await saveEntry({
      content: r.text,
      format: "list",
      sourceUrl: r.sourceUrl,
      sourceTitle: r.sourceTitle,
      feature: "panel-yt-transcript",
    });
    showToast("Transcript added to the doc");
  } catch (err) {
    showToast(
      access === "declined"
        ? "Transcript needs site access — approve the one-time prompt"
        : `Transcript failed: ${String(err?.message || err).slice(0, 90)}`,
      true
    );
  } finally {
    els.capTs.disabled = false;
  }
}

// ---- Voice input (dictation) ----
// Chrome's built-in Web Speech API — free, no keys, ~100 languages. The side
// panel can't show the mic permission prompt itself, so the first use routes
// through micgrant.html in a tab (one grant, persists for the extension).
// Finals land at the editor's caret when it has focus (undo-friendly via
// replaceRange); otherwise they're appended at the end of the doc.

const VOICE_LANGS = [
  { code: "en-US", label: "English (US)" },
  { code: "en-IN", label: "English (India)" },
  { code: "hi-IN", label: "हिन्दी — Hindi" },
  { code: "bn-IN", label: "বাংলা — Bengali" },
  { code: "ta-IN", label: "தமிழ் — Tamil" },
  { code: "te-IN", label: "తెలుగు — Telugu" },
  { code: "mr-IN", label: "मराठी — Marathi" },
  { code: "gu-IN", label: "ગુજરાતી — Gujarati" },
  { code: "kn-IN", label: "ಕನ್ನಡ — Kannada" },
  { code: "ml-IN", label: "മലയാളം — Malayalam" },
  { code: "pa-IN", label: "ਪੰਜਾਬੀ — Punjabi" },
  { code: "ur-IN", label: "اردو — Urdu" },
  { code: "ne-NP", label: "नेपाली — Nepali" },
  { code: "es-ES", label: "Español — Spanish" },
  { code: "fr-FR", label: "Français — French" },
  { code: "de-DE", label: "Deutsch — German" },
  { code: "it-IT", label: "Italiano — Italian" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "ru-RU", label: "Русский — Russian" },
  { code: "ja-JP", label: "日本語 — Japanese" },
  { code: "ko-KR", label: "한국어 — Korean" },
  { code: "zh-CN", label: "中文（简体）— Chinese" },
  { code: "ar-SA", label: "العربية — Arabic" },
  { code: "id-ID", label: "Bahasa Indonesia" },
  { code: "tr-TR", label: "Türkçe — Turkish" },
  { code: "vi-VN", label: "Tiếng Việt — Vietnamese" },
  { code: "th-TH", label: "ไทย — Thai" },
];

let voiceLang = "en-US";
let dictAppended = false; // first append of a session opens a new paragraph

const voice = createVoiceInput({
  getLang: () => voiceLang,
  onFinal: insertDictation,
  onInterim: (t) => {
    els.voiceLive.textContent = t;
    els.voiceLive.hidden = !t;
  },
  onState: (on) => {
    els.voiceBtn.classList.toggle("rec", on);
    if (!on) dictAppended = false;
  },
  onError: (msg, code) => {
    els.voiceBtn.classList.remove("rec");
    if (code === "not-allowed" || code === "service-not-allowed") return openMicGrant();
    showToast(msg, true);
  },
});

function voiceLangDefault() {
  const ui = (chrome.i18n?.getUILanguage?.() || "en").toLowerCase();
  const hit =
    VOICE_LANGS.find((l) => l.code.toLowerCase() === ui) ||
    VOICE_LANGS.find((l) => l.code.slice(0, 2) === ui.slice(0, 2));
  return hit?.code || "en-US";
}

function setupVoice() {
  chrome.storage.local.get(["voiceLang"], (o) => {
    voiceLang = o.voiceLang || voiceLangDefault();
    renderVoiceMenu();
  });
  // Keep the editor's focus/caret — the whole point of the cursor-insert path.
  for (const el of [els.voiceBtn, els.voiceLang, els.voiceMenu]) {
    el.addEventListener("mousedown", (e) => e.preventDefault());
  }
  els.voiceBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onVoiceToggle();
  });
  els.voiceLang.addEventListener("click", (e) => {
    e.stopPropagation();
    els.exportMenu.hidden = true;
    els.capTsMenu.hidden = true;
    els.voiceMenu.hidden = !els.voiceMenu.hidden;
  });
  els.voiceMenu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-lang]");
    if (!b) return;
    e.stopPropagation();
    voiceLang = b.dataset.lang;
    chrome.storage.local.set({ voiceLang });
    els.voiceMenu.hidden = true;
    renderVoiceMenu();
  });
}

function renderVoiceMenu() {
  const cur = VOICE_LANGS.find((l) => l.code === voiceLang);
  els.voiceLang.textContent = voiceLang.slice(0, 2).toUpperCase() + " ▾";
  els.voiceLang.title = `Dictation language — ${cur ? cur.label : voiceLang}`;
  els.voiceMenu.innerHTML = "";
  for (const l of VOICE_LANGS) {
    const b = document.createElement("button");
    b.dataset.lang = l.code;
    b.textContent = l.label;
    if (l.code === voiceLang) b.classList.add("sel");
    els.voiceMenu.appendChild(b);
  }
}

async function onVoiceToggle() {
  if (!voiceSupported()) return showToast("Dictation isn't supported in this browser", true);
  if (voice.active) return voice.stop();
  let state = "prompt";
  try {
    state = (await navigator.permissions.query({ name: "microphone" })).state;
  } catch {}
  if (state !== "granted") return openMicGrant();
  track("feature", { name: "panel-voice" });
  voice.start();
}

function openMicGrant() {
  voice.stop();
  chrome.tabs.create({ url: chrome.runtime.getURL("micgrant.html") });
  showToast("Allow the microphone once in the new tab, then click the mic again");
}

function insertDictation(text) {
  const chunk = text.trim();
  if (!chunk || !activeBucket) return;
  const v = els.editor.value;
  if (mode === "write" && document.activeElement === els.editor) {
    const s = els.editor.selectionStart;
    const e = els.editor.selectionEnd;
    const glueBefore = s && !/\s$/.test(v.slice(0, s)) ? " " : "";
    const glueAfter = v.slice(e) && !/^\s/.test(v.slice(e)) ? " " : "";
    const ins = glueBefore + chunk + glueAfter;
    replaceRange(s, e, ins, s + ins.length, s + ins.length);
  } else {
    // Editor not focused (or Preview mode) → append at the end of the doc,
    // opening a fresh paragraph for the session's first phrase. replaceRange
    // falls back to a value write + input event when the hidden editor can't
    // take execCommand, so autosave and the live preview still kick in.
    const glue = !v ? "" : dictAppended ? " " : /\n$/.test(v) ? "" : "\n\n";
    const ins = glue + chunk;
    replaceRange(v.length, v.length, ins, v.length + ins.length, v.length + ins.length);
    dictAppended = true;
  }
}

// ---- Export: PDF / Markdown (doc) and Excel (tracker) ----
// Screenshots live permanently in IndexedDB, so exports embed them straight
// from local storage — no cloud round-trip, works offline and unsynced.

function download(filename, mime, data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const safeName = (s) => (s || "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "dumpster";

async function bucketName(id) {
  return (await getBuckets()).find((b) => b.id === id)?.name || "Dumpster";
}

async function onExportPdf() {
  els.exportMenu.hidden = true;
  if (!activeBucket) return;
  // A dedicated print-styled page; Chrome's print dialog offers "Save as PDF".
  chrome.tabs.create({
    url: chrome.runtime.getURL(`export.html?bucket=${encodeURIComponent(activeBucket)}`),
  });
  track("feature", { name: "export-pdf" });
}

const blobToDataUri = (blob) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

async function onExportMd() {
  els.exportMenu.hidden = true;
  if (!activeBucket) return;
  let md = await getBody(activeBucket);
  // Inline each local screenshot as a data URI so the .md is self-contained.
  const ids = [...md.matchAll(/dumpster:img:([\w-]+)/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    const blob = await getImage(id);
    const uri = blob instanceof Blob ? await blobToDataUri(blob) : "";
    md = md.split(`dumpster:img:${id}`).join(uri);
  }
  download(`${safeName(await bucketName(activeBucket))}.md`, "text/markdown", md);
  track("feature", { name: "export-md" });
  showToast("Markdown exported");
}

// DOCX comes from the synced Google Doc via Drive's export (real .docx, images
// included) — the one export that needs Google connected; PDF/MD stay local.
async function onExportDocx() {
  els.exportMenu.hidden = true;
  if (!activeBucket) return;
  const { connected } = await getConnection();
  if (!connected) return showToast("Connect Google to export DOCX (PDF/MD work offline)", true);
  const map = await new Promise((r) => chrome.storage.local.get("docsDocMap", (o) => r(o.docsDocMap || {})));
  const docId = map[activeBucket]?.docId;
  if (!docId) return showToast("This doc hasn't synced to Google yet — try again after sync", true);
  try {
    const token = await getToken(false);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`export ${res.status}`);
    const blob = await res.blob();
    download(`${safeName(await bucketName(activeBucket))}.docx`, blob.type, blob);
    track("feature", { name: "export-docx" });
    showToast("Word doc exported");
  } catch (err) {
    showToast(`DOCX export failed: ${err.message}`, true);
  }
}

// ---- Sheet bar: Share / Open / Export (mirrors the doc bar) ----

// All sheet buckets live as tabs in the one synced spreadsheet; deep-link to
// this bucket's exact tab (#gid), like the workspace's "Open sheet ↗".
function syncedSheetUrl() {
  return new Promise((resolve) =>
    chrome.storage.local.get(["sheetsSpreadsheetId", "sheetsTabMap"], (o) => {
      const sid = o.sheetsSpreadsheetId;
      const tab = o.sheetsTabMap?.[activeSheet];
      if (!sid || !tab) return resolve(null);
      resolve(`https://docs.google.com/spreadsheets/d/${sid}/edit#gid=${tab.sheetId}`);
    })
  );
}

async function onShareSheet() {
  const url = await syncedSheetUrl();
  if (!url) return showToast("No cloud sheet yet — connect Google to share", true);
  try {
    await navigator.clipboard.writeText(url);
    showToast("Sheet link copied");
  } catch {
    showToast(url);
  }
}

async function onOpenSheet() {
  const url = await syncedSheetUrl();
  if (url) chrome.tabs.create({ url });
  else chrome.runtime.openOptionsPage(); // not synced — open the local table
}

// ---- Tracker export with a bucket picker (mirrors the workspace modal) ----
// Choosing a format opens a picker: the current tracker is listed first and
// pre-checked; select more, or "All trackers". Multi-select exports one file —
// Excel gets a worksheet per bucket, JSON one key per bucket.

const EXPORT_COLS = ["createdAt", "content", "sourceUrl", "sourceTitle", "status", "notes"];
let pickFormat = "xlsx"; // format chosen from the menu; used by the Export button

function onExportXlsx() {
  els.sheetExportMenu.hidden = true;
  openExportPicker("xlsx");
}
function onExportJson() {
  els.sheetExportMenu.hidden = true;
  openExportPicker("json");
}

async function openExportPicker(format) {
  if (!activeSheet) return;
  pickFormat = format;
  const sheets = (await getBuckets()).filter((b) => b.kind === "sheet");
  // Current tracker first, like the workspace's export dialog.
  sheets.sort((a, z) => (a.id === activeSheet ? -1 : z.id === activeSheet ? 1 : 0));
  els.pickList.innerHTML = "";
  for (const b of sheets) {
    const item = document.createElement("label");
    item.className = "pick-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = b.id;
    cb.checked = b.id === activeSheet; // default: just the current tracker
    cb.addEventListener("change", syncPickAll);
    const name = document.createElement("span");
    name.textContent = b.name;
    item.append(cb, name);
    if (b.id === activeSheet) {
      const tag = document.createElement("span");
      tag.className = "current";
      tag.textContent = "current";
      item.appendChild(tag);
    }
    els.pickList.appendChild(item);
  }
  els.pickAll.checked = sheets.length === 1;
  syncPickAll();
  els.pickBackdrop.hidden = false;
}

const pickBoxes = () => [...els.pickList.querySelectorAll("input[type=checkbox]")];

function syncPickAll() {
  const boxes = pickBoxes();
  els.pickAll.checked = boxes.length > 0 && boxes.every((b) => b.checked);
  els.pickGo.disabled = !boxes.some((b) => b.checked);
}

function closeExportPicker() {
  els.pickBackdrop.hidden = true;
}

// Gather rows for one bucket, oldest-first, in the workspace's export shape.
async function exportRows(bucketId) {
  return (await getEntriesByBucket(bucketId))
    .slice()
    .sort((a, z) => (a.createdAt < z.createdAt ? -1 : 1))
    .map((e) => Object.fromEntries(EXPORT_COLS.map((c) => [c, e[c] ?? ""])));
}

// Excel tab names: ≤31 chars, no illegal chars, deduped — as in the workspace.
function uniqueSheetName(name, used) {
  let base = (name || "Sheet").replace(/[\[\]*?/\\:]/g, "-").slice(0, 31) || "Sheet";
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 28)} ${n++}`;
  used.add(candidate);
  return candidate;
}

async function onExportGo() {
  const ids = pickBoxes().filter((b) => b.checked).map((b) => b.value);
  if (!ids.length) return;
  const buckets = (await getBuckets()).filter((b) => ids.includes(b.id));
  const data = [];
  for (const b of buckets) data.push({ name: b.name, rows: await exportRows(b.id) });
  const stem = data.length === 1 ? safeName(data[0].name) : "dumpster-trackers";

  if (pickFormat === "json") {
    const obj = {};
    for (const d of data) obj[d.name] = d.rows;
    download(`${stem}.json`, "application/json", JSON.stringify(obj, null, 2));
    track("feature", { name: "export-json" });
  } else {
    const XLSX = globalThis.__xlsxOverride || (await import("./vendor/xlsx.mjs"));
    const wb = XLSX.utils.book_new();
    const used = new Set();
    for (const d of data) {
      const ws = d.rows.length
        ? XLSX.utils.json_to_sheet(d.rows, { header: EXPORT_COLS })
        : XLSX.utils.aoa_to_sheet([EXPORT_COLS]);
      XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(d.name, used));
    }
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    download(`${stem}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf);
    track("feature", { name: "export-xlsx" });
  }
  closeExportPicker();
  showToast(`Exported ${data.length === 1 ? data[0].name : data.length + " trackers"}`);
}

// ---- Share / Open Doc (bottom bar) ----
// Both act on the active bucket's synced Google Doc (docsDocMap). Screenshots
// moved out of the bottom bar — the page dock, right-click menu, and
// Alt+Shift+S still cover capture.

function syncedDocUrl() {
  return new Promise((resolve) =>
    chrome.storage.local.get("docsDocMap", (o) => {
      const docId = o.docsDocMap?.[activeBucket]?.docId;
      resolve(docId ? `https://docs.google.com/document/d/${docId}/edit` : null);
    })
  );
}

async function onShareDoc() {
  const url = await syncedDocUrl();
  if (!url) return showToast("No cloud doc yet — connect Google to share", true);
  try {
    await navigator.clipboard.writeText(url);
    showToast("Doc link copied");
  } catch {
    showToast(url); // clipboard blocked — at least surface the link
  }
}

async function onOpenDoc() {
  const url = await syncedDocUrl();
  if (url) chrome.tabs.create({ url });
  else chrome.runtime.openOptionsPage(); // not synced — open the local doc view
}

let toastTimer = null;
function showToast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("toast-error", isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3200);
}

init().then(() => setMode("preview"));
