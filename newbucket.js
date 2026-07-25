// Mini window opened from the context menu's "＋ New bucket…". Reads the
// pending dump stashed by the background worker, creates the bucket with the
// chosen kind, files the dump, and closes.

import { addBucket, setLastBucketId, signalDump } from "./src/buckets.js";
import { addEntry, makeEntry } from "./src/db.js";
import { enqueueUpsert } from "./src/outbox.js";

const els = {
  title: document.getElementById("title"),
  name: document.getElementById("name"),
  preview: document.getElementById("preview"),
  cancel: document.getElementById("cancel"),
  create: document.getElementById("create"),
};

function getPending() {
  return new Promise((r) => chrome.storage.local.get("pendingDump", (o) => r(o.pendingDump)));
}
function clearPending() {
  return new Promise((r) => chrome.storage.local.remove("pendingDump", r));
}

let pending = null;

async function init() {
  pending = await getPending();
  if (!pending) {
    window.close();
    return;
  }
  els.title.textContent = pending.kind === "doc" ? "New Doc bucket" : "New Sheet bucket";
  els.preview.textContent = pending.content || "(current page)";
  els.name.focus();

  els.cancel.addEventListener("click", async () => {
    await clearPending();
    window.close();
  });
  els.create.addEventListener("click", onCreate);
  els.name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onCreate();
    if (e.key === "Escape") els.cancel.click();
  });
}

async function onCreate() {
  const name = els.name.value.trim();
  if (!name) {
    els.name.focus();
    return;
  }
  els.create.disabled = true;
  const bucket = await addBucket(name, pending.kind);
  const entry = makeEntry({
    bucketId: bucket.id,
    content: pending.content,
    sourceUrl: pending.sourceUrl,
    sourceTitle: pending.sourceTitle,
  });
  await addEntry(entry);
  await setLastBucketId(bucket.id);
  await signalDump();
  await enqueueUpsert(entry.id);
  await clearPending();
  window.close();
}

init();
