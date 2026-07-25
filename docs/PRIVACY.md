# Dumpster — Privacy Policy

_Last updated: [SET DATE BEFORE DEPLOYING]_

Dumpster is a Chrome extension for saving links, text snippets, and notes into
organized buckets. It is built to be **local-first**: your data belongs to you
and stays on your device unless *you* connect your own Google account.

## What data Dumpster handles

- **Content you save ("dumps")** — the text or links you choose to save, the
  bucket you file them under, and any status or notes you add.
- **Screenshots you take** — captured only when you explicitly use a screenshot
  action (popup button, right-click menu, keyboard shortcut, or study panel),
  and stored on your device.
- **Page context** — when you save from a page, the current tab's URL and title
  are attached to that dump so you remember where it came from.

That's all. Dumpster has no accounts, no analytics, no tracking, and no
advertising. It never reads your browsing history.

## Where your data lives

- **On your device.** All data is stored locally in your browser
  (IndexedDB and Chrome extension storage). It is not transmitted to the
  developer or to any third party.
- **Optionally, in your own Google Drive.** If you choose to connect your
  Google account, Dumpster mirrors your dumps into a spreadsheet and/or Google
  Docs **in your own Google Drive**, using Google's narrow `drive.file`
  permission — which only allows access to files this extension itself creates.
  Dumpster cannot see the rest of your Drive, and your data still never touches
  the developer's servers (there are none).
- **Screenshot sync detail.** Google's Docs API can only ingest images from a
  reachable URL. When a screenshot syncs into one of your Docs, Dumpster
  uploads it to your Drive, makes that single file link-visible (an unguessable
  address) for the few seconds Google needs to copy it into the document, then
  deletes the temporary file. Screenshot text extraction (search inside your
  screenshots) uses Drive's built-in OCR: a temporary converted document is
  created in your Drive and deleted immediately after the text is read.

## What Dumpster never does

- No selling, sharing, or transferring of your data to third parties.
- No use of your data for advertising, profiling, or creditworthiness purposes.
- No transmission of your data anywhere except, at your explicit choice, to
  your own Google Drive.

## Google user data (Limited Use disclosure)

Dumpster's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Specifically: Google user data is used
only to provide the user-facing cloud-sync feature described above, is not
transferred to third parties, and is not used for advertising.

## Permissions, in plain language

| Permission | Why Dumpster needs it |
|---|---|
| Storage | Keep your buckets and dumps on your device. |
| Context menus | The right-click "Dump to" menu. |
| Tabs | Attach the current page's URL/title to a dump you save. |
| Identity | Only if you connect Google: sign-in for cloud sync. |
| Alarms | Retry cloud-sync writes in the background if you're offline. |
| Scripting (active tab only) | Show the "name your new bucket" prompt and the drag-a-region screenshot overlay on the current page. Nothing is read from the page. |
| Side panel | The optional study panel you can pin beside a page. |
| googleapis.com access | Only if you connect Google: write to your own Sheet. |

## Deleting your data

- **Local data**: delete entries/buckets in the extension, or remove the
  extension entirely — local data is deleted with it.
- **Synced data**: the mirrored spreadsheet lives in *your* Drive — delete it
  like any of your files.
- **Google access**: disconnect inside the extension, or revoke Dumpster's
  access anytime at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Changes to this policy

If this policy changes materially, the updated version will be posted at this
URL with a new "last updated" date.

## Contact

Questions about this policy: **[ADD CONTACT EMAIL BEFORE DEPLOYING]**
