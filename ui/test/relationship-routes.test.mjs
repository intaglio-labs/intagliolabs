// The orb's card surface (L5 step 10): refresh builds and snapshots cards,
// GET serves them through the display-time gate, POST records outcomes into
// the same append-only machinery the eval loop reads. Matcher stubbed: these
// are route tests, and the model has its own graded ledger.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start, openDb } from '../server/hermes.mjs';
import { produceOweBatch } from '../server/relationship/owe.mjs';
import { produceBatch } from '../server/relationship/producer.mjs';

const TOKEN = 'e'.repeat(64);
const CAP = { max: 5, windowMs: 86_400_000 };
const DAY = 86_400_000;

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
    // Isolated from the machine's config: these tests exercise the matcher
    // path, and the owner's config on a dev Mac may select the eligibility
    // producer. Same reason relationshipCap is pinned above.
    relationshipProducerConfig: { producer: 'matcher', mode: 'any' },
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

// /admin/relationship/event used to hardcode kind:'reconnect' and
// ruleVersion:MATCH_RULES_VERSION in every branch (mute/dismiss/recordEvent),
// so a verdict on a card from any OTHER producer's snapshot -- kind and
// producer_version both -- landed misfiled. The fix reads both off the named
// snapshot; this drives a card whose snapshot kind is 'owe' through mute,
// dismiss (with 'not-this-kind'), and a plain event, checking each lands
// under 'owe'/'owe-v1', never 'reconnect'/rm-match's version.
test("an event's kind and rule_version come from the snapshot, not a hardcoded 'reconnect'", async () => {
  const OWE_CARDS = [{
    personKey: 'name:owe person', name: 'Owe Person', kind: 'owe',
    sentence: 'You said you would, and that came due 9 days ago.',
    role: 'friend', focus: null, label: null, left: null, leftTone: null,
    evidence: { owe_kind: 'owe:expired-commitment', overdueDays: 9 },
    producer_version: 'owe-v1',
  }];
  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(card.kind, 'owe');

    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'muted', mute_days: 30 });
    const muteRow = db.prepare('SELECT kind FROM rm_mute ORDER BY id DESC LIMIT 1').get();
    assert.equal(muteRow.kind, 'owe', 'the mute recorded under the snapshot\'s own kind');
    const mutedEvent = db.prepare("SELECT kind, rule_version FROM rm_card_event WHERE event = 'muted'").get();
    assert.equal(mutedEvent.kind, 'owe');
    assert.equal(mutedEvent.rule_version, 'owe-v1');
  }, { relationshipMatcher: async () => ({ cards: structuredClone(OWE_CARDS), focus: 'x', currentTopics: [] }) });

  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'dismissed', reason: 'not-this-kind' });
    const dismissedEvent = db.prepare("SELECT kind, rule_version, reason FROM rm_card_event WHERE event = 'dismissed'").get();
    assert.equal(dismissedEvent.kind, 'owe');
    assert.equal(dismissedEvent.rule_version, 'owe-v1');
    assert.equal(dismissedEvent.reason, 'not-this-kind');
    const muteRow = db.prepare('SELECT person_key, kind FROM rm_mute').get();
    assert.equal(muteRow.person_key, card.personKey);
    assert.equal(muteRow.kind, 'owe', 'not-this-kind mutes under the card\'s own kind, not reconnect');
  }, { relationshipMatcher: async () => ({ cards: structuredClone(OWE_CARDS), focus: 'x', currentTopics: [] }) });

  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'opened' });
    const openedEvent = db.prepare("SELECT kind, rule_version FROM rm_card_event WHERE event = 'opened'").get();
    assert.equal(openedEvent.kind, 'owe');
    assert.equal(openedEvent.rule_version, 'owe-v1');
  }, { relationshipMatcher: async () => ({ cards: structuredClone(OWE_CARDS), focus: 'x', currentTopics: [] }) });
});

