#!/bin/sh
# Warm Docker's image cache for social connections. This deliberately pulls
# images only: no Matrix user, bridge config, registration, cookie, or account
# state exists until the owner actually chooses a social connection.
set -eu

DOCKER="${DOCKER_BIN:-$(command -v docker 2>/dev/null || true)}"
if [ -z "$DOCKER" ] || [ ! -x "$DOCKER" ]; then
  echo "bridge prefetch skipped: Docker Desktop is not installed"
  exit 0
fi

# Docker Desktop commonly starts beside the app. Wait in this background task
# rather than racing it on first launch; a later app launch safely retries if
# it takes longer or is deliberately closed.
attempt=0
until "$DOCKER" info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 45 ]; then
    echo "bridge prefetch deferred: Docker Desktop is not ready"
    exit 0
  fi
  sleep 2
done

images='
ghcr.io/element-hq/synapse:v1.140.0
dock.mau.dev/mautrix/meta:v26.08
dock.mau.dev/mautrix/meta:ig-v26.08
dock.mau.dev/mautrix/twitter@sha256:a780515de3c7fa8f410e2d6355d4c69a0c439742c40bafeec8a3d8e61a94cbc4
dock.mau.dev/mautrix/telegram:latest
dock.mau.dev/mautrix/discord:latest
dock.mau.dev/mautrix/slack:latest
dock.mau.dev/mautrix/linkedin:latest'

for image in $images; do
  if "$DOCKER" image inspect "$image" >/dev/null 2>&1; then
    continue
  fi
  echo "bridge prefetch: pulling $image"
  "$DOCKER" pull "$image"
done

echo "bridge prefetch: complete"
