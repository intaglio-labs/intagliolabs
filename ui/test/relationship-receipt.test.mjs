// L5 step 3: person claims ride the SAME deletion cascade as owner claims,
// and the deterministic receipt renderer derives the item-contract states
// from what hermes already stores. The cascade half is tested through the
// real server paths -- rule 7: grepping for the cascade is not evidence that
// person claims are in it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, insertRows, applyMemoryBatch, decideClaim, start } from '../server/hermes.mjs';
import { renderClaimReceipt } from '../server/relationship/receipt.mjs';
import { createRelationshipMemory } from '../server/relationship/service.mjs';

const TOKEN = 'e'.repeat(64);
const NOW = Date.now();
const RUN = Object.freeze({
  model: 'qwen3-8b', prompt_path: 'prompts/extract_claims.md',
  prompt_sha: 'a'.repeat(64), params: { temperature: 0 },
});

function seedAndClaim(db, { subject = 'person', key = 'name:jane doe' } = {}) {
  insertRows(db, [{ ts: NOW - 1000, source: 'imessage', entity_id: 'e:1',
    text: 'lunch with jane on friday', meta: { is_from_me: true } }]);
  const contextId = Number(db.prepare('SELECT id FROM context ORDER BY id DESC LIMIT 1').get().id);
  applyMemoryBatch(db, { run: RUN, claims: [{
    kind: 'commitment', text: 'The owner owes Jane lunch.',
    ...(subject === 'person' ? { subject, subject_person_key: key } : {}),
    source: { context_id: contextId, quote: 'lunch with jane' },
  }] });
  return { contextId, claimId: Number(db.prepare('SELECT id FROM claim ORDER BY id DESC LIMIT 1').get().id) };
}

test('the receipt carries the item contract, derived not stored', () => {
  const db = openDb(':memory:');
  const { contextId, claimId } = seedAndClaim(db);
  const r = renderClaimReceipt(db, claimId, { now: NOW });
  assert.deepEqual(r.person_keys, ['name:jane doe']);
  assert.equal(r.kind, 'commitment');
  assert.equal(r.trust_state, 'proposed');
  assert.equal(r.standing_state, 'active');
  assert.equal(r.proactive_policy, 'review_only');
  assert.equal(r.validity_state, 'live');
  assert.equal(r.freshness_state, 'current');
  assert.equal(r.summary, 'The owner owes Jane lunch.');
  assert.equal(r.evidence_refs.length, 1);
  const e = r.evidence_refs[0];
  assert.equal(e.context_id, contextId);
  assert.equal(e.quote, 'lunch with jane');
  assert.ok(e.present && e.unchanged);
  assert.equal(typeof r.recorded_at, 'number');
  assert.equal(r.producer_version, `${RUN.model}@${RUN.prompt_sha}`);
  assert.equal(r.derivation_run_id, 1);
  assert.equal(renderClaimReceipt(db, 9999), null);
});

test('trust_state follows the LATEST decision, same ordering as v_claim_accepted', () => {
  const db = openDb(':memory:');
  const { claimId } = seedAndClaim(db);
  decideClaim(db, { claim_id: claimId, action: 'accept' });
  assert.equal(renderClaimReceipt(db, claimId).trust_state, 'accepted');
  // A later retraction outranks the acceptance; nothing is rewritten.
  db.prepare("INSERT INTO claim_decision(claim_id, action, actor, created_at) VALUES (?, 'retract', 'owner', ?)")
    .run(claimId, NOW + 60_000);
  assert.equal(renderClaimReceipt(db, claimId).trust_state, 'retracted');
});

