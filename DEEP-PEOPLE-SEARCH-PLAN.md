# Deep people search

Plan only. This document describes how to extend Intaglio's existing people
graph into an evidence-backed search surface for compound questions such as:

- “Find the investors I met in LA about five years ago.”
- “Does anyone from my high school work in tech?”
- “Who would be down for Italy?”

## Outcome

A person can ask an open-ended question about people in their history and get a
short, ranked list where every result:

1. refers to a person already present in the local people graph;
2. satisfies the explicit filters in the question;
3. includes a concise explanation of why it matched;
4. distinguishes known facts from reasonable hypotheses; and
5. is computed locally without sending corpus text to a cloud model.

This is a retrieval and ranking feature, not an autonomous outreach feature.
It finds people and explains the evidence; it never messages anyone or presents
an inferred preference as consent.

## What already exists

The repository already has most of the foundation:

- `ui/server/people/graph.mjs` resolves identities across Contacts, messages,
  mail, calendar, and LinkedIn into one person graph.
- `ui/server/people/search.mjs` handles narrow investor, mentor, reconnect, era,
  and warm-introduction searches with deterministic ranking.
- `ui/server/people/content.mjs` maps an FTS match back to a person and limits
  evidence to a bounded excerpt.
- `POST /vault/ask` in `ui/server/hermes.mjs` is the sealed, local answer path.
- Hermes is already the sole database writer and deleter, and corpus text is
  prohibited from riding a cloud-model request.

The missing layer is a general query plan that can combine several predicates
at once: role + place + time, shared affiliation + current industry, or likely
interest + relationship strength.

## Product contract

Deep people search should follow four rules.

### Grounded

Code selects candidates and verifies constraints. A model may help translate
the user's question into a typed query, but it does not invent candidates,
merge identities, or decide that unsupported evidence is true.

### Legible

Each result says why it matched in terms the user can audit, for example:

> Maya Chen — investor; met at a Los Angeles event in June 2021; last spoke in
> 2023.

The answer should also disclose weak or missing evidence: “I found two likely
matches” is better than silently upgrading a guess to a fact.

### Conservative about people

False positives are more damaging than omissions. Identity resolution remains
exact or owner-confirmed. Affiliation, location, employment, and intent each
have minimum evidence thresholds. “Would be down” is always phrased as a
hypothesis unless the corpus contains an explicit commitment.

### Local and erasable

Parsing, extraction, retrieval, ranking, and narration run locally. Derived
evidence lives under Hermes' ownership and retains a pointer to its source
entity so source edits, retention, and deletion invalidate it.

## Query model

Translate each question into a closed, validated `PeopleQuery` object:

```json
{
  "subject": "person",
  "all": [
    { "predicate": "role", "op": "is", "value": "investor" },
    { "predicate": "interaction.place", "op": "within", "value": "Los Angeles" },
    { "predicate": "interaction.time", "op": "between", "from": 1598918400000, "to": 1661990400000 }
  ],
  "rank": ["evidence_confidence", "relationship_warmth", "recency"],
  "limit": 10
}
```

Supported predicate families for the first release:

| Family | Examples | Preferred evidence |
| --- | --- | --- |
| Identity and role | investor, designer, founder | LinkedIn role/company, firm/domain rules, explicit relationship content |
| Interaction | met, emailed, traveled with | calendar attendance/location, direct or group conversation participation |
| Time | in 2021, five years ago, during college | timestamps and owner-defined life eras |
| Place | LA, London, Italy | structured event location first; locally extracted place mentions second |
| Affiliation | same high school, worked at Stripe | education/employment metadata and owner-defined aliases |
| Industry | works in tech, healthcare | deterministic company/title taxonomy with locally generated fallback labels |
| Interest or intent | down for Italy, wants to ski | explicit positive/negative statements, plans, invitations, and repeated topic evidence |
| Relationship | close, dormant, reachable | existing graph depth, reciprocity, channels, meetings, and dormancy |

The parser must preserve conjunctions. “Investors I met in LA” means role AND
in-person interaction AND place; broadening that to any one condition would
produce an impressive-looking but wrong list.

## How the example questions resolve

| Question | Hard filters | Ranking and answer language |
| --- | --- | --- |
| Investors met in LA about five years ago | investor evidence; an in-person interaction; Los Angeles location; fuzzy time window centered five years ago | Rank by evidence confidence, then warmth. State the actual date and event/location evidence. |
| Anyone from my high school who works in tech | same owner-confirmed school; current tech employment | Rank exact education records above text-derived evidence. State school and current role/company. |
| Who would be down for Italy? | reachable person; positive Italy/travel evidence; no later negative evidence | Rank explicit plans or enthusiasm above generic travel mentions, then warmth and recency. Say “likely interested” unless the person explicitly agreed to this trip. |

