// Per-bucket free-form markdown body for the side-panel doc editor.
//
// Local-first layer ON TOP of the entry model — it never replaces entries:
// selections/screenshots still create entries (and cloud-sync) exactly as
// before; each new entry is ALSO appended to the bucket's markdown body so it
// shows up in the editor/live preview, where the user can freely edit around
// it. Manual edits live only in the body for now (sync of the free-form body
// is a later phase).
//
// Storage: chrome.storage.local
//   docBody:<bucketId>   → markdown string
//   docCursor:<bucketId> → createdAt ISO of the newest entry already ingested

import { getEntriesByBucket } from "./db.js";

const bodyKey = (id) => `docBody:${id}`;
const cursorKey = (id) => `docCursor:${id}`;

const chromeStore = {
  get: (k) => new Promise((r) => chrome.storage.local.get(k, (o) => r(o[k]))),
  set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
};
let store = chromeStore;
let fetchEntries = getEntriesByBucket;

// Test hook.
export function __setDeps({ store: s, getEntriesByBucket: g } = {}) {
  if (s) store = s;
  if (g) fetchEntries = g;
}

export async function getBody(bucketId) {
  return (await store.get(bodyKey(bucketId))) || "";
}

export async function setBody(bucketId, text) {
  await store.set({ [bodyKey(bucketId)]: String(text ?? "") });
}

// Markdown block for one entry, mirroring how the Docs provider renders it:
// h1/h2 → headings, list → bullet, screenshots → image reference.
export function entryToMarkdown(entry) {
  if (entry.hasImage) return `![screenshot](dumpster:img:${entry.id})`;
  const text = String(entry.content || "").trim();
  if (!text) return "";
  switch (entry.format) {
    case "h1":
      return `# ${text}`;
    case "h2":
      return `## ${text}`;
    case "list":
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => `- ${l.trim()}`)
        .join("\n");
    default:
      return text;
  }
}

// Append entries newer than the stored cursor to the body (oldest first) so
// captures made from the page appear in the editor without overwriting manual
// edits. Returns true when the body changed.
export async function ingestNewEntries(bucketId) {
  const cursor = (await store.get(cursorKey(bucketId))) || "";
  const entries = (await fetchEntries(bucketId))
    .filter((e) => String(e.createdAt) > cursor)
    .sort((a, z) => (a.createdAt < z.createdAt ? -1 : 1));
  if (!entries.length) return false;

  let body = await getBody(bucketId);
  for (const e of entries) {
    const block = entryToMarkdown(e);
    if (!block) continue;
    body = body ? `${body.replace(/\n+$/, "")}\n\n${block}\n` : `${block}\n`;
  }
  await store.set({
    [bodyKey(bucketId)]: body,
    [cursorKey(bucketId)]: String(entries[entries.length - 1].createdAt),
  });
  return true;
}

// First open of a bucket in the editor: if it has no body yet, seed it from
// ALL existing entries so the editor starts as the full document rather than
// empty. Skips silently when a body already exists.
export async function seedIfEmpty(bucketId) {
  const existing = await getBody(bucketId);
  const cursor = await store.get(cursorKey(bucketId));
  if (existing || cursor) return false;
  return ingestNewEntries(bucketId);
}
