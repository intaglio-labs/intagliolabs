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
# The background is generated, not committed (the repo ignores *.png).
#
# ALWAYS REGENERATED, AND THE DPI IS DERIVED. This was `if [ ! -f ... ]`, so both
# the render and the dpi stamp were skipped whenever the file already existed —
# regenerate the art by hand once and the next release shipped it unstamped at
# 72dpi, which Finder draws far too large in a 600pt window. That is the version
# that shipped.
#
# The dpi is CALCULATED rather than written down, because the pixel size is not
# knowable from the source: make-dmg-bg.swift declares a 1200x800 canvas, but
# NSImage renders at the screen's backing scale, so on a retina Mac it writes
# 2400x1600. A hardcoded number is right for one machine and silently wrong on
# the other — this file has carried two different wrong ones (144 and 288) at the
# same time as a comment claiming a third.
#
# dpi/72 is the scale divisor, so the dpi that makes any width land on 600pt is
# pixels * 72 / 600.
WIN_PT=600
swift icon/make-dmg-bg.swift icon/dmg-bg.png
BG_W=$(sips -g pixelWidth icon/dmg-bg.png | awk '/pixelWidth/{print $2}')
BG_DPI=$(( BG_W * 72 / WIN_PT ))
sips -s dpiWidth "$BG_DPI" -s dpiHeight "$BG_DPI" icon/dmg-bg.png >/dev/null

# Read it back, because a stamp that did not take is invisible until the DMG is
# open in front of somebody.
GOT_DPI=$(sips -g dpiWidth icon/dmg-bg.png | awk '/dpiWidth/{print int($2)}')
GOT_PT=$(( BG_W * 72 / GOT_DPI ))
if [ "$GOT_PT" != "$WIN_PT" ]; then
  echo "ERROR: background is ${BG_W}px at ${GOT_DPI}dpi = ${GOT_PT}pt; the window is ${WIN_PT}pt." >&2
  exit 1
fi
echo "background: ${BG_W}px @ ${GOT_DPI}dpi = ${GOT_PT}pt wide, matching the window"

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
    -- Let Finder finish loading the background and settling the window before
    -- placing anything. Positions set into a window that is still laying itself
    -- out are silently discarded -- osascript still reports success, and the
    -- icons come out on Finder's default grid instead. That is what shipped:
    -- the art expected them at 150/450 and Finder had already put them at its
    -- own spacing, leaving the label plates sitting under nothing.
    delay 2
    set position of item "Intaglio Labs.app" of container window to {150, 210}
    set position of item "Applications" of container window to {450, 210}
    -- Write the positions into .DS_Store, then read them back and put them
    -- again. The first update is what persists them; the second pass is what
    -- makes a silent miss impossible to ship, because the verification below
    -- reads the file this produces.
    update without registering applications
    delay 2
    set position of item "Intaglio Labs.app" of container window to {150, 210}
    set position of item "Applications" of container window to {450, 210}
    update without registering applications
    delay 2
    close
  end tell
end tell
OSA
then
  echo "DMG window styled"
else
  echo "WARNING: Finder styling failed (Automation grant?); shipping unstyled." >&2
fi

# AND CHECK THAT IT ACTUALLY TOOK.
#
# osascript reported success on a run where Finder had silently ignored both
# positions and left the icons on its default grid -- so "styled" is not evidence
# of anything. The background art places an arrow between two icon columns and a
# contrast plate under each icon's NAME; if the icons are not where the art says,
# those plates sit under empty space and the window ships looking broken.
#
# Finder stores the positions it actually used in .DS_Store. Reading them back is
# the only check that cannot agree with itself.
if osascript <<'OSA' > "$DIST/positions.txt" 2>/dev/null
tell application "Finder"
  tell disk "Intaglio Labs"
    open
    delay 1
    set a to position of item "Intaglio Labs.app" of container window
    set b to position of item "Applications" of container window
    close
    return (item 1 of a as text) & "," & (item 2 of a as text) & " " & ¬
           (item 1 of b as text) & "," & (item 2 of b as text)
  end tell
end tell
OSA
then
  GOT=$(tr -d '\n' < "$DIST/positions.txt")
  echo "icon positions: $GOT"
  if [ "$GOT" != "150,210 450,210" ]; then
    echo "ERROR: Finder placed the icons at [$GOT], not [150,210 450,210]." >&2
    echo "       The background art is drawn for those coordinates; shipping this" >&2
    echo "       puts the label plates under empty space. Not shipping it." >&2
    hdiutil detach "$MNT" >/dev/null 2>&1 || true
    exit 1
  fi
  echo "icon positions verified against the art"
fi
rm -f "$DIST/positions.txt"
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
