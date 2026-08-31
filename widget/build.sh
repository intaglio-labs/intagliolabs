#!/bin/sh
# Build the Intaglio Labs desktop widget: one swiftc invocation, a bundle assembled
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

# A Documents-backed checkout can add File Provider metadata to a bundle as it
# is assembled; codesign correctly refuses that metadata. Local builds therefore
# stage the app on the system volume. Release builds opt into build/ explicitly
# (where CI has no File Provider) because release.sh needs that signed bundle to
# create the DMG.
if [ -n "${HAZLIE_STAGE_DIR:-}" ]; then
  STAGE_ROOT="$HAZLIE_STAGE_DIR"
else
  STAGE_ROOT="$(mktemp -d /private/tmp/intaglio-widget.XXXXXX)"
fi
APP="$STAGE_ROOT/Intaglio Labs.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/ui"
cp Info.plist "$APP/Contents/Info.plist"

# PROVENANCE: which source this bundle was built from, stamped into the COPY in
# build/ and never into the tracked Info.plist -- stamping the source file would
# dirty the tree on every build, and a dirty tree is exactly what release.sh
# refuses to ship. Done here, before the signature at the foot of this script,
# so the stamp is covered by it: a later edit would invalidate the signature
# rather than quietly rewrite the answer.
#
# Why an app needs this at all: build.sh compiles whatever is on disk right now.
# Without a stamp, a DMG in a downloads folder is unattributable -- there is no
# way, ever, to find out which commit a user is running, which turns every bug
# report from that build into a guess. release.sh sets these; a direct build.sh
# run derives them itself so a hand-built app is traceable too.
HZ_COMMIT="${HZ_SOURCE_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
if [ -z "${HZ_SOURCE_CLEAN:-}" ]; then
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then HZ_SOURCE_CLEAN=0; else HZ_SOURCE_CLEAN=1; fi
fi
/usr/libexec/PlistBuddy -c "Add :HZSourceCommit string $HZ_COMMIT" \
  "$APP/Contents/Info.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Add :HZSourceClean bool $([ "$HZ_SOURCE_CLEAN" = 1 ] && echo YES || echo NO)" \
  "$APP/Contents/Info.plist" >/dev/null
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
# This checkout commonly lives in a File Provider-backed Documents folder.
# A byte-for-byte `cp -R` of connectors/node_modules then opens thousands of
# tiny files and can turn a local rebuild into a forty-minute operation. APFS
# clone-copy keeps identical bytes copy-on-write and finishes in seconds. Keep
# the ordinary copy as a fallback for non-APFS build volumes.
clone_tree() {
  src="$1"; dst="$2"
  rm -rf "$dst"
  if ! cp -c -R "$src" "$dst" 2>/dev/null; then
    rm -rf "$dst"
    cp -R "$src" "$dst"
  fi
}
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
clone_tree ../connect "$BE/connect"
clone_tree ../ui/server "$BE/ui/server"
clone_tree ../ui/scripts "$BE/ui/scripts"
clone_tree ../prompts "$BE/prompts"
# node_modules is the one pathological tree in a File Provider checkout. Reuse
# the installed copy only when its lockfile is byte-identical; source and tests
# still come from this checkout. A dependency change misses the cache and falls
# back to the authoritative repo tree.
mkdir -p "$BE/connectors"
rsync -a --exclude node_modules ../connectors/ "$BE/connectors/"
INSTALLED_CONNECTORS="/Applications/Intaglio Labs.app/Contents/Resources/backend/connectors"
# Release builds set HAZLIE_STAGE_DIR. They must never inherit executable code
# from an installed app, even with the same lockfile: the release checkout is
# the only auditable source for the artifact that gets Developer ID signed.
if [ -z "${HAZLIE_STAGE_DIR:-}" ] \
   && [ -d "$INSTALLED_CONNECTORS/node_modules" ] \
   && cmp -s ../connectors/package-lock.json "$INSTALLED_CONNECTORS/package-lock.json"; then
  clone_tree "$INSTALLED_CONNECTORS/node_modules" "$BE/connectors/node_modules"
else
  clone_tree ../connectors/node_modules "$BE/connectors/node_modules"
