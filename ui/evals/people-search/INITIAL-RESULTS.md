# Initial People Search Eval — 2026-08-29

This report contains aggregate findings only. No private query, identity, message, evidence, model prose, or per-query result is included.

## Scorecard

| Surface | Earlier measurement | Current measurement | Status |
| --- | ---: | ---: | --- |
| Deterministic safety and architecture invariants | 2 / 9 | 9 / 9 | Pass |
| Real local-model synthetic gold set | 1 / 5 | 5 / 5 | Pass |
| Private shadow planning | Not measured | 3 / 3 | Pass |
| Private shadow completed answers | 0–1 / 3 in initial runs | 3 / 3 | Pass |
| Private shadow execution and batch errors | 0–2 / 3 in initial runs | 0 | Pass |
| Privacy, identity-confidence, and authorship violations | Not measured | 0 | Pass |
| Exact-repeat warm model calls | Not measured | 0 | Pass |
| Exact-repeat result consistency violations | Not measured | 0 | Pass |

The latest private shadow kept the aggregate candidate set at 18, produced 10 verified matches, answered all three queries, and had no execution or safety errors. Cold execution fell from 125,174 ms to 89,643 ms, a 28% reduction (approximately 30 seconds per query). The exact-repeat warm replay completed all three queries in 80 ms total (approximately 27 ms per query), with six cache hits, zero model calls, and identical answer counts. Match-count movement from the prior run is treated as model variance, not a quality claim.

The cold pass used eight local-model calls: three plans, three judgments, and two contradiction verifications. It processed 9,646 prompt tokens and generated 1,696 completion tokens. Planning took 18,383 ms, judgment 18,199 ms, and verification 9,191 ms in aggregate. Cold inference remains the largest product weakness. The local accepted-memory store was unavailable for these runs, so private memory recall could not be evaluated. The synthetic memory-authorship boundary did pass.

## What improved

- Broad people questions now route through one general evidence-first path.
- Planner-only concepts such as time, repetition, and reachability no longer become brittle lexical requirements.
- Word-based relative dates, morphological variants, and acronyms receive general retrieval support.
- Durable-interest questions require repeated evidence, and contradictory or weak support fails closed.
- Connector evidence is aggregated through the persisted person/identifier projection.
- Independent verification, identity-confidence caps, safe summaries, and aggregate-only private reporting are enforced.
- Candidates are deterministically bounded, judged through facet-level evidence packets, and repaired once when the local model emits invalid structured output.
- Independent verification is reserved for conclusions that cite potentially contradictory evidence; verifier failure safely removes the risky match.
- Model stages are cached by a SHA-256 digest of the complete request. Raw questions and evidence inputs are never persisted as cache keys.
- Final derived answers are cached against a persistent corpus, connector-spine, identity-resolution, owner-profile, model-endpoint, code-revision, and day fingerprint. An evidence or identity change invalidates the answer before it can be served.
- The cache is local, bounded to 512 entries, expires entries after seven days, and fails open as a miss if its store is damaged. Privacy deletion routes strictly erase and compact it before reporting success.
- Facet judgments use a compact facet-to-evidence map, reducing cold generation without weakening code validation.
- The eval records aggregate cache hits, model calls, prompt/completion tokens, stage latency, warm latency, and consistency violations.

## Fix priorities

1. Evaluate a faster local model/runtime for cold structured planning and judgment while keeping the same code validators and gold score.
2. Set a per-query latency budget and return bounded partial results when that budget expires.
3. Extend cache invalidation stress coverage across identity merge/split and owner-profile edits; purge, retention, entity deletion, People clear, and process restarts now have strict erasure coverage.
4. Add a synthetic accepted-memory fixture that measures query interpretation gains and proves owner memory cannot leak into person attribution.
5. Grow the gold set by query shape and connector mix, with hard negatives and repeated runs to measure model variance.

Answer quality, reliability, and warm-query latency now pass the initial gate. Cold-query latency remains a failing product target and is the next optimization pillar.
