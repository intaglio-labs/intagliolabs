// Tests for the Relationship Memory service (step 1 of the L5 plan): the
// facade wires existing primitives together and adds none of its own logic.
// What is tested here is the WIRING — same humans everywhere, decisions land
// in the shared store, the baseline control stays deterministic — not the
// primitives themselves, which have their own suites.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { createRelationshipMemory } from '../server/relationship/service.mjs';
import { resolutionState } from '../server/people/resolve.mjs';

const NOW = new Date(2027, 0, 1).getTime();
const DAY = 86_400_000;

function spineDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  const ins = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name, kind] of pairs) ins.run(id, name, kind ?? 'phone', NOW);
  return db;
}

// Enough two-way history for one clearly dormant person and one active one.
function fixture() {
  const ctx = openDb(':memory:');
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({ ts: NOW - (400 - i * 10) * DAY, source: 'imessage', entity_id: `d:${i}`, text: 'x',
      meta: { chat_handle: '+18085550100', is_from_me: i % 2 === 0 } });
    rows.push({ ts: NOW - (20 - i * 2) * DAY, source: 'imessage', entity_id: `a:${i}`, text: 'y',
      meta: { chat_handle: '+18085550200', is_from_me: i % 2 === 1 } });
  }
  insertRows(ctx, rows);
  const state = spineDb([
    ['+18085550100', 'Dormant Friend', 'phone'],
    ['+18085550200', 'Active Friend', 'phone'],
  ]);
  return { ctx, state };
}

test('the service refuses to exist without a context db', () => {
  assert.throws(() => createRelationshipMemory({}), /context db/);
});

test('people() folds resolution aliases in, so every consumer sees the same humans', () => {
  const { ctx, state } = fixture();
  const res = new DatabaseSync(':memory:');
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: state, resolutionsDb: res });
  const before = svc.people({ now: NOW });
  assert.ok(before.find((p) => p.name === 'Dormant Friend'));
  assert.ok(before.find((p) => p.name === 'Active Friend'));

  // The owner rules the two are the same person: the service's own decide()
  // must change what its own people() returns, with no other plumbing.
  const [a, b] = [before.find((p) => p.name === 'Dormant Friend').key,
                  before.find((p) => p.name === 'Active Friend').key];
  svc.identity.decide(a, b, 'same', NOW);
  const after = svc.people({ now: NOW });
  assert.equal(after.filter((p) => p.name === 'Dormant Friend' || p.name === 'Active Friend').length, 1,
    'one merged person after the owner says "same"');
});

test('identity.decide writes the SHARED resolutions store, not a parallel ledger', () => {
  const { ctx, state } = fixture();
  const res = new DatabaseSync(':memory:');
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: state, resolutionsDb: res });
  svc.identity.decide('name:a', 'name:b', 'different', NOW);
  // Read back through resolve.mjs directly: the decision must be visible to
  // the rest of the app, not just to the service that recorded it.
  const { differentPairs } = resolutionState(res);
  assert.equal(differentPairs.size, 1);
});

test('identity.decide without a resolutions db throws instead of forgetting', () => {
  const { ctx, state } = fixture();
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: state });
  assert.throws(() => svc.identity.decide('name:a', 'name:b', 'same'), /nowhere durable/);
});

test('the fixed-interval baseline finds the dormant person and not the active one', () => {
  const { ctx, state } = fixture();
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: state });
  const ranked = svc.rank('fixed-interval', svc.people({ now: NOW }),
    { now: NOW, intervalDays: 180, minMessages: 3 });
  assert.deepEqual(ranked.map((p) => p.name), ['Dormant Friend']);
});

test('rank refuses an unknown strategy and a duplicate registration', () => {
  const { ctx, state } = fixture();
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: state });
  assert.throws(() => svc.rank('cleverness', []), /unknown rank strategy/);
  assert.throws(() => svc.registerRankStrategy('fixed-interval', () => []), /already registered/);
  svc.registerRankStrategy('noop', (people) => people);
  assert.deepEqual(svc.rankStrategies().sort(), ['fixed-interval', 'noop']);
});

test('coverage: a live source spans a short dormancy claim, a dead one spans nothing', () => {
  const { ctx, state } = fixture();
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: state });
  // Newest imessage row in the fixture is 12 days old, so with a generous
  // threshold the source is fresh — but it cannot vouch for a dormancy claim
  // shorter than its own silence.
  const cov = svc.coverage({ now: NOW, sources: ['imessage'], staleAfter: { imessage: 30 * DAY } });
  assert.equal(cov.state.imessage, 'fresh');
  assert.equal(cov.spansDormancy('imessage', 180), true);
  assert.equal(cov.spansDormancy('imessage', 5), false,
    'a source quiet for 12 days cannot back a 5-day silence claim');
  // Never-ingested: absent, and it vouches for nothing.
  const cov2 = svc.coverage({ now: NOW, sources: ['whatsapp'], staleAfter: { whatsapp: 30 * DAY } });
  assert.equal(cov2.state.whatsapp, 'absent');
  assert.equal(cov2.spansDormancy('whatsapp', 180), false);
});

test('source registry: contract enforced, empty until step 6', () => {
  const { ctx, state } = fixture();
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: state });
  assert.deepEqual(svc.sources(), []);
  assert.throws(() => svc.registerSource({ name: 'x' }), /source adapter/);
  assert.throws(() => svc.registerSource({ candidates: () => [] }), /source adapter/);
  svc.registerSource({ name: 'messages', candidates: () => [] });
  assert.throws(() => svc.registerSource({ name: 'messages', candidates: () => [] }), /already registered/);
  assert.deepEqual(svc.sources(), ['messages']);
});

test('validity passthrough: an expired commitment is expired here iff hermes says so', () => {
  const { ctx, state } = fixture();
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: state });
  const claim = { kind: 'commitment', valid_to: NOW - DAY };
  assert.equal(svc.validity.isExpired(claim, { now: NOW }), true);
  assert.equal(svc.validity.isExpired({ ...claim, valid_to: NOW + DAY }, { now: NOW }), false);
});
