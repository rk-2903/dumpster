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
  addEntries,
  countByBucket,
  updateEntry,
  deleteEntry,
  getImage,
  STATUSES,
  DEFAULT_STATUS,
  EXPORT_COLS,
} from "./src/db.js";
import {
  enqueueUpsert,
  enqueueUpsertMany,
  enqueueDelete,
  enqueueBucketOp,
} from "./src/outbox.js";
import { connect as gConnect, disconnect as gDisconnect, getConnection } from "./src/googleAuth.js";
import { track, pingActive, flush } from "./src/telemetry.js";

const els = {
  bucketOpenLink: document.getElementById("bucket-open-link"),
  sheetTabs: document.getElementById("sheet-tabs"),
  docTabs: document.getElementById("doc-tabs"),
  addSheet: document.getElementById("add-sheet"),
  addDoc: document.getElementById("add-doc"),
  bucketName: document.getElementById("bucket-name"),
  entryCount: document.getElementById("entry-count"),
  rows: document.getElementById("rows"),
  table: document.getElementById("entries"),
  empty: document.getElementById("empty"),
  rename: document.getElementById("rename-bucket"),
  del: document.getElementById("delete-bucket"),
  search: document.getElementById("search"),
  viewToggle: document.getElementById("view-toggle"),
  listView: document.getElementById("list-view"),
  board: document.getElementById("board-view"),
  docView: document.getElementById("doc-view"),
  // Export modal
  exportOpen: document.getElementById("export-open"),
  exportModal: document.getElementById("export-modal"),
  exportFormat: document.getElementById("export-format"),
  formatHint: document.getElementById("format-hint"),
  exportAll: document.getElementById("export-all"),
  exportBuckets: document.getElementById("export-buckets"),
  exportCancel: document.getElementById("export-cancel"),
  exportGo: document.getElementById("export-go"),
  // Import
  importOpen: document.getElementById("import-open"),
  importFile: document.getElementById("import-file"),
  toast: document.getElementById("toast"),
  // Cloud sync
  cloudOpen: document.getElementById("cloud-open"),
  cloudDot: document.getElementById("cloud-dot"),
  cloudModal: document.getElementById("cloud-modal"),
  cloudDisconnected: document.getElementById("cloud-disconnected"),
  cloudConnected: document.getElementById("cloud-connected"),
  cloudEmail: document.getElementById("cloud-email"),
  cloudStatusDot: document.getElementById("cloud-status-dot"),
  cloudStatusText: document.getElementById("cloud-status-text"),
  cloudLinks: document.getElementById("cloud-links"),
  cloudCancel: document.getElementById("cloud-cancel"),
  cloudConnect: document.getElementById("cloud-connect"),
  cloudDisconnect: document.getElementById("cloud-disconnect"),
  cloudDone: document.getElementById("cloud-done"),
};

let activeBucketId = null;
let activeBucketKind = "sheet"; // doc buckets have no status/board
let currentEntries = []; // entries for the active bucket (unfiltered)
let currentView = "list"; // "list" | "board" | "document"
// Remembered view per bucket kind (doc buckets default to the Document preview).
let viewPref = { sheet: "list", doc: "document" };
const VIEW_LABELS = { document: "Document", list: "List", board: "Board" };
const kindViews = (kind) => (kind === "doc" ? ["document", "list"] : ["list", "board"]);

async function init() {
  await ensureSeeded();
  pingActive(); // opening the workspace counts as active-today
  flush();
  await migrateStatuses();
  const savedPref = await getSetting("viewPref");
  if (savedPref) viewPref = { ...viewPref, ...savedPref };
  activeBucketId = await getLastBucketId();
  await renderTabs();
  await renderBucket();

  els.rename.addEventListener("click", onRename);
  els.del.addEventListener("click", onDelete);
  els.addSheet.addEventListener("click", () => onNewBucket("sheet"));
  els.addDoc.addEventListener("click", () => onNewBucket("doc"));
  els.search.addEventListener("input", renderView);
  els.viewToggle.addEventListener("click", onToggleView);
  wireExportModal();
  wireImport();
  wireCloudModal();
  updateCloudChip();

  // Live-refresh when another context changes data: a bucket add/rename/delete
  // (changes.buckets) or a dump from the popup / context menu (changes.dumpSignal,
  // which the entry write can't announce on its own — IndexedDB has no
  // cross-tab change event). Cloud state changes update the sync chip/modal.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.dumpSignal) {
      renderTabs();
      renderBucket();
    } else if (changes.buckets) {
      renderTabs();
    }
    if (changes.syncState || changes.gconnection) {
      updateCloudChip();
      if (!els.cloudModal.hidden) refreshCloudModal();
    }
  });
  // Fallback: a frozen/discarded tab may miss the event; re-fetch on refocus.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      renderTabs();
      renderBucket();
    }
  });
}

