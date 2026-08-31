#!/bin/sh
# Provision the social-bridge stack with NO DOCKER — the successor to
# ops/setup-bridges.sh.
#
#   bash ops/setup-bridges-native.sh            # provision, then start
#   bash ops/setup-bridges-native.sh --provision-only
#   bash ops/setup-bridges-native.sh --stop
#   bash ops/setup-bridges-native.sh --status
#
# WHY BOTH SCRIPTS EXIST FOR NOW. setup-bridges.sh works and holds a live
# household's bridge state. This is a parallel path, deliberately: the container
# stack keeps running until this has been driven end to end against real logins.
# The two must not both run — they share ~/.hazlie/matrix and would fight over
# the same ports and databases. --status says which, if either, is up.
#
# WHAT CHANGED, and it is smaller than it looks. Every piece of configuration
# below is the same configuration the compose stack wrote; what moves is WHERE
# things live and HOW they are addressed:
#
#   container path        ->  real path
#   /data/homeserver.yaml     $M/synapse/homeserver.yaml
#   /registrations/x.yaml     $M/<bridge>/registration.yaml
#   file:/data/x.db           file:$M/<bridge>/x.db
#
#   compose DNS           ->  loopback
#   the homeserver's name     127.0.0.1:8008
#   each bridge's name        127.0.0.1:<its port>
#
# (Those names are spelled out nowhere on purpose: the egress wire in
# connectors/test/egress.test.mjs reads every https host literal in tracked
# source, and a container DNS name written out in a comment reads to it as an
# undeclared destination -- correctly, now that nothing exempts them.)
#
# And one thing gets BETTER rather than merely equivalent: appservice.hostname
# was 0.0.0.0 because a container has to bind every interface to be reachable
# across the compose network. Native binaries default to 127.0.0.1 and stay
# there, so seven appservice listeners that were reachable from the LAN are now
# reachable only from this machine.
#
# The bridge binaries are also more honest to drive than the images were. The
# compose path generated config by running the image bare and hoping a file
# appeared; the binaries take -e (write example config) and -g (write
# registration) and say what they did.
#
# WHAT THIS DOES: install eight launchd agents -- Synapse and one per bridge --
# and wait until they answer. It does not hold the processes itself; RunAtLoad
# plus KeepAlive means they survive a crash and a reboot without this script
# running at all. Until 2026-08-30 that sentence read "WHAT THIS DOES NOT DO:
# supervise", which was tolerable only while Compose's `restart:
# unless-stopped` sat underneath as a fallback. It does not any more.

set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# ONE STATE ROOT PER ENGINE. Native and Docker both used to write
# ~/.hazlie/matrix, and the two provisioners disagree about what a path means:
# native writes host-absolute paths (/Users/you/.hazlie/...) and Docker writes
# the container's view (/data/...). Whichever ran second left a homeserver.yaml
# the other one cannot start from, so a Docker fallback triggered on a machine
# with a working native install would not fall back -- it would break both.
# Native keeps this path because it is the one checks.mjs and bridges/README
# already point owners at; Docker moved to ~/.hazlie/matrix-docker.
M="$HOME/.hazlie/matrix"
BIN="$HOME/.hazlie/bridges/bin"
SYN="$HOME/.hazlie/bridges/synapse"
RUN="$HOME/.hazlie/bridges/run"
SERVER_NAME="hazlie.local"
SYNAPSE_PORT=8008

MODE="all"
for arg in "$@"; do
  case "$arg" in
    --provision-only) MODE="provision" ;;
    --stop) MODE="stop" ;;
    --status) MODE="status" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# A MACHINE THAT ALREADY RAN THE CONTAINER STACK HAS ITS STATE SITTING HERE.
# Container-era homeserver.yaml holds the container's view of every path
# (/data/...), which nothing on this side can start from, and provisioning on
# top of it produces a half-converted directory whose failure surfaces later as
# a bridge that will not start with nothing pointing back at the cause.
#
# Refuse it and say what to do. There is no longer a container stack to go back
# to, so the instruction is to move the old directory aside and let this build
# a fresh one -- the bridges re-link and backfill, which is slow but works,
# where a silently mixed directory does not.
#
# .engine is the marker going forward. An install predating it is classified by
# what its own homeserver.yaml says.
claim_state_root() {
  marker="$M/.engine"
  if [ -f "$marker" ]; then
    found=$(cat "$marker" 2>/dev/null || echo unknown)
  elif [ -f "$M/synapse/homeserver.yaml" ]; then
    if grep -qE '(^|: )/data(/|$)' "$M/synapse/homeserver.yaml" 2>/dev/null; then
      found="docker"
    else
      found="native"
    fi
  else
    found="native"
  fi
  if [ "$found" != "native" ]; then
    echo "$M was written by the $found stack, which this build no longer runs." >&2
    echo "Move it aside and re-run; the bridges will re-link and backfill:" >&2
    echo "  mv \"$M\" \"$M.$found.bak\"" >&2
    echo "Nothing was changed." >&2
    exit 1
  fi
  mkdir -p "$M" && chmod 700 "$M"
  printf 'native\n' > "$marker"
}
[ "$MODE" = "status" ] || [ "$MODE" = "stop" ] || claim_state_root

