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
#   http://synapse:8008       http://127.0.0.1:8008
#   http://hazlie-meta:PORT   http://127.0.0.1:PORT
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
# WHAT THIS DOES NOT DO: supervise. It starts processes and writes pidfiles so
# the stack can be exercised, but launchd is the real answer and is the next
# leg. Anything that outlives a reboot must not depend on this.

set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
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

pidfile() { echo "$RUN/$1.pid"; }

alive() {
  f=$(pidfile "$1")
  [ -f "$f" ] || return 1
  pid=$(cat "$f" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

stop_one() {
  if alive "$1"; then
    kill "$(cat "$(pidfile "$1")")" 2>/dev/null || true
    echo "stopped $1"
  fi
  rm -f "$(pidfile "$1")"
}

stop_all() {
  for n in synapse $(bridge_rows | awk '{print $1}'); do stop_one "$n"; done
}

status_all() {
  # Docker first: if the old stack is up, saying so is more useful than
  # reporting seven native processes as "down".
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hazlie-'; then
    echo "the CONTAINER stack is running (ops/setup-bridges.sh). Native and container"
    echo "stacks share \$M and these ports; stop one before starting the other."
  fi
  for n in synapse $(bridge_rows | awk '{print $1}'); do
    if alive "$n"; then echo "  up    $n (pid $(cat "$(pidfile "$n")"))"; else echo "  down  $n"; fi
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
[ -f "$SYN/.ready" ] || { echo "no Synapse runtime: run ops/build-synapse.sh" >&2; exit 1; }
[ -f "$BIN/libolm.3.dylib" ] || { echo "no libolm: run ops/build-libolm.sh" >&2; exit 1; }
missing=""
for b in $(bridge_rows | awk '{print $4}'); do
  [ -x "$BIN/$b" ] || missing="$missing $b"
done
[ -z "$missing" ] || { echo "missing bridge binaries:$missing — run: node ops/fetch-bridges.mjs" >&2; exit 1; }

YQ="${HZ_YQ:-}"
[ -n "$YQ" ] || YQ=$(command -v yq 2>/dev/null || true)
[ -n "$YQ" ] || YQ="$REPO/widget/build/Intaglio Labs.app/Contents/Resources/backend/tools/yq"
[ -x "$YQ" ] || { echo "yq not found; set HZ_YQ" >&2; exit 1; }

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
start_bg() {
  name=$1; shift
  alive "$name" && { echo "  already up: $name"; return 0; }
  # setsid is not on macOS; nohup plus a detached redirect is the portable form.
  nohup "$@" >"$RUN/$name.log" 2>&1 &
  echo $! > "$(pidfile "$name")"
}

if [ "$NEEDS_RESTART" = "1" ]; then stop_one synapse; fi
start_bg synapse "$PY" -m synapse.app.homeserver --config-path "$M/synapse/homeserver.yaml"

i=0
until curl -sf "http://127.0.0.1:$SYNAPSE_PORT/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 45 ]; then
    echo "synapse never became healthy; see $RUN/synapse.log" >&2
    tail -20 "$RUN/synapse.log" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 2
done
echo "synapse: healthy on 127.0.0.1:$SYNAPSE_PORT"

# --- the owner ----------------------------------------------------------------
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
  python3 - "$PW" "$SYNAPSE_PORT" "$SERVER_NAME" "$M/synapse/homeserver.yaml" <<'PY'
import hashlib, hmac, json, os, re, sys, urllib.request

pw, port, server, config = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
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
path = os.path.expanduser('~/.hazlie/matrix/owner-credentials.json')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump({"homeserver": base,
               "user_id": "@you:" + server,
               "access_token": tok, "password": pw}, f, indent=2)
print("owner-credentials.json written (0600)")
PY
fi

bridge_rows | while read -r name port dbfile binary; do
  start_bg "$name" "$BIN/$binary" -c "$M/$name/config.yaml" -r "$M/$name/registration.yaml" -n
done

echo
status_all
