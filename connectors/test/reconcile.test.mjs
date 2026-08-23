// The reconciliation floor. Every case here is about a DELETE that must not
// happen — this is the only code path in the package that destroys the owner's
// rows, and deleting a row takes the claims derived from it, including ones the
// owner reviewed and accepted.
//
// The bug it exists for: reconciliation works by difference, so anything the
// scan did not observe is assumed gone. A scan can return empty while
// succeeding — an expired token surfacing as 200, a filter change, an
// unshared calendar, an unmounted volume — and at the point of the diff that
// is indistinguishable from "the source really is empty". The old code deleted
// the whole window and logged it as successful cleanup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planReconcile } from '../lib/reconcile.mjs';

const held = (...ids) => ids.map((entity_id) => ({ entity_id }));
const many = (n, prefix = 'e') =>
  held(...Array.from({ length: n }, (_, i) => `${prefix}${i}`));

test('an empty scan deletes NOTHING, however much is held', () => {
  // The headline case. No evidence was gathered, so no conclusion may be drawn.
  const plan = planReconcile({ observedIds: new Set(), held: many(40) });
  assert.equal(plan.stale.length, 40, 'the difference is still computed and reportable');
  assert.match(plan.refuse, /observed 0 entities/u);
});

test('an empty scan against an empty store is not a refusal — there is nothing to do', () => {
  const plan = planReconcile({ observedIds: new Set(), held: [] });
  assert.deepEqual(plan.stale, []);
  assert.equal(plan.refuse, null);
});

test('ordinary churn proceeds: a few rows gone from a full window', () => {
  const observedIds = new Set(many(40).map((e) => e.entity_id).slice(0, 37));
  const plan = planReconcile({ observedIds, held: many(40) });
  assert.deepEqual(plan.stale, ['e37', 'e38', 'e39']);
  assert.equal(plan.refuse, null, 'three of forty is a normal poll');
});

test('a poll claiming most of the window vanished is refused', () => {
  // A single incremental poll does not get to decide that 30 of 40 events are
  // gone. If that is real, `run.mjs --purge` is the deliberate path.
  const observedIds = new Set(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
  const plan = planReconcile({ observedIds, held: many(40) });
  assert.equal(plan.stale.length, 30);
  assert.match(plan.refuse, /30 of 40/u);
});

test('the ratio test does not fire on a small window', () => {
  // Deleting 3 of 4 is ordinary churn in a tiny window, not an anomaly — a
  // ratio floor that fired here would refuse normal operation and get removed.
  const plan = planReconcile({ observedIds: new Set(['e0']), held: many(4) });
  assert.deepEqual(plan.stale, ['e1', 'e2', 'e3']);
  assert.equal(plan.refuse, null);
});

test('exactly half is allowed; more than half is not', () => {
  // Pinning the boundary so a later tweak has to be deliberate.
  const halfObserved = new Set(many(20).map((e) => e.entity_id).slice(0, 10));
  assert.equal(planReconcile({ observedIds: halfObserved, held: many(20) }).refuse, null);

  const oneMore = new Set(many(20).map((e) => e.entity_id).slice(0, 9));
  assert.match(planReconcile({ observedIds: oneMore, held: many(20) }).refuse, /11 of 20/u);
});

test('nothing stale means nothing refused, even from an empty scan', () => {
  const plan = planReconcile({ observedIds: new Set(['e0']), held: held('e0') });
  assert.deepEqual(plan.stale, []);
  assert.equal(plan.refuse, null);
});

test('an array of observed ids works as well as a Set', () => {
  const plan = planReconcile({ observedIds: ['e0', 'e1'], held: many(4) });
  assert.deepEqual(plan.stale, ['e2', 'e3']);
  assert.equal(plan.refuse, null);
});

test('a missing or malformed held list is treated as nothing held', () => {
  for (const bad of [undefined, null, 'nope', 42]) {
    const plan = planReconcile({ observedIds: new Set(['e0']), held: bad });
    assert.deepEqual(plan.stale, [], JSON.stringify(bad));
    assert.equal(plan.refuse, null);
  }
});

test('the stale list is always returned so a refusal can be reported', () => {
  // The caller logs how many WOULD have been deleted. If a refusal returned an
  // empty list, the warning could not say how close it came, and a floor
  // nobody can see the effect of is a floor nobody trusts.
  const plan = planReconcile({ observedIds: new Set(), held: many(25) });
  assert.equal(plan.stale.length, 25);
  assert.ok(plan.refuse);
});
