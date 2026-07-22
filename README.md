# Dumpster

A Chrome extension for quick-dumping links, snippets, and notes into **buckets**.
Local-first, append-forever. Built to stop losing the job link / profile / snippet
you meant to come back to.

## What it does

- **Buckets** — create as many as you want (e.g. `Job applications`, `Read later`).
- **Two ways to dump:**
  - **Popup** (toolbar icon): pick a bucket, paste, optionally *Add another* to
    stack several, then *Dump* — each becomes its own row.
  - **Right-click → Dump to ▸ [bucket]** — dumps the selected text, a link, an
    image, or the current page in one gesture. No popup, no paste.
- **Auto-captured context** — every dump records a timestamp plus the page URL
  and title it came from, so even a bare note remembers where you were.
- **Append-only** — dumps only ever add rows; nothing is overwritten.
- **Review table** (the "View all" page / extension options): one tab per bucket,
  one row per dump. Each dump has a **Status** (`To Do` → `In Process` → `Done`)
  and free-text **Notes**; the dumped text itself is editable (double-click).
  Content links are clickable.
- **Export** — pick any buckets (or all) and export to **Excel** (one sheet per
  bucket) or **JSON** (each bucket a key holding its dumps).

Data lives in the browser (IndexedDB + `chrome.storage.local`). Nothing leaves
your machine. Cross-device sync (e.g. to a Google Sheet) is a deliberate Phase-2
follow-up — see below.

## Install (unpacked, for development)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this `dumpster/` folder.
4. Pin the Dumpster icon from the toolbar puzzle menu.

Reload the extension from that page after any code change.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (popup, options page, context menus, service worker) |
| `src/db.js` | IndexedDB layer — entry rows (append-only; edit status/notes; delete) |
| `src/buckets.js` | Bucket metadata in `chrome.storage.local` |
| `src/background.js` | Service worker — seeds buckets, builds the right-click menu, handles reflex dumps |
| `popup.html/.css/.js` | Toolbar popup with batch staging |
| `dumpster.html/.css/.js` | Full-page review table + export |
| `icons/` | Generated PNG icons |

## Roadmap (Phase 2)

- **Sync / global access** — push buckets to a Google Sheet (one tab per bucket)
  so the same data is reachable from your phone and shareable.
- **AI assistance** — surface time-sensitive dumps (e.g. "follow up on this
  referral") and suggest the right bucket at capture time.
- **Per-bucket typed fields** — let a bucket define its own columns instead of the
  shared Status/Notes pair.
- **Keyboard-shortcut quick-capture** bar as a third, fastest entry point.

## Third-party

- **SheetJS (xlsx)** — vendored at `vendor/xlsx.mjs`, loaded lazily only when you
  export/import Excel. Licensed **Apache-2.0** (`vendor/SHEETJS-LICENSE.txt`).
