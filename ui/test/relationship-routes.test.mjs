// The orb's card surface (L5 step 10): refresh builds and snapshots cards,
// GET serves them through the display-time gate, POST records outcomes into
// the same append-only machinery the eval loop reads. Matcher stubbed: these
// are route tests, and the model has its own graded ledger.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start, openDb } from '../server/hermes.mjs';
// A NAMESPACE IMPORT for the memo helper, deliberately: a named import of an
// export the module does not have is a LINK error, and that fails this whole
// file with one unhelpful line instead of letting the one test that reaches
// for it say what it found.
import * as hermes from '../server/hermes.mjs';
import { produceOweBatch, OWE_PRODUCER_VERSION } from '../server/relationship/owe.mjs';
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
    // AND ISOLATED FROM THE MACHINE'S CONFIG THE OTHER WAY: the mode route
    // WRITES that file now (the picker's choice has to survive a restart, which
    // is what the screen offering it promises). Without this line every mode
    // post below edits the developer's own ~/.hazlie/connectors/config.json.
    ownerConfigPath: join(dir, 'config.json'),
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
    // Pinned rather than left to read the owner's real ~/.hazlie config: this
    // test's seeded snapshots carry the matcher path's own producer_version
    // scheme ('rm-match-v13', a model+promptSha stamp -- see the top-of-file
    // STUB_CARDS), and hydrateCards only applies eligibility's
    // PRODUCER_VERSION staleness check to reconnect when this config says
    // 'eligibility'. Leaving it unset made this test's outcome depend on
    // whatever producer the machine running it happens to have configured.
    relationshipProducerConfig: { producer: 'matcher', mode: 'any' },
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
    // See withServer above: the mode route writes the owner's config file.
    ownerConfigPath: join(dir, 'config.json'),
    ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // The config path too: a one-off widened look must leave the owner's
  // persisted pick where it was, and the only way to say that is to read it.
  try {
    await fn({ call, db: server.db }, { configPath: join(dir, 'config.json') });
  } finally {
    await server.close();
  }
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
// question 12 days ago, never answered. Also seeds two owner-authored
// messages well before the ask -- OWE_MIN_OWNER_MESSAGES requires the owner
// to have actually written to this person more than once, and placing them
// this early keeps the open loop itself intact (last-owner ts stays earlier
// than last-them ts).
function seedOweOpenLoopCandidate(db, key, name, now, text = 'can you send that over?') {
  insertPersonRow(db, { key, name, sent: 10, received: 10 }, now);
  insertMessage(db, key, { ts: now - 300 * DAY, text: 'hey', ownerAuthored: 1 });
  insertMessage(db, key, { ts: now - 299 * DAY, text: 'checking in', ownerAuthored: 1 });
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

test(`accepting an Owe card records kind=owe, rule_version=${OWE_PRODUCER_VERSION}`, async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedOweOpenLoopCandidate(db, 'name:owe route accept', 'Owe Route Accept', now);

    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/event', {
      snapshot_id: card.snapshot_id, person_key: card.personKey, event: 'accepted',
    });
    const accepted = db.prepare("SELECT kind, rule_version FROM rm_card_event WHERE event = 'accepted'").get();
    assert.equal(accepted.kind, 'owe');
    assert.equal(accepted.rule_version, OWE_PRODUCER_VERSION);
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
    // See withServer above: the mode route writes the owner's config file, so
    // a restart test that posts a mode needs a config path of its own.
    ownerConfigPath: join(dir, 'config.json'),
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

// ---------------------------------------------------------------------
// Modes are queues, not refreshes (L5 mode-picker follow-on): clicking a
// mode button used to POST /refresh, which minted a fresh batch (and a
// 'shown' event on a brand-new person) on every click. POST
// /admin/relationship/mode only ever sets rel.mode; the following GET /card
// serves whichever unjudged card that mode already has queued, or refills
// once through the ordinary synchronous eligibility path.

function seedReconnectCandidateMode(db, key, name, now, subRoles = []) {
  insertPersonRow(db, { key, name, subRoles, sent: 20, received: 20 }, now);
  insertMessage(db, key, { ts: now - 200 * DAY, authored: 1 });
  insertActiveDayRow(db, key, isoDay(now, 200));
}