// Two rows: Sheet buckets, then Doc buckets. Each row scrolls horizontally
// with its own pinned ＋ button (wired once in init).
async function renderTabs() {
  const buckets = await getBuckets();
  const counts = await countByBucket();
  if (!buckets.some((b) => b.id === activeBucketId)) {
    activeBucketId = buckets[0]?.id || null;
  }
  const rows = [
    { el: els.sheetTabs, kind: "sheet" },
    { el: els.docTabs, kind: "doc" },
  ];
  for (const row of rows) {
    row.el.innerHTML = "";
    for (const b of buckets.filter((x) => x.kind === row.kind)) {
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
      row.el.appendChild(tab);
    }
    if (!row.el.children.length) {
      const hint = document.createElement("span");
      hint.className = "tab-row-empty";
      hint.textContent = row.kind === "doc" ? "No Doc buckets yet" : "No Sheet buckets yet";
      row.el.appendChild(hint);
    }
  }
  // Keep the active tab visible in its scroll row.
  document.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

async function renderBucket() {
  const buckets = await getBuckets();
  const bucket = buckets.find((b) => b.id === activeBucketId);
  els.bucketName.textContent = bucket ? bucket.name : "—";
  activeBucketKind = bucket?.kind === "doc" ? "doc" : "sheet";
  await renderBucketOpenLink(bucket);
  els.table.classList.toggle("no-status", activeBucketKind === "doc");
  els.table.classList.toggle("no-key", activeBucketKind === "doc");
  // Doc buckets: Document | List. Sheet buckets: List | Board.
  const views = kindViews(activeBucketKind);
  currentView = views.includes(viewPref[activeBucketKind]) ? viewPref[activeBucketKind] : views[0];
  renderViewToggle(activeBucketKind);
  els.viewToggle.hidden = false;
  currentEntries = bucket ? await getEntriesByBucket(bucket.id) : [];
  renderView();
}

function renderViewToggle(kind) {
  els.viewToggle.innerHTML = "";
  for (const v of kindViews(kind)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "seg" + (v === currentView ? " active" : "");
    btn.dataset.view = v;
    btn.textContent = VIEW_LABELS[v];
    els.viewToggle.appendChild(btn);
  }
}

// "Open doc ↗" / "Open sheet ↗" next to the bucket heading — links straight to
// this bucket's synced Google Doc, or its exact spreadsheet tab (#gid). Hidden
// until the bucket has actually synced (its file/tab exists).
async function renderBucketOpenLink(bucket) {
  const link = els.bucketOpenLink;
  link.hidden = true;
  if (!bucket) return;
  if (bucket.kind === "doc") {
    const map = (await getSetting("docsDocMap")) || {};
    const d = map[bucket.id];
    if (d) {
      link.href = `https://docs.google.com/document/d/${d.docId}/edit`;
      link.textContent = "Open doc ↗";
      link.title = "Open this bucket's Google Doc";
      link.hidden = false;
    }
  } else {
    const sid = await getSetting("sheetsSpreadsheetId");
    const tab = ((await getSetting("sheetsTabMap")) || {})[bucket.id];
    if (sid && tab) {
      link.href = `https://docs.google.com/spreadsheets/d/${sid}/edit#gid=${tab.sheetId}`;
      link.textContent = "Open sheet ↗";
      link.title = "Open this bucket's tab in the Google Sheet";
      link.hidden = false;
    }
  }
}

// Entries matching the current search box.
function visibleEntries() {
  const q = els.search.value.trim().toLowerCase();
  if (!q) return currentEntries;
  return currentEntries.filter((e) =>
    [e.key || "", e.content, e.sourceTitle, e.sourceUrl, e.status, e.notes, e.ocrText || ""]
      .join(" ")
      .toLowerCase()
      .includes(q)
  );
}

function updateCount(shown) {
  const total = currentEntries.length;
  const q = els.search.value.trim();
  els.entryCount.textContent = !total
    ? ""
    : q
    ? `${shown} of ${total}`
    : `${total} ${total === 1 ? "entry" : "entries"}`;
}

// Render whichever view is active from the in-memory entries.
function renderView() {
  const entries = visibleEntries();
  updateCount(entries.length);
  els.listView.hidden = currentView !== "list";
  els.board.hidden = currentView !== "board";
  els.docView.hidden = currentView !== "document";
  if (currentView === "board") renderBoard(entries);
  else if (currentView === "document") renderDocument(entries);
  else renderList(entries);
}

// ---- Document view (read-only rendered preview of the Doc bucket) ----

function formatDocDate(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "Undated"
    : d.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

function docContentInto(container, entry) {
  if (entry.hasImage) {
    const img = document.createElement("img");
    img.className = "doc-img";
    img.alt = "Screenshot";
    img.title = "Click to view full size";
    getImage(entry.id).then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      thumbUrls.add(url);
      img.src = url;
    });
    img.addEventListener("click", () => openLightbox(entry.id));
    container.appendChild(img);
  }
  container.appendChild(linkify(entry.content));
}

