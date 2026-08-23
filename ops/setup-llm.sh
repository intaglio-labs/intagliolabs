#!/usr/bin/env bash
# Installs the local LLM tier: llama-server binary, the model weights, and the
# launchd agent that keeps it resident on 127.0.0.1:8080.
#
# Idempotent — every step checks before acting, so re-running after a partial
# failure (or after a model/plist change) is the intended recovery path.
# A partially-downloaded model resumes; an already-loaded agent is left alone
# unless its plist changed.
#
# Flags:
#   --verify   also sha256-check the model file (adds ~10s for 5 GB)
#
# ── MODEL DISCREPANCY WITH THE ARCHITECTURE PLAN ─────────────────────────────
# The plan names "Qwen3-8B-Instruct-2507 Q4_K_M". Verified against the live
# Hugging Face API on 2026-08-11: THAT MODEL DOES NOT EXIST. All of
#   Qwen/Qwen3-8B-Instruct-2507-GGUF        -> 401 (HF's no-such-repo answer)
#   unsloth/Qwen3-8B-Instruct-2507-GGUF     -> 401
#   bartowski/Qwen_Qwen3-8B-Instruct-2507-GGUF -> 401
#   Qwen/Qwen3-8B-Instruct-2507 (base repo) -> 401
# The 2507 instruct refresh was never released at 8B — it exists only at 4B
# (Qwen/Qwen3-4B-Instruct-2507 -> 200). What IS real at the plan's size class:
#   Qwen/Qwen3-8B-GGUF -> 200, file Qwen3-8B-Q4_K_M.gguf, 5,027,783,488 bytes.
# Qwen3-8B is the original HYBRID-thinking model, not a non-thinking instruct.
# It also cannot complete a first decode on the target 8 GB M2: Metal exhausts
# unified memory even with one slot and smaller batches. On hosts with <=8 GiB,
# setup therefore selects the real 4B non-thinking 2507 instruct model. Larger
# hosts keep the original 8B choice with "--reasoning off" (see the plist).
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
umask 077

# Capture the optional download credential as a shell-only value before the
# script spawns any child process. An inherited environment variable would
# otherwise be visible in each child's environment even when curl's header is
# correctly supplied through stdin.
HF_DOWNLOAD_TOKEN="${HF_TOKEN:-}"
export -n HF_DOWNLOAD_TOKEN HF_TOKEN LLAMA_API_KEY LLAMA_API_KEY_SHA256
unset HF_TOKEN LLAMA_API_KEY LLAMA_API_KEY_SHA256

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Verified 2026-08-11 from each repository's Hugging Face API metadata.
# HAZLIE_MODEL_TIER is an escape hatch for controlled comparison; normal setup
# should leave it at auto so an 8 GB machine cannot install a model it cannot
# decode.
HOST_MEMORY_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
MODEL_TIER_REQUEST="${HAZLIE_MODEL_TIER:-auto}"
case "$MODEL_TIER_REQUEST" in
  auto)
    if [[ "$HOST_MEMORY_BYTES" =~ ^[0-9]+$ ]] && [[ "$HOST_MEMORY_BYTES" -gt 0 ]] && [[ "$HOST_MEMORY_BYTES" -le 8589934592 ]]; then
      MODEL_TIER="4B 2507 instruct (8 GB host fallback)"
    else
      MODEL_TIER="8B hybrid-thinking"
    fi
    ;;
  4b) MODEL_TIER="4B 2507 instruct (explicit override)" ;;
  8b) MODEL_TIER="8B hybrid-thinking (explicit override)" ;;
  *) echo "ERROR: HAZLIE_MODEL_TIER must be auto, 4b, or 8b." >&2; exit 1 ;;
esac

if [[ "$MODEL_TIER" == 4B* ]]; then
  MODEL_REPO="unsloth/Qwen3-4B-Instruct-2507-GGUF"
  MODEL_FILE="Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
  MODEL_SIZE=2497281120
  MODEL_SHA256="3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"
