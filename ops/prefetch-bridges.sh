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
ghcr.io/element-hq/synapse@sha256:2af5409da4e155123ef1f8ab30914fb14ba36b8b909197073498db733298fcd7
dock.mau.dev/mautrix/meta@sha256:662f3d52249304c44c91cbc3d3552eced3e5baf93916be7c6b17a47677036de8
dock.mau.dev/mautrix/meta@sha256:4b2704de94809351884da2640b1b1421920980a60269aa871fa870a8d50e7eb0
dock.mau.dev/mautrix/twitter@sha256:a780515de3c7fa8f410e2d6355d4c69a0c439742c40bafeec8a3d8e61a94cbc4
dock.mau.dev/mautrix/telegram@sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8
dock.mau.dev/mautrix/discord@sha256:065405ca2f961b2687ca577c4eb65592c139d641342a9611d98b5394f30cf84a
dock.mau.dev/mautrix/slack@sha256:77610eaaaa368829bcc3b78b8c79bb981832803a903991a48c6b9d2d70ff243d
dock.mau.dev/mautrix/linkedin@sha256:0bf683337f3a2e27f01b057f0ff83b8ec488676da400c944773dbbd936c15778'

for image in $images; do
  if "$DOCKER" image inspect "$image" >/dev/null 2>&1; then
    continue
  fi
  echo "bridge prefetch: pulling $image"
  "$DOCKER" pull "$image"
done

echo "bridge prefetch: complete"
