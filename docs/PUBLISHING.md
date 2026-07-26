# Publishing Dumpster to the Chrome Web Store

The end-to-end path from this repo to a public listing. Most steps are one-time;
after that, releasing an update is just "build zip → upload → re-review".

> **The one wrinkle to understand first:** the Google OAuth client (used for cloud
> sync) is bound to an **extension ID**. Your local unpacked ID and the ID the
> Web Store assigns at first upload are **different**. Step 4 reconciles them —
> don't skip it, or Connect Google will fail in the published version.

## 1. One-time: developer account

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in with the Google account that should own the listing.
3. Pay the **$5 one-time** registration fee.

## 2. Prepare the release

1. Land everything into `main` via a release PR (`dev` → `main`).
2. Bump `"version"` in `manifest.json` (e.g. `0.2.0`).
3. Build the store package:

   ```bash
   ./scripts/package.sh
   ```

   This produces `dist/dumpster-v<version>.zip` containing only what the store
   needs (manifest at the zip root, `src/`, popup/viewer files, `icons/`,
   `vendor/`, `LICENSE`). It also strips any local `"key"` field from the
   packaged manifest and warns if the OAuth `client_id` is still the placeholder.

## 3. First upload → you get your permanent ID

1. Dashboard → **New item** → upload the zip.
2. The store assigns the item's **permanent extension ID**. Note it down.

## 4. Reconcile the OAuth client with the store ID

1. [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services →
   Credentials** → your OAuth client (type: Chrome Extension) → set its
   **Item ID** to the store's extension ID (or create a second client for it and
   put that client's id into `manifest.json`).
2. Recommended: make local dev use the same ID too — in the dashboard's
   **Package** tab copy the item's **public key** and paste it into your local
   `manifest.json` as `"key"`. Then dev and store share one ID and one OAuth
   client. (`package.sh` strips the key from store uploads automatically.)

## 5. OAuth consent screen → Production

1. Cloud Console → **OAuth consent screen** → publish from *Testing* to
   **In production**.
2. Dumpster only uses the **non-sensitive** `drive.file` scope, so no security
   assessment is required. Until you complete (free) brand verification, users
   see an "unverified app" style consent screen — it works, it just looks plain.
3. Make sure the **Google Sheets API** is enabled in the project.

## 6. Store listing

Fill in on the dashboard:

- **Listing**: name, description ("quickly save links, snippets, and notes into
  organized buckets"), category (Productivity), at least one **1280×800**
  screenshot, the 128px icon (already in `icons/`).
- **Privacy practices** tab — this is what actually gates approval:
  - **Privacy policy URL** — deploy `docs/PRIVACY.md` (GitHub Pages works) and
    link it. Required because the extension uses `identity`/user data.
  - **Single purpose**: "Save links, text, and notes into organized buckets for
    later action."
  - **Permission justifications** (copy-paste ready):
    | Permission | Justification |
    |---|---|
    | `storage` | Store the user's buckets and dumps locally. |
    | `contextMenus` | The right-click "Dump to" capture menu. |
    | `tabs` | Read the current tab's URL/title to attach as the dump's source. |
    | `identity` | Optional: connect the user's Google account for cloud sync. |
    | `alarms` | Retry queued cloud-sync writes in the background. |
    | `scripting` + `activeTab` | On the current tab only, and only when the user acts: the "name your new bucket" prompt, the drag-a-region screenshot overlay, visible-tab capture, and the on-demand selection helper. No page content is read except the user's explicit text selection when they click a helper button. Uses `activeTab` (current tab, on gesture) — **no `<all_urls>` / broad host access**. |
    | `sidePanel` | The optional study panel (notes + screenshots pinned beside a page). |
    | Host permissions (googleapis.com) | Optional cloud sync writes to the user's own Google Sheet; no other hosts are contacted. |
  - Data-use disclosures: data stays on-device or in the user's own Google
    Drive; nothing is transmitted to the developer.

## 7. Submit for review

- Click **Submit for review**. Typical turnaround is hours to a few days;
  `tabs` + `identity` can draw a closer look — the justifications above cover it.
- Once approved, the listing is public and anyone can install it.

## Releasing updates

1. Merge changes to `main`, bump `manifest.json` version.
2. `./scripts/package.sh` → upload the new zip on the item's **Package** tab →
   submit. Users receive the update automatically after review.

## Notes

- The OAuth `client_id` in `manifest.json` is **not a secret** — extension OAuth
  clients have no client secret and the id ships in every install.
- The Web Store has **no built-in payments**. A future paywall would use a
  licensing service (e.g. ExtensionPay) — see the roadmap.
