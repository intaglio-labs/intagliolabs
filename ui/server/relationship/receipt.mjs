// The deterministic receipt renderer (L5 step 3): one claim row in, one
// RelationshipMemoryItem-shaped receipt out, per the item contract in
// L5-RELATIONSHIP-MEMORY-EXPERIMENT.md. Pure arithmetic over what hermes
// already stores -- no model anywhere near it, because a receipt is the thing
// the owner checks the model AGAINST.
//
// The derived states answer the contract's question -- "What did Intaglio
// believe at the moment it showed this card?" -- from columns that already
// carry the semantics: claim.created_at IS transaction time, claim_decision
// IS the append-only lifecycle, distill_run IS the producer record. This
// module names them; it stores nothing.
//
// freshness_state deserves its warning label: 'stale' and 'source_missing'
// should be IMPOSSIBLE, because hermes deletes a claim in the same
// transaction that edits or deletes its source. They are computed anyway, for
// the same reason claimCounts() reports its stale number -- a state nobody
// computes is a hole nobody finds, and the L5 stop condition "source deletion
// fails to invalidate derived memory" needs a detector, not an assumption.

import { isExpired } from '../memory/validity.mjs';

const TRUST_BY_ACTION = Object.freeze({
  accept: 'accepted', reject: 'rejected', retract: 'retracted',
});

export function renderClaimReceipt(db, claimId, { now = Date.now() } = {}) {
  const claim = db
    .prepare(
      'SELECT c.id, c.subject, c.subject_person_key, c.kind, c.text, c.observed_at, ' +
        'c.valid_to, c.p_claim, c.created_at, c.run_id, r.model, r.prompt_sha ' +
        'FROM claim c JOIN distill_run r ON r.id = c.run_id WHERE c.id = ?'
    )
    .get(claimId);
  if (claim === undefined) return null;

  // Latest decision wins -- the same ordering v_claim_accepted uses, so this
  // renderer and the product surface can never disagree about standing.
  const decision = db
    .prepare(
      'SELECT action, actor, created_at FROM claim_decision WHERE claim_id = ? ' +
        'ORDER BY created_at DESC, id DESC LIMIT 1'
    )
    .get(claimId);

  // Pointer PLUS snapshot, compared against the live row. The contract keeps
  // one flat justification set and over-invalidates on any member; the
  // renderer mirrors that: one bad reference degrades the whole item.
  const evidence = db
    .prepare(
      'SELECT s.context_id, s.source, s.entity_id, s.quote, s.content_hash, ' +
        'x.content_hash AS current_hash, x.id AS live_id ' +
        'FROM claim_source s LEFT JOIN context x ON x.id = s.context_id ' +
        'WHERE s.claim_id = ? ORDER BY s.context_id'
    )
    .all(claimId)
    .map((r) => ({
      context_id: r.context_id, source: r.source, entity_id: r.entity_id ?? null,
      quote: r.quote, content_hash: r.content_hash ?? null,
      present: r.live_id !== null,
      unchanged: r.live_id !== null &&
        (r.content_hash === null || r.content_hash === r.current_hash),
    }));

  const freshness_state = evidence.length === 0 || evidence.some((e) => !e.present)
    ? 'source_missing'
    : evidence.some((e) => !e.unchanged)
      ? 'stale'
      : 'current';

  return {
    id: claim.id,
    person_keys: claim.subject === 'person' ? [claim.subject_person_key] : [],
    kind: claim.kind,
    trust_state: decision ? TRUST_BY_ACTION[decision.action] : 'proposed',
    // v1 constants: nothing supersedes or contradicts yet (the contract
    // reserves contradiction and explicitly disables it), and nothing is
    // proactively eligible before the gates of steps 4-6 exist.
    standing_state: 'active',
    proactive_policy: 'review_only',
    validity_state: isExpired(claim, { now }) ? 'expired' : 'live',
    freshness_state,
    // Display text, not evidence -- the contract's words. The refs above are
    // the authority; this is what a card may print.
    summary: claim.text,
    evidence_refs: evidence,
    observed_at: claim.observed_at ?? null,
    valid_until: claim.valid_to ?? null,
    recorded_at: claim.created_at,
    derivation_run_id: claim.run_id,
    producer_version: `${claim.model}@${claim.prompt_sha}`,
    ...(decision ? { decided_at: decision.created_at, decided_by: decision.actor } : {}),
  };
}