# THE FULL-HISTORY MARKER, WHICH HERE IS ALWAYS A NO-OP -- AND MUST STILL BE
# WRITTEN.
#
# main added a one-time migration for installs provisioned with a 10000-message
# portal cap: back the bridge databases up, wipe them, re-link so the full
# history flows, and purge the derived corpus so it re-imports. That migration
# lived only in the container provisioner, which is gone.
#
# It is not ported, because there is nothing here it could migrate. This script
# has written 2147483647 since its first line of history -- the uncapped value
# checkBridgeHardening demands -- so a natively provisioned install has never
# had a capped portal to reset. A container-era directory does not reach this
# point either: claim_state_root refuses it above and tells the owner to move it
# aside, which produces a fresh uncapped install rather than a migrated one.
#
# What is NOT optional is writing the completion marker. Provision.swift reads
# it, and its rule is "an existing runtime WITHOUT this marker needs the
# migration" -- so leaving it unwritten made every launch of a working install
# re-run the whole bridge setup, forever, looking for a migration no script
# could perform any more. Written on a genuinely fresh directory before any
# later step can fail, for the same reason the container script gave: a retry
# must not mistake its own half-finished install for an old capped runtime.
FULL_HISTORY_MARKER="$M/.full-history-reset-v1"
mark_history_uncapped() {
  [ -f "$FULL_HISTORY_MARKER" ] && return 0
  ( umask 077; : > "$FULL_HISTORY_MARKER" )
}

# name  port   dbfile             binary
bridge_rows() {
cat <<'ROWS'
meta      29319 mautrix-meta      mautrix-meta-darwin-arm64
instagram 29330 mautrix-instagram mautrix-instagram-darwin-arm64
twitter   29327 mautrix-twitter   mautrix-twitter-darwin-arm64
telegram  29317 mautrix-telegram  mautrix-telegram-darwin-arm64
slack     29335 mautrix-slack     mautrix-slack-darwin-arm64
linkedin  29336 mautrix-linkedin  mautrix-linkedin-darwin-arm64
discord   29334 mautrix-discord   mautrix-discord-darwin-arm64
ROWS
}

# LAUNCHD OWNS THESE PROCESSES, not this script.
#
# They used to be nohup children, and this file's own header said so: "WHAT
# THIS DOES NOT DO: supervise ... launchd is the real answer and is the next
# leg." That was survivable only while Docker was the fallback, because
# Compose carried `restart: unless-stopped` underneath it. Docker is gone, so
# the missing leg became the whole story: a crashed bridge stopped that
# platform until somebody happened to re-run setup, and a reboot stopped
# everything. Eight agents, RunAtLoad + KeepAlive, ThrottleInterval 60 so a
# bridge that cannot start does not become a hot loop.
UID_=$(id -u)
AGENTS="$HOME/Library/LaunchAgents"
SUPERVISOR_LABEL="io.intaglio.bridges"

# ONE AGENT SUPERVISES ALL EIGHT, and it is our own signed node that does it.
#
# This briefly installed eight launchd agents -- one per bridge plus Synapse --
# which supervised correctly and put eight entries in the owner's Login Items
# naming binaries they never installed by name. AssociatedBundleIdentifiers is
# only honoured when the job's program shares a TEAM with the bundle it names,
# and the mautrix binaries and Synapse's CPython are ad-hoc with no team at all.
# ops/bridge-supervisor.mjs carries the full reasoning, including the two
# alternatives that were rejected.
#
# Crash recovery is not given up: the supervisor restarts its children with the
# same 60s floor launchd would have applied, and is itself RunAtLoad+KeepAlive.

alive() {
  launchctl print "gui/$UID_/$SUPERVISOR_LABEL" 2>/dev/null \
    | grep -qE '^[[:space:]]*pid = [0-9]+'
}

supervisor_pid() {
  launchctl print "gui/$UID_/$SUPERVISOR_LABEL" 2>/dev/null \
    | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p' | head -1
}

# The children are ordinary processes now, not launchd jobs, so ask the process
# table rather than launchctl. Matching on the binary path keeps this from
# counting an unrelated python or a developer's own mautrix build.
child_pid() {
  case "$1" in
    synapse) pgrep -f "$SYN/venv/bin/python -m synapse.app.homeserver" 2>/dev/null | head -1 ;;
    *)       pgrep -f "$BIN/mautrix-$1-darwin-arm64 " 2>/dev/null | head -1 ;;
  esac
}

