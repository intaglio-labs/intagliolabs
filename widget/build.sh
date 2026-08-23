#!/bin/sh
# Build the Hazlie desktop widget: one swiftc invocation, a bundle assembled
# by hand, an ad-hoc signature. No Xcode project, no SwiftPM, no third-party
# code — the same shape as the ops/setup-*.sh scripts.
#
#   widget/build.sh            build + install to ~/Applications/Hazlie.app
#   widget/build.sh --run      ...and (re)launch it
set -eu
cd "$(dirname "$0")"

mkdir -p build
# Pin the target: swiftc's default is the SDK's OS, which can be NEWER than
# the running system — LaunchServices then refuses the app with -10825.
swiftc -O -target "$(uname -m)-apple-macos13.0" \
  -o build/Hazlie src/main.swift src/Windows.swift src/Bridge.swift src/AssetScheme.swift src/BridgeLogin.swift src/Provision.swift

APP="build/Intaglio Labs.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/ui"
cp Info.plist "$APP/Contents/Info.plist"
cp build/Hazlie "$APP/Contents/MacOS/Hazlie"
# The icon is a committed artifact (icon/Hazlie.icns); regenerate with
# icon/make-icon.swift + iconutil when the face changes.
cp icon/Hazlie.icns "$APP/Contents/Resources/Hazlie.icns"
# The way out ships with the way in: testers who can't cleanly leave don't
# install twice (APP-PLAN.md phase 2).
cp uninstall.sh "$APP/Contents/Resources/uninstall.sh"
cp ui/* "$APP/Contents/Resources/ui/"
# The ported voice core, served to the ear page at /lib/ by the asset scheme.
mkdir -p "$APP/Contents/Resources/ui/lib"
cp voice/lib/* "$APP/Contents/Resources/ui/lib/"

# ---------------------------------------------------------------------------
# SELF-CONTAINED BACKEND (widget/src/Provision.swift renders + loads this at
# first run). A DOWNLOADED app has no repo, no Homebrew, no network — so the
# local services (connect, hermes, connectors) and the node they run on ship
# INSIDE the app. Provision copies node to the stable ~/.hazlie/bin/node (FDA
# attaches to that path, not the re-signed bundle) and points the launchd
# plists' code paths at this backend dir.
BE="$APP/Contents/Resources/backend"
rm -rf "$BE"; mkdir -p "$BE"
# Builtins-only services + the connectors' pure-JS deps. NOT ui/node_modules:
# it carries native ABIs (onnxruntime/sharp) left over from the deleted Expo
# tree, ui/package.json declares zero deps, and hermes is node builtins only.
# build.sh runs from widget/, so the backend sources are one up, at the repo
# root (../). (widget/ui is the app's own pages; the backend's ui/server is a
# different tree at the repo root.)
# Mirror the repo layout exactly, because the plists reference @REPO@-relative
# paths (@REPO@/ui/server/hermes.mjs, @REPO@/connect/server.mjs, …) and
# distill-once.mjs reads prompts/ relative to the repo root. Provision sets
# @REPO@ to this backend dir, so every one of those paths must resolve here.
mkdir -p "$BE/ui"
cp -R ../connect "$BE/connect"
cp -R ../ui/server "$BE/ui/server"
cp -R ../ui/scripts "$BE/ui/scripts"
cp -R ../prompts "$BE/prompts"
cp -R ../connectors "$BE/connectors"
cp -R ../common "$BE/common"
# Runtime doesn't need the test trees.
find "$BE" -type d -name test -prune -exec rm -rf {} + 2>/dev/null || true

# NODE RUNTIME: the small wrapper + its libnode dylib, with the wrapper's
# @rpath reference rewritten to @executable_path/../lib so it finds the dylib
# next to itself — true both here (node/bin + node/lib) and once provision
# copies them to ~/.hazlie/bin + ~/.hazlie/lib.
NODE_SRC="$(readlink -f "$(command -v node)")"
LIBREF="$(otool -L "$NODE_SRC" | awk '/libnode/{print $1; exit}')"
LIBNAME=""
mkdir -p "$BE/node/bin" "$BE/node/lib"
cp "$NODE_SRC" "$BE/node/bin/node"; chmod 755 "$BE/node/bin/node"
if [ -n "$LIBREF" ]; then
  LIBNAME="$(basename "$LIBREF")"
  for c in "$(dirname "$NODE_SRC")/../lib/$LIBNAME" "$(dirname "$NODE_SRC")/$LIBNAME"; do
    [ -f "$c" ] && { cp "$c" "$BE/node/lib/$LIBNAME"; break; }
  done
  chmod 644 "$BE/node/lib/$LIBNAME"
  install_name_tool -change "$LIBREF" "@executable_path/../lib/$LIBNAME" "$BE/node/bin/node"
fi

# Plist templates (@HOME@/@REPO@ placeholders) — provision renders them:
# @REPO@ -> this backend dir, @HOME@ -> the user's home.
mkdir -p "$BE/agents"
cp ../ops/com.hazlie.connect.plist ../ops/com.hazlie.hermes.plist ../ops/com.hazlie.connectors.plist "$BE/agents/"

# SIGNING, AND WHY IT IS NOT AD-HOC ANY MORE.
#
# This used to be `codesign --force -s - "$APP"`, with a comment claiming that
# "an identityless signature still gives the OS a stable code identity for
# TCC/firewall bookkeeping." That claim was wrong, and it cost a microphone
# prompt on EVERY arm of the orb — not once per install, once per capture
# session, forever.
#
# The mechanism: an ad-hoc signature's designated requirement is a bare
# `cdhash H"..."` with no certificate behind it. TCC will not durably persist a
# microphone grant against an identity it cannot verify, so every new capture
# session re-asks. The app process was up for ten hours and still prompted each
# time the ear called getUserMedia; it was never a relaunch or a rebuild.
#
# Signing with a real identity gives a designated requirement of
# identifier + team + Apple certificate chain, which TCC persists — and which
# survives rebuilds, so ordinary development stops re-triggering the prompt.
#
# The hardened runtime comes with it, and that is why Hazlie.entitlements
# exists: under the runtime, microphone access is refused outright without
# com.apple.security.device.audio-input.
#
# EXPECT ONE MORE PROMPT after the first build that changes identity — the app
# genuinely is a different code identity now. Allow it once; it sticks.
#
# Ad-hoc remains the fallback so a machine with no identity can still build,
# but it says plainly what it costs rather than claiming to be equivalent.
IDENTITY="${HAZLIE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | awk '/Apple Development|Developer ID Application/ {print $2; exit}')}"

if [ -n "$IDENTITY" ]; then
  # INSIDE-OUT: the bundled node runtime is nested Mach-O and must carry its
  # own Developer ID signature (with JIT entitlements for V8) BEFORE the app
  # seals it, or notarization rejects the bundle. libnode first (a plain dylib,
  # no entitlements), then the wrapper, then the app.
  if [ -n "$LIBNAME" ] && [ -f "$BE/node/lib/$LIBNAME" ]; then
    codesign --force --options runtime -s "$IDENTITY" "$BE/node/lib/$LIBNAME"
  fi
  codesign --force --options runtime \
    --entitlements node.entitlements \
    -s "$IDENTITY" "$BE/node/bin/node"
  codesign --force --options runtime \
    --entitlements Hazlie.entitlements \
    -s "$IDENTITY" "$APP"
  echo "signed with $IDENTITY (hardened runtime, audio-input entitlement)"
else
  codesign --force -s - "$APP"
  echo "WARNING: no code-signing identity found; signed ad-hoc." >&2
  echo "         macOS will re-ask for microphone access on every arm." >&2
  echo "         Fix: create a code-signing identity, or set HAZLIE_SIGN_IDENTITY." >&2
fi

# /Applications, exactly one copy. It is the app's real home (the onboarding
# move step exists precisely to get user installs there), and the era of a
# second copy in ~/Applications ended when two registrations of one bundle id
# made LaunchServices' pick arbitrary.
DEST="/Applications/Intaglio Labs.app"
rm -rf "$DEST" "/Applications/Hazlie.app" "$HOME/Applications/Hazlie.app" "$HOME/Applications/Intaglio Labs.app"
cp -R "$APP" "$DEST"
echo "installed: $DEST"

LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREG" -f "$DEST" 2>/dev/null || true
"$LSREG" -u "$PWD/build/Intaglio Labs.app" 2>/dev/null || true

if [ "${1:-}" = "--run" ]; then
  pkill -x Hazlie 2>/dev/null || true
  open "$DEST"
fi
