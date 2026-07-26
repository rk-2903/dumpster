// Study side panel: a persistent notebook pinned beside the page. Pick a Doc
// bucket, type notes, snap screenshots — everything flows through the same
// entry + blob + outbox path as the popup.
//
// Note on captures: activeTab is granted per-tab by extension gestures (action
// click, menu, hotkey). The panel's own capture buttons work while that grant
// is live for the current tab; when Chrome refuses, we point at Alt+Shift+S,
// which re-grants on every press.

import {
  getBuckets,
  ensureSeeded,
  addBucket,
  getLastBucketId,
  setLastBucketId,
  signalDump,
} from "./src/buckets.js";
import { addEntry, makeEntry, putImage } from "./src/db.js";
import { enqueueUpsert } from "./src/outbox.js";
import { captureVisible, cropBlob } from "./src/capture.js";
import { regionSelectOverlay } from "./src/regionSelect.js";
import { track, pingActive, flush } from "./src/telemetry.js";

const els = {
  bucket: document.getElementById("bucket"),
  newBucket: document.getElementById("new-bucket"),
  note: document.getElementById("note"),
  addNote: document.getElementById("add-note"),
  shotVisible: document.getElementById("shot-visible"),
  shotRegion: document.getElementById("shot-region"),
  session: document.getElementById("session"),
  sessionEmpty: document.getElementById("session-empty"),
  openViewer: document.getElementById("open-viewer"),
  toast: document.getElementById("toast"),
};

async function init() {
  await ensureSeeded();
  pingActive(); // opening the study panel counts as active-today
  flush();
  await refreshBuckets();

  els.newBucket.addEventListener("click", onNewBucket);
  els.bucket.addEventListener("change", () => setLastBucketId(els.bucket.value));
  els.addNote.addEventListener("click", onAddNote);
  els.note.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onAddNote();
    }
  });
  els.shotVisible.addEventListener("click", () => onShot(false));
  els.shotRegion.addEventListener("click", () => onShot(true));
  els.openViewer.addEventListener("click", () => chrome.runtime.openOptionsPage());

  // Keep the bucket list fresh (e.g. a bucket added via right-click).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.buckets) refreshBuckets(els.bucket.value);
  });
}

function getActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null))
  );
}

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
  if (chosen) els.bucket.value = chosen;
  const none = !docs.length;
  els.addNote.disabled = none;
  els.shotVisible.disabled = none;
  els.shotRegion.disabled = none;
}

async function onNewBucket() {
  const name = prompt("Name your new Doc bucket:");
  if (!name || !name.trim()) return;
  const bucket = await addBucket(name.trim(), "doc");
  await setLastBucketId(bucket.id);
  await refreshBuckets(bucket.id);
  els.note.focus();
}

async function saveEntry({ content, blob }) {
  const bucketId = els.bucket.value;
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
  await signalDump();
  await enqueueUpsert(entry.id);
  addSessionItem(entry, blob);
  track("feature", { name: blob ? "panel-screenshot" : "panel-note" });
  return entry;
}

async function onAddNote() {
  const text = els.note.value.trim();
  if (!text) {
    els.note.focus();
    return;
  }
  await saveEntry({ content: text });
  els.note.value = "";
  els.note.focus();
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

function addSessionItem(entry, blob) {
  els.sessionEmpty.hidden = true;
  const item = document.createElement("div");
  item.className = "session-item";
  if (blob) {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(blob);
    img.alt = "Screenshot";
    item.appendChild(img);
  }
  const txt = document.createElement("span");
  txt.className = "txt";
  txt.textContent = entry.content;
  txt.title = entry.content;
  item.appendChild(txt);
  els.session.insertBefore(item, els.session.firstChild.nextSibling);
}

let toastTimer = null;
function showToast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("toast-error", isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3200);
}

init();