# Render a template, LINT IT BEFORE INSTALLING, install 0600, and (re)load only
# when the content actually changed -- the same shape ops/setup-connectors.sh
# arrived at, including the ordering lesson it learned the hard way: validating
# after the move leaves a broken plist on disk, and the unchanged-file branch
# then compares it to itself forever.
install_agent() {
  src="$1"; shift
  dst="$AGENTS/$SUPERVISOR_LABEL.plist"
  mkdir -p "$AGENTS"
  rendered=$(sed "$@" "$src")
  changed=1
  if [ -f "$dst" ] && [ "$rendered" = "$(cat "$dst")" ]; then
    changed=0
  else
    tmp=$(mktemp -t hazlie-bridge-plist)
    printf '%s\n' "$rendered" > "$tmp"
    if ! plutil -lint "$tmp" >/dev/null 2>&1; then
      rm -f "$tmp"
      echo "  !! $SUPERVISOR_LABEL: rendered plist is malformed -- not installed" >&2
      return 1
    fi
    mv "$tmp" "$dst"
  fi
  # Reassert even when unchanged: a permissive mode must not survive a
  # nominally idempotent run.
  chmod 600 "$dst"
  if launchctl print "gui/$UID_/$SUPERVISOR_LABEL" >/dev/null 2>&1; then
    if [ "$changed" = "1" ]; then
      launchctl bootout "gui/$UID_/$SUPERVISOR_LABEL" 2>/dev/null || true
      wait_booted_out || return 1
      bootstrap_supervisor "$dst" || return 1
    fi
    launchctl kickstart -k "gui/$UID_/$SUPERVISOR_LABEL" 2>/dev/null || true
  else
    bootstrap_supervisor "$dst" || return 1
    launchctl kickstart "gui/$UID_/$SUPERVISOR_LABEL" 2>/dev/null || true
  fi
}

# BOOTOUT IS ASYNCHRONOUS, AND BOOTSTRAPPING INTO ITS WAKE FAILS.
#
# `launchctl bootout` returns before the service name is released, so a
# bootstrap issued immediately afterwards loses a race and answers
# "Bootstrap failed: 5: Input/output error". Both calls were `|| true`, so the
# script sailed on with NOTHING LOADED, found no bridges alive, and called
# abandon -- which tore down the stack it had just failed to start. That is how
# a routine re-run left the owner's machine with no bridges at all
# (2026-08-31). ops/setup-connectors.sh had already learned this and retries;
# this is the same fix, plus an explicit wait so the common case does not need
# the retries.
# THE JOB GOING AWAY IS NOT THE PORTS GOING AWAY. Booting the supervisor out
# stops its children, but the next supervisor starts its own Synapse the instant
# it is bootstrapped -- and if the previous one has not finished releasing :8008,
# the new one dies with "Couldn't listen on ::1:8008: Address already in use",
# the health wait times out, and abandon tears the whole stack down. That is a
# routine re-run leaving the machine with no bridges, and it happened twice on
# 2026-08-31 before this waited for the right thing.
#
# So wait for all three: the launchd job, the child processes, and the port.
wait_booted_out() {
  i=0
  while launchctl print "gui/$UID_/$SUPERVISOR_LABEL" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 20 ]; then
      echo "  !! $SUPERVISOR_LABEL would not boot out" >&2
      return 1
    fi
    sleep 1
  done
  i=0
  while [ -n "$(pgrep -f 'mautrix-.*-darwin-arm64|synapse\.app\.homeserver' 2>/dev/null)" ] \
        || lsof -nP -iTCP:"$SYNAPSE_PORT" -sTCP:LISTEN >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 25 ]; then
      # Stragglers, not a reason to give up: SIGKILL what is left rather than
      # bootstrapping a supervisor whose children cannot bind.
      echo "  stragglers from the previous stack; forcing them down" >&2
      pkill -9 -f 'mautrix-.*-darwin-arm64' 2>/dev/null || true
      pkill -9 -f 'synapse\.app\.homeserver' 2>/dev/null || true
      sleep 2
      break
    fi
    sleep 1
  done
  return 0
}

bootstrap_supervisor() {
  for _attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID_" "$1" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  # NOT `|| true`. A supervisor that did not load is the whole stack missing,
  # and the caller has to know that before it decides anything else.
  echo "  !! could not bootstrap $SUPERVISOR_LABEL after 5 attempts" >&2
  return 1
}

# Booting the supervisor out stops its children: it forwards SIGTERM on the way
# down. The eight per-bridge agents an earlier build installed are removed too,
# or they would keep restarting the same processes this one is trying to own.
stop_one() {
  label="io.intaglio.bridge.$1"
  [ "$1" = "synapse" ] && label="io.intaglio.synapse"
  if launchctl print "gui/$UID_/$label" >/dev/null 2>&1; then
    launchctl bootout "gui/$UID_/$label" 2>/dev/null || true
  fi
  rm -f "$AGENTS/$label.plist"
}

stop_all() {
  if launchctl print "gui/$UID_/$SUPERVISOR_LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$UID_/$SUPERVISOR_LABEL" 2>/dev/null || true
    echo "stopped the bridge supervisor"
  fi
  # The per-agent era, if this install came from that build.
  for n in synapse $(bridge_rows | awk '{print $1}'); do stop_one "$n"; done
  # And anything left from before launchd owned these at all.
  retire_pidfile_era
}

status_all() {
  if alive; then
    echo "  up    supervisor (pid $(supervisor_pid))"
  else
    echo "  down  supervisor"
  fi
  for n in synapse $(bridge_rows | awk '{print $1}'); do
    p=$(child_pid "$n")
    if [ -n "$p" ]; then echo "  up    $n (pid $p)"; else echo "  down  $n"; fi
  done
}

