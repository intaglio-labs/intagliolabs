#!/bin/sh
# Build the Hazlie desktop widget: one swiftc invocation, a bundle assembled
# by hand, an ad-hoc signature. No Xcode project, no SwiftPM, no third-party
# code — the same shape as the ops/setup-*.sh scripts.
#
#   widget/build.sh            build + install to /Applications/Intaglio Labs.app
#   widget/build.sh --run      ...and (re)launch it
#
# (This header said ~/Applications/Hazlie.app until 2026-08-23. Both halves had
# been false since the bundle was renamed and the install moved -- see DEST at
# the foot of this file, which also removes the old ~/Applications copies. Rule
# 2: the code is what shipped, so the sentence is what gets fixed.)
set -eu
cd "$(dirname "$0")"

mkdir -p build
# Pin the target: swiftc's default is the SDK's OS, which can be NEWER than
# the running system — LaunchServices then refuses the app with -10825.
# src/*.swift, not a hand-kept list. The list was explicit and a new file
# (ModelSetup.swift) was simply absent from it, so the build failed with
# "cannot find 'ModelSetup' in scope" -- which reads like a missing import
# rather than a missing argument. There is no case where a file in src/ should
# not be compiled, so there is nothing for the list to express.
swiftc -O -target "$(uname -m)-apple-macos13.0" -o build/Hazlie src/*.swift

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
# (No common/: it did not cross to this repo and nothing bundled imports it —
# verified zero `../common` / `/common/` references in connect/connectors/
# ui-server. Copying a nonexistent dir hard-fails the build under set -e.)
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

# LLAMA RUNTIME + MODEL, so the local "ask" model works offline on a fresh Mac.
# The portable llama-server + its dylibs (bundle-llama.py rewrites the install
# names; Metal GPU inference verified) and the ~4.7GB gguf. cp -c clones the
# model on APFS — instant copy-on-write, no multi-GB copy per build.
# Guarded so a plain `git clone && ./build.sh` (no llama.cpp, no provisioned
# model) still builds a working app — just without the bundled "ask".
# THE RUNTIME SHIPS. THE WEIGHTS DO NOT.
#
# Both used to be bundled, and the app was 5.3 GB — 4.7 GB of it one .gguf.
# That is a 39x download for a capability plenty of installs will not use, paid
# by everyone including someone who only wants their calendar searchable.
#
# The split is not a preference, it follows what each thing costs to obtain:
#
#   llama runtime (~30 MB)  bundled. It is small, and building it otherwise
#                           means Homebrew and a toolchain on the owner's Mac.
#   voice models (~496 MB)  bundled. They CANNOT be produced on a user's
#                           machine: setup-voice.sh needs npm and esbuild to
#                           bundle the Kokoro worker, and sharp breaks the
#                           install on a current node even on a dev box.
#   the .gguf (2.5-4.7 GB)  DOWNLOADED, chosen in onboarding. One file, one
#                           declared host (huggingface.co, already in
#                           ops/EGRESS.json as model-asset), no toolchain — and
#                           it is the one with a real choice in it, since 4B and
#                           8B suit different amounts of RAM.
#
# This does not weaken "nothing leaves the box": a setup-time fetch the owner
# asked for is a different act from a runtime call, and the runtime still has no
# network fallback of any kind. It fails closed exactly as before.
if command -v llama-server >/dev/null 2>&1; then
  python3 bundle-llama.py "$BE/llama"
else
  echo "NOTE: llama-server not on PATH — the runtime will not be bundled." >&2
  echo "      brew install llama.cpp before building for distribution." >&2
fi

# VOICE MODELS (ear STT + speak TTS), so voice works offline out of the box the
# same way ask does. ~495MB — Moonshine tiny + Silero VAD + onnxruntime-web for
# the ear, Kokoro-82M for the voice — normally produced by voice/setup-voice.sh
# into ~/.hazlie/models/voice, which AssetScheme.swift serves to the ear page.
# The runtime fails CLOSED without these (no HuggingFace fallback at runtime), so
# a fresh Mac has no voice unless they ship. Cloned in (cp -c -R: instant on
# APFS); provision clones them back out to ~/.hazlie/models/voice on first run.
VOICE_SRC="$HOME/.hazlie/models/voice"
if [ -d "$VOICE_SRC" ]; then
  cp -c -R "$VOICE_SRC" "$BE/voice-models" 2>/dev/null || cp -R "$VOICE_SRC" "$BE/voice-models"
else
  echo "WARNING: no voice models at $VOICE_SRC — run voice/setup-voice.sh." >&2
  echo "         This build will have NO voice on a fresh machine." >&2
fi

# Plist templates (@HOME@/@REPO@ placeholders) — provision renders them:
# @REPO@ -> this backend dir, @HOME@ -> the user's home.
mkdir -p "$BE/agents"
cp ../ops/com.hazlie.connect.plist ../ops/com.hazlie.hermes.plist \
   ../ops/com.hazlie.connectors.plist ../ops/com.hazlie.llama-server.plist \
   ../ops/com.hazlie.whatsapp-keepalive.plist "$BE/agents/"

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

# THE PROVISIONING PROFILE, embedded before signing.
#
# A development-signed Mac app carries one or it is not validly signed for any
# machine, and `spctl -a` says rejected. The profile names this team, this bundle
# id and the Macs allowed to run it, and lives at
# Contents/embedded.provisionprofile by convention.
#
# This comment used to go on to blame the missing profile for the silent
# Contacts/Calendar/Photos prompt failure. That was the wrong diagnosis, and it is
# corrected here rather than deleted because it sent the search in the wrong
# direction for days. The app that would not prompt HAD a valid profile and both
# identifier entitlements. What it lacked was the per-service hardened-runtime
# entitlements — see Hazlie.entitlements, which now carries all four and quotes
# tccd's own refusal. A profile is what lets you hand the app to someone else; it
# is not what earns a TCC prompt.
#
# Absent is not fatal: an ad-hoc or unprofiled build still runs for whoever
# built it. It just cannot be handed to anyone.
# TWO SIGNING MODES, AND THEY ARE NOT COMPATIBLE.
#
#   Apple Development  -> embed a provisioning profile, and carry the two
#                         identifier entitlements it asserts. Runs only on the
#                         Macs the profile lists. Without the profile the app is
#                         not validly signed for ANY machine.
#   Developer ID       -> NO profile, and NOT those entitlements. A Developer ID
#                         app is signed for everyone, so a per-machine profile is
#                         meaningless and application-identifier is invalid
#                         without one; codesign rejects the combination.
#
# release.sh sets HAZLIE_SIGN_IDENTITY to the Developer ID hash and calls this
# script, so the mode has to be decided HERE from the identity actually in use
# rather than assumed. Getting this wrong produces a bundle that signs fine and
# is refused at launch, which is a slow way to find out.
ENTS="Hazlie.entitlements"
PROFILE="signing/mac-dev.provisionprofile"
IDENTITY_NAME="$(security find-identity -v -p codesigning 2>/dev/null | grep -F "$IDENTITY" | head -1)"
case "$IDENTITY_NAME" in
  *"Developer ID"*)
    rm -f "$APP/Contents/embedded.provisionprofile"
    echo "signing for distribution: no provisioning profile, base entitlements"
    ;;
  *)
    if [ -f "$PROFILE" ]; then
      cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"
      # The identifier entitlements are only valid alongside the profile that
      # asserts them, so they are added here rather than living in the file.
      ENTS="build/dev.entitlements"
      python3 - "$PROFILE" "$ENTS" <<'PYEOF'
import plistlib, subprocess, sys
raw = subprocess.run(["security", "cms", "-D", "-i", sys.argv[1]],
                     capture_output=True).stdout
ents = plistlib.loads(raw).get("Entitlements", {})
base = plistlib.load(open("Hazlie.entitlements", "rb"))
for k in ("com.apple.application-identifier", "com.apple.developer.team-identifier"):
    if k in ents:
        base[k] = ents[k]
plistlib.dump(base, open(sys.argv[2], "wb"))
PYEOF
      echo "embedded $PROFILE (development build)"
    else
      echo "NOTE: no $PROFILE — this build runs only for whoever built" >&2
      echo "      it, and cannot be handed to anyone. See ops/SIGNING.md." >&2
    fi
    ;;
esac

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
  # The llama runtime (only when it was bundled above): every dylib first, then
  # the server with the same JIT + Metal entitlements node uses (V8 and Metal
  # both need allow-jit / allow-unsigned-executable-memory; disable-library-
  # validation lets the rewritten dylibs load).
  if [ -f "$BE/llama/bin/llama-server" ]; then
    for dylib in "$BE/llama/lib/"*.dylib; do
      [ -f "$dylib" ] && codesign --force --options runtime -s "$IDENTITY" "$dylib"
    done
    codesign --force --options runtime \
      --entitlements node.entitlements \
      -s "$IDENTITY" "$BE/llama/bin/llama-server"
  fi
  codesign --force --options runtime \
    --entitlements "$ENTS" \
    -s "$IDENTITY" "$APP"
  echo "signed with $IDENTITY (hardened runtime, $ENTS)"
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
