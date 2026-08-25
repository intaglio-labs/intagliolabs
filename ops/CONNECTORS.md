# Connectors — contract and runbook

The connectors tier is the set of pollers that read the owner's own data —
Apple's on-disk stores and the approved remote endpoints enumerated in
[`EGRESS.json`](EGRESS.json) — and write it into
the household context store through Hermes. This document is the contract:
what each source writes, how identity and deletion work, how the Oura
connector authenticates, and the operational runbook (Full Disk Access, logs,
backups, the security boundary).

Hermes remains the corpus's **sole writer and sole deleter**. Connectors write
only via `POST /ingest` (contract: [`INGESTION.md`](INGESTION.md)) and request
deletion only via the bearer-only `/admin/*` routes. No connector ever opens
`context.db`.

## Network posture

The connectors daemon (`connectors/daemon.mjs` — a child of the app via
`widget/src/Connectors.swift`, or the `io.intaglio.connectors` launchd agent on
a machine with no app installed) is **loopback-only: it opens no listener of
any kind.** Its sockets are outbound only:

- **loopback out** to Hermes (`127.0.0.1:51789`): `POST /ingest`, `/admin/*` —
  the only place corpus rows go.
- **outbound HTTPS/IMAPS** to the approved remote endpoints (Granola, Oura,
  Notion, Gmail IMAP, Google Calendar + its OAuth host), **enumerated in
  [`EGRESS.json`](EGRESS.json) and nowhere else** — the table that used to sit
  here restated the hosts and drifted (it omitted the two Google Calendar
  hosts while the connector reached them), which is exactly the failure the
  ledger ends. Read the ledger for what is reachable; the tripwire is
  `connectors/test/egress.test.mjs`.

The `files` connector adds **no** egress path: it reads the local
mirrors that iCloud Drive, Box and Dropbox already maintain on disk and opens
no socket at all.

An earlier revision of the plan had one LAN listener here (Health Auto Export
push). **That listener is gone**: the Apple Health connector was replaced by
the Oura connector (owner decision, 2026-08-19), health data now arrives by
outbound polling like Granola's, and HAE is demoted to the fallback appendix
at the end of this file. Doctor deliberately has no LAN-listener checks —
there is nothing inbound to check.

> **RESOLVED 2026-08-22 — and the flag itself had gone stale.** It said
> `ui/AGENTS.md` still named the HAE LAN transfer and omitted
> `api.ouraring.com`; both had been amended by the time anyone read it, so the
> flag was reporting a discrepancy that no longer existed while a much larger
> one had opened underneath it.
>
> The host list no longer lives in prose anywhere. **`ops/EGRESS.json` is the
> only enumeration**, and `connectors/test/egress.test.mjs` fails the suite on
> any host in tracked source that is missing from it. That is what stops this
> paragraph, and the eight others like it, from drifting again: two prose files
> each claiming to supersede the other is exactly the failure that produced
> them.

## Configuration (config.json)

`~/.hazlie/connectors/config.json` (0600, in the 0700 `~/.hazlie/connectors`
directory) is required — `loadConfig()` (`connectors/daemon.mjs`) refuses to
run any connector without it, `run.mjs` included. `ops/setup-connectors.sh`
creates it as `{}` if missing; every top-level key below is optional, so `{}`
is a fully valid config and every connector runs with its defaults.

