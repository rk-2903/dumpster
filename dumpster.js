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
  countByBucket,
  updateEntry,
  deleteEntry,
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
  exportCsv: document.getElementById("export-csv"),
  exportJson: document.getElementById("export-json"),
  search: document.getElementById("search"),
};

let activeBucketId = null;
let rowIndex = []; // { tr, hay } for client-side filtering

async function init() {
  await ensureSeeded();
  activeBucketId = await getLastBucketId();
  await renderTabs();
  await renderBucket();

  els.rename.addEventListener("click", onRename);
  els.del.addEventListener("click", onDelete);
  els.exportCsv.addEventListener("click", () => exportActive("csv"));
  els.exportJson.addEventListener("click", () => exportActive("json"));
  els.search.addEventListener("input", applyFilter);

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
  content.appendChild(linkify(entry.content));

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
  const statusEl = makeEditable("input", entry.status, "＋ status", (val) =>
    updateEntry(entry.id, { status: val })
  );
  statusEl.classList.add("status-input");
  const applyTone = () => {
    statusEl.dataset.tone = statusTone(statusEl.value);
    // Size the pill to hug its text (placeholder when empty).
    statusEl.size = Math.max((statusEl.value || "＋ status").length + 2, 7);
  };
  applyTone();
  statusEl.addEventListener("input", applyTone);
  status.appendChild(statusEl);

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

// Infer a pill color from free-text status. Keeps status freeform (works for any
// bucket) while giving the job-tracker flow at-a-glance color.
function statusTone(value) {
  const s = (value || "").toLowerCase();
  if (!s) return "empty";
  // Match on stems (no trailing boundary) so "applied", "rejecting" etc. hit.
  if (/\b(appl|sent|done|accept|offer|complete|hired|submit|approv|got)/.test(s)) return "green";
  if (/\b(reject|declin|clos|ghost|lost|withdraw|drop|pass)/.test(s)) return "red";
  if (/\b(pending|wait|referr|follow|review|progress|need|todo|later|soon|schedul)/.test(s)) return "amber";
  return "blue";
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

async function exportActive(format) {
  const buckets = await getBuckets();
  const bucket = buckets.find((b) => b.id === activeBucketId);
  if (!bucket) return;
  const entries = await getEntriesByBucket(bucket.id);
  const safeName = bucket.name.replace(/[^\w.-]+/g, "_");

  if (format === "json") {
    download(
      `dumpster-${safeName}.json`,
      "application/json",
      JSON.stringify({ bucket: bucket.name, entries }, null, 2)
    );
  } else {
    const cols = ["createdAt", "content", "sourceUrl", "sourceTitle", "status", "notes"];
    const lines = [cols.join(",")];
    for (const e of entries) lines.push(cols.map((c) => csvCell(e[c])).join(","));
    download(`dumpster-${safeName}.csv`, "text/csv", lines.join("\n"));
  }
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