“About five years ago” should become a fuzzy date range centered on the target
date rather than a single calendar year. “LA” should resolve through a local
alias table to Los Angeles and its common forms; it must not require an external
geocoding request.

## Architecture

The request path has five stages:

```text
question
  -> typed local query plan
  -> people-graph candidate set
  -> structured + FTS evidence lookup
  -> hard filtering and deterministic ranking
  -> bounded answer with reasons and uncertainty
```

### 1. Add a local evidence index

Create a derived `person_evidence` table in the Hermes database. It contains
structured facts and observations, not a second copy of corpus prose.

Suggested fields:

```text
person_key          resolved graph person
predicate           role, school, employer, industry, place, interest, intent...
value_norm          normalized value used for matching
value_label         owner-facing label
start_ts / end_ts   when the evidence applies
polarity            positive, negative, or unknown
confidence          deterministic 0..1 evidence strength
source              calendar, linkedin, imessage, mail...
entity_id           source entity used for invalidation
context_id          optional pointer to the canonical Hermes row
derivation          structured, rule, or local-model
```

Indexes should cover `(predicate, value_norm)`, `(person_key, predicate)`, and
time ranges. A unique derivation key prevents duplicate evidence on redelivery.
Deletion of a source entity deletes its evidence in the same Hermes operation.

Build evidence from strongest to weakest:

1. structured metadata already present on a row;
2. deterministic extraction rules over bounded fields;
3. a local model producing schema-validated observations from local text.

The local model's extraction output is treated as evidence with lower
confidence, never as an identity merge or a final answer. No extraction result
is accepted without a source pointer.

### 2. Fill the source gaps

Extend ingestion only where the source has stronger structured data than prose:

- Calendar: retain normalized event location and the evidence that an attendee
  was present; distinguish physical meetings from virtual calls.
- LinkedIn export: ingest education and richer employment history when those
  fields exist; preserve effective dates where available.
- Contacts and owner profile: let the owner define schools, employers, home
  locations, life eras, and aliases such as `LA -> Los Angeles`.
- Messages and mail: use FTS for query-time discovery and local extraction for
  repeated high-value evidence such as places, interests, plans, acceptance,
  and rejection.

Owner profile facts must be explicit. “My high school” should resolve from an
owner-configured school, not from the system guessing which school counts.

### 3. Implement the query planner

Add `ui/server/people/query.mjs` with:

- deterministic parsing for dates, relative time, known roles, relationship
  terms, common place aliases, and conjunctions;
- a strict `PeopleQuery` schema and validator;
- a local-model fallback for phrasing that rules do not cover; the model sees
  the question and allowed schema, but does not choose results;
- ambiguity detection, so a materially unclear question produces one concise
  clarification instead of silently picking an interpretation.

Keep the current narrow intent detectors as fast paths and compatibility tests.
Deep search should activate only when the planner produces at least one valid
people predicate.

### 4. Retrieve, filter, and rank

Add `ui/server/people/deep-search.mjs`:

1. Build or load the existing resolved people graph.
2. Fetch candidate evidence for each hard predicate.
3. Intersect candidate sets for `all` clauses and union explicit `any` clauses.
4. Reject candidates below the predicate-specific confidence floor.
5. Rank survivors with a visible score breakdown.

Suggested score order:

1. constraint completeness;
2. evidence confidence and independence of sources;
3. relationship warmth and reachability;
4. recency appropriate to the question;
5. content spread across conversations, using the existing conversation-count
   approach instead of raw mention count.

Negative evidence must be first-class. A recent “I can't travel this year”
should suppress an older Italy mention. Generic interest in food, travel, or
Europe is not enough to assert interest in an Italy trip.

### 5. Return an evidence-backed answer

Integrate deep search before the generic claim/episodic path in
`handleVaultAsk`, alongside the existing person-search fast path.

The response should contain:

- a short interpretation of the query when useful;
- up to ten ranked people;
- one or two reasons per person, including dates;
- explicit confidence language for inferred interest;
- source names and counts, never raw rows;
- an honest no-result answer that names which constraint had no evidence.

The first version can stay text-only to preserve the existing `/vault/ask`
contract. A later UI can add expandable evidence cards, but opening raw source
text requires a separate, explicit owner-review design rather than widening the
ordinary browser response.

## Implementation phases

### Phase 0 — contracts and fixtures

