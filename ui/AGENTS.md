# Scope — the Hazlie assistant track

(Amended for the public tree: this file used to open with an Expo-versions
header and a scope exemption citing the root CLAUDE.md that governed the
diarization experiments. Neither the Expo app, the experiments, nor a root
CLAUDE.md/AGENTS.md is in this repository — they stayed on the private side —
so the rules that still bind are inlined below rather than cited.)

ui/ is a sanctioned separate track (the Hazlie assistant): its
local context server (server/hermes.mjs) and retrieval into the LLM prompt exist by
explicit owner direction — they satisfy the requirement that the interaction
layer query a locally served database of ingested context. Two hard
rules inherited from the diarization experiments still bind here: no speaker
enrollment or voiceprints (speaker labels
in the context DB are ingestion-supplied text, never audio-derived), and no
fabricated results.

## Where retrieval lives now — amended 2026-08-12

The exemption above still holds, but the retrieval it names **moved, and is
temporarily absent.** Owner-approved on 2026-08-12:

- `GET /search` and `GET /recent` are deleted, and `lib/context.mjs` with them. No
  browser code can request a context row.
  **Amended 2026-08-22.** This used to read "No HTTP route returns a context
  row", and that absolute is no longer true — `GET /admin/memory/pending`
  returns a quote so the owner can review a claim against the text it came
  from, which is the whole point of a review page. It is bearer-only, loopback,
  and deliberate. The real rule, stated so it is not overstated again: **no
  route returns a context row to a browser or to the courier**; exactly one
  bearer-only review route returns a quote, to the owner, about their own
  corpus.
- The Expo app's `askHazlie` (deleted with that app) had its `contextSnippets`
  parameter removed first: passing corpus text on a model call became a thrown
  error rather than a policy someone had to remember. The policy outlives the
  function.
- Retrieval returns server-side in the **sealed reader**, which owns the only
  database handle, holds no cloud credential, and returns **speech, not rows**.
  **Amended 2026-08-22 — read this before citing the line above.** The sealed
  reader was specified as `server/vault.mjs`. That file does not exist and was
  never written; the reader landed in-process as `handleVaultAsk` in
  `server/hermes.mjs`, served at `POST /vault/ask`. Five comments and two docs
  pointed at the missing file for weeks. Sharing hermes' single handle is
  correct — it IS the sole owner — but note the one property that did NOT
  survive the move: this text said "talks only to its **own** loopback
  llama-server", and there is one `llamaBaseUrl` for the whole process, so the
  ask path and the browser `/lane/local` lane reach the same server. Both are
  loopback and both are validated by `canonicalLoopbackBase`, so nothing leaves
  the box; the isolation that is missing is between the two lanes, not between
  the box and the network. Recorded as an open gap rather than quietly
  restated.

Between those two points the assistant had no memory. That was judged acceptable
because the context DB held **zero rows** when the change landed, so nothing was
lost in practice — and doing it before capture exists is far cheaper than doing it
after.

The rule that survives all of it, and that the sealed reader must not quietly
undo: **corpus text never rides a cloud request automatically.** Not as a setting,
not as an advanced flag. A toggle is a thing that gets removed when convenience
wins; not building one is stronger than defaulting one off.

## The cloud lane is not covered by this exemption

The exemption is scoped to "a locally served database of ingested context." It does
**not** contemplate outbound cloud egress with a stored provider credential and a
server-side tool loop. `POST /lane/cloud/...` currently answers 501 and the client
throws rather than falling back, so nothing has been widened yet.

