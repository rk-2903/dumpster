// IndexedDB access layer for dumped entries.
// Shared by the popup, the viewer page, and the background service worker.
// Entries are append-only for dumps; only status/notes are editable later, and
// entries can be deleted individually or with their bucket.

const DB_NAME = "dumpster";
const DB_VERSION = 2; // v2 adds the images store (screenshot blobs keyed by entry id)
const STORE = "entries";
const IMAGES = "images";

let dbPromise = null;

// The three workflow states. New dumps default to the first (To Do).
export const STATUSES = ["To Do", "In Process", "Done"];
export const DEFAULT_STATUS = STATUSES[0];
// Columns for user-facing exports (Excel/JSON) — shared by workspace + panel.
export const EXPORT_COLS = ["createdAt", "key", "content", "sourceUrl", "sourceTitle", "status", "notes"];

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("bucketId", "bucketId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(IMAGES)) {
        db.createObjectStore(IMAGES); // key = entry id, value = PNG Blob
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, storeName = STORE) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Build a normalized entry. `content` is the thing the user dumped; the rest is
 * auto-captured context so a bare note still remembers where it came from.
 */
export function makeEntry({ bucketId, content, sourceUrl = "", sourceTitle = "" }) {
  return {
    id: crypto.randomUUID(),
    bucketId,
    content: (content || "").trim(),
    sourceUrl,
    sourceTitle,
    status: DEFAULT_STATUS,
    notes: "",
    createdAt: new Date().toISOString(),
  };
}

export async function addEntries(entries) {
  if (!entries.length) return;
  const store = await tx("readwrite");
  await Promise.all(entries.map((e) => reqToPromise(store.add(e))));
}

export function addEntry(entry) {
  return addEntries([entry]);
}

export async function getEntriesByBucket(bucketId) {
  const store = await tx("readonly");
  const index = store.index("bucketId");
  const rows = await reqToPromise(index.getAll(IDBKeyRange.only(bucketId)));
  // Newest first.
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getAllEntries() {
  const store = await tx("readonly");
  return reqToPromise(store.getAll());
}

export async function getEntry(id) {
  const store = await tx("readonly");
  return reqToPromise(store.get(id));
}

export async function countByBucket() {
  const store = await tx("readonly");
  const rows = await reqToPromise(store.getAll());
  const counts = {};
  for (const r of rows) counts[r.bucketId] = (counts[r.bucketId] || 0) + 1;
  return counts;
}

export async function updateEntry(id, patch) {
  const store = await tx("readwrite");
  const existing = await reqToPromise(store.get(id));
  if (!existing) return;
  await reqToPromise(store.put({ ...existing, ...patch, id }));
}

export async function deleteEntry(id) {
  const store = await tx("readwrite");
  await reqToPromise(store.delete(id));
  await deleteImage(id); // cascade: a deleted entry's screenshot goes with it
}

export async function deleteEntriesByBucket(bucketId) {
  const store = await tx("readwrite");
  const index = store.index("bucketId");
  const keys = await reqToPromise(index.getAllKeys(IDBKeyRange.only(bucketId)));
  await Promise.all(keys.map((k) => reqToPromise(store.delete(k))));
  await Promise.all(keys.map((k) => deleteImage(k)));
}

// ---- Screenshot blobs (images store; key = entry id) ----

export async function putImage(entryId, blob) {
  const store = await tx("readwrite", IMAGES);
  await reqToPromise(store.put(blob, entryId));
}

export async function getImage(entryId) {
  const store = await tx("readonly", IMAGES);
  return reqToPromise(store.get(entryId));
}

export async function deleteImage(entryId) {
  const store = await tx("readwrite", IMAGES);
  await reqToPromise(store.delete(entryId));
}
