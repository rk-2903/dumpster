// Google Docs sync provider. Mirrors each bucket into its own Google Doc
// ("Dumpster — <bucket>"). Entries append chronologically under date headings
// (HEADING_2); each entry is a content line plus a subtle meta line
// (status · source · notes) with real links.
//
// Update/delete strategy: every entry's block is wrapped in a Docs NamedRange
// keyed by the entry id. Named ranges track their position as the doc changes,
// so a later edit/delete can locate the exact block and replace or remove it
// in place — the Docs equivalent of the Sheets provider's id column.
//
// Same injectable deps as sheetsSync (getToken, fetchImpl, store) for testing.

const DOCS = "https://docs.googleapis.com/v1";
const DRIVE = "https://www.googleapis.com/drive/v3";

const chromeStore = {
  get: (key) => new Promise((r) => chrome.storage.local.get(key, (o) => r(o[key]))),
  set: (key, value) => new Promise((r) => chrome.storage.local.set({ [key]: value }, r)),
};

export function createDocsProvider({ getToken, fetchImpl = globalThis.fetch, store = chromeStore } = {}) {
  const MAP_KEY = "docsDocMap"; // { [bucketId]: { docId, title, lastDate } }
  const TITLE_RANGE = "__dumpster_title__"; // named range over the in-doc title

  async function api(method, url, body) {
    const token = await getToken(false);
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Docs ${method} ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  const r = (s, e) => ({ startIndex: s, endIndex: e });

  async function getMap() {
    return (await store.get(MAP_KEY)) || {};
  }

  async function ensureBucketDoc(bucketId, bucketName) {
    const map = await getMap();
    if (map[bucketId]) return map[bucketId];
    const created = await api("POST", `${DOCS}/documents`, { title: `Dumpster — ${bucketName}` });
    // The bucket name is also the doc's visible heading (TITLE style), wrapped
    // in a named range so a bucket rename can rewrite it later.
    const t = `${bucketName}\n`;
    await api("POST", `${DOCS}/documents/${created.documentId}:batchUpdate`, {
      requests: [
        { insertText: { location: { index: 1 }, text: t } },
        {
          updateParagraphStyle: {
            range: r(1, 1 + t.length),
            paragraphStyle: { namedStyleType: "TITLE" },
            fields: "namedStyleType",
          },
        },
        { createNamedRange: { name: TITLE_RANGE, range: r(1, 1 + t.length) } },
      ],
    });
    map[bucketId] = { docId: created.documentId, title: bucketName, lastDate: "" };
    await store.set(MAP_KEY, map);
    return map[bucketId];
  }

  function dateLabel(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? "Undated"
      : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }

  // One entry's text block + offsets (relative to block start) for styling.
  // Doc buckets are documentation — no workflow status line; meta is just
  // source · notes, and it's omitted entirely when both are empty.
  function buildBlock(entry) {
    const content = String(entry.content || "").trim() || "(empty)";
    const src = entry.sourceTitle || entry.sourceUrl || "";
    let meta = "";
    let srcOffset = -1;
    if (src) {
      srcOffset = 0;
      meta = src;
    }
    if (entry.notes) meta = meta ? `${meta}  ·  ${entry.notes}` : entry.notes;
    return {
      text: meta ? `${content}\n${meta}\n\n` : `${content}\n\n`, // blank line separates entries
      contentLen: content.length,
      contentIsUrl: /^https?:\/\/\S+$/.test(content),
      metaOffset: content.length + 1,
      metaLen: meta.length,
      srcOffset,
      srcLen: src.length,
    };
  }

  // Styling for a block whose text was inserted at absolute index `at`.
  function styleRequests(entry, block, at) {
    const reqs = [
      {
        updateParagraphStyle: {
          range: r(at, at + block.text.length),
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          fields: "namedStyleType",
        },
      },
    ];
    if (block.metaLen > 0) {
      reqs.push({
        updateTextStyle: {
          range: r(at + block.metaOffset, at + block.metaOffset + block.metaLen),
          textStyle: {
            italic: true,
            fontSize: { magnitude: 10, unit: "PT" },
            foregroundColor: { color: { rgbColor: { red: 0.42, green: 0.45, blue: 0.49 } } },
          },
          fields: "italic,fontSize,foregroundColor",
        },
      });
    }
    if (block.contentIsUrl) {
      reqs.push({
        updateTextStyle: {
          range: r(at, at + block.contentLen),
          textStyle: { link: { url: String(entry.content).trim() } },
          fields: "link",
        },
      });
    }
    if (block.srcOffset >= 0 && entry.sourceUrl) {
      const s = at + block.metaOffset + block.srcOffset;
      reqs.push({
        updateTextStyle: {
          range: r(s, s + block.srcLen),
          textStyle: { link: { url: entry.sourceUrl } },
          fields: "link",
        },
      });
    }
    return reqs;
  }

  function getDoc(docId) {
    return api("GET", `${DOCS}/documents/${docId}?fields=namedRanges,body.content(endIndex)`);
  }

  // Combined span of the entry's named range (may be split by manual edits).
  function rangeOf(doc, name) {
    const groups = doc.namedRanges?.[name]?.namedRanges || [];
    const spans = groups.flatMap((g) => g.ranges || []);
    if (!spans.length) return null;
    return {
      start: Math.min(...spans.map((x) => x.startIndex)),
      end: Math.max(...spans.map((x) => x.endIndex)),
    };
  }

  async function upsertEntry(entry) {
    const tab = await ensureBucketDoc(entry.bucketId, entry.bucketName || "Bucket");
    const doc = await getDoc(tab.docId);
    const block = buildBlock(entry);
    const existing = rangeOf(doc, entry.id);

    if (existing) {
      // Replace the block in place (stays in its original date section).
      const { start, end } = existing;
      await api("POST", `${DOCS}/documents/${tab.docId}:batchUpdate`, {
        requests: [
          { deleteNamedRange: { name: entry.id } },
          { deleteContentRange: { range: r(start, end) } },
          { insertText: { location: { index: start }, text: block.text } },
          ...styleRequests(entry, block, start),
          { createNamedRange: { name: entry.id, range: r(start, start + block.text.length) } },
        ],
      });
      return;
    }

    // Append at the end; add a date heading when the day changes.
    const content = doc.body?.content || [];
    const insertAt = Math.max(1, (content[content.length - 1]?.endIndex || 2) - 1);
    const heading = dateLabel(entry.createdAt);
    const needHeading = tab.lastDate !== heading;
    const headingText = needHeading ? `${heading}\n` : "";
    const blockStart = insertAt + headingText.length;

    const requests = [{ insertText: { location: { index: insertAt }, text: headingText + block.text } }];
    if (needHeading) {
      requests.push({
        updateParagraphStyle: {
          range: r(insertAt, insertAt + headingText.length),
          paragraphStyle: { namedStyleType: "HEADING_2" },
          fields: "namedStyleType",
        },
      });
    }
    requests.push(...styleRequests(entry, block, blockStart));
    requests.push({
      createNamedRange: { name: entry.id, range: r(blockStart, blockStart + block.text.length) },
    });
    await api("POST", `${DOCS}/documents/${tab.docId}:batchUpdate`, { requests });

    if (needHeading) {
      const map = await getMap();
      if (map[entry.bucketId]) {
        map[entry.bucketId].lastDate = heading;
        await store.set(MAP_KEY, map);
      }
    }
  }

  async function deleteEntry(entryId, bucketId) {
    const map = await getMap();
    const tab = map[bucketId];
    if (!tab) return;
    const doc = await getDoc(tab.docId);
    const span = rangeOf(doc, entryId);
    if (!span) return;
    await api("POST", `${DOCS}/documents/${tab.docId}:batchUpdate`, {
      requests: [
        { deleteNamedRange: { name: entryId } },
        { deleteContentRange: { range: r(span.start, span.end) } },
      ],
    });
  }

  async function renameBucket(bucketId, newName) {
    const map = await getMap();
    const tab = map[bucketId];
    if (!tab) return;
    await api("PATCH", `${DRIVE}/files/${tab.docId}`, { name: `Dumpster — ${newName}` });
    // Rewrite the in-doc title heading as well.
    const doc = await getDoc(tab.docId);
    const span = rangeOf(doc, TITLE_RANGE);
    if (span) {
      const t = `${newName}\n`;
      await api("POST", `${DOCS}/documents/${tab.docId}:batchUpdate`, {
        requests: [
          { deleteNamedRange: { name: TITLE_RANGE } },
          { deleteContentRange: { range: r(span.start, span.end) } },
          { insertText: { location: { index: span.start }, text: t } },
          {
            updateParagraphStyle: {
              range: r(span.start, span.start + t.length),
              paragraphStyle: { namedStyleType: "TITLE" },
              fields: "namedStyleType",
            },
          },
          { createNamedRange: { name: TITLE_RANGE, range: r(span.start, span.start + t.length) } },
        ],
      });
    }
    tab.title = newName;
    await store.set(MAP_KEY, map);
  }

  async function deleteBucket(bucketId) {
    const map = await getMap();
    const tab = map[bucketId];
    if (!tab) return;
    // Trash rather than hard-delete — recoverable from the user's Drive trash.
    await api("PATCH", `${DRIVE}/files/${tab.docId}`, { trashed: true });
    delete map[bucketId];
    await store.set(MAP_KEY, map);
  }

  return { ensureBucketDoc, upsertEntry, deleteEntry, renameBucket, deleteBucket };
}