**Get this exemption text updated before the first commit that opens a non-loopback
socket** — not after. Disagreements get flagged rather than routed around (a
convention this repo keeps from the private repo's root AGENTS.md), and a
provider key arriving without a recorded decision is
exactly that kind of silent routing-around.

## Egress policy — amended 2026-08-19, superseded 2026-08-22

**THE HOST LIST MOVED. `ops/EGRESS.json` is the only enumeration of what this
system can reach; `connectors/test/egress.test.mjs` fails the suite on any host
in tracked source that is missing from it.** Do not count paths here, or in any
other prose file — link the ledger instead.

Why it moved, recorded because the failure is instructive: this section used to
enumerate five paths and say "and no others", and the same claim was restated
longhand in eight more files. Between 2026-08-19 and 2026-08-22 the real host
set grew by `api.notion.com`, six chat platforms, two container registries and a
model host. Not one of the nine updated. The rule three paragraphs down — get
this text updated *before* the socket-opening commit — was broken at least four
times, and the widget ended up shipping a string asserting the exact opposite of
this document. A decision recorded in one prose file cannot propagate to eight
others, so the enumeration had to stop being prose.

What does NOT move is the claim itself, which is still stated here and stated
once:

**Hazlie sends no corpus data to a cloud model. All reasoning and narration happen
locally**, on loopback llama-server instances. That claim is much narrower than
"nothing leaves the Mac" — which is false, and must not be written anywhere.
Data leaves on every `api`, `bridge` and `login-webview` path in the ledger.
What does not leave is corpus text on a model call.

The five paths below were the 2026-08-19 set. They are kept **for their
reasoning, not as an inventory** — the caveats on Granola's upstream summaries
and the rationale for the Google Calendar path are load-bearing and are not
written down anywhere else. For what is reachable *today*, read the ledger.

1. **IMAP to the mail provider** (Gmail): fetching the owner's own mailbox down to
   this Mac. Content moves provider → Mac; nothing is sent to a third party.
2. **Granola's official REST API** (`public-api.granola.ai`): fetching back
   transcripts and summaries Granola already holds. Two honest caveats recorded
   with the approval: Granola's summaries are *cloud-produced upstream* — this
   connector does not make that worse, but it cannot make it better — and the MCP
   `query_*` tools run inference server-side and are **not** approved. REST
   endpoints only. (Granola's local cache is AES-encrypted with an
   entitlement-gated key; do not attempt to read it.)
3. **Oura's API** (`api.ouraring.com`, amended 2026-08-19 replacing the earlier
   Health Auto Export LAN path): fetching back the owner's own ring data, which
   Oura's cloud already holds by virtue of how the ring syncs. OAuth2 with an
   owner-registered app; tokens live in `~/.hazlie/secrets/`. With this change the
   connectors daemon is **fully loopback-only** — no process in this system listens
   on a non-loopback interface. HAE and a Shortcuts-push variant survive only as
   documented fallbacks in `ops/CONNECTORS.md`; building either would reintroduce a
   LAN listener and requires updating this list first.
4. **Apple's iMessage service**, for courier replies and digests sent through
   Messages.app. These messages transit Apple's servers and **sync to every device
   on the Apple ID** — a digest containing health and calendar derivations lands on
   all of them. The privacy boundary of this system is the Apple ID, not this Mac.
5. **Google Calendar API** (`oauth2.googleapis.com`, `www.googleapis.com`, amended
   2026-08-19): fetching back the owner's own calendar, which Google already holds.
   Read-only scope (`calendar.readonly`) — the connector cannot create, move or
   delete an event even if it tried. OAuth2 with an owner-registered Desktop client;
   tokens live in `~/.hazlie/secrets/` under the same rotation discipline as Oura.

   **Why this path exists, recorded so it is not relitigated:** the owner's calendar
   lives in Notion Calendar, which speaks to Google's API directly and never syncs
   into macOS Calendar.app. Measured on this seed 2026-08-19 — all three Google
   calendars registered in Calendar.app hold **zero** events, while the local
   calendars that do hold events stop at 2026-04-16. Reading the local store
   therefore cannot ever see the real calendar. The alternative considered and
   rejected was enabling Calendar.app sync: a second redundant sync path the owner
   does not use, which fails silently and would become a manual per-machine setup
   step on every deployed Mac Mini. Google also closed the cheaper door — basic-auth
   CalDAV ended 2025-03-14, so a Gmail app password cannot reach Calendar and OAuth
   is the only remaining mechanism.

Recorded rejections: **Sendblue** (would relay message content through a third
party's Mac farm from a number that isn't the owner's — fails the claim above three
ways). Cloud LLM calls carrying corpus data remain forbidden in all forms; the
cloud lane still answers 501.

The connectors track adds a top-level `connectors/` package (its own deps, its own
daemon) and a `courier` daemon for the iMessage lane. Hermes remains the sole
writer *and sole deleter* of the context DB; connectors write through `POST
/ingest` and request retention through bearer-only `/admin/*` routes. Courier never
holds a context-DB handle. Commands are accepted only from the pinned Messages
self-thread and only with an explicit `hz` / `hazlie:` prefix; content from any
other sender is data, never instructions.
