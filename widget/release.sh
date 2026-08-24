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
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --no-notarize) NOTARIZE=0 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) echo "unknown flag: $arg (--no-notarize, --allow-dirty)" >&2; exit 1 ;;
  esac
done

# --- provenance guard ---------------------------------------------------------
#
# WHAT THIS EXISTS TO PREVENT. Everything past this point signs with Developer
# ID, notarizes, staples, and writes a DMG that Gatekeeper clears silently on
# any Mac in the world. And it builds from the WORKING TREE -- whatever files
# happen to be on disk the moment it runs. Put those two facts together and a
# release is one mistyped command away from being somebody's half-finished
# branch, delivered to every downloader with Apple's blessing on it.
#
# This is not hypothetical. The tree this ships from is a SHARED checkout that
# other people and other sessions work in: on 2026-08-24 it changed branch three
# times in one day, and sat with uncommitted edits in widget/ui/ for much of it.
# Nothing in this script had ever looked at any of that.
#
# The rule: a release comes from a commit that is on main, clean, and already
# pushed. "Pushed" is not bureaucracy -- it is the line between shipping code
# somebody can read and shipping code that exists only on this Mac. If the DMG
# turns out to be broken, the first question is always "what is in it", and an
# unpushed commit cannot answer.
#
# --allow-dirty does NOT bypass the guard. It changes the OUTPUT: the DMG is
# renamed so it can never be handed out as a release by accident. That is the
# only escape hatch, and it is deliberately one that leaves a mark.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: not a git checkout, so this build cannot be traced to a commit." >&2
  echo "       Release from a clone. (A tarball build is fine for yourself --" >&2
  echo "       use widget/build.sh, which does not sign or notarize.)" >&2
  exit 1
fi

COMMIT="$(git rev-parse --short HEAD)"
BRANCH="$(git symbolic-ref --quiet --short HEAD || echo '(detached)')"
DIRT="$(git status --porcelain)"
RELEASABLE=1
WHY=""

[ -n "$DIRT" ] && { RELEASABLE=0; WHY="$WHY
  - the working tree has uncommitted changes:
$(printf '%s\n' "$DIRT" | sed 's/^/      /' | head -10)"; }

[ "$BRANCH" = main ] || { RELEASABLE=0; WHY="$WHY
  - HEAD is on '$BRANCH', not main"; }

# Compared against the LOCAL origin/main ref, and deliberately not preceded by a
# fetch: a build script that reaches the network to decide what it is allowed to
# ship can be answered differently on two runs a minute apart. Staleness is
# named in the failure text instead, so the person reading it knows to fetch.
if git rev-parse --verify --quiet origin/main >/dev/null; then
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
    RELEASABLE=0; WHY="$WHY
  - HEAD is not origin/main, so this code is not pushed anywhere
    (run 'git fetch' first if origin/main looks stale)"; }
else
  RELEASABLE=0; WHY="$WHY
  - there is no origin/main to compare against"
fi

if [ "$RELEASABLE" = 0 ] && [ "$ALLOW_DIRTY" = 0 ]; then
  echo "ERROR: refusing to build a release from this tree.$WHY" >&2
  echo "" >&2
  echo "  A release is signed, notarized and stapled -- once it is on your" >&2
  echo "  download page it is indistinguishable from a real one, and users get" >&2
  echo "  it silently. Commit, push to main, and re-run." >&2
  echo "" >&2
  echo "  For a test build, re-run with --allow-dirty; the DMG is then named" >&2
  echo "  so it cannot be mistaken for a release." >&2
  exit 1
fi

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
# its own scan cannot pick Apple Development first, and the provenance the
# guard above established so the stamp inside the bundle agrees with it.
HAZLIE_SIGN_IDENTITY="$IDENTITY" \
  HZ_SOURCE_COMMIT="$COMMIT" \
  HZ_SOURCE_CLEAN="$([ -z "$DIRT" ] && echo 1 || echo 0)" \
  ./build.sh

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
# A build the guard would have refused carries that fact in its FILENAME. The
# version string alone is hand-maintained in Info.plist and identical across
# every build of a given version, so it cannot distinguish a release from a
# scratch build sitting in the same folder a week later -- and the one that gets
# uploaded is whichever one the tab-completion found.
if [ "$RELEASABLE" = 1 ]; then
  DMG="$DIST/IntaglioLabs-$VERSION.dmg"
else
  DMG="$DIST/IntaglioLabs-$VERSION-NOT-A-RELEASE-$COMMIT$([ -n "$DIRT" ] && echo '-dirty').dmg"
  echo "NOTE: --allow-dirty -- writing $(basename "$DMG")" >&2
fi
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
