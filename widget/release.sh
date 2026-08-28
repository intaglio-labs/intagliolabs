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
#   3. Notary credentials stored once, from an App Store Connect API key
#      (Users and Access > Integrations). NOT an Apple ID and app-specific
#      password: that is a credential for the whole Apple account wearing a
#      narrower name, while the key is scoped to the API, revocable on its own,
#      owned by the team rather than a person, and not behind anyone's 2FA.
#        xcrun notarytool store-credentials hazlie-notary \
#          --key AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-UUID>
#      Omit --issuer for an Individual key; notarytool requires it for a Team
#      key and refuses it for an Individual one.
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

# A TAG IS ALSO PROVENANCE, and on a release runner it is the only kind
# available: a tag build checks out a detached HEAD, so the branch test below can
# never pass there and the ref this script would compare against may not have
# been fetched at all.
#
# This is not a bypass, it is the same question answered by a different fact. The
# guard asks "can somebody else fetch the exact code this DMG was built from".
# `HEAD == origin/main` answers it for a laptop. An annotated tag that GitHub
# resolves to this commit, on a commit that is an ancestor of origin/main,
# answers it at least as well -- and it answers a second question the laptop path
# cannot, which is WHICH release this is.
#
# Dirtiness is checked above and is NOT excused here: a runner with a modified
# tree means something wrote to the checkout, and that is worth stopping for
# wherever it happens.
# HZ_RELEASE_TAG names the tag being built. It is set explicitly by the caller
# rather than read out of GitHub's own GITHUB_REF_*, because those describe the
# ref the WORKFLOW ran on: on a manual re-run they say "branch main" even while
# the job is checked out at a tag, and a guard that believes them would be
# guarding the wrong thing. An explicit variable is also what makes this testable
# outside CI at all.
TAGGED=0
if [ -n "${HZ_RELEASE_TAG:-}" ]; then
  TAG_COMMIT="$(git rev-parse --verify --quiet "refs/tags/${HZ_RELEASE_TAG}^{commit}" || echo '')"
  if [ -z "$TAG_COMMIT" ]; then
    RELEASABLE=0; WHY="$WHY
  - HZ_RELEASE_TAG='${HZ_RELEASE_TAG}' is not a tag in this checkout
    (a shallow clone has no tags -- fetch-depth: 0)"
  elif [ "$TAG_COMMIT" != "$(git rev-parse HEAD)" ]; then
    RELEASABLE=0; WHY="$WHY
  - HEAD is not the commit tag '${HZ_RELEASE_TAG}' points at"
  elif ! git merge-base --is-ancestor HEAD refs/remotes/origin/main 2>/dev/null; then
    RELEASABLE=0; WHY="$WHY
  - tag '${HZ_RELEASE_TAG}' is not on origin/main, so this code was never
    merged (fetch main before releasing)"
  else
    TAGGED=1
  fi
fi

if [ "$TAGGED" = 0 ]; then
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
HAZLIE_STAGE_DIR="$PWD/build" \
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

# The DMG: app + Applications symlink over a minimal installer background.
# The background carries only the drag instruction and arrow; Finder still
# supplies the native window chrome and icon labels.
STAGE="$DIST/stage"
mkdir -p "$STAGE/.background"
cp -R "$APP" "$STAGE/Intaglio Labs.app"
# Finder provenance can be attached to a copied bundle after it is signed.
# A staged DMG must be just as clean as the /Applications install copy or
# codesign will reject the app a user drags out of it.
xattr -cr "$STAGE/Intaglio Labs.app" 2>/dev/null || true
# Render at the actual backing scale and stamp it to the 600pt Finder window.
WIN_PT=600
BG="$DIST/dmg-bg.png"
swift icon/make-dmg-bg.swift "$BG"
BG_W=$(sips -g pixelWidth "$BG" | awk '/pixelWidth/{print $2}')
BG_DPI=$(( BG_W * 72 / WIN_PT ))
sips -s dpiWidth "$BG_DPI" -s dpiHeight "$BG_DPI" "$BG" >/dev/null
cp "$BG" "$STAGE/.background/bg.png"
rm -f "$BG"
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
osascript <<'OSA' >/dev/null 2>&1 || true
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
    delay 1
    set position of item "Intaglio Labs.app" of container window to {150, 210}
    set position of item "Applications" of container window to {450, 210}
    update without registering applications
    delay 1
    close
  end tell
end tell
OSA
# Finder records icon-layout metadata while the image is mounted. It can attach
# that metadata to the app bundle itself, which codesign refuses, so remove it
# before the image is detached and compressed.
xattr -cr "$MNT/Intaglio Labs.app" 2>/dev/null || true
codesign --verify --strict --deep "$MNT/Intaglio Labs.app"
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
