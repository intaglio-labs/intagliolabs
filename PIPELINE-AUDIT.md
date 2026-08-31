# Pipeline audit — ingest → segment → distill → summarise → people

Audited 2026-08-31 against the live stores (`~/.hazlie/context/context.db`,
`~/.hazlie/people/summaries.db`, `~/.hazlie/people/resolutions.db`,
`~/.hazlie/connectors/state.db`) and the working tree at `e6ca2ac`. Every number
below is a query I ran or a line I read. No message content, names or handles
appear anywhere in this document.

---

## 1. The answer to your question

**It is not "feeding a bunch of shit to an LLM and asking it to summarize" — but
two of the five stages are currently producing nothing that reaches you, and
they are the two that cost the most.**

The honest scorecard:

| Stage | Verdict | Evidence |
|---|---|---|
| **Ingest** (write path) | **Earns its keep.** Not theatre. | Zero duplicate content hashes across 454,352 rows; zero NULL `entity_id`; server-side hashing at `ui/server/hermes.mjs:1503`; upsert on `(source, entity_id)` at `:1589`. |
| **Ingest** (collection policy) | **Wrong, cheaply fixable.** | 14,497 calendar rows from 146 real birthdays (`select count(*), count(distinct json_extract(meta,'$.event_uid')) from context where source='calendar' and json_extract(meta,'$.calendar')='Birthdays'` → `14497\|146`). 4,125 photos rows are filename placeholders with OCR never run. |
| **Segmentation** | **Earns its keep, mostly.** Deterministic, reproducible, and the citation boundary holds. | A fresh rebuild of all 419,016 rows reproduced 37,006 episodes with 37,006 identical `member_hash` values, 0 drift. Zero claims cite a non-quotable row. |
| **Distillation** | **Expensive theatre today.** ~11 GPU-hours, 3,948 claims, **zero reachable**. | `select count(*) from claim_decision` → **0**. `select count(*) from v_claim_accepted` → **0**. `ui/server/memory/retrieve.mjs:51,97` read only that view. |
| **Summarisation** | **Real output, badly compressed, priced wrong.** | 116 person-year summaries over 226,863 messages — but the overview field is generic filler and the year pass throws away ~74% of the specifics the expensive leaf layer found. |
| **People layer** | **Broken at the commit, silently.** | `select count(*) from people` → **0**, while boot logs "4,253 people". The durable half of the projection has never committed. |
| **Relationship cards** | **Generating into a closed door.** | `select count(*) from rm_card_event` → **0** against 28 candidate snapshots. `hermes.mjs:2505` returns `{card:null, reason:'no-cap-configured'}` before touching a card. |

The single most important sentence in this report: **you have paid for roughly
25 GPU-hours of local inference, and the two stages that consumed ~90% of it
(distillation ~11 h, summarisation ~14 h) currently have no reader.** Distillation
you already caught and switched off yourself on 2026-08-27
(`widget/src/Distiller.swift:47-77`; `~/.hazlie/distill.enabled` does not exist,
confirmed). Summarisation is still running and nothing measures whether a
person-year page is ever opened.

What is genuinely *not* theatre, and is worth defending: the write path, the
episode index, the receipt/quotable boundary, the coverage accounting, the
deterministic abstention in `/vault/ask`, and the digest
(`ui/server/vault/digest.mjs:2` — "NO model is involved anywhere in this"). Several
of these exist specifically because a model was tried and lost. That is the right
instinct and this report does not ask you to reverse any of it.

---

## 2. Work backwards: what the outputs actually are

### 2a. Claims — 3,948 rows, 0 usable

```
select kind,count(*) from claim group by 1 order by 2 desc;
plan|3365   fact|260   constraint|159   preference|151   commitment|13
```

