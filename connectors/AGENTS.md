# connectors/ — binding rules

This package is the read side of Intaglio Labs' ingestion: resident pollers that
read the owner's own stores and services and deliver rows to hermes. The
rules below are load-bearing; the why is written with each one so nobody has
to reconstruct it before "simplifying" it away.

## Network posture: loopback-only, no listener — and the Oura change

**This daemon opens NO listener of any kind.** Its sockets are outbound only:

- loopback HTTP to hermes — the only place corpus rows go. The address is
  `HAZLIE_HERMES_URL`, then config `hermesUrl`, then `127.0.0.1:51789` — the
  canonical port since 2026-08-20, chosen because unrelated local software may
  hold 8787 and answer 200 there.
  run.mjs and the daemon's
  preflight both verify the port answers with hermes' exact `/health` body
  before any row is sent — liveness is not identity.
  (the ingest client refuses a non-loopback base URL at runtime);
- outbound HTTPS/IMAPS to the approved endpoints, **enumerated in
  `ops/EGRESS.json` and nowhere else**. This list used to be spelled out here
  and it drifted from `ui/AGENTS.md`'s list, so the two documents disagreed
  about what was approved — which is how `api.notion.com` came to be asserted
  as approved in this file while the document of record had never heard of it.
  `connectors/test/egress.test.mjs` now fails on any host missing from the
  ledger, so the list stays honest without anyone remembering to update prose.

The `files` connector (added 2026-08-20) opens **no socket at all** — it reads
the local mirrors iCloud Drive, Box and Dropbox already maintain on disk, so
it widens nothing here. What it does need is a hard rule about *not* reading:
many files in those folders can be dataless, and opening them could pull a
large archive down through the owner's cloud account on a timer. See
`ops/CONNECTORS.md` § "files — the dataless rule".

Owner decision, 2026-08-19: the Apple Health connector is **replaced by an
Oura Ring API v2 connector**. Oura deprecated personal access tokens in
Dec 2025, so the connector uses OAuth2 (app registered by the owner at
cloud.ouraring.com/oauth/applications; long-lived access token + refresh
token stored locally as an owner-only JSON secret, read via
`lib/secrets.mjs readSecretJson`). Health data arrives by **polling**, like
the Granola poller. Consequence: the previously planned Health Auto Export
LAN listener — the one non-loopback surface this system ever contemplated —
**is not built**, and the daemon is fully loopback-only. HAE is demoted to a
documented fallback for non-Oura Apple Health data only, and building it
would be a design change requiring an owner decision, not a feature. Entity
ids are unchanged: `health:<metric>:<YYYY-MM-DD>`,
`health:workout:<start_iso>`.

(This note used to say `ui/AGENTS.md` still described the HAE LAN path as
approved item 3, and that this file superseded it "pending that document's
update". That was already stale when it was read in the 2026-08-22 audit —
`ui/AGENTS.md` item 3 had been amended to Oura. Two documents each claiming to
supersede the other is precisely the failure `ops/EGRESS.json` now prevents:
neither supersedes anything, both point at the ledger.)

## Pure-JS dependencies only

`libphonenumber-js`, `imapflow`, `mailparser` — and nothing with a native
module, ever. **Why:** the daemon runs under a *copied* node binary
(`~/.hazlie/bin/node` — Full Disk Access is granted per-resolved-binary and
does not survive a `brew upgrade node`, so setup pins a copy at a stable
path). A native module binds a compiled ABI to the node it was built for and
**breaks silently when that binary is swapped** — the failure shows up as a
crash or misload weeks later, in launchd, with nothing pointing back at the
upgrade. Pure JS runs under whatever pinned node is current. `npm install`
here must never produce a `.node` file or a `binding.gyp` in `node_modules`
(verified at install time).

## The log never carries row content

`lib/log.mjs` writes JSON lines to `~/.hazlie/logs/connectors.log`: counts,
ids, durations, error messages, schema facts — **never message bodies, mail
subjects, note content, transcript text, or contact names**. The corpus
boundary is hermes' database; a log line quoting a message re-creates the
corpus in a second file with none of hermes' deletion discipline. The logger
refuses a closed list of content-shaped field names (`text`, `body`,
`subject`, …) as a tripwire, but the policy binds everything the tripwire
cannot see — including `run_log.error` strings in state.db and every
`console.*` in this package.

## Hermes is the sole writer AND sole deleter

Connectors never open `context.db` — not read-only, not "just to check".
Writes go through `POST /ingest` (`lib/ingestClient.mjs`); deletion is
*requested* through the bearer-only `/admin/*` routes (`retain.mjs`,
`run.mjs --purge`). Reconciliation reads come back as **entity ids and
timestamps only** (`/admin/entities`) — corpus text never crosses into this
process. Local artifacts (cursors, caches, quarantine, contact map) are ours
and are deleted directly. Rules that ride the write path:

- always send `ts` on entity rows (a server-defaulted `ts` changes the
  content hash every delivery);
- **pre-sort semantically-unordered arrays in `meta`** (attendees,
  recipients, categories) — hermes canonicalizes object key order for the
  content hash but keeps array order, because it cannot know which arrays
  are sets; an unsorted attendee list reads as an edit on every delivery;
- never compute or send a content hash from this side; hermes computes it,
  and a second implementation would eventually disagree on serialization.

## Apple-store reads (lib/storeReader.mjs)

Never copy `db`/`-wal`/`-shm` as files — three separate copies are not
atomic and produce a torn database that opens fine and lies. Two sanctioned
modes only: `snapshotStore()` (SQLite Online Backup API — coherent against a
live writer) for infrequent bulk scans, and `openPersistentReader()`
(read-only connection; WAL gives per-transaction snapshot isolation) for
tight loops. Which consumer uses which is a **measured** decision recorded
per store in `ops/PROBES.md`; do not switch a consumer's mode without
re-measuring.

## Secrets discipline (lib/secrets.mjs)

Every secret is an owner-only (`0600`) regular file inside a `0700`
directory under `~/.hazlie/secrets/`, and every read replays the full check
set (lstat not stat, regular file, no group/other bits, owner uid, parent
exactly `0700`) — an `0600` file in a group-writable directory is not
owner-only. Secrets are read **at use time**, never cached across calls and
never copied into config, argv, or the environment of a child process.
Current inventory: `hermes-token.txt` (64-hex), `granola-api-key.txt`
(one line), `gmail-app-password.txt` (one line, not yet provisioned),
`oura-tokens.json` (OAuth2 access + refresh tokens, not yet provisioned —
JSON via `readSecretJson`), `notion-api-key.txt` (internal integration token,
one line). `config.json` is held to the same file standard
even though it is not a secret: it names what this daemon polls.

## Scheduling and failure isolation

One self-rescheduling `setTimeout` per source — never `setInterval`, which
fires on the clock regardless of whether the last run finished and would
race two runs of one source on the same cursor. A source failure is recorded
in `run_log` and the other sources keep running. `/admin/maintain` (blocking
VACUUM on hermes) runs only in the configured idle window (default 03:30).

## Backups: none, by default

State, caches, and cursors are deliberately not backed up — a backup is a
second unguarded copy of household-adjacent data, and everything here
re-ingests from its source of truth. An owner who wants one anyway should
encrypt it and treat it as another corpus copy.