else
  MODEL_REPO="Qwen/Qwen3-8B-GGUF"
  MODEL_FILE="Qwen3-8B-Q4_K_M.gguf"
  MODEL_SIZE=5027783488
  MODEL_SHA256="d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785"
fi
MODEL_URL="https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}"

# The plist hardcodes this path (launchd expands no variables at all).
LLAMA_BIN="/opt/homebrew/bin/llama-server"

MODEL_DIR="$HOME/.hazlie/models"
LOG_DIR="$HOME/.hazlie/logs"
SECRET_DIR="$HOME/.hazlie/secrets"
LLAMA_API_KEY_FILE="$SECRET_DIR/llama-api-key.txt"
HERMES_TOKEN_FILE="$SECRET_DIR/hermes-token.txt"
ACTIVE_LLAMA_KEY_STAMP="$SECRET_DIR/active-llama-api-key.sha256"
ACTIVE_MODEL_STAMP="$MODEL_DIR/active-model.txt"
LABEL="com.hazlie.llama-server"
PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
HEALTH_URL="http://127.0.0.1:8080/health"
INFERENCE_URL="http://127.0.0.1:8080/v1/chat/completions"

VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY=1 ;;
    *) echo "unknown flag: $arg (only --verify is supported)" >&2; exit 1 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

# ── (a) llama-server binary ──────────────────────────────────────────────────
step "llama-server binary"
if [[ -x "$LLAMA_BIN" ]]; then
  echo "    present: $LLAMA_BIN ($("$LLAMA_BIN" --version 2>&1 | head -1))"
elif command -v llama-server >/dev/null 2>&1; then
  # Present but not where the plist points. Symlinking around it would break
  # silently on the next brew upgrade; make the human decide.
  echo "ERROR: llama-server is at $(command -v llama-server), but the launchd" >&2
  echo "plist hardcodes $LLAMA_BIN. Edit LLAMA_BIN here and the plist, or" >&2
  echo "install via 'brew install llama.cpp' on Apple Silicon homebrew." >&2
  exit 1
elif command -v brew >/dev/null 2>&1; then
  echo "    not found — installing via brew"
  brew install llama.cpp
  [[ -x "$LLAMA_BIN" ]] || { echo "ERROR: brew install finished but $LLAMA_BIN still missing." >&2; exit 1; }
else
  echo "ERROR: no llama-server and no brew. Install Homebrew (https://brew.sh)" >&2
  echo "then re-run, or install llama.cpp so that $LLAMA_BIN exists." >&2
  exit 1
fi

# ── (b) model weights ─────────────────────────────────────────────────────────
step "model weights ($MODEL_TIER; $MODEL_FILE, $(( MODEL_SIZE / 1000000000 )) GB)"
mkdir -p "$MODEL_DIR" "$LOG_DIR" "$SECRET_DIR"
# ~/.hazlie itself can predate this script (or have been created under a
# permissive default umask). Lock the runtime root as well as its children;
# every current child is Hazlie-private state.
chmod 700 "$HOME/.hazlie"
chmod 700 "$MODEL_DIR" "$LOG_DIR" "$SECRET_DIR"
MODEL_PATH="$MODEL_DIR/$MODEL_FILE"

have_size=$([[ -f "$MODEL_PATH" ]] && stat -f %z "$MODEL_PATH" || echo 0)
if [[ "$have_size" == "$MODEL_SIZE" ]]; then
  echo "    present: $MODEL_PATH"
