#!/bin/sh
# Build a relocatable Synapse runtime — the eighth and last container.
#
#   bash ops/build-synapse.sh [outdir]    # default: ~/.hazlie/bridges/synapse
#
# WHAT THIS REPLACES, and the correction that made it possible. The claim that
# kept Docker in this product was "Synapse is Python, no Matrix homeserver
# publishes a macOS arm64 build, so removing the homeserver means writing one."
# The premise was false. matrix-synapse 1.140.0 -- the version this repo already
# pins -- publishes matrix_synapse-1.140.0-cp39-abi3-macosx_11_0_arm64.whl. It
# installs from wheels alone, with no Rust toolchain and no compiler on the
# machine, and it runs: verified 2026-08-29 on this architecture, /health OK and
# /_matrix/client/versions serving through v1.12.
#
# TWO THINGS THE CONTAINER WAS DOING FOR US, both handled here:
#
#   1. A LOCKED DEPENDENCY SET. An image freezes its resolution at build time; a
#      fresh pip install does not. matrix-synapse asks for
#      `prometheus-client >=0.6.0`, pip takes 0.26.0, and Synapse cannot subclass
#      its Collector -- the homeserver dies at import with an MRO TypeError
#      before it ever reads a config. Reproduces on 3.12 and 3.14 alike, so it is
#      a resolution problem, not a platform one. bridges/synapse-requirements.txt
#      is the frozen set; this installs from it and nothing else.
#
#   2. A PINNED INTERPRETER. The system Python is whatever the owner's Mac has
#      -- 3.14 on this machine, which upstream does not test. Synapse declares
#      >=3.10,<4.0. So the interpreter is shipped too, from Astral's
#      python-build-standalone: a relocatable CPython that is already the same
#      move this project made for Node (71 MB embedded) and llama-server.
#      Its SQLite is 3.53, comfortably over the 3.40 floor Synapse 1.142+ wants.
#
# UPSTREAM STOPS PUBLISHING macOS WHEELS AT 1.144.0. 1.143.0 is the last with
# them. Staying on <=1.143.0 means running an unpatched network-facing
# homeserver, which is not somewhere to live; the way forward is building the
# wheel from sdist on a macOS CI runner, which needs a Rust toolchain in CI and
# never on a user's machine. Do that before taking a 1.144+ bump, not after.
#
# SIZE: about 200 MB of venv plus 72 MB of interpreter, measured. That is real,
# and it buys back a multi-gigabyte Linux VM.

set -eu
OUT="${1:-$HOME/.hazlie/bridges/synapse}"
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REQS="$REPO/bridges/synapse-requirements.txt"

PY_RELEASE="20260825"
PY_VERSION="3.12.14"
PY_ASSET="cpython-${PY_VERSION}+${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${PY_ASSET}"

[ -f "$REQS" ] || { echo "missing $REQS" >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "this builds an aarch64 runtime; run it on Apple Silicon" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/synapse-build.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "fetching CPython ${PY_VERSION}"
curl -fsSL -o "$WORK/cpython.tar.gz" "$PY_URL"
tar xzf "$WORK/cpython.tar.gz" -C "$WORK"
[ -x "$WORK/python/bin/python3" ] || { echo "extracted CPython has no python3" >&2; exit 1; }

# BUILT IN PLACE, NOT STAGED AND MOVED, and that is not laziness.
#
# A venv is not relocatable. `python -m venv` writes the creating interpreter's
# ABSOLUTE path into pyvenv.cfg, into every console-script shebang, and into the
# bin/python symlink. Building under $WORK and moving the result produced a tree
# that looked complete and whose venv/bin/python was a dangling symlink into a
# temp directory this script had already deleted -- `no such file or directory`
# on the interpreter itself, from a build that reported success. So the venv is
# created where it will live.
#
# The atomicity that costs us is bought back with a marker written LAST: a
# half-built runtime has no .ready, and anything consuming this must check for it
# rather than for the directory.
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$WORK/python" "$OUT/python"
"$OUT/python/bin/python3" -m venv "$OUT/venv"

echo "installing Synapse from the locked set"
# --only-binary: if a wheel is missing for this platform, FAIL rather than
# silently starting a source build that needs a toolchain the user does not have.
# --no-deps: the lockfile is the complete set; letting pip resolve again is
# exactly the door this file exists to close.
"$OUT/venv/bin/pip" install --quiet --disable-pip-version-check \
  --only-binary=:all: --no-deps -r "$REQS"

# PROVE IT BEFORE DECLARING IT READY. An import check catches the MRO failure
# above, which happens at import and not at install -- a green pip is not
# evidence. Failing here leaves no .ready behind, which is the point.
"$OUT/venv/bin/python" -c 'import synapse; print("synapse", synapse.__version__)'
"$OUT/venv/bin/python" - <<'CHECK'
# The homeserver module is what actually gets executed; importing synapse alone
# does not touch the metrics stack where the dependency break lives.
import synapse.app.homeserver  # noqa: F401
print("homeserver module imports")
CHECK

date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/.ready"

echo "synapse runtime -> $OUT"
echo "  interpreter: $OUT/python/bin/python3"
echo "  homeserver : $OUT/venv/bin/python -m synapse.app.homeserver"
