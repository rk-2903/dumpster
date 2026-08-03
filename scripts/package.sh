#!/usr/bin/env bash
# Build a clean Chrome Web Store zip: dist/ivynotes-v<version>.zip
#
# - Packages only what the store needs (manifest at zip root, src/, popup/viewer
#   files, icons/, vendor/, LICENSE) — no .git, docs, scripts, or dev files.
# - Strips any local "key" field from the packaged manifest (dev-only; the store
#   derives the ID itself — see docs/PUBLISHING.md step 4).
# - Warns if the OAuth client_id is still the placeholder.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v zip >/dev/null || { echo "error: 'zip' not found"; exit 1; }
command -v node >/dev/null || { echo "error: 'node' not found (used to edit manifest)"; exit 1; }

VERSION="$(node -p "JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version")"
OUT="dist/ivynotes-v${VERSION}.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- stage the store payload -------------------------------------------------
cp manifest.json popup.html popup.css popup.js workspace.html workspace.css workspace.js LICENSE "$STAGE/"
cp -R src icons vendor "$STAGE/"

# --- clean the staged manifest ----------------------------------------------
node - "$STAGE/manifest.json" <<'EOF'
const fs = require("fs");
const path = process.argv[2];
const m = JSON.parse(fs.readFileSync(path, "utf8"));

// "key" pins the local dev ID; the store must not receive it.
if (m.key) { delete m.key; console.log("  - stripped dev-only \"key\" from packaged manifest"); }
// Drop the JSON-comment helper field if present.
if (m.oauth2 && m.oauth2["//"]) delete m.oauth2["//"];

fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");

if (m.oauth2 && /REPLACE_WITH_YOUR_CLIENT_ID/.test(m.oauth2.client_id || "")) {
  console.warn("  ! WARNING: oauth2.client_id is still the placeholder — Google sync will not work in this build.");
}
EOF

# --- zip ---------------------------------------------------------------------
mkdir -p dist
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$ROOT/$OUT" .)

echo "Built $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
echo "Contents:"
unzip -l "$OUT" | awk 'NR>3 {print "  " $4}' | sed '/^  *$/d' | head -30
