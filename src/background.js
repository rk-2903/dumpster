// Background service worker: seeds buckets, keeps the right-click "Dump to ▸"
// menu in sync with the bucket list, and handles reflex dumps from that menu.

import {
  getBuckets,
  ensureSeeded,
  addBucket,
  getLastBucketId,
  setLastBucketId,
  signalDump,
} from "./buckets.js";
import { addEntry, makeEntry, putImage } from "./db.js";
import { enqueueUpsert } from "./outbox.js";
import { drain } from "./sync.js";
import { captureVisible, cropBlob } from "./capture.js";
import { regionSelectOverlay } from "./regionSelect.js";
import { getToken, getConnection } from "./googleAuth.js";
import { createDocsProvider } from "./docsSync.js";
import { track, flush, pingActive, initUninstallUrl } from "./telemetry.js";

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

  // Screenshots land in Doc buckets: each bucket offers visible-area or
  // drag-a-region capture.
  createItem({ id: "shot-parent", title: "Screenshot to", contexts: CONTEXTS });
  for (const bucket of buckets.filter((b) => b.kind === "doc")) {
    const bid = `shotb:${bucket.id}`;
    createItem({ id: bid, parentId: "shot-parent", title: bucket.name, contexts: CONTEXTS });
    createItem({ id: `shot:vis:${bucket.id}`, parentId: bid, title: "Visible area", contexts: CONTEXTS });
    createItem({ id: `shot:reg:${bucket.id}`, parentId: bid, title: "Select region", contexts: CONTEXTS });
  }
  createItem({ id: "shotnew", parentId: "shot-parent", title: "＋ New Doc bucket…", contexts: CONTEXTS });

  // Right-click the toolbar icon: the doc panel opens on left-click now, so
  // the menu carries the popup-style quick dump (multi-item staging, Sheet
  // notes) as a small window instead.
  createItem({ id: "open-panel", title: "Open doc panel", contexts: ["action"] });
  createItem({ id: "quick-dump", title: "Quick dump…", contexts: ["action"] });
}

// Choose what to dump based on what was right-clicked, preferring the most
// specific target: selected text, then a link, then an image, then the page.
function contentFromClick(info) {
  if (info.selectionText) return info.selectionText;
  if (info.linkUrl) return info.linkUrl;
  if (info.srcUrl) return info.srcUrl;
  return info.pageUrl || "";
}

// Capture (optionally cropped), store locally, and queue for sync.
async function saveScreenshot(bucketId, tab, rect) {
  const blob = await captureVisible(tab?.windowId);
  const final = rect ? await cropBlob(blob, rect, rect.dpr || 1) : blob;
  const entry = makeEntry({
    bucketId,
    content: "", // image only — no caption text
    sourceUrl: tab?.url || "",
    sourceTitle: tab?.title || "",
  });
  entry.hasImage = true;
  await putImage(entry.id, final);
  await addEntry(entry);
  await setLastBucketId(bucketId);
  await signalDump();
  await enqueueUpsert(entry.id);
  flashBadge();
}

function flashBadgeError(code) {
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  chrome.action.setBadgeText({ text: "✕" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
  track("error", code ? { code } : undefined); // anonymous error counter
}

// Capture (region or visible) into a bucket. Returns { ok } | { cancelled }.
// A pre-selected `rect` (e.g. from the in-page dock overlay) skips injection —
// the context-menu path passes none and injects the overlay itself.
async function captureScreenshot(tab, mode, bucketId, rect = null) {
  if (mode === "region" && !rect) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: regionSelectOverlay });
    rect = res?.result;
    if (!rect) return { cancelled: true };
    await new Promise((r) => setTimeout(r, 80)); // let the overlay's removal paint
  }
  await saveScreenshot(bucketId, tab, mode === "region" ? rect : null);
  return { ok: true };
}

// OCR a region (or the visible tab) to *text* and file it as a paragraph entry
// in the Doc bucket — Drive's free convert-with-OCR. Needs a Google connection.
async function ocrCaptureToText(tab, bucketId, rect) {
  const { connected } = await getConnection();
  if (!connected) return { ok: false, error: "Connect Google for OCR" };
  const shot = await captureVisible(tab?.windowId);
  const blob = rect ? await cropBlob(shot, rect, rect.dpr || 1) : shot;
  const text = (await createDocsProvider({ getToken }).ocrImage(blob).catch(() => "")) || "";
  if (!text) return { ok: false, error: "No text found" };
  const entry = makeEntry({
    bucketId,
    content: text,
    sourceUrl: tab?.url || "",
    sourceTitle: tab?.title || "",
  });
  entry.format = "p";
  await addEntry(entry);
  await setLastBucketId(bucketId);
  await signalDump();
  await enqueueUpsert(entry.id);
  flashBadge();
  return { ok: true };
}