| Key | Shape | Notes |
|---|---|---|
| `selfName` | string | Non-empty if present. |
| `ownerEmails` | — | The owner's own addresses beyond `mail.accounts`, read by the people graph, not the connectors themselves. |
| `hermesUrl` | string | HTTP loopback origin, e.g. `"http://127.0.0.1:51789"` — for a machine where 51789 is taken. Env (`HAZLIE_HERMES_URL`) wins under launchd; this is what a hand-run `node run.mjs <source>` reads instead. |
| `intervals` | `{ <source>: seconds }` | 60–86400; per-source poll interval override. |
| `mail` | `{ host, port, user, folders, backfillDays, maxBodyBytes, accounts: [...] }` | `accounts[]` takes the same keys (minus `accounts`) for more than one mailbox. The Gmail app password itself is a secret (`gmail-app-password.txt`), not part of this file. |
| `imessage` | `{ backfillDays }` | |
| `calendar` | `{ backend: "local" \| "google" }` | Never both — see `sources/calendar.mjs` `run()`. |
| `granola` | `{ includeTranscripts }` | |
| `oura` | `{ backfillDays }` | |
| `photos` | `{ backfillDays }` | |
| `notion` | `{}` | No keys yet — reads only its secret file. |
| `files` | `{ roots, materializeDataless }` | `materializeDataless: true` opts into opening online-only cloud files; see "files — the dataless rule" below for the cost. |
| `linkedin` | `{}` | No keys yet — an unknown key here is a caller bug, not a no-op. |
| `retention` | `{ <source>: days, maintainHour: "HH:MM" }` | 24-hour clock. |
| `role` | — | Accepted, ignored (dead since the two-machine split was removed). |

Every level is closed: an unrecognized key throws rather than being silently
ignored, so a typo (`interval` for `intervals`) fails loudly at startup
instead of quietly running with defaults.

## Source registry

One namespace per source; the full `entity_id` grammar and upsert semantics
live in [`INGESTION.md`](INGESTION.md). What each connector puts in a row:

| `source` | `entity_id` | `text` | `meta` |
|---|---|---|---|
| `imessage` | `imessage:<guid>` | decoded message text (attachments as `[attachment: …]` placeholder) | chat/handle ids, timestamps, attachment metadata |
| `calendar` | `calendar:<event_uid>:<recurrence_id>` | title + human-readable time span | `start_ms`, `end_ms`, attendees (pre-sorted), location, raw ids |
| `mail` | `mail:<Message-ID>` (fallback `mail:<account>:<folder>:<uidvalidity>:<uid>`) | plaintext body, ≤16 KiB | headers subset: from/to (pre-sorted), subject, folder, uid |
| `granola` | `granola:<note_id>` | note summary (transcripts off by default) | note metadata from the REST response |
| `health` | `health:<metric>:<YYYY-MM-DD>` · `health:workout:<start_iso>` | one human sentence per metric per completed local day | **the raw Oura record verbatim, including its Oura `id`** |
| `notes` | `notes:<note_id>` | title + decoded body (gzip → protobuf) | folder, created, char count |
| `photos` | `photos:<uuid>` | caption / scene description | time, place, faces, album |
| `notion` | `notion:<page_id>` | title + the page's text blocks, ≤20k chars | url, parent type, block count, `truncated` |
| `files` | `files:<absolute path>` | filename + folder trail; file contents when local, small and text | `store`, `folder`, `ext`, `bytes`, **`online_only`**, `has_content` |
| `whatsapp` | `whatsapp:<stanza_id>` | one message's text, from WhatsApp Desktop's local store | `stanza_id`, `is_from_me`, `is_group`, `chat_handle`, `chat_name`?, `sender_handle`? |
| `linkedin` | `linkedin:conn:<slug>` · `linkedin:msg:<sha8>` | connection: name — position at company (+ connected date); message: content, ≤4000 chars | connection: name, url, email, company, position; message: conversation id, from/to, subject |
| `hazlie_digest` | `hazlie_digest:<date>` | the delivered digest text | composition facts |
| `seed` | (none) | dev fixtures | — |

Two rules from the ingest contract that bind every connector:

- **Always send `ts`** on entity rows — a server-defaulted `ts` changes the
  content hash on every delivery and turns each redelivery into a spurious
  update.
- **Pre-sort semantically-unordered arrays** (attendees, recipients) before
  ingest — arrays keep their order in the canonical hash, and a reordered
  attendee list would read as an edit.

## Cursor semantics

Cursors are each connector's own local state, kept under `~/.hazlie/connectors/`
(files 0600 in 0700 directories) — never in `context.db`, and never containing
row text.

