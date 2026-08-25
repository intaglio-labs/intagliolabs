#!/usr/bin/env bash
# Installs the connectors tier: the stable node binary the Full Disk Access
# grant attaches to, the ~/.hazlie runtime tree, the connector secrets, and
# the launchd agents that keep Hermes and the connectors daemon resident.
#
# Idempotent — every step checks before acting, so re-running after a partial
# failure (or after a plist change) is the intended recovery path. Existing
# secrets are always retained; the stable binary is never replaced without an
# explicit flag, because the FDA grant is attached to that exact file.
#
# Run ops/setup-llm.sh FIRST: it generates the two secrets Hermes refuses to
# start without (llama-api-key.txt, hermes-token.txt).
#
# Flags:
#   --replace-node   allow replacing an existing ~/.hazlie/bin/node whose
#                    version differs from the system node. Read the warning
#                    step (b) prints before using this: replacing the binary
#                    can invalidate the Full Disk Access grant.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HAZLIE="$HOME/.hazlie"
BIN_DIR="$HAZLIE/bin"
LIB_DIR="$HAZLIE/lib"
SECRET_DIR="$HAZLIE/secrets"
LOG_DIR="$HAZLIE/logs"
STABLE_NODE="$BIN_DIR/node"
NODE_VERSION_STAMP="$BIN_DIR/node.version"
HERMES_HEALTH_URL="http://127.0.0.1:${HERMES_PORT:-51789}/health"  # hermes.mjs default port (canonical since 2026-08-20)

REPLACE_NODE=0
for arg in "$@"; do
  case "$arg" in
    --replace-node) REPLACE_NODE=1 ;;
    *) echo "unknown flag: $arg (only --replace-node is supported)" >&2; exit 1 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

# ── (a) runtime directory tree ────────────────────────────────────────────────
step "runtime directory tree (~/.hazlie)"
mkdir -p "$BIN_DIR" "$LIB_DIR" "$HAZLIE/cache" "$HAZLIE/connectors" "$SECRET_DIR" "$LOG_DIR"
# ~/.hazlie can predate this script or have been created under a permissive
# umask. Everything under it is Hazlie-private state, so reassert the whole
# tree on every run rather than trusting whichever run created each piece.
chmod 700 "$HAZLIE" "$BIN_DIR" "$LIB_DIR" "$HAZLIE/cache" "$HAZLIE/connectors" "$SECRET_DIR" "$LOG_DIR"
echo "    0700 asserted on ~/.hazlie and children"

# Every connector's loadConfig() (connectors/daemon.mjs) refuses to run at all
# without this file, and every top-level key in it is optional — so a bare "{}"
# is a fully valid config. Without this step a fresh install could complete
# every other part of setup and still have zero working connectors, with each
# one failing identically ("connectors config file is missing") for a reason
# none of them state (ops/CONNECTORS.md, "Configuration (config.json)").
CONFIG_FILE="$HAZLIE/connectors/config.json"
if [[ -f "$CONFIG_FILE" ]]; then
  chmod 600 "$CONFIG_FILE"
  echo "    config.json present (mode 0600 reasserted)"
else
  printf '{}\n' > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "    config.json created (empty; see ops/CONNECTORS.md, \"Configuration (config.json)\" to customize)"
fi

# ── (b) stable node binary ────────────────────────────────────────────────────
# TCC grants Full Disk Access to one exact file. /opt/homebrew/bin/node is a
# symlink into a Cellar directory that brew upgrade deletes, so the grant must
# live on a copy that only changes when a human decides it should. FDA also
# does not propagate through wrappers — the plists execute this copy directly.
step "stable node binary ($STABLE_NODE)"
command -v node >/dev/null 2>&1 || {
  echo "ERROR: no node on PATH. Install Node 23+ (brew install node) and re-run." >&2
  exit 1
}
SYSTEM_NODE="$(readlink -f "$(command -v node)")"
SYSTEM_NODE_VERSION="$("$SYSTEM_NODE" --version)"

