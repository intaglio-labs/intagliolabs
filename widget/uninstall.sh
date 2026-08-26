#!/bin/sh
# Remove Intaglio Labs from this Mac, completely and loudly. The counterpart to
# build.sh and ops/setup-connectors.sh, in the same shape: POSIX sh, no
# dependencies, every step printed as it happens.
#
#   widget/uninstall.sh              show the full plan, then ask before deleting
#   widget/uninstall.sh --dry-run    show the plan and exit; change nothing
#   widget/uninstall.sh --keep-data  remove app + services, KEEP ~/.hazlie
#   widget/uninstall.sh --yes        no prompt (for scripts; still prints)
#
# What this touches, and only this:
#   1. Every io.intaglio.* launchd agent in this user's domain (stopped and
#      its plist removed) — AND every pre-rename com.hazlie.* one, because an
#      uninstall that only knew the current namespace would leave the old
#      agents running under launchd with nothing left to point at them.
#   2. The Intaglio Labs widget process and the app bundle — 'Intaglio Labs.app'
#      (or a pre-rename 'Hazlie.app') in ~/Applications and /Applications.
#   3. ~/.hazlie — the database, secrets, models, logs, caches. This is the
#      irreversible one: there are no backups by design, and nobody has a
#      copy (see the privacy policy). Hence the typed confirmation.
#
# What it NEVER touches: your Messages/Notes/Photos/Mail data (Intaglio Labs only
# ever read those in place), your Time Machine or cloud backups, and the TCC
# permission grants — macOS does not let a script revoke those, so the exact
# System Settings paths are printed at the end instead.
set -eu

HZ_HOME="${HAZLIE_HOME:-$HOME/.hazlie}"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DRY=0; KEEP_DATA=0; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
act() { # act <description> <cmd...> — print always, execute unless dry run
  desc="$1"; shift
  if [ "$DRY" = 1 ]; then say "would: $desc"; else say "doing: $desc"; "$@" || say "  !! failed (continuing): $desc" >&2; fi
}

say "Intaglio Labs uninstall — plan for this machine:"
say ""

# ── 1. launchd agents ────────────────────────────────────────────────────────
FOUND_AGENTS=""
for plist in "$AGENTS_DIR"/io.intaglio.*.plist "$AGENTS_DIR"/com.hazlie.*.plist; do
  [ -e "$plist" ] || continue
  FOUND_AGENTS="$FOUND_AGENTS $(basename "$plist" .plist)"
done
# Agents can be loaded without a plist on disk (a bootstrap from a repo path).
LOADED=$(launchctl list 2>/dev/null | awk '$3 ~ /^(io\.intaglio|com\.hazlie)\./ {print $3}') || LOADED=""
for label in $LOADED; do
  case " $FOUND_AGENTS " in *" $label "*) ;; *) FOUND_AGENTS="$FOUND_AGENTS $label" ;; esac
done
if [ -n "$FOUND_AGENTS" ]; then
  say "  services to stop and remove:$FOUND_AGENTS"
else
  say "  services: none found"
fi

# ── 2. the app ───────────────────────────────────────────────────────────────
# Both names: build.sh installs '/Applications/Intaglio Labs.app' (and the
# in-app self-move copies to the same name); 'Hazlie.app' is the pre-rename
# install. One path per line — 'Intaglio Labs.app' contains a space, so a
# space-joined list would word-split into two wrong rm targets.
NL='
'
APPS=""
for a in "$HOME/Applications/Hazlie.app" "/Applications/Hazlie.app" \
         "$HOME/Applications/Intaglio Labs.app" "/Applications/Intaglio Labs.app"; do
  [ -d "$a" ] && APPS="$APPS$a$NL"
done
if [ -n "$APPS" ]; then
  say "  app bundles to remove:"
  printf '%s' "$APPS" | while IFS= read -r a; do say "    $a"; done
else
  say "  app bundles: none found"
