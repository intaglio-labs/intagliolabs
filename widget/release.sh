#!/bin/sh
# Tier A release (widget/APP-PLAN.md): a notarized, Gatekeeper-clean
# Hazlie.app in a DMG, distributable outside the App Store. Same shape as
# build.sh: no Xcode project, no third-party tools.
#
#   widget/release.sh              build, sign, notarize, staple, DMG
#   widget/release.sh --no-notarize  skip Apple (unsigned-for-web dry run)
#
# One-time setup this script cannot do for you (see APP-PLAN.md Phase 1):
#   1. Apple Developer Program membership on the shipping entity.
#   2. A "Developer ID Application" certificate in the login keychain
#      (Xcode > Settings > Accounts > Manage Certificates, or the portal).
#   3. Notary credentials stored once:
#        xcrun notarytool store-credentials hazlie-notary \
#          --apple-id <appleid> --team-id <TEAMID> --password <app-specific>
set -eu
cd "$(dirname "$0")"

NOTARIZE=1
[ "${1:-}" = "--no-notarize" ] && NOTARIZE=0

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Info.plist)"

# Release signs with Developer ID ONLY — an Apple Development cert produces
# an app other Macs refuse, which is worse than failing here.
IDENTITY="${HAZLIE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | awk '/Developer ID Application/ {print $2; exit}')}"
if [ -z "$IDENTITY" ]; then
  echo "ERROR: no 'Developer ID Application' certificate in the keychain." >&2
  echo "       Release builds cannot use the Apple Development identity —" >&2
  echo "       other Macs refuse it. See the setup steps at the top of" >&2
  echo "       this script; then re-run." >&2
  exit 1
fi

# build.sh does the compile, bundle and (re)sign; hand it the identity so
# its own scan cannot pick Apple Development first.
HAZLIE_SIGN_IDENTITY="$IDENTITY" ./build.sh

APP="build/Intaglio Labs.app"
DIST=build/dist
rm -rf "$DIST"
mkdir -p "$DIST"

codesign --verify --strict --deep "$APP"

if [ "$NOTARIZE" = 1 ]; then
  # Notarize the app (zip is the submission container), then staple the
  # ticket to the app itself so it verifies offline.
  ditto -c -k --keepParent "$APP" "$DIST/IntaglioLabs-$VERSION.zip"
  xcrun notarytool submit "$DIST/IntaglioLabs-$VERSION.zip" \
    --keychain-profile hazlie-notary --wait
  xcrun stapler staple "$APP"
  rm "$DIST/IntaglioLabs-$VERSION.zip"
fi

# The DMG: app + Applications symlink over the drag-here background
# (icon/dmg-bg.png, drawn by icon/make-dmg-bg.swift). The window layout is a
# .DS_Store Finder writes for us: build read-write, mount, let Finder set the
# view, convert to compressed. Finder scripting needs the one-time Automation
# grant; if it is refused the DMG still builds, just unstyled, and says so.
STAGE="$DIST/stage"
mkdir -p "$STAGE/.background"
cp -R "$APP" "$STAGE/Intaglio Labs.app"
# The background is generated, not committed (the repo ignores *.png):
# rendered at 2x and stamped 288dpi so the 600x400 point window is crisp.
if [ ! -f icon/dmg-bg.png ]; then
  swift icon/make-dmg-bg.swift icon/dmg-bg.png
  sips -s dpiWidth 288 -s dpiHeight 288 icon/dmg-bg.png >/dev/null
fi
cp icon/dmg-bg.png "$STAGE/.background/bg.png"
ln -s /Applications "$STAGE/Applications"
DMG="$DIST/IntaglioLabs-$VERSION.dmg"
RW="$DIST/rw.dmg"
rm -f "$RW" "$DMG"
hdiutil create -volname "Intaglio Labs" -srcfolder "$STAGE" -ov -format UDRW "$RW" >/dev/null
MNT=$(hdiutil attach "$RW" -readwrite -noverify -noautoopen | awk -F'\t' '/\/Volumes\//{print $3}')
if osascript <<'OSA'
tell application "Finder"
  tell disk "Intaglio Labs"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 200, 800, 600}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 100
    set background picture of viewOptions to file ".background:bg.png"
    set position of item "Intaglio Labs.app" of container window to {150, 210}
    set position of item "Applications" of container window to {450, 210}
    close
    open
    update without registering applications
    delay 1
    close
  end tell
end tell
OSA
then
  echo "DMG window styled"
else
  echo "WARNING: Finder styling failed (Automation grant?); shipping unstyled." >&2
fi
sync
hdiutil detach "$MNT" >/dev/null
hdiutil convert "$RW" -format UDZO -o "$DMG" >/dev/null
rm -f "$RW"
rm -rf "$STAGE"

codesign --force -s "$IDENTITY" "$DMG"
if [ "$NOTARIZE" = 1 ]; then
  # Notarize and staple the DMG too, so Gatekeeper clears it before the
  # user ever mounts it.
  xcrun notarytool submit "$DMG" --keychain-profile hazlie-notary --wait
  xcrun stapler staple "$DMG"
  # The proof: what a downloader's Gatekeeper will conclude.
  spctl --assess --type open --context context:primary-signature -v "$DMG"
fi

echo "release: $DMG (v$VERSION)"
