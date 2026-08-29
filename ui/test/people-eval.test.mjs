import assert from 'node:assert/strict';
import test from 'node:test';

import { assertAggregatePrivateMetrics } from '../evals/people-search/privacy.mjs';

function aggregateMetrics() {
  return {
    queries: 3,
    planned: 3,
    answered: 1,
    abstained: 2,
    execution_errors: 0,
    memory_errors: 0,
    planning_errors: 0,
    retrieval_errors: 0,
    verification_errors: 0,
    elapsed_ms: 1200,
    candidates: 4,
    verified_matches: 1,
    privacy_violations: 0,
    identity_confidence_violations: 0,
    person_attribution_owner_evidence_violations: 0,
    memory_queries_with_lexical_hits: 1,
    memory_store_available: true,
  };
}

test('private shadow reports accept aggregate counts only', () => {
  assert.equal(assertAggregatePrivateMetrics(aggregateMetrics()).queries, 3);
  assert.throws(
    () => assertAggregatePrivateMetrics({ ...aggregateMetrics(), per_query: [] }),
    /non-aggregate/u
  );
  assert.throws(
    () => assertAggregatePrivateMetrics({ ...aggregateMetrics(), answered: ['identity'] }),
    /non-negative integers/u
  );
});
