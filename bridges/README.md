# bridges/ — continuous social DMs via a local Matrix bus

This is Lane 1 of the social-bridges plan (`SOCIAL-BRIDGES-PLAN.md`, a plan
file that stayed in the private repo): the Beeper trick, run entirely on
this Mac. A tiny Matrix homeserver is an aggregation bus; one bridge per platform
speaks that platform's own client protocol as the owner's linked session and
relays DMs into Matrix; one hazlie connector reads Matrix. Nothing federates,
nothing listens off-loopback, no corpus data reaches a cloud model — the same
inbound-fetch-of-your-own-data posture as the IMAP and Oura pollers.

## What's running

| container | image | what | host port |
|---|---|---|---|
| `hazlie-synapse` | `ghcr.io/element-hq/synapse@sha256:2af5…` | the homeserver / bus | `127.0.0.1:8008` only |
| `hazlie-meta` | `dock.mau.dev/mautrix/meta@sha256:662f…` | Facebook **Messenger** | none (internal) |
| `hazlie-instagram` | `dock.mau.dev/mautrix/meta@sha256:4b27…` | **Instagram** DMs | none (internal) |
| `hazlie-twitter` | `dock.mau.dev/mautrix/twitter@sha256:a780…` | **X/Twitter** DMs | none (internal) |
| `hazlie-telegram` | `dock.mau.dev/mautrix/telegram@sha256:c073…` | **Telegram** | none (internal) |
| `hazlie-discord` | `dock.mau.dev/mautrix/discord@sha256:0654…` | **Discord** DMs | none (internal) |
| `hazlie-linkedin` | `dock.mau.dev/mautrix/linkedin@sha256:0bf6…` | **LinkedIn** DMs | none (internal) |
| `hazlie-slack` | `dock.mau.dev/mautrix/slack@sha256:7761…` | **Slack** DMs | none (internal) |

(The runtime Compose file, setup path, and background prefetch all use the same
immutable image digests. A first install therefore cannot generate config with
different bridge code from the container it later runs.)

**Why two Meta bridges:** mautrix split them in July 2026 when Meta dropped the
shared Instagram/Messenger API; the v26.08 `meta` binary is Messenger-only, the
`ig-` tag is Instagram-only. **Why Synapse** (not the plan's Conduit): Conduit is
dead-ended, its fork conduwuit is archived, and continuwuity has an
appservice-registration bug that breaks encrypted bridges. Synapse is heavier but
Docker contains that, and every mautrix path targets it.

- Server name: `hazlie.local` (never federates — baked into user IDs, don't change).
- Owner Matrix user: `@you:hazlie.local`. Credentials + access token live 0600
  at `~/.hazlie/matrix/owner-credentials.json`.
- All runtime state (configs, session cookies, message DBs) lives under
  `~/.hazlie/matrix/` (0700), **outside the repo**. Only this dir is committed.

## Setting it up from nothing

`bash ops/setup-bridges.sh` — idempotent, resumable, and the ONLY recipe for a
fresh machine. It generates synapse's config (client-only, no federation, all
seven appservices registered), each bridge's config and registration (hardened:
backfill on, double puppeting off), brings the stack up, and creates the owner
user + `~/.hazlie/matrix/owner-credentials.json`. Written 2026-08-25, the day
a wipe proved the original stack's recipe lived in nobody's head: the widget's
login windows harvested cookies with no bridge behind them to take the
hand-off. Telegram reads its app credential from the signed app bundle; a
source build without one falls back to the per-user api_id/api_hash walkthrough.

## Operating it

```sh
cd bridges
docker compose ps                     # status
docker compose up -d                  # start (survives reboot via restart: unless-stopped, once Docker is up)
docker compose logs -f mautrix-meta   # watch a bridge
docker compose down                   # stop (data persists in ~/.hazlie/matrix)
docker compose down && rm -rf ~/.hazlie/matrix/*   # FULL teardown, wipes everything
```

## Logging in a platform  (THE human step — nothing flows until this is done)

Login happens in **Intaglio Labs' own connect page** (`connect/`), not a third-party
Matrix client. The Messenger and Instagram rows there open a native login panel
(`connect/lib/bridge.mjs` + `bridgePage.mjs`) that drives the bridge bot over the
local Matrix API. Auth is **cookie-based** (mautrix removed QR from the bot flow).

