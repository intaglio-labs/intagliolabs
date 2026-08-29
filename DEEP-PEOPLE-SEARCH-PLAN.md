# Deep people search

Implementation status (2026-08-28): the general evidence-search path is built
in `ui/server/people/generalSearch.mjs` and covered by
`ui/test/people-general-search.test.mjs`. Evidence-based people questions do not
have topic-specific shortcuts.

## Product contract

A person can ask a new question about people in their history and get a short,
ranked list where every result:

1. refers to a canonical person already present in the local people graph;
2. cites evidence linked to that same person;
3. distinguishes what the person said from what the owner said to them;
4. explains the supported inference without returning corpus prose; and
5. is planned and judged locally without sending corpus text to a cloud model.

The feature finds and explains people. It never messages anyone, merges
identities, or presents inferred interest as consent.

## Request path

```text
question + explicit owner-profile context
  -> constrained local query plan
  -> validated required facets, source, attribution, time, and ranking fields
  -> local FTS + structured profile/meeting retrieval
  -> canonical-person aggregation through person_event_links
  -> bounded local evidence judgment
  -> independent bounded local evidence verification
  -> code validation of facets, IDs, repetition, identity, and confidence
  -> fixed safe summary, never model prose or raw rows
```

The plan supports message, profile, calendar, and Granola-meeting evidence;
person, conversation, and participant attribution; time bounds; durable versus
single-item evidence; reachability; and relevance, recency, relationship, or
dormancy ranking. The planner expands concepts into likely local vocabulary, so
new topics do not require a code change. Synonyms inside a facet are OR terms;
separate required facets are AND conditions and each receives its own retrieval
budget and evidence slot.

“My high school” is grounded in configured owner schools supplied to the local
planner. Other owner-relative facts should follow the same pattern: explicit
profile configuration, never inference from the corpus.

## Trust boundaries

- Hermes remains the sole writer and deleter of the context and projection
  tables.
- The planner sees the question and explicit owner-profile facts, not corpus
  rows.
- The evidence judge and independent verifier see only bounded candidate bundles
  through the validated loopback llama-server URL, with redirects disabled.
- Candidate IDs and evidence IDs are assigned by code. Unknown people,
  cross-person citations, contradictions, low-confidence identity links,
  incomplete facets, and insufficient repeated evidence are rejected.
- Model-generated evidence prose is never returned. The widget receives names,
  counts, sources, and a fixed safe support description.
- `person_event_links` stores structural attribution and pointers, never a
  second copy of message or meeting text.
- Retention and purge invalidate the rebuildable people projection.

## Deliberate separate paths

Warm-introduction traversal and explicit reconnect/relationship-health ranking
remain deterministic graph operations. “Who did I text most?” remains an episodic statistics query.
They do not interpret topical corpus evidence and therefore are not alternate
deep-search shortcuts.

## Verification

Coverage includes noisy compound conditions, unfamiliar interests, structured
employment, calendar and Granola meeting topics, repeated conversations,
owner-versus-person authorship, contradictory evidence, short-message privacy,
identity-confidence caps, multiple identifiers across connectors, incremental
projection updates, stale projection failure, cross-person citation rejection,
loopback-only model calls, and non-people question refusal.