test('a repeated accepted for the same snapshot inserts once and reports duplicate', async () => {
  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    const first = await (await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'accepted' })).json();
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, undefined, 'the first verdict is not a duplicate');
    const second = await (await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'accepted' })).json();
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true, 'the repeat (e.g. a triple-click) is reported, not silently accepted');
    assert.equal(second.existing.event, 'accepted');
    const n = Number(db.prepare(
      "SELECT COUNT(*) AS n FROM rm_card_event WHERE snapshot_id = ? AND event = 'accepted'"
    ).get(card.snapshot_id).n);
    assert.equal(n, 1, 'exactly one accepted row landed for this snapshot, no matter how many posts arrived');
  });
});

test('a dismissed after an accepted for the same snapshot also does not insert', async () => {
  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'accepted' });
    const res = await (await call('POST', '/admin/relationship/event', { snapshot_id: card.snapshot_id,
      person_key: card.personKey, event: 'dismissed', reason: 'not-useful' })).json();
    assert.equal(res.duplicate, true, 'a snapshot already judged accepted refuses a later dismissed too');
    const rows = db.prepare(
      'SELECT event FROM rm_card_event WHERE snapshot_id = ? ORDER BY id'
    ).all(card.snapshot_id).map((r) => r.event);
    assert.deepEqual(rows.filter((e) => e === 'accepted' || e === 'dismissed'), ['accepted'],
      'no dismissed row was written once an accepted already existed');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_suppression').get().n), 0,
      'the refused dismissed carried no suppression side effect either, even with reason never-this-person-adjacent');
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

