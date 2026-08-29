# Initial People Search Eval — 2026-08-29

This report contains aggregate findings only. No private query, identity, message, evidence, model prose, or per-query result is included.

## Scorecard

| Surface | Earlier measurement | Current measurement | Status |
| --- | ---: | ---: | --- |
| Deterministic safety and architecture invariants | 2 / 9 | 9 / 9 | Pass |
| Real local-model synthetic gold set | 1 / 5 | 4 / 5 | Failing gate |
| Private shadow planning | Not measured | 3 / 3 | Pass |
| Private shadow completed answers | Not measured | 1 / 3 on latest run; 0–1 / 3 across two runs | Failing gate |
| Private shadow execution errors | Not measured | 0 / 3 on latest run; 0–2 / 3 across two runs | Flaky gate |
| Privacy, identity-confidence, and authorship violations | Not measured | 0 | Pass |

The latest private shadow found 53 candidates and 9 verified matches in aggregate, completed in 156,842 ms, and had no execution errors. A preceding run over the same three-query set found the same candidate volume but had two downstream execution errors and no completed answers. That means the immediate problem is not total retrieval failure; it is latency, selectivity, and run-to-run reliability at realistic candidate volume. The local accepted-memory store was unavailable for these runs, so local memory recall could not be evaluated. The synthetic memory-authorship boundary did pass.

## What improved

- Broad people questions now route through one general evidence-first path.
- Planner-only concepts such as time, repetition, and reachability no longer become brittle lexical requirements.
- Word-based relative dates, morphological variants, and acronyms receive general retrieval support.
- Durable-interest questions require repeated evidence, and contradictory or weak support fails closed.
- Connector evidence is aggregated through the persisted person/identifier projection.
- Independent verification, identity-confidence caps, safe summaries, and aggregate-only private reporting are enforced.

## Fix priorities

1. Add bounded candidate reranking and batched verification so realistic candidate sets do not time out or overload the local model.
2. Record aggregate stage latency and error counts on every private shadow run, then set explicit latency budgets.
3. Improve compound-condition verifier calibration while retaining the independent fail-closed pass.
4. Add a synthetic accepted-memory fixture that measures query interpretation gains and proves owner memory cannot leak into person attribution.
5. Grow the gold set by query shape and connector mix, with hard negatives and repeated runs to measure model variance.

This initial result is intentionally recorded as a failing release gate. The eval infrastructure is working because it exposed the reliability gap instead of hiding it behind a successful retrieval count.
