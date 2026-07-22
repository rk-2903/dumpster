import {
  getBuckets,
  ensureSeeded,
  addBucket,
  renameBucket,
  deleteBucket,
  getLastBucketId,
  setLastBucketId,
} from "./src/buckets.js";
import {
  getEntriesByBucket,
  getAllEntries,
  countByBucket,
  updateEntry,
  deleteEntry,
  STATUSES,
  DEFAULT_STATUS,
} from "./src/db.js";

const els = {
  tabs: document.getElementById("tabs"),
  bucketName: document.getElementById("bucket-name"),
  entryCount: document.getElementById("entry-count"),
  rows: document.getElementById("rows"),
  table: document.getElementById("entries"),
  empty: document.getElementById("empty"),
  rename: document.getElementById("rename-bucket"),
  del: document.getElementById("delete-bucket"),
  search: document.getElementById("search"),
  // Export modal
  exportOpen: document.getElementById("export-open"),
  exportModal: document.getElementById("export-modal"),
  exportFormat: document.getElementById("export-format"),
  formatHint: document.getElementById("format-hint"),
  exportAll: document.getElementById("export-all"),
  exportBuckets: document.getElementById("export-buckets"),
  exportCancel: document.getElementById("export-cancel"),
  exportGo: document.getElementById("export-go"),
};

let activeBucketId = null;
let rowIndex = []; // { tr, hay } for client-side filtering

async function init() {
  await ensureSeeded();
  await migrateStatuses();
  activeBucketId = await getLastBucketId();
  await renderTabs();
  await renderBucket();

  els.rename.addEventListener("click", onRename);
  els.del.addEventListener("click", onDelete);
  els.search.addEventListener("input", applyFilter);
  wireExportModal();

  // A dump made from the context menu while this tab is open should show up.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.buckets) renderTabs();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderBucket();
  });
}

async function renderTabs() {
  const buckets = await getBuckets();
  const counts = await countByBucket();
  if (!buckets.some((b) => b.id === activeBucketId)) {
    activeBucketId = buckets[0]?.id || null;
  }
  els.tabs.innerHTML = "";
  for (const b of buckets) {
    const tab = document.createElement("button");
    tab.className = "tab" + (b.id === activeBucketId ? " active" : "");
    tab.innerHTML = `${escapeHtml(b.name)}<span class="badge">${counts[b.id] || 0}</span>`;
    tab.addEventListener("click", async () => {
      activeBucketId = b.id;
      els.search.value = "";
      await setLastBucketId(b.id);
      await renderTabs();
      await renderBucket();
    });
    els.tabs.appendChild(tab);
  }
  const add = document.createElement("button");
  add.className = "tab add";
  add.textContent = "＋";
  add.title = "New bucket";
  add.addEventListener("click", onNewBucket);
  els.tabs.appendChild(add);
}