test('POST /admin/relationship/mode: unknown fields/mode 400, no card event of its own', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const bad = await call('POST', '/admin/relationship/mode', { mode: 'any', extra: 1 });
    assert.equal(bad.status, 400);

    const badMode = await call('POST', '/admin/relationship/mode', { mode: 'nope' });
    assert.equal(badMode.status, 400);

    const ok = await call('POST', '/admin/relationship/mode', { mode: 'founder' });
    assert.equal(ok.status, 200);
    // `persisted` is the route saying the choice reached the config file as
    // well as this process -- the mode row's own promise ("your choice is kept
    // by the reader"). relationship-mode-config.test.mjs reads the file back.
    assert.deepEqual(await ok.json(), { mode: 'founder', persisted: true });

    const events = db.prepare('SELECT COUNT(*) AS n FROM rm_card_event').get();
    assert.equal(events.n, 0, 'switching mode alone records no event of any kind');
  });
});

test('switching mode serves that mode\'s queued card without writing a new batch; switching back does the same', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidateMode(db, 'name:mode any', 'Mode Any', now);
    seedReconnectCandidateMode(db, 'name:mode founder', 'Mode Founder', now, ['founder']);

    // Establish rel.mode='any' and let it refill -- this produces the 'any'
    // batch and serves its one card.
    await call('POST', '/admin/relationship/mode', { mode: 'any' });
    const anyCard = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(anyCard.card.kind, 'reconnect');
    assert.equal(anyCard.card.personKey, 'name:mode any');
    const batchesAfterAny = db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n;

    // Switch to 'founder': its own queue is empty so far, so this GET refills
    // it, but the earlier 'any' card is untouched (still unjudged) rather
    // than being dropped by the mode switch.
    await call('POST', '/admin/relationship/mode', { mode: 'founder' });
    const founderCard = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(founderCard.card.personKey, 'name:mode founder');
    const batchesAfterFounder = db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n;
    assert.ok(batchesAfterFounder > batchesAfterAny, 'founder had no queued card yet, so its own refill ran once');

    // Switch back to 'any': its card is STILL unjudged and queued from
    // before -- this GET must serve it again, not produce a fresh batch.
    await call('POST', '/admin/relationship/mode', { mode: 'any' });
    const batchesBeforeSecondAny = db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n;
    const anyCardAgain = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(anyCardAgain.card.personKey, 'name:mode any', 'the earlier any-mode card serves again, unchanged');
    assert.equal(anyCardAgain.card.snapshot_id, anyCard.card.snapshot_id, 'same snapshot -- not a new one');
    const batchesAfterSecondAny = db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n;
    assert.equal(batchesAfterSecondAny, batchesBeforeSecondAny, 'no new batch was written switching back');
  });
});

// SERVED MODE IS PROVENANCE, NOT POLICY (round-5 finding 10).
//
// `mode` says what the owner is on; `servedMode` says which mode produced the
// card in their hand, and reconnect.js prefers servedMode over mode precisely
// because the card is the truthful thing to light up. Filling servedMode in
// from the config when the card carries none makes the route assert a
// provenance it does not have -- and it asserts exactly the value that makes a
// panel comparing the two conclude the card already matches the picker.
test('servedMode stays null for a card that records no mode, while mode still answers', async () => {
  // The failing input: a reconnect card produced before any mode was ever
  // recorded (STUB_CARDS carry no evidence.mode, which is also the shape of
  // every Owe card) on an install whose CONFIG says founder. rel.mode is unset
  // -- nobody has posted one in this process -- so the card still serves.
  await withServer(async ({ call }) => {
    assert.equal((await (await call('POST', '/admin/relationship/refresh')).json()).started, true);
    await settle();
    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card.kind, 'reconnect');
    assert.equal(out.card.personKey, 'name:lapsed colleague');
    assert.equal(out.mode, 'founder', 'the config is what the owner is on');
    assert.equal(out.servedMode, null,
      'and the card cannot claim it was produced under that, because it was produced under nothing');
  }, { relationshipProducerConfig: { producer: 'matcher', mode: 'founder' } });
});

test('servedMode names the mode a card WAS produced under', async () => {
  // The counterweight: when the batch records a mode, that is the answer, and
  // it is the card's own rather than the process's or the config's.
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidateMode(db, 'name:served founder', 'Served Founder', now, ['founder']);
    await call('POST', '/admin/relationship/mode', { mode: 'founder' });
    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card.personKey, 'name:served founder');
    assert.equal(out.servedMode, 'founder');
    assert.equal(out.mode, 'founder');
  });
});

