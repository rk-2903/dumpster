// Background service worker: seeds buckets, keeps the right-click "Dump to ▸"
// menu in sync with the bucket list, and handles reflex dumps from that menu.

import { getBuckets, ensureSeeded, addBucket, setLastBucketId, signalDump } from "./buckets.js";
import { addEntry, makeEntry } from "./db.js";
import { enqueueUpsert } from "./outbox.js";
import { drain } from "./sync.js";

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

  // Two typed submenus: Sheet buckets and Doc buckets, each with its bucket
  // list plus a "New bucket…" entry (which opens a small naming window,
  // since context menus can't take text input).
  const groups = [
    { kind: "sheet", title: "Sheet" },
    { kind: "doc", title: "Doc" },
  ];
  for (const g of groups) {
    const groupId = `kind:${g.kind}`;
    createItem({ id: groupId, parentId: PARENT_ID, title: g.title, contexts: CONTEXTS });
    for (const bucket of buckets.filter((b) => b.kind === g.kind)) {
      createItem({
        id: `bucket:${bucket.id}`,
        parentId: groupId,
        title: bucket.name,
        contexts: CONTEXTS,
      });
    }
    createItem({
      id: `newbucket:${g.kind}`,
      parentId: groupId,
      title: "＋ New bucket…",
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
  const id = String(info.menuItemId);

  // "New bucket…": ask for the name right on the page via an injected native
  // prompt (activeTab is granted by the menu click). Falls back to a small
  // naming window on pages Chrome won't inject into (chrome://, Web Store).
  if (id.startsWith("newbucket:")) {
    const kind = id.slice("newbucket:".length);
    const dump = {
      kind,
      content: contentFromClick(info),
      sourceUrl: tab?.url || info.pageUrl || "",
      sourceTitle: tab?.title || "",
    };

    let name = null;
    let injected = false;
    if (tab?.id != null) {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (label) => window.prompt(label),
          args: [`Name your new ${kind === "doc" ? "Doc" : "Sheet"} bucket:`],
        });
        injected = true;
        name = res?.result;
      } catch {
        /* injection not allowed here → fall back below */
      }
    }

    if (!injected) {
      await new Promise((r) => chrome.storage.local.set({ pendingDump: dump }, r));
      chrome.windows.create({
        url: chrome.runtime.getURL("newbucket.html"),
        type: "popup",
        width: 400,
        height: 300,
      });
      return;
    }

    if (!name || !name.trim()) return; // user cancelled the prompt
    const bucket = await addBucket(name.trim(), kind);
    const entry = makeEntry({
      bucketId: bucket.id,
      content: dump.content,
      sourceUrl: dump.sourceUrl,
      sourceTitle: dump.sourceTitle,
    });
    await addEntry(entry);
    await setLastBucketId(bucket.id);
    await signalDump();
    await enqueueUpsert(entry.id);
    flashBadge();
    return;
  }

  if (!id.startsWith("bucket:")) return;
  const bucketId = id.slice("bucket:".length);
  const entry = makeEntry({
    bucketId,
    content: contentFromClick(info),
    sourceUrl: tab?.url || info.pageUrl || "",
    sourceTitle: tab?.title || "",
  });
  await addEntry(entry);
  await setLastBucketId(bucketId);
  await signalDump(); // refresh any open viewer tab live
  await enqueueUpsert(entry.id); // queue for cloud sync
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

// ---- Cloud sync drain ----
// Any context (popup/viewer/context-menu) pings us via runtime.sendMessage after
// enqueuing outbox ops; a periodic alarm retries anything still pending.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "dumpster-sync") drain();
});
chrome.alarms.create("dumpster-sync", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "dumpster-sync") drain();
});
chrome.runtime.onStartup.addListener(drain);
drain();
