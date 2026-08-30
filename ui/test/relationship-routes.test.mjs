// The orb's card surface (L5 step 10): refresh builds and snapshots cards,
// GET serves them through the display-time gate, POST records outcomes into
// the same append-only machinery the eval loop reads. Matcher stubbed: these
// are route tests, and the model has its own graded ledger.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start } from '../server/hermes.mjs';

const TOKEN = 'e'.repeat(64);
const CAP = { max: 5, windowMs: 86_400_000 };

const STUB_CARDS = [{
  personKey: 'name:lapsed colleague', name: 'Lapsed Colleague', kind: 'reconnect',
  sentence: 'Text them to demo the CRM at their studio.', quote: '[2024]: come demo it at the studio',
  role: 'studio founder', focus: 'launching a personal CRM app', label: 'business',
  left: 'ended warmly', leftTone: 'warm',
  evidence: { topics: [], messages: 42, dormancyDays: 300, meetings: 3, lastMeetingDaysAgo: 200 },
  producer_version: 'rm-match-v13',
}];

async function withServer(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-routes-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipMatcher: async () => ({ cards: structuredClone(STUB_CARDS), focus: 'x', currentTopics: [] }),
    relationshipCap: CAP,
    ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try { await fn({ call, db: server.db }); } finally { await server.close(); }
}

const settle = () => new Promise((r) => setTimeout(r, 50)); // refresh is fire-and-forget

test('refresh snapshots the batch and card flows through accept', async () => {
  await withServer(async ({ call, db }) => {
    assert.equal((await (await call('POST', '/admin/relationship/refresh')).json()).started, true);
    await settle();
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_snapshot').get().n), 1,
      'the offer is immutably recorded before anything is shown');
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(card.name, 'Lapsed Colleague');
    assert.ok(Number.isInteger(card.snapshot_id));
    // The widget shows it, the owner accepts it.
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'shown' });
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'accepted' });
    const again = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(again.card, null, 'an acted-on card leaves the queue');
    const events = db.prepare('SELECT event FROM rm_card_event ORDER BY id').all().map((r) => r.event);
    assert.deepEqual(events, ['shown', 'accepted']);
  });
});

test('never-this-person from the card suppresses at the door', async () => {
  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'dismissed', reason: 'never-this-person' });
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_suppression').get().n), 1);
    assert.equal((await (await call('GET', '/admin/relationship/card')).json()).card, null);
  });
});

test('the cap fails closed: no configuration, no cards', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card, null);
    assert.equal(out.reason, 'no-cap-configured');
  }, { relationshipCap: null });
});

test('the spent cap closes the door at serve time', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'shown' });
    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card, null, 'one shown, cap of one: nothing more today');
  }, { relationshipCap: { max: 1, windowMs: 86_400_000 } });
});

test('mute records the event and quiets the person', async () => {
  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'muted', mute_days: 30 });
    assert.equal((await (await call('GET', '/admin/relationship/card')).json()).card, null);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_mute').get().n), 1);
  });
});

test('bearerless requests bounce', async () => {
  await withServer(async ({ call }) => {
    const res = await fetch(`http://127.0.0.1:1`, { method: 'GET' }).catch(() => null);
    // real check: same server, wrong auth
  });
  const dir = mkdtempSync(join(tmpdir(), 'rel-routes-'));
  const server = await start({ port: 0, dbPath: join(dir, 'context.db'),
    llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN, relationshipCap: CAP });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/admin/relationship/card`);
    assert.equal(res.status, 401);
  } finally { await server.close(); }
});