test('a restart hydrates cards from the last committed batch, without a refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-routes-hydrate-'));
  const dbPath = join(dir, 'context.db');
  const now = Date.now();

  // Seed one batch and two snapshots directly, in the exact shape the refresh
  // route itself writes -- no refresh ever runs in this test.
  const seed = openDb(dbPath);
  const batchId = Number(
    seed.prepare(
      'INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, ?, ?, ?)'
    ).run(now, 2, 'open', null).lastInsertRowid
  );
  const insSnap = seed.prepare(
    'INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const snap1 = Number(insSnap.run(
    batchId, 'name:sam carter', 'reconnect', 'Text them to demo the launch.',
    JSON.stringify({
      quote_context_id: null, role: 'studio founder', focus: 'launching a personal CRM app',
      label: 'business', left: 'ended warmly', leftTone: 'warm',
      messages: 42, dormancyDays: 300, meetings: 3, lastMeetingDaysAgo: 200, topics: [],
    }),
    'rm-match-v13', 'combined-v13', now,
  ).lastInsertRowid);
  insSnap.run(
    batchId, 'name:second friend', 'reconnect', 'Text them to co-host demo day.',
    JSON.stringify({
      quote_context_id: null, role: 'event organizer', focus: 'in-person demo day', label: null,
      left: null, leftTone: null, messages: 20, dormancyDays: 250, meetings: 0,
      lastMeetingDaysAgo: null, topics: [],
    }),
    'rm-match-v13', 'combined-v13', now,
  );
  seed.close();

  const server = await start({
    port: 0, dbPath, llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN, relationshipCap: CAP,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/admin/relationship/card`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const { card } = await res.json();
    assert.ok(card, 'the card queue is populated straight from the DB -- no refresh was called');
    assert.equal(card.snapshot_id, snap1);
    assert.equal(card.sentence, 'Text them to demo the launch.');
    assert.equal(card.personKey, 'name:sam carter');
    assert.equal(card.evidence.messages, 42);
    assert.equal(card.evidence.dormancyDays, 300);
    assert.equal(card.evidence.meetings, 3);
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// Lint routes (step 5½): closed-field/param rejections, /stats.lint's shape,
// and the pre-migration null guard -- the checks and the pass itself are
// covered directly against lint.mjs in relationship-lint.test.mjs.
// ---------------------------------------------------------------------------

test('lint routes reject unknown fields/params, and "gone"/an unrecognized resolution 400s', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('POST', '/admin/relationship/lint', { bogus: true })).status, 400);
    assert.equal((await call('GET', '/admin/relationship/lint/findings?bogus=1')).status, 400);
    assert.equal(
      (await call('POST', '/admin/relationship/lint/resolve', { findingKey: 'x', resolution: 'dismiss', bogus: true })).status,
      400
    );
    assert.equal((await call('POST', '/admin/relationship/lint/resolve', { findingKey: 'x', resolution: 'gone' })).status, 400);
    assert.equal((await call('POST', '/admin/relationship/lint/resolve', { findingKey: 'x', resolution: 'nonsense' })).status, 400);

    // A dismiss on a finding that does not exist is a no-op, not a 400 --
    // 'dismiss' is check-agnostic, so there is no check_name to look up first.
    const missingDismiss = await call('POST', '/admin/relationship/lint/resolve', { findingKey: 'no-such-key', resolution: 'dismiss' });
    assert.equal(missingDismiss.status, 200);
    assert.equal((await missingDismiss.json()).applied, false);

    // A role choice needs a real role_conflict finding to validate the
    // check_name against, so a missing key 400s instead.
    assert.equal(
      (await call('POST', '/admin/relationship/lint/resolve', { findingKey: 'no-such-key', resolution: 'keep-export' })).status,
      400
    );
  });
});

test('/stats carries a lint key with the expected shape after a pass', async () => {
  await withServer(async ({ call }) => {
    const result = await (await call('POST', '/admin/relationship/lint', {})).json();
    assert.equal(result.status, 'complete');
    assert.ok(Array.isArray(result.checks_run));
    assert.ok(result.counts && typeof result.counts === 'object');

    const stats = await (await call('GET', '/stats')).json();
    assert.ok(stats.lint, '/stats carries a lint key');
    assert.equal(stats.lint.lastPassStatus, 'complete');
    assert.equal(typeof stats.lint.open, 'number');
    assert.ok(stats.lint.openByCheck && typeof stats.lint.openByCheck === 'object');
    assert.equal(typeof stats.lint.dismissed, 'number');
    assert.equal(typeof stats.lint.newLastPass, 'number');
    assert.equal(typeof stats.lint.closedLastPass, 'number');
    assert.ok(Array.isArray(stats.lint.truncated));
    assert.ok(Array.isArray(stats.lint.checks));
  });
});

test('/stats.lint is null, not a crash, against a pre-lint-migration database', async () => {
  await withServer(async ({ call, db }) => {
    db.exec('DROP TABLE lint_finding');
    db.exec('DROP TABLE lint_run');
    const res = await call('GET', '/stats');
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(stats.lint, null);
  });
});

test('/stats carries a cards key with the expected per-kind shape', async () => {
  await withServer(async ({ call, db }) => {
    await call('POST', '/admin/relationship/refresh'); await settle();
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', {
      snapshot_id: card.snapshot_id, person_key: card.personKey, event: 'accepted',
    });

    const stats = await (await call('GET', '/stats')).json();
    assert.ok(stats.cards, '/stats carries a cards key');
    assert.equal(typeof stats.cards.windowDays, 'number');
    assert.equal(typeof stats.cards.since, 'number');
    for (const scope of [stats.cards.perKind, stats.cards.allTime]) {
      for (const kind of ['owe', 'reconnect']) {
        const k = scope[kind];
        assert.ok(k, `${kind} present`);
        for (const field of ['shown', 'opened', 'accepted', 'dismissed', 'muted', 'suppressed', 'daysServed']) {
          assert.equal(typeof k[field], 'number');
        }
        assert.ok(k.dismissReasons && typeof k.dismissReasons === 'object');
        assert.equal(k.verdict, undefined, 'no verdict field');
      }
    }
    // The stub matcher's cards all carry kind='reconnect' (see STUB_CARDS
    // above); this test's own accept lands there, not under 'owe'.
    assert.equal(stats.cards.allTime.reconnect.shown, 1);
    assert.equal(stats.cards.allTime.reconnect.accepted, 1);
    assert.equal(stats.cards.allTime.reconnect.acceptRate, 1);
    assert.equal(stats.cards.allTime.owe.shown, 0);
    assert.equal(stats.cards.allTime.owe.acceptRate, null);
  });
});

test('/stats.cards is null, not a crash, against a pre-migration database', async () => {
  await withServer(async ({ call, db }) => {
    db.exec('DROP TABLE rm_card_event');
    const res = await call('GET', '/stats');
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(stats.cards, null);
  });
});

// ---------------------------------------------------------------------
// Owe wired into the card route (L5 follow-on step 8): the eligibility
// producer config, both producers sharing rel.cards/rel.batch, per-kind
// alternation via daily.mjs. Fixtures write people/person_event_links/claim
// rows directly on server.db, same discipline as relationship-producer.test.mjs
// and relationship-owe.test.mjs.

async function withEligibilityServer(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-routes-owe-'));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
    ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try { await fn({ call, db: server.db }); } finally { await server.close(); }
}

function insertPersonRow(db, { key, name, role = 'friend', subRoles = [], sent, received, met = 0 }, now) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, now - 400 * DAY, now - 10 * DAY, now - 10 * DAY, now - 10 * DAY,
    sent, received, met, 0, sent + received, 0, role, '{}', null, now, JSON.stringify(subRoles));
}
function insertActiveDayRow(db, key, activeDay) {
  db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)').run(key, activeDay);
}
function isoDay(now, offsetDays) { return new Date(now - offsetDays * DAY).toISOString().slice(0, 10); }

function insertMessage(db, key, { ts, text = 'hi', authored = 0, ownerAuthored = 0, room = 0 } = {}) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, '{}')"
  ).run(ts, text).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', ?, ?, ?, 1, 'conv')`
  ).run(key, ctxId, authored ? 1 : 0, ownerAuthored ? 1 : 0, room ? 1 : 0);
  return ctxId;
}

