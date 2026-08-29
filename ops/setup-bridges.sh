#!/bin/sh
# Provision the social-bridge runtime from NOTHING — the piece the 2026-08-25
# wipe proved was missing. bridges/README.md documents OPERATING an existing
# stack; the original ~/.hazlie/matrix was hand-built and its recipe lived
# nowhere, so a wipe meant every social login silently went into a void: the
# widget's login window harvested cookies and there was no bridge to hand them
# to. This script IS that recipe, frozen the day the stack was rebuilt.
#
#   bash ops/setup-bridges.sh        # from a checkout or the installed copy
#
# Idempotent by construction: every step checks for its own artifact first, so
# re-running after a partial failure resumes rather than clobbers. State lands
# in ~/.hazlie/matrix (0700), never in the repo.
#
# What it builds, in order:
#   1. bridges/.env pointing compose at ~/.hazlie/matrix
#   2. synapse's generated homeserver.yaml, patched: client-only listener,
#      no federation, no trusted key servers, the seven appservice registrations,
#      registration closed (the owner is created via the shared secret)
#   3. each bridge's config.yaml (image writes the example; yq sets identity,
#      sqlite, permissions, backfill ON, double-puppet OFF — the hardening
#      checkBridgeHardening() enforces) and its registration.yaml
#   4. the stack, via docker compose
#   5. the owner user @you:hazlie.local + ~/.hazlie/matrix/owner-credentials.json
#      (0600 — access token, user id, homeserver; the connect page's
#      lib/bridge.mjs contract)
#
# Telegram is provisioned but will crash-loop until the owner adds api_id and
# api_hash from my.telegram.org/apps to its config.yaml — a per-account
# credential nobody else can create. The script stops that container and says
# so rather than leaving a restart loop burning quietly.
set -eu
OPS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$OPS_DIR/.."

M="$HOME/.hazlie/matrix"
SYNAPSE_IMAGE="ghcr.io/element-hq/synapse@sha256:2af5409da4e155123ef1f8ab30914fb14ba36b8b909197073498db733298fcd7"
DISCORD_IMAGE="dock.mau.dev/mautrix/discord@sha256:065405ca2f961b2687ca577c4eb65592c139d641342a9611d98b5394f30cf84a"

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — open Docker Desktop first, then re-run." >&2
  exit 1
fi
# Downloaded builds carry yq next to this script. A checkout keeps supporting a
# developer's PATH copy, but end users must never need Homebrew just to press
# Connect. HZ_YQ is intentionally first for release/CI validation.
YQ="${HZ_YQ:-$OPS_DIR/../tools/yq}"
if [ ! -x "$YQ" ]; then YQ="$(command -v yq 2>/dev/null || true)"; fi
if [ -z "$YQ" ] || [ ! -x "$YQ" ]; then
  echo "bridge config editor is missing from this install; reinstall Intaglio Labs." >&2
  exit 1
fi

mkdir -p "$M" && chmod 700 "$M"
# The compose file interpolates this environment variable. Keeping it in this
# process rather than bridges/.env means the downloaded app never needs to
# mutate its own signed bundle just to set up a user's private bridge state.
export HAZLIE_MATRIX="$M"

# --- synapse ------------------------------------------------------------------
if [ ! -f "$M/synapse/homeserver.yaml" ]; then
  mkdir -p "$M/synapse"
  docker run --rm -v "$M/synapse:/data" \
    -e SYNAPSE_SERVER_NAME=hazlie.local -e SYNAPSE_REPORT_STATS=no \
    "$SYNAPSE_IMAGE" generate
fi
# Every bridge's registration must be LISTED, not merely mounted. This check
# used to be "does the block exist at all" — true after the first run, so a
# bridge added later (linkedin, 2026-08-25) got its file mounted, its config
# written and its container started, then crash-looped on "the as_token was
# not accepted" because synapse had never been told to read it.
NEEDS_SYNAPSE_RESTART=0
if [ -f "$M/synapse/homeserver.yaml" ] && grep -q app_service_config_files "$M/synapse/homeserver.yaml"; then
  for b in meta instagram twitter telegram discord slack linkedin; do
    if ! grep -q "/registrations/$b.yaml" "$M/synapse/homeserver.yaml"; then
      "$YQ" -i ".app_service_config_files += [\"/registrations/$b.yaml\"]" "$M/synapse/homeserver.yaml"
      echo "synapse: registered $b"
      NEEDS_SYNAPSE_RESTART=1
    fi
  done
