# Dumpster

A Chrome extension for quick-dumping links, snippets, and notes into **buckets**.
Local-first, append-forever. Built to stop losing the job link / profile / snippet
you meant to come back to.

## What it does

- **Typed buckets** — the tab bar has two scrollable rows, each with its own ＋:
  - **Sheet buckets** — trackers. Each dump has a **Status**
    (`To Do` → `In Process` → `Done`) and **Notes**; view as a table or a
    **Kanban board** and drag cards between columns to change status.
  - **Doc buckets** — documentation. No workflow status. In the viewer they
    default to a **Document** view (toggle to List to edit): entries render as a
    flowing document — date sections, H1/H2/list/paragraph, inline screenshots,
    and a **References** section at the bottom listing the unique source links.
- **Three ways to dump:**
  - **Toolbar icon → doc panel**: clicking the icon opens the **doc panel**
    beside the page (see Study capture below). The classic capture popup lives
    on as **Quick dump…** (right-click the icon): a **Sheet / Doc** tab keeps
    the two bucket types separate — pick the tab, pick a bucket, paste,
    optionally *Add another* to stack several, then *Dump*. (Screenshots
    enable on the Doc tab.)
  - **Right-click → Dump to → Sheet / Doc → [bucket]** — dumps the selected
    text, a link, an image, or the current page in one gesture.
  - **Right-click → … → ＋ New bucket…** — names the bucket via a prompt right
    on the page you're on and files the dump into it in one go (a small naming
    window appears only on pages Chrome can't inject into, e.g. `chrome://`).