# Discover which libnode dylib this build links (some builds are static).
LIBNODE_REF="$(otool -L "$SYSTEM_NODE" | awk '/libnode/{print $1; exit}')"
LIBNODE_NAME=""
LIBNODE_SRC=""
if [[ -n "$LIBNODE_REF" ]]; then
  LIBNODE_NAME="$(basename "$LIBNODE_REF")"
  SYSTEM_NODE_DIR="$(dirname "$SYSTEM_NODE")"
  for cand in "$SYSTEM_NODE_DIR/../lib/$LIBNODE_NAME" "$SYSTEM_NODE_DIR/$LIBNODE_NAME"; do
    if [[ -f "$cand" ]]; then
      LIBNODE_SRC="$(cd "$(dirname "$cand")" && pwd)/$LIBNODE_NAME"
      break
    fi
  done
  if [[ -z "$LIBNODE_SRC" ]]; then
    echo "ERROR: $SYSTEM_NODE links $LIBNODE_NAME but no such file exists on its rpath" >&2
    echo "(looked next to the binary and in ../lib). The copy would not run." >&2
    exit 1
  fi
fi

install_stable_node() {
  # The dylib first: the binary resolves @rpath/libnode at exec, and a binary
  # copied before its library would leave a broken stable node on a crash
  # between the two copies.
  if [[ -n "$LIBNODE_SRC" ]]; then
    cp -f "$LIBNODE_SRC" "$LIB_DIR/$LIBNODE_NAME"
    chmod 644 "$LIB_DIR/$LIBNODE_NAME"
    echo "    copied $LIBNODE_NAME -> $LIB_DIR/"
  fi
  cp -f "$SYSTEM_NODE" "$STABLE_NODE"
  chmod 755 "$STABLE_NODE"
  printf '%s\n' "$SYSTEM_NODE_VERSION" > "$NODE_VERSION_STAMP"
  chmod 600 "$NODE_VERSION_STAMP"
  echo "    installed: $STABLE_NODE ($SYSTEM_NODE_VERSION)"
}

if [[ -x "$STABLE_NODE" ]]; then
  # A missing dylib makes the existing binary unrunnable; restoring the dylib
  # does not touch the granted file, so it never needs the replace flag.
  if [[ -n "$LIBNODE_NAME" && ! -f "$LIB_DIR/$LIBNODE_NAME" ]]; then
    cp -f "$LIBNODE_SRC" "$LIB_DIR/$LIBNODE_NAME"
    chmod 644 "$LIB_DIR/$LIBNODE_NAME"
    echo "    restored missing $LIBNODE_NAME -> $LIB_DIR/"
  fi
  STABLE_VERSION="$("$STABLE_NODE" --version 2>/dev/null || echo unknown)"
  if [[ "$STABLE_VERSION" == "$SYSTEM_NODE_VERSION" ]]; then
    # Reassert the stamp even when nothing changed, so doctor's comparison
    # never trips on a stamp lost to a partial earlier run.
    printf '%s\n' "$STABLE_VERSION" > "$NODE_VERSION_STAMP"
    chmod 600 "$NODE_VERSION_STAMP"
    echo "    present: $STABLE_NODE ($STABLE_VERSION; version stamp matches)"
  elif [[ "$REPLACE_NODE" == 1 ]]; then
    install_stable_node
    echo ""
    echo "    !! The stable binary was REPLACED ($STABLE_VERSION -> $SYSTEM_NODE_VERSION)."
    echo "    !! macOS may treat the new file as ungranted. Verify with a"
    echo "    !! launchd-spawned doctor run (ops/CONNECTORS.md, 'FDA runbook');"
    echo "    !! if fda-* checks fail there, re-grant Full Disk Access to"
    echo "    !! $STABLE_NODE in System Settings."
  else
    echo "" >&2
    echo "!!  REFUSING to replace $STABLE_NODE" >&2
    echo "!!  installed: $STABLE_VERSION    system node: $SYSTEM_NODE_VERSION" >&2
    echo "!!" >&2
    echo "!!  The Full Disk Access grant is attached to that exact file, and every" >&2
    echo "!!  resident agent (hermes, connectors) executes it. Replacing it can" >&2
    echo "!!  invalidate the grant and silently blind every Apple-store connector" >&2
    echo "!!  until a human re-grants and re-verifies." >&2
    echo "!!" >&2
    echo "!!  If the version change is intended, re-run with --replace-node, then" >&2
    echo "!!  follow the re-grant steps it prints." >&2
    exit 1
  fi