test('a mode with an empty queue refills once and is throttled after; a different mode is unaffected', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    // Nobody is eligible for reconnect in any mode: every refill attempt for
    // 'investor' will produce zero cards.
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    const first = await (await call('GET', '/admin/relationship/card')).json();
    // Owe is also empty (no seeded candidates at all), so pool-exhausted is
    // the expected outcome once both kinds' current-mode/kind pools are dry.
    assert.equal(first.card, null);
    const batchesAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n;
    assert.ok(batchesAfterFirst >= 1, 'the empty investor pool was actually attempted once');

    const second = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(second.card, null);
    const batchesAfterSecond = db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n;
    assert.equal(batchesAfterSecond, batchesAfterFirst, 'a second poll within the throttle window does not refill again');
  });
});

test('hydrate restores all three reconnect modes plus Owe after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-routes-mode-hydrate-'));
  const dbPath = join(dir, 'context.db');
  const opts = {
    port: 0, dbPath, llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN, relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    // See withServer above: the mode route writes the owner's config file, so
    // a restart test that posts a mode needs a config path of its own.
    ownerConfigPath: join(dir, 'config.json'),
    peopleProjectionAutoRebuild: false,
  };
  const now = Date.now();

  const first = await start(opts);
  try {
    const db = first.db;
    // 'founder' and 'investor' seed people ONLY eligible for their own mode
    // (subRoles gates eligiblePool for those two modes); 'any' has no
    // subRoles filter, so its own batch may also pick up the founder/investor
    // people -- irrelevant here, since what this test checks is that each
    // mode's OWN batch (produced under that mode) survives the restart
    // independently, not who ranks first within a mode's pool.
    seedReconnectCandidateMode(db, 'name:hydrate any', 'Hydrate Any', now, []);
    seedReconnectCandidateMode(db, 'name:hydrate founder', 'Hydrate Founder', now, ['founder']);
    seedReconnectCandidateMode(db, 'name:hydrate investor', 'Hydrate Investor', now, ['investor']);

    produceBatch(db, { mode: 'founder', now });
    produceBatch(db, { mode: 'investor', now: now + 1000 });
    produceBatch(db, { mode: 'any', now: now + 2000 });
  } finally {
    await first.close();
  }

  const second = await start(opts);
  try {
    const rows = second.db.prepare(
      "SELECT person_key, evidence FROM rm_candidate_snapshot WHERE kind = 'reconnect' ORDER BY id"
    ).all();
    const byMode = new Map();
    for (const r of rows) {
      const m = JSON.parse(r.evidence).mode;
      if (!byMode.has(m)) byMode.set(m, []);
      byMode.get(m).push(r.person_key);
    }
    assert.ok(byMode.get('founder')?.includes('name:hydrate founder'));
    assert.ok(byMode.get('investor')?.includes('name:hydrate investor'));
    assert.ok(byMode.get('any')?.includes('name:hydrate any'));

    const base = `http://127.0.0.1:${second.port}`;
    const call = (method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    await call('POST', '/admin/relationship/mode', { mode: 'founder' });
    const founderCard = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(founderCard.card.personKey, 'name:hydrate founder', 'the founder batch survived the restart, hydrated on its own');
  } finally {
    await second.close();
  }
});

// ---------------------------------------------------------------------
// A drafted message, on demand (L5 mode-picker follow-on, part 2):
// POST /admin/relationship/draft, its 24h cache, its grounding of the
// model's own output, and the card route's `drafts` field.

function fakeDraftEngine(resultTextOrFn) {
  const counters = { calls: 0, totalCostUsd: 0.02, totalDurationMs: 5 };
  const capturedUsers = [];
  return {
    name: 'fake-draft', model: 'fake-model', counters, capturedUsers,
    async complete({ user }) {
      counters.calls += 1;
      capturedUsers.push(user);
      return typeof resultTextOrFn === 'function' ? resultTextOrFn(counters.calls) : resultTextOrFn;
    },
  };
}