# RETIRE THE nohup ERA BEFORE CLAIMING ITS PORTS.
#
# Installs provisioned by the previous build of this branch are running as
# nohup children with pidfiles under $RUN, and launchd knows nothing about
# them. Bootstrapping the agents on top would put Synapse's agent into a
# restart loop against a :8008 that pid-from-a-file is still holding, and the
# seven appservice ports the same way -- a "native setup failed" on a machine
# whose bridges are, at that moment, working.
#
# One-time, and safe to run when there is nothing to do: no pidfiles means no
# loop body. SIGTERM, then a bounded wait, then SIGKILL -- these are Go
# binaries and a Python homeserver, all of which close their SQLite handles on
# a clean signal and none of which deserve an immediate -9.
retire_pidfile_era() {
  found=0
  for f in "$RUN"/*.pid; do
    [ -f "$f" ] || continue
    pid=$(cat "$f" 2>/dev/null || true)
    rm -f "$f"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null || continue
    found=1
    kill "$pid" 2>/dev/null || true
  done
  [ "$found" = "0" ] && return 0
  echo "retiring the previous unsupervised bridge processes"
  i=0
  while [ "$i" -lt 20 ]; do
    still=0
    for pid in $(pgrep -f 'mautrix-.*-darwin-arm64|synapse.app.homeserver' 2>/dev/null || true); do
      kill -0 "$pid" 2>/dev/null && still=1
    done
    [ "$still" = "0" ] && return 0
    i=$((i + 1))
    sleep 1
  done
  for pid in $(pgrep -f 'mautrix-.*-darwin-arm64|synapse.app.homeserver' 2>/dev/null || true); do
    kill -9 "$pid" 2>/dev/null || true
  done
}


case "$MODE" in
  stop) stop_all; exit 0 ;;
  status) status_all; exit 0 ;;
esac

# --- preconditions ------------------------------------------------------------
# Each of these is something a previous leg produces. Checked by ARTIFACT rather
# than by directory, because a half-built runtime is the failure that reports
# success (see ops/build-synapse.sh on why .ready exists).
# SELF-BOOTSTRAPPING, because the alternative is Docker.
#
# This used to demand a pre-built runtime and exit, which meant a fresh install
# had no .ready, fell through to the Docker provisioner, and started a Linux VM
# on a machine that never needed one. Docker being the FALLBACK only helps if the
# native path can reach a working state by itself.
#
# Nothing here needs a toolchain on the owner's machine: the bridge binaries are
# published Go executables, libolm ships prebuilt in the app bundle, and the
# Synapse runtime is a relocatable CPython plus wheels (--only-binary, so a
# missing wheel FAILS rather than silently starting a source build). What it does
# need is network, once. If any step fails the script exits non-zero and
# Provision falls back to Docker, which is exactly what a fallback is for.
NODE="${HZ_NODE:-$HOME/.hazlie/bin/node}"
[ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null || true)

# UNCONDITIONAL, because this gate used to read "is the Meta binary present".
# The downloads are sequential: Meta lands, the network drops during LinkedIn,
# and every later run sees Meta, skips the fetch forever, and dies at the
# missing-binaries check below -- a partial install that could never resume.
# fetch-bridges.mjs is written for exactly this ("fetch what is missing, verify
# all"): it re-hashes what is already there and downloads only the gaps, so the
# cost of running it every time is seven sha256s and the benefit is that an
# interrupted install repairs itself.
if [ -n "$NODE" ] && [ -f "$REPO/ops/fetch-bridges.mjs" ]; then
  echo "verifying bridge binaries"
  "$NODE" "$REPO/ops/fetch-bridges.mjs" || {
    echo "bridge fetch failed" >&2; exit 1;
  }
fi

if [ ! -f "$SYN/.ready" ] && [ -f "$REPO/ops/build-synapse.sh" ]; then
  echo "building the Synapse runtime (first run)"
  sh "$REPO/ops/build-synapse.sh" "$SYN" || {
    echo "synapse runtime build failed" >&2; exit 1;
  }
fi

[ -f "$SYN/.ready" ] || { echo "no Synapse runtime and could not build one" >&2; exit 1; }
# libolm comes from the app bundle on a real install and is built from source
# only in a checkout. It must sit BESIDE the binaries: their rpath lists
# @executable_path first, and upstream ships the dylib nowhere.
if [ ! -f "$BIN/libolm.3.dylib" ]; then
  BUNDLED="$REPO/bridges/lib/libolm.3.dylib"
  if [ -f "$BUNDLED" ]; then
    mkdir -p "$BIN"
    cp "$BUNDLED" "$BIN/libolm.3.dylib"
    chmod 0755 "$BIN/libolm.3.dylib"
  elif command -v cmake >/dev/null 2>&1; then
    sh "$REPO/ops/build-libolm.sh" "$BIN" >/dev/null 2>&1 || true
  fi
fi
[ -f "$BIN/libolm.3.dylib" ] || {
  echo "no libolm: the app should ship it at bridges/lib/libolm.3.dylib; in a" >&2
  echo "checkout run ops/build-libolm.sh (needs cmake)" >&2
  exit 1
}
missing=""
for b in $(bridge_rows | awk '{print $4}'); do
  [ -x "$BIN/$b" ] || missing="$missing $b"
done
[ -z "$missing" ] || {
  echo "missing bridge binaries:$missing" >&2
  echo "the first-run fetch above did not produce them; check the network and" >&2
  echo "re-run, or run: node ops/fetch-bridges.mjs" >&2
  exit 1
}

# THE BUNDLED COPY, BEFORE PATH. In a downloaded app $REPO is already
# Contents/Resources/backend and build.sh puts yq at $REPO/tools/yq -- the old
# third fallback appended an in-checkout "widget/build/Intaglio Labs.app/..."
# path underneath that, which exists in no bundle. So on a stock Mac with no
# Homebrew yq, every native setup died HERE, after paying for the bridge
# binaries and the whole Synapse runtime. Same resolution order the Docker
# provisioner already used, and for the same reason: pressing Connect must
# never require Homebrew. HZ_YQ stays first for release/CI validation.
YQ="${HZ_YQ:-$REPO/tools/yq}"
[ -x "$YQ" ] || YQ="$(command -v yq 2>/dev/null || true)"
[ -n "$YQ" ] && [ -x "$YQ" ] || {
  echo "bridge config editor is missing from this install; reinstall Intaglio Labs." >&2
  exit 1
}

PY="$SYN/venv/bin/python"
mkdir -p "$M" "$RUN"
chmod 0700 "$HOME/.hazlie/bridges" "$M" "$RUN" 2>/dev/null || true

# --- synapse ------------------------------------------------------------------
mkdir -p "$M/synapse"
if [ ! -f "$M/synapse/homeserver.yaml" ]; then
  # --data-directory replaces the image's implicit /data. Without it the
  # generated config points its database and media store at the CWD, which is
  # wherever this script happened to be run from.
  (cd "$M/synapse" && "$PY" -m synapse.app.homeserver \
      --server-name "$SERVER_NAME" \
      --config-path "$M/synapse/homeserver.yaml" \
      --data-directory "$M/synapse" \
      --generate-config --report-stats=no >/dev/null)
  echo "synapse: config written"
fi

# Registrations are listed by REAL PATH now. The compose stack could write
# /registrations/x.yaml because it bind-mounted them; nothing mounts anything
# here, so the homeserver reads each bridge's own file where the bridge wrote it.
NEEDS_RESTART=0
if grep -q app_service_config_files "$M/synapse/homeserver.yaml"; then
  for b in $(bridge_rows | awk '{print $1}'); do
    if ! grep -q "$M/$b/registration.yaml" "$M/synapse/homeserver.yaml"; then
      "$YQ" -i ".app_service_config_files += [\"$M/$b/registration.yaml\"]" "$M/synapse/homeserver.yaml"
      echo "synapse: registered $b"
      NEEDS_RESTART=1
    fi
  done
else
  # Same hardening the container config got: client API only, nothing federates,
  # no trusted key servers (the default reached out to matrix.org).
  "$YQ" -i '
    .trusted_key_servers = [] |
    .federation_domain_whitelist = [] |
    .app_service_config_files = []
  ' "$M/synapse/homeserver.yaml"
  for b in $(bridge_rows | awk '{print $1}'); do
    "$YQ" -i ".app_service_config_files += [\"$M/$b/registration.yaml\"]" "$M/synapse/homeserver.yaml"
  done
  python3 - "$M/synapse/homeserver.yaml" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
# Nothing federates on a loopback bus, so the federation resource comes out of
# the listener too. Same edit the container config made.
s = s.replace("- names: [client, federation]", "- names: [client]")
open(p, 'w').write(s)
PY
  echo "synapse: hardened (client-only, no federation, no key servers)"
  NEEDS_RESTART=1
fi

# --- bridges ------------------------------------------------------------------
bridge_rows | while read -r name port dbfile binary; do
  mkdir -p "$M/$name"
  cfg="$M/$name/config.yaml"
  reg="$M/$name/registration.yaml"

  if [ ! -f "$cfg" ]; then
    # Pre-bridgev2 bridges have no -e flag -- the container shipped their example
    # config and its entrypoint copied it in. ops/fetch-bridges.mjs downloads and
    # hash-checks that file from the source tree at the same pinned tag, so the
    # seed is verified rather than trusted.
    if [ -f "$BIN/$name-example-config.yaml" ]; then
      cp "$BIN/$name-example-config.yaml" "$cfg"
      chmod 0600 "$cfg"
    else
      "$BIN/$binary" -c "$cfg" -e >/dev/null
    fi
    [ -f "$cfg" ] || { echo "$name: config generation failed" >&2; exit 1; }
    echo "$name: config written"
  fi

  # THE LIMITS AND THE LOG LEVEL ARE MAIN'S, PORTED VERBATIM, and both are
  # load-bearing rather than cosmetic.
  #
  # 2147483647 uncaps history: this used to write 10000, which silently decided
  # how much of somebody's own past they were allowed to keep. connectors/lib/
  # checks.mjs checkBridgeHardening FAILs anything lower, so a native install
  # with the old numbers reported broken and its fix string pointed at the
  # Docker script.
  #
  # logging.min_level = info is a PRIVACY setting, not a verbosity preference:
  # the check's own words are "debug logs may contain message bodies". Neither
  # setup script set it before, so it is the one hardening failure that bites
  # Docker installs too until they re-provision.
  #
  # Re-applied every run, not only on first write: a bridge whose first attempt
  # wrote an example config and then failed before registration must be fixable
  # by re-running, and mautrix only writes registration.yaml once the homeserver
  # is configured.
  if [ "$name" = "discord" ]; then
    # Pre-bridgev2 shape: database under appservice, backfill and double-puppet
    # under bridge.* — the shapes checkBridgeHardening() calls legacy.
    "$YQ" -i "
      .homeserver.address = \"http://127.0.0.1:$SYNAPSE_PORT\" |
      .homeserver.domain = \"$SERVER_NAME\" |
      .appservice.address = \"http://127.0.0.1:$port\" |
      .appservice.hostname = \"127.0.0.1\" |
      .appservice.port = $port |
      .appservice.database.type = \"sqlite3-fk-wal\" |
      .appservice.database.uri = \"file:$M/$name/$dbfile.db?_txlock=immediate\" |
      .bridge.permissions = {\"$SERVER_NAME\": \"user\", \"@you:$SERVER_NAME\": \"admin\"} |
      .bridge.startup_private_channel_create_limit = 2147483647 |
      .bridge.backfill.forward_limits.initial.dm = 2147483647 |
      .bridge.backfill.forward_limits.initial.channel = 2147483647 |
      .bridge.backfill.forward_limits.initial.thread = 2147483647 |
      .bridge.backfill.forward_limits.missed.dm = -1 |
      .bridge.backfill.forward_limits.missed.channel = -1 |
      .bridge.backfill.forward_limits.missed.thread = -1 |
      .bridge.double_puppet_server_map = {} |
      .logging.min_level = \"info\"
    " "$cfg"
  else
    "$YQ" -i "
      .homeserver.address = \"http://127.0.0.1:$SYNAPSE_PORT\" |
      .homeserver.domain = \"$SERVER_NAME\" |
      .appservice.address = \"http://127.0.0.1:$port\" |
      .appservice.hostname = \"127.0.0.1\" |
      .appservice.port = $port |
      .database.type = \"sqlite3-fk-wal\" |
      .database.uri = \"file:$M/$name/$dbfile.db?_txlock=immediate\" |
      .bridge.permissions = {\"$SERVER_NAME\": \"user\", \"@you:$SERVER_NAME\": \"admin\"} |
      .backfill.enabled = true |
      .backfill.max_initial_messages = 2147483647 |
      .backfill.max_catchup_messages = 2147483647 |
      .backfill.threads.max_initial_messages = 2147483647 |
      .double_puppet.secrets = {} |
      .logging.min_level = \"info\"
    " "$cfg"
  fi

  if [ ! -f "$reg" ]; then
    "$BIN/$binary" -c "$cfg" -r "$reg" -g >/dev/null
    [ -f "$reg" ] || { echo "$name: registration generation failed" >&2; exit 1; }
    echo "$name: registration written"
  fi
done

[ "$MODE" = "provision" ] && { echo "provisioned (not started)"; exit 0; }

# --- up -----------------------------------------------------------------------
# NOTHING IS LEFT RUNNING BY A SETUP THAT FAILED. Synapse binds :8008 before
# the bridges are even installed, so an abort after this point used to leave a
# homeserver holding the port with no bridges behind it -- and the next run,
# or anything else wanting :8008, met a listener it had not started. Every exit
# path below goes through this.
abandon() {
  echo "$1" >&2
  stop_all
  exit 1
}

retire_pidfile_era

# RETIRE THE PER-PROCESS AGENT ERA TOO, AND ON THE SUCCESS PATH.
#
# The build between the nohup era and this one installed eight launchd agents,
# one per process. They are still loaded on any machine that ran it, still hold
# :8008 and the seven appservice ports, and launchd will keep restarting them --
# so bringing the supervisor up beside them produces two of everything, with the
# second copy failing to bind and retrying forever.
#
# This lived only inside stop_all(), which only abandon() calls, so it ran on
# failure and never on the ordinary upgrade path. Measured: a successful run
# left seven stale agents loaded next to the new supervisor.
retire_per_agent_era() {
  found=0
  for n in synapse $(bridge_rows | awk '{print $1}'); do
    label="io.intaglio.bridge.$n"
    [ "$n" = "synapse" ] && label="io.intaglio.synapse"
    if launchctl print "gui/$UID_/$label" >/dev/null 2>&1; then
      launchctl bootout "gui/$UID_/$label" 2>/dev/null || true
      found=1
    fi
    rm -f "$AGENTS/$label.plist"
  done
  [ "$found" = "1" ] && echo "retired the per-process bridge agents"
  # Give launchd a moment to actually release the ports before the supervisor
  # tries to claim them.
  [ "$found" = "1" ] && sleep 3
  return 0
}
retire_per_agent_era

# --- telegram's missing half --------------------------------------------------
# PORTED FROM THE CONTAINER SCRIPT, which is where this lived and which is gone.
# Without it Telegram regresses from "a phone-and-code login like every other
# platform" to "register your own app at my.telegram.org first", for every user
# of every build -- including builds that ship a credential precisely so nobody
# has to. widget/build.sh still bakes the pair in and still says so.
#
# The generated config ships mautrix's EXAMPLE credentials (api_id 12345) and
# the bridge refuses to start on them, so the example id is the reliable "not
# yet configured" signal rather than an empty key.
#
# THREE PLACES A REAL PAIR CAN COME FROM, in this order. None of them is this
# repository, and that is deliberate: it is public, and Telegram refuses logins
# made with any api_id it finds in public code (API_ID_PUBLISHED_FLOOD). See
# the note at PLATFORMS.telegram in connect/lib/bridge.mjs.
#   1. $HZ_TELEGRAM_APP        -- an explicit run, or CI from a repo secret
#   2. ~/.hazlie/secrets/telegram-app.txt -- this machine's own copy (0600)
#   3. the installed app's bundled copy   -- what widget/build.sh baked in
# The per-user walkthrough in the widget stays live underneath all three: it
# writes the same two keys through the same path, so a flagged shipped id
# degrades to "register your own" instead of to nothing.
telegram_app_credential() {
  if [ -n "${HZ_TELEGRAM_APP:-}" ]; then printf '%s' "$HZ_TELEGRAM_APP"; return; fi
  if [ -f "$HOME/.hazlie/secrets/telegram-app.txt" ]; then
    tr -d '[:space:]' < "$HOME/.hazlie/secrets/telegram-app.txt"; return
  fi
  for app in "/Applications/Intaglio Labs.app" "$HOME/Applications/Intaglio Labs.app"; do
    if [ -f "$app/Contents/Resources/backend/telegram-app" ]; then
      tr -d '[:space:]' < "$app/Contents/Resources/backend/telegram-app"; return
    fi
  done
  printf ''
}

TELEGRAM_UNCONFIGURED=0
if [ "$("$YQ" '.network.api_id // 0' "$M/telegram/config.yaml" 2>/dev/null)" = "12345" ]; then
  TG_APP="$(telegram_app_credential)"
  # An explicit CI/local override arrives in this process's environment. Drop it
  # before sed or any other child can inherit the credential.
  unset HZ_TELEGRAM_APP || true
  # Shape-checked before it is written. A malformed pair produces a bridge that
  # crash-loops with nothing on the machine naming the cause -- which under
  # launchd's KeepAlive is exactly the hot loop ThrottleInterval exists for.
  if printf '%s' "$TG_APP" | grep -Eq '^[0-9]{1,12}:[0-9a-fA-F]{32}$'; then
    TG_ID="${TG_APP%%:*}"
    TG_HASH="${TG_APP#*:}"
    # Targeted line replacement, not a yq round trip: mautrix's generated config
    # carries ~700 lines of comments that a re-serialise would flatten. Feed the
    # replacement program over stdin so the API hash never appears in sed's argv
    # (and therefore never flashes in another process's `ps` view).
    {
      # DOUBLED BACKSLASHES, AND THEY ARE LOAD-BEARING. printf eats one level of
      # escaping, so a single \1 here is not sed's backreference -- it is printf's
      # octal escape for 0x01, and what reaches the config is a literal control
      # character where the key name should be. That is exactly what happened
      # when this block was ported from the container script: it replaced
      # "api_id:" with ^A, and mautrix then refused the file with "yaml: control
      # characters are not allowed". Verified with printf before re-committing.
      printf 's/^\\([[:space:]]*api_id:\\).*/\\1 %s/\n' "$TG_ID"
      printf 's/^\\([[:space:]]*api_hash:\\).*/\\1 "%s"/\n' "$TG_HASH"
    } | /usr/bin/sed -i '' -f - "$M/telegram/config.yaml"
    echo "telegram: configured from a shipped app credential"
  else
    TELEGRAM_UNCONFIGURED=1
    echo "telegram: needs api_id + api_hash from my.telegram.org/apps"
    echo "          the widget's Telegram tile walks you through it, or set them"
    echo "          by hand in $M/telegram/config.yaml and then re-run this script."
  fi