function uniqueRefs(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = (e.sourceUrl || e.sourceTitle || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ url: e.sourceUrl || "", title: e.sourceTitle || "" });
  }
  return out;
}

function renderDocument(entries) {
  revokeThumbs();
  els.docView.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "Nothing here yet. Dump text or screenshots into this Doc bucket.";
    els.docView.appendChild(empty);
    return;
  }

  const ordered = [...entries].sort((a, z) => (a.createdAt < z.createdAt ? -1 : 1));
  const article = document.createElement("article");
  article.className = "doc-article";

  let lastDate = null;
  let listEl = null; // open <ul> collecting consecutive list items
  for (const entry of ordered) {
    const date = formatDocDate(entry.createdAt);
    if (date !== lastDate) {
      lastDate = date;
      listEl = null;
      const h = document.createElement("div");
      h.className = "doc-date";
      h.textContent = date;
      article.appendChild(h);
    }

    if (entry.format === "list") {
      if (!listEl) {
        listEl = document.createElement("ul");
        listEl.className = "doc-list";
        article.appendChild(listEl);
      }
      const li = document.createElement("li");
      docContentInto(li, entry);
      if (entry.notes) {
        const n = document.createElement("span");
        n.className = "doc-notes";
        n.textContent = `  ${entry.notes}`;
        li.appendChild(n);
      }
      listEl.appendChild(li);
      continue;
    }

    listEl = null;
    const tag = entry.format === "h1" ? "h1" : entry.format === "h2" ? "h2" : "p";
    const node = document.createElement(tag);
    node.className = "doc-block";
    docContentInto(node, entry);
    article.appendChild(node);
    if (entry.notes) {
      const n = document.createElement("p");
      n.className = "doc-notes";
      n.textContent = entry.notes;
      article.appendChild(n);
    }
  }

  const refs = uniqueRefs(ordered);
  if (refs.length) {
    const h = document.createElement("div");
    h.className = "doc-date doc-refs-head";
    h.textContent = "References";
    article.appendChild(h);
    const ul = document.createElement("ul");
    ul.className = "doc-refs";
    for (const ref of refs) {
      const li = document.createElement("li");
      if (ref.url) {
        const a = document.createElement("a");
        a.href = ref.url;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = ref.title || ref.url;
        li.appendChild(a);
      } else {
        li.textContent = ref.title;
      }
      ul.appendChild(li);
    }
    article.appendChild(ul);
  }
  els.docView.appendChild(article);
}

function renderList(entries) {
  revokeThumbs();
  els.rows.innerHTML = "";
  els.table.hidden = entries.length === 0;
  els.empty.hidden = entries.length !== 0;
  for (const entry of entries) els.rows.appendChild(renderRow(entry));
}

// ---- Board (Kanban) view ----

