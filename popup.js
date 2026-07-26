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
import { track, pingActive, flush, initUninstallUrl } from "./src/telemetry.js";

const els = {
  bucket: document.getElementById("bucket"),
  kindTabs: [...document.querySelectorAll(".kind-tab")],
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
  telemetry: document.getElementById("telemetry-toggle"),
  telemetryNotice: document.getElementById("telemetry-notice"),
  telemetryDismiss: document.getElementById("telemetry-dismiss"),
  toast: document.getElementById("toast"),
};

// Items waiting to be dumped as separate rows:
// { kind: "text", text } | { kind: "image", blob, thumbUrl }
let staged = [];
let currentTab = null;
let buckets = [];
// Which bucket type the popup is showing — Sheet and Doc are kept on separate
// tabs so the two never mix. Persisted as `popupKind`.
let activeKind = "sheet";

function getStored(key) {
  return new Promise((r) => chrome.storage.local.get(key, (o) => r(o[key])));
}

async function init() {
  await ensureSeeded();

  // Open on the tab the user last used (an explicit tab switch, or the kind of
  // their last-dumped bucket), falling back to Sheet.
  buckets = await getBuckets();
  const storedKind = await getStored("popupKind");
  const lastId = await getLastBucketId();
  const lastKind = buckets.find((b) => b.id === lastId)?.kind;
  activeKind = storedKind || lastKind || "sheet";
  await refreshBuckets();

  currentTab = await getActiveTab();
  if (currentTab?.title || currentTab?.url) {
    els.attachLabel.textContent = `Attach: ${currentTab.title || currentTab.url}`;
    els.attachLabel.title = currentTab.url || "";
  } else {
    els.attach.checked = false;
    els.attach.parentElement.hidden = true;
  }

  els.kindTabs.forEach((t) => t.addEventListener("click", () => switchKind(t.dataset.kind)));
  els.newBucket.addEventListener("click", onNewBucket);
  els.bucket.addEventListener("change", () => {
    if (els.bucket.value) setLastBucketId(els.bucket.value);
    updateShotState();
    updateSubmitState();
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

  // Opening the popup is a good "active today" signal; also drain any queue.
  pingActive();
  flush();

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
    // Re-enabling from the popup is the master reset — clear any per-domain /
    // all-sites dock hides the user set from the dock's × menu.
    const patch = on
      ? { selectionHelper: true, dumpsterDockHideAll: false, dumpsterDockHideDomains: [] }
      : { selectionHelper: false };
    chrome.storage.local.set(patch);
    if (on) injectSelectionHelper(); // activate immediately on this tab
    // Turning off: the already-injected script self-disables via the storage
    // change; no re-injection until re-enabled.
  });

  wireTelemetryControls();
}

// Anonymous-usage opt-out toggle + one-time first-run notice.
function wireTelemetryControls() {
  chrome.storage.local.get(["telemetryEnabled", "telemetryNoticeSeen"], (o) => {
    els.telemetry.checked = o.telemetryEnabled !== false; // default on
    // Show the disclosure once, only while telemetry is on.
    els.telemetryNotice.hidden = o.telemetryNoticeSeen === true || o.telemetryEnabled === false;
  });
  els.telemetry.addEventListener("change", () => {
    chrome.storage.local.set({ telemetryEnabled: els.telemetry.checked });
    initUninstallUrl(); // set or clear the uninstall ping to match the choice
    if (!els.telemetry.checked) els.telemetryNotice.hidden = true;
  });
  els.telemetryDismiss.addEventListener("click", () => {
    chrome.storage.local.set({ telemetryNoticeSeen: true });
    els.telemetryNotice.hidden = true;
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

function updateTabs() {
  els.kindTabs.forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.kind === activeKind))
  );
}

// Screenshots are a Doc-bucket feature (sheets have no place to show them).
function updateShotState() {
  const canShoot = activeKind === "doc" && !!els.bucket.value;
  els.shot.disabled = !canShoot;
  els.shot.title = canShoot
    ? "Screenshot the visible page into this Doc bucket"
    : activeKind === "doc"
      ? "Create a Doc bucket first (click ＋)"
      : "Screenshots go to Doc buckets — switch to the Doc tab";
}

async function switchKind(kind) {
  if (!kind || kind === activeKind) return;
  activeKind = kind;
  chrome.storage.local.set({ popupKind: kind });
  await refreshBuckets();
  if (els.bucket.value) setLastBucketId(els.bucket.value);
  els.content.focus();
}

// Populate the select with only the active kind's buckets; keep the previous
// selection if it belongs to this kind, else the last-used one, else the first.
async function refreshBuckets(selectId) {
  buckets = await getBuckets();
  const last = await getLastBucketId();
  const inKind = buckets.filter((b) => b.kind === activeKind);
  els.bucket.innerHTML = "";
  if (!inKind.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.textContent = `No ${activeKind === "doc" ? "Doc" : "Sheet"} buckets yet — click ＋`;
    els.bucket.appendChild(opt);
    els.bucket.value = "";
  } else {
    for (const b of inKind) {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.name;
      els.bucket.appendChild(opt);
    }
    const pick = [selectId, last].find((id) => inKind.some((b) => b.id === id)) || inKind[0].id;
    els.bucket.value = pick;
  }
  updateTabs();
  updateShotState();
  updateSubmitState();
}

async function onNewBucket() {
  const name = prompt(`Name your new ${activeKind === "doc" ? "Doc" : "Sheet"} bucket:`);
  if (!name || !name.trim()) return;
  const bucket = await addBucket(name.trim(), activeKind);
  await setLastBucketId(bucket.id);
  await refreshBuckets(bucket.id);
  els.content.focus();
}

async function onScreenshot() {
  els.shot.disabled = true;
  try {
    const blob = await captureVisible(currentTab?.windowId);
    staged.push({ kind: "image", blob, thumbUrl: URL.createObjectURL(blob) });
    renderStaged();
    updateSubmitState();
    track("feature", { name: "popup-screenshot" });
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
  els.submit.disabled = n === 0 || !els.bucket.value;
  els.submit.textContent = n > 1 ? `Dump ${n}` : "Dump";
}

async function onSubmit() {
  const items = pendingItems();
  if (!items.length) return;

  const bucketId = els.bucket.value;
  if (!bucketId) return;
  chrome.storage.local.set({ popupKind: activeKind }); // reopen on this tab
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
  track("feature", { name: "popup-dump" });

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