Per platform, on the connect page:

1. Click **Connect** on the Messenger (or Instagram) row → the login panel.
2. Click **Begin login**. Behind the scenes it claims the room as the bot's
   management room, cancels any half-finished attempt, and starts fresh; the
   panel then shows the bot asking for cookies.
3. In a browser tab on facebook.com / instagram.com (logged in): devtools →
   **Network** → filter `graphql` → click a request → **Copy → Copy as cURL** →
   paste into the panel's box and send. The bridge reads the cookies out of it.
   (Messenger needs `datr, c_user, sb, xs`; Instagram needs
   `sessionid, csrftoken, mid, ig_did, ds_user_id` — the bot names any it's missing.)
4. The panel shows "linked as …" and the bridge backfills your DMs.

The pasted cookies go browser → connect page (loopback) → local bot → Meta, and
are **masked in the panel transcript** so they're never echoed back on screen.

### Privacy hardening (applied — passive/invisible posture)

The bridges are configured to leave the smallest possible footprint on the
remote account. These are set in each bridge's `config.yaml` (under
`~/.hazlie/matrix/*`, gitignored); reapply with `yq` after any regeneration:

```sh
# per bridge dir (~/.hazlie/matrix/<bridge>):
yq -i '.backfill.enabled = true |
  .backfill.max_initial_messages = 2147483647 |
  .backfill.max_catchup_messages = 2147483647 |
  .backfill.threads.max_initial_messages = 2147483647 |
  .double_puppet.secrets = {}' config.yaml
```

`homeserver.presence = false` used to be in that line. **Drop it — the key does
not exist.** Verified 2026-08-22 across all seven configs: no bridge version here
has `homeserver.presence`, and each drops it during the config rewrite it does
at startup. It was a no-op that got copied from bridge to bridge and read like a
protection. Presence, where it is controllable at all, is
`network.send_presence_on_typing` (meta only, already false by default).

`mautrix-discord` is the older generation and uses different paths for both:
`bridge.backfill.forward_limits.{initial,missed}.{dm,channel,thread}`. Initial
backfill has no unlimited sentinel, so setup uses `2147483647`; missed-message
backfill uses its documented `-1` fetch-all value. Setup also raises
`bridge.startup_private_channel_create_limit` from five to `2147483647`, so
every known DM receives a portal at startup. The double-puppet key is
`bridge.double_puppet_server_map`. `connectors/doctor.mjs` knows both shapes.

On an existing install, setup detects the former capped values before replacing
them and explicitly restarts `mautrix-discord`. Compose cannot detect a change
inside the bind-mounted config file on its own. The restart preserves the login
database while Discord re-discovers every private channel, creates the portals
the old five-chat cap omitted, and repopulates existing portals through the
missed-message fetch-all lane.

- **`double_puppet.secrets: {}`** — the bridge acts as a separate ghost, never
  as *you*, so it can never mark your DMs "seen" on Meta's side.
- **`homeserver.presence: false`** + defaulted `send_presence_on_typing: false`
  — never broadcasts that you're online/typing.