**85.2% are `plan`** — day-scale logistics. `prompts/distill_claims.md:47-52`
names exactly this class ("Being somewhere, arriving, meeting, running late and
turning up") as "the single most common way to get this task wrong". The store
already knows it: of the 1,275 claims the validity layer could date,
**1,274 have already expired** (`select sum(valid_to is not null), sum(valid_to is
not null and valid_to < strftime('%s','now')*1000) from claim` → `1275|1274`).

I read a 49-claim spread sample with full source rows. Roughly 30 of 49 were
meet-at-a-time / be-somewhere-later / leave-around-N. About 4 were durable.

**Seven claims are the prompt's own worked examples, stored as facts about you.**
Two assert a drug allergy at `p=0.95`, each sourced to a 5-character interjection;
the drug name appears nowhere in either episode. Three assert a standing weekly
medical appointment; that word appears in none of the three episodes. Two are the
prompt's travel-booking template, one carrying the prompt's literal example date.
All seven pass every check the codebase has, because every check is about the
*quote*: `distill.mjs:523` verifies the quote is an exact span, `:527` verifies
the text contains the word "owner". **Neither asks whether the quote has anything
to do with the claim.** The review UI (`connect/lib/memoryPage.mjs:173`) renders
claim-above-blockquote, and the quote is genuine, so the page looks correct. This
is the one failure class a human reviewer structurally cannot catch, and a stored
false allergy is the highest-stakes wrong claim this system can hold.

Two more measured defects in the same family:
- **411 claims (10.4%) share zero content words with their own cited quote.** Most
  are *not* fabrication — the model legitimately composes across episode lines,
  which is what episode mode is for. The defect is that `claim_source` holds
  exactly one row per claim (3,948 sources for 3,948 claims), so a claim assembled
  from three lines gets one receipt and the model often picks the wrong one. 66%
  of receipts are the entire source message (2,613 of 3,948), against the prompt's
  instruction at `:96` to pick the shortest supporting span.
- **44 claims (1.1%) attribute a third party's statement to you** — receipt has a
  third-person subject and no first-person marker. Because you *wrote* the row,
  `is_from_me=1` holds and the "owner" word check passes. `prompts/distill_claims.md:127-131`
  forbids exactly this.

**`p_claim` is functionally binary and cannot do the job it was added for:**

```
0.95|2031  0.85|1571  0.9|232  0.8|91  0.75|16  0.92|5  0.88|2
```

Seven values, 91.2% on two of them, nothing below 0.75 against a `REVIEW_FLOOR`
of 0.5 (`hermes.mjs:1983`) — so the floor excludes zero claims and the queue's
`ORDER BY p_claim DESC` degenerates to two buckets. Thresholding at 0.9 and at
0.86 keeps the identical 2,268 claims. `p` also does not track correctness here:
4 of the 7 prompt-leak claims and 16 of the 44 misattributions carry p=0.95. The
comment at `distill.mjs:39-48` is careful to say the Experiment A precision gain
was measured on another corpus and is not reproducible here — that caution was
warranted, and this closes the loop: **it did not transfer.**

**What is right about this stage:** integrity is stronger than most production
systems. Claims with no source row: 0. Sources pointing at a missing context row:
0. Quotes that are not a literal substring: 0. Content-hash drift: 0. Claims
citing a non-quotable row: 0. The 89% empty-run rate is *healthy selectivity*, not
waste — yield rises monotonically with owner-line count (4.0% at 1 line → 18.2%
at 31+), which is what correct abstention looks like.

### 2b. Summaries — 116 person-years, specific at the leaves, generic at the top

The `text` overview **fails a swap test**. 109 of 116 open with the same
grammatical construction (`select sum(text like 'The relationship%'), count(*) from summaries`
→ `109/116`); the top 5 openings cover 63 of 116. Mean 0.35 entity mentions per
overview; only 27% contain any. Pairwise content-word Jaccard: same-person mean
0.217 vs cross-person 0.154 — separation of only **1.41×**, and 20.6% of
cross-person pairs score at or above the *median* same-person pair. The highest
cross-person pair scored 0.529; I read that pair and they are functionally
interchangeable. The year prompt (`summary.mjs:379`) says "never name either
person", and the model satisfies it by adopting a universal subject, which
defeats the adjacent instruction to start with substance.

**Output width is set by `maxItems`, not by the evidence.** Across 115 summaries:
Recurring themes 97% at cap, Notable moments 96%, Communication pattern 97%, Open
loops 95%. **Zero summaries have an empty section anywhere**, across 115 year
passes and 1,254 leaf reductions. `summary.mjs:382` instructs "Omit any section
item without clear support"; `sectionsFromYear` (`:547`) filters empty arrays, so
abstention *would* be visible — it has never happened. A person-year with 68
messages and one with 19,345 both produce exactly 3 open loops.

**Compression is regressive.** Distinct entities at leaf level correlate with
volume (Pearson r=+0.556); at year level that collapses to r=+0.137, and
leaf→year survival is *negatively* correlated (r=-0.324). The funnel for the
three densest relationships: 19,345 msgs → 35 entities → 9 → 2 (3% survival);
11,767 → 62 → 18 → 5 (6%); 7,025 → 38 → 14 → 2 (3%). The month-consolidation hop
only fires for months with more than one chunk — i.e. only for dense
relationships — adding a third lossy hop exactly where evidence is richest (mean
survival 19.9% with the hop, 32.2% without). **The pipeline is least informative
about the people you talk to most.**

Two things that are genuinely good here. **Evidence accounting is exact**: chunk
counts match `coverage_json.chunks` in 115/115, `rows_seen` equals the summed
leaf-chunk messages in 115/115, and `sampleRows` (`:266`) is a no-op that returns
everything. I could not find any path where a summary claims volume it did not
read. And **entity-level hallucination is low**: 366 of 406 year-level entity
mentions trace to that person-year's own leaf chunks; excluding one
capitalisation artifact of my heuristic the true unsupported rate is ~0.5%.

Two mechanical defects. **169 of 1,254 leaf reductions (13.5%) are byte-identical
to a sibling** within the same person-year, in 72 groups — and an
adjacency-controlled test says this is a *batching* artifact, not thin evidence:
chronologically adjacent chunks are identical 9.3% of the time inside a batch vs
1.4% across a batch boundary. Duplicate groups are also *heavier* than average
(p50 270 messages vs 130), which rules out the benign explanation. And **36 of 131
month consolidations (27.5%) return one of their own parts verbatim**, discarding
the rest of the month, because the consolidation result *replaces* every part in
the year prompt (`:749`).

### 2c. Relationship cards — 28 generated, 0 ever displayed

`rm_card_event` → **0 rows**. `rm_mute` → 0. `rm_suppression` → 0. The card
endpoint short-circuits at `hermes.mjs:2505` because
`cfg?.relationshipMemory?.capPerDay` is absent — `~/.hazlie/connectors/config.json`
contains exactly one top-level key, `personRolesByYear`, verified. The widget has
polled that endpoint every 10 minutes (`widget/ui/widget.js:465-476`) and received
null every time for the life of the feature. The fail-closed gate is *correct*;
the problem is that it is silent, so Phase 1 generated candidates into a closed
door for two days and nothing reported it.

What the cards say, when they say anything: 26 of 28 carry one of two focus
phrases, 24 of 28 mention the same product noun, and all 28 match the same three
topics — the global top-3 of your last 45 days. The topical gate
(`topicScore >= 3`, `matcher.mjs:244`) therefore filters nobody. **The
differentiating content on a card is the counted-facts line, not the model's
sentence.** And the counted facts are real and unavailable anywhere else: the
calendar-attendee → contacts-spine join (`matcher.mjs:127-163`) surfaces people
with three-figure shared meetings last attended years ago. **If you cut anything
here, cut the writer and keep the arithmetic.**

Also: run-to-run instability makes the rules-version join key unsound. Four
batches ran inside 21 minutes on the same corpus; batch 3 and batch 4 overlap in
2 of 6 people, 7 of 8 repeat people got a different model-written role, 7 of 8 a
different sentence, 5 of 8 a different supporting quote. `rm-match-v13` denotes a
distribution, not a function.

---

## 3. The pipeline, stage by stage

### Ingest — `connectors/` → `/ingest` → `context.db`

**454,352 rows.** By source: imessage 415,795 · calendar 21,587 · instagram 5,714
· photos 4,125 · whatsapp 3,190 · files 1,777 · discord 1,310 · twitter 416 ·
messenger 386 · notes 31 · linkedin 21.

*Cost:* negligible model cost (zero — no LLM in this path). *Returns:* the
corpus everything else reads.

The **write path is correct and needs no work**: zero duplicate content hashes,
zero NULL entity_ids, hash computed server-side only (`hermes.mjs:1503`), closed
field set (`:1467`), upsert matched on `(source, entity_id)` (`:1589`),
iMessage self-echo dedup at `connectors/lib/imessageRows.mjs:42-60`. Re-runs and
backfills upsert cleanly and `store_changed_at` only moves on real change.

The **collection policy is where the problems are**:

- **14,497 birthday rows from 146 facts (3.2% of the whole corpus).** A
  yearly-recurring all-day event is expanded to one context row per occurrence,
  and `connectors/sources/calendar.mjs:66` sets `HISTORY_FLOOR_TS` to
  1900-01-01, so the walker generates 146 rows/year for 127 years. 59% of all
  calendar rows predate 2015. This is more rows than whatsapp + files + discord +
  twitter + messenger + notes + linkedin combined.
- **All 4,125 photos rows are filename placeholders.** `has_text` is NULL on every
  one; the text column is `(photo IMG_xxxx.HEIC)`. `episodic.mjs:305` already
  skips them ("a filename snippet says nothing"). The one field with signal —
  lat/lng on 3,268 rows — lives in `meta` and is invisible to FTS, defeating the
  module's own stated use case.
- **1,777 files rows indexed without opening any file.** Zero rows have
  `has_content=true`, including the five whose bytes were local — so
  `lib/fileText.mjs` has never successfully run.
- **WhatsApp has failed 460 of 483 runs** and is still scheduled every cycle
  (`ENOENT` on a store that does not exist on this machine;
  `connectors/sources/whatsapp.mjs:46`). iMessage has failed 112 of 693 — a 16%
  failure rate on the source that is 91.5% of the corpus, which means silent gaps.
- **`run_log.ingested` reports 1,208,719 phantom rows from `contacts`**, which
  writes zero context rows (`connectors/sources/contacts.mjs:381-384` says so
  deliberately). It is the largest apparent ingester in the operational log and
  contributes nothing to the corpus. Anyone reading `run_log` to answer "what is
  filling this thing" gets a wrong answer by an order of magnitude.
- **No retention is configured.** `connectors/retain.mjs:87` iterates only sources
  the config names; the config names none. All the machinery exists — per-source
  `keep_days`, cascading claim deletion, FTS tombstoning — and none of it is on.
- **35,336 rows (7.8%) are structurally excluded from the memory layer**
  (`episodeStore.mjs:17` limits episodes to imessage/whatsapp/notes). The
  justification is that the people graph reads them as handles and counts. **That
  graph has zero rows** (`select count(*) from people` → 0). So the most complex
  ingestion path in the repo — 608 lines of matrix connector plus a Synapse
  instance and nine bridge processes — feeds a table nothing reads.
- **Four of twelve source modules have never run** (mail, granola, notion, oura —
  absent from all 4,385 `run_log` entries), yet `ui/server/vault/digest.mjs:219-283`
  reads granola and health rows for its output.

### Segmentation — context rows → `context_thread` → `episode`/`episode_member`

**37,006 episodes, 360,587 members, 169,909 of them owner-authored.**

*Cost:* 600 ms for a full rebuild. Free. *Returns:* the batching unit and the
citation boundary.

**This is the strongest stage.** A fresh `buildEpisodes` over all 419,016 rows
reproduced 37,006 episodes with 37,006 identical `member_hash` values, 0
fresh-only, 0 store-only, and a shuffled input with a different `now` produced the
identical hash set. The rule is pure, `built_by` is enforced by a CHECK
constraint, and the incremental hazard is genuinely closed (`content_hash` covers
meta, so a rewritten thread key takes the UPDATE branch and bumps
`store_changed_at`, which the cursor at `episodeStore.mjs:217-225` sees). Cache
churn is 0.87%. **The citation boundary holds absolutely**: zero of 3,948 claims
cite a non-quotable row, and `hermes.mjs:2213,2233-2234` resolves line→context_id
server-side rather than trusting the caller.

Three real problems:

1. **The distiller runs with episode context suppressed, so 53% of
   `episode_member` has no reader.** `select coalesce(episode_context,'NULL'),
   count(*) from distill_run group by 1` → `NULL|17`, `off|36609`. **No run has
   ever used `on`.** With context off, `renderEpisode` (`distill.mjs:444`) emits
   only `quotable=1` lines — so you pay to key, group, hash and store **190,678
   non-owner rows** and then show the model your half of the conversation with the
   other half removed. That is precisely the failure the episode design was
   written to fix (`distill.mjs:318-327`). The A/B arm was built, indexed
   (`distill_run_arm`) and never run once. `rows_in` also records `lines.length`
   rather than rendered lines (`ui/scripts/distill-episodes.mjs:251`), so the
   354,740 figure overstates what the model read by ~2×, and that number is what
   the owner-facing progress display shows.
2. **The 60-minute gap's stated justification does not reproduce on this corpus.**
   `episodes.mjs:7-10` calls it "a boundary rather than a preference", citing a
   sharply bimodal distribution with a 30–120 minute plateau. Measured over
   415,471 consecutive in-thread pairs: (30,60m] = 3.00%, (60,120m] = 2.70% —
   **flat, no trough anywhere in the window**. 8,482 multi-row episodes (27.8%)
   holding 138,164 members are held together only by a 30–60 minute silence.
   Moving 60→30 adds 15% more episodes; 60→120 removes 15%. That is a live tuning
   knob presented in source as settled empiricism, and it propagates directly into
   the relationship matcher's `topicScore`.
3. **8,583 episodes (23%) are orphaned from a person the thread already
   identifies.** `counterpartyFor` (`episodeStore.mjs:68-80`) walks the episode's
   own members and returns null when the handle set isn't exactly 1 — so a 1:1
   thread whose person resolves in 40 other episodes yields NULL for any window in
   which only you spoke. All 8,583 are monologues. The bias is not random: it
   removes exactly the unanswered-message episodes, which is what a reconnect
   matcher most wants. `counterparty_key` is consistent within every thread that
   resolves at all (0 threads carry two different keys), so inheriting the
   thread's key is safe.

One measurement that cuts against the batching premise: **claim yield per owner
line falls 4.5× as episodes get larger** (1 line → 4.14%; 2-3 → 4.30%; 4-8 →
2.33%; 9-20 → 1.90%; 21+ → 0.91%). The 21+ bucket holds 25% of owner lines and
produced 10% of claims. The cap is not the mechanism (1,136 episodes × 8 would
allow 9,088; only 395 were emitted). I cannot separate this from a real confound —
long chats may genuinely be chit-chat — but nobody has measured it, and the
direction is against the premise that grouping helps extraction. Batching *did*
cut LLM calls 4.6× (169,909 owner rows → 36,626 runs), so it is a genuine cost
win; the open question is whether it costs recall.

And a note on whether the gap rule is worth it at all: **a naive (thread ×
calendar day) split gives the same unit for 40% fewer LLM calls** — 22,241 units
covering 385,532 rows versus 37,006 episodes covering 360,587. 98.3% of episodes
lie wholly inside one calendar day, and for 59.3% of thread-days the gap rule
produces exactly one episode, buying nothing. You are already running both units
simultaneously: `approximateConversationKey` (`episodes.mjs:85-97`) is the
fallback for 66,276 rows in the people tallies, which **double-counts 8,436
thread-days** where both an episode id and a day key appear in the same Set
(`ui/server/people/content.mjs:207`, `topics.mjs:390-398`).

### Distillation — episodes → claims

*Cost:* **~11.0 GPU-hours**, 36,626 runs, 3,436,593 prompt tokens, 554,669
generated. *Returns:* 3,948 claims, **0 reachable.**

91.7% of runs (33,578) returned zero claims, consuming ~62% of the measured
inference time. As noted above, the empty rate itself is correct behaviour. The
problems are the ones in §2a plus:

- **Every one of the 40,577 cached answers is dead.** The cache key is
  `${promptSha.slice(0,16)}/${model}/${contentHash}` (`distill.mjs:92`). The
  shipped prompt hashes to `a3b6442bb2430be7`; the four cache directories are
  `b91f008a`, `77d9d806`, `b362b857`, `b55587cb`. **None match.** 159 MB of quoted
  private text is sitting in directories nothing will ever read again, and a
  prompt edit is a full 11-hour corpus re-read. That has already happened four
  times.
- **A one-line deterministic gate removes 32.6% of calls for 4.0% of claims.**
  Bucketing every run by total quotable characters in its episode:

  | owner chars | runs | claims | claims/run |
  |---|---|---|---|
  | <40 | 11,935 | 157 | 0.0132 |
  | 40–99 | 10,583 | 744 | 0.0703 |
  | 100–299 | 9,984 | 1,497 | 0.1499 |
  | ≥300 | 4,037 | 1,470 | 0.3641 |

  27.6× yield spread. A `SUM(LENGTH(text)) WHERE quotable=1 < 40` predicate in the
  pending query (`distill-episodes.mjs:148-160`) drops 11,935 calls at a cost of
  157 claims. Not free — but it is a *measured* trade, which is more than
  "send everything" has.
- **59 episodes were re-run by concurrent passes**, leaving 7 exact-duplicate
  claims that are permanently unremovable (`claim` is append-only with no-update
  and no-replace triggers). Cause is a check-then-act gap: the pending list is
  computed once up front and the `NOT EXISTS` guard cannot see an unwritten
  concurrent run.
- **6.5% of claims are duplicates or near-duplicates** (95 groups covering 258
  claims; largest group is one meet-at-a-time sentence ×21). BM25 in
  `retrieve.mjs:96` would score 21 copies of a non-fact above one real one.
- **39 claims were distilled from an iOS driving auto-reply** — 11 of them stored
  as `constraint`, the kind that means a standing rule about what you can do. The
  ownership boundary is enforced on metadata, and metadata cannot distinguish a
  person from their phone.

### Summarisation — rows → chunks → batches → year

*Cost:* **13.81 GPU-hours** over 51,301 s wall, **96.9% GPU-busy**. 6,231,606
prompt tokens at 233 tok/s + 466,719 generated at 20.3 tok/s across 808 calls.
*Returns:* 116 person-year summaries — 37,373 bytes of overview prose plus 151,017
bytes of section JSON, over 226,863 messages.

**428 GPU-seconds per summary.** Whether an ≤900-char overview plus five bullet
lists is worth that is your call; the cost side is now exact.

**There is no multi-hop re-read** — this is the thing I went looking for and did
not find. Unique evidence is ~5.11M tokens; actual evidence-bearing prompt tokens
were 5,677,858. **Redundancy 1.11×.** The reduce hops consume reduction JSON
(1,259,032 bytes total), not messages. 877 of 1,013 person-months (86.6%) are a
single chunk and bypass the middle hop entirely (`summary.mjs:702-704`). The
annual prompt is provably bounded by construction: `boundedString`/`boundedStrings`
(`:110-116`) cap every field before it reaches `yearPrompt`, and consolidation
guarantees ≤12 records. The `MIN_ROWS=10`/`MIN_SUBSTANTIVE_ROWS=3` guard fires
before any model call.

So the architecture is sound. The waste is in three tunable parameters — see §4.

**No groundedness check exists anywhere.** All six abstention paths are "unknown
person" (`:566`), "thin input" (`:572`), or "the JSON didn't parse" (`:677, :685,
:735, :776`). A grep for `verify|unsupported|confidence|abstain|citation|
provenance|groundedness` over `summary.mjs` returns two hits, both inside prompt
strings. All 16 tests in `ui/test/people-summary.test.mjs` assert plumbing,
privacy, caching or coverage — none asserts anything about support. Note the
contrast with the identity layer next door, which attaches typed evidence and
confidence to every derived link (`graph.mjs:707-724`): the project knows how to
do this and does not do it here.

One UI honesty problem: `widget/ui/people-months.js:189-192` renders
"all N direct messages". `coverage.messages` is `rows.length` computed before any
model call — a *process* guarantee presented as an *evidence* guarantee. Given
that 11.5% of summarised messages currently contribute only a byte-copy of another
chunk's reduction, "all N" is true of the intake and not of the output. (The
intake number is itself honest: 0 rows have a ts `chunkRows` would drop, and only
5 messages exceed `MAX_MESSAGE_CHARS`.)

### People layer — projection, identity, ranking

*Cost:* ~10 s of full two-pass corpus rebuild **on every boot**, during which
hermes answers nothing (node:sqlite is synchronous). *Returns:* an in-memory graph
that works, and a durable projection that has never once committed.

**`select count(*) from people` → 0.** Same for `person_identifiers`,
`identity_evidence`, `person_event_links`, `person_channels`, `person_activity`,
`person_active_days`. `people_projection_state` reads
`source_revision=4259, projected_revision=-1, people_count=0, built_at=NULL`, while
the boot log says "people core warm in 6295ms (4253 people)". The only way both
can be true is that `replaceProjection` (`projection.mjs:471-500`) threw and rolled
back — and the exception is swallowed by the bare `catch {}` at
`projection.mjs:657`, which returns the correct raw answer with no signal that the
durable half failed. **No log line, no counter, no health check.** The two numbers
have disagreed for at least a day and nothing notices.

The likely mechanism, which I could not execute to confirm (copying the DB to a
scratch dir was sandbox-blocked): `rawKeyForId` (`graph.mjs:619-629`) derives the
key from the *name* on the row as well as the identifier, so one identifier can be
claimed by two person keys. Measured: 2 calendar attendee addresses and 14 chat
handles appear under both a name-derived key and an id-derived key.
`person_identifiers.identifier` is a global PRIMARY KEY (`projection.mjs:52-56`)
inserted with a plain INSERT (`:444-446`).

Downstream consequence: **deep people search is permanently returning a
"temporary" failure message.** `generalSearch.mjs:701` calls
`refreshPeopleProjection` with no fallback, `retrieveRows` sources 100% of its
evidence from `person_event_links` (0 rows), and `:1180-1188` catches and returns
"try again in a moment". Retrying cannot help. It also spends a planning model call
at `:1164` *before* failing.

Three more things worth knowing about the numbers this layer reports:

- **"~4,140 people" is the in-memory graph, and about half of it is calendar
  invite lists.** 2,341 distinct calendar attendee emails, 1,440 of which (61.5%)
  appear in exactly one event, and only 104 of which appear on any contact card.
  ~2,237 graph people have no message channel at all.
- **"Met in person" is really "was on an invite list".** `graph.mjs:774` increments
  `metInPerson` for every calendar signal regardless of role, and
  `graph.mjs:397-399` adds declined attendees. 1,421 of 2,341 attendee addresses
  (60.7%) never accepted anything. Recurring series are expanded per occurrence —
  104 event_uids have 127 rows each — so one weekly meeting manufactures 127
  "meetings" with everyone on the invite. Max for a single address: 459.
- **The People page order is roughly two-thirds recurring-calendar artifact.**
  `engagement = messages + 3*met + 1*meetingNotes` (`map.mjs:471`), with `met`
  uncapped. Reconstructing the 2026 ranking: top 25 = 15 calendar vs 10 message;
  top 100 = 77 vs 23. From about rank 10 downward the page is ordered by
  invite frequency, which matches the complaint already quoted at `map.mjs:141`
  that an earlier fix was meant to address.
- **Cross-platform merging effectively does not happen: ~70 people.** Exactly 70
  contact cards bridge a calendar email to an iMessage handle; the exact-name rule
  adds 8 more; loose phone normalisation adds **zero** (799 handles hit the spine
  exactly, 799 after normalisation). The address-book machinery is correct and
  works — it just only reaches the ~1,216 people the address book knows.
  Thin by headcount, **good by volume**: those 799 known handles carry 265,418 of
  284,728 handle-attributed messages (93%).
- **The owner-resolution layer has never been used.** `select count(*) from
  person_resolution` → **0**. The candidate detector, nickname table,
  personal-domain signal, union-find and SHA-256 alias fingerprinting have never
  changed an answer on this corpus. That is the clearest case of unpaid-for
  engineering in the layer.

Finally: **routine entity reconciliation nukes the whole projection.** Deleting 7
stale calendar events calls `clearPeopleProjection` (`hermes.mjs:2833`), which
drops every projection table and resets `projected_revision` to -1. The privacy
reasoning is sound; the blast radius is the whole table. Masked today because the
projection is broken anyway; it becomes the next bottleneck once the write is
fixed.

---

## 4. Why 12 contacts took overnight

The arithmetic, in full.

**It was not 12 contacts. It was 123 person-year jobs.**

`generated_ms` is fixed per `summarizeYear` call (`summary.mjs:559`), so its
distinct values are jobs: `select count(distinct generated_ms) from summary_chunks`
→ **123**. That is 12 people × ~10 years (2017–2026), which is exactly
`WARM_AHEAD = 12` (`summary.mjs:212`) fired once per year-page open. Opening ten
year pages enqueued ten waves of twelve.

**Wall clock:** `select datetime(min(generated_ms)/1000,...), datetime(max(...))
from summary_chunks` → 2026-08-30 09:11:35 → 2026-08-31 04:07:17. The contiguous
dense run is **51,301 s = 14 h 15 m**.

**It was 96.9% GPU-busy — there is no idle time to reclaim.** Parsing every
`print_timing` line in `~/.hazlie/logs/llama-server.err.log` over that window: 808
calls, 6,231,606 prompt tokens in 26,700 s (233 tok/s), 466,719 generated tokens in
23,028 s (20.3 tok/s). GPU busy = 49,728 s = 13.81 h.

**Where the time went**, bucketed by prompt size:

| prompt bucket | calls | prompt tok | gen tok | GPU-h |
|---|---|---|---|---|
| ≥20k | 107 | 2,669,123 | 130,660 | **5.80** |
| 10–20k | 101 | 1,456,891 | 108,181 | **3.22** |
| 4–10k | 215 | 1,551,844 | 111,937 | **2.96** |
| 1–4k | 210 | 458,221 | 73,322 | 1.26 |
| <1k | 175 | 95,527 | 42,619 | 0.57 |

The ≥4k buckets are the raw-message chunk reductions — nothing else in this
pipeline sends a 4k+ prompt. **423 calls, 11.98 GPU-hours = 86.8% of the run.**
The reduce hops (month consolidation + annual synthesis) are the <4k buckets:
1.83 GPU-hours, **13.2%**.

**Now the three multipliers, in order of size.**

### (a) It was a cold rebuild, caused by a one-line prompt edit — 14× overspend

`SUMMARY_REVISION` is a single constant (`summary.mjs:50`) that gates **all three
stages identically**: the chunk cache (`:604`), the month consolidation (`:718`),
and the annual cache (`:584`). It went 4→5 in commit `56401f6` on 2026-08-29 20:02
— the night before. Confirmed in the store: `select code_rev,count(*) from
summary_chunks group by 1` → `5|1385`, a single lockstep generation.

`git show 1900838` (the rev 3→4 bump, 2026-08-27) changed **exactly one prompt
string** — the annual instruction, adding a phrasing constraint. That edit cannot
alter a single chunk reduction. It invalidated every one of them, which is 86.8%
of the pipeline's cost.

Under stage-scoped revisions that same edit costs 116 annual passes at ~31 s each
(~3,800 prompt tokens at 318 tok/s = 12 s, plus ~450 generated at 23.5 tok/s =
19 s): **116 × 31 s = 60 minutes instead of 14 h 15 m.** A **14× saving** on a
one-line prompt tweak, which is exactly the kind of change you make most often.

For completeness, the other three bumps were legitimate — rev 2 (rooms excluded)
and rev 3 (bridged sources added) both change `gatherRows`; rev 5 introduced
chunking. **1 of 4 bumps was pure waste**, and nothing in the code prevents the
next one.

### (b) The 80,000-char batch is a net loss — 1.9 hours

`BATCH_CHAR_CAP = 80_000` / `BATCH_ITEM_CAP = 4` (`summary.mjs:44-45`), justified
in the comment as "removes most per-request latency". **On a local single-slot
server there is no per-request latency worth removing** — the log shows inter-task
gaps of 20–90 ms. The optimisation was reasoning about a remote API.

Meanwhile both throughput curves degrade monotonically with prompt size, and they
compound:

| prompt size | prompt tok/s | | prompt bucket | gen tok/s |
|---|---|---|---|---|
| 1–2k | **326** | | <1k | **24.5** |
| 4–8k | 293 | | 4–10k | 21.6 |
| 12–16k | 244 | | 10–20k | 19.6 |
| 20–24k | 209 | | ≥20k | **17.5** |
| 24–28k | 194 | | | |
| 28–40k | **186** | | | |

Measured on the batched path: the ≥20k bucket spent 20,887 GPU-s on 107 calls; at
4 items that is 428 chunks = **48.8 s/chunk**.

Counterfactual from this server's own rates. A single chunk averages 4,620
evidence tokens (5,677,858 ÷ 1,229) plus ~200 preamble, and generates 285 tokens:
- prompt 4,820 ÷ 293 = 16.5 s
- gen 285 ÷ 21.6 = 13.2 s
- **= 29.7 s/chunk**, versus 48.8 measured. **A 1.65× penalty.**

Across the evidence stage: 11.98 GPU-h → **10.07 GPU-h. Batching cost 1.9 hours
(16% of the run)** to save 423 round trips and ~85k tokens of repeated preamble.

The cap also creates a live risk: it counts **characters** while context is
measured in **tokens**. The largest prompt in the log is 31,650 tokens against
`--ctx-size 32768`, with `maxTokens: 520 × items` = 2,080 requested on top. That
cannot fit. The 400/413/422 fallback (`:645-648`) catches it and re-runs each
chunk individually, **paying for the same evidence twice**. I found no such
failures in this run, but the margin is **3.4%**.

Separately, the packer is running at **2.62 of 4 items** (478 calls ≥3k tokens
produced 1,254 reductions) because 80,000 ÷ 24,000 = 3.33 — a full-size chunk can
never batch 4. And nothing counts how often the fallback fires, so the 164-call
gap between 314 (ideal) and 478 (actual) cannot be attributed.

### (c) The prompt cache achieved essentially zero reuse — 476 GiB churned

768 `making room for prompt cache entry, removing oldest entry` lines in the run
window, totalling **487,674 MiB = 476 GiB evicted**, largest single entry 2,448
MiB (which matches 32K of q8_0 KV exactly, per the plist's own note at `:38-40`).
Of the 20 slot selections that reported an LCP similarity at all, median 0.118 in
the first segment and 0.226 in the second.

**Every summary prompt is unique evidence.** The only shared prefix is ~150 tokens
of system message. So each ~28k-token call builds a ~2 GB KV entry that will never
be hit again, and immediately evicts the previous one — 0.95 evictions per call,
635 MiB average. **There is no prompt-cache reuse to be had at any batch size, and
there never will be for this workload.** A smaller batch wins for the throughput
reason above, and wins *additionally* here because a 5k-token KV entry is ~400 MB
cheaper to build and discard.

### (d) `--ubatch-size 128` — undocumented, and I did not measure the alternative

`ops/io.intaglio.llama-server.plist:91-94` sets `--batch-size 512`,
`--ubatch-size 128`. llama.cpp's default physical micro-batch is 512. The comment
block at `:12-48` documents every other flag with a rationale and a probe date —
`batch-size`, `ubatch-size` and `parallel` appear in `ProgramArguments` and
nowhere in the comment.

Prompt processing is 53.7% of the run, and the measured ceiling on this box is 326
tok/s at 1–2k tokens, never higher at any size (n=808). That is low for an 8B
Q4_K_M on this hardware. At `ubatch 128` the Metal backend issues four times as
many smaller matmuls per prompt, which is the classic signature.

**I did not measure the counterfactual and will not claim a number.** Changing the
flag means restarting a live service, which is outside a read-only audit. What I
can say: the flag is a quarter of the default, it governs the stage consuming over
half the run, and whoever set it left no record of having measured it. If
`--ubatch-size 512` gives even 2× on prompt eval, **that removes 3.7 hours** —
more than every other fix here combined.

### (e) 250 of 252 model-load failures fell inside this window

`grep 'srv load_model: failed to load model'` → 252 occurrences, 250 in the final
decile of the log — the same decile holding all the big-prompt calls. Error:
`common_fit_params: encountered an error while trying to fit params to free device
memory`. 340 boot attempts, 88 successful — **74% failing**. With `KeepAlive=true`
and `ThrottleInterval=60`, that is **≥4 hours of the model tier being unavailable**
during the exact window you were waiting on summaries, reading to you as "the app
is slow" with nothing naming the cause. I did not prove causation between the big
batches and the crashes, but the concentration is not subtle.

### The blast radius is already capped — three hours after the run ended

Commit `1f3ae73` (2026-08-31 07:28:36) adds `pickWarmSet` with
`WARM_AHEAD=12`, `WARM_PERSON_CHUNK_CAP=4`, `WARM_CHUNK_BUDGET=12`
(`summary.mjs:212-232`). The run ended 04:07:17. **Before that commit**, opening a
year page enqueued every eligible person for a full hierarchical summary — ten
opens produced the 123 jobs. **After it**, one page open costs at most 12 chunks
plus the annual passes that fit: ~16 minutes on AC, zero on battery. With the
batch fix, ~12 minutes.

**So the number to judge is 12–16 minutes per page open, not 14 hours.** The 14
hours was a one-time cold rebuild of a decade of history, triggered by a revision
bump, under a warmer that had no budget. All three of those conditions are now
either fixed or fixable.

What `1f3ae73` does *not* fix: **nothing re-warms when new messages arrive**, only
when a page is opened.

---

## 5. The incremental design

**Incrementality already works.** Your instinct — "at least it should be
incremental" — describes code that exists. What did not exist was any reason for
the cache to be warm, because rev 5 landed the night before.

### What one new message costs today

Tracing `summary.mjs` with a warm cache, for a message arriving for person P in
month M of year Y:

| step | cost |
|---|---|
| `gatherRows` re-reads the whole year | **119 ms** measured (88 ms SQL + 31 ms JSON.parse over 51,890 rows of 2025). Negligible. |
| `chunkRows` re-chunks | Months ≠ M keep identical row lists → identical fingerprints → **cached, zero model calls** |
| Month M's affected chunk | **1 reduction ≈ 29.7 s** |
| Month M consolidation | Only if M has >1 chunk — **13.4% of months** — **+~21 s** |
| Annual pass | Always. **+~31 s** |

**Common case ≈ 61 s. Multi-chunk month ≈ 82 s. Full rebuild = 51,301 s → 841×
cheaper.**

Confirmed live: person-year 2026 has three distinct `generated_ms`; the middle run
wrote **exactly one chunk** and reused six others. The month partition also bounds
the worst case — a message inserted mid-month cascades only within that month
(measured over 22 insertion positions: median 3 of 11 chunks stale, max 5, never
crossing a month boundary).

### What in the schema blocks it going further

1. **`chunk_index` is positional and packing is greedy from the month's start**
   (schema `:492-495`, packing `:251-259`). A backfill, a WhatsApp history sync, or
   an edited row inserted mid-month re-fingerprints every subsequent chunk in that
   month. 86.6% of months are a single chunk so the common case is safe, but the
   worst measured month holds **14 chunks** — a head-insertion there costs
   14 × 29.7 + 21 + 31 = **468 s (7.8 min)** instead of 61 s.
2. **The fingerprint hashes the row objects, not the prompt.**
   `hash({revision, rows: chunk.rows})` (`:598`) covers `{ts, source, fromMe, text}`
   in full, but the prompt only uses `rowLine` (`:165`), which renders `ts` as
   `MM-DD` and truncates text at 6,000 chars. **A timestamp correction within the
   same day invalidates a chunk whose prompt bytes are identical.**
3. **No row identity is stored.** `summary_chunks` records `messages` (a count) but
   not *which* `context.id` values it covered. So nothing can ask "which chunks
   does this new row touch?" — invalidation cannot be driven from the ingest side.
   Which matters, because **`context.db` already emits exactly that signal**: the
   `people_context_dirty_ai/au/ad` triggers populate `people_projection_dirty` on
   every insert. Nothing in `ui/server/people/` reads it for summaries.
4. **The annual pass is unconditional.** `evidenceHash` covers every row (`:577`),
   so a message that changes one chunk's evidence but not its reduction still costs
   the 31-second annual call.

### The changes, in order

1. **Split `SUMMARY_REVISION` into `CHUNK_REVISION` / `CONSOLIDATION_REVISION` /
   `ANNUAL_REVISION`.** Use each at its own fingerprint and gate (`:598`/`:604`,
   `:710`/`:718`, `:577`/`:584`). Comment each with what changes it. Add a test
   asserting the chunk revision is unchanged when only `yearPrompt` moved. **This
   is the 14× fix and it is the single highest-value change in this report.**
2. **Fingerprint the prompt, not the rows:**
   `hash({ revision: CHUNK_REVISION, lines: chunk.rows.map(rowLine) })`. One line.
   Removes false invalidations and makes the fingerprint mean "this exact prompt
   was answered".
3. **Set `BATCH_ITEM_CAP = 1`** (or delete `packChunkBatches` and `BATCH_SCHEMA`
   entirely — the single-chunk path at `:661-676` is already the correctness
   fallback and becomes the only path). Recovers 1.9 h/rebuild, kills the 13.5%
   duplicate-reduction defect, and removes the 3.4% context-overflow margin. If you
   keep batching, cap on **estimated tokens** (chars ÷ 2.8) with headroom for
   `520 × items`, not on chars.
4. **Content-address chunk identity.** Make the fingerprint the identity —
   `PRIMARY KEY (person_key, year, month, fingerprint)` — and let `chunk_index` be a
   plain ordering column. Then a shifted boundary that reproduces an earlier
   chunk's contents still hits. For the 14-chunk month, close chunks on a
   content-defined boundary (hash of the line, or the existing `SESSION_GAP_MS` at
   `:46`) subject to the current caps, so an insertion perturbs one or two chunks.
5. **Fingerprint the annual pass**: store `hash({ANNUAL_REVISION, coverage,
   reductions})` on the `summaries` row and skip `:774` when it matches.
6. **Wire ingest to invalidation.** Add `context_ids` (or a min/max id range) to
   `summary_chunks`, and have the connector drain `people_projection_dirty` into a
   set of `(person_key, year)` pairs to re-warm. **This converts summaries from
   "recomputed when someone opens a page" to "recomputed when the data moved",
   which is the thing you are actually asking for.**

### One thing not to optimise

**No work is shared between two people, and none can be.** `gatherRows` at
`summary.mjs:283` skips group threads, and `:285` keeps only rows mapping to this
`person_key`, so two people never share a message. Same between years — chunks are
`(year, month)` and a month belongs to one year. This is not a lost optimisation;
it is a design decision with no cost attached. The one genuinely repeated read is
`gatherRows` scanning the year per person: **119 ms, ~1.4 s per page, ~15 s across
the entire 14-hour run.** Do not spend a day on it.

---

## 6. Ranked recommendations

### A. This is wrong (correctness / safety)

| # | Fix | Evidence | Size |
|---|---|---|---|
| **A1** | **Quarantine the 7 prompt-leak claims and add a support check.** Reject any claim whose content words + digits have zero overlap with its cited line AND with every quotable line in the episode. Strip concrete nouns from the prompt's worked examples, or move them into few-shot turns. | 7 claims verified to contain terms absent from their entire episode, incl. a false medical fact at p=0.95. `distill.mjs:523,527` check only the quote. Zero-overlap set: 411 claims. | **S** (a pure function + a `claim_decision('reject')` per id — `claim` is append-only, rejection is the only removal path) |
| **A2** | **Log the projection exception and surface staleness in `/health`.** Assert `people_projection_state.people_count` matches the graph length after a warm. | `select count(*) from people` → 0 with `projected_revision=-1`, against a boot log of 4,253. Swallowed at `projection.mjs:657`. | **S** |
| **A3** | **Make identifier→key a pure function of the identifier**, resolved once per identifier before assignment. | `graph.mjs:619-629` derives the key from the row's name; 16 identifiers measured under two keys; `person_identifiers.identifier` is a global PK (`projection.mjs:52-56`). Likely the cause of A2. | **M** |
| **A4** | **Drop third-person claims.** If the cited quote has a third-person subject pronoun and no first-person marker, reject. | 44 claims (1.1%); 16 at p=0.95. Forbidden at `prompts/distill_claims.md:127-131`. No false positive among the 15 I read. | **S** |
| **A5** | **Reject batch responses whose reductions are not pairwise distinct**; fall back to the per-chunk path (the retry loop at `:664-679` already exists). Add a `via TEXT` column recording 'batch' vs 'solo'. | 169 of 1,254 reductions byte-identical to a sibling; 9.3% in-batch vs 1.4% cross-batch; duplicate groups are *heavier* than average (p50 270 vs 130 messages). | **S** |
| **A6** | **Compare each month consolidation against its inputs**; if it equals any single part, retry once or concatenate-and-dedupe locally (no model needed). | 36 of 131 consolidations (27.5%) are a verbatim copy of one part, and the result *replaces* all parts at `:749`. | **S** |
| **A7** | **Count a calendar signal as "met" only when accepted or organized, and collapse recurring series** to distinct `event_uid`/day before it reaches `metInPerson`. Cap its ranking contribution. | 60.7% of attendee addresses never accepted; 104 event_uids have 127 rows each; max `metInPerson` 459; top-100 People page is 77 calendar vs 23 message. | **M** |
| **A8** | **Read `personRolesByYear`, not `personRoles`.** | `matcher.mjs:116` reads a key the config does not have; `label` is NULL on 28 of 28 snapshots, so the v11 label rule has never fired and any grading attributed to it was collected without it. | **XS** (one line) |
| **A9** | **Key the card acted/shown check on `(person_key, kind)` + cooldown or an evidence hash, not `snapshot_id`.** | `hermes.mjs:2510-2512,2520-2522` key on row id; every refresh mints new ids; 13 of 28 rows are byte-identical repeats. A dismissal does not survive the next auto-refresh. | **S** |
| **A10** | **Make `no-cap-configured` loud** (startup warning / a line on the refresh response), or set the cap. | `rm_card_event` → 0 rows, ever. A safety gate that silently disables the pillar it protects is indistinguishable from the pillar being broken. | **XS** |
| **A11** | **Open `run.mjs:427` read-only.** | It opens the live `context.db` read-write and runs `db.exec(SCHEMA)` + `migrate()`, a second writer against a sole-writer DB in `journal_mode=DELETE`. It only reads (`:463,470,483,513,517`). | **XS** |
| **A12** | **Add an attempt counter to summary jobs and narrow `isRetryable`.** | `hermes.mjs:4244` treats 502 as retryable; `summary.mjs:412-417` stamps 502 on *every* non-ok response including permanent 4xx; `summaryQueue.mjs:170-186` requeues with no counter. Background jobs can retry forever, re-paying `gatherRows` each time. | **S** |
| **A13** | **Correct two source comments that assert rigour the artifacts do not support.** `episodes.mjs:7-10` (the gap plateau does not reproduce: 3.00% vs 2.70%, flat); `EPISODE_SOURCES` comment (the four excluded conversational sources all carry `chat_handle`). Commit `ops/l5-promotion-gates.json` with the sealed-set hash, or soften the comments in `service.mjs:14-31`, `calendarReconnect.mjs:1-11`, `matcher.mjs:1-22` — that file does not exist and `~/.hazlie/experiments/` does not exist at all. | Measured / `ls`. | **S** |

### B. This is wasted compute

| # | Fix | Saving | Size |
|---|---|---|---|
| **B1** | **Split `SUMMARY_REVISION` into three stage revisions.** | **14×** on the most common edit: 60 min instead of 14 h 15 m. Verified: `1900838` changed one annual prompt string and invalidated all 1,385 chunks. | **S** |
| **B2** | **A/B `--ubatch-size` before anything else.** `llama-bench -m … -p 4096,28160 -ub 128,256,512 -fa 1 -ctk q8_0 -ctv q8_0`; set the winner and document it in the plist comment block per that file's own convention. | Potentially **3.7 h** of a 14.25 h rebuild — more than every other fix combined. Prompt processing is 53.7% of the run and the flag is ¼ the default, undocumented. | **S** to test, **XS** to apply. Watch RSS. |
| **B3** | **`BATCH_ITEM_CAP = 1`** (or delete the batch path). | **1.9 h/rebuild (16%)**, plus it kills A5 and the 3.4% overflow margin. 48.8 s/chunk batched vs 29.7 s computed from this server's own curves. | **S** |
| **B4** | **Stop storing `plan` as memory.** Drop the kind, or route plans to a short-lived table the review queue never shows. | Review queue **3,948 → 583** — an hour of reading instead of a pile nobody finishes. 85.2% of claims; 1,274 of 1,275 dated ones already expired. | **M** |
| **B5** | **Add the length gate to the pending-episode query** (`distill-episodes.mjs:148-160`), recorded in `distill_run.params` as a revertible arm. | **32.6% of distillation calls** for 4.0% of claims. 27.6× yield spread across the buckets. | **S** |
| **B6** | **Clamp the calendar history floor** (`calendar.mjs:66`, currently 1900) and exclude system Birthdays/Holidays calendars at ingest. Then purge + rescan. | **14,497 rows → 146.** 3.2% of the entire corpus. | **S** |
| **B7** | **Split the distill cache key** so the model+content half survives a prompt edit, and GC orphaned prompt-sha directories. | 159 MB of quoted private text in four directories nothing will ever read; a prompt edit currently costs an 11-hour corpus re-read. | **S** |
| **B8** | **Add `--no-context-shift` to the plist**, and cap batch KV occupancy so peak leaves headroom. | Turns silent mid-evidence truncation into a loud failure into the existing fallback. 250 of 252 model-load failures fell in the summary window; ≥4 h of model-tier unavailability at `ThrottleInterval 60`. | **XS** / **S** |
| **B9** | **Expose the leaf and month reductions directly** instead of treating the year prose as the only product. Or stop persisting a free-text overview and template it from the sections. | The leaf layer holds **1,134 distinct entities the year summaries never surface**; 57% of person-years yield ≤3 specifics for 52% of chunk compute. The expensive part is measurably the good part; the cheap part on top degrades it. | **M** |
| **B10** | **Fix the projection commit → boot warm becomes the 64 ms path** (one historical warm proves it). Then scope `clearPeopleProjection` to affected people instead of the whole table. Merge the two full corpus scans in `buildGraph` + `buildPersonEventLinks`. | ~10 s of dead air on **every boot**, during which hermes answers nothing (node:sqlite is synchronous). | **M** (follows from A2/A3) |
| **B11** | **Delete the relationship `verify` call**, or give it evidence the first call did not have. **A/B the `ownerFocus` call against its own deterministic fallback.** | `matcher.mjs:313-321` re-reads two strings the model just wrote — the shape of check that looks like rigour and cannot fail for the right reason. `matcher.mjs:101-104` already has a regex-tally fallback on the same expression; nobody has measured which is better. | **S** |
| **B12** | **Set per-source `keep_days`** for photos, files, calendar birthdays and the bridged platforms. The route already handles cascade correctly. | Config line, not code. Currently zero retention is configured on a store of real private messages. | **XS** |
| **B13** | **Fix `whatsapp.needs()`** to report a missing prerequisite; investigate the 112 iMessage failures. **Give `contacts` a `stateOnly` flag** so it stops reporting 1.2M phantom ingests. | 460 of 483 whatsapp runs fail hourly on a store that doesn't exist. 16% failure on 91.5% of the corpus means silent gaps. `run_log.ingested` is currently unusable as a metric. | **S** |
| **B14** | **Decide one conversation unit** — episode or thread-day — and stop mixing them in the same Set. | 8,436 thread-days double-counted (`content.mjs:207`, `topics.mjs:390-398`). You run both units simultaneously today. | **S** |

### C. Do not do these

- **Do not add bulk accept to the review queue.** The no-bulk-accept decision at
  `memoryPage.mjs:14-15,205-206` is right. Cut the queue *before* it reaches a
  human (A1 + A4 + B4), then look at what's left.
- **Do not restart the distiller before the queue has a door and a number.** The
  correct order is: put an entrance to the review queue inside the product →
  measure accept rate on the 3,948 already sitting there → *then* decide whether
  another 11 hours is worth it. Nothing else about that stage should be tuned
  until step 2 has a number.
- **Do not optimise `gatherRows`.** 0.02% of the run.
- **Do not size batches for prompt-cache reuse.** It is measurably absent (476 GiB
  evicted, median LCP similarity 0.118) and always will be for this workload.

### The one measurement that would change this report

**Instrument whether the 116 person-year summaries are ever opened**, the way
`rm_card_event` was built to instrument the cards. If they are not, the 14.58 hours
has the same problem the 11.03 hours had, and no prompt edit fixes it.

---

## 7. What I could not determine

Stated explicitly rather than guessed:

1. **Whether the ~28k batches caused the llama-server crashes.** 250 of 252
   `load_model` failures fall inside the summarisation window, and the error is a
   memory-fit failure on an 18 GB host loading a 5.03 GB model with a 2.4 GB KV
   cache. The concentration is not subtle, but **I did not prove causation.**
2. **What `--ubatch-size 512` would actually buy.** Changing it requires restarting
   a live service, which is outside a read-only audit. I can state the flag is ¼ the
   default, governs 53.7% of the run, and is undocumented in a file that documents
   everything else. **I will not put a number on the improvement.** B2 is the test,
   not the fix.
3. **What llama-server does on an over-context prompt on this build.** The
   400/413/422 fallback (`summary.mjs:648-653`) is tested only against a hand-written
   mock (`ui/test/people-summary.test.mjs:125-150`). The server is up but `/props`
   requires the API key, and probing would take the single `--parallel 1` slot from
   the live queue. **If context shift is active, an over-length batch is silently
   truncated and returns a schema-valid answer** — indistinguishable from A5.
4. **The exact constraint that aborts `replaceProjection`.** Copying the DB to a
   scratch directory was sandbox-blocked, so I could not execute the write. The
   *mechanism* (A3) is inferred from the schema plus 16 measured collisions; the
   *fact* that the write does not commit (A2) is established directly from the state
   row.
5. **Whether the 4.5× yield decline on large episodes is the model or the data.**
   Long chats may genuinely be chit-chat while a lone message is more likely to be a
   logistics commitment. The `--context` arm plus a 30-minute gap run would settle
   it; the machinery is already there (`distill_run_arm`) and it is one flag and one
   index scan.
6. **Whether the 157 claims a length gate would drop were the good ones.** Nobody
   has reviewed any claim, so there is no ground truth to check against. B5 is a
   measured trade with an unmeasured quality side.
7. **Whether relations *between* entities survive summarisation correctly.** I
   bounded fabricated *nouns* at ~0.5%. An entity can survive into a sentence that
   misstates what happened to it, and nothing I ran would catch that.
8. **Whether the Phase 0 ablation results cited throughout the relationship code
   were ever run.** `ops/l5-promotion-gates.json` does not exist and
   `~/.hazlie/experiments/` does not exist at all. **Absence is not proof they were
   never run** — you may have deleted them — but from the repository's point of
   view every number presented as ablation-derived is currently unbacked.
9. **Whether the one 399-identifier contact card is an error.** It is inert today
   (none of those numbers appear as a message handle) and may be a deliberate
   bucket. It is the largest single over-merge exposure in the spine by two orders
   of magnitude if any one of them ever sends a message.
10. **Per-call durations for distillation.** `started_at == ended_at` on all 36,626
    rows because `distill-episodes.mjs` never sends `run.started_at`. The 11.0-hour
    figure is reconstructed from llama-server log timings, not from `distill_run`.