fi

if ! grep -q app_service_config_files "$M/synapse/homeserver.yaml"; then
  python3 - "$M/synapse/homeserver.yaml" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
# Client API only: nothing federates on a loopback bus.
s = s.replace("      - names: [client, federation]", "      - names: [client]")
s = s.replace('''trusted_key_servers:
  - server_name: "matrix.org"
''', '''# Nothing federates: hazlie.local is a loopback-only bus. No trusted key
# servers (the default reached out to matrix.org), no federation resource
# in the listener either.
trusted_key_servers: []
federation_domain_whitelist: []

# The bridge appservices. Each file is that bridge's own registration.yaml,
# mounted read-only by docker-compose so synapse always sees current tokens.
app_service_config_files:
  - /registrations/meta.yaml
  - /registrations/instagram.yaml
  - /registrations/twitter.yaml
  - /registrations/telegram.yaml
  - /registrations/discord.yaml
  - /registrations/slack.yaml
  - /registrations/linkedin.yaml

# The owner is created once via register_new_matrix_user (the shared secret
# above); nobody else can sign up on a single-human bus.
enable_registration: false
''')
open(p, 'w').write(s)
PY
  echo "synapse: homeserver.yaml patched"
fi

# --- the bridges --------------------------------------------------------------
# name  image                                  container         port   dbfile
bridge_rows() {
cat <<'ROWS'
meta      dock.mau.dev/mautrix/meta@sha256:662f3d52249304c44c91cbc3d3552eced3e5baf93916be7c6b17a47677036de8 hazlie-meta 29319 mautrix-meta
instagram dock.mau.dev/mautrix/meta@sha256:4b2704de94809351884da2640b1b1421920980a60269aa871fa870a8d50e7eb0 hazlie-instagram 29330 mautrix-instagram
twitter   dock.mau.dev/mautrix/twitter@sha256:a780515de3c7fa8f410e2d6355d4c69a0c439742c40bafeec8a3d8e61a94cbc4 hazlie-twitter 29327 mautrix-twitter
telegram  dock.mau.dev/mautrix/telegram@sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8 hazlie-telegram 29317 mautrix-telegram
slack     dock.mau.dev/mautrix/slack@sha256:77610eaaaa368829bcc3b78b8c79bb981832803a903991a48c6b9d2d70ff243d hazlie-slack 29335 mautrix-slack
linkedin  dock.mau.dev/mautrix/linkedin@sha256:0bf683337f3a2e27f01b057f0ff83b8ec488676da400c944773dbbd936c15778 hazlie-linkedin 29336 mautrix-linkedin
ROWS
}

# --- one-time full-history migration -----------------------------------------
#
# Builds through v0.2.2 created each portal with a 10,000-message initial cap.
# Raising the number above does not reopen an existing portal: standard
# Synapse cannot run mautrix's backwards-insertion queue, so those missing
# remote messages remain unreachable. There is only one honest upgrade path:
# recreate the private Matrix bus and its bridge portals once, under the new
# uncapped policy.
#
# This is intentionally recoverable. Containers are stopped first, every
# database/WAL and Synapse media directory is MOVED (not copied or deleted) to
# one owner-only timestamped backup, and configs/registrations are kept. The
# owner will have to reconnect social accounts; their bridge credentials live
# in the databases being reset and must not be extracted or rewritten by a
# migration script.
#
# Fresh installs never enter this block: owner-credentials.json does not exist
# until their first bridge setup finishes. The completion marker makes the
# migration strictly once-only even though this idempotent setup script runs on
# later launches.
FULL_HISTORY_MARKER="$M/.full-history-reset-v1"
FULL_HISTORY_PENDING="$M/.full-history-reset-v1.pending"
# A genuinely fresh install has no capped portal history to migrate. Mark that
# fact before later setup steps can fail and leave owner credentials behind;
# otherwise the retry would mistake its own partial fresh install for an old
# capped runtime and needlessly reset it.
if [ ! -f "$M/owner-credentials.json" ] \
   && [ ! -f "$FULL_HISTORY_MARKER" ] \
   && [ ! -f "$FULL_HISTORY_PENDING" ]; then
  ( umask 077; : > "$FULL_HISTORY_MARKER" )