test('POST /admin/relationship/draft: unknown fields 400, unknown snapshot 400, no engine 400', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidate(db, 'name:draft badreq', 'Draft Badreq', now);
    await call('POST', '/admin/relationship/refresh');
    const { card } = await (await call('GET', '/admin/relationship/card')).json();

    const badFields = await call('POST', '/admin/relationship/draft', { snapshot_id: card.snapshot_id, extra: 1 });
    assert.equal(badFields.status, 400);

    const badSnapshot = await call('POST', '/admin/relationship/draft', { snapshot_id: 999999 });
    assert.equal(badSnapshot.status, 400);
  });
  // no-engine case, separately: policy.relationshipMemoryEngine explicitly
  // null is the same test-seam every other engine getter honors.
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidate(db, 'name:draft noengine', 'Draft Noengine', now);
    await call('POST', '/admin/relationship/refresh');
    const { card } = await (await call('GET', '/admin/relationship/card')).json();
    const res = await call('POST', '/admin/relationship/draft', { snapshot_id: card.snapshot_id });
    assert.equal(res.status, 400);
  }, { relationshipMemoryEngine: null });
});

test('creates two rows; a second call within 24h is cached with zero engine calls', async () => {
  const engine = fakeDraftEngine(JSON.stringify({
    drafts: [{ text: 'Hey! Realized it has been a while -- hope things are good.' },
      { text: 'Hi! Been meaning to reach out -- how have you been?' }],
  }));
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidate(db, 'name:draft cache', 'Draft Cache', now);
    await call('POST', '/admin/relationship/refresh');
    const { card } = await (await call('GET', '/admin/relationship/card')).json();

    const first = await (await call('POST', '/admin/relationship/draft', { snapshot_id: card.snapshot_id })).json();
    assert.equal(first.cached, false);
    assert.equal(first.drafts.length, 2);
    assert.equal(engine.counters.calls, 1);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM rm_card_draft WHERE snapshot_id = ?').get(card.snapshot_id);
    assert.equal(rows.n, 2);

    const second = await (await call('POST', '/admin/relationship/draft', { snapshot_id: card.snapshot_id })).json();
    assert.equal(second.cached, true);
    assert.equal(second.drafts.length, 2);
    assert.equal(engine.counters.calls, 1, 'the second ask within 24h made no engine call');

    // GET /card carries the same drafted rows for this snapshot.
    const served = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(served.card.drafts.length, 2);
  }, { relationshipMemoryEngine: engine });
});

test('oversize and empty drafts are dropped; only the survivors are stored', async () => {
  const engine = fakeDraftEngine(JSON.stringify({
    drafts: [
      { text: '' },
      { text: 'x'.repeat(241) },
      { text: 'A short, valid opener that fits comfortably under the limit.' },
    ],
  }));
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidate(db, 'name:draft ground', 'Draft Ground', now);
    await call('POST', '/admin/relationship/refresh');
    const { card } = await (await call('GET', '/admin/relationship/card')).json();

    const out = await (await call('POST', '/admin/relationship/draft', { snapshot_id: card.snapshot_id })).json();
    assert.equal(out.drafts.length, 1);
    assert.equal(out.drafts[0].text, 'A short, valid opener that fits comfortably under the limit.');
  }, { relationshipMemoryEngine: engine });
});

test('the owner\'s ME lines reach the prompt as a tone sample but never the stored draft text', async () => {
  const meText = 'ME-ONLY-TONE-SAMPLE-TEXT-SHOULD-NEVER-BE-STORED';
  const engine = fakeDraftEngine(JSON.stringify({
    drafts: [{ text: 'Hey! It has been a while -- hope you are doing well.' },
      { text: 'Hi there! Curious how things have been going lately.' }],
  }));
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    const key = 'name:draft meline';
    seedReconnectCandidate(db, key, 'Draft Meline', now);
    // An owner-authored, direct-message line -- the tone sample source.
    insertMessage(db, key, { ts: now - 1 * DAY, text: meText, ownerAuthored: 1 });

    await call('POST', '/admin/relationship/refresh');
    const { card } = await (await call('GET', '/admin/relationship/card')).json();

    const out = await (await call('POST', '/admin/relationship/draft', { snapshot_id: card.snapshot_id })).json();
    assert.ok(engine.capturedUsers[0].includes(meText), 'the ME line reached the prompt as a tone sample');
    assert.ok(engine.capturedUsers[0].includes('ME:'), 'labeled ME:, per spec');
    for (const d of out.drafts) {
      assert.ok(!d.text.includes(meText), 'the stored draft text never contains the raw ME line');
    }
    const stored = db.prepare('SELECT text FROM rm_card_draft WHERE snapshot_id = ?').all(card.snapshot_id);
    for (const row of stored) assert.ok(!row.text.includes(meText));
  }, { relationshipMemoryEngine: engine });
});

