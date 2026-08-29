# People Search Evaluation Pillar

Deep people search is a permanent product-quality surface. The goal is to improve recall and usefulness without weakening evidence, identity, memory, or privacy boundaries.

## What we measure

- Retrieval recall across messages, profiles, meetings, and connector identities.
- Grounded precision for compound conditions, durable affinity, and contradiction handling.
- Identity safety: answer confidence can never exceed the supporting identity confidence.
- Privacy safety: the browser receives summaries and aggregate facts, not source rows or model prose.
- Memory coordination: owner-memory claims may help interpret the reader's context, but never become evidence that another person said, believed, or preferred something.
- Reliability and latency, including model/token counts, cold stage timings, cache hits, exact-repeat warm latency, and result consistency.

## Layers

1. **Deterministic invariants** use synthetic local data and must always pass.
2. **Local-model gold set** runs the actual planner, evidence judge, and independent verifier over synthetic multi-connector fixtures with known outcomes.
3. **Private shadow** runs product seed queries over the owner's local stores. It emits only a fixed allowlist of aggregate counts and a total duration. It never persists or prints questions, names, messages, evidence, person identifiers, model prose, or per-query results.

The memory and people systems are deliberately complementary. Accepted memory represents the reader's own durable claims. People search treats connector evidence linked through the identity projection as the authority for claims about another person. The eval checks this authorship boundary and reports whether accepted memory was available and lexically recalled, without exposing the memory.

The production cache follows the same boundary. Its keys persist only SHA-256 digests of complete inputs. Schema-constrained model outputs and final derived summaries stay in a bounded 0600 local store beside the corpus; no source row or message excerpt is stored in a final answer. Exact-repeat answers are valid only while the corpus, connector identity spine, resolution decisions, owner profile, model endpoint, search revision, and local day remain unchanged. Every retention, purge, entity-deletion, and People-clear route strictly erases and compacts this derived store before reporting success.

## Run

From `ui/`:

```sh
npm run eval:people
npm run eval:people:private
```

`--debug` is allowed only for synthetic diagnostics. Private output is passed through an aggregate-field allowlist before it can be printed.

## Release gate

A people-search change is not releasable when any deterministic invariant regresses, any privacy/identity/authorship violation is nonzero, the local-model gold score regresses, the private shadow has an execution or model-batch error, or an exact-repeat replay changes result counts or makes a new model call. A clean score does not prove product quality; it is the minimum gate before qualitative expansion.

New bugs should become synthetic regression cases. New product capabilities should add at least one positive, one hard-negative, and one cross-connector or memory-boundary case. The private shadow should be run locally before release, while only the sanitized aggregate result may be documented.
