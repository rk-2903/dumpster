// Bucket metadata lives in chrome.storage.local (small, and its onChanged event
// lets the background service worker rebuild the context menu when buckets
// change). Entry rows live in IndexedDB (see db.js) because they can grow large.

import { deleteEntriesByBucket } from "./db.js";

const BUCKETS_KEY = "buckets";
const LAST_KEY = "lastBucketId";

function get(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (r) => resolve(r[key])));
}

function set(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

export async function getBuckets() {
  const buckets = await get(BUCKETS_KEY);
  return Array.isArray(buckets) ? buckets : [];
}

/** Guarantee at least one bucket exists so the UI is never empty. */
export async function ensureSeeded() {
  const buckets = await getBuckets();
  if (buckets.length) return buckets;
  const seeded = [makeBucket("Job applications"), makeBucket("Read later")];
  await set({ [BUCKETS_KEY]: seeded, [LAST_KEY]: seeded[0].id });
  return seeded;
}

function makeBucket(name) {
  return { id: crypto.randomUUID(), name: name.trim(), createdAt: new Date().toISOString() };
}

export async function addBucket(name) {
  const buckets = await getBuckets();
  const bucket = makeBucket(name);
  await set({ [BUCKETS_KEY]: [...buckets, bucket] });
  return bucket;
}

export async function renameBucket(id, name) {
  const buckets = await getBuckets();
  await set({ [BUCKETS_KEY]: buckets.map((b) => (b.id === id ? { ...b, name: name.trim() } : b)) });
}

export async function deleteBucket(id) {
  const buckets = await getBuckets();
  const remaining = buckets.filter((b) => b.id !== id);
  await deleteEntriesByBucket(id);
  const patch = { [BUCKETS_KEY]: remaining };
  if ((await getLastBucketId()) === id) patch[LAST_KEY] = remaining[0]?.id || "";
  await set(patch);
}

export async function getLastBucketId() {
  const id = await get(LAST_KEY);
  const buckets = await getBuckets();
  if (id && buckets.some((b) => b.id === id)) return id;
  return buckets[0]?.id || "";
}

export function setLastBucketId(id) {
  return set({ [LAST_KEY]: id });
}

// Cross-context "a dump was added" ping. IndexedDB has no change event that
// reaches an already-open viewer tab, so writing an always-changing value to
// chrome.storage lets the viewer's storage.onChanged listener refresh live.
export function signalDump() {
  return set({ dumpSignal: Date.now() });
}