async function lastDocBucket() {
  const docs = (await getBuckets()).filter((b) => b.kind === "doc");
  if (!docs.length) return null;
  const lastId = await getLastBucketId();
  return docs.find((b) => b.id === lastId) || docs[0];
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);

  // Must run before any await — sidePanel.open needs the live user gesture.
  if (id === "open-panel") {
    chrome.sidePanel.open({ windowId: tab.windowId });
    return;
  }

  // The classic capture popup, now reachable from the icon's context menu.
  if (id === "quick-dump") {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup.html?window=1"),
      type: "popup",
      width: 384,
      height: 640,
    });
    return;
  }

  // Screenshot to an existing Doc bucket: "shot:<vis|reg>:<bucketId>".
  if (id.startsWith("shot:")) {
    const [, mode, bucketId] = id.split(":");
    try {
      await captureScreenshot(tab, mode === "reg" ? "region" : "visible", bucketId);
    } catch (err) {
      console.warn("[dumpster] screenshot failed:", err.message);
      flashBadgeError();
    }
    return;
  }

  // Screenshot into a brand-new Doc bucket (named via in-page prompt).
  if (id === "shotnew") {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (label) => window.prompt(label),
        args: ["Name your new Doc bucket:"],
      });
      const name = res?.result;
      if (!name || !name.trim()) return;
      const bucket = await addBucket(name.trim(), "doc");
      await saveScreenshot(bucket.id, tab, null);
    } catch (err) {
      // Page doesn't allow injection (chrome://, Web Store) → capture can't
      // work there either; signal failure instead of opening a naming window.
      console.warn("[dumpster] screenshot new-bucket failed:", err.message);
      flashBadgeError();
    }
    return;
  }

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
  track("feature", { name: "context-dump" });
});

function flashBadge() {
  chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
  chrome.action.setBadgeText({ text: "" });
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

chrome.runtime.onInstalled.addListener(async (details) => {
  await requestPersistence();
  await ensureSeeded();
  await rebuildMenus();
  // Anonymous lifecycle telemetry (opt-out). Point the uninstall URL here too.
  if (details.reason === "install") track("install");
  else if (details.reason === "update") {
    track("update", { from: details.previousVersion, to: chrome.runtime.getManifest().version });
  }
  initUninstallUrl();
  flush();
});

// Clicking the toolbar icon opens the doc side panel directly (no popup —
// with a default_popup set this behavior would be ignored, so the manifest
// no longer declares one). The icon click still grants activeTab, which the
// panel uses to arm the page helper on the current tab.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn("[dumpster] panel behavior:", e.message));

// MV3 workers are torn down and restarted; rebuild on wake so the menu survives.
chrome.runtime.onStartup.addListener(() => {
  rebuildMenus();
  pingActive();
  initUninstallUrl();
  flush();
});
rebuildMenus();
requestPersistence();
// On every worker wake: count a daily-active ping and drain any queued events.
pingActive();
initUninstallUrl();
flush();

// Keep the menu current whenever the bucket list changes (from popup or viewer).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.buckets) rebuildMenus();
});

// ---- Keyboard shortcut: screenshot to the last-used Doc bucket ----
// The command gesture grants activeTab for the focused tab.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "screenshot-to-doc") return;
  try {
    const buckets = await getBuckets();
    const docs = buckets.filter((b) => b.kind === "doc");
    if (!docs.length) {
      flashBadgeError(); // nowhere to put it — create a Doc bucket first
      return;
    }
    const lastId = await getLastBucketId();
    const target = docs.find((b) => b.id === lastId) || docs[0];
    await saveScreenshot(target.id, tab, null);
    track("feature", { name: "screenshot-hotkey" });
  } catch (err) {
    console.warn("[dumpster] shortcut screenshot failed:", err.message);
    flashBadgeError("screenshot");
  }
});

