#!/usr/bin/env bash
# Promote a COMMIT to the running installation.
#
# WHY THIS EXISTS. The launchd plists name a PATH, never a commit, so whatever
# is on disk at that path when a daemon restarts is what runs -- under a Full
# Disk Access grant, against real iMessage, mail and photos. Pointing that path
# at a git checkout means the running app silently becomes whatever branch
# someone last checked out, and finding out is a matter of noticing something
# behave oddly. That hazard is why a second worktree (~/hazlie-live) existed:
# not because two trees were wanted, but because one of them had to hold still.
#
# A directory that is not a checkout holds still for free. This installs one.
#
# Source is `git archive <ref>`, NOT a copy of the working tree, and that is the
# whole point: an archive of a commit cannot contain an uncommitted edit, a
# stray file, or a half-finished branch. There is no flag to promote a dirty
# tree, because a production installation nobody can name the commit of is the
# thing this is here to prevent.
#
#   ops/promote.sh                 install origin/main
#   ops/promote.sh <ref>           install any commit-ish (a tag, a sha)
#
# Then re-run ops/setup-connectors.sh FROM THE INSTALLED COPY to repoint the
# agents at it -- the last line here prints the exact command.
set -euo pipefail
umask 077

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.hazlie/app"
REF="${1:-origin/main}"

command -v git >/dev/null || { echo "ERROR: git not found." >&2; exit 1; }
git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "ERROR: $SRC is not a git checkout, so there is no commit to promote." >&2; exit 1; }

COMMIT="$(git -C "$SRC" rev-parse --verify "$REF^{commit}" 2>/dev/null)" || {
  echo "ERROR: '$REF' is not a commit in $SRC." >&2
  echo "       (Run 'git fetch' if you meant a ref that only exists on the remote.)" >&2
  exit 1; }
SHORT="$(git -C "$SRC" rev-parse --short "$COMMIT")"

echo "promoting $REF ($SHORT) -> $DEST"

# Build beside the live copy and swap at the end, so an interrupted promote
# leaves the running installation whole rather than half-replaced.
rm -rf "$DEST.new" "$DEST.old"
mkdir -p "$DEST.new"
git -C "$SRC" archive --format=tar "$COMMIT" | tar -x -C "$DEST.new"

# Runtime dependencies. connectors is the only tier with any (imapflow,
# mailparser, libphonenumber-js); ui and connect are dependency-free by design.
# Installed per-installation because node_modules is not in the archive -- and
# a missing one does not fail loudly, it surfaces as two connector checks that
# read like code bugs and are not.
if [ -f "$DEST.new/connectors/package.json" ]; then
  echo "installing connectors runtime deps..."
  ( cd "$DEST.new/connectors" && npm ci --omit=dev --silent )
fi

# What is actually installed, answerable without guessing. `doctor` and any
# future check can read this; so can a human wondering why production behaves
# unlike the branch they are looking at.
printf '%s\n' "$COMMIT" > "$DEST.new/.installed-commit"
git -C "$SRC" log -1 --format='%H%n%cI%n%s' "$COMMIT" > "$DEST.new/.installed-from"

[ -d "$DEST" ] && mv "$DEST" "$DEST.old"
mv "$DEST.new" "$DEST"
rm -rf "$DEST.old"
chmod 700 "$DEST"

echo "installed $SHORT at $DEST"
echo
echo "next, repoint the launchd agents at it:"
echo "    bash $DEST/ops/setup-connectors.sh"