- Define `PeopleQuery`, evidence predicates, confidence tiers, and answer
  language.
- Add synthetic multi-source fixtures for the three example questions.
- Record expected inclusions, exclusions, ranking, and no-result behavior.

Exit: the examples are executable acceptance tests even though they fail.

### Phase 1 — role + place + time

- Add calendar location normalization and physical-meeting classification.
- Materialize role, interaction, place, and time evidence.
- Implement compound filtering and the first query-parser slice.
- Ship “investors I met in LA about five years ago” behind a feature flag.

Exit: every returned investor satisfies all four constraints, and each result
names the supporting meeting/date evidence.

### Phase 2 — shared affiliations + current work

- Add owner-profile schools and aliases.
- Ingest LinkedIn education/employment fields where available.
- Add school, employer, and industry predicates with effective-date handling.
- Ship “anyone from my high school works in tech?”

Exit: a person needs both shared-school evidence and current-tech evidence; old
tech jobs are not represented as current.

### Phase 3 — interests and intent

- Add local extraction for positive, negative, planned, and completed travel
  statements.
- Add evidence decay and contradiction handling.
- Add conservative interest ranking and uncertainty language.
- Ship “who would be down for Italy?”

Exit: direct enthusiasm or plans outrank mentions, later negatives override
older positives, and the answer never represents likelihood as consent.

### Phase 4 — generalization and UX

- Add the schema-constrained local planner fallback.
- Add clarification behavior, local query history, and performance caching.
- Tune thresholds against an owner-reviewed evaluation set.
- Remove the feature flag after privacy, deletion, and quality gates pass.

## Test plan

Add unit and integration coverage near the existing people tests:

- `ui/test/people-query.test.mjs`: dates, aliases, conjunctions, negation, and
  ambiguity.
- `ui/test/people-evidence.test.mjs`: extraction, confidence, source pointers,
  deduplication, and invalidation.
- `ui/test/people-deep-search.test.mjs`: compound filtering, scoring, negative
  evidence, and explanation output.
- `ui/test/memory.test.mjs`: `/vault/ask` routing and response contract.
- connector tests for any new calendar or LinkedIn metadata.
- egress tests proving no new host and no corpus-bearing cloud request.

Required adversarial cases:

- an investor who was active five years ago but never met in LA is excluded;
- an LA meeting outside the requested period is excluded;
- someone from a similarly named school is not merged into the owner's school;
- a former tech employee is not called a current tech employee;
- “Italy makes me miserable” is not positive interest;
- a travel newsletter and business short code never become people;
- two people with similar names remain separate;
- deleting or purging a source removes its derived evidence and changes results;
- a parser or local-model failure falls through safely and fabricates nothing.

## Performance and operations

- Materialize evidence incrementally during Hermes ingestion and rebuild it with
  a versioned maintenance job when extraction rules change.
- Cache the resolved graph by the existing corpus/spine stamps; do not hold a
  stale contacts view across connector updates.
- Bound FTS rows, local-model extraction size, candidates, and answer length.
- Target under 500 ms for indexed structured searches and under 2 seconds for a
  warm mixed structured/content search on a mature corpus.
- Log only query shape, timing, candidate counts, and error classes. Never log
  questions, names, excerpts, or evidence values.

## Rollout and quality bar

Start with an owner-only feature flag and a synthetic evaluation suite, then run
an owner-reviewed set of real questions locally. Track precision at the top of
the list, constraint violations, identity mistakes, unsupported explanations,
and no-result rate. Do not optimize recall until constraint violations and
unsupported claims are effectively zero.

The release gate is:

- no candidate violates a hard query constraint;
- every explanation can be traced to live source evidence;
- deletion and retention remove derived evidence;
- no corpus text reaches a cloud model or log;
- uncertain intent is labeled as uncertain;
- the existing investor, mentor, reconnect, warm-intro, episodic, and sync-status
  paths keep passing unchanged.

## Recommended product decisions

1. Make owner-profile affiliations explicit and editable; do not infer “my high
   school.”
2. Prefer precision over recall for people and relationship claims.
3. Keep deterministic selection/ranking, with local models limited to typed
   parsing, extraction, and optional narration.
4. Treat travel-interest results as leads to ask, not promises or consent.
5. Keep the first release in `/vault/ask`; add richer evidence review only after
   defining its privacy boundary.

For one engineer, the three vertical slices plus hardening are roughly four to
six weeks, assuming the required LinkedIn education fields are available in the
supported export. Phase 1 is the smallest useful milestone and exercises the
core architecture needed by the other two examples.
