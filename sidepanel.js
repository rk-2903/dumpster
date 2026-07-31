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
import { addEntry, makeEntry, putImage, getImage } from "./src/db.js";
import { enqueueUpsert } from "./src/outbox.js";
import { captureVisible, cropBlob } from "./src/capture.js";
import { regionSelectOverlay } from "./src/regionSelect.js";
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
  shareDoc: document.getElementById("share-doc"),
  openDoc: document.getElementById("open-doc"),
  saveState: document.getElementById("save-state"),
  dropOverlay: document.getElementById("drop-overlay"),
  dropLabel: document.getElementById("drop-label"),
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

  els.capRegion.addEventListener("click", () => onRegionCapture("shot"));
  els.capOcr.addEventListener("click", () => onRegionCapture("ocr"));
  els.shareDoc.addEventListener("click", onShareDoc);
  els.openDoc.addEventListener("click", onOpenDoc);

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

  setupImageDrop();
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
    showToast(`Added ${files.length === 1 ? "image" : files.length + " images"} to the doc ✓`);
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
    showToast("Added image to the doc ✓");
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

async function saveEntry({ content, blob, format }) {
  const bucketId = activeBucket;
  const tab = await getActiveTab();
  const entry = makeEntry({
    bucketId,
    content,
    sourceUrl: tab?.url || "",
    sourceTitle: tab?.title || "",
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
  track("feature", { name: blob ? "panel-screenshot" : "panel-note" });
  return entry;
}

// ---- Toolbar captures: region screenshot / OCR grab ----
// A click inside the panel is NOT one of the gestures that grants activeTab
// for the page (icon click / menu / hotkey are), so the panel asks for
// per-site access the first time you capture on a site — Chrome shows an
// "Allow?" prompt once, then it works there permanently. The crop lands at
// the end of the doc, exactly like a text selection from the pill.

async function ensureSiteAccess(tab) {
  const url = tab?.url || "";
  if (!/^https?:\/\//i.test(url)) return "unsupported"; // chrome://, store, etc.
  const pattern = `${new URL(url).origin}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return "ok";
    // Ask immediately, while the button click's activation is still fresh.
    return (await chrome.permissions.request({ origins: [pattern] })) ? "ok" : "declined";
  } catch {
    return "declined"; // request needs a gesture — fall through to activeTab
  }
}

async function onRegionCapture(kind) {
  const tab = await getActiveTab();
  const access = await ensureSiteAccess(tab);
  if (access === "unsupported") return showToast("This page can't be captured", true);
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: regionSelectOverlay,
    });
    const rect = res?.result;
    if (!rect) return; // cancelled (Esc / tiny drag)
    await new Promise((r) => setTimeout(r, 80)); // let the overlay's removal paint
    const blob = await captureVisible(tab?.windowId);
    const crop = await cropBlob(blob, rect, rect.dpr || 1);

    if (kind === "ocr") {
      const { connected } = await getConnection();
      if (!connected) return showToast("Connect Google for OCR", true);
      els.capOcr.disabled = true;
      try {
        const text = ((await createDocsProvider({ getToken }).ocrImage(crop).catch(() => "")) || "").trim();
        if (!text) return showToast("No text found in that region", true);
        await saveEntry({ content: text, format: "p" });
        showToast("Text added to the doc ✓");
      } finally {
        els.capOcr.disabled = false;
      }
      return;
    }
    await saveEntry({ content: "", blob: crop }); // image only, no caption
    showToast("Screenshot added ✓");
  } catch {
    // No per-site grant and no live activeTab for this tab.
    showToast(
      access === "declined"
        ? "Capture needs access to this site — approve the prompt, or press Alt+Shift+S"
        : "Couldn't capture this page — press Alt+Shift+S or use the page dock",
      true
    );
  }
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
    showToast("Doc link copied ✓");
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