- **Study capture (Doc buckets)** — built for researching with a page open:
  - **Screenshots**: from Quick dump (📸 button), right-click → **Screenshot to**
    (visible area or **drag-a-region**), or **Alt+Shift+S** straight to your
    last-used Doc bucket. Thumbnails show in the viewer (click for full size),
    and synced screenshots appear **inside the bucket's Google Doc**, sized to
    fit.
  - **Doc panel** (click the toolbar icon): a **markdown editor** pinned
    beside the page (Chrome's side panel), with a **Doc | Sheet** switcher at
    the top.
    - **Doc mode** — a fixed toolbar holds the **active-doc picker**, paragraph
      styles (Normal/H1/H2), **B / I / code / lists**, **⬚ region screenshot**
      and **OCR** capture buttons (both drop a drag-rectangle on the page; the
      crop lands at the end of the doc as an image or extracted paragraph text
      — first use asks Chrome's one-time site-access prompt, required by the
      capture API), a **YouTube transcript** button (last 30s / 60s / full,
      timestamped — same as the dock's), and GitHub-style **Write / Preview** tabs with a live
      rendered preview (**double-click the preview** to jump into edit mode).
      Selections and screenshots you capture on the page flow straight into
      the active doc (and still sync as entries); around them you can write
      anything in markdown — saved locally as you type. **Drag an image into
      the panel** (from a page or your desktop) and it's appended at the end
      of the doc; if a site blocks fetching its image, the link is saved
      instead. (Free-form body → Google Docs sync is a roadmap item.)
    - **Sheet mode** — a mini tracker: pick a Sheet bucket, **quick-add**
      entries (⌘/Ctrl+Enter, current page attached as source), and flip the
      newest rows' **status pills** (To Do / In Process / Done) inline —
      changes sync and live-refresh an open workspace. The mode and last
      tracker are remembered. Each add has two fields: an optional **Key**
      (a label like `username` or `id`) above the **Data** — they land in
      **separate columns** in the workspace table, the synced Google Sheet,
      and exports, so key/value trackers stay structured. Every row also has
      a **copy** button (copies the value only — never the key, source or
      status) and a **delete** ✕ that arms into a red *Delete?* needing a
      second click, removing the row locally **and** from the synced sheet.
      (Note: trackers are **not encrypted** — locally or in your Google Sheet
      — so avoid storing real passwords or secrets.)
    - **AI tools (bring your own)** — a ✨ menu in the doc toolbar:
      **Summarize doc** (appends a `## Summary`), **Flashcards → tracker**
      (Q/A pairs land as a key/value Sheet bucket, synced like any tracker),
      **Quiz me** (interactive multiple-choice overlay with explanations and a
      score), and **Ask your notes** (chat over all your buckets with cited
      sources; insert answers into the doc). Connect it **your way** — four
      options, set up in ✨ → *AI settings…*: **Gemini** (a **free** key —
      most students have one), **Ollama** (a model on your **own machine**),
      **OpenAI**, or **Anthropic**. Keys stay on your device; requests go
      straight to the provider you picked, never through any middleman, and
      Ollama hosts must be local. See [AI setup](#ai-setup-bring-your-own)
      below and [docs/PRIVACY.md](docs/PRIVACY.md).
    - **Voice input** — a 🎙 mic button in the doc bottom bar dictates notes in
      **your language** (~100 supported; picker beside the mic, remembered).
      Uses the browser's **free built-in speech recognition** — no account, no
      API key. Spoken text lands **at your cursor** in the editor (plain
      Cmd/Ctrl+Z undoes it), or at the **end of the doc** when the editor isn't
      focused; interim words preview live above the bar. First use opens a
      one-time microphone grant tab (side panels can't show the prompt);
      needs internet (Chrome's recognizer runs on Google's speech service —
      see the privacy policy).
    - **Bottom bar** (per mode) — **⇪ Share** and **↗ Open** deep-link to the
      bucket's Google Doc or its exact spreadsheet tab, and **⇓ Export**:
      a Doc exports as **PDF** (print-styled page → Save as PDF),
      **Word (.docx)** (via the synced Google Doc — needs Google connected),
      or a **self-contained Markdown** file (screenshots embedded as data
      URIs); a tracker exports as **Excel or JSON** through the same picker as
      the workspace dialog — current tracker pre-selected, tick more or **All
      trackers** for one combined file (a worksheet per tracker in Excel, a
      key per tracker in JSON). PDF/MD/Excel/JSON read from local storage, so
      they work offline and for never-synced buckets.
    - **Cloud chip** — a live sync-status dot in the panel toolbar (hollow =
      not connected, green = synced, amber = syncing, red = error); clicking
      it opens the workspace's Cloud dialog for Connect / Disconnect.
  - **OCR**: synced screenshots get their text extracted (via Drive's free OCR)
    so the bucket filter can find words *inside* your screenshots.
  - **Page helper** (current tab, armed when you open the doc panel or Quick dump —
    injected on demand, never running on other tabs in the background; toggle it
    off in Quick dump):
    - a **floating dock** on the right edge you can **drag up/down** (its
      position is remembered). Hover to expand its toolbar: a **📷 page**
      screenshot, a **⬚ region** screenshot (drag a rectangle right on the page),
      an **OCR** grab (drag a region → its text is extracted and added as a
      paragraph — needs Google connected), and **H1 / H2 / ≔ / ¶** chips that
      save the current selection to your last-used Doc bucket. On **YouTube**
      the dock adds a **transcript** button — capture the **last 30s / 60s or
      the full transcript** as timestamped `[m:ss]` bullets, with the entry's
      source link resuming the video at that moment. Its **×** menu
      hides the dock **until next visit**, **on this domain**, or **on all
      websites** (re-enable from the Quick dump toggle);
    - a **selection menu**: select text and a small pill appears —
      **H1 / H2 / list / ¶** — click one to save that text to your last-used Doc
      bucket, formatted as a real Heading 1/2, bullet, or paragraph in the Doc.
- **Auto-captured context** — every dump records a timestamp plus the page URL
  and title it came from, so even a bare note remembers where you were.
- **Append-only** — dumps only ever add rows; nothing is overwritten. The dumped
  text is editable later (double-click), links are clickable, and each bucket
  has a live **filter**.
- **Live refresh** — dumps made from the popup or right-click appear instantly
  in an open Dumpster tab.
- **Export** — pick any buckets (the one you're viewing is pre-selected, or
  choose All) and export to **Excel** (one sheet per bucket) or **JSON** (each
  bucket a key holding its dumps).
- **Import** — load an **Excel** or **JSON** file back in. Dumps append into
  buckets matched by name (missing buckets are created); rows that already exist
  (same content + timestamp) are skipped, so re-importing the same file is safe.
- **Google sync (optional)** — connect your own Google account and every dump
  mirrors into your Drive: Sheet buckets → one spreadsheet, Doc buckets → their
  own Google Docs. See below.

Data lives in the browser (IndexedDB + `chrome.storage.local`, with persistent
storage requested so it isn't evicted). Your **content** never leaves your
machine unless you connect Google — and then it goes only to your own Drive.

- **Anonymous usage stats (opt-out)** — to see how many people use Dumpster and
  which features matter, it sends **anonymous** event counts (a random id,
  event names like `install`/`active`/`feature`/`error`, version, locale) to the
  developer's Supabase backend. Never your dumps, selections, screenshots, page
  URLs, or Google data. Opt-out — see [docs/PRIVACY.md](docs/PRIVACY.md) for
  exactly what's collected and how to disable it. The backend (schema + edge
  functions you self-host) lives in [`supabase/`](supabase/).

## Install (unpacked, for development)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this `dumpster/` folder.
4. Pin the Dumpster icon from the toolbar puzzle menu.

Reload the extension from that page after any code change.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (side panel, context menus, service worker, OAuth, commands) |
| `src/db.js` | IndexedDB layer — entry rows (append-only; edit status/notes/content; delete) |
| `src/buckets.js` | Bucket metadata (typed: sheet/doc) in `chrome.storage.local` |
| `src/background.js` | Service worker — right-click menu, reflex dumps, in-page new-bucket prompt, sync drain loop |
| `src/outbox.js` | Durable, coalescing sync op queue (no-ops while disconnected) |
| `src/sync.js` | Sync orchestrator — routes ops to the provider matching each bucket's kind |
| `src/googleAuth.js` | `chrome.identity` connect/disconnect/token wrapper |
| `src/telemetry.js` | Anonymous, opt-out usage telemetry (durable batched sender) |
| `src/sheetsSync.js` | Sheets provider — tab per bucket, row per dump keyed by entry id |
| `src/docsSync.js` | Docs provider — doc per bucket, date headings, named-range keyed blocks |
| `src/markdown.js` | Tiny markdown → HTML renderer (panel preview + exports) |
| `src/docBody.js` | Per-bucket free-form markdown body (seed, ingest, autosave) |
| `src/ai.js` | Bring-your-own AI layer — Gemini / Ollama / OpenAI / Anthropic, one `aiComplete()` |
| `src/voiceInput.js` | Dictation wrapper over the browser's speech recognition (~100 languages) |
| `src/capture.js` | captureVisibleTab → blob + region crop helpers |
| `src/regionSelect.js` | Injected drag-a-region overlay |
| `src/ytTranscript.js` | Injected YouTube transcript scraper (last 30s/60s/full) |
| `src/selectionMenu.js` | Injected page helper — selection pill + floating dock |
| `sidepanel.html/.js` | Doc panel — markdown editor, Sheet tracker, exports, cloud chip |
| `export.html/.js` | Print-styled page behind the doc panel's PDF export |
| `micgrant.html/.js` | One-time microphone grant page (side panels can't show the prompt) |
| `popup.html/.css/.js` | Quick dump popup (icon right-click → small window) |
| `dumpster.html/.css/.js` | Full-page workspace: tabs, list/board, filter, import/export, Cloud modal |
| `newbucket.html/.js` | Fallback naming window for the context-menu New bucket flow |
| `scripts/package.sh` | Builds the Chrome Web Store zip (`dist/`) |
| `docs/` | Publishing guide + privacy policy draft |
| `supabase/` | Telemetry backend — schema, edge functions, deploy guide (self-hosted) |
| `vendor/` | SheetJS (lazy-loaded for Excel import/export) |
| `icons/` | Generated PNG icons |

## AI setup (bring your own)

The ✨ menu (Summarize · Flashcards · Quiz · Ask your notes) is **off until you
connect a provider**. Open ✨ → **AI settings…**, pick one, then **Test** →
**Save**. Your key is stored only in `chrome.storage.local` on this device, and
requests go straight from the extension to the provider you chose — there is no
Dumpster server in the path.

| Provider | Cost | Get a key |
|---|---|---|
| **Gemini** | Free tier (what most students use) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Ollama** | Free, runs on your machine, works offline | [ollama.com](https://ollama.com) — see below |
| **OpenAI** | Pay-as-you-go | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic** | Pay-as-you-go | [console.anthropic.com](https://console.anthropic.com/settings/keys) |

### Ollama: allow the extension

Ollama rejects browser-extension requests unless its origin allow-list includes
them, so pull a model and start the server with `OLLAMA_ORIGINS` set:

```bash
ollama pull llama3.2
```

**A server that is already running will not pick the setting up** — it has to be
restarted with the variable in its environment. On macOS the menu-bar app often
ignores `launchctl setenv`, so the reliable route is to quit it and run the
server yourself (keep this terminal open):

```bash
osascript -e 'quit app "Ollama"'; sleep 2; OLLAMA_ORIGINS='chrome-extension://*' ollama serve
```

To verify from a terminal, send the request shape the extension actually uses —
**with an `Origin` header**, since a request without one is allowed even when
the extension is blocked, which makes plain `curl` look misleadingly healthy:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:11434/api/chat -H "Origin: chrome-extension://test" -H "Content-Type: application/json" -d '{"model":"llama3.2","stream":false,"messages":[{"role":"user","content":"hi"}]}'
```

`200` means the panel will work; `403` means Ollama is still blocking the
extension. Only local addresses are accepted (`localhost`, `127.0.0.1`, LAN,
`*.local`) — a remote host is refused so "nothing leaves your computer" stays
true.

## Google sync

Cloud sync mirrors your dumps into your **own** Google Drive. Both destinations
are live at once, routed by each bucket's type:

- **Sheet buckets** — tabs in one "Dumpster" spreadsheet (the default empty
  "Sheet1" is cleaned up automatically), a row per dump keyed by entry id, so
  status changes, edits, and deletes update the same row.
- **Doc buckets** — each bucket gets its own Google Doc (bucket name as the
  doc's title heading), entries grouped under date headings as a content line
  plus a notes meta line. The heading hierarchy is consistent — **title › date
  (Heading 1) › entry headings (Heading 2/3) › References (Heading 1)** — so the
  Doc's built-in **outline pane** is a clean, navigable table of contents. Edits
  and deletes locate their block via Docs named ranges keyed by entry id. **Screenshots are embedded inline**: the Docs
  API can only ingest publicly reachable images, so each screenshot is uploaded
  to your Drive, made link-visible for a few seconds while Docs copies it into
  the document, then deleted (the local copy remains the source of truth).

Connecting (an official-style **Connect Google** button in the Cloud modal)
backfills everything already in Dumpster, oldest-first. The Cloud chip shows
live sync state (with error detail when something fails), and the modal links to
the spreadsheet plus a collapsible list of each Doc bucket's doc. Local
IndexedDB stays the source of truth; syncing is a background, non-blocking push
(durable outbox + retry alarm) so capture stays instant and works offline. Uses
the narrow `drive.file` scope (only files the app creates) via
`chrome.identity`.

**One-time developer setup** (needed before the Connect button can authenticate):

1. **Pin the extension ID** — add a `"key"` to `manifest.json` so the ID is stable
   (`chrome://extensions` → pack, or generate a key pair). The OAuth client is bound
   to this ID.
2. In the [Google Cloud Console](https://console.cloud.google.com/): create a project
   → **APIs & Services → Enabled APIs**: enable **Google Sheets API**, and for the
   Docs target also **Google Docs API** + **Google Drive API** (doc rename/trash) →
   **OAuth consent screen** (External; add yourself as a test user) → **Credentials →
   Create OAuth client ID → type: Chrome Extension**, with your pinned extension ID.
3. Put the client ID into `manifest.json`'s `oauth2.client_id` (replacing
   `REPLACE_WITH_YOUR_CLIENT_ID...`).

While the consent screen is in **Testing**, only added test users (≤100) can connect.
To ship publicly, submit for verification — `drive.file` is non-restricted, so it's the
lighter brand verification, not the restricted-scope security assessment.

## Publishing

Everything needed to ship Dumpster to the Chrome Web Store:

- **[docs/PUBLISHING.md](docs/PUBLISHING.md)** — the full step-by-step: developer
  account, packaging, the extension-ID / OAuth-client reconciliation (the one
  gotcha), consent-screen production, store listing + permission justifications,
  and how to release updates.
- **`./scripts/package.sh`** — builds a clean store upload at
  `dist/dumpster-v<version>.zip` (strips the dev-only manifest `"key"`, warns if
  the OAuth client id is still the placeholder).
- **[docs/PRIVACY.md](docs/PRIVACY.md)** — privacy policy draft. Deploy it to a
  public URL (e.g. GitHub Pages) and fill in the date + contact email before
  submitting the listing — the store requires the URL.

## Roadmap (Phase 2)

- **Study-flow gaps vs. LunaNotes** — still open: live timestamped video notes
  with click-to-seek, a transcript drawer, screenshot annotation, and
  cross-bucket global search. (Summaries, flashcards, quizzes and ask-your-notes
  are **done** — see the AI tools above.) Full analysis in
  [docs/IDEAS-LUNANOTES-GAPS.md](docs/IDEAS-LUNANOTES-GAPS.md).
- **Concept diagrams** — generate Mermaid from a doc and render it in the
  preview (the remaining AI item from that analysis).
- **Flashcard review mode** — study the generated Q/A tracker in the panel
  (flip, spaced repetition) instead of reading it as a table.
- **Committed test suite** — the jsdom/Node suites currently live outside the
  repo and get wiped; move them to `tests/` with an `npm test` script.
- **UI localization** — translate the extension's own labels/buttons via
  `chrome.i18n` + `_locales` (voice dictation already works in ~100 languages).
- **Offline / on-device dictation** — Chrome's on-device speech recognition (or
  a Whisper-class model) so voice input works without internet.
- **Translate dictation** — optionally translate spoken notes into the doc's
  language instead of transcribing verbatim.
- **Convert bucket type** — switch an existing bucket between Sheet and Doc
  (with its synced data migrated to the new destination).
- **Paywall / subscriptions** — gate premium features (e.g. Excel import/export,
  cloud sync) via a licensing service such as ExtensionPay; the Web Store has no
  built-in payments.
- **Stale doc-map cleanup** — prune `docsDocMap` entries whose Drive files were
  trashed or whose buckets were retyped/deleted.
- **AI assistance** — surface time-sensitive dumps (e.g. "follow up on this
  referral") and suggest the right bucket at capture time.
- **Per-bucket typed fields** — let a bucket define its own columns instead of the
  shared Status/Notes pair.
- **Keyboard-shortcut quick-capture** bar as a third, fastest entry point.
- **Doc-panel body sync** — push the panel's free-form markdown body into the
  bucket's Google Doc (today only captured entries sync; manual panel writing
  stays local).
- **Two-way sync** — reflect edits made in the Sheet/Doc back into Dumpster
  (currently one-way push).

## Third-party

- **SheetJS (xlsx)** — vendored at `vendor/xlsx.mjs`, loaded lazily only when you
  export/import Excel. Licensed **Apache-2.0** (`vendor/SHEETJS-LICENSE.txt`).