| Source | Cursor | Notes |
|---|---|---|
| `imessage` | chat.db `ROWID` high-water mark | first run pins to `MAX(ROWID)` unless backfilling |
| `calendar` | none — **window reconciliation** | scan −7d..+30d (backfill −90d..+60d); see below |
| `mail` | per-folder IMAP `UID` cursor + `UIDVALIDITY` guard | a `UIDVALIDITY` change invalidates the cursor for that folder; re-scan |
| `granola` | `updated_after` timestamp, rewound 60 s | the skew absorbs clock drift; upsert makes the overlap free |
| `health` (Oura) | last completed poll day + **trailing 7-day re-poll** | Oura corrects daily summaries retroactively; the re-poll window catches corrections, and upsert lands them as `updated`/`unchanged` |
| `whatsapp` | `ZMESSAGEDATE` high-water mark (Apple-epoch seconds) | reads a snapshot of WhatsApp Desktop's store; freshness is bounded by when the app last ran, and the store **prunes** — never reconcile by absence (see `PROBES.md`) |
| `linkedin` | export files' mtimes | file-based, no API: scans only when a CSV in `~/.hazlie/imports/linkedin/` is newer than last seen; `--backfill` re-reads both files |

**Window reconciliation (calendar, and any future scanned-window source):**
upserts cannot express deletion. After each successful window scan the
connector calls `GET /admin/entities?source=calendar&from_ts=&to_ts=` (returns
entity ids + timestamps only — corpus content never crosses back), diffs
against the observed set, and calls `POST /admin/delete-entities` for the
difference. A rescheduled event therefore moves instead of duplicating, and a
cancelled one cannot haunt tomorrow's digest. Reconcile only over windows the
scan fully covered — deleting outside the scanned window would delete rows the
scan simply didn't look at.

## Lifecycle — retention, purge, maintenance

All deletion flows through Hermes' bearer-only `/admin/*` routes (full
verified contract in [`INGESTION.md`](INGESTION.md)):

| Route | What | When |
|---|---|---|
| `POST /admin/retain {source, keep_days}` | delete rows older than the horizon | each connector's retention schedule |
| `POST /admin/delete-entities {source, entity_ids}` | reconciliation deletes, ≤500/batch | after window scans |
| `POST /admin/purge {source}` | delete ALL rows for a source, **then FTS rebuild + VACUUM inline, immediately** | `node connectors/run.mjs <source> --purge` |
| `POST /admin/maintain {}` | the batched physical cleanup (FTS rebuild + VACUUM) | idle window, default **03:30** |

The split exists because `VACUUM` blocks single-threaded Hermes for its whole
duration: routine retention deletes cheaply on schedule and the daemon
requests `/admin/maintain` in the idle window — but a **purge pays for the
physical cleanup inline**, because "purge" means the text must be gone from
the FTS pages and the free list *now*, not at 03:30. A purge via `run.mjs`
also wipes the connector's own local artifacts (cursors, caches) for that
source.

## The Oura connector

Replaces the Apple Health / Health Auto Export connector (owner decision,
2026-08-19). Oura deprecated personal access tokens in December 2025, so this
is an OAuth2 client against Oura API v2. Entity ids are unchanged from the
plan: `health:<metric>:<YYYY-MM-DD>`, `health:workout:<start_iso>`.

### App registration (one-time, human)