fi
# THE AUTH SCRIPTS, because a downloaded install has no repo to run them from.
# The connect page's Google and Oura rows told the owner to run
# `node ops/gcal-auth.mjs`, and ops/ was never copied into the bundle — so that
# instruction worked for whoever had cloned the repo and for nobody else. The
# connect server spawns these directly now (POST /api/google-auth), and it
# resolves them at ../ops relative to itself, which is this path in the bundle
# and the repo root in a checkout. Same relative path, both layouts.
mkdir -p "$BE/ops"
# THE BRIDGE RUNTIME, WHICH IS NOW THE ONLY ONE.
#
# setup-bridges-native.sh provisions Synapse and seven mautrix bridges as
# launchd agents on this Mac. There used to be a second script that provisioned
# the same stack in Docker, and it was shipped beside this one as a fallback;
# both are gone. Docker Desktop on macOS is a Linux virtual machine — several GB
# of disk, a gig-plus of resident RAM, a commercial licence for business use —
# and the bridges never needed it: every mautrix bridge is Go with a published
# darwin-arm64 binary, and matrix-synapse publishes a macOS arm64 wheel.
#
# A fallback that silently installs a VM is not a fallback anyone consented to,
# and this one was unreachable in practice anyway. What replaces it is a setup
# script that fetches its own dependencies, tears down what it started if it
# cannot finish, and says why in ~/.hazlie/logs/bridge-setup.log.
cp ../ops/gcal-auth.mjs ../ops/oura-auth.mjs \
   ../ops/setup-bridges-native.sh ../ops/build-libolm.sh ../ops/build-synapse.sh \
   ../ops/fetch-bridges.mjs ../ops/prefetch-bridges.sh "$BE/ops/"
# The bridge supervisor and the single agent that runs it. Without these the
# stack still starts but nothing supervises it, and an earlier version of this
# line shipped eight per-process agents that each announced themselves in Login
# Items -- see ops/bridge-supervisor.mjs for why there is one now.
cp ../ops/io.intaglio.bridges.plist ../ops/bridge-supervisor.mjs "$BE/ops/"
# A downloaded app executes these directly. Preserve the source mode, but also
# set it explicitly so an archive or checkout that lost executable bits cannot
# silently turn first-launch bridge warming off.
chmod 755 "$BE/ops/prefetch-bridges.sh" \
          "$BE/ops/setup-bridges-native.sh" "$BE/ops/build-libolm.sh" \
          "$BE/ops/build-synapse.sh"
clone_tree ../bridges "$BE/bridges"
# The bridge installer needs yq to safely patch third-party YAML templates.
# Ship the static editor in the app instead of requiring every downloaded-app
# user to have Homebrew. This is a build requirement only, not a runtime one.
YQ_SRC="$(command -v yq 2>/dev/null || true)"
if [ -z "$YQ_SRC" ]; then
  echo "ERROR: yq is required to build a self-contained social bridge installer." >&2
  exit 1
fi
mkdir -p "$BE/tools"
cp -L "$YQ_SRC" "$BE/tools/yq"
chmod 755 "$BE/tools/yq"

# THE TELEGRAM APP CREDENTIAL, if this build machine has one.
#
# Telegram issues api_id/api_hash per ACCOUNT, and its bridge refuses to start
# without a real pair — so until now every install had to register its own app
# at my.telegram.org and paste the pair in before Telegram would do anything.
# Shipping one pair with the product is what turns that into an ordinary
# phone-and-code login (it is what Beeper does).
#
# IT CANNOT LIVE IN THE REPO, and this is the whole reason it arrives here
# rather than as a file in ops/: this repository is PUBLIC, and Telegram
# refuses logins made with any api_id it finds in public code
# (API_ID_PUBLISHED_FLOOD). Committing the pair would not degrade Telegram
# slowly, it would break every install at once. So the build reads it from the
# machine's own secret store (or CI's, from a repository secret) and writes it
# into the bundle, the same shape the site's Firebase credentials already use.
#
# A build WITHOUT the secret is not an error — it produces an app whose
# Telegram falls back to the per-user walkthrough, which is exactly today's
# behaviour. That fallback is the point: a shipped api_id is extractable from
# any binary with `strings`, so "published" is a matter of when, and when
# Telegram flags this one the per-user path is what everybody lands on.
TG_APP="${HZ_TELEGRAM_APP:-}"
if [ -z "$TG_APP" ] && [ -f "$HOME/.hazlie/secrets/telegram-app.txt" ]; then
  TG_APP="$(tr -d '[:space:]' < "$HOME/.hazlie/secrets/telegram-app.txt")"