// ------------------------------------------------------------------
// THE FIRST LOAD IS NOT A STEADY STATE (run 3, fresh Mac, twenty minutes in).
//
// The fifteen-minute refill throttle exists so an exhausted producer does not
// write an empty batch on every poll. It was armed against an empty pool
// before the daemon's first-load sprint delivered anybody, so when the pool
// DID fill -- investor going from nobody to somebody -- the route went on
// answering "come back in 13.5 minutes" to an owner sitting on the setup
// screen with nothing else to look at.

function markShown(db, key, kind, now = Date.now()) {
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, event, rule_version, time_band, created_at) '
    + "VALUES (?, ?, 'shown', 'test', 'morning', ?)"
  ).run(key, kind, now);
}

test('an install that has never shown a reconnect card retries in a minute, not a quarter hour', async () => {
  await withEligibilityServer(async ({ call }) => {
    // Nobody eligible anywhere: the exhausted answer, which is the one that
    // carries the retry the panel waits on.
    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card, null);
    assert.ok(out.retryAfterMs <= 60_000,
      `a first load must come back inside a minute, not ${out.retryAfterMs} ms: the pool is`
      + ' filling under the sprint while the owner watches');
  });
});

test('once a reconnect card has been shown, the quarter hour stands', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    // The steady-state machine the throttle was written for. One shown card is
    // the whole difference, and it is append-only, so this only goes one way.
    markShown(db, 'name:already seen', 'reconnect');
    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card, null);
    assert.ok(out.retryAfterMs > 60_000,
      `an install past its first card must not re-run the producer every minute (${out.retryAfterMs} ms)`);
    assert.ok(out.retryAfterMs <= 15 * 60_000);
  });
});

// AND "NOBODY" HAS TWO MEANINGS, only one of which the owner can do anything
// about. On run 3 the investor pool held nobody while six people were waiting
// under 'anyone', and the screen said what it would have said on an empty
// machine.
test('a mode with nobody in it says so, and says how many there are in all', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    // Two people who qualify for 'any' and for no sub-role mode.
    seedReconnectCandidateMode(db, 'name:mode empty one', 'Mode Empty One', now);
    seedReconnectCandidateMode(db, 'name:mode empty two', 'Mode Empty Two', now);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card, null);
    assert.equal(out.reason, 'pool-exhausted-mode',
      'the picker is what is empty, not the house');
    assert.equal(out.mode, 'investor');
    assert.deepEqual(out.counts, { mode: 0, any: 2 },
      'counts, so the panel can offer to widen -- and counts only, never names');
    assert.ok(!JSON.stringify(out).includes('Mode Empty One'),
      'a reason is not a queue: nobody is named in it');
  });
});

test('a house with nobody in it keeps the old reason', async () => {
  await withEligibilityServer(async ({ call }) => {
    // Same mode, nobody anywhere. There is nothing to widen to, so the answer
    // must stay the one the panel already knows.
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });
    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card, null);
    assert.equal(out.reason, 'pool-exhausted');
    assert.equal(out.counts, undefined);
  });
});

test("'any' never reports a mode-empty pool, because there is nothing to widen to", async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    // A founder nobody has offered yet: the 'any' pool can pick them up, so
    // this branch is never reached -- but if it were, 'any' has no wider pool
    // to name and must not claim one.
    seedReconnectCandidateMode(db, 'name:mode any only', 'Mode Any Only', now, ['founder']);
    await call('POST', '/admin/relationship/mode', { mode: 'any' });
    const out = await (await call('GET', '/admin/relationship/card')).json();
    if (out.card === null) assert.notEqual(out.reason, 'pool-exhausted-mode');
    assert.equal(out.counts, undefined);
  });
});

