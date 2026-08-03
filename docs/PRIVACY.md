---
layout: default
title: Privacy Policy
---

# IvyNotes Privacy Policy

_Last updated: 3 August 2026_

IvyNotes is a Chrome extension for saving links, text snippets, and notes into
organized buckets. It is built to be **local-first**: your data belongs to you
and stays on your device unless *you* connect your own Google account.

## What data IvyNotes handles

- **Content you save ("dumps")** — the text or links you choose to save, the
  bucket you file them under, and any status or notes you add.
- **Screenshots you take** — captured only when you explicitly use a screenshot
  action (popup button, right-click menu, keyboard shortcut, or study panel),
  and stored on your device.
- **Text you select** — the optional selection helper is injected only into the
  current tab, on demand (when you open the IvyNotes popup), never into your
  other tabs or in the background. It shows a floating pill when you select
  text, and reads **only the text you selected, and only at the moment you click
  one of its buttons** (H1/H2/list/paragraph) to save it. It does not read,
  collect, or transmit anything else from the page, and you can turn it off from
  the popup.
- **Page context** — when you save from a page, the current tab's URL and title
  are attached to that dump so you remember where it came from.
- **Voice input (optional)** — the doc panel's mic button dictates notes using
  your **browser's built-in speech recognition** (the Web Speech API). While the
  mic is on, Chrome streams the audio to **Google's speech service** to turn it
  into text — that processing is done by your browser under Google's terms, not
  by IvyNotes. IvyNotes itself **never records, stores, or transmits audio**;
  only the recognized text lands in your doc, on your device. The mic is only
  active while the button glows red, microphone access is granted once by you
  and revocable anytime (`chrome://settings/content/microphone`), and the
  feature simply stays off if you never grant it.

- **AI features (optional, bring your own)** — Summarize / Flashcards / Quiz /
  Ask are **off until you connect a provider of your choice**: your own Google
  Gemini, OpenAI or Anthropic API key, or a local Ollama model on your machine.
  When you run an AI action, the text of the doc is sent **directly to the
  provider you chose** — to Google, OpenAI or Anthropic under your own key and
  that company's terms, or to your own computer for Ollama, which never goes
  online at all. Only the active provider's key is ever used or transmitted. **Ask your notes** additionally
  searches across *all* your buckets and sends only the excerpts that match
  your question (nothing is sent when nothing matches). Ollama must be a
  local or private-network address — the extension refuses a remote host, so
  "stays on your machine" stays true. Your API key and settings are stored only on your
  device, nothing passes through any developer server, and no AI request ever
  happens except when you click an AI action.

IvyNotes has no user accounts, no advertising, and no cross-site tracking, and
it never reads your browsing history. It does send **anonymous usage
statistics** to help decide what to improve — described in its own section
below.

## Anonymous usage statistics

To understand how many people use IvyNotes and which features matter, the
extension sends a small amount of **anonymous** usage data. It is **enabled**,
and there is currently **no setting in the extension to turn it off** —
uninstalling IvyNotes stops it completely (see *How to stop it* below). The data
is anonymous by construction: it is tied to a random identifier created on your
device and can never be connected to you, your Google account, or anything you
save.

- **What is collected:** a random identifier generated on your device (a UUID —
  not derived from you, your account, or your hardware), the name of an event
  (for example `install`, a daily `active` ping, a `feature` used such as
  "screenshot" or "export", or an `error` count), the extension version, and
  your browser's language. That's the whole list.
- **What is never collected:** the content of your dumps, the text you select,
  your screenshots, the URLs or titles of pages you visit, your Google account
  or email, or anything from your Google Drive. Usage events carry counts and
  short labels only — never your data.
- **Where it goes:** to the developer's own Supabase project, used solely to
  produce aggregate counts (active users, feature usage, retention, error
  rates). It is not sold, shared, or used for advertising or profiling.
- **Uninstall:** removing the extension opens a page that records a single
  anonymous `uninstall` event (the random identifier only).
- **How to stop it:** uninstalling IvyNotes ends all of it — the random
  identifier and anything still queued are stored on your device and are removed
  with the extension. A visible on/off setting is planned for a future release;
  until then, uninstalling is the way to stop collection.

## Where your data lives

- **On your device.** All data is stored locally in your browser
  (IndexedDB and Chrome extension storage). It is not transmitted to the
  developer or to any third party.
- **Optionally, in your own Google Drive.** If you choose to connect your
  Google account, IvyNotes mirrors your dumps into a spreadsheet and/or Google
  Docs **in your own Google Drive**, using Google's narrow `drive.file`
  permission — which only allows access to files this extension itself creates.
  IvyNotes cannot see the rest of your Drive, and your data still never touches
  the developer's servers (there are none).
- **Screenshot sync detail.** Google's Docs API can only ingest images from a
  reachable URL. When a screenshot syncs into one of your Docs, IvyNotes
  uploads it to your Drive, makes that single file link-visible (an unguessable
  address) for the few seconds Google needs to copy it into the document, then
  deletes the temporary file. Screenshot text extraction (search inside your
  screenshots) uses Drive's built-in OCR: a temporary converted document is
  created in your Drive and deleted immediately after the text is read.

## What IvyNotes never does

- No selling, sharing, or transferring of your data to third parties.
- No use of your data for advertising, profiling, or creditworthiness purposes.
- No transmission of *your content* anywhere except, at your explicit choice, to
  your own Google Drive. The only other network traffic is the anonymous usage
  statistics described above (which you can turn off) — never your dumps,
  selections, screenshots, page URLs, or Google data.

## Google user data (Limited Use disclosure)

IvyNotes's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Specifically: Google user data is used
only to provide the user-facing cloud-sync feature described above, is not
transferred to third parties, and is not used for advertising.

## Permissions, in plain language

| Permission | Why IvyNotes needs it |
|---|---|
| Storage | Keep your buckets and dumps on your device. |
| Context menus | The right-click "Dump to" menu. |
| Tabs | Attach the current page's URL/title to a dump you save. |
| Identity | Only if you connect Google: sign-in for cloud sync. |
| Alarms | Retry cloud-sync writes in the background if you're offline. |
| Scripting (active tab only) | Show the "name your new bucket" prompt and the drag-a-region screenshot overlay on the current page. Nothing is read from the page. |
| Optional site access (on request) | Nothing at install. The first time you use the doc panel's region/OCR capture buttons, Chrome shows its own one-time prompt asking to allow access on websites — required because Chrome's screen-capture API only accepts that broad grant. IvyNotes uses it solely to draw the selection overlay and capture the visible tab when *you* click a capture button; it still never reads pages in the background. Revocable anytime at `chrome://extensions` → IvyNotes → Site access. |
| Side panel | The optional study panel you can pin beside a page. |
| googleapis.com access | Only if you connect Google: write to your own Sheet. |
| supabase.co access | Send the anonymous usage statistics described above. |

## Deleting your data

- **Local data**: delete entries/buckets in the extension, or remove the
  extension entirely — local data is deleted with it.
- **Synced data**: the mirrored spreadsheet lives in *your* Drive — delete it
  like any of your files.
- **Google access**: disconnect inside the extension, or revoke IvyNotes's
  access anytime at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Changes to this policy

If this policy changes materially, the updated version will be posted at this
URL with a new "last updated" date.

## Contact

Questions about this policy: **rahulkumar6611@gmail.com**