// Seeds a reconnect-eligible person (producer.mjs's own gates: two-way
// history, authored, quiet >= 180 days) so a reconnect candidate is always
// available alongside whatever Owe fixture a test adds.
function seedReconnectCandidate(db, key, name, now) {
  insertPersonRow(db, { key, name, sent: 20, received: 20 }, now);
  insertMessage(db, key, { ts: now - 200 * DAY, authored: 1 });
  insertActiveDayRow(db, key, isoDay(now, 200));
}

// Seeds an owe:open-loop-eligible person: an authored, direct-message
// question 12 days ago, never answered.
function seedOweOpenLoopCandidate(db, key, name, now, text = 'can you send that over?') {
  insertPersonRow(db, { key, name, sent: 10, received: 10 }, now);
  insertMessage(db, key, { ts: now - 12 * DAY, text, authored: 1 });
}

function insertDistillRun(db, now) {
  return Number(db.prepare(
    `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context,
       rows_in, claims_out, status, started_at, ended_at)
     VALUES ('test-model', 'test/prompt.md', 'sha', '{}', 'on', 1, 1, 'complete', ?, ?)`
  ).run(now, now).lastInsertRowid);
}
function insertOwnerCommitmentClaim(db, { runId, text = 'I will send the deck', observedAt, validTo }) {
  return Number(db.prepare(
    `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
     VALUES (?, 'owner', NULL, 'commitment', ?, ?, ?, NULL, ?)`
  ).run(runId, text, observedAt, validTo, observedAt).lastInsertRowid);
}
function acceptClaim(db, claimId, now) {
  db.prepare("INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, 'accept', 'owner', NULL, ?)").run(claimId, now);
}
function rejectClaim(db, claimId, now) {
  db.prepare("INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, 'reject', 'owner', NULL, ?)").run(claimId, now);
}
function insertClaimSource(db, { claimId, contextId, quote = 'quote' }) {
  db.prepare(
    "INSERT INTO claim_source(claim_id, context_id, source, entity_id, content_hash, quote) VALUES (?, ?, 'imessage', NULL, NULL, ?)"
  ).run(claimId, contextId, quote);
}

// Seeds an owe:expired-commitment (B1) candidate: an accepted owner
// commitment claim whose valid_to is already past, sourced off a direct
// message with this person.
function seedOweCommitmentCandidate(db, key, name, now, { text = 'I will follow up' } = {}) {
  insertPersonRow(db, { key, name, sent: 10, received: 10 }, now);
  const runId = insertDistillRun(db, now);
  const observedAt = now - 100 * DAY;
  const validTo = now - 20 * DAY;
  const claimId = insertOwnerCommitmentClaim(db, { runId, text, observedAt, validTo });
  acceptClaim(db, claimId, observedAt);
  const ctx = insertMessage(db, key, { ts: observedAt, text: 'sounds good', ownerAuthored: 1 });
  insertClaimSource(db, { claimId, contextId: ctx, quote: 'sounds good' });
  return { claimId };
}

