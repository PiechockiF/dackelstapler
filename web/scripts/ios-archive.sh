#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

mode="release"
case "${1:-}" in
  --preflight) mode="preflight" ;;
  "") ;;
  *) echo "Usage: npm run ios:archive OR npm run ios:preflight" >&2; exit 1 ;;
esac

unset CAP_SERVER_URL CAP_LIVE_RELOAD

npm run build:local
npx cap sync ios
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const config = JSON.parse(readFileSync("ios/App/App/capacitor.config.json", "utf8"));
  if (config.server?.url) throw new Error("Offline archive must not load a remote server URL.");
  const catalog = JSON.parse(readFileSync("ios/App/App/public/offline/catalog.json", "utf8"));
  if (!catalog.sites?.length) throw new Error("Offline catalog missing from native bundle.");
'

# Desktop may be synced by iCloud, which adds Finder metadata to build products
# and makes codesign fail. Keep derived data and archives in Xcode's local folders.
xcode_root="$HOME/Library/Developer/Xcode"
archive_dir="$xcode_root/Archives/$(date +%Y-%m-%d)"
archive_path="$archive_dir/SiteTwin-$mode-$(date +%H-%M-%S).xcarchive"
mkdir -p "$archive_dir"

xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$xcode_root/DerivedData/SiteTwin" \
  -archivePath "$archive_path" \
  -allowProvisioningUpdates \
  archive

codesign --verify --deep --strict "$archive_path/Products/Applications/App.app"
echo "Archive: $archive_path"
echo "Self-contained local build. No server or tunnel required."