fi

# THE WHOLE STACK, UNDER ONE AGENT. The supervisor starts Synapse and every
# configured bridge as its own children. Telegram's credential is written above
# rather than below, so the supervisor's first pass either starts it with a real
# api_id or knowingly skips it -- it does not spend a 60s retry on a config this
# script was about to fix.
#
# NEEDS_RESTART used to boot the synapse agent out on its own; the supervisor
# owns every process now, so a config change means restarting the supervisor,
# which install_agent's kickstart -k does unconditionally.
NODE_BIN="${HZ_NODE:-$HOME/.hazlie/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN=$(command -v node 2>/dev/null || true)
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] \
  || abandon "no node to run the bridge supervisor with"

install_agent "$REPO/ops/io.intaglio.bridges.plist" \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@REPO@|$REPO|g" \
  || abandon "could not install the bridge supervisor"

i=0
until curl -sf "http://127.0.0.1:$SYNAPSE_PORT/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 45 ]; then
    tail -20 "$RUN/synapse.log" >&2 2>/dev/null || true
    abandon "synapse never became healthy; see $RUN/synapse.log"
  fi
  sleep 2
done
echo "synapse: healthy on 127.0.0.1:$SYNAPSE_PORT"

# --- the owner ----------------------------------------------------------------
# BEFORE the credentials, not after: Provision reads "credentials present,
# marker absent" as "this install needs the migration", so a run that died in
# between would send every later launch back through the whole setup.
mark_history_uncapped

