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
  sentence: 'Text them to demo the CRM at their studio.',
  role: 'studio founder', focus: 'launching a personal CRM app', label: 'business',
  left: 'ended warmly', leftTone: 'warm',
  evidence: { topics: [], messages: 42, dormancyDays: 300, meetings: 3, lastMeetingDaysAgo: 200 },
  producer_version: 'rm-match-v13',
}, {
  personKey: 'name:second friend', name: 'Second Friend', kind: 'reconnect',
  sentence: 'Text them to co-host the demo day.',
  role: 'event organizer', focus: 'in-person demo day', label: null,
  left: null, leftTone: null,
  evidence: { topics: [], messages: 20, dormancyDays: 250, meetings: 0, lastMeetingDaysAgo: null },
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
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_snapshot').get().n), 2,
      'the offers are immutably recorded before anything is shown');
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(card.name, 'Lapsed Colleague');
    assert.ok(Number.isInteger(card.snapshot_id));
    // 'shown' was recorded by the SERVER on that GET -- the widget records
    // nothing (client-side recording double-counted relaunches; audit).
    const shownRows = db.prepare("SELECT COUNT(*) AS n FROM rm_card_event WHERE event='shown'").get().n;
    assert.equal(Number(shownRows), 1);
    await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM rm_card_event WHERE event='shown'").get().n), 1,
      'a re-fetch of the same pending card records no second shown');
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'accepted' });
    const again = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(again.card?.name, 'Second Friend', 'an acted-on card leaves the queue; the next serves');
    const events = db.prepare('SELECT event FROM rm_card_event ORDER BY id').all().map((r) => r.event);
    // Two distinct cards were handed out (A then, after the accept, B) --
    // each with exactly one server-recorded shown.
    assert.deepEqual(events, ['shown', 'accepted', 'shown']);
  });
});

test('never-this-person from the card suppresses at the door', async () => {
  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'dismissed', reason: 'never-this-person' });
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_suppression').get().n), 1);
    const after = (await (await call('GET', '/admin/relationship/card')).json()).card;
    assert.notEqual(after?.personKey, card.personKey, 'the suppressed person is gone from the queue');
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

test('the cap limits distinct interruptions, and an already-shown card is never a phantom', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(card.name, 'Lapsed Colleague');
    // The popup's follow-up fetch gets the SAME card back -- its own shown
    // row must not eat the last cap slot (the phantom-notification repro).
    const again = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(again.card?.name, 'Lapsed Colleague');
    // But a SECOND distinct card is refused: the window's interruption is spent.
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'dismissed', reason: 'not-useful' });
    const third = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(third.card, null, 'cap of one: the second card waits for tomorrow');
  }, { relationshipCap: { max: 1, windowMs: 86_400_000 } });
});

test('a plain dismissal retires the card', async () => {
  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'dismissed', reason: 'not-useful', note: 'wrong project' });
    const row = { ...db.prepare("SELECT snapshot_id, note FROM rm_card_event WHERE event='dismissed'").get() };
    assert.equal(Number(row.snapshot_id), card.snapshot_id, 'the dismissal keys to its snapshot');
    assert.equal(row.note, 'wrong project', 'the free-text why survives the whole chain');
    const again = await (await call('GET', '/admin/relationship/card')).json();
    assert.notEqual(again.card?.name, 'Lapsed Colleague', 'not-useful actually retires the card');
  });
});

test('the quote rides by reference and dies with its source row', async () => {
  await withServer(async ({ call, db }) => {
    await call('POST', '/ingest', [{ ts: Date.now(), source: 'imessage', entity_id: 'q:1',
      text: 'come demo it at the studio' }]);
    const ctxId = Number(db.prepare('SELECT id FROM context ORDER BY id DESC LIMIT 1').get().id);
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(card.quote, 'come demo it at the studio', 'resolved from the live row at serve time');
    assert.ok(!db.prepare('SELECT evidence FROM rm_candidate_snapshot WHERE id = ?').get(card.snapshot_id)
      .evidence.includes('come demo it'), 'the snapshot holds a reference, never the quoted text');
    await call('POST', '/admin/delete-entities', { source: 'imessage', entity_ids: ['q:1'] });
    const after = await (await call('GET', '/admin/relationship/card')).json();
    assert.notEqual(after.card?.name, 'Lapsed Colleague',
      'source deleted: the card cannot show its receipt, so it does not show');
  }, { relationshipMatcher: async (svc) => {
    const db2 = svc.db();
    const cid = Number(db2.prepare('SELECT id FROM context ORDER BY id DESC LIMIT 1').get().id);
    return { cards: [ { ...structuredClone(STUB_CARDS[0]), quoteContextId: cid } ], focus: 'x', currentTopics: [] };
  } });
});

test('mute records the event and quiets the person', async () => {
  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'muted', mute_days: 30 });
    const after = (await (await call('GET', '/admin/relationship/card')).json()).card;
    assert.notEqual(after?.personKey, card.personKey, 'the muted person is quiet; the queue moves on');
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