else
  install_stable_node
  echo ""
  echo "    grant Full Disk Access to this file once (System Settings >"
  echo "    Privacy & Security > Full Disk Access > + > $STABLE_NODE);"
  echo "    the runbook in ops/CONNECTORS.md has the verification steps."
fi

# ── (c) secrets ───────────────────────────────────────────────────────────────
step "secrets ($SECRET_DIR)"

# Hermes' own secrets are setup-llm.sh's to generate; refuse rather than grow a
# second generator that drifts. Under KeepAlive a Hermes missing its secrets
# would refuse-and-relaunch forever, so this is checked before any bootstrap.
for f in hermes-token.txt llama-api-key.txt; do
  if [[ ! -f "$SECRET_DIR/$f" ]]; then
    echo "ERROR: $SECRET_DIR/$f is missing. Run ops/setup-llm.sh first." >&2
    exit 1
  fi
done
echo "    hermes-token.txt / llama-api-key.txt present (setup-llm.sh's)"

# Granola API key: arrives from the Granola app, not from a generator here, so
# presence is verified and permissions reasserted — never prompted for.
GRANOLA_KEY_FILE="$SECRET_DIR/granola-api-key.txt"
if [[ -L "$GRANOLA_KEY_FILE" ]] || [[ -e "$GRANOLA_KEY_FILE" && ! -f "$GRANOLA_KEY_FILE" ]]; then
  echo "ERROR: $GRANOLA_KEY_FILE must be a regular, non-symlink file." >&2
  exit 1
fi
if [[ -f "$GRANOLA_KEY_FILE" ]]; then
  chmod 600 "$GRANOLA_KEY_FILE"
  echo "    granola-api-key.txt present (mode 0600 reasserted)"
else
  echo "    WARNING: granola-api-key.txt is missing — the granola connector is"
  echo "    disabled until the key from the Granola app is saved there (0600)."
fi

# Gmail app password: the one secret a human has to type. read -s so it never
# lands in shell history or process listings; written via mktemp + mv so a
# crash mid-write cannot leave a world-readable partial file.
GMAIL_FILE="$SECRET_DIR/gmail-app-password.txt"
if [[ -L "$GMAIL_FILE" ]] || [[ -e "$GMAIL_FILE" && ! -f "$GMAIL_FILE" ]]; then
  echo "ERROR: $GMAIL_FILE must be a regular, non-symlink file." >&2
  exit 1
fi
if [[ -f "$GMAIL_FILE" ]]; then
  chmod 600 "$GMAIL_FILE"
  echo "    gmail-app-password.txt present (mode 0600 reasserted)"
elif [[ -t 0 ]]; then
  echo "    gmail-app-password.txt is missing. Create one at"
  echo "    https://myaccount.google.com/apppasswords and paste it here"
  echo "    (input hidden; press Enter alone to skip — mail stays disabled):"
  read -rs -p "    app password: " GMAIL_APP_PASSWORD
  echo
  GMAIL_APP_PASSWORD="${GMAIL_APP_PASSWORD// /}"  # Google displays it in spaced groups
  if [[ -n "$GMAIL_APP_PASSWORD" ]]; then
    gmail_tmp=$(mktemp "$SECRET_DIR/.gmail-app-password.XXXXXX")
    trap 'rm -f "${gmail_tmp:-}"' EXIT
    printf '%s\n' "$GMAIL_APP_PASSWORD" > "$gmail_tmp"
    chmod 600 "$gmail_tmp"
    mv "$gmail_tmp" "$GMAIL_FILE"
    gmail_tmp=
    trap - EXIT
    unset GMAIL_APP_PASSWORD
    echo "    saved owner-only gmail-app-password.txt"
  else
    unset GMAIL_APP_PASSWORD
    echo "    skipped — mail connector disabled until it exists"
  fi
