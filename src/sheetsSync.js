// Google Sheets sync provider. Mirrors the local data into one spreadsheet:
// a tab per bucket, a row per dump, keyed by the entry id in column A (so later
// edits/deletes can locate the row). Implements the provider interface used by
// the background drainer.
//
// Dependencies (getToken, fetch, store) are injected so the logic is unit-testable
// without a real Google account.

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

// Column order in each tab. id is first so a row can be found by entry id.
export const ROW_COLS = ["id", "createdAt", "content", "sourceUrl", "sourceTitle", "status", "notes"];

const chromeStore = {
  get: (key) => new Promise((r) => chrome.storage.local.get(key, (o) => r(o[key]))),
  set: (key, value) => new Promise((r) => chrome.storage.local.set({ [key]: value }, r)),
};

export function createSheetsProvider({ getToken, fetchImpl = globalThis.fetch, store = chromeStore } = {}) {
  const SPREADSHEET_KEY = "sheetsSpreadsheetId";
  const TABMAP_KEY = "sheetsTabMap"; // { [bucketId]: { sheetId, title } }

  async function api(method, url, body) {
    const token = await getToken(false); // silent token for background sync
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Sheets ${method} ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  const quote = (title) => `'${String(title).replace(/'/g, "''")}'`;
  const encRange = (title, a1) => encodeURIComponent(`${quote(title)}!${a1}`);
  const rowFromEntry = (e) => ROW_COLS.map((c) => e[c] ?? "");

  // Create the spreadsheet on first use; store its id.
  async function ensureSpreadsheet() {
    let id = await store.get(SPREADSHEET_KEY);
    if (id) return id;
    const created = await api("POST", BASE, { properties: { title: "Dumpster" } });
    id = created.spreadsheetId;
    await store.set(SPREADSHEET_KEY, id);
    return id;
  }

  async function getTabMap() {
    return (await store.get(TABMAP_KEY)) || {};
  }

  // Excel/Sheets tab titles must be unique and <=31 chars with no []:*?/\.
  function uniqueTitle(name, taken) {
    const base = String(name || "Sheet").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
    let candidate = base;
    let n = 2;
    while (taken.has(candidate.toLowerCase())) {
      const suffix = ` (${n++})`;
      candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    return candidate;
  }

  // Ensure a tab exists for the bucket; create it (with a header row) if missing.
  async function ensureBucketTab(bucketId, bucketName) {
    const spreadsheetId = await ensureSpreadsheet();
    const map = await getTabMap();
    if (map[bucketId]) return map[bucketId];

    const meta = await api("GET", `${BASE}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`);
    const titles = new Set((meta.sheets || []).map((s) => s.properties.title.toLowerCase()));
    const title = uniqueTitle(bucketName, titles);

    const res = await api("POST", `${BASE}/${spreadsheetId}:batchUpdate`, {
      requests: [{ addSheet: { properties: { title } } }],
    });
    const sheetId = res.replies[0].addSheet.properties.sheetId;
    await api("PUT", `${BASE}/${spreadsheetId}/values/${encRange(title, "A1:G1")}?valueInputOption=RAW`, {
      values: [ROW_COLS],
    });

    map[bucketId] = { sheetId, title };
    await store.set(TABMAP_KEY, map);
    return map[bucketId];
  }

  // 1-based row of the entry id in column A, or 0 if absent (row 1 = header).
  async function findRow(spreadsheetId, title, entryId) {
    const data = await api("GET", `${BASE}/${spreadsheetId}/values/${encRange(title, "A:A")}`);
    const rows = data.values || [];
    for (let i = 1; i < rows.length; i++) if (rows[i][0] === entryId) return i + 1;
    return 0;
  }

  // Insert or update the row for an entry.
  async function upsertEntry(entry) {
    const spreadsheetId = await ensureSpreadsheet();
    const tab = await ensureBucketTab(entry.bucketId, entry.bucketName || "Bucket");
    const row = rowFromEntry(entry);
    const at = await findRow(spreadsheetId, tab.title, entry.id);
    if (at) {
      await api("PUT", `${BASE}/${spreadsheetId}/values/${encRange(tab.title, `A${at}:G${at}`)}?valueInputOption=RAW`, {
        values: [row],
      });
    } else {
      await api(
        "POST",
        `${BASE}/${spreadsheetId}/values/${encRange(tab.title, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { values: [row] }
      );
    }
  }

  // Remove an entry's row (best-effort — no-op if the tab/row is gone).
  async function deleteEntry(entryId, bucketId) {
    const spreadsheetId = await store.get(SPREADSHEET_KEY);
    const map = await getTabMap();
    const tab = map[bucketId];
    if (!spreadsheetId || !tab) return;
    const at = await findRow(spreadsheetId, tab.title, entryId);
    if (!at) return;
    await api("POST", `${BASE}/${spreadsheetId}:batchUpdate`, {
      requests: [
        { deleteDimension: { range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: at - 1, endIndex: at } } },
      ],
    });
  }

  async function renameBucket(bucketId, newName) {
    const spreadsheetId = await store.get(SPREADSHEET_KEY);
    const map = await getTabMap();
    const tab = map[bucketId];
    if (!spreadsheetId || !tab) return;
    const meta = await api("GET", `${BASE}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`);
    const taken = new Set(
      (meta.sheets || []).filter((s) => s.properties.sheetId !== tab.sheetId).map((s) => s.properties.title.toLowerCase())
    );
    const title = uniqueTitle(newName, taken);
    await api("POST", `${BASE}/${spreadsheetId}:batchUpdate`, {
      requests: [{ updateSheetProperties: { properties: { sheetId: tab.sheetId, title }, fields: "title" } }],
    });
    map[bucketId] = { sheetId: tab.sheetId, title };
    await store.set(TABMAP_KEY, map);
  }

  async function deleteBucket(bucketId) {
    const spreadsheetId = await store.get(SPREADSHEET_KEY);
    const map = await getTabMap();
    const tab = map[bucketId];
    if (!spreadsheetId || !tab) return;
    await api("POST", `${BASE}/${spreadsheetId}:batchUpdate`, {
      requests: [{ deleteSheet: { sheetId: tab.sheetId } }],
    });
    delete map[bucketId];
    await store.set(TABMAP_KEY, map);
  }

  return { ensureSpreadsheet, ensureBucketTab, upsertEntry, deleteEntry, renameBucket, deleteBucket };
}