1. Sign in at `https://cloud.ouraring.com/oauth/applications` and create an
   application (this is the owner's own account; the "app" is private).
2. Redirect URI: a loopback URI (`http://localhost:<port>/callback`) that the
   OAuth helper binds for the seconds the consent flow takes. Loopback
   redirect is the native-app OAuth pattern; nothing remote ever hosts it.
3. Put the client id and client secret in `~/.hazlie/secrets/oura-client-id.txt`
   and `oura-client-secret.txt` (0600, one line each) — the helper and the
   connector both read them from there for the refresh flow.
4. Scopes the helper requests: `personal daily heartrate workout session spo2`
   (the connector reads daily summaries, sleep periods for HRV, workouts,
   stress). Oura's portal now also offers `stress`/`heart_health` scopes beyond
   its documented list.

### Token file

`~/.hazlie/secrets/oura-tokens.json`, mode 0600 in the 0700 secrets dir, as
written by `ops/oura-auth.mjs` (the shape the connector's token manager reads):

```json
{
  "access_token": "…",
  "refresh_token": "…",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "personal daily …",
  "obtained_at": 1755600000000
}
```

Minted by `ops/oura-auth.mjs` (one-time browser approval; a `.prev` sibling
holds the previous pair — see rotation below). Client credentials live in
their own two files above, NOT in the token file: the token file gets
rewritten on every rotation, and a rewrite path that also carries the app
secret is a rewrite path that can lose it. Doctor WARNs `secret-oura` until
the helper has run; the oura connector runs sandbox-only (and refuses to
ingest) until then.

**Current registration caveat (2026-08-19):** the Oura app's registered
redirect URI is `https://contentprinter.com`, not the helper's
`http://localhost:8817/callback` — until the app registration adds the
localhost URI, authorization is the manual flow: open the consent URL with
the contentprinter redirect, approve, and paste the landing URL's `?code=…`
back for a manual exchange (redirect_uri must match at the token endpoint).

**Refresh rotation is the connector's job, and the order matters:** Oura
rotates the refresh token on every refresh — the response carries a NEW
refresh token and the old one is dead. The connector must persist the new
token file **atomically (write temp + rename) before first use of the new
access token**; crashing after use-but-before-persist strands the grant, and
the only recovery is re-running the OAuth helper through browser consent.

### Polling

- Endpoints: `https://api.ouraring.com/v2/usercollection/{daily_sleep,
  daily_readiness, daily_activity, sleep, workout, session}` with
  `start_date`/`end_date` parameters and `next_token` pagination.
- Cadence: every 30 minutes, re-scanning the trailing 7 local days (the
  correction window — see cursor table). Upsert makes the overlap free:
  corrected records land as `updated`, everything else as `unchanged`.
- Rate limit: **5000 requests per 5 minutes** (API-documented). The poller's
  worst day is a few dozen requests per cycle; on a `429`, honor
  `Retry-After` and push the cycle, never tight-retry.
- Transform: one row per metric per completed local day (`text` is one human
  sentence; `meta` is the raw Oura record verbatim, including its Oura `id`),
  plus one row per workout. Incomplete (today's) days are not written — they
  would churn as `updated` on every poll for no reader benefit.

## Fallback appendix: Apple Health via Health Auto Export

**Not built.** Only relevant for Apple Health data Oura does not carry (e.g.
iPhone-sourced steps if the ring is retired, blood pressure from a cuff). HAE
pushes JSON over the local LAN, which would make the connectors daemon a
LAN-listening process again — a real posture change, not a config flag. If it
is ever revived, the plan's listener spec binds in full: explicit `bindHost`
(refuse `0.0.0.0` or unset), shared token compared sha256-then-timingSafeEqual,
`application/json` only, 10 MiB cap, per-IP rate limit, whole-payload
validation before any ingest, and the trusted-LAN assumption written here with
TLS-in-front as the documented opt-out. The egress policy in `ui/AGENTS.md`
must be re-amended **before** that listener first binds.

## FDA runbook — Full Disk Access for the Apple-store reads

chat.db, the Calendar store, and AddressBook sit behind TCC. The design is:
**one grant, to one file, used only via launchd.**

- **The granted file** is `~/.hazlie/bin/node` — a copy owned by
  `ops/setup-connectors.sh`, because FDA attaches to an exact binary and the
  Homebrew path is deleted out from under a grant on every `brew upgrade`.
  Grant it once: System Settings → Privacy & Security → Full Disk Access →
  `+` → (⌘⇧G) `~/.hazlie/bin/node` → toggle on.
- **Attribution is launchd-only.** TCC applies the grant to the *responsible
  process*. When launchd spawns the stable binary directly (as both plists
  do), the binary is responsible and the grant applies. When a shell spawns
  the very same binary, the terminal app is responsible and the read is
  denied. Verified on this machine, 2026-08-19: identical read-only opens of
  chat.db, the Group Containers Calendar store, and two AddressBook stores
  all PASS under `launchctl submit … ~/.hazlie/bin/node connectors/doctor.mjs`
  and are all EPERM'd when the same command runs from a terminal.
- **Consequences:**
  - `doctor` run from a shell shows `fda-*` FAILs that production will not
    have. The production truth is one line:
    `launchctl submit -l io.intaglio.doctor -o /tmp/doctor.out -e /tmp/doctor.err -- ~/.hazlie/bin/node <repo>/connectors/doctor.mjs --json`
    — poll `/tmp/doctor.out`, then `launchctl remove io.intaglio.doctor`.
  - Never wrap the binary in a shell script or another interpreter inside a
    plist; the wrapper becomes the responsible process and the grant stops
    applying.
  - Replacing the binary can invalidate the grant, which is why
    setup-connectors.sh refuses a version change without `--replace-node` and
    tells you to re-verify afterwards.
- **Recovery** when the grant row looks present but launchd-spawned reads are
  still denied (typically a stale entry after a binary swap):
  `tccutil reset SystemPolicyAllFiles` — note this clears **every** app's FDA
  grant, not just ours — then re-grant the stable binary and re-verify with
  the launchd doctor run.

## Log-content policy

Connector logs are JSON-lines under `~/.hazlie/logs/`. **No log line may ever
carry corpus content**: no message bodies, no mail subjects, no note titles or
text, no health values. Counts, entity ids, durations, HTTP statuses, cursor
positions, and schema facts only. Entity ids are constructed to be safe to log
(guids, dates, normalized Message-IDs); if a source's natural id embeds
content, the connector must hash it before it may appear in a log or an error.
Doctor output obeys the same rule — its SQLite probes read only
`sqlite_master`, so there is no content to leak.

## Backup policy — NONE, by default and on purpose

`context.db` is not backed up. A backup is a second copy of the household
corpus sitting outside every guard this system builds — outside Hermes'
sole-writer boundary, outside `secure_delete`, outside retention and purge (a
purged source would live on in every snapshot). And it buys nothing: the
corpus is *derived state* — every source re-ingests from its system of record
(chat.db, IMAP, the Granola and Oura APIs), and entity upsert makes re-ingest
converge.

Opt-in, if a backup is ever truly wanted: take it with node:sqlite `backup()`
(never a file copy — WAL sidecars make copies non-atomic) onto an encrypted
volume the owner manages, and accept in writing that purge no longer means
purged until that volume is handled too.

## Security boundary

Stated once, so "private" is not assumed to mean more than it delivers:

- **At rest** the guarantee is FileVault. File modes (0600/0700 everywhere)
  are the same-machine multi-user guard, not disk-theft protection.
- **Same-uid processes are trusted** — a process running as the owner can
  read the token file and the database directly, and no server-side check
  changes that (`authorize()` in `ui/server/hermes.mjs` documents the
  residual cross-uid gap too). The machine is the boundary.
- **Linked Apple devices receive courier output.** Digests and replies sent
  through Messages transit Apple's servers and sync to every device on the
  Apple ID; a digest derived from health and calendar data lands on all of
  them. The privacy boundary of this system is the Apple ID, not this Mac.
- Egress is the closed set enumerated in [`EGRESS.json`](EGRESS.json); a new
  path lands as a ledger entry with a real `decision`, in the same commit as
  the code that opens it, enforced by `connectors/test/egress.test.mjs`.

## Doctor

```
node connectors/doctor.mjs             # human-readable
node connectors/doctor.mjs --json      # machine-readable
node connectors/doctor.mjs --network   # + Granola auth (200 expected),
                                       #   api.ouraring.com and IMAP reachability
```

Exit 0 iff no FAIL. WARNs name connectors disabled by design (missing Oura
tokens or Gmail app password) or edges the store readers handle. Network
checks are opt-in so a local diagnosis opens no third-party sockets as a side
effect. Remember the attribution caveat above when reading `fda-*` rows from
a shell.


## files — the dataless rule

Measured on the owner's Mac, 2026-08-20, across iCloud Drive, Box and Dropbox:

| | count |
|---|---|
| files walked | 97,718 |
| **dataless** (online-only, no bytes on disk) | **96,262** |
| materialized locally | 1,456 |
| total size if every dataless file were opened | **45.6 GB** |

Reading a dataless file materializes it. A connector that opened them would
pull 45.6 GB through the owner's iCloud account on a 15-minute timer, and
would look like a sync bug rather than a design mistake. So:

- **Dataless files are ingested as metadata and never opened.** `meta.online_only`
  is `true` on those rows, and `meta.has_content` is `false`, so a reader can
  never mistake a filename for a summary of contents.
- **Detection is `blocks === 0 && size > 0`.** macOS marks these with the
  `SF_DATALESS` st_flag, which node's `Stats` does not expose. The proxy was
  verified against `stat(1)`'s flag string on this machine: dataless files
  report 0 allocated blocks, a materialized 34,820-byte neighbour reports 72.
  An APFS-compressed file whose data lives in an xattr can also report 0
  blocks, so this can misjudge a local file as dataless — that direction
  under-reads instead of triggering a download, which is the failure the
  check exists to prevent.
- `files.materializeDataless` exists in the config schema and **throws** if
  set to `true`. It is a placeholder for a deliberate implementation with a
  size budget, not a switch.

Other rules the walk enforces, each with a measurement behind it:

- **Symlinks are never followed.** iCloud Drive's `Desktop` and `Documents`
  are symlinks back into the home directory; following them walks all of
  `~`, ingests it twice, and escapes the configured root.
- **Dependency trees are skipped** (`node_modules`, `.git`, `build`, `Pods`,
  `.dart_tool`, …). Without this, ~60k of the 96k files found are a synced
  `node_modules` and the 3,843 real documents are buried.
- **Credential folders and filenames are skipped** (`Secret Keys`, `.ssh`,
  `*.pem`, `.env`, `id_rsa`, …). The owner's iCloud has a folder called
  "Secret Keys"; neither its contents nor its filenames belong in a corpus.
- **Only documents and text files earn a row.** 17,331 files survive the
  exclusions; 3,843 of those are documents.

**Cursor.** `files:max-mtime`, advanced to the mtime of the last row actually
*delivered*, not of the last file seen. The walk yields in directory order,
so candidates are sorted by mtime before the per-run cap is applied — without
that, the first dry run delivered 2,000 iCloud rows, declined to advance the
cursor because it was capped, and would have re-delivered the same 2,000
forever without ever reaching Box or Dropbox. Verified converging: run 1
delivered 2,000 (1,831 remaining), run 2 delivered 1,828, run 3 delivered 0.

**First run is slow, steady state is not.** The first walk makes iCloud's
file provider answer ~17k cold metadata queries: 54 s measured. Warm, the
same walk is 242 ms.

## notion — setup and consent

Notion internal integrations start with access to **nothing**; the owner
shares individual pages or databases with the integration. That is a
per-page consent model enforced by Notion's own servers, and it means an
empty first run is the expected outcome — the scan logs
`sharedWithIntegration` so "nothing shared yet" and "nothing changed" never
look the same.

1. Create an internal integration at <https://notion.so/my-integrations>.
2. Save its token: `(umask 077; pbpaste > ~/.hazlie/secrets/notion-api-key.txt)`
3. In Notion, open a page → ••• → Connections → the integration.

`Notion-Version` is pinned (`2022-06-28`) so a server-side release cannot
change the response shape under a running daemon.

**Known gap:** nested blocks (toggles, columns) hold their text one level
down and are **not** followed, so their contents are missing from these rows.
`meta.blocks` records how many top-level blocks were read. Following children
costs a request per container plus a recursion bound, and should be measured
before it is built.
