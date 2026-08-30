#!/bin/sh
# Warm the native bridge runtime after launch, without creating any social
# state. The expensive part of a social connection is a ~305 MB download plus a
# Synapse runtime build; doing it here means pressing Connect on LinkedIn is a
# login, not a download. No Matrix user, bridge config, registration, cookie or
# account state exists until the owner actually chooses a source -- that is
# setup-bridges-native.sh's job and it is deliberately not called from here.
#
# This used to warm Docker's image cache (`docker pull` x8, after waiting up to
# 90s for Docker Desktop to come up). There is no Docker any more. What it warms
# now is what the native path actually consumes: hash-checked bridge binaries
# from mautrix's releases, and the CPython + wheels Synapse runs on.
#
# EVERY STEP IS IDEMPOTENT AND OPTIONAL. This runs unattended at launch, so a
# failure here must never be fatal and must never block: fetch-bridges.mjs
# re-hashes what is present and downloads only gaps, build-synapse.sh writes
# .ready last so a half-built runtime is distinguishable from a good one, and
# both are re-run by setup-bridges-native.sh anyway if this did not finish.
set -u

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN="$HOME/.hazlie/bridges/bin"
SYN="$HOME/.hazlie/bridges/synapse"

NODE="${HZ_NODE:-$HOME/.hazlie/bin/node}"
[ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null || true)

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "bridge prefetch skipped: no node to run the fetcher with"
  exit 0
fi

if [ -f "$REPO/ops/fetch-bridges.mjs" ]; then
  echo "prefetching bridge binaries"
  if "$NODE" "$REPO/ops/fetch-bridges.mjs"; then
    echo "bridge binaries present and verified in $BIN"
  else
    echo "bridge binary prefetch did not finish; setup will retry"
  fi
fi

if [ ! -f "$SYN/.ready" ] && [ -f "$REPO/ops/build-synapse.sh" ]; then
  echo "prefetching the synapse runtime"
  if sh "$REPO/ops/build-synapse.sh" "$SYN"; then
    echo "synapse runtime ready at $SYN"
  else
    echo "synapse runtime prefetch did not finish; setup will retry"
  fi
fi

exit 0