test('an expired commitment reads expired, a live one live', () => {
  const db = openDb(':memory:');
  const { claimId } = seedAndClaim(db);
  db.prepare("INSERT INTO distill_run(model, prompt_path, prompt_sha, params, rows_in, claims_out, status, started_at) VALUES ('m','p','s','{}',0,0,'complete',1)").run();
  // valid_to in the past; direct insert because validToFor derives expiry from
  // text and the renderer's arithmetic is what is under test here.
  db.prepare(
    "INSERT INTO claim(run_id, subject, subject_person_key, kind, text, valid_to, created_at) " +
      "VALUES (2, 'person', 'name:jane doe', 'commitment', 'was due yesterday', ?, ?)"
  ).run(NOW - 86_400_000, NOW);
  const expiredId = Number(db.prepare('SELECT id FROM claim ORDER BY id DESC LIMIT 1').get().id);
  db.prepare("INSERT INTO claim_source(claim_id, context_id, source, quote) VALUES (?, 1, 'imessage', 'lunch')").run(expiredId);
  assert.equal(renderClaimReceipt(db, expiredId, { now: NOW }).validity_state, 'expired');
  assert.equal(renderClaimReceipt(db, claimId, { now: NOW }).validity_state, 'live');
});

test('freshness degrades to stale and source_missing -- the hole detectors', () => {
  const db = openDb(':memory:');
  const { contextId, claimId } = seedAndClaim(db);
  // These states should be unreachable through hermes, whose cascade deletes
  // the claim in the same transaction as the edit or delete. Reach them with
  // raw SQL precisely BECAUSE the renderer is the detector for that cascade
  // failing.
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare("UPDATE context SET content_hash = 'drifted' WHERE id = ?").run(contextId);
  assert.equal(renderClaimReceipt(db, claimId).freshness_state, 'stale');
  db.prepare('DELETE FROM context WHERE id = ?').run(contextId);
  assert.equal(renderClaimReceipt(db, claimId).freshness_state, 'source_missing');
});

test('the service exposes the renderer over its own handle', () => {
  const db = openDb(':memory:');
  const { claimId } = seedAndClaim(db);
  const svc = createRelationshipMemory({ contextDb: db });
  assert.equal(svc.receiptFor(claimId, { now: NOW }).trust_state, 'proposed');
});

// ---------------------------------------------------------------------------
// The cascade, through the real server paths.
// ---------------------------------------------------------------------------

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'l5-cascade-'));
  const server = await start({ port: 0, dbPath: join(dir, 'context.db'),
    llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body) });
  try { await fn({ post, db: server.db }); } finally { await server.close(); }
}

const PERSON_CLAIM = (contextId) => ({
  kind: 'commitment', text: 'The owner owes Jane lunch.',
  subject: 'person', subject_person_key: 'name:jane doe',
  source: { context_id: contextId, quote: 'lunch with jane' },
});

test('deleting the source entity deletes the person claim and its decisions', async () => {
  await withServer(async ({ post, db }) => {
    assert.equal((await post('/ingest', [{ ts: NOW, source: 'imessage', entity_id: 'im:1',
      text: 'lunch with jane on friday' }])).status, 200);
    const applied = await (await post('/admin/memory/apply', { run: RUN, claims: [PERSON_CLAIM(1)] })).json();
    assert.equal(applied.applied, 1);
    decideClaim(db, { claim_id: 1, action: 'accept' });
    const res = await (await post('/admin/delete-entities', { source: 'imessage', entity_ids: ['im:1'] })).json();
    assert.equal(res.deleted, 1);
    for (const t of ['claim', 'claim_source', 'claim_decision']) {
      assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n), 0,
        `${t} must be empty: a person claim may not outlive its source`);
    }
  });
});

test('editing the source row out from under a person claim deletes it', async () => {
  await withServer(async ({ post, db }) => {
    assert.equal((await post('/ingest', [{ ts: NOW, source: 'imessage', entity_id: 'im:1',
      text: 'lunch with jane on friday' }])).status, 200);
    await post('/admin/memory/apply', { run: RUN, claims: [PERSON_CLAIM(1)] });
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM claim').get().n), 1);
    // Redelivery with different text: an in-place upsert whose content hash
    // breaks the snapshot the claim was read from.
    assert.equal((await post('/ingest', [{ ts: NOW, source: 'imessage', entity_id: 'im:1',
      text: 'actually cancel that' }])).status, 200);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM claim').get().n), 0,
      'the edit invalidated the person claim in the same operation');
  });
});