function renderBoard(entries) {
  els.board.innerHTML = "";
  for (const status of STATUSES) {
    const col = document.createElement("div");
    col.className = "board-col";
    col.dataset.status = status;
    col.dataset.tone = statusTone(status);

    const items = entries.filter(
      (e) => (STATUSES.includes(e.status) ? e.status : DEFAULT_STATUS) === status
    );

    const head = document.createElement("div");
    head.className = "board-col-head";
    const title = document.createElement("span");
    title.className = "board-col-title";
    title.textContent = status;
    const count = document.createElement("span");
    count.className = "board-col-count";
    count.textContent = items.length;
    head.append(title, count);
    col.appendChild(head);

    const list = document.createElement("div");
    list.className = "board-col-list";
    for (const entry of items) list.appendChild(renderCard(entry));
    col.appendChild(list);

    wireDropTarget(col, status);
    els.board.appendChild(col);
  }
}

function renderCard(entry) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.id = entry.id;

  if (entry.key) {
    const k = document.createElement("div");
    k.className = "card-key";
    k.textContent = entry.key;
    k.title = entry.key;
    card.appendChild(k);
  }
  const body = document.createElement("div");
  body.className = "card-content";
  body.appendChild(linkify(entry.content));
  card.appendChild(body);

  if (entry.sourceUrl) {
    const a = document.createElement("a");
    a.className = "card-source";
    a.href = entry.sourceUrl;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = entry.sourceTitle || entry.sourceUrl;
    a.title = entry.sourceUrl;
    card.appendChild(a);
  }
  if (entry.notes) {
    const n = document.createElement("div");
    n.className = "card-notes";
    n.textContent = entry.notes;
    card.appendChild(n);
  }

  const foot = document.createElement("div");
  foot.className = "card-foot";
  const time = document.createElement("span");
  time.textContent = formatTime(entry.createdAt);
  time.title = new Date(entry.createdAt).toLocaleString();
  const del = document.createElement("button");
  del.className = "row-delete";
  del.textContent = "✕";
  del.title = "Delete this entry";
  del.addEventListener("click", async () => {
    await deleteEntry(entry.id);
    enqueueDelete(entry.id, entry.bucketId);
    currentEntries = currentEntries.filter((e) => e.id !== entry.id);
    renderTabs();
    renderView();
  });
  foot.append(time, del);
  card.appendChild(foot);

  card.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    e.dataTransfer.setData("text/plain", entry.id);
    e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  return card;
}

function wireDropTarget(col, status) {
  col.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    col.classList.add("drop-over");
  });
  col.addEventListener("dragleave", (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove("drop-over");
  });
  col.addEventListener("drop", async (e) => {
    e.preventDefault();
    col.classList.remove("drop-over");
    const id = e.dataTransfer.getData("text/plain");
    const entry = currentEntries.find((x) => x.id === id);
    if (!entry || entry.status === status) return;
    entry.status = status;
    await updateEntry(id, { status });
    enqueueUpsert(id);
    track("feature", { name: "board-move" });
    renderView(); // re-render board so cards + counts move
  });
}

function onToggleView(e) {
  const btn = e.target.closest(".seg");
  if (!btn || btn.dataset.view === currentView) return;
  currentView = btn.dataset.view;
  viewPref[activeBucketKind] = currentView;
  setSetting("viewPref", viewPref);
  renderViewToggle(activeBucketKind);
  renderView();
}

function getSetting(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (r) => resolve(r[key])));
}
function setSetting(key, value) {
  chrome.storage.local.set({ [key]: value });
}

function renderRow(entry) {
  const tr = document.createElement("tr");

  const time = document.createElement("td");
  time.className = "cell-time";
  time.textContent = formatTime(entry.createdAt);
  time.title = new Date(entry.createdAt).toLocaleString();

  const key = document.createElement("td");
  key.className = "cell-key";
  key.appendChild(
    makeEditable("input", entry.key || "", "Key…", async (val) => {
      await updateEntry(entry.id, { key: val });
      enqueueUpsert(entry.id);
    })
  );

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
  status.className = "cell-status";
  status.appendChild(renderStatusSelect(entry));

  const notes = document.createElement("td");
  notes.appendChild(
    makeEditable("textarea", entry.notes, "Add a note…", async (val) => {
      await updateEntry(entry.id, { notes: val });
      enqueueUpsert(entry.id);
    })
  );

  const actions = document.createElement("td");
  const del = document.createElement("button");
  del.className = "row-delete";
  del.textContent = "✕";
  del.title = "Delete this entry";
  del.addEventListener("click", async () => {
    await deleteEntry(entry.id);
    enqueueDelete(entry.id, entry.bucketId);
    tr.remove();
    renderTabs();
    renderBucket();
  });
  actions.appendChild(del);

  tr.append(time, key, content, source, status, notes, actions);
  return tr;
}