else
  if [[ "$have_size" != 0 ]]; then
    echo "    partial file ($have_size of $MODEL_SIZE bytes) — resuming"
  fi
  # -C - resumes from the existing byte count; --fail turns HTTP errors into
  # exit codes instead of a 5 GB error page saved as a model.
  # macOS still ships Bash 3.2, where expanding an empty array under `set -u`
  # raises "unbound variable". Keep the unauthenticated path array-free.
  if [[ -n "$HF_DOWNLOAD_TOKEN" ]]; then
    if ! [[ "$HF_DOWNLOAD_TOKEN" =~ ^hf_[A-Za-z0-9]+$ ]]; then
      echo "ERROR: HF_TOKEN has an unexpected format." >&2
      exit 1
    fi
    # Read the header from stdin rather than argv so a long-running/resumable
    # download never exposes the token in `ps` output. -q must be curl's first
    # argument so a user ~/.curlrc cannot enable a trace or proxy behind us.
    printf 'header = "Authorization: Bearer %s"\n' "$HF_DOWNLOAD_TOKEN" |
      curl -q --config - --fail --location -C - --retry 3 --retry-delay 5 \
        -o "$MODEL_PATH" "$MODEL_URL"
    unset HF_DOWNLOAD_TOKEN
  else
    curl -q --fail --location -C - --retry 3 --retry-delay 5 \
      -o "$MODEL_PATH" "$MODEL_URL"
  fi
  got=$(stat -f %z "$MODEL_PATH")
  if [[ "$got" != "$MODEL_SIZE" ]]; then
    echo "ERROR: downloaded $got bytes, expected $MODEL_SIZE. Re-run to resume." >&2
    exit 1
  fi
  echo "    downloaded: $MODEL_PATH"
fi
unset HF_DOWNLOAD_TOKEN

if [[ "$VERIFY" == 1 ]]; then
  echo "    verifying sha256..."
  got_sha=$(shasum -a 256 "$MODEL_PATH" | awk '{print $1}')
  if [[ "$got_sha" != "$MODEL_SHA256" ]]; then
    echo "ERROR: sha256 mismatch: $got_sha (expected $MODEL_SHA256)." >&2
    echo "Delete $MODEL_PATH and re-run." >&2
    exit 1
  fi
  echo "    sha256 ok"
fi
chmod 600 "$MODEL_PATH"

# llama-server is loopback-only, but loopback alone does not stop a hostile web
# page from sending a no-CORS POST that consumes inference and mutates the prompt
# cache. Generate a stable, owner-only bearer key. Hermes reads this file and is
# the only browser-facing caller; the key never enters an Expo environment or
# command-line argument.
step "private llama API key"
if [[ -L "$LLAMA_API_KEY_FILE" ]] || [[ -e "$LLAMA_API_KEY_FILE" && ! -f "$LLAMA_API_KEY_FILE" ]]; then
  echo "ERROR: $LLAMA_API_KEY_FILE must be a regular, non-symlink file." >&2
  exit 1
fi
if [[ ! -e "$LLAMA_API_KEY_FILE" ]]; then
  command -v openssl >/dev/null 2>&1 || {
    echo "ERROR: openssl is required to generate the llama API key." >&2
    exit 1
  }
  key_tmp=$(mktemp "$SECRET_DIR/.llama-api-key.XXXXXX")
  trap 'rm -f "${key_tmp:-}"' EXIT
  openssl rand -hex 32 > "$key_tmp"
  chmod 600 "$key_tmp"
  mv "$key_tmp" "$LLAMA_API_KEY_FILE"
  key_tmp=
  trap - EXIT
  echo "    generated owner-only key file"
else
  chmod 600 "$LLAMA_API_KEY_FILE"
  echo "    existing key file retained"
fi
if [[ "$(wc -l < "$LLAMA_API_KEY_FILE" | tr -d ' ')" != 1 ]] ||
   ! LC_ALL=C grep -Eq '^[0-9a-f]{64}$' "$LLAMA_API_KEY_FILE"; then
  echo "ERROR: $LLAMA_API_KEY_FILE is not one generated 256-bit hex key." >&2
  exit 1
fi
LLAMA_API_KEY="$(tr -d '\r\n' < "$LLAMA_API_KEY_FILE")"
LLAMA_API_KEY_SHA256="$(shasum -a 256 "$LLAMA_API_KEY_FILE" | awk '{print $1}')"
# A caller-controlled inherited environment could pre-export either variable;
# explicitly make both shell-only before curl is spawned.
export -n LLAMA_API_KEY LLAMA_API_KEY_SHA256

