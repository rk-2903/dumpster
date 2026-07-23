// Durable, coalescing sync outbox in chrome.storage.local. Records *intent* — which
// entries changed or were deleted, and bucket rename/delete ops — so the background
// worker can push them to the active cloud provider, surviving MV3 worker restarts.
//
// Each op carries an opId so the drainer can remove exactly what it processed,
// without racing against new enqueues.

import { getConnection } from "./googleAuth.js";

const KEY = "outbox";

// Only queue ops while connected — otherwise the outbox would grow forever with
// nothing to drain. Data that predates a connection is handled by backfill-on-
// connect (see roadmap), not the outbox.
async function connected() {
  return (await getConnection()).connected;
}

function get() {
  return new Promise((r) => chrome.storage.local.get(KEY, (o) => r(o[KEY] || [])));
}
function set(ops) {
  return new Promise((r) => chrome.storage.local.set({ [KEY]: ops }, r));
}

function kick() {
  // Wake the background worker to drain. No receiver (e.g. worker asleep) is fine —
  // it also drains on its own alarm.
  try {
    chrome.runtime.sendMessage({ type: "dumpster-sync" }, () => void chrome.runtime.lastError);
  } catch {
    /* no-op */
  }
}

// An entry was added or edited. Coalesces: one pending upsert per entry, and it
// supersedes any pending delete for the same entry.
export async function enqueueUpsert(entryId) {
  if (!(await connected())) return;
  const ops = (await get()).filter((o) => !(o.entryId === entryId && (o.kind === "upsert" || o.kind === "delete")));
  ops.push({ opId: crypto.randomUUID(), kind: "upsert", entryId });
  await set(ops);
  kick();
}

// Bulk upsert (backfill on connect, or import) — one storage write for many ids.
export async function enqueueUpsertMany(entryIds) {
  if (!entryIds.length || !(await connected())) return;
  const wanted = new Set(entryIds);
  const ops = (await get()).filter((o) => !(wanted.has(o.entryId) && (o.kind === "upsert" || o.kind === "delete")));
  for (const id of wanted) ops.push({ opId: crypto.randomUUID(), kind: "upsert", entryId: id });
  await set(ops);
  kick();
}

// An entry was deleted. bucketId is kept because the entry is gone from IndexedDB
// and the provider still needs to know which sheet/tab to remove the row from.
export async function enqueueDelete(entryId, bucketId) {
  if (!(await connected())) return;
  const ops = (await get()).filter((o) => !(o.entryId === entryId && (o.kind === "upsert" || o.kind === "delete")));
  ops.push({ opId: crypto.randomUUID(), kind: "delete", entryId, bucketId });
  await set(ops);
  kick();
}

// A bucket was renamed or deleted. kind: "bucketRename" (with name) | "bucketDelete".
export async function enqueueBucketOp(kind, bucketId, name = "") {
  if (!(await connected())) return;
  const ops = await get();
  ops.push({ opId: crypto.randomUUID(), kind, bucketId, name });
  await set(ops);
  kick();
}

export function readOutbox() {
  return get();
}

// Remove exactly the ops the drainer finished (by opId), preserving anything
// enqueued meanwhile.
export async function removeOps(opIds) {
  if (!opIds.length) return;
  const drop = new Set(opIds);
  await set((await get()).filter((o) => !drop.has(o.opId)));
}