fi
# Shape-checked here as well as at the reader, because a malformed pair
# produces a bridge that crash-loops at the user with no line naming why.
if printf '%s' "$TG_APP" | grep -Eq '^[0-9]{1,12}:[0-9a-fA-F]{32}$'; then
  printf '%s\n' "$TG_APP" > "$BE/telegram-app"
  chmod 600 "$BE/telegram-app"
  echo "telegram: app credential baked in (ops/setup-bridges-native.sh will use it)"
else
  [ -n "$TG_APP" ] && echo "telegram: ignoring a malformed credential — expected <api_id>:<api_hash>" >&2
  echo "telegram: no app credential on this machine; installs will use the per-user walkthrough"
fi

# The Calendar/Contacts helper. Node cannot call EventKit or the Contacts
# framework, so without this both sources can only reach their data by reading
# the backing sqlite stores -- which is Full Disk Access, a grant far larger than
# either needs. Built as its own binary rather than folded into the app because
# the connectors daemon spawns it per pass. See helpers/AppleData.swift.
mkdir -p "$BE/helpers"
swiftc -O -target "$(uname -m)-apple-macos13.0" -o "$BE/helpers/apple-data" helpers/AppleData.swift
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
# The llama runtime: bundle-llama.py fetches llama.cpp's own sha256-pinned macOS
# release and stages it flat, backends included, so it runs on a Mac that has
# never heard of Homebrew. (It used to repackage Homebrew's build, which could
# not work anywhere but the build machine — that file's header has the whole
# measurement.) The model is not bundled; see the split below.
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
#   voice models (~496 MB)  bundled, because producing them needs node, npm and
#                           ~1.9 GB of downloads -- a toolchain and a wait no
#                           end user should be handed. NOT because the build is
#                           fragile: setup-voice.sh passes --ignore-scripts and
#                           runs clean on a cold cache in about half a minute.
#                           (This used to say "sharp breaks the install on a
#                           current node even on a dev box". That was true of
#                           the script as it stood BEFORE d447212, which fixed
#                           it with --ignore-scripts -- and was committed
#                           eleven minutes before this comment was written.
#                           Measured 2026-08-25: the committed script exits 0
#                           on node 22.21.1 with a cold cache and produces a
#                           byte-identical tree.)
#   the .gguf (2.5-4.7 GB)  DOWNLOADED, chosen in onboarding. One file, one
#                           declared host (huggingface.co, already in
#                           ops/EGRESS.json as model-asset), no toolchain — and
#                           it is the one with a real choice in it, since 4B and
#                           8B suit different amounts of RAM.
#
# This does not weaken "nothing leaves the box": a setup-time fetch the owner
# asked for is a different act from a runtime call, and the runtime still has no
# network fallback of any kind. It fails closed exactly as before.
# NO `command -v llama-server` GUARD ANY MORE. This used to repackage whatever
# Homebrew had installed, so a build machine without llama.cpp silently produced
# an app with no local answering at all. It now fetches llama.cpp's own
# sha256-pinned macOS release: the build needs nothing installed, and every
# build gets the same bytes. A fetch failure is fatal on purpose -- shipping the
# app without its runtime is what used to happen quietly.
python3 bundle-llama.py "$BE/llama"

