# People Search Evaluation Pillar

Deep people search is a permanent product-quality surface. The goal is to improve recall and usefulness without weakening evidence, identity, memory, or privacy boundaries.

## What we measure

- Retrieval recall across messages, profiles, meetings, and connector identities.
- Grounded precision for compound conditions, durable affinity, and contradiction handling.
- Identity safety: answer confidence can never exceed the supporting identity confidence.
- Privacy safety: the browser receives summaries and aggregate facts, not source rows or model prose.
- Memory coordination: owner-memory claims may help interpret the reader's context, but never become evidence that another person said, believed, or preferred something.
- Reliability and latency, including the stage where a private shadow query failed.

## Layers

1. **Deterministic invariants** use synthetic local data and must always pass.
2. **Local-model gold set** runs the actual planner, evidence judge, and independent verifier over synthetic multi-connector fixtures with known outcomes.
3. **Private shadow** runs product seed queries over the owner's local stores. It emits only a fixed allowlist of aggregate counts and a total duration. It never persists or prints questions, names, messages, evidence, person identifiers, model prose, or per-query results.

The memory and people systems are deliberately complementary. Accepted memory represents the reader's own durable claims. People search treats connector evidence linked through the identity projection as the authority for claims about another person. The eval checks this authorship boundary and reports whether accepted memory was available and lexically recalled, without exposing the memory.

## Run

From `ui/`:

```sh
npm run eval:people
npm run eval:people:private
```

`--debug` is allowed only for synthetic diagnostics. Private output is passed through an aggregate-field allowlist before it can be printed.

## Release gate

A people-search change is not releasable when any deterministic invariant regresses, any privacy/identity/authorship violation is nonzero, the local-model gold score regresses, or the private shadow has an execution error. A clean score does not prove product quality; it is the minimum gate before qualitative expansion.

New bugs should become synthetic regression cases. New product capabilities should add at least one positive, one hard-negative, and one cross-connector or memory-boundary case. The private shadow should be run locally before release, while only the sanitized aggregate result may be documented.
