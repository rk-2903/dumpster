// Sync orchestrator (drainer). Reads the outbox, resolves current state from
// IndexedDB, and pushes to the active cloud provider. Runs in the background
// worker. The core loop is a pure function (processOps) so it can be unit-tested
// without Google or IndexedDB.

import { readOutbox, removeOps } from "./outbox.js";
import { getEntry, getImage } from "./db.js";
import { getBuckets } from "./buckets.js";
import { getConnection, getToken } from "./googleAuth.js";
import { createSheetsProvider } from "./sheetsSync.js";
import { createDocsProvider } from "./docsSync.js";
import { blobDimensions } from "./capture.js";

// Fetch a screenshot blob + pixel dimensions for the Docs provider.
async function getImageInfo(entryId) {
  const blob = await getImage(entryId);
  if (!blob) return null;
  let dims = null;
  try {
    dims = await blobDimensions(blob); // needs createImageBitmap (present in SW)
  } catch {
    /* size fallback handled by the provider */
  }
  return { blob, width: dims?.width, height: dims?.height };
}

// Both providers are always live: sheet-kind buckets mirror to the spreadsheet,
// doc-kind buckets each mirror to their own Google Doc.
function makeProviders(deps = {}) {
  return {
    sheet: createSheetsProvider({ getToken, ...deps }),
    doc: createDocsProvider({ getToken, getImage: getImageInfo, ...deps }),
  };
}

function setSyncState(state, error = "") {
  return new Promise((r) => chrome.storage.local.set({ syncState: state, syncError: error }, r));
}

/**
 * Process outbox ops in order. Upserts route to the provider matching the
 * bucket's kind; deletes and bucket ops are offered to both providers — the one
 * that owns the bucket acts, the other no-ops (each checks its own map).
 * Stops at the first failure and leaves that op (and the rest) for retry.
 *
 * deps: { providers: {sheet, doc}, getEntry(id), nameById, kindById }
 */
export async function processOps(ops, { providers, getEntry: getEntryFn, nameById, kindById }) {
  const done = [];
  let failed = false;
  let error = "";
  const both = [providers.sheet, providers.doc];
  for (const op of ops) {
    try {
      if (op.kind === "upsert") {
        const entry = await getEntryFn(op.entryId);
        if (entry) {
          entry.bucketName = nameById.get(entry.bucketId) || "Bucket";
          const kind = kindById.get(entry.bucketId) === "doc" ? "doc" : "sheet";
          await providers[kind].upsertEntry(entry);
        }
        // entry gone (deleted before push) → nothing to do; treat as done
      } else if (op.kind === "delete") {
        for (const p of both) await p.deleteEntry(op.entryId, op.bucketId);
      } else if (op.kind === "bucketRename") {
        for (const p of both) await p.renameBucket(op.bucketId, op.name);
      } else if (op.kind === "bucketDelete") {
        for (const p of both) await p.deleteBucket(op.bucketId);
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
  const providers = makeProviders();

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
    const kindById = new Map(buckets.map((b) => [b.id, b.kind]));
    const { done, failed, error } = await processOps(ops, { providers, getEntry, nameById, kindById });
    await removeOps(done);
    await setSyncState(failed ? "error" : "synced", failed ? error : "");
  } catch (err) {
    console.warn("[dumpster] drain failed:", err.message);
    await setSyncState("error", err.message);
  } finally {
    draining = false;
  }
}
