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
- **Import** — load an **Excel** or **JSON** file back in. Dumps append into
  buckets matched by name (missing buckets are created); rows that already exist
  (same content + timestamp) are skipped, so re-importing the same file is safe.
- **List or Board** — view a bucket as a table or a **Kanban board** (To Do /
  In Process / Done); drag a card between columns to change its status.

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

## Google sync (setup — in progress)

Cloud sync mirrors your dumps into your **own** Google Drive: one "Dumpster"
spreadsheet, a tab per bucket, a row per dump. Local IndexedDB stays the source of
truth; syncing is a background, non-blocking push so capture stays instant. Uses the
narrow `drive.file` scope (only files the app creates) via `chrome.identity`.

**One-time developer setup** (needed before the Connect button can authenticate):

1. **Pin the extension ID** — add a `"key"` to `manifest.json` so the ID is stable
   (`chrome://extensions` → pack, or generate a key pair). The OAuth client is bound
   to this ID.
2. In the [Google Cloud Console](https://console.cloud.google.com/): create a project
   → **APIs & Services → Enabled APIs**: enable **Google Sheets API** → **OAuth
   consent screen** (External; add yourself as a test user) → **Credentials → Create
   OAuth client ID → type: Chrome Extension**, with your pinned extension ID.
3. Put the client ID into `manifest.json`'s `oauth2.client_id` (replacing
   `REPLACE_WITH_YOUR_CLIENT_ID...`).

While the consent screen is in **Testing**, only added test users (≤100) can connect.
To ship publicly, submit for verification — `drive.file` is non-restricted, so it's the
lighter brand verification, not the restricted-scope security assessment.

## Roadmap (Phase 2)

- **Docs sync target** — a switchable second provider with inline screenshots
  (`insertInlineImage`) and Drive OCR, alongside the Sheets target.
- **AI assistance** — surface time-sensitive dumps (e.g. "follow up on this
  referral") and suggest the right bucket at capture time.
- **Per-bucket typed fields** — let a bucket define its own columns instead of the
  shared Status/Notes pair.
- **Keyboard-shortcut quick-capture** bar as a third, fastest entry point.

## Third-party

- **SheetJS (xlsx)** — vendored at `vendor/xlsx.mjs`, loaded lazily only when you
  export/import Excel. Licensed **Apache-2.0** (`vendor/SHEETJS-LICENSE.txt`).