if [ ! -f "$M/owner-credentials.json" ]; then
  # REGISTERED THROUGH THE SHARED-SECRET ADMIN API, not through
  # register_new_matrix_user.
  #
  # That console script is what `docker exec hazlie-synapse
  # register_new_matrix_user` reached for, and it does not work in a clean venv:
  # it imports `requests`, which matrix-synapse declares as a dependency
  # NOWHERE. The container image happened to have it. Pulling requests plus
  # urllib3, certifi, charset-normalizer and idna into a locked runtime to
  # satisfy one undeclared import, for a step that runs exactly once, is a bad
  # trade.
  #
  # The endpoint underneath that script is documented and needs only the
  # standard library: GET a nonce, HMAC it with the registration_shared_secret
  # Synapse already wrote into homeserver.yaml, POST. That is the same "the
  # owner is created via the shared secret" the container path described; this
  # calls it directly instead of through a broken wrapper.
  PW="$(openssl rand -hex 24)"
  # $M is passed, not assumed. The guard above tests "$M/owner-credentials.json"
  # while the write below named ~/.hazlie/matrix outright; the two agreed only
  # because this engine's root happens to be that path. Same latent split as the
  # docker script had, fixed the same way.
  python3 - "$PW" "$SYNAPSE_PORT" "$SERVER_NAME" "$M/synapse/homeserver.yaml" "$M" <<'PY'