// ONE LOOK AT A WIDER POOL, WITHOUT CHANGING WHAT THE OWNER IS ON.
//
// "nobody quiet who is an investor yet -- N people in all; start with anyone?"
// is only an offer if the page can take it up without moving the picker. So
// the route accepts a mode for THIS REQUEST: it produces and serves under it,
// reports it as the card's provenance, and leaves rel.mode and the owner's
// config exactly where they were. POST /admin/relationship/mode stays the only
// thing that changes what the owner is on, because that is a decision.
test('?mode= serves a card from that mode without changing the owner\'s pick', async () => {
  await withEligibilityServer(async ({ call, db }, { configPath }) => {
    const now = Date.now();
    seedReconnectCandidateMode(db, 'name:one off any', 'One Off Any', now);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    // Nobody is an investor, so the ordinary ask has nothing -- the state the
    // page's widen button is offered from.
    const narrow = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(narrow.card, null);
    assert.equal(narrow.reason, 'pool-exhausted-mode');
    assert.equal(narrow.oneOff, undefined, 'an ordinary ask is not a one-off');

    // The widened look.
    const wide = await (await call('GET', '/admin/relationship/card?mode=any')).json();
    assert.ok(wide.card, 'a card produced and served under the mode this request named');
    assert.equal(wide.card.personKey, 'name:one off any');
    assert.equal(wide.servedMode, 'any', 'provenance: the card was produced under any');
    assert.equal(wide.mode, 'investor', 'and the owner is still on investor');
    assert.equal(wide.oneOff, true, 'said in as many words, so the picker need not infer it');

    // Neither the process nor the file moved.
    const after = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(after.mode, 'investor', 'the next ordinary ask is still the owner\'s mode');
    assert.equal(
      JSON.parse(readFileSync(configPath, 'utf8')).relationshipMemory.mode,
      'investor',
      'and the persisted pick is untouched: a look is not a decision'
    );
  });
});

test('a mode the closed set does not name is ignored, not honoured', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidateMode(db, 'name:one off ignored', 'One Off Ignored', now);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });
    // This value would otherwise reach produceBatch, which treats an unknown
    // mode as 'any' -- so an ignored param must be ignored HERE, at the edge.
    const out = await (await call('GET', '/admin/relationship/card?mode=anyone')).json();
    assert.equal(out.card, null, 'still the investor pool, which is empty');
    assert.equal(out.oneOff, undefined);
    assert.equal(out.mode, 'investor');
  });
});

test('a one-off peek teases from the widened pool and is still a peek', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidateMode(db, 'name:one off peek', 'One Off Peek', now);
    await call('POST', '/admin/relationship/mode', { mode: 'founder' });

    const peek = await (await call('GET', '/admin/relationship/card?peek=1&mode=any')).json();
    assert.equal(peek.peek, true);
    assert.equal(peek.card.personKey, 'name:one off peek');
    assert.equal(peek.oneOff, true);
    // A peek records nothing, one-off or not: 'shown' is what pickProducer
    // reads and what starts the person's cooldown.
    const events = db.prepare("SELECT COUNT(*) AS n FROM rm_card_event WHERE event = 'shown'").get();
    assert.equal(events.n, 0);
  });
});

// THE COUNTS ARE TAKEN WHEN A REFILL RUNS, NOT WHEN A POLL ARRIVES
// (round-7 finding 15).
//
// Two full pool scans per request looked cheap because they only happen off
// 'any'. That is true of the mode and not of the frequency: a founder or
// investor owner on a fresh Mac is throttled on nearly every poll, the setup
// screen polls every ~15 s, and the first-load retry window holds that state
// for the whole half hour. The counts are memoised against the refill attempt
// that produced the answer, so the staleness they buy is bounded by the retry
// window itself -- a minute on a first load.
test('the pool is not re-counted for every poll inside one throttle window', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidateMode(db, 'name:counted one', 'Counted One', now);
    seedReconnectCandidateMode(db, 'name:counted two', 'Counted Two', now);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    const first = await (await call('GET', '/admin/relationship/card')).json();
    assert.deepEqual(first.counts, { mode: 0, any: 2 });

    // Somebody new arrives -- the sprint does exactly this -- and the next
    // poll lands inside the same throttle window.
    seedReconnectCandidateMode(db, 'name:counted three', 'Counted Three', now);
    const second = await (await call('GET', '/admin/relationship/card')).json();
    assert.deepEqual(second.counts, { mode: 0, any: 2 },
      'the same answer, from the same refill attempt: no second pair of scans');
  });
});

