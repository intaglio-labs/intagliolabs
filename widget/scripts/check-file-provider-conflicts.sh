#!/bin/sh
set -eu

CONFLICTS="$(
  find "$@" \
    -path '*/node_modules' -prune -o \
    -type f \( -name '* 2' -o -name '* 2.*' \) -print
)"

if [ -n "$CONFLICTS" ]; then
  printf '%s\n' "$CONFLICTS"
  exit 1
fi