import hashlib, hmac, json, os, re, sys, urllib.request

pw, port, server, config, state_root = sys.argv[1:6]
base = 'http://127.0.0.1:' + port

# Read the secret without a YAML parser. This runs on the SYSTEM python, which
# may have nothing installed; the venv's python is not used here because it
# would drag the homeserver's own environment into a step that only needs HTTP.
# Synapse writes the key on one line, quoted.
secret = None
for line in open(config, encoding='utf-8'):
    m = re.match(r'^registration_shared_secret:\s*"(.*)"\s*$', line)
    if m:
        secret = m.group(1)
        break
if not secret:
    sys.exit('no registration_shared_secret in homeserver.yaml')

def post(path, payload):
    req = urllib.request.Request(
        base + path, data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

nonce = json.load(urllib.request.urlopen(base + '/_synapse/admin/v1/register'))['nonce']
# The MAC is over NUL-separated fields in this exact order, with the literal
# "notadmin" for a non-admin user. A wrong order or separator fails closed with
# M_FORBIDDEN rather than creating the wrong user, which is the good direction
# for this to fail in.
mac = hmac.new(
    key=secret.encode('utf8'),
    msg=b'\x00'.join([nonce.encode(), b'you', pw.encode(), b'notadmin']),
    digestmod=hashlib.sha1,
).hexdigest()
post('/_synapse/admin/v1/register', {
    'nonce': nonce, 'username': 'you', 'password': pw,
    'admin': False, 'mac': mac,
})
print('registered @you:' + server)

tok = post('/_matrix/client/v3/login', {
    'type': 'm.login.password',
    'identifier': {'type': 'm.id.user', 'user': 'you'},
    'password': pw,
})['access_token']
path = os.path.join(state_root, 'owner-credentials.json')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump({"homeserver": base,
               "user_id": "@you:" + server,
               "access_token": tok, "password": pw}, f, indent=2)
print("owner-credentials.json written (0600)")
PY
fi

# BOOTSTRAPPED IS NOT RUNNING, AND THIS SCRIPT'S EXIT CODE IS LOAD-BEARING.
#
# The supervisor being up says nothing about its children: it starts a bridge
# whose binary is missing or whose config is bad exactly as readily as one that
# works, and reports it in its own log. Give it a moment past its first spawn,
# then ask the process table.
sleep 6
dead=""; live=0
for name in $(bridge_rows | awk '{print $1}'); do
  # Telegram-without-a-credential is a deliberate non-start, not a failure, and
  # counting it as dead would report a healthy six-platform install as broken.
  [ "$name" = "telegram" ] && [ "$TELEGRAM_UNCONFIGURED" = "1" ] && continue
  if [ -n "$(child_pid "$name")" ]; then live=$((live + 1)); else dead="$dead $name"; fi
done

echo
status_all

if [ -n "$dead" ]; then
  echo >&2
  echo "these bridges did not come up:$dead" >&2
  echo "the supervisor will keep retrying them (60s floor); the logs say why:" >&2
  for name in $dead; do
    echo "--- $name ---" >&2
    tail -15 "$RUN/$name.log" >&2 2>/dev/null || echo "  (no log yet)" >&2
  done
fi

# Partial failure is NOT a failed run. Six working platforms and one that needs
# a credential the owner has to create -- telegram's api_id is the standing
# example -- is a working install with a note, and the supervisor keeps retrying
# the odd one out. Only a total washout means the runtime itself did not work,
# and that is the case where leaving a homeserver holding :8008 helps nobody.
if [ "$live" -eq 0 ]; then
  abandon "no bridge came up; native setup failed"
fi