# libolm.3.dylib, PREBUILT AND SHIPPED, so a fresh install needs no toolchain.
#
# Every native mautrix bridge carries LC_LOAD_DYLIB on @rpath/libolm.3.dylib — a
# hard link, so the process aborts in dyld before main() without it — and upstream
# publishes that dylib only as a CI artifact, never as a release asset.
#
# ops/build-libolm.sh can build it, but it needs cmake, and cmake is NOT on a
# stock Mac: Xcode's command line tools do not provide it, so the only cmake on
# this build machine is Homebrew's. Making a consumer install depend on that
# would trade a Docker dependency for a Homebrew one, which is not what removing
# Docker was for. So the build machine pays that cost once and the result ships,
# exactly as the llama dylibs above already do.
#
# libolm is Apache-2.0. This comment used to assert that site/notices already
# reproduced that licence; it did not name libolm at all, and shipping a binary
# on the strength of a licence note that does not exist is worse than shipping
# it with no note. site/notices now carries a "Native libraries" section naming
# OpenMarket and New Vector, pointing at the Apache text already on the page,
# and reproducing the three-clause BSD notice for curve25519-donna — which is
# compiled INTO this dylib (confirmed by nm) and whose binary clause requires
# the notice appear in our documentation. Node and yq ship here too and are
# still unnamed; that gap is older than this file and is flagged, not fixed.
#
# libolm is also archived upstream and does not compile unpatched against a
# current clang — build-libolm.sh carries the one-line patch and the reasoning.
mkdir -p "$BE/bridges/lib"
if [ -f "$BE/bridges/lib/libolm.3.dylib" ]; then
  : # already staged by a previous run in this tree
elif [ -f "$HOME/.hazlie/bridges/bin/libolm.3.dylib" ]; then
  cp "$HOME/.hazlie/bridges/bin/libolm.3.dylib" "$BE/bridges/lib/libolm.3.dylib"
  echo "bundled libolm from the local native runtime"
elif command -v cmake >/dev/null 2>&1; then
  if sh ../ops/build-libolm.sh "$BE/bridges/lib" >/dev/null 2>&1; then
    echo "bundled libolm (built from source)"
  else
    echo "NOTE: libolm build failed — native bridges will not start." >&2
  fi
else
  echo "NOTE: no cmake and no prebuilt libolm — native bridges will not start." >&2
  echo "      brew install cmake, or run ops/build-libolm.sh once, before" >&2
  echo "      building for distribution." >&2
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
cp ../ops/io.intaglio.connect.plist ../ops/io.intaglio.hermes.plist \
   ../ops/io.intaglio.connectors.plist ../ops/io.intaglio.llama-server.plist "$BE/agents/"
mkdir -p "$BE/config"
cp ../ops/inference-profiles.json "$BE/config/"

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
# TWO SIGNING MODES, AND THEY ARE NOT COMPATIBLE.
#
#   Apple Development  -> signs for the machine that built it. `spctl -a` rejects
#                         it, which is expected and sufficient.
#   Developer ID       -> signed for everyone, notarized and stapled by
#                         release.sh. This is the artifact anyone else gets.
#
# release.sh sets HAZLIE_SIGN_IDENTITY to the Developer ID hash and calls this
# script, so the mode is decided HERE from the identity actually in use rather
# than assumed. Getting this wrong produces a bundle that signs fine and is
# refused at launch, which is a slow way to find out.
#
# ~~The development arm used to embed signing/mac-dev.provisionprofile and lift
# `application-identifier` + `team-identifier` out of it, which is what let a
# development build run on other listed Macs.~~ Removed 2026-08-27 with the
# instructions in ops/SIGNING.md: it required registering an App ID and every
# machine's UDID, and bought nothing -- release.sh already produces something
# that runs anywhere, and the entitlements carry no get-task-allow so it was
# never a debugging aid either. See ops/SIGNING.md, "There is no shareable
# development build, on purpose".
#
# The Developer ID arm still clears a stale embedded profile: an older build in
# the same tree could have left one, and a Developer ID signature with a
# per-machine profile is refused.
ENTS="Hazlie.entitlements"
IDENTITY_NAME="$(security find-identity -v -p codesigning 2>/dev/null | grep -F "$IDENTITY" | head -1)"
case "$IDENTITY_NAME" in
  *"Developer ID"*)
    rm -f "$APP/Contents/embedded.provisionprofile"
    echo "signing for distribution: no provisioning profile, base entitlements"
    ;;
  *)
    rm -f "$APP/Contents/embedded.provisionprofile"
    echo "signing for this machine (development identity, no profile)"
    ;;
esac