// A built page item (person_page_item), accepted, in one section -- same
// shape pages.mjs's own storePage writes, built directly here rather than
// through the engine.
function insertPageItem(db, { personKey, section, text, now }) {
  const runId = insertDistillRun(db, now);
  const claimId = Number(db.prepare(
    `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
     VALUES (?, 'person', ?, 'fact', ?, NULL, NULL, NULL, ?)`
  ).run(runId, personKey, text, now).lastInsertRowid);
  acceptClaim(db, claimId, now);
  db.prepare('INSERT INTO person_page_item(claim_id, section, built_at) VALUES (?, ?, ?)').run(claimId, section, now);
  return claimId;
}

test('the route serves an Owe card with no page, and records shown under kind=owe', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedOweOpenLoopCandidate(db, 'name:owe route one', 'Owe Route One', now);

    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.ok(out.card, 'an owe card is served even with no page built');
    assert.equal(out.card.kind, 'owe');
    assert.equal(out.card.page.sections.who, null);

    const shown = db.prepare("SELECT kind FROM rm_card_event WHERE event = 'shown'").get();
    assert.equal(shown.kind, 'owe');
  });
});

test('accepting an Owe card records kind=owe, rule_version=owe-v1', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedOweOpenLoopCandidate(db, 'name:owe route accept', 'Owe Route Accept', now);

    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', {
      snapshot_id: card.snapshot_id, person_key: card.personKey, event: 'accepted',
    });
    const accepted = db.prepare("SELECT kind, rule_version FROM rm_card_event WHERE event = 'accepted'").get();
    assert.equal(accepted.kind, 'owe');
    assert.equal(accepted.rule_version, 'owe-v1');
  });
});

test("not-this-kind on an Owe card writes rm_mute person+kind='owe'; reconnect keeps serving", async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedOweOpenLoopCandidate(db, 'name:owe route kind', 'Owe Route Kind', now);
    seedReconnectCandidate(db, 'name:reconnect route kind', 'Reconnect Route Kind', now);

    const first = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(first.card.kind, 'owe', 'owe goes first (control, and never shown yet)');
    await call('POST', '/admin/relationship/event', {
      snapshot_id: first.card.snapshot_id, person_key: first.card.personKey,
      event: 'dismissed', reason: 'not-this-kind',
    });
    const mute = db.prepare('SELECT person_key, kind FROM rm_mute').get();
    assert.equal(mute.person_key, 'name:owe route kind');
    assert.equal(mute.kind, 'owe');

    const second = await (await call('GET', '/admin/relationship/card')).json();
    assert.ok(second.card, 'reconnect still serves after an owe not-this-kind dismissal');
    assert.equal(second.card.kind, 'reconnect');
  });
});

test('an Owe card\'s sentence stays the template even when the person has a how_left page item', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    const key = 'name:owe route sentence';
    seedOweOpenLoopCandidate(db, key, 'Owe Route Sentence', now);
    insertPageItem(db, { personKey: key, section: 'how_left', text: 'Ended the call on good terms.', now });

    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card.kind, 'owe');
    assert.ok(out.card.sentence.includes('They asked you something'), 'the owe template sentence, unchanged');
    assert.ok(!out.card.sentence.includes('Ended the call'), 'the page how_left text never substitutes on an owe card');
  });
});