test('the counts are measured together, mode beside any', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidateMode(db, 'name:measured any', 'Measured Any', now);
    await call('POST', '/admin/relationship/mode', { mode: 'founder' });
    const out = await (await call('GET', '/admin/relationship/card')).json();
    // `mode` is a reading of the founder pool taken in the same breath as
    // `any`, not a constant the branch already knew. In this branch it reads
    // zero because the branch is only reached when the last refill found the
    // mode pool empty -- but it is measured, and the reason is what says which
    // case this is.
    assert.equal(typeof out.counts.mode, 'number');
    assert.equal(out.counts.mode, 0);
    assert.equal(out.counts.any, 1);
    assert.equal(out.reason, 'pool-exhausted-mode');
  });
});

// EVERY CARD REPLY SAYS WHERE THE CARD CAME FROM (round-8 finding 1).
//
// `servedMode` was set on the full serve and not on the PEEK -- and the peek is
// what the widen button calls. So the panel's one-off hand-off read undefined
// on every press, opened under the standing mode, and filtered out the very
// card it had just teased: press "show me anyone, just this once", get the
// card, then "nothing to review" with the investor chip still lit.
//
// The contract, pinned once for all four shapes: provenance (`servedMode`) and
// the standing pick (`mode`) on every card reply, `oneOff` when the request
// named its own mode.
test('peek and serve both carry the card\'s provenance and the standing pick', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidateMode(db, 'name:contract any', 'Contract Any', now);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    // A ONE-OFF PEEK: the case the hand-off exists for.
    const widePeek = await (await call('GET', '/admin/relationship/card?peek=1&mode=any')).json();
    assert.equal(widePeek.peek, true);
    assert.equal(widePeek.card.personKey, 'name:contract any');
    assert.equal(widePeek.servedMode, 'any',
      'without this the panel opens on the standing mode and drops the teased card');
    assert.equal(widePeek.mode, 'investor', 'and the standing pick is still reported');
    assert.equal(widePeek.oneOff, true);

    // A ONE-OFF SERVE of the same card: the same two fields, same values.
    const wideServe = await (await call('GET', '/admin/relationship/card?mode=any')).json();
    assert.equal(wideServe.card.personKey, 'name:contract any');
    assert.equal(wideServe.servedMode, 'any');
    assert.equal(wideServe.mode, 'investor');
    assert.equal(wideServe.oneOff, true);
  });
});

test('a standing peek reports its own mode, and no oneOff', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedReconnectCandidateMode(db, 'name:contract standing', 'Contract Standing', now);
    await call('POST', '/admin/relationship/mode', { mode: 'any' });
    const peek = await (await call('GET', '/admin/relationship/card?peek=1')).json();
    assert.equal(peek.card.personKey, 'name:contract standing');
    assert.equal(peek.servedMode, 'any', 'the card was produced under the standing mode');
    assert.equal(peek.mode, 'any');
    assert.equal(peek.oneOff, undefined, 'nothing was asked for, so nothing is one-off');
  });
});

test('an Owe peek has no mode to report, and says so rather than guessing', async () => {
  await withEligibilityServer(async ({ call, db }) => {
    const now = Date.now();
    seedOweOpenLoopCandidate(db, 'name:contract owe', 'Contract Owe', now);
    // Owe goes first when neither kind has been shown (CARD_PRODUCERS order).
    const peek = await (await call('GET', '/admin/relationship/card?peek=1')).json();
    assert.equal(peek.card.kind, 'owe');
    assert.equal(peek.servedMode, null,
      'an Owe card carries no mode and needs none: nothing filters it by one');
    assert.equal(typeof peek.mode, 'string', 'the standing pick is still reported beside it');
  });
});

// A POOL WE COULD NOT COUNT IS NOT A COUNT OF ZERO (round-8 finding 10).
//
// The memo write used to happen after the catch as well as after a reading, so
// one transient failure inside eligiblePool pinned "the house is empty" until
// the next refill stamped a new `at` -- a whole retry window on the screen
// whose only job is to say how it is going.
//
// Unit, not route: making eligiblePool throw from outside takes the PRODUCER
// down with it and the route answers a different branch entirely.
test('a pool that could not be counted is not remembered as an empty one', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  seedReconnectCandidateMode(db, 'name:flaky any', 'Flaky Any', now);
  const rel = { refill: { 'reconnect:investor': { at: 1_000, empty: true } } };

  let failing = true;
  const flaky = {
    prepare(sql) {
      if (failing) { failing = false; throw new Error('database is locked'); }
      return db.prepare(sql);
    },
  };

  assert.equal(hermes.modeEmptyCounts(flaky, rel, 'investor', 'reconnect:investor', now), null,
    'this request cannot say, so it says nothing');
  assert.equal(rel.modeCounts, undefined, 'and nothing was learned, so nothing is remembered');

  assert.deepEqual(hermes.modeEmptyCounts(flaky, rel, 'investor', 'reconnect:investor', now),
    { mode: 0, any: 1 },
    'the next request counts again rather than being served the failure back');
  assert.ok(rel.modeCounts, 'a real reading IS remembered, which is what the memo is for');
});