else
  echo "    gmail-app-password.txt is missing and stdin is not a terminal —"
  echo "    skipping the prompt (mail connector disabled); re-run interactively."
fi

# Oura tokens are OAuth2 artifacts, not a value a human can type: a separate
# helper mints ~/.hazlie/secrets/oura-tokens.json after the browser consent
# flow, and the connector rotates the refresh token from then on. That helper
# is future work — see ops/CONNECTORS.md, "The Oura connector".
echo "    oura-tokens.json: minted by the Oura OAuth helper (not this script);"
echo "    the oura connector stays disabled until it exists"

# ── (d) connectors dependencies ───────────────────────────────────────────────
step "connectors dependencies (npm ci)"
if [[ -f "$REPO_ROOT/connectors/package.json" ]]; then
  (cd "$REPO_ROOT/connectors" && npm ci)
  # THE PURE-JS RULE, CHECKED RATHER THAN TRUSTED. connectors/AGENTS.md forbids
  # native modules here, and the reason is not tidiness: this daemon runs under
  # a COPIED node binary (~/.hazlie/bin/node) because Full Disk Access is
  # granted per resolved binary. A native module binds a compiled ABI to the
  # node it was built for and breaks SILENTLY when that binary is swapped —
  # the failure surfaces weeks later, in launchd, with nothing pointing back at
  # the upgrade. The rule said "verified at install time"; nothing verified it.
  native=$(find "$REPO_ROOT/connectors/node_modules" \
    \( -name '*.node' -o -name 'binding.gyp' \) -print -quit 2>/dev/null || true)
  if [[ -n "$native" ]]; then
    echo "    !! a native module landed in connectors/node_modules:" >&2
    echo "    !!   $native" >&2
    echo "    !! connectors/AGENTS.md forbids these — the daemon runs under a" >&2
    echo "    !! copied node and a compiled ABI breaks silently when it is" >&2
    echo "    !! swapped. Remove the dependency that pulled it in." >&2
    exit 1
  fi
  echo "    installed (pure JS verified)"
else
  echo "    connectors/package.json not present yet (a concurrent commit adds"
  echo "    it) — skipping npm ci; re-run this script after it lands."
fi

# ── (e) launchd agents ────────────────────────────────────────────────────────
step "launchd agents"

# THE PRE-RENAME AGENTS, RETIRED FIRST. The reverse-DNS namespace moved from
# com.hazlie.* to io.intaglio.* on 2026-08-25, to derive from the domain the
# project actually owns (intaglio.io). launchd keys a service on its LABEL, so
# the old agents are not "replaced" by the new ones — they are simply a second
# set, still loaded, still KeepAlive, still executing the same scripts against
# the same database. Two hermes instances racing for port 51789 is the visible
# failure; two connector daemons racing for the same cursors is the quiet one.
# Retired here rather than in a migration note, because a note only helps the
# person who reads it.
# ONLY THE AGENTS THIS SCRIPT OWNS. llama-server is setup-llm.sh's, and
# retiring it here left a machine with no llama-server at all: this script
# booted the old one out and nothing in it installs the replacement, so
# `/vault/ask` answered "fetch failed" until setup-llm.sh was re-run. An
# uninstall step for an agent you do not install is a hole, not a migration.
for old in hermes connect connectors whatsapp-keepalive; do
  old_label="com.hazlie.$old"
  old_plist="$HOME/Library/LaunchAgents/$old_label.plist"
  if launchctl print "gui/$UID/$old_label" >/dev/null 2>&1; then
    launchctl bootout "gui/$UID/$old_label" 2>/dev/null || true
    echo "    retired pre-rename agent $old_label"
  fi
  if [[ -f "$old_plist" ]]; then
    rm -f "$old_plist"
    echo "    removed $old_plist"
  fi