fi
if [ ! -f "$FULL_HISTORY_MARKER" ] \
   && { [ -f "$M/owner-credentials.json" ] || [ -f "$FULL_HISTORY_PENDING" ]; }; then
  if [ -f "$FULL_HISTORY_PENDING" ]; then
    # Resume into the exact backup chosen by the interrupted attempt. Reject a
    # malformed marker rather than letting its contents become an mv target.
    IFS= read -r RESET_BACKUP < "$FULL_HISTORY_PENDING" || RESET_BACKUP=""
    case "$RESET_BACKUP" in
      "$M"/backups/full-history-v1-*/*) echo "invalid full-history reset marker" >&2; exit 1 ;;
      "$M"/backups/full-history-v1-*) ;;
      *) echo "invalid full-history reset marker" >&2; exit 1 ;;
    esac
    mkdir -p "$RESET_BACKUP" && chmod 700 "$M/backups" "$RESET_BACKUP"
  else
    RESET_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    RESET_BACKUP="$M/backups/full-history-v1-$RESET_STAMP"
    mkdir -p "$RESET_BACKUP" && chmod 700 "$M/backups" "$RESET_BACKUP"
    # Written before the first move. Its only content is the validated local
    # backup path, which lets a later launch finish every remaining exact move.
    ( umask 077; printf '%s\n' "$RESET_BACKUP" > "$FULL_HISTORY_PENDING" )
  fi

  # Stop every writer before moving SQLite's db/wal/shm set. A backup missing
  # its WAL is not a backup.
  ( cd bridges && docker compose stop >/dev/null 2>&1 )

  # A failed first attempt may have recreated part of the new runtime before
  # setup stopped. Never let a retry overwrite the original recovery copy:
  # preserve those partial retry files in their own owner-only subtree.
  RESET_RETRY_BACKUP="$RESET_BACKUP/retry-runtime-$(date -u +%Y%m%dT%H%M%SZ)-$$"

  backup_path() {
    rel="$1"
    src="$M/$rel"
    [ -e "$src" ] || return 0
    dst="$RESET_BACKUP/$rel"
    if [ -e "$dst" ]; then
      dst="$RESET_RETRY_BACKUP/$rel"
      [ ! -e "$dst" ] || {
        echo "full-history retry backup collision: $rel" >&2
        exit 1
      }
    fi
    mkdir -p "$(dirname "$dst")"
    mv "$src" "$dst"
  }

  backup_path owner-credentials.json
  for suffix in '' -wal -shm; do
    backup_path "synapse/homeserver.db$suffix"
  done
  backup_path synapse/media_store
  bridge_rows | while read -r name image cn port dbfile; do
    for suffix in '' -wal -shm; do
      backup_path "$name/$dbfile.db$suffix"
    done
  done
  for suffix in '' -wal -shm; do
    backup_path "discord/mautrix-discord.db$suffix"
  done

  # The connector daemon owns the derived Hermes corpus and Matrix cursors.
  # It consumes this owner-only marker before scheduling any new reads, so old
  # room copies cannot mix with the newly imported rooms.
  mkdir -p "$HOME/.hazlie/connectors"
  chmod 700 "$HOME/.hazlie/connectors"
  ( umask 077; : > "$HOME/.hazlie/connectors/social-reimport-v1.pending" )
  echo "social history: old capped runtime moved to $RESET_BACKUP"
  echo "social history: accounts must be reconnected once"
fi

bridge_rows | while read -r name image cn port dbfile; do
  mkdir -p "$M/$name"
  if [ ! -f "$M/$name/config.yaml" ]; then
    docker run --rm -v "$M/$name:/data" "$image" >/dev/null 2>&1 || true
    [ -f "$M/$name/config.yaml" ] || { echo "$name: config generation failed" >&2; exit 1; }
    echo "$name: config written"
  fi
  # All six above are the modern (bridgev2) layout — Telegram's pinned image
  # uses it too, which is why it is in this list and not special-cased
  # the way its python-era config would have needed. This must run even when
  # a first attempt wrote its example config then failed before registration:
  # mautrix only generates registration.yaml after the homeserver is set.
  # Standard Synapse cannot run mautrix's backwards queue (that path is
  # Beeper-only), so the initial portal fill is the only supported route to
  # complete remote history. bridgev2 treats zero/negative as disabled; use
  # the largest signed 32-bit limit as the explicit "uncapped" value.
  "$YQ" -i "
    .homeserver.address = \"http://synapse:8008\" |
    .homeserver.domain = \"hazlie.local\" |
    .appservice.address = \"http://$cn:$port\" |
    .appservice.hostname = \"0.0.0.0\" |
    .appservice.port = $port |
    .database.type = \"sqlite3-fk-wal\" |
    .database.uri = \"file:/data/$dbfile.db?_txlock=immediate\" |
    .bridge.permissions = {\"hazlie.local\": \"user\", \"@you:hazlie.local\": \"admin\"} |
    .backfill.enabled = true |
    .backfill.max_initial_messages = 2147483647 |
    .backfill.max_catchup_messages = 2147483647 |
    .backfill.threads.max_initial_messages = 2147483647 |
    .double_puppet.secrets = {} |
    .logging.min_level = "info"
  " "$M/$name/config.yaml"
  if [ ! -f "$M/$name/registration.yaml" ]; then
    # Docker Compose creates a directory when its bind-mount source does not
    # exist. That directory blocks mautrix from writing the registration file
    # on the next setup attempt, so remove only an *empty* one; never discard
    # user data or a non-empty path.
    if [ -d "$M/$name/registration.yaml" ]; then
      rmdir "$M/$name/registration.yaml" 2>/dev/null || {
        echo "$name: registration.yaml is a non-empty directory; move it aside before retrying" >&2
        exit 1
      }
      echo "$name: removed empty stale registration path"
    fi
    docker run --rm -v "$M/$name:/data" "$image" >/dev/null 2>&1 || true
    [ -f "$M/$name/registration.yaml" ] || { echo "$name: registration generation failed" >&2; exit 1; }
    echo "$name: registration written"
  fi
done

# Discord is the pre-bridgev2 generation: database under appservice, backfill
# and double-puppet under bridge.* — the shapes checkBridgeHardening() calls
# legacy and still verifies.
DISCORD_NEEDS_PORTAL_REFRESH=0
if [ ! -f "$M/discord/config.yaml" ]; then
  mkdir -p "$M/discord"
  docker run --rm -v "$M/discord:/data" "$DISCORD_IMAGE" >/dev/null 2>&1 || true
  [ -f "$M/discord/config.yaml" ] || { echo "discord: config generation failed" >&2; exit 1; }
  echo "discord: config written"
fi
# A bind-mounted config edit does not make Compose recreate or restart an
# already-running container. Detect the old capped policy BEFORE overwriting
# it so upgrades can restart Discord once below. That restart is the safe
# portal rebuild: mautrix-discord discovers every private channel again,
# creates the portals omitted by the old five-channel startup cap, and uses
# missed=-1 to repopulate existing empty portals without discarding the login
# database or creating duplicate Matrix history.
if [ -f "$M/owner-credentials.json" ] && [ -f "$M/discord/mautrix-discord.db" ]; then
  if ! "$YQ" -e '
    .bridge.startup_private_channel_create_limit == 2147483647 and
    .bridge.backfill.forward_limits.initial.dm == 2147483647 and
    .bridge.backfill.forward_limits.initial.channel == 2147483647 and
    .bridge.backfill.forward_limits.initial.thread == 2147483647 and
    .bridge.backfill.forward_limits.missed.dm == -1 and
    .bridge.backfill.forward_limits.missed.channel == -1 and
    .bridge.backfill.forward_limits.missed.thread == -1
  ' "$M/discord/config.yaml" >/dev/null 2>&1; then
    DISCORD_NEEDS_PORTAL_REFRESH=1
  fi
fi
# Same partial-install recovery as the modern bridges above. Discord uses the
# pre-bridgev2 config shape, but its registration generator has the same
# prerequisite: a configured homeserver domain.
# Discord's legacy bridge has two different limit contracts. Initial portal
# backfill explicitly rejects an unlimited sentinel, so use the largest signed
# 32-bit value there. Missed-message backfill does support -1. Create every
# private portal at startup as well; leaving the image default of five made a
# linked account look healthy while almost all of its DMs remained invisible.
# The generated Discord config also defaults to debug. Its HTTP debug records
# can include message request bodies, which do not belong in local operational
# logs. Info retains lifecycle/failure diagnostics without message content.
"$YQ" -i '
  .homeserver.address = "http://synapse:8008" |
  .homeserver.domain = "hazlie.local" |
  .appservice.address = "http://hazlie-discord:29334" |
  .appservice.hostname = "0.0.0.0" |
  .appservice.port = 29334 |
  .appservice.database.type = "sqlite3-fk-wal" |
  .appservice.database.uri = "file:/data/mautrix-discord.db?_txlock=immediate" |
  .bridge.permissions = {"hazlie.local": "user", "@you:hazlie.local": "admin"} |
  .bridge.startup_private_channel_create_limit = 2147483647 |
  .bridge.backfill.forward_limits.initial.dm = 2147483647 |
  .bridge.backfill.forward_limits.initial.channel = 2147483647 |
  .bridge.backfill.forward_limits.initial.thread = 2147483647 |
  .bridge.backfill.forward_limits.missed.dm = -1 |
  .bridge.backfill.forward_limits.missed.channel = -1 |
  .bridge.backfill.forward_limits.missed.thread = -1 |
  .bridge.double_puppet_server_map = {} |
  .logging.min_level = "info"
' "$M/discord/config.yaml"
if [ ! -f "$M/discord/registration.yaml" ]; then
  if [ -d "$M/discord/registration.yaml" ]; then
    rmdir "$M/discord/registration.yaml" 2>/dev/null || {
      echo "discord: registration.yaml is a non-empty directory; move it aside before retrying" >&2
      exit 1
    }
    echo "discord: removed empty stale registration path"
  fi
  docker run --rm -v "$M/discord:/data" "$DISCORD_IMAGE" >/dev/null 2>&1 || true
  [ -f "$M/discord/registration.yaml" ] || { echo "discord: registration generation failed" >&2; exit 1; }
  echo "discord: registration written"
fi

# --- up -----------------------------------------------------------------------
( cd bridges && docker compose up -d )
# Compose does not restart a container for changes inside a bind-mounted file.
# Existing Discord installs therefore need this explicit one-time refresh when
# the capped values above were detected. The corrected config is itself the
# idempotency marker: subsequent setup runs see it and leave Discord alone.
if [ "$DISCORD_NEEDS_PORTAL_REFRESH" = "1" ]; then
  ( cd bridges && docker compose restart mautrix-discord )
  echo "discord: refreshed existing portals under the full-history policy"
fi
# A newly listed appservice is only read at synapse startup.
if [ "$NEEDS_SYNAPSE_RESTART" = "1" ]; then
  ( cd bridges && docker compose restart synapse )
  sleep 8
fi
# Synapse needs to be answering before the owner can be registered.
i=0
until curl -sf http://127.0.0.1:8008/health >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 30 ] && { echo "synapse never became healthy" >&2; exit 1; }
  sleep 2
done

# --- the owner ----------------------------------------------------------------
if [ ! -f "$M/owner-credentials.json" ]; then
  PW="$(openssl rand -hex 24)"
  docker exec hazlie-synapse register_new_matrix_user http://localhost:8008 \
    -c /data/homeserver.yaml -u you -p "$PW" --no-admin
  python3 - "$PW" <<'PY'
import json, os, sys, urllib.request
pw = sys.argv[1]
req = urllib.request.Request(
    'http://127.0.0.1:8008/_matrix/client/v3/login',
    data=json.dumps({"type": "m.login.password",
                     "identifier": {"type": "m.id.user", "user": "you"},
                     "password": pw}).encode(),
    headers={'Content-Type': 'application/json'})
tok = json.load(urllib.request.urlopen(req))['access_token']
path = os.path.expanduser('~/.hazlie/matrix/owner-credentials.json')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump({"homeserver": "http://127.0.0.1:8008",
               "user_id": "@you:hazlie.local",
               "access_token": tok, "password": pw}, f, indent=2)
print("owner-credentials.json written (0600)")
PY
fi

# --- telegram's missing half --------------------------------------------------
# The generated config ships mautrix's EXAMPLE credentials (api_id 12345) and
# the bridge refuses to start on them, so the example id is the reliable
# "not yet configured" signal rather than an empty key.
#
# THREE PLACES A REAL PAIR CAN COME FROM, in this order. None of them is this
# repository, and that is deliberate: it is public, and Telegram refuses logins
# made with any api_id it finds in public code (API_ID_PUBLISHED_FLOOD). See
# the note at PLATFORMS.telegram in connect/lib/bridge.mjs.
#   1. $HZ_TELEGRAM_APP        — an explicit run, or CI from a repo secret
#   2. ~/.hazlie/secrets/telegram-app.txt — this machine's own copy (0600)
#   3. the installed app's bundled copy   — what widget/build.sh baked in, so
#      a user who never registered anything still gets a working bridge
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

if [ "$("$YQ" '.network.api_id // 0' "$M/telegram/config.yaml" 2>/dev/null)" = "12345" ]; then
  TG_APP="$(telegram_app_credential)"
  # An explicit CI/local override arrives in this process's environment. Drop
  # it before sed, Compose, or any other child can inherit the credential.
  unset HZ_TELEGRAM_APP || true
  # Shape-checked before it is written. A malformed pair produces a container
  # that crash-loops with nothing on the machine naming the cause — which is
  # the exact failure this whole block exists to end.
  if printf '%s' "$TG_APP" | grep -Eq '^[0-9]{1,12}:[0-9a-fA-F]{32}$'; then
    TG_ID="${TG_APP%%:*}"
    TG_HASH="${TG_APP#*:}"
    # Targeted line replacement, not a yq round trip: mautrix's generated
    # config carries ~700 lines of comments that a re-serialise would flatten.
    # Feed the replacement program over stdin so the API hash never appears in
    # sed's argv (and therefore never flashes in another process's `ps` view).
    {
      printf 's/^\\([[:space:]]*api_id:\\).*/\\1 %s/\n' "$TG_ID"
      printf 's/^\\([[:space:]]*api_hash:\\).*/\\1 "%s"/\n' "$TG_HASH"
    } | /usr/bin/sed -i '' -f - "$M/telegram/config.yaml"
    ( cd bridges && docker compose up -d mautrix-telegram >/dev/null 2>&1 ) || true
    echo "telegram: configured from a shipped app credential"
  else
    ( cd bridges && docker compose stop mautrix-telegram >/dev/null 2>&1 ) || true
    echo "telegram: stopped — it needs api_id + api_hash from my.telegram.org/apps"
    echo "          the widget's Telegram tile walks you through it, or set them"
    echo "          by hand in $M/telegram/config.yaml and then:"
    echo "          cd bridges && docker compose up -d mautrix-telegram"
  fi
fi

# The runtime and owner were recreated successfully. Mark both migrated old
# installs and brand-new installs so no later setup run can reset them again.
# Rename the in-progress marker when present so success becomes atomic.
if [ -f "$FULL_HISTORY_PENDING" ]; then
  mv "$FULL_HISTORY_PENDING" "$FULL_HISTORY_MARKER"
else
  ( umask 077; : > "$FULL_HISTORY_MARKER" )
fi

echo "bridge runtime is up:"
( cd bridges && docker compose ps --format 'table {{.Name}}\t{{.Status}}' )