# The llama key above authenticates Hermes going OUT to llama-server. This one
# authenticates callers coming IN to Hermes: /ingest and the lane routes reject
# an Origin-less request without it, which is what closes the hole where any
# local process could write the household's context store just by sending no
# Origin header. Separate file so rotating one does not force rotating the
# other. The browser never uses it -- the page authenticates by Origin and
# holds no secret at all (server/hermes.mjs authorize()).
step "private Hermes bearer token"
if [[ -L "$HERMES_TOKEN_FILE" ]] || [[ -e "$HERMES_TOKEN_FILE" && ! -f "$HERMES_TOKEN_FILE" ]]; then
  echo "ERROR: $HERMES_TOKEN_FILE must be a regular, non-symlink file." >&2
  exit 1
fi
if [[ ! -e "$HERMES_TOKEN_FILE" ]]; then
  command -v openssl >/dev/null 2>&1 || {
    echo "ERROR: openssl is required to generate the Hermes bearer token." >&2
    exit 1
  }
  token_tmp=$(mktemp "$SECRET_DIR/.hermes-token.XXXXXX")
  trap 'rm -f "${token_tmp:-}"' EXIT
  openssl rand -hex 32 > "$token_tmp"
  chmod 600 "$token_tmp"
  mv "$token_tmp" "$HERMES_TOKEN_FILE"
  token_tmp=
  trap - EXIT
  echo "    generated owner-only token file"
else
  chmod 600 "$HERMES_TOKEN_FILE"
  echo "    existing token file retained"
fi
if [[ "$(wc -l < "$HERMES_TOKEN_FILE" | tr -d ' ')" != 1 ]] ||
   ! LC_ALL=C grep -Eq '^[0-9a-f]{64}$' "$HERMES_TOKEN_FILE"; then
  echo "ERROR: $HERMES_TOKEN_FILE is not one generated 256-bit hex token." >&2
  exit 1
fi
echo "    ingestion clients read it from $HERMES_TOKEN_FILE"
key_changed=1
if [[ -f "$ACTIVE_LLAMA_KEY_STAMP" ]] &&
   [[ "$(cat "$ACTIVE_LLAMA_KEY_STAMP")" == "$LLAMA_API_KEY_SHA256" ]]; then
  key_changed=0
fi

# Feed the authorization header through curl's stdin config so the key is never
# visible in argv/process listings. LLAMA_API_KEY is a non-exported shell value.
llama_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$LLAMA_API_KEY" |
    curl -q --config - "$@"
}

# model.gguf is the stable name the plist points at; the symlink means a model
# swap is one ln plus a kickstart, with the real filename keeping provenance.
model_changed=1
if [[ -f "$ACTIVE_MODEL_STAMP" ]] && [[ "$(cat "$ACTIVE_MODEL_STAMP")" == "$MODEL_FILE" ]]; then
  model_changed=0
fi
ln -sfn "$MODEL_FILE" "$MODEL_DIR/model.gguf"
echo "    model.gguf -> $MODEL_FILE"

# ── (c) launchd agent ─────────────────────────────────────────────────────────
step "launchd agent ($LABEL)"
[[ -f "$PLIST_SRC" ]] || { echo "ERROR: $PLIST_SRC missing." >&2; exit 1; }

# --- hardening preflight (MEMORY-PLAN Day 0) --------------------------------
# The template now passes --offline and --no-slots. Probe THIS binary for both
# before rendering: on a build that lacks them, llama-server would refuse to
# start and KeepAlive would respawn it in a loop, which reads as "LLM down"
# with nothing in the obvious place saying why.
help_text=$("$LLAMA_BIN" --help 2>&1 || true)
for required in --offline --no-slots; do
  if ! grep -qe "$required" <<<"$help_text"; then
    echo "ERROR: $LLAMA_BIN does not support $required; refusing to install a" >&2
    echo "plist it cannot boot. Upgrade llama-server or remove the flag from" >&2
    echo "ops/com.hazlie.llama-server.plist together with this check." >&2
    exit 1
  fi
done

