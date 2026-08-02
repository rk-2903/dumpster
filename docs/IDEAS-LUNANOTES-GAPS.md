# Feature gap analysis — LunaNotes (lunanotes.io)

_Analyzed 2026-08-02 from [lunanotes.io](https://lunanotes.io/), its
[YouTube extension page](https://lunanotes.io/features/youtube-extension),
[timestamps page](https://lunanotes.io/features/timestamps), pricing page, and the
[Chrome Web Store listing](https://chromewebstore.google.com/detail/lunanotes-take-notes-on-y/oehoffnnkgcdacmbkhmlbjedinpampak)._

LunaNotes is an AI note-taking app centered on **watching YouTube with a note panel
beside the player**: notes are auto-timestamped, clicking a note jumps the video,
screenshots can be annotated, and AI turns transcripts into summaries, flashcards,
quizzes, and concept diagrams. It's a **cloud workspace** (accounts, cross-device sync,
real-time collaboration, AI chat over your library) with a freemium model
($0 / $4.99 / $9.99 per month, AI metered by credits).

## Where we already stand

Dumpster overlaps more than expected, with a different center of gravity:

| Theirs | Ours today |
|---|---|
| Transcript pulled from videos | ✅ Transcript capture (last 30s/60s/full, `[m:ss]` stamps, `&t=` deep links) |
| Screenshots while watching | ✅ Visible/region screenshots + OCR (any page, not just YouTube) |
| Notes beside the content | ✅ Side-panel markdown editor with formatting toolbar |
| Cloud sync to their servers | ✅ Sync to **your own** Google Docs/Sheets (privacy advantage) |
| — | ✅ Voice dictation in ~100 languages (LunaNotes has nothing comparable) |
| — | ✅ Key/value trackers, status pills, Excel/JSON/PDF/DOCX/MD export |

Our structural advantages to preserve: **local-first, no accounts, no developer
servers, data in the user's own Drive, free**.

## Gaps — what we could implement

### Tier 1 — natural fits (no servers, no AI, mostly panel/content-script work)

1. **Live timestamped video notes** ⭐ their signature feature
   - While a YouTube tab is active, every note/paragraph written in the panel gets the
     current `video.currentTime` stamp automatically (we already stamp transcript
     captures — extend to hand-written notes).
   - **Click a `[m:ss]` stamp in the panel → seek the video** to that moment (message
     to the content script → `video.currentTime = t`). Today our deep links open a new
     navigation; in-place seek is the delight factor.
   - **Auto-pause while typing** in the panel, resume on blur (toggleable).
2. **Transcript view beside the video** — we already scrape the transcript for capture;
   render it in a panel drawer (click a line → seek; select lines → save to doc).
3. **Screenshot annotation** — a lightweight canvas step (arrow, box, highlight, crop)
   between capture and save. Applies to all our capture paths, not just YouTube.
4. **Save a full article/page to a doc** — one-click readability-style extraction of
   the current page into the active doc (we only capture selections today).
5. **Tags + cross-bucket search** — LunaNotes has tags/folders and library-wide
   search; we only have per-bucket filter. A global search box in the workspace over
   all buckets (content, keys, OCR text) is cheap and high-value; tags can follow.
6. **Text highlight color in notes** — markdown `==highlight==` support in the editor,
   preview, and Docs sync (their formatting palette is richer than ours).

### Tier 2 — AI features (need a model; keep local-first via BYO key)

LunaNotes' AI is its paid engine: summaries, flashcards, quizzes, concept diagrams,
AI chat with citations, auto-structured notes. We can match the useful subset without
running servers by letting users **bring their own API key** (stored locally, calls go
direct from the extension to the provider) — or gate behind the roadmap's paywall later.

7. ✅ **One-click video/page summary** — shipped: ✨ → Summarize doc (appends `## Summary`).
8. ✅ **Flashcards from a doc** — shipped: ✨ → Flashcards → key/value tracker
   (key = question, data = answer); review mode still open.
9. ✅ **Quiz me** — shipped: ✨ → Quiz me (MCQ overlay with explanations + score).
10. **Concept diagrams** — generate Mermaid from a doc's content; render in preview
    (markdown-native, no proprietary canvas needed).
11. ✅ **Ask your notes** — shipped: ✨ → Ask your notes (keyword retrieval over all
    buckets, cited answers, insert-into-doc). Embeddings still optional later.
12. **Auto-structured notes** — turn a raw transcript capture into
    headings/bullets (H1/H2/list formats already exist end-to-end).

### Tier 3 — bigger bets / philosophy trade-offs (decide deliberately)

13. **Cross-device sync** — LunaNotes syncs via their cloud. Our local-first
    equivalent: mirror the local DB into the user's own Drive appData folder and
    restore on another machine. No developer servers needed, but real conflict-handling
    work.
14. **Collaboration/sharing** — theirs is real-time co-editing (needs servers —
    conflicts with our philosophy). Our 80% answer already exists: the synced Google
    Doc/Sheet **is** shareable; make that a first-class "Share with others" flow
    (set link-sharing + copy link from the panel).
15. **Podcast / meeting transcription** — they ingest audio files and Meet recordings
    (metered). Heavy; our voice dictation covers the live-capture case. Revisit only
    with on-device Whisper-class models.
16. **Calendar auto-recording** — out of character for a capture tool; skip.
17. **MCP server** — they expose notes to AI agents. Intriguing and differentiating
    (a local MCP server over the user's own buckets); exploratory.
18. **Freemium/monetization** — their model validates the roadmap's existing
    paywall item (AI credits are the natural meter if Tier 2 lands without BYO keys).

## Suggested order

| Priority | Items | Why |
|---|---|---|
| Quick wins | 1 (stamps + click-to-seek), 2 (transcript drawer), 5 (global search) | Biggest study-flow payoff, zero new dependencies |
| Next | 3 (annotation), 4 (save article), 6 (highlight) | Rounds out capture quality |
| Then | 7, 8, 10 (summary, flashcards, diagrams via BYO key) | Matches their AI headline features while staying serverless |
| Deliberate decisions | 13, 14, 17, 18 | Each changes product posture; discuss before building |
