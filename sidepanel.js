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
// Note on captures: activeTab is granted per-tab by extension gestures (action
// click, menu, hotkey). The panel's capture buttons work while that grant is
// live for the current tab; when Chrome refuses, we point at Alt+Shift+S.

import { getBuckets, ensureSeeded, addBucket, getLastBucketId, setLastBucketId, signalDump } from "./src/buckets.js";
import { addEntry, makeEntry, putImage, getImage } from "./src/db.js";
import { enqueueUpsert } from "./src/outbox.js";
import { captureVisible, cropBlob } from "./src/capture.js";
import { regionSelectOverlay } from "./src/regionSelect.js";
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
  shotVisible: document.getElementById("shot-visible"),
  shotRegion: document.getElementById("shot-region"),
  saveState: document.getElementById("save-state"),
  toast: document.getElementById("toast"),
};

let activeBucket = null; // id of the doc this panel edits
let mode = "preview"; // "write" | "preview" — preview is the live view
let saveTimer = null;
let imageUrls = new Map(); // entryId → object URL (revoked on re-render)

async function init() {
  await ensureSeeded();
  pingActive();
  flush();
  await refreshBuckets();

  els.newBucket.addEventListener("click", onNewBucket);
  els.bucket.addEventListener("change", () => switchBucket(els.bucket.value));
  els.openViewer.addEventListener("click", () => chrome.runtime.openOptionsPage());

  els.modeWrite.addEventListener("click", () => setMode("write"));
  els.modePreview.addEventListener("click", () => setMode("preview"));

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

  els.shotVisible.addEventListener("click", () => onShot(false));
  els.shotRegion.addEventListener("click", () => onShot(true));

  // Live updates: new captures (from the pill/dock/hotkey/context menu) signal
  // via dumpSignal; bucket list changes keep the picker fresh.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.buckets) refreshBuckets(els.bucket.value);
    if (changes.dumpSignal) onNewCaptures();
  });

  // The icon click that opened this panel granted activeTab for the current
  // tab — arm the page helper there (this used to be the popup's job).
  chrome.storage.local.get("selectionHelper", (o) => {
    if (o.selectionHelper !== false) injectSelectionHelper();
  });
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
  els.shotVisible.disabled = none;
  els.shotRegion.disabled = none;
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
  const name = prompt("Name your new Doc bucket:");
  if (!name || !name.trim()) return;
  const bucket = await addBucket(name.trim(), "doc");
  await refreshBuckets(bucket.id);
  setMode("write");
  els.editor.focus();
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
  const caret = editing ? els.editor.selectionStart : null;
  els.editor.value = body;
  if (caret != null) els.editor.setSelectionRange(caret, caret); // appends land below the cursor
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

function replaceRange(start, end, text, selStart, selEnd) {
  const v = els.editor.value;
  els.editor.value = v.slice(0, start) + text + v.slice(end);
  els.editor.setSelectionRange(selStart, selEnd);
  els.editor.focus();
  els.editor.dispatchEvent(new Event("input", { bubbles: true }));
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

async function saveEntry({ content, blob }) {
  const bucketId = activeBucket;
  const tab = await getActiveTab();
  const entry = makeEntry({
    bucketId,
    content,
    sourceUrl: tab?.url || "",
    sourceTitle: tab?.title || "",
  });
  if (blob) {
    entry.hasImage = true;
    await putImage(entry.id, blob);
  }
  await addEntry(entry);
  await setLastBucketId(bucketId);
  await signalDump(); // also triggers our own onNewCaptures → body + preview
  await enqueueUpsert(entry.id);
  track("feature", { name: blob ? "panel-screenshot" : "panel-note" });
  return entry;
}

async function onShot(region) {
  const tab = await getActiveTab();
  try {
    let rect = null;
    if (region) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: regionSelectOverlay,
      });
      rect = res?.result;
      if (!rect) return; // cancelled
      await new Promise((r) => setTimeout(r, 80));
    }
    const blob = await captureVisible(tab?.windowId);
    const final = rect ? await cropBlob(blob, rect, rect.dpr || 1) : blob;
    await saveEntry({ content: "", blob: final }); // image only, no caption
  } catch (err) {
    // Most likely: no live activeTab grant for this tab.
    showToast("Chrome needs a gesture — press Alt+Shift+S instead", true);
  }
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
