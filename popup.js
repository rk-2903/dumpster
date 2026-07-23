import {
  getBuckets,
  ensureSeeded,
  addBucket,
  getLastBucketId,
  setLastBucketId,
  signalDump,
} from "./src/buckets.js";
import { addEntries, makeEntry } from "./src/db.js";

const els = {
  bucket: document.getElementById("bucket"),
  newBucket: document.getElementById("new-bucket"),
  content: document.getElementById("content"),
  attach: document.getElementById("attach-page"),
  attachLabel: document.getElementById("attach-label"),
  staged: document.getElementById("staged"),
  addMore: document.getElementById("add-more"),
  submit: document.getElementById("submit"),
  openViewer: document.getElementById("open-viewer"),
  toast: document.getElementById("toast"),
};

let staged = []; // items waiting to be dumped as separate rows
let currentTab = null;

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
  els.bucket.addEventListener("change", () => setLastBucketId(els.bucket.value));
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
}

function getActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null))
  );
}

async function refreshBuckets(selectId) {
  const buckets = await getBuckets();
  const chosen = selectId || (await getLastBucketId());
  els.bucket.innerHTML = "";
  for (const b of buckets) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    els.bucket.appendChild(opt);
  }
  if (chosen) els.bucket.value = chosen;
}

async function onNewBucket() {
  const name = prompt("Name your new bucket:");
  if (!name || !name.trim()) return;
  const bucket = await addBucket(name.trim());
  await setLastBucketId(bucket.id);
  await refreshBuckets(bucket.id);
  els.content.focus();
}

function onAddMore() {
  const text = els.content.value.trim();
  if (!text) {
    els.content.focus();
    return;
  }
  staged.push(text);
  els.content.value = "";
  renderStaged();
  els.content.focus();
  updateSubmitState();
}

function renderStaged() {
  els.staged.innerHTML = "";
  els.staged.hidden = staged.length === 0;
  staged.forEach((text, i) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "txt";
    span.textContent = text;
    span.title = text;
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "✕";
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      staged.splice(i, 1);
      renderStaged();
      updateSubmitState();
    });
    li.append(span, rm);
    els.staged.appendChild(li);
  });
}

function pendingItems() {
  const items = [...staged];
  const current = els.content.value.trim();
  if (current) items.push(current);
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
  const source = els.attach.checked && currentTab
    ? { sourceUrl: currentTab.url || "", sourceTitle: currentTab.title || "" }
    : { sourceUrl: "", sourceTitle: "" };

  const entries = items.map((content) => makeEntry({ bucketId, content, ...source }));
  await addEntries(entries);
  await setLastBucketId(bucketId);
  await signalDump(); // tell any open viewer tab to refresh live

  staged = [];
  els.content.value = "";
  renderStaged();
  updateSubmitState();
  showToast(`Dumped ${entries.length} ✓`);
  setTimeout(() => window.close(), 700);
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
}

init();