# Regular `cp` preserves Finder metadata from the checkout. Recent macOS
# attaches provenance to those copied files, and signing rejects the resulting
# FinderInfo on the outer bundle. Re-clone the assembled app without resource
# forks or extended attributes before we sign; this changes only build output.
CLEAN_APP="$APP.clean"
rm -rf "$CLEAN_APP"
ditto --norsrc --noextattr "$APP" "$CLEAN_APP"
rm -rf "$APP"
mv "$CLEAN_APP" "$APP"

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
  # The llama runtime is FLAT in llama/bin now (binary + every ggml backend
  # module together, resolving each other through @loader_path), so the dylib
  # sweep looks there rather than in a lib/ that no longer exists. Missing this
  # would leave ad-hoc backends inside a Developer ID bundle, which release.sh
  # now refuses to submit.
  if [ -f "$BE/llama/bin/llama-server" ]; then
    for dylib in "$BE/llama/bin/"*.dylib; do
      [ -f "$dylib" ] && codesign --force --options runtime -s "$IDENTITY" "$dylib"
    done
    codesign --force --options runtime \
      --entitlements node.entitlements \
      -s "$IDENTITY" "$BE/llama/bin/llama-server"
  fi
  # NO ENTITLEMENTS ON THE HELPER, and that is load-bearing rather than an
  # omission. It was first signed with the app's, on the reasoning that it is the
  # process actually calling EventKit and Contacts -- and macOS SIGKILLed it on
  # every launch (exit 137, `taskgated-helper (ConfigurationProfiles)`). The
  # personal-information.* entitlements are restricted: under an Apple
  # Development identity they are only honoured alongside an embedded
  # provisioning profile, and a bare Mach-O executable has nowhere to embed one
  # the way an .app bundle does.
  #
  # It does not need them anyway. TCC attributes access to the RESPONSIBLE
  # process, which for a child of the app is the app -- whose entitlements and
  # whose grants are the ones that count. Signed plainly it reads the address
  # book fine; signed with the entitlements it never got far enough to try.
  if [ -f "$BE/helpers/apple-data" ]; then
    codesign --force --options runtime -s "$IDENTITY" "$BE/helpers/apple-data"
  fi
  if [ -f "$BE/tools/yq" ]; then
    codesign --force --options runtime -s "$IDENTITY" "$BE/tools/yq"
  fi
  # libolm. A plain dylib, so no entitlements -- the same treatment the llama
  # dylibs and libnode get, and for the reason spelled out at the top of this
  # block: nested Mach-O must carry its own Developer ID signature BEFORE the
  # app seals it or notarization rejects the whole bundle.
  #
  # It arrived after v0.3.0 carrying an ad-hoc signature from build-libolm.sh,
  # was staged into the bundle, and was never added here. v0.4.0's notarization
  # came back Invalid and the run died at `stapler staple` with "Record not
  # found" -- a symptom that names nothing. An ad-hoc signature is the failure
  # mode that looks most like success: `codesign -dv` prints a real
  # CodeDirectory and only the "Signature=adhoc" line gives it away.
  if [ -f "$BE/bridges/lib/libolm.3.dylib" ]; then
    codesign --force --options runtime -s "$IDENTITY" "$BE/bridges/lib/libolm.3.dylib"
  fi
  # Signing nested Mach-O can restore this Finder attribute on the bundle.
  # Remove it immediately before the app-level signature.
  xattr -d com.apple.FinderInfo "$APP" 2>/dev/null || true
  xattr -d 'com.apple.fileprovider.fpfs#P' "$APP" 2>/dev/null || true
  codesign --force --options runtime \
    --entitlements "$ENTS" \
    -s "$IDENTITY" "$APP"
  echo "signed with $IDENTITY (hardened runtime, $ENTS)"
else
  xattr -d com.apple.FinderInfo "$APP" 2>/dev/null || true
  xattr -d 'com.apple.fileprovider.fpfs#P' "$APP" 2>/dev/null || true
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
ditto --norsrc --noextattr "$APP" "$DEST"
# Copying a bundle into /Applications can attach Finder provenance metadata to
# the destination after it was signed. codesign rejects that metadata, so clear
# it from this generated install copy before LaunchServices registers it.
xattr -cr "$DEST" 2>/dev/null || true
echo "installed: $DEST"

LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREG" -f "$DEST" 2>/dev/null || true
"$LSREG" -u "$PWD/build/Intaglio Labs.app" 2>/dev/null || true

# RESTART THE BACKGROUND SERVICES, or the install is only half done.
#
# hermes, connect and llama-server are launchd agents with KeepAlive=true and
# ProgramArguments pointing INTO this bundle. They are not children of the app,
# so quitting the app does not stop them and `pkill` does not either -- launchd
# restarts within ThrottleInterval, reading whatever is on disk at that instant.
#
# That lost two deploys on 2026-08-24. The sequence is silent and looks fine:
# kill the app, start a build, launchd relaunches hermes from the OLD bundle
# mid-build, the build then overwrites the files under the running process, and
# the app comes up talking to a server running last build's code. The symptom
# was a schema migration that simply never ran, and the only way to notice was
# to check PRAGMA user_version by hand.
#
# kickstart -k kills and restarts in one step, AFTER the copy, so the process
# that comes back is guaranteed to be reading the bundle just installed.
# Failures are tolerated: a machine that has never provisioned the agents has
# nothing to restart, which is a normal state and not a build error.
for svc in io.intaglio.hermes io.intaglio.connect io.intaglio.llama-server; do
  if launchctl print "gui/$(id -u)/$svc" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$svc" >/dev/null 2>&1 \
      && echo "restarted: $svc" \
      || echo "WARNING: $svc did not restart; it may still be running old code" >&2
  fi
done

# RESTART THE APP TOO, for exactly the same reason as the agents above.
#
# The comment above is careful about three background services and then left the
# app itself behind a flag, which is the half of the install that is actually on
# screen. A running Intaglio Labs holds the bundle it launched with -- its webviews keep
# serving the HTML and JS from that copy -- so overwriting /Applications changes
# nothing it displays. On 2026-08-25 that meant an hour of testing a panel whose
# JS was 73 minutes old, and the symptom was the worst kind: the feature looked
# broken rather than stale, because the OLD code was doing exactly what the old
# code did.
#
# Only if it was ALREADY running. Launching an app the owner had closed is a
# surprise an install has no business springing; --run stays the way to say
# "start it regardless".
if pgrep -x Hazlie >/dev/null 2>&1; then
  pkill -x Hazlie 2>/dev/null || true
  # Wait for it to actually go. `open` on a still-dying instance reactivates the
  # corpse instead of launching the new bundle, which would reproduce the very
  # bug this block exists to fix.
  for _ in $(seq 1 50); do
    pgrep -x Hazlie >/dev/null 2>&1 || break
    sleep 0.1
  done
  if pgrep -x Hazlie >/dev/null 2>&1; then
    echo "WARNING: Intaglio Labs would not quit; it is still showing the old bundle" >&2
  else
    # REAP THE CONNECTOR DAEMON, which is the app's CHILD and not a launchd
    # agent, so killing the app orphans it (reparented to launchd) rather than
    # stopping it. The new app then spawns a second one, and two daemons ingest
    # into the same state.db at once -- observed on 2026-08-25, where the visible
    # symptom was a plain "database is locked" from an unrelated query.
    #
    # Safe only in this window: the app is confirmed dead, so any daemon still
    # alive is by definition an orphan, and the replacement has not started yet.
    pkill -f 'connectors/daemon\.mjs' 2>/dev/null \
      && echo "reaped: orphaned connector daemon" || true
    # AND THE DISTILLER, for exactly the same reason and with worse consequences.
    # It is also a child of the app, so killing the app reparents it to launchd
    # rather than stopping it -- Distiller.stop() only runs on a clean quit.
    # Observed right after distillation was switched off: a pass from the
    # PREVIOUS bundle was still running two minutes later, holding the corpus
    # write lock and the model, under an app that had been told not to distil.
    # An orphan also outlives the switch that disabled it, which makes the switch
    # look broken.
    pkill -f 'ui/scripts/distill-(episodes|once)\.mjs' 2>/dev/null \
      && echo "reaped: orphaned distiller pass" || true
    open "$DEST" && echo "restarted: Intaglio Labs.app"
  fi
elif [ "${1:-}" = "--run" ]; then
  open "$DEST"
fi
