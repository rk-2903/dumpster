// Sync orchestrator (drainer). Reads the outbox, resolves current state from
// IndexedDB, and pushes to the active cloud provider. Runs in the background
// worker. The core loop is a pure function (processOps) so it can be unit-tested
// without Google or IndexedDB.

import { readOutbox, removeOps } from "./outbox.js";
import { getEntry } from "./db.js";
import { getBuckets } from "./buckets.js";
import { getConnection, getToken } from "./googleAuth.js";
import { createSheetsProvider } from "./sheetsSync.js";

function providerFor(target, deps = {}) {
  if (target === "docs") return null; // DocsProvider — coming soon
  return createSheetsProvider({ getToken, ...deps }); // default: sheets
}

function getTarget() {
  return new Promise((r) => chrome.storage.local.get("syncTarget", (o) => r(o.syncTarget || "sheets")));
}
function setSyncState(state, error = "") {
  return new Promise((r) => chrome.storage.local.set({ syncState: state, syncError: error }, r));
}

/**
 * Process outbox ops against a provider, in order. Stops at the first failure and
 * leaves that op (and the rest) for the next retry. Returns the opIds that
 * succeeded so the caller can remove exactly those.
 *
 * deps: { provider, getEntry(id)->entry|undefined, nameById:Map<bucketId,name> }
 */
export async function processOps(ops, { provider, getEntry: getEntryFn, nameById }) {
  const done = [];
  let failed = false;
  let error = "";
  for (const op of ops) {
    try {
      if (op.kind === "upsert") {
        const entry = await getEntryFn(op.entryId);
        if (entry) {
          entry.bucketName = nameById.get(entry.bucketId) || "Bucket";
          await provider.upsertEntry(entry);
        }
        // entry gone (deleted before push) → nothing to do; treat as done
      } else if (op.kind === "delete") {
        await provider.deleteEntry(op.entryId, op.bucketId);
      } else if (op.kind === "bucketRename") {
        await provider.renameBucket(op.bucketId, op.name);
      } else if (op.kind === "bucketDelete") {
        await provider.deleteBucket(op.bucketId);
      }
      done.push(op.opId);
    } catch (err) {
      console.warn("[dumpster] sync op failed:", op.kind, err.message);
      failed = true;
      error = err.message;
      break; // preserve order; retry later
    }
  }
  return { done, failed, error };
}

let draining = false;

// Drain the outbox to the cloud. Safe to call often (re-entrancy guarded).
export async function drain() {
  if (draining) return;
  const conn = await getConnection();
  if (!conn.connected) return;
  const target = await getTarget();
  const provider = providerFor(target);
  if (!provider) return;

  draining = true;
  try {
    const ops = await readOutbox();
    if (!ops.length) {
      await setSyncState("synced");
      return;
    }
    await setSyncState("syncing");
    const buckets = await getBuckets();
    const nameById = new Map(buckets.map((b) => [b.id, b.name]));
    const { done, failed, error } = await processOps(ops, { provider, getEntry, nameById });
    await removeOps(done);
    await setSyncState(failed ? "error" : "synced", failed ? error : "");
  } catch (err) {
    console.warn("[dumpster] drain failed:", err.message);
    await setSyncState("error", err.message);
  } finally {
    draining = false;
  }
}