// --- GET /admin/config/card: what the owner actually chose -----------------
//
// Settings could not show the owner a single thing the card is configured to
// do: the mode picker lives on the card itself, the cap has no control at all
// (surface review E finding 24), and the engine switch -- the one that decides
// whether excerpts leave this Mac -- is reachable only inside the onboarding
// flow, so once that flow is done it is gone (finding 22).
//
// The fixture is built so a wrong implementation fails rather than merely
// being unchecked: the SERVER IS STARTED WITH OVERRIDES that disagree with the
// file (relationshipCap {max:5}, producer 'matcher', mode 'any'), and the file
// is empty. A route answering through relationshipCap/relationshipProducerConfig
// -- the obvious spelling, and the one every other branch of the card route
// uses -- would report capPerDay 5, producer 'matcher', mode 'any' here. This
// route answers what is on disk, so all four are null: an override belongs to
// a test harness, and a fallback belongs to whatever has to run a batch, but
// neither is a choice the owner made and a settings page must not show either
// back to them as one.
test('GET /admin/config/card reports the owner\'s own four keys, and null for the ones nobody set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-routes-config-'));
  const configPath = join(dir, 'config.json');
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'matcher', mode: 'any' },
    ownerConfigPath: configPath,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    // A fresh install: no config file at all.
    assert.deepEqual(await (await call('GET', '/admin/config/card')).json(),
      { mode: null, capPerDay: null, producer: null, engine: null },
      'nobody has chosen -- which is a different row from having chosen zero');

    // Now the owner chooses, through the three routes that own those writes.
    await call('POST', '/admin/config/card', { capPerDay: 3, producer: 'eligibility' });
    await call('POST', '/admin/relationship/mode', { mode: 'founder' });
    await call('POST', '/admin/config/engine', { engine: 'claude-cli' });

    assert.deepEqual(await (await call('GET', '/admin/config/card')).json(),
      { mode: 'founder', capPerDay: 3, producer: 'eligibility', engine: 'claude-cli' },
      'read back through the same seam the writes went through');

    // 'local' DELETES relationshipMemory.engine rather than writing a string
    // (absent-means-loopback is engines.mjs's contract), so the read has to
    // answer null for it and leave the other three standing.
    await call('POST', '/admin/config/engine', { engine: 'local' });
    assert.deepEqual(await (await call('GET', '/admin/config/card')).json(),
      { mode: 'founder', capPerDay: 3, producer: 'eligibility', engine: null });

    // A read and only a read: no batch, no snapshot, no cap bookkeeping.
    await call('GET', '/admin/config/card');
    assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS n FROM rm_candidate_batch').get().n), 0);
    assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS n FROM rm_card_event').get().n), 0);

    // No body, so no media type asked of it -- and still bearer-only.
    assert.equal((await fetch(`${base}/admin/config/card`)).status, 401);
    assert.equal((await fetch(`${base}/admin/config/card`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).status, 200, 'a GET with no content-type is served');
  } finally { await server.close(); }
});

// A relationshipMemory section that is not an object, or holds values of the
// wrong type, is a hand-edited config -- the read answers null rather than
// handing the page a number where it expects a name (or the reverse).
test('GET /admin/config/card answers null for a malformed config rather than echoing it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-routes-config-bad-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    relationshipMemory: { mode: 7, capPerDay: '3', producer: '', engine: { name: 'claude-cli' } },
  }));
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipCap: CAP, ownerConfigPath: configPath,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/admin/config/card`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.deepEqual(await res.json(), { mode: null, capPerDay: null, producer: null, engine: null });
  } finally { await server.close(); }
});