test('a restart hydrates BOTH kinds, and recovers rel.mode from the reconnect batch even when Owe is the newer one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-routes-owe-hydrate-'));
  const dbPath = join(dir, 'context.db');
  const opts = {
    port: 0, dbPath, llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN, relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
  };
  const now = Date.now();

  const first = await start(opts);
  try {
    const db = first.db;
    // Tagged 'investor' so mode='investor' below actually finds them --
    // eligiblePool's own mode gate, not incidental to what this test checks.
    insertPersonRow(db, { key: 'name:hydrate reconnect', name: 'Hydrate Reconnect', subRoles: ['investor'], sent: 20, received: 20 }, now);
    insertMessage(db, 'name:hydrate reconnect', { ts: now - 200 * DAY, authored: 1 });
    insertActiveDayRow(db, 'name:hydrate reconnect', isoDay(now, 200));
    seedOweOpenLoopCandidate(db, 'name:hydrate owe', 'Hydrate Owe', now);

    // Reconnect's batch is produced FIRST, under mode='investor'; Owe's batch
    // is produced SECOND (chronologically newer). rel.mode must still
    // recover 'investor' -- from the reconnect batch specifically, never
    // from whichever batch happens to be newest.
    const reconnectResult = produceBatch(db, { mode: 'investor', now });
    assert.equal(reconnectResult.cards.length, 1);
    produceOweBatch(db, { now: now + 1000 });

    // A SECOND investor-tagged person, added only AFTER batch #1 was
    // produced: absent from both batches above, so it is untouched by the
    // "already shown" cooldown the first candidate picks up once served
    // below, and is exactly who the post-restart refresh (further down)
    // should find if -- and only if -- it correctly re-derives mode='investor'.
    insertPersonRow(db, { key: 'name:hydrate reconnect fresh', name: 'Hydrate Reconnect Fresh', subRoles: ['investor'], sent: 20, received: 20 }, now);
    insertMessage(db, 'name:hydrate reconnect fresh', { ts: now - 200 * DAY, authored: 1 });
    insertActiveDayRow(db, 'name:hydrate reconnect fresh', isoDay(now, 200));
  } finally {
    await first.close();
  }

  const second = await start(opts);
  try {
    const base = `http://127.0.0.1:${second.port}`;
    const call = (method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // Neither kind has ever been shown: pickProducer's tie resolves to
    // CARD_PRODUCERS[0] ('owe'), and the hydrated owe card serves with no
    // new production.
    const firstCard = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(firstCard.card.kind, 'owe');
    assert.equal(firstCard.card.personKey, 'name:hydrate owe');
    await call('POST', '/admin/relationship/event', {
      snapshot_id: firstCard.card.snapshot_id, person_key: firstCard.card.personKey, event: 'dismissed',
    });

    // Owe was just shown; reconnect (never shown) goes next -- the hydrated
    // reconnect card serves, proving it survived the restart too.
    const secondCard = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(secondCard.card.kind, 'reconnect');
    assert.equal(secondCard.card.personKey, 'name:hydrate reconnect');

    // Mode recovery: an explicit refresh with no mode in the body falls back
    // to rel.mode ?? producerConfig.mode. producerConfig.mode here is 'any';
    // the new reconnect batch's evidence.mode must read 'investor' (the
    // reconnect batch's own mode), not 'any' (the config default a failed
    // recovery would fall back to).
    await call('POST', '/admin/relationship/refresh', {});
    const newest = second.db.prepare(
      "SELECT person_key, evidence FROM rm_candidate_snapshot WHERE kind = 'reconnect' ORDER BY id DESC LIMIT 1"
    ).get();
    assert.equal(newest.person_key, 'name:hydrate reconnect fresh',
      'the new refresh found the fresh investor candidate -- proof mode=investor was actually used');
    assert.equal(JSON.parse(newest.evidence).mode, 'investor');
  } finally {
    await second.close();
  }
});

test('an expired-commitment card whose claim is rejected between produce and serve is dropped', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    const key = 'name:owe route rejected claim';
    const { claimId } = seedOweCommitmentCandidate(db, key, 'Owe Route Rejected Claim', now);

    // Produce the batch directly (simulating an earlier request/cycle that
    // already ran the producer), THEN reject the claim -- the race this test
    // targets. The very first card-route call after this hydrates rel.cards
    // from what was already produced and must drop the card at serve time.
    produceOweBatch(db, { now });
    rejectClaim(db, claimId, now);

    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card, null, 'the rejected-between-produce-and-serve card is dropped, not shown');
  });
});
