// The calendar reconnect adapter: the Phase 0 winner as product code. The
// properties are the arm-3 rules and the join arm's one proven edge -- a
// scheduled future meeting vetoes the card.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { createRelationshipMemory } from '../server/relationship/service.mjs';
import { calendarReconnectAdapter } from '../server/relationship/calendarReconnect.mjs';

const NOW = Date.now();
const DAY = 86_400_000;
const CAP = { max: 10, windowMs: 24 * 3_600_000 };

function stateDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  db.exec('CREATE TABLE run_log (connector TEXT, ok INTEGER, finished_ts INTEGER)');
  const ins = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name] of pairs) ins.run(id, name, 'email', NOW);
  return db;
}

function meeting(ts, emails, entity) {
  return { ts, source: 'calendar', entity_id: entity, text: 'meeting',
    meta: { attendees: emails.map((e) => ({ email: e })) } };
}

function fixture({ future = [] } = {}) {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    // Lapsed Colleague: 3 past small meetings, none in 200 days.
    meeting(NOW - 300 * DAY, ['lapsed@work.com'], 'c:1'),
    meeting(NOW - 250 * DAY, ['lapsed@work.com'], 'c:2'),
    meeting(NOW - 200 * DAY, ['lapsed@work.com'], 'c:3'),
    // Regular: met recently.
    meeting(NOW - 300 * DAY, ['regular@work.com'], 'c:4'),
    meeting(NOW - 10 * DAY, ['regular@work.com'], 'c:5'),
    // Forward coverage: the calendar has a future event (with nobody known).
    meeting(NOW + 20 * DAY, ['someoneelse@x.com'], 'c:9'),
    ...future,
  ]);
  const svc = createRelationshipMemory({ contextDb: ctx,
    stateDb: stateDb([['lapsed@work.com', 'Lapsed Colleague'], ['regular@work.com', 'Regular Friend']]) });
  svc.registerSource(calendarReconnectAdapter());
  return svc;
}

test('a lapsed meeting relationship becomes a candidate; a current one does not', () => {
  const cands = fixture().candidates({ now: NOW, cap: CAP });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].personKey, 'name:lapsed colleague');
  assert.equal(cands[0].evidence.meetings, 3);
  assert.equal(cands[0].producer_version, 'rm-cal-reconnect-v1');
});

test('a future meeting with the person vetoes the card', () => {
  const svc = fixture({ future: [meeting(NOW + 5 * DAY, ['lapsed@work.com'], 'c:8')] });
  assert.deepEqual(svc.candidates({ now: NOW, cap: CAP }), [],
    'do not suggest reconnecting with someone the owner sees on Tuesday');
});

test('no forward calendar coverage means no claims at all', () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [
    meeting(NOW - 300 * DAY, ['lapsed@work.com'], 'c:1'),
    meeting(NOW - 250 * DAY, ['lapsed@work.com'], 'c:2'),
    meeting(NOW - 200 * DAY, ['lapsed@work.com'], 'c:3'),
  ]);
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: stateDb([['lapsed@work.com', 'Lapsed Colleague']]) });
  svc.registerSource(calendarReconnectAdapter());
  assert.deepEqual(svc.candidates({ now: NOW, cap: CAP }), [],
    '"nothing scheduled" over a calendar with no future rows is a claim about a dead sync');
});

test('suppression holds here exactly as it does for messages', () => {
  const svc = fixture();
  svc.controls.suppress('name:lapsed colleague', NOW);
  assert.deepEqual(svc.candidates({ now: NOW, cap: CAP }), []);
});

test('an invite display-name folds an email-only contact onto the named person', () => {
  const ctx = openDb(':memory:');
  const m = (ts, entity, name) => ({ ts, source: 'calendar', entity_id: entity, text: 'meeting',
    meta: { attendees: [{ email: 'mt@personal.dev', ...(name ? { name } : {}) }] } });
  insertRows(ctx, [
    m(NOW - 300 * DAY, 'c:1', 'Mika Tanaka'), m(NOW - 250 * DAY, 'c:2', 'Mika Tanaka'),
    m(NOW - 200 * DAY, 'c:3', 'Mika Tanaka'), meeting(NOW + 20 * DAY, ['x@y.com'], 'c:9'),
  ]);
  // The spine knows the email only AS an email (calendar-sourced), and knows
  // the person by name through their phone.
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: stateDb([
    ['mt@personal.dev', 'mt@personal.dev'], ['+15550009', 'Mika Tanaka']]) });
  svc.registerSource(calendarReconnectAdapter());
  const cands = svc.candidates({ now: NOW, cap: CAP });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].personKey, 'name:mika tanaka', 'one human, one card, the owner-named key');
});

test('broadcast events do not create relationships', () => {
  const ctx = openDb(':memory:');
  const crowd = Array.from({ length: 12 }, (_, i) => `p${i}@x.com`);
  insertRows(ctx, [
    meeting(NOW - 300 * DAY, ['lapsed@work.com', ...crowd], 'c:1'),
    meeting(NOW - 250 * DAY, ['lapsed@work.com', ...crowd], 'c:2'),
    meeting(NOW - 200 * DAY, ['lapsed@work.com', ...crowd], 'c:3'),
    meeting(NOW + 20 * DAY, ['someoneelse@x.com'], 'c:9'),
  ]);
  const svc = createRelationshipMemory({ contextDb: ctx, stateDb: stateDb([['lapsed@work.com', 'Lapsed Colleague']]) });
  svc.registerSource(calendarReconnectAdapter());
  assert.deepEqual(svc.candidates({ now: NOW, cap: CAP }), [],
    'a 13-attendee event is a broadcast, not a relationship');
});