// Object URLs for row thumbnails, revoked whenever the list re-renders.
const thumbUrls = new Set();
function revokeThumbs() {
  for (const u of thumbUrls) URL.revokeObjectURL(u);
  thumbUrls.clear();
}

// The dumped text: linkified read-only view, double-click to edit inline.
// Entries with a screenshot get a clickable thumbnail above the text.
function renderContentView(td, entry) {
  td.textContent = "";
  td.title = "Double-click to edit";
  if (entry.hasImage) {
    const img = document.createElement("img");
    img.className = "cell-thumb";
    img.alt = "Screenshot";
    img.title = "Click to view full size";
    getImage(entry.id).then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      thumbUrls.add(url);
      img.src = url;
    });
    img.addEventListener("click", () => openLightbox(entry.id));
    td.appendChild(img);
  }
  td.appendChild(linkify(entry.content));
  td.ondblclick = (e) => {
    // Don't hijack a click meant for a link or the thumbnail.
    if (e.target.tagName === "A" || e.target.tagName === "IMG") return;
    editContent(td, entry);
  };
}

// Full-size screenshot overlay; click anywhere or Esc closes.
async function openLightbox(entryId) {
  const blob = await getImage(entryId);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const backdrop = document.createElement("div");
  backdrop.className = "lightbox";
  const img = document.createElement("img");
  img.src = url;
  img.alt = "Screenshot";
  backdrop.appendChild(img);
  const close = () => {
    URL.revokeObjectURL(url);
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
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
      enqueueUpsert(entry.id);
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
  sel.addEventListener("change", async () => {
    entry.status = sel.value;
    sel.dataset.tone = statusTone(sel.value);
    await updateEntry(entry.id, { status: sel.value });
    enqueueUpsert(entry.id);
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

async function onNewBucket(kind) {
  const label = kind === "doc" ? "Doc" : "Sheet";
  const name = prompt(`Name your new ${label} bucket:`);
  if (!name || !name.trim()) return;
  const bucket = await addBucket(name.trim(), kind);
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
  enqueueBucketOp("bucketRename", bucket.id, name.trim());
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
  enqueueBucketOp("bucketDelete", bucket.id);
  activeBucketId = null;
  await renderTabs();
  await renderBucket();
}

// ---- Export ---------------------------------------------------------------

// EXPORT_COLS is shared with the panel exports — see src/db.js.
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
  // The bucket being viewed is listed first and pre-selected.
  buckets.sort((a, b) => (a.id === activeBucketId ? -1 : b.id === activeBucketId ? 1 : 0));
  els.exportBuckets.innerHTML = "";
  for (const b of buckets) {
    const label = document.createElement("label");
    label.className = "check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = b.id;
    cb.checked = b.id === activeBucketId;
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
// No indeterminate dash — All reads checked only when everything is selected.
function refreshExportState() {
  const boxes = [...els.exportBuckets.querySelectorAll("input")];
  const checked = boxes.filter((b) => b.checked).length;
  els.exportAll.checked = checked > 0 && checked === boxes.length;
  els.exportAll.indeterminate = false;
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
  track("feature", { name: exportFormat === "json" ? "export-json" : "export-xlsx" });
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

// ---- Import ----------------------------------------------------------------

function wireImport() {
  els.importOpen.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", async () => {
    const file = els.importFile.files[0];
    els.importFile.value = ""; // allow re-picking the same file
    if (file) await handleImport(file);
  });
}

async function handleImport(file) {
  try {
    const isJson = /\.json$/i.test(file.name);
    const byBucket = isJson ? parseJsonImport(await file.text()) : await parseXlsxImport(file);
    const result = await mergeImport(byBucket);
    await renderTabs();
    await renderBucket();
    showToast(
      `Imported ${result.added} ${result.added === 1 ? "dump" : "dumps"}` +
        (result.skipped ? `, skipped ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"}` : "")
    );
  } catch (err) {
    console.error(err);
    showToast(`Import failed: ${err.message || "unreadable file"}`, true);
  }
}

// Our JSON export is { "Bucket name": [ {cols...} ] }. Return that map of rows.
function parseJsonImport(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("expected a { bucket: [dumps] } object");
  }
  const out = {};
  for (const [name, rows] of Object.entries(data)) {
    if (Array.isArray(rows)) out[name] = rows;
  }
  return out;
}

// Each xlsx sheet is a bucket; rows come from the header row.
async function parseXlsxImport(file) {
  const XLSX = await import("./vendor/xlsx.mjs"); // lazy
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
  const out = {};
  for (const name of wb.SheetNames) {
    out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "", raw: false });
  }
  return out;
}

// Append rows into name-matched buckets (creating missing ones), skipping any
// row that already exists (same content + timestamp).
async function mergeImport(byBucket) {
  let added = 0;
  let skipped = 0;
  const addedIds = [];
  const buckets = await getBuckets();
  const byName = new Map(buckets.map((b) => [b.name.toLowerCase(), b]));

  for (const [rawName, rows] of Object.entries(byBucket)) {
    const name = String(rawName).trim();
    if (!name || !rows.length) continue;

    let bucket = byName.get(name.toLowerCase());
    if (!bucket) {
      bucket = await addBucket(name);
      byName.set(name.toLowerCase(), bucket);
    }

    const seen = new Set((await getEntriesByBucket(bucket.id)).map(dedupeKey));
    const toAdd = [];
    for (const row of rows) {
      const entry = entryFromImport(bucket.id, row);
      if (!entry.content) continue; // skip empty
      const key = dedupeKey(entry);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      toAdd.push(entry);
    }
    await addEntries(toAdd);
    added += toAdd.length;
    for (const e of toAdd) addedIds.push(e.id);
  }
  await enqueueUpsertMany(addedIds); // sync imported dumps to the cloud
  return { added, skipped };
}

function dedupeKey(e) {
  return `${(e.key || "").trim()} ${(e.content || "").trim()} ${e.createdAt || ""}`;
}

function entryFromImport(bucketId, row) {
  const createdAt = toIso(row.createdAt);
  const entry = {
    id: crypto.randomUUID(),
    bucketId,
    content: String(row.content ?? "").trim(),
    sourceUrl: String(row.sourceUrl ?? ""),
    sourceTitle: String(row.sourceTitle ?? ""),
    status: STATUSES.includes(row.status) ? row.status : DEFAULT_STATUS,
    notes: String(row.notes ?? ""),
    createdAt,
  };
  const key = String(row.key ?? "").trim();
  if (key) entry.key = key;
  return entry;
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// ---- Cloud sync UI --------------------------------------------------------

const SYNC_LABEL = { syncing: "Syncing…", synced: "Synced", error: "Sync error", idle: "Idle" };

function wireCloudModal() {
  els.cloudOpen.addEventListener("click", openCloudModal);
  els.cloudCancel.addEventListener("click", closeCloudModal);
  els.cloudDone.addEventListener("click", closeCloudModal);
  els.cloudModal.addEventListener("click", (e) => {
    if (e.target === els.cloudModal) closeCloudModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.cloudModal.hidden) closeCloudModal();
  });
  els.cloudConnect.addEventListener("click", onConnect);
  els.cloudDisconnect.addEventListener("click", onDisconnect);
}

async function openCloudModal() {
  await refreshCloudModal();
  els.cloudModal.hidden = false;
}
function closeCloudModal() {
  els.cloudModal.hidden = true;
}

async function refreshCloudModal() {
  const conn = await getConnection();
  els.cloudDisconnected.hidden = conn.connected;
  els.cloudConnected.hidden = !conn.connected;
  if (!conn.connected) return;
  els.cloudEmail.textContent = conn.email || "your account";
  const state = (await getSetting("syncState")) || "idle";
  let label = SYNC_LABEL[state] || "Idle";
  if (state === "error") {
    const detail = await getSetting("syncError");
    if (detail) label = `Sync error — ${detail}`;
  }
  els.cloudStatusText.textContent = label;
  els.cloudStatusDot.dataset.state = state;
  await renderCloudLinks();
}

// Links to everything synced: the spreadsheet, plus a collapsible list of each
// Doc bucket's doc. Only doc-kind buckets are listed — docsDocMap may hold
// stale entries for buckets that predate typed buckets (or were retyped).
//
// The modal re-renders on storage changes while it's open, so renders can
// overlap. Gather all data BEFORE touching the DOM, and let only the newest
// render write — otherwise two interleaved passes each append their links and
// every section shows up twice.
let cloudLinksRender = 0;
async function renderCloudLinks() {
  const token = ++cloudLinksRender;
  const sid = await getSetting("sheetsSpreadsheetId");
  const map = (await getSetting("docsDocMap")) || {};
  const buckets = await getBuckets();
  if (token !== cloudLinksRender) return; // superseded by a newer render

  els.cloudLinks.innerHTML = "";
  const mkLink = (href, text, parent) => {
    const a = document.createElement("a");
    a.className = "cloud-sheet-link";
    a.target = "_blank";
    a.rel = "noreferrer";
    a.href = href;
    a.textContent = text;
    parent.appendChild(a);
  };

  if (sid) mkLink(`https://docs.google.com/spreadsheets/d/${sid}/edit`, "Open Google Sheet ↗", els.cloudLinks);

  const docBuckets = buckets.filter((b) => b.kind === "doc" && map[b.id]);

  if (docBuckets.length) {
    const details = document.createElement("details");
    details.className = "cloud-docs";
    const summary = document.createElement("summary");
    summary.innerHTML = `Doc links <span class="badge">${docBuckets.length}</span>`;
    details.appendChild(summary);
    const list = document.createElement("div");
    list.className = "cloud-docs-list";
    for (const b of docBuckets) {
      mkLink(`https://docs.google.com/document/d/${map[b.id].docId}/edit`, `Open “${b.name}” doc ↗`, list);
    }
    details.appendChild(list);
    els.cloudLinks.appendChild(details);
  }

  if (!els.cloudLinks.children.length) {
    const span = document.createElement("span");
    span.className = "cloud-links-empty";
    span.textContent = "Files are created in your Drive as dumps sync.";
    els.cloudLinks.appendChild(span);
  }
}

// Queue every entry, oldest first so the Docs provider's date grouping and the
// Sheet's row order both come out chronological.
async function backfillAll() {
  const all = await getAllEntries();
  all.sort((a, z) => (a.createdAt < z.createdAt ? -1 : 1));
  await enqueueUpsertMany(all.map((e) => e.id));
}

async function onConnect() {
  const label = document.getElementById("cloud-connect-label");
  els.cloudConnect.disabled = true;
  label.textContent = "Connecting…";
  try {
    await gConnect(); // interactive OAuth via chrome.identity
    track("feature", { name: "connect" });
    // Backfill: queue all existing dumps so current data lands in the target.
    await backfillAll();
    await refreshCloudModal();
    updateCloudChip();
    showToast("Connected — syncing your dumps ✓");
  } catch (err) {
    showToast(`Google connect failed: ${err.message || "cancelled"}`, true);
  } finally {
    els.cloudConnect.disabled = false;
    label.textContent = "Connect Google";
  }
}

async function onDisconnect() {
  await gDisconnect();
  await refreshCloudModal();
  updateCloudChip();
  showToast("Disconnected from Google");
}

async function updateCloudChip() {
  const conn = await getConnection();
  const state = conn.connected ? (await getSetting("syncState")) || "idle" : "off";
  els.cloudDot.dataset.state = state;
  els.cloudOpen.title = conn.connected
    ? `Cloud sync: ${SYNC_LABEL[state] || "connected"}`
    : "Cloud sync: not connected";
}

let toastTimer = null;
function showToast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("toast-error", isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3200);
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

init().then(() => {
  // Deep link from the side panel's cloud chip: open the Cloud dialog directly.
  if (location.hash === "#cloud") {
    history.replaceState(null, "", location.pathname); // don't re-open on reload
    openCloudModal();
  }
});
