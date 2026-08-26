#!/bin/sh
# Owner-run, one-time voice provisioning (VOICE-PLAN rev 3, Day 0). This is
# the ONLY step that touches the network — npm registry + model downloads —
# and it is explicit, like brew. The runtime never fetches: missing assets
# fail closed with a fixed message in chat.
#
#   widget/voice/setup-voice.sh
#
# Produces ~/.hazlie/models/voice/{models,vendor,workers,voice}, which the
# app serves to the ear page via hazlie-asset:// (AssetScheme.swift).
set -eu
cd "$(dirname "$0")"

# Intaglio Labs' copied node is the pinned toolchain (>=22.13 required; the copy
# is v25 with FTS5). Fall back to PATH node with a version note.
NODE="$HOME/.hazlie/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
echo "using node: $NODE ($("$NODE" --version))"

# --ignore-scripts, and it is load-bearing rather than caution.
#
# kokoro-js depends on transformers.js, which depends on sharp -- a NATIVE
# module. It has no prebuilt for this node, so its install script falls back to
# building from source via node-gyp and dies: "Please add node-addon-api to your
# dependencies". That took the whole install with it, so the voice stack could
# not be built at all on a current node.
#
# Nothing here ever RUNS sharp: it is transformers.js' image path, and this is
# an audio pipeline. esbuild only needs the transformers SOURCE to bundle the
# Kokoro worker. So the fix is to skip install scripts, not to make sharp
# compile. Optional deps stay ON, because esbuild ships its platform binary as
# one (@esbuild/darwin-arm64) -- --omit=optional was tried first and removed the
# very thing the build needs.
"$NODE" "$(command -v npm)" install --no-fund --no-audit --ignore-scripts

# The frontend scripts write to ./public relative to their package root.
"$NODE" scripts/build-workers.mjs
"$NODE" scripts/fetch-models.mjs
"$NODE" scripts/bake-voice.mjs || echo "bake-voice skipped (optional pre-baked lines)"

DEST="$HOME/.hazlie/models/voice"
mkdir -p "$DEST"
cp -R public/. "$DEST/"
echo "provisioned: $DEST"
ls "$DEST"
echo "Now rebuild + relaunch: widget/build.sh --run"