async function renderBucket() {
  const buckets = await getBuckets();
  const bucket = buckets.find((b) => b.id === activeBucketId);
  if (!bucket) {
    els.bucketName.textContent = "—";
    els.entryCount.textContent = "";
    els.rows.innerHTML = "";
    els.table.hidden = true;
    els.empty.hidden = false;
    return;
  }
  els.bucketName.textContent = bucket.name;

  const entries = await getEntriesByBucket(bucket.id);
  els.entryCount.textContent = entries.length
    ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`
    : "";
  els.rows.innerHTML = "";

  if (!entries.length) {
    rowIndex = [];
    els.table.hidden = true;
    els.empty.hidden = false;
    return;
  }
  els.table.hidden = false;
  els.empty.hidden = true;

  rowIndex = [];
  for (const entry of entries) {
    const tr = renderRow(entry);
    els.rows.appendChild(tr);
    const hay = [entry.content, entry.sourceTitle, entry.sourceUrl, entry.status, entry.notes]
      .join(" ")
      .toLowerCase();
    rowIndex.push({ tr, hay });
  }
  applyFilter();
}

function applyFilter() {
  const q = els.search.value.trim().toLowerCase();
  let shown = 0;
  for (const { tr, hay } of rowIndex) {
    const match = !q || hay.includes(q);
    tr.style.display = match ? "" : "none";
    if (match) shown++;
  }
  const total = rowIndex.length;
  els.entryCount.textContent = !total
    ? ""
    : q
    ? `${shown} of ${total}`
    : `${total} ${total === 1 ? "entry" : "entries"}`;
}

function renderRow(entry) {
  const tr = document.createElement("tr");

  const time = document.createElement("td");
  time.className = "cell-time";
  time.textContent = formatTime(entry.createdAt);
  time.title = new Date(entry.createdAt).toLocaleString();

  const content = document.createElement("td");
  content.className = "cell-content";
  renderContentView(content, entry);

  const source = document.createElement("td");
  if (entry.sourceUrl) {
    const a = document.createElement("a");
    a.className = "src-link";
    a.href = entry.sourceUrl;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = entry.sourceTitle || entry.sourceUrl;
    a.title = entry.sourceUrl;
    source.appendChild(a);
  }

  const status = document.createElement("td");
  status.appendChild(renderStatusSelect(entry));

  const notes = document.createElement("td");
  notes.appendChild(
    makeEditable("textarea", entry.notes, "Add a note…", (val) =>
      updateEntry(entry.id, { notes: val })
    )
  );

  const actions = document.createElement("td");
  const del = document.createElement("button");
  del.className = "row-delete";
  del.textContent = "✕";
  del.title = "Delete this entry";
  del.addEventListener("click", async () => {
    await deleteEntry(entry.id);
    tr.remove();
    renderTabs();
    renderBucket();
  });
  actions.appendChild(del);

  tr.append(time, content, source, status, notes, actions);
  return tr;
}

// The dumped text: linkified read-only view, double-click to edit inline.
function renderContentView(td, entry) {
  td.textContent = "";
  td.title = "Double-click to edit";
  td.appendChild(linkify(entry.content));
  td.ondblclick = (e) => {
    // Don't hijack a click meant for a link.
    if (e.target.tagName === "A") return;
    editContent(td, entry);
  };
}

function editContent(td, entry) {
  td.textContent = "";
  td.title = "";
  td.ondblclick = null;
  const ta = document.createElement("textarea");
  ta.className = "editable content-edit";
  ta.value = entry.content;
  ta.rows = Math.min(6, entry.content.split("\n").length + 1);
  const save = async () => {
    const val = ta.value.trim();
    if (val && val !== entry.content) {
      entry.content = val;
      await updateEntry(entry.id, { content: val });
    }
    renderContentView(td, entry);
  };
  ta.addEventListener("blur", save);
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      ta.blur();
    } else if (ev.key === "Escape") {
      ta.value = entry.content; // discard
      ta.blur();
    }
  });
  td.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// Status is a three-state select rendered as a colored pill.
function renderStatusSelect(entry) {
  const sel = document.createElement("select");
  sel.className = "status-select";
  for (const s of STATUSES) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  }
  sel.value = STATUSES.includes(entry.status) ? entry.status : DEFAULT_STATUS;
  sel.dataset.tone = statusTone(sel.value);
  sel.addEventListener("change", () => {
    entry.status = sel.value;
    sel.dataset.tone = statusTone(sel.value);
    updateEntry(entry.id, { status: sel.value });
  });
  return sel;
}

function statusTone(value) {
  if (value === "Done") return "green";
  if (value === "In Process") return "blue";
  return "amber"; // To Do
}

// One-time cleanup: map any legacy free-text status onto the three states.
async function migrateStatuses() {
  const all = await getAllEntries();
  const updates = [];
  for (const e of all) {
    if (STATUSES.includes(e.status)) continue;
    const t = (e.status || "").toLowerCase();
    let next = DEFAULT_STATUS;
    if (/\b(done|complete|accept|offer|hired|approv|closed|reject|declin)/.test(t)) next = "Done";
    else if (/\b(process|progress|interview|review|wait|pending|follow|referr|sent|appl|dm|need|schedul|submit)/.test(t))
      next = "In Process";
    if (next !== e.status) updates.push(updateEntry(e.id, { status: next }));
  }
  await Promise.all(updates);
}

function makeEditable(tag, value, placeholder, onSave) {
  const el = document.createElement(tag);
  el.className = "editable";
  el.placeholder = placeholder;
  if (tag === "textarea") el.rows = 1;
  el.value = value || "";
  let last = el.value;
  el.addEventListener("blur", () => {
    if (el.value !== last) {
      last = el.value;
      onSave(el.value.trim());
    }
  });
  if (tag === "input") {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") el.blur();
    });
  }
  return el;
}

// Turn bare URLs inside dumped text into clickable links, safely (no innerHTML
// of untrusted content).
function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement("a");
    a.href = m[0];
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = m[0];
    frag.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

async function onNewBucket() {
  const name = prompt("Name your new bucket:");
  if (!name || !name.trim()) return;
  const bucket = await addBucket(name.trim());
  activeBucketId = bucket.id;
  await setLastBucketId(bucket.id);
  await renderTabs();
  await renderBucket();
}

async function onRename() {
  const buckets = await getBuckets();
  const bucket = buckets.find((b) => b.id === activeBucketId);
  if (!bucket) return;
  const name = prompt("Rename bucket:", bucket.name);
  if (!name || !name.trim()) return;
  await renameBucket(bucket.id, name.trim());
  await renderTabs();
  await renderBucket();
}

async function onDelete() {
  const buckets = await getBuckets();
  const bucket = buckets.find((b) => b.id === activeBucketId);
  if (!bucket) return;
  const entries = await getEntriesByBucket(bucket.id);
  const msg = entries.length
    ? `Delete "${bucket.name}" and its ${entries.length} ${entries.length === 1 ? "entry" : "entries"}? This can't be undone.`
    : `Delete "${bucket.name}"?`;
  if (!confirm(msg)) return;
  await deleteBucket(bucket.id);
  activeBucketId = null;
  await renderTabs();
  await renderBucket();
}

