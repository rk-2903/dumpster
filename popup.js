import {
  getBuckets,
  ensureSeeded,
  addBucket,
  getLastBucketId,
  setLastBucketId,
  signalDump,
} from "./src/buckets.js";
import { addEntries, makeEntry, putImage } from "./src/db.js";
import { enqueueUpsertMany } from "./src/outbox.js";
import { captureVisible } from "./src/capture.js";

const els = {
  bucket: document.getElementById("bucket"),
  newBucket: document.getElementById("new-bucket"),
  content: document.getElementById("content"),
  attach: document.getElementById("attach-page"),
  attachLabel: document.getElementById("attach-label"),
  shot: document.getElementById("shot"),
  staged: document.getElementById("staged"),
  addMore: document.getElementById("add-more"),
  submit: document.getElementById("submit"),
  openViewer: document.getElementById("open-viewer"),
  selectionHelper: document.getElementById("selection-helper"),
  toast: document.getElementById("toast"),
};

// Items waiting to be dumped as separate rows:
// { kind: "text", text } | { kind: "image", blob, thumbUrl }
let staged = [];
let currentTab = null;
let buckets = [];

async function init() {
  await ensureSeeded();
  await refreshBuckets();

  currentTab = await getActiveTab();
  if (currentTab?.title || currentTab?.url) {
    els.attachLabel.textContent = `Attach: ${currentTab.title || currentTab.url}`;
    els.attachLabel.title = currentTab.url || "";
  } else {
    els.attach.checked = false;
    els.attach.parentElement.hidden = true;
  }

  els.newBucket.addEventListener("click", onNewBucket);
  els.bucket.addEventListener("change", () => {
    setLastBucketId(els.bucket.value);
    updateShotState();
  });
  els.shot.addEventListener("click", onScreenshot);
  els.addMore.addEventListener("click", onAddMore);
  els.submit.addEventListener("click", onSubmit);
  els.openViewer.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.content.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  });
  els.content.addEventListener("input", updateSubmitState);
  updateSubmitState();
  updateShotState();

  // Selection helper: injected on demand into THIS tab (activeTab), so it never
  // runs on tabs in the background and needs no page reload. Opening the popup
  // (this code) activates it for the current tab when enabled.
  chrome.storage.local.get("selectionHelper", (o) => {
    const on = o.selectionHelper !== false;
    els.selectionHelper.checked = on;
    if (on) injectSelectionHelper();
  });
  els.selectionHelper.addEventListener("change", () => {
    const on = els.selectionHelper.checked;
    chrome.storage.local.set({ selectionHelper: on });
    if (on) injectSelectionHelper(); // activate immediately on this tab
    // Turning off: the already-injected script self-disables via the storage
    // change; no re-injection until re-enabled.
  });
}

async function injectSelectionHelper() {
  const tab = currentTab || (await getActiveTab());
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/selectionMenu.js"] });
  } catch {
    /* restricted page (chrome://, Web Store, etc.) — can't inject there */
  }
}

function getActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null))
  );
}

function selectedBucket() {
  return buckets.find((b) => b.id === els.bucket.value);
}

// Screenshots are a Doc-bucket feature (sheets have no place to show them).
function updateShotState() {
  const isDoc = selectedBucket()?.kind === "doc";
  els.shot.disabled = !isDoc;
  els.shot.title = isDoc
    ? "Screenshot the visible page into this Doc bucket"
    : "Screenshots go to Doc buckets — pick one to enable";
}

async function refreshBuckets(selectId) {
  buckets = await getBuckets();
  const chosen = selectId || (await getLastBucketId());
  els.bucket.innerHTML = "";
  for (const group of [
    { kind: "sheet", label: "Sheets" },
    { kind: "doc", label: "Docs" },
  ]) {
    const inGroup = buckets.filter((b) => b.kind === group.kind);
    if (!inGroup.length) continue;
    const og = document.createElement("optgroup");
    og.label = group.label;
    for (const b of inGroup) {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.name;
      og.appendChild(opt);
    }
    els.bucket.appendChild(og);
  }
  if (chosen) els.bucket.value = chosen;
}

async function onNewBucket() {
  const name = prompt("Name your new bucket:");
  if (!name || !name.trim()) return;
  const bucket = await addBucket(name.trim());
  await setLastBucketId(bucket.id);
  await refreshBuckets(bucket.id);
  updateShotState();
  els.content.focus();
}

async function onScreenshot() {
  els.shot.disabled = true;
  try {
    const blob = await captureVisible(currentTab?.windowId);
    staged.push({ kind: "image", blob, thumbUrl: URL.createObjectURL(blob) });
    renderStaged();
    updateSubmitState();
  } catch (err) {
    showToast(`Screenshot failed: ${err.message}`, true);
  } finally {
    updateShotState();
  }
}

function onAddMore() {
  const text = els.content.value.trim();
  if (!text) {
    els.content.focus();
    return;
  }
  staged.push({ kind: "text", text });
  els.content.value = "";
  renderStaged();
  els.content.focus();
  updateSubmitState();
}

function renderStaged() {
  els.staged.innerHTML = "";
  els.staged.hidden = staged.length === 0;
  staged.forEach((item, i) => {
    const li = document.createElement("li");
    if (item.kind === "image") {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = item.thumbUrl;
      img.alt = "Screenshot";
      const span = document.createElement("span");
      span.className = "txt";
      span.textContent = "Screenshot";
      li.append(img, span);
    } else {
      const span = document.createElement("span");
      span.className = "txt";
      span.textContent = item.text;
      span.title = item.text;
      li.append(span);
    }
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "✕";
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      staged.splice(i, 1);
      renderStaged();
      updateSubmitState();
    });
    li.append(rm);
    els.staged.appendChild(li);
  });
}

function pendingItems() {
  const items = [...staged];
  const current = els.content.value.trim();
  if (current) items.push({ kind: "text", text: current });
  return items;
}

function updateSubmitState() {
  const n = pendingItems().length;
  els.submit.disabled = n === 0;
  els.submit.textContent = n > 1 ? `Dump ${n}` : "Dump";
}

async function onSubmit() {
  const items = pendingItems();
  if (!items.length) return;

  const bucketId = els.bucket.value;
  const source =
    els.attach.checked && currentTab
      ? { sourceUrl: currentTab.url || "", sourceTitle: currentTab.title || "" }
      : { sourceUrl: "", sourceTitle: "" };

  const entries = [];
  for (const item of items) {
    if (item.kind === "image") {
      const entry = makeEntry({ bucketId, content: "", ...source }); // image only, no caption
      entry.hasImage = true;
      await putImage(entry.id, item.blob);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      entries.push(entry);
    } else {
      entries.push(makeEntry({ bucketId, content: item.text, ...source }));
    }
  }
  await addEntries(entries);
  await setLastBucketId(bucketId);
  await signalDump(); // tell any open viewer tab to refresh live
  await enqueueUpsertMany(entries.map((e) => e.id)); // queue for cloud sync

  staged = [];
  els.content.value = "";
  renderStaged();
  updateSubmitState();
  showToast(`Dumped ${entries.length} ✓`);
  setTimeout(() => window.close(), 700);
}

let toastTimer = null;
function showToast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("toast-error", isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
}

init();
