// L5 step 5: the three initial categories in one inbox, one review door,
// three pre-existing lifecycles. The load-bearing property throughout is the
// hard stop condition: a permanently suppressed person produces NO item of
// ANY kind.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows, applyMemoryBatch } from '../server/hermes.mjs';
import { createRelationshipMemory } from '../server/relationship/service.mjs';

const NOW = Date.now();
const DAY = 86_400_000;
const RUN = Object.freeze({ model: 'qwen3-8b', prompt_path: 'prompts/extract_claims.md',
  prompt_sha: 'a'.repeat(64), params: { temperature: 0 } });

function spineDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  // The watchdog reads run recency for run-signal sources; real state.db has
  // this table, so the fixture must too or coverage() cannot be asked at all.
  db.exec('CREATE TABLE run_log (connector TEXT, ok INTEGER, finished_ts INTEGER)');
  const ins = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name] of pairs) ins.run(id, name, 'phone', NOW);
  return db;
}

// One person (Dave Lee) who triggers ALL THREE categories: a merge question
// against 'David Lee', a pending commitment claim about him, and an open loop
// (he wrote last, 10 days unanswered). A recent row from a third person keeps
// the imessage source fresh so the loop's coverage gate can pass.
function fixture() {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - 40 * DAY, source: 'imessage', entity_id: 'd:1', text: 'hey', meta: { chat_handle: '+15550001', is_from_me: true } },
    { ts: NOW - 10 * DAY, source: 'imessage', entity_id: 'd:2', text: 'lunch soon?', meta: { chat_handle: '+15550001', is_from_me: false } },
    { ts: NOW - 30 * DAY, source: 'imessage', entity_id: 'v:1', text: 'hi', meta: { chat_handle: '+15550002', is_from_me: false } },
    { ts: NOW - 29 * DAY, source: 'imessage', entity_id: 'v:2', text: 'yo', meta: { chat_handle: '+15550002', is_from_me: true } },
    // Fresh third party: keeps the source alive and answered.
    { ts: NOW - 3_600_000, source: 'imessage', entity_id: 'f:1', text: 'ok', meta: { chat_handle: '+15550003', is_from_me: true } },
    // The owner's message the commitment claim will cite.
    { ts: NOW - 5 * DAY, source: 'imessage', entity_id: 'o:1', text: 'i owe dave lunch', meta: { is_from_me: true } },
  ]);
  const owedRow = Number(ctx.prepare("SELECT id FROM context WHERE entity_id = 'o:1'").get().id);
  applyMemoryBatch(ctx, { run: RUN, claims: [{
    kind: 'commitment', text: 'The owner owes Dave Lee lunch.',
    subject: 'person', subject_person_key: 'name:dave lee',
    source: { context_id: owedRow, quote: 'i owe dave lunch' },
  }] });
  const state = spineDb([
    ['+15550001', 'Dave Lee'], ['+15550002', 'David Lee'], ['+15550003', 'Fresh Friend'],
  ]);
  const res = new DatabaseSync(':memory:');
  return createRelationshipMemory({ contextDb: ctx, stateDb: state, resolutionsDb: res });
}

const kinds = (items) => items.map((i) => i.kind).sort();

test('all three categories appear, each with its own lifecycle actions', () => {
  const svc = fixture();
  const items = svc.inbox({ now: NOW });
  assert.deepEqual(kinds(items), ['explicit_commitment', 'identity_merge', 'open_loop']);
  const merge = items.find((i) => i.kind === 'identity_merge');
  assert.deepEqual(merge.person_keys, ['name:dave lee', 'name:david lee']);
  assert.deepEqual(merge.actions, ['same', 'different']);
  const claim = items.find((i) => i.kind === 'explicit_commitment');
  assert.equal(claim.receipt.trust_state, 'proposed');
  assert.deepEqual(claim.actions, ['accept', 'reject']);
  const loop = items.find((i) => i.kind === 'open_loop');
  assert.equal(loop.evidence.waitingDays, 10);
  assert.ok(!('undefined' in loop), 'no leaked fields');
  assert.match(loop.summary, /unanswered for 10 days/);
});

test('a suppressed person produces no item of any kind -- the hard stop condition', () => {
  const svc = fixture();
  assert.equal(svc.inbox({ now: NOW }).length, 3);
  svc.controls.suppress('name:dave lee', NOW);
  assert.deepEqual(svc.inbox({ now: NOW }), [],
    'merge (either key), commitment, and loop must ALL vanish');
});

test('mute quiets the suggestion, not the review', () => {
  const svc = fixture();
  svc.controls.mute({ personKey: 'name:dave lee', kind: 'open_loop', untilAt: NOW + DAY, now: NOW });
  const items = svc.inbox({ now: NOW });
  assert.deepEqual(kinds(items), ['explicit_commitment', 'identity_merge'],
    'the loop is muted; the commitment still needs deciding');
});

test('review routes each id to its own lifecycle', () => {
  const svc = fixture();
  const items = svc.inbox({ now: NOW });

  // Claim: accept through claim_decision.
  svc.review(items.find((i) => i.kind === 'explicit_commitment').id, { action: 'accept', now: NOW });
  assert.equal(svc.receiptFor(1).trust_state, 'accepted');

  // Merge: 'same' lands in the resolutions store and folds the two people.
  svc.review(items.find((i) => i.kind === 'identity_merge').id, { action: 'same', now: NOW });
  const after = svc.inbox({ now: NOW });
  assert.equal(after.find((i) => i.kind === 'identity_merge'), undefined, 'decided pairs are not re-asked');
  assert.equal(svc.people({ now: NOW }).filter((p) => /^Dav/.test(p.name)).length, 1, 'one merged person');

  // Loop: dismissing with never-this-person is the one-tap permanent control.
  svc.review(after.find((i) => i.kind === 'open_loop').id,
    { action: 'dismiss', reason: 'never-this-person', now: NOW });
  assert.deepEqual(svc.inbox({ now: NOW }).filter((i) => i.person_keys.includes('name:dave lee')), [],
    'suppression reached from the inbox holds across every category');
});

test('a loop the coverage cannot vouch for is not claimed', () => {
  // Same fixture minus the fresh third-party row: the newest imessage row IS
  // the unanswered message, so ingestion cannot be shown to span the window
  // and the "10 days unanswered" claim would rest on a possibly-dead pipe.
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    { ts: NOW - 40 * DAY, source: 'imessage', entity_id: 'd:1', text: 'hey', meta: { chat_handle: '+15550001', is_from_me: true } },
    { ts: NOW - 10 * DAY, source: 'imessage', entity_id: 'd:2', text: 'lunch soon?', meta: { chat_handle: '+15550001', is_from_me: false } },
  ]);
  const svc = createRelationshipMemory({ contextDb: ctx,
    stateDb: spineDb([['+15550001', 'Dave Lee']]) });
  assert.deepEqual(svc.inbox({ now: NOW }).filter((i) => i.kind === 'open_loop'), []);
});

test('the review door validates action against category', () => {
  const svc = fixture();
  assert.throws(() => svc.review('merge:junk', { action: 'accept' }), /'same' or 'different'/);
  assert.throws(() => svc.review('claim:1', { action: 'same' }), /'accept', 'reject' or 'retract'/);
  assert.throws(() => svc.review('loop:name:x', { action: 'accept' }), /'dismiss' or 'mute'/);
  assert.throws(() => svc.review('card:9', { action: 'accept' }), /unknown inbox item id/);
});