done

bootstrap_agent() {
  local plist_dst="$1" label="$2"
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID" "$plist_dst"; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: launchctl could not bootstrap $label after 5 attempts." >&2
  return 1
}

# Render @HOME@/@REPO@, lint, install 0600, and (re)load — the same
# change-detection setup-llm.sh uses, so an unchanged agent is left alone and
# a changed one is booted out and back rather than restarted stale.
install_agent() {
  local label="$1"
  local src="$SCRIPT_DIR/$label.plist"
  local dst="$HOME/Library/LaunchAgents/$label.plist"
  [[ -f "$src" ]] || { echo "ERROR: $src missing." >&2; exit 1; }
  local rendered changed=1
  rendered=$(sed -e "s|@HOME@|$HOME|g" -e "s|@REPO@|$REPO_ROOT|g" "$src")
  if [[ -f "$dst" ]] && [[ "$rendered" == "$(cat "$dst")" ]]; then
    changed=0
    echo "    $label: installed plist already current"
  else
    mkdir -p "$(dirname "$dst")"
    # LINT BEFORE INSTALLING, not after. The old order wrote the rendered plist
    # into ~/Library/LaunchAgents and validated it on the next line, so a
    # malformed template left a broken agent file on disk — and because the
    # "already current" branch above skips the lint entirely, the next run
    # compared the broken file to itself, called it current, and never checked
    # it again. Validate a temp copy, then move it into place.
    tmp_plist="$(mktemp -t hazlie-plist)"
    printf '%s\n' "$rendered" > "$tmp_plist"
    if ! plutil -lint "$tmp_plist" >/dev/null; then
      rm -f "$tmp_plist"
      echo "    !! $label: rendered plist is malformed — not installed" >&2
      exit 1
    fi
    mv "$tmp_plist" "$dst"
    echo "    $label: installed $dst"
  fi
  # Reassert even when unchanged: a permissive chmod must not survive an
  # otherwise idempotent setup run.
  chmod 600 "$dst"
  if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
    if [[ "$changed" == 1 ]]; then
      echo "    $label: reloading (plist changed)"
      launchctl bootout "gui/$UID/$label"
      bootstrap_agent "$dst" "$label"
      launchctl kickstart -k "gui/$UID/$label"
    else
      echo "    $label: already loaded"
    fi
  else
    bootstrap_agent "$dst" "$label"
    launchctl kickstart "gui/$UID/$label"
    echo "    $label: bootstrapped"
  fi
}

install_agent io.intaglio.hermes
install_agent io.intaglio.connect

# WhatsApp Desktop only syncs while it is running, so the connector's freshness
# is bounded by how often the owner opens the app (ops/PROBES.md measured the
# newest message as ~2 months old for exactly this reason). This agent opens it
# hidden every 4 hours to keep the local store current.
#
# It was LOADED ON THE OWNER'S MACHINE BY HAND and no script installed it, so a
# fresh Mac would silently have no WhatsApp freshness at all — messages would
# just quietly stop being recent, with nothing to point at. Installed here now.
# Gated on the connector existing, same as the daemon below: keeping WhatsApp
# awake for a connector that is not built would be a daily app launch for
# nothing.
if [[ -f "$REPO_ROOT/connectors/sources/whatsapp.mjs" ]]; then
  install_agent io.intaglio.whatsapp-keepalive
else
  echo "    io.intaglio.whatsapp-keepalive: no whatsapp connector — skipping"
fi