- ~~**`backfill.enabled: false`** — no bulk history pull (which would mark many
  chats read).~~ **THIS WAS FALSE, and it cost four bridges their history.**
  Backfill is ON everywhere now (owner decision, 2026-08-22: "all
  connections should pull bulk messages"), and the claim it rested on does not
  survive contact with the logs.

  The claim was that pulling history marks conversations read on the real
  account. Checked 2026-08-22 against `docker compose logs mautrix-meta`, which
  had been backfilling with `enabled: true` for 21 hours across 19 finished
  conversations:

  - 101 read receipts, **every one inbound** — `Bridged read receipt,
    action="handle remote event"`. That is Meta telling the bridge a thread is
    read because the owner read it on their phone.
  - **Zero outbound.** Nothing under a matrix-event action, nothing to the
    network.
  - The `mark_read=true` in backfill log lines is the LOCAL Matrix room, driven
    by `unread_hours_threshold`, whose own config comment reads "mark it as read
    even if it's unread on the remote network".

  Which is what the entry two bullets up already implied: read status reaches
  the platform only through double puppeting, and `double_puppet.secrets: {}`
  means the bridge can never act as the owner. There was no mechanism for the
  feared behaviour to happen through.

  Kept struck rather than deleted because the reasoning was plausible, was
  written with confidence, and was believed for days — a session read it, took
  it as fact, and nearly designed a skip-unread-conversations feature around it.
  `connectors/doctor.mjs` now FAILS when a bridge has backfill off, so this
  cannot quietly revert.
- **Read-only in practice** — sending DMs *through* the bridge is the automation
  Meta actually hunts; Intaglio Labs only reads, so stay out of typing in portal rooms.
- **Cookies from your everyday browser session** — extract them from the browser
  you already use the platform on, so Meta sees your existing session continuing
  on your normal device/IP, not a new-device login.

### Migrating a bridge whose config the image has outgrown

Symptom: the container crash-loops on `Legacy bridge config detected, but hacky
network config migrator is not set`. It means the image has moved to bridgev2
and the config on disk is the older format. Hit on `mautrix-slack` 2026-08-22.

**Check for state first.** If the bridge has never logged in there is nothing to
preserve and this is free:

```sh
sqlite3 -readonly ~/.hazlie/matrix/<bridge>/mautrix-<bridge>.db 'select count(*) from user_login;'
```

Then, from `bridges/`:

```sh
docker compose stop mautrix-<bridge>
cd ~/.hazlie/matrix/<bridge>
cp config.yaml config.yaml.legacy && rm config.yaml
cd - && docker compose up mautrix-<bridge>        # writes a fresh default config, then exits
docker compose stop mautrix-<bridge>
```

The fresh config is generic, so carry the identity back over. **`as_token` and
`hs_token` must keep matching `registration.yaml`** or Synapse rejects the
appservice — read them from the registration, not from memory:

```sh
cd ~/.hazlie/matrix/<bridge>
yq -i '
  .homeserver.address       = load("config.yaml.legacy").homeserver.address |
  .homeserver.domain        = load("config.yaml.legacy").homeserver.domain  |
  .appservice.id            = load("config.yaml.legacy").appservice.id |
  .appservice.bot.username  = load("config.yaml.legacy").appservice.bot.username |
  .appservice.hostname      = load("config.yaml.legacy").appservice.hostname |
  .appservice.port          = load("config.yaml.legacy").appservice.port |
  .appservice.as_token      = load("registration.yaml").as_token |
  .appservice.hs_token      = load("registration.yaml").hs_token |
  .bridge.permissions       = load("config.yaml.legacy").bridge.permissions |
  .database.type            = "sqlite3-fk-wal" |
  .database.uri             = "file:/data/mautrix-<bridge>.db?_txlock=immediate" |
  .backfill.enabled         = true |
  .backfill.max_initial_messages = 2147483647 |
  .backfill.max_catchup_messages = 2147483647 |
  .backfill.threads.max_initial_messages = 2147483647 |
  .double_puppet.secrets    = {}
' config.yaml
```

Two that bite, both found the hard way: the generated config's `database.uri` is
a **postgres placeholder**, and `bridge.permissions` is an **example.com
placeholder** that fails startup with `bridge.permissions not configured`. Then
`docker compose restart mautrix-<bridge>` and look for `Bridge started`.

**Image consistency:** `docker-compose.yml` pins every live bridge by digest.
Telegram's setup and prefetch entries use its runtime digest as well. The
remaining setup/prefetch entries still use mutable tags and must also be
aligned; until then, a mutable tag can move underneath a config that was fine
yesterday.

### The honest risk (Meta)

Bridging with your real cookies is a linked-device-style session. No mautrix-
specific crackdown is known, and single-user read-your-own-DMs is far from the
bulk-automation Meta actually hunts — but sessions get invalidated periodically
(re-`login`), and a ban is rare-but-nonzero.

The `matrix` connector is live for Messenger, Instagram, LinkedIn, X, Telegram,
Discord and Slack. It maps each portal event back to the platform-specific
Hermes source and walks history through the shared newest-year-first barrier.