// ---- Export ---------------------------------------------------------------

const EXPORT_COLS = ["createdAt", "content", "sourceUrl", "sourceTitle", "status", "notes"];
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let exportFormat = "xlsx";

function wireExportModal() {
  els.exportOpen.addEventListener("click", openExportModal);
  els.exportCancel.addEventListener("click", closeExportModal);
  els.exportModal.addEventListener("click", (e) => {
    if (e.target === els.exportModal) closeExportModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.exportModal.hidden) closeExportModal();
  });
  els.exportFormat.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg");
    if (!btn) return;
    exportFormat = btn.dataset.format;
    [...els.exportFormat.children].forEach((s) => s.classList.toggle("active", s === btn));
    els.formatHint.textContent =
      exportFormat === "xlsx"
        ? "One sheet per bucket."
        : "Each bucket becomes a key holding its dumps.";
  });
  els.exportAll.addEventListener("change", () => {
    els.exportBuckets.querySelectorAll("input").forEach((c) => (c.checked = els.exportAll.checked));
    refreshExportState();
  });
  els.exportBuckets.addEventListener("change", refreshExportState);
  els.exportGo.addEventListener("click", doExport);
}

async function openExportModal() {
  const buckets = await getBuckets();
  els.exportBuckets.innerHTML = "";
  for (const b of buckets) {
    const label = document.createElement("label");
    label.className = "check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = b.id;
    cb.checked = b.id === activeBucketId; // default: the bucket you're viewing
    const span = document.createElement("span");
    span.textContent = b.name;
    label.append(cb, span);
    els.exportBuckets.appendChild(label);
  }
  refreshExportState();
  els.exportModal.hidden = false;
}

function closeExportModal() {
  els.exportModal.hidden = true;
}

function selectedExportIds() {
  return [...els.exportBuckets.querySelectorAll("input:checked")].map((i) => i.value);
}

// Keep the "All buckets" checkbox and Export button in sync with the selection.
function refreshExportState() {
  const boxes = [...els.exportBuckets.querySelectorAll("input")];
  const checked = boxes.filter((b) => b.checked).length;
  els.exportAll.checked = checked > 0 && checked === boxes.length;
  els.exportAll.indeterminate = checked > 0 && checked < boxes.length;
  els.exportGo.disabled = checked === 0;
}

async function doExport() {
  const ids = selectedExportIds();
  if (!ids.length) return;
  const buckets = (await getBuckets()).filter((b) => ids.includes(b.id));

  // Gather each bucket's rows, oldest-first for natural reading in a sheet.
  const data = [];
  for (const b of buckets) {
    const entries = (await getEntriesByBucket(b.id))
      .slice()
      .sort((a, z) => (a.createdAt < z.createdAt ? -1 : 1))
      .map(pickCols);
    data.push({ name: b.name, rows: entries });
  }

  if (exportFormat === "json") {
    const obj = {};
    for (const d of data) obj[d.name] = d.rows;
    download(`dumpster-${stamp()}.json`, "application/json", JSON.stringify(obj, null, 2));
  } else {
    const XLSX = await import("./vendor/xlsx.mjs"); // lazy: only load ~1MB on demand
    const wb = XLSX.utils.book_new();
    const used = new Set();
    for (const d of data) {
      const ws = d.rows.length
        ? XLSX.utils.json_to_sheet(d.rows, { header: EXPORT_COLS })
        : XLSX.utils.aoa_to_sheet([EXPORT_COLS]);
      XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(d.name, used));
    }
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    download(`dumpster-${stamp()}.xlsx`, XLSX_MIME, buf);
  }
  closeExportModal();
}

function pickCols(e) {
  const o = {};
  for (const c of EXPORT_COLS) o[c] = e[c] ?? "";
  return o;
}

// Excel sheet names: <=31 chars, no []:*?/\, and must be unique.
function uniqueSheetName(name, used) {
  const base = (name || "Sheet").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function download(filename, mime, data) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

init();