// ---- Selection helper: save selected page text to the last-used Doc bucket ----
// The in-page floating pill sends only the selected text + chosen format. We
// file it into a Doc bucket so it lands in that bucket's Google Doc as a real
// Heading 1/2, bullet list, or paragraph.
const SELECTION_FORMATS = new Set(["h1", "h2", "list", "p"]);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "dumpster-selection-save") return;
  (async () => {
    try {
      const text = String(msg.text || "").trim();
      if (!text) return sendResponse({ ok: false, error: "Empty selection" });
      const docs = (await getBuckets()).filter((b) => b.kind === "doc");
      if (!docs.length) return sendResponse({ ok: false, error: "No Doc bucket yet" });
      const lastId = await getLastBucketId();
      const bucket = docs.find((b) => b.id === lastId) || docs[0];
      const tab = sender.tab;
      const entry = makeEntry({
        bucketId: bucket.id,
        content: text,
        sourceUrl: tab?.url || "",
        sourceTitle: tab?.title || "",
      });
      if (SELECTION_FORMATS.has(msg.format)) entry.format = msg.format;
      await addEntry(entry);
      await setLastBucketId(bucket.id);
      await signalDump();
      await enqueueUpsert(entry.id);
      flashBadge();
      track("feature", { name: "selection" });
      sendResponse({ ok: true, bucketName: bucket.name });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async sendResponse
});

// ---- YouTube transcript: timestamped caption lines into the last Doc bucket ----
// The dock sends pre-formatted "[m:ss] text" lines plus a deep-link source URL
// (watch?v=…&t=<sec>s) so the doc entry resumes the video at that moment.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "dumpster-transcript-save") return;
  (async () => {
    try {
      const text = String(msg.text || "").trim();
      if (!text) return sendResponse({ ok: false, error: "Empty transcript" });
      const docs = (await getBuckets()).filter((b) => b.kind === "doc");
      if (!docs.length) return sendResponse({ ok: false, error: "No Doc bucket yet" });
      const lastId = await getLastBucketId();
      const bucket = docs.find((b) => b.id === lastId) || docs[0];
      const sourceUrl = /^https?:\/\//i.test(msg.sourceUrl || "")
        ? msg.sourceUrl
        : sender.tab?.url || "";
      const entry = makeEntry({
        bucketId: bucket.id,
        content: text,
        sourceUrl,
        sourceTitle: String(msg.sourceTitle || sender.tab?.title || ""),
      });
      entry.format = "list"; // one bullet per [m:ss] line
      await addEntry(entry);
      await setLastBucketId(bucket.id);
      await signalDump();
      await enqueueUpsert(entry.id);
      flashBadge();
      track("feature", { name: "yt-transcript" });
      sendResponse({ ok: true, bucketName: bucket.name });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async sendResponse
});

// ---- Floating launcher: screenshot to the last-used Doc bucket ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "dumpster-shot") return;
  (async () => {
    try {
      const bucket = await lastDocBucket();
      if (!bucket) {
        flashBadgeError();
        return sendResponse({ ok: false, error: "No Doc bucket yet" });
      }
      if (msg.mode === "ocr") {
        const r = await ocrCaptureToText(sender.tab, bucket.id, msg.rect || null);
        if (r.ok) track("feature", { name: "ocr" });
        else flashBadgeError("ocr");
        return sendResponse(r.ok ? { ok: true, bucketName: bucket.name } : r);
      }
      const res = await captureScreenshot(
        sender.tab,
        msg.mode === "region" ? "region" : "visible",
        bucket.id,
        msg.rect || null
      );
      if (res.cancelled) return sendResponse({ ok: false, cancelled: true });
      track("feature", { name: msg.mode === "region" ? "screenshot-region" : "screenshot" });
      sendResponse({ ok: true, bucketName: bucket.name });
    } catch (err) {
      flashBadgeError("screenshot");
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async sendResponse
});

// ---- Cloud sync drain ----
// Any context (popup/viewer/context-menu) pings us via runtime.sendMessage after
// enqueuing outbox ops; a periodic alarm retries anything still pending.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "dumpster-sync") {
    drain();
    flush(); // piggyback telemetry delivery on the sync kick
  }
});
chrome.alarms.create("dumpster-sync", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "dumpster-sync") {
    drain();
    flush(); // durable retry for queued telemetry
  }
});
chrome.runtime.onStartup.addListener(drain);
drain();
