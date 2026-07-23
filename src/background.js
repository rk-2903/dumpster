// Background service worker: seeds buckets, keeps the right-click "Dump to ▸"
// menu in sync with the bucket list, and handles reflex dumps from that menu.

import { getBuckets, ensureSeeded, setLastBucketId, signalDump } from "./buckets.js";
import { addEntry, makeEntry } from "./db.js";

const PARENT_ID = "dumpster-parent";
const CONTEXTS = ["selection", "link", "page", "image"];

// Serialize rebuilds. onInstalled, onStartup, worker wake, and the
// storage.onChanged that ensureSeeded() itself fires can all trigger a rebuild
// near-simultaneously; without a lock two runs interleave their removeAll/create
// calls and Chrome throws "Cannot create item with duplicate id".
let rebuildQueue = Promise.resolve();
function rebuildMenus() {
  rebuildQueue = rebuildQueue.catch(() => {}).then(doRebuildMenus);
  return rebuildQueue;
}

// Reading chrome.runtime.lastError in the callback marks it handled, so a stray
// create never surfaces as an "Unchecked runtime.lastError" in the console.
function createItem(opts) {
  chrome.contextMenus.create(opts, () => void chrome.runtime.lastError);
}

async function doRebuildMenus() {
  await chrome.contextMenus.removeAll();
  const buckets = await getBuckets();

  createItem({ id: PARENT_ID, title: "Dump to", contexts: CONTEXTS });

  if (!buckets.length) {
    createItem({
      id: "dumpster-empty",
      parentId: PARENT_ID,
      title: "No buckets yet — open Dumpster to add one",
      enabled: false,
      contexts: CONTEXTS,
    });
    return;
  }

  for (const bucket of buckets) {
    createItem({
      id: `bucket:${bucket.id}`,
      parentId: PARENT_ID,
      title: bucket.name,
      contexts: CONTEXTS,
    });
  }
}

// Choose what to dump based on what was right-clicked, preferring the most
// specific target: selected text, then a link, then an image, then the page.
function contentFromClick(info) {
  if (info.selectionText) return info.selectionText;
  if (info.linkUrl) return info.linkUrl;
  if (info.srcUrl) return info.srcUrl;
  return info.pageUrl || "";
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId.startsWith("bucket:")) return;
  const bucketId = info.menuItemId.slice("bucket:".length);
  const entry = makeEntry({
    bucketId,
    content: contentFromClick(info),
    sourceUrl: tab?.url || info.pageUrl || "",
    sourceTitle: tab?.title || "",
  });
  await addEntry(entry);
  await setLastBucketId(bucketId);
  await signalDump(); // refresh any open viewer tab live
  flashBadge();
});

function flashBadge() {
  chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
  chrome.action.setBadgeText({ text: "✓" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
}

// Ask Chrome to treat our IndexedDB/storage as persistent so it isn't evicted
// under disk pressure. For extensions this is granted without a prompt; safe to
// call repeatedly.
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* not fatal — data is still stored, just not eviction-protected */
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await requestPersistence();
  await ensureSeeded();
  await rebuildMenus();
});

// MV3 workers are torn down and restarted; rebuild on wake so the menu survives.
chrome.runtime.onStartup.addListener(rebuildMenus);
rebuildMenus();
requestPersistence();

// Keep the menu current whenever the bucket list changes (from popup or viewer).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.buckets) rebuildMenus();
});
