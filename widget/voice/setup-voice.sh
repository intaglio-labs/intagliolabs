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

# Hazlie's copied node is the pinned toolchain (>=22.13 required; the copy
# is v25 with FTS5). Fall back to PATH node with a version note.
NODE="$HOME/.hazlie/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
echo "using node: $NODE ($("$NODE" --version))"

"$NODE" "$(command -v npm)" install --no-fund --no-audit

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
