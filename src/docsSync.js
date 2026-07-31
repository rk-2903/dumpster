// Google Docs sync provider. Mirrors each bucket into its own Google Doc
// ("Dumpster — <bucket>"). Entries append chronologically under date headings.
//
// Heading hierarchy (so the Doc's outline pane is navigable):
//   TITLE      → bucket name
//   HEADING_1  → date sections + the "References" section
//   HEADING_2/3→ entry headings (a saved "H1"/"H2" selection, one level below
//                its date so it nests correctly in the outline)
// Each entry is a content line plus a subtle italic notes line.
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

// getImage(entryId) → { blob, width?, height? } | null — injected so the provider
// can fetch screenshot blobs (from IndexedDB in production, fixtures in tests).
export function createDocsProvider({ getToken, fetchImpl = globalThis.fetch, store = chromeStore, getImage } = {}) {
  const MAP_KEY = "docsDocMap"; // { [bucketId]: { docId, title, lastDate, refs } }
  const TITLE_RANGE = "__dumpster_title__"; // named range over the in-doc title
  const REFS_RANGE = "__dumpster_refs__"; // named range over the References section
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

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

  // The Docs API fetches image URIs server-side without auth, so a private
  // Drive file won't work. Pattern: upload the PNG, make it link-visible for a
  // few seconds, insert (Docs copies the bytes into the document), then delete
  // the temp file. The local blob stays the source of truth.
  async function uploadTempImage(blob) {
    const token = await getToken(false);
    const res = await fetchImpl(`${DRIVE_UPLOAD}?uploadType=media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": blob.type || "image/png" },
      body: blob,
    });
    if (!res.ok) throw new Error(`Drive upload ${res.status}`);
    const { id } = await res.json();
    await api("POST", `https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
      type: "anyone",
      role: "reader",
    });
    return id;
  }

  function deleteTempImage(id) {
    return api("DELETE", `https://www.googleapis.com/drive/v3/files/${id}`).catch(() => {});
  }

  // Extract text from a screenshot using Drive's free convert-with-OCR:
  // upload the PNG as a Google Doc (multipart, ocrLanguage) → export text/plain
  // → delete the temp doc. Same drive.file scope; no Vision API.
  async function ocrImage(blob) {
    const token = await getToken(false);
    const boundary = `dumpster-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({
      name: "Dumpster OCR temp",
      mimeType: "application/vnd.google-apps.document",
    });
    const body = new Blob(
      [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        `--${boundary}\r\nContent-Type: ${blob.type || "image/png"}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`,
      ],
      { type: `multipart/related; boundary=${boundary}` }
    );
    const up = await fetchImpl(`${DRIVE_UPLOAD}?uploadType=multipart&ocrLanguage=en`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!up.ok) throw new Error(`OCR upload ${up.status}`);
    const { id } = await up.json();
    try {
      const ex = await fetchImpl(
        `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!ex.ok) throw new Error(`OCR export ${ex.status}`);
      return (await ex.text()).trim();
    } finally {
      await deleteTempImage(id);
    }
  }

  // Inline image sized to fit the doc column (px → pt at 0.75, capped 460pt).
  function imageRequest(atIndex, fileId, dims) {
    const req = {
      insertInlineImage: {
        location: { index: atIndex },
        uri: `https://drive.google.com/uc?export=view&id=${fileId}`,
      },
    };
    const maxPt = 460;
    if (dims?.width) {
      const pt = Math.min(maxPt, Math.round(dims.width * 0.75));
      req.insertInlineImage.objectSize = { width: { magnitude: pt, unit: "PT" } };
    } else {
      req.insertInlineImage.objectSize = { width: { magnitude: maxPt, unit: "PT" } };
    }
    return req;
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
    map[bucketId] = { docId: created.documentId, title: bucketName, lastDate: "", refs: [] };
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
  // Sources are NOT shown per line — they live in a shared References section at
  // the bottom of the doc. The optional meta line is just the user's notes.
  function buildBlock(entry) {
    const raw = String(entry.content || "").trim();
    // Image-only entries carry no caption text; only truly empty non-image
    // entries fall back to a placeholder.
    const content = raw || (entry.hasImage ? "" : "(empty)");
    const meta = entry.notes ? String(entry.notes) : "";
    return {
      text: meta ? `${content}\n${meta}\n\n` : `${content}\n\n`, // blank line separates entries
      contentLen: content.length,
      contentIsUrl: /^https?:\/\/\S+$/.test(content),
      metaOffset: content.length + 1,
      metaLen: meta.length,
    };
  }

  // Map a saved selection format onto Docs paragraph styling for the content
  // line ([at, at+contentLen+1) — includes the trailing newline).
  function formatRequests(entry, block, at) {
    const contentRange = r(at, at + block.contentLen + 1);
    switch (entry.format) {
      // Entry headings sit one level BELOW the date sections (HEADING_1), so the
      // Doc's outline nests them under their date: H1 date › H2/H3 entries.
      case "h1":
        return [{ updateParagraphStyle: { range: contentRange, paragraphStyle: { namedStyleType: "HEADING_2" }, fields: "namedStyleType" } }];
      case "h2":
        return [{ updateParagraphStyle: { range: contentRange, paragraphStyle: { namedStyleType: "HEADING_3" }, fields: "namedStyleType" } }];
      case "list":
        return [{ createParagraphBullets: { range: contentRange, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } }];
      default:
        return []; // "p" / undefined → NORMAL_TEXT already applied
    }
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
      // Override the content paragraph's style when a format was chosen.
      ...formatRequests(entry, block, at),
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
    return reqs;
  }

  // ---- References section (unique source links, pinned at the bottom) ----

  const refKey = (e) => (e.sourceUrl || e.sourceTitle || "").trim();

  // Rebuild the References section from the bucket's stored unique sources:
  // delete the old section (if any) and re-insert it at the very end, so it
  // always stays at the bottom. No-op when there are no sources.
  async function rebuildRefs(bucketId) {
    const map = await getMap();
    const tab = map[bucketId];
    const refs = tab?.refs || [];
    if (!tab) return;
    const doc = await getDoc(tab.docId);
    const existing = rangeOf(doc, REFS_RANGE);

    const requests = [];
    let end;
    if (existing) {
      requests.push({ deleteNamedRange: { name: REFS_RANGE } });
      requests.push({ deleteContentRange: { range: r(existing.start, existing.end) } });
      end = existing.start; // section is always last → deletion leaves the doc ending here
    } else {
      const content = doc.body?.content || [];
      end = Math.max(1, (content[content.length - 1]?.endIndex || 2) - 1);
    }
    if (!refs.length) {
      if (requests.length) await api("POST", `${DOCS}/documents/${tab.docId}:batchUpdate`, { requests });
      return;
    }

    const headingText = "References\n";
    let text = headingText;
    const links = [];
    for (const ref of refs) {
      const label = ref.title || ref.url;
      links.push({ offset: text.length, len: label.length, url: ref.url });
      text += `${label}\n`;
    }
    requests.push({ insertText: { location: { index: end }, text } });
    requests.push({
      updateParagraphStyle: {
        range: r(end, end + headingText.length),
        paragraphStyle: { namedStyleType: "HEADING_1" }, // top-level section, like dates
        fields: "namedStyleType",
      },
    });
    for (const l of links) {
      if (!l.url) continue;
      requests.push({
        updateTextStyle: {
          range: r(end + l.offset, end + l.offset + l.len),
          textStyle: { link: { url: l.url } },
          fields: "link",
        },
      });
    }
    requests.push({ createNamedRange: { name: REFS_RANGE, range: r(end, end + text.length) } });
    await api("POST", `${DOCS}/documents/${tab.docId}:batchUpdate`, { requests });
  }

  // Record a new unique source; returns true if the References section needs a rebuild.
  async function noteSource(bucketId, entry) {
    const key = refKey(entry);
    if (!key) return false;
    const map = await getMap();
    const tab = map[bucketId];
    if (!tab) return false;
    tab.refs = tab.refs || [];
    if (tab.refs.some((ref) => (ref.url || ref.title) === key)) return false;
    tab.refs.push({ url: entry.sourceUrl || "", title: entry.sourceTitle || "" });
    await store.set(MAP_KEY, map);
    return true;
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
    const refsRange = rangeOf(doc, REFS_RANGE); // entries append above this

    // Screenshot entries: stage a temp public Drive copy for Docs to ingest.
    let img = null;
    let tempFileId = null;
    if (entry.hasImage && getImage) {
      img = await getImage(entry.id);
      if (img?.blob) tempFileId = await uploadTempImage(img.blob);
    }
    // The image occupies one index unit at the end of the block (its own line).
    const blockLen = block.text.length + (tempFileId ? 1 : 0);
    const imageReqs = (blockStart) =>
      tempFileId ? [imageRequest(blockStart + block.text.length - 1, tempFileId, img)] : [];

    try {
      if (existing) {
        // Replace the block in place (stays in its original date section).
        const { start, end } = existing;
        await api("POST", `${DOCS}/documents/${tab.docId}:batchUpdate`, {
          requests: [
            { deleteNamedRange: { name: entry.id } },
            { deleteContentRange: { range: r(start, end) } },
            { insertText: { location: { index: start }, text: block.text } },
            ...styleRequests(entry, block, start),
            ...imageReqs(start),
            { createNamedRange: { name: entry.id, range: r(start, start + blockLen) } },
          ],
        });
        return;
      }

      // Append after the last entry but BEFORE the References section (so
      // References stays at the very bottom); else at the doc end.
      const content = doc.body?.content || [];
      const docEnd = Math.max(1, (content[content.length - 1]?.endIndex || 2) - 1);
      const insertAt = refsRange ? refsRange.start : docEnd;
      const heading = dateLabel(entry.createdAt);
      const needHeading = tab.lastDate !== heading;
      const headingText = needHeading ? `${heading}\n` : "";
      const blockStart = insertAt + headingText.length;

      const requests = [{ insertText: { location: { index: insertAt }, text: headingText + block.text } }];
      if (needHeading) {
        requests.push({
          updateParagraphStyle: {
            range: r(insertAt, insertAt + headingText.length),
            paragraphStyle: { namedStyleType: "HEADING_1" }, // top-level date section
            fields: "namedStyleType",
          },
        });
      }
      requests.push(...styleRequests(entry, block, blockStart));
      requests.push(...imageReqs(blockStart));
      requests.push({
        createNamedRange: { name: entry.id, range: r(blockStart, blockStart + blockLen) },
      });
      await api("POST", `${DOCS}/documents/${tab.docId}:batchUpdate`, { requests });

      if (needHeading) {
        const map = await getMap();
        if (map[entry.bucketId]) {
          map[entry.bucketId].lastDate = heading;
          await store.set(MAP_KEY, map);
        }
      }
    } finally {
      // Docs copied the bytes at insert time; remove the temp file either way.
      if (tempFileId) await deleteTempImage(tempFileId);
    }

    // Keep the bottom References section current if this entry cited a new source.
    if (await noteSource(entry.bucketId, entry)) await rebuildRefs(entry.bucketId);
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

  return { ensureBucketDoc, upsertEntry, deleteEntry, renameBucket, deleteBucket, ocrImage };
}