# Fail closed on persistence: --slot-save-path writes per-slot KV (prompt
# content included) to disk, and the env form reaches the process without ever
# appearing in ProgramArguments. Owner-authored corpus text must not gain a
# second, unmanaged on-disk representation as a side effect of a tuning flag.
if grep -qe '--slot-save-path' -e 'LLAMA_ARG_SLOT_SAVE_PATH' -e 'LLAMA_ARG_CACHE_IDLE_SLOTS' "$PLIST_SRC"; then
  echo "ERROR: ops/com.hazlie.llama-server.plist configures slot/prompt" >&2
  echo "persistence (slot-save-path or an LLAMA_ARG_* equivalent). That writes" >&2
  echo "prompt content to disk outside the managed stores. Remove it." >&2
  exit 1
fi

rendered=$(sed "s|@HOME@|$HOME|g" "$PLIST_SRC")
changed=1
if [[ -f "$PLIST_DST" ]] && [[ "$rendered" == "$(cat "$PLIST_DST")" ]]; then
  changed=0
  echo "    installed plist already current"
else
  mkdir -p "$(dirname "$PLIST_DST")"
  printf '%s\n' "$rendered" > "$PLIST_DST"
  plutil -lint "$PLIST_DST" >/dev/null
  echo "    installed: $PLIST_DST"
fi
# Reassert even when content is unchanged: a permissive chmod must not survive
# an otherwise idempotent setup run.
chmod 600 "$PLIST_DST"
if [[ "$model_changed" == 1 ]]; then
  changed=1
  echo "    active model changed; service reload required"
fi
if [[ "$key_changed" == 1 ]]; then
  changed=1
  echo "    llama API key changed; service reload required"
fi

bootstrap_agent() {
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID" "$PLIST_DST"; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: launchctl could not bootstrap $LABEL after 5 attempts." >&2
  return 1
}

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  if [[ "$changed" == 1 ]]; then
    echo "    reloading (service configuration or active model changed)"
    launchctl bootout "gui/$UID/$LABEL"
    bootstrap_agent
    launchctl kickstart -k "gui/$UID/$LABEL"
  else
    echo "    already loaded"
  fi
else
  bootstrap_agent
  launchctl kickstart "gui/$UID/$LABEL"
  echo "    bootstrapped"
fi

# ── (d) health ────────────────────────────────────────────────────────────────
step "waiting for $HEALTH_URL (a cold model load can take a minute)"
healthy=0
for i in $(seq 1 60); do
  if body=$(llama_curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null); then
    echo "    up after ~$(( i * 2 ))s: $body"
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != 1 ]]; then
  echo "ERROR: no healthy response after 120s." >&2
  echo "Check: launchctl print gui/$UID/$LABEL" >&2
  echo "       tail -50 $LOG_DIR/llama-server.err.log" >&2
  exit 1
fi

# /health turns green once the HTTP server is listening, even when Metal runs
# out of memory on the first real decode. Require one actual generated token so
# setup cannot report success for a server that only answers health checks.
step "verifying one-token inference"
if ! llama_curl -fsS --max-time 120 "$INFERENCE_URL" \
  -H 'Content-Type: application/json' \
  -d '{"model":"local","messages":[{"role":"user","content":"Reply OK"}],"temperature":0,"max_tokens":1}' \
  >/dev/null; then
  echo "ERROR: health passed but inference failed." >&2
  echo "Check: tail -50 $LOG_DIR/llama-server.err.log" >&2
  exit 1
fi
echo "    inference ok"

# This is deliberately written only after a real decode succeeds. On the next
# run these stamps distinguish files the resident process actually loaded from
# files changed underneath an older process.
printf '%s\n' "$MODEL_FILE" > "$ACTIVE_MODEL_STAMP"
chmod 600 "$ACTIVE_MODEL_STAMP"
printf '%s\n' "$LLAMA_API_KEY_SHA256" > "$ACTIVE_LLAMA_KEY_STAMP"
chmod 600 "$ACTIVE_LLAMA_KEY_STAMP"
unset LLAMA_API_KEY LLAMA_API_KEY_SHA256

for log in "$LOG_DIR"/*.log; do
  [[ -e "$log" ]] && chmod 600 "$log"
done

echo
echo "llama-server is resident. Logs: $LOG_DIR/llama-server.{out,err}.log"