# THE APP OWNS THE DAEMON WHEN THE APP IS INSTALLED, and installing this agent
# anyway is not merely redundant — the two actively fight. `Provision
# .retireConnectorsAgent()` boots out and DELETES this plist on every app
# launch, by design: the daemon runs as a child of the app so TCC attributes
# Full Disk Access to one row called Intaglio Labs instead of to a unix binary
# nobody installed (widget/src/Connectors.swift). So a machine with the app got
# an agent installed here, killed seconds later by the app, and a
# "Bootstrap failed: 5: Input/output error" that looks like a launchd defect
# and is really two components disagreeing about who owns the process.
#
# Observed 2026-08-25: the plist vanishing from ~/Library/LaunchAgents after
# each attempt was read as macOS pruning a failing agent. It was the app.
if [[ ! -f "$REPO_ROOT/connectors/daemon.mjs" ]]; then
  echo "    io.intaglio.connectors: connectors/daemon.mjs not present yet (a"
  echo "    concurrent commit adds it) — skipping this agent; a KeepAlive job"
  echo "    pointing at a missing script would crash-loop. Re-run after it lands."
elif [[ -d "/Applications/Intaglio Labs.app" ]]; then
  echo "    io.intaglio.connectors: the app is installed and runs the daemon as"
  echo "    its own child — skipping the agent, which the app would delete anyway."
else
  install_agent io.intaglio.connectors
fi

# The iMessage lanes are GONE (owner, 2026-08-21): Hazlie no longer texts its
# user and no longer takes `hz` commands from a pinned thread — everything
# goes through the widget. If an old install still has the agents loaded:
#   launchctl bootout gui/$UID/com.hazlie.listen
#   launchctl bootout gui/$UID/com.hazlie.watchdog
#   rm ~/Library/LaunchAgents/com.hazlie.{listen,watchdog}.plist
# The freshness logic the watchdog delivered survives in
# ui/server/status/watchdog.mjs, consumed by the widget's status surface.
if launchctl print "gui/$UID/com.hazlie.listen" >/dev/null 2>&1 \
   || launchctl print "gui/$UID/com.hazlie.watchdog" >/dev/null 2>&1; then
  echo "    !! retired iMessage agents still loaded — run the bootout lines in" >&2
  echo "    !! this script (search: 'iMessage lanes are GONE')." >&2
fi

# ── (f) hermes health ─────────────────────────────────────────────────────────
# Identity, not just liveness: the body must be Hermes' exact answer, because
# an unrelated local dev server squatting :8787 also answers 200 — observed on
# this machine — and every connector would then POST household rows at it.
step "waiting for $HERMES_HEALTH_URL"
healthy=0
for i in $(seq 1 15); do
  if body=$(curl -fsS --max-time 2 "$HERMES_HEALTH_URL" 2>/dev/null) &&
     [[ "$body" == '{"ok":true}' ]]; then
    echo "    up after ~${i}s: $body"
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" != 1 ]]; then
  echo "ERROR: no Hermes health answer after 15s." >&2
  echo "Check: launchctl print gui/$UID/io.intaglio.hermes" >&2
  echo "       tail -50 $LOG_DIR/hermes.err.log" >&2
  echo "       lsof -nP -iTCP:${HERMES_PORT:-51789} -sTCP:LISTEN   # another process may hold the port" >&2
  exit 1
fi

# ── (g) doctor ────────────────────────────────────────────────────────────────
step "doctor"
DOCTOR_STATUS=0
"$STABLE_NODE" "$REPO_ROOT/connectors/doctor.mjs" || DOCTOR_STATUS=$?
echo
if [[ "$DOCTOR_STATUS" != 0 ]]; then
  echo "doctor reported FAILs (exit $DOCTOR_STATUS). fda-* rows failing HERE are"
  echo "expected: this shell — not launchd — is the responsible process, so the"
  echo "Full Disk Access grant does not apply to this run. Production truth:"
  echo "    launchctl submit -l io.intaglio.doctor -o /tmp/doctor.out -e /tmp/doctor.err \\"
  echo "      -- $STABLE_NODE $REPO_ROOT/connectors/doctor.mjs --json"
  echo "    (poll /tmp/doctor.out, then: launchctl remove io.intaglio.doctor)"
  echo "Any non-fda FAIL above is real; act on its fix line."
else
  echo "doctor is green."
fi

echo
echo "connectors tier installed. Logs: $LOG_DIR/{hermes,connectors}.{out,err}.log"
