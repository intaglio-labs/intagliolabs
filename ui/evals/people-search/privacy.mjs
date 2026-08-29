const PRIVATE_METRIC_KEYS = Object.freeze(new Set([
  'queries',
  'planned',
  'answered',
  'abstained',
  'execution_errors',
  'memory_errors',
  'planning_errors',
  'retrieval_errors',
  'verification_errors',
  'elapsed_ms',
  'judgment_batches',
  'verification_batches',
  'batch_errors',
  'planning_ms',
  'judgment_ms',
  'verification_ms',
  'model_calls',
  'prompt_tokens',
  'completion_tokens',
  'cache_hits',
  'cache_misses',
  'warm_cache_hits',
  'warm_model_calls',
  'warm_cache_ms',
  'cache_consistency_violations',
  'candidates',
  'verified_matches',
  'privacy_violations',
  'identity_confidence_violations',
  'person_attribution_owner_evidence_violations',
  'memory_queries_with_lexical_hits',
  'memory_store_available',
]));

export function assertAggregatePrivateMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error('private shadow metrics must be an object');
  }
  const keys = Object.keys(metrics);
  if (keys.length !== PRIVATE_METRIC_KEYS.size
      || keys.some((key) => !PRIVATE_METRIC_KEYS.has(key))) {
    throw new Error('private shadow metrics contain a non-aggregate field');
  }
  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'memory_store_available') {
      if (typeof value !== 'boolean') throw new Error('private shadow availability must be boolean');
    } else if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('private shadow counts must be non-negative integers');
    }
  }
  return metrics;
}