fi

# ── 3. the data ──────────────────────────────────────────────────────────────
if [ -d "$HZ_HOME" ]; then
  SIZE=$(du -sh "$HZ_HOME" 2>/dev/null | awk '{print $1}')
  if [ "$KEEP_DATA" = 1 ]; then
    say "  data: KEEPING $HZ_HOME ($SIZE) per --keep-data"
  else
    say "  data to DELETE PERMANENTLY: $HZ_HOME ($SIZE)"
    say "    (database, secrets, downloaded models, logs. No backups exist"
    say "     unless your own backup tool covers your home folder.)"
  fi
else
  say "  data: $HZ_HOME not present"
fi
say ""

[ "$DRY" = 1 ] && { say "dry run — nothing changed."; exit 0; }

# ── confirmation ─────────────────────────────────────────────────────────────
if [ "$ASSUME_YES" != 1 ]; then
  if [ "$KEEP_DATA" = 1 ] || [ ! -d "$HZ_HOME" ]; then
    printf 'proceed? [y/N] '
    read -r answer
    [ "$answer" = y ] || [ "$answer" = Y ] || { say "aborted; nothing changed."; exit 1; }
  else
    # Deleting the corpus is the one action with no undo anywhere in the
    # world, so it takes more than a y.
    printf 'type "delete my data" to proceed (anything else aborts): '
    read -r answer
    [ "$answer" = "delete my data" ] || { say "aborted; nothing changed."; exit 1; }
  fi
fi

# ── execute ──────────────────────────────────────────────────────────────────
for label in $FOUND_AGENTS; do
  act "stop $label" launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  [ -e "$AGENTS_DIR/$label.plist" ] && act "remove $AGENTS_DIR/$label.plist" rm -f "$AGENTS_DIR/$label.plist"
done

pgrep -x Hazlie >/dev/null 2>&1 && act "quit the Intaglio Labs widget" pkill -x Hazlie
printf '%s' "$APPS" | while IFS= read -r a; do
  act "remove $a" rm -rf "$a"
done

if [ "$KEEP_DATA" != 1 ] && [ -d "$HZ_HOME" ]; then
  act "delete $HZ_HOME" rm -rf "$HZ_HOME"
fi

# The self-move step (onboarding screen 0) can leave a stale app copy behind
# and records where in HazlieStaleCopyPath. Remove the copy it names — but
# only if it actually names one of our app bundles, so a corrupted default
# can never aim this rm at something else — then drop the whole defaults
# domain.
# Both bundle ids: a pre-rename install wrote its defaults under com.hazlie.widget.
for bundle in io.intaglio.widget com.hazlie.widget; do
  STALE=$(defaults read "$bundle" HazlieStaleCopyPath 2>/dev/null || true)
  case "$STALE" in
    */Hazlie.app|*"/Intaglio Labs.app") [ -d "$STALE" ] && act "remove stale self-move copy $STALE" rm -rf "$STALE" ;;
  esac
  act "remove $bundle preferences" defaults delete "$bundle" 2>/dev/null
done

# Best-effort reset of the grants that CAN be reset per-bundle. Failures here
# are normal (grant never given, or macOS refuses) and change nothing else.
for bundle in io.intaglio.widget com.hazlie.widget; do
  tccutil reset Microphone "$bundle" >/dev/null 2>&1 && say "doing: reset microphone grant for $bundle" || true
done

say ""
say "done. Two grants macOS only lets YOU revoke, in System Settings:"
say "  - Privacy & Security > Full Disk Access: remove 'node' (~/.hazlie/bin/node)"
say "    if listed. The binary is already gone; the stale row is cosmetic but"
say "    worth clearing."
say "  - Privacy & Security > Automation: any leftover Intaglio Labs rows."
say "If Intaglio Labs ever texted you (pre-2026-08-21 installs), those messages live"
say "in Messages under your Apple ID and are yours to delete there."
