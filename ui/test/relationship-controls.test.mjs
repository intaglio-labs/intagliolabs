// L5 step 4: the owner's controls exist and hold before any candidate
// generator does. The properties under test are the plan's own sentences:
// suppression is permanent, survives identity merges, and outranks
// everything; a mute states its scope and duration; a dismissal reason is
// one of five; the global cap counts every proactive kind together and an
// unconfigured cap shows nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb } from '../server/hermes.mjs';
import { createControls, timeBand, DISMISS_REASONS, NOT_THIS_KIND_MUTE_DAYS, cardStats } from '../server/relationship/controls.mjs';
import { createRelationshipMemory } from '../server/relationship/service.mjs';

const NOW = Date.now();
const HOUR = 3_600_000;
const CAP = { max: 2, windowMs: 24 * HOUR };
const ctl = (db, opts) => createControls(db, opts);

test('suppression is permanent, outranks everything, and only settings can reverse it', () => {
  const c = ctl(openDb(':memory:'));
  c.suppress('name:ex person', NOW);
  assert.equal(c.isSuppressed('name:ex person'), true);
  assert.deepEqual(c.allowCard({ personKey: 'name:ex person', kind: 'open_loop', cap: CAP, now: NOW }),
    { allowed: false, reason: 'suppressed' });
  c.unsuppress('name:ex person');
  assert.equal(c.isSuppressed('name:ex person'), false);
});

test('an identity merge widens a suppression and never clears it', () => {
  const db = openDb(':memory:');
  // Before the merge: two keys, one suppressed under its old key.
  const aliases = new Map();
  const c = ctl(db, { canonicalOf: (k) => aliases.get(k) ?? k });
  c.suppress('name:jon smith', NOW);
  assert.equal(c.isSuppressed('name:jonathan smith'), false, 'distinct people stay distinct');
  // The owner rules them the same person; both keys now fold to one canonical.
  aliases.set('name:jon smith', 'name:jonathan smith');
  assert.equal(c.isSuppressed('name:jonathan smith'), true,
    'the merged person is suppressed through the alias, with the row untouched');
  assert.equal(c.isSuppressed('name:jon smith'), true);
});

test('mute scopes: person hits every kind, kind hits every person, both hits the pair', () => {
  const c = ctl(openDb(':memory:'));
  c.mute({ personKey: 'name:a', untilAt: NOW + HOUR, now: NOW });
  c.mute({ kind: 'open_loop', untilAt: NOW + HOUR, now: NOW });
  c.mute({ personKey: 'name:b', kind: 'shared_context', untilAt: NOW + HOUR, now: NOW });
  assert.equal(c.isMuted({ personKey: 'name:a', kind: 'anything', now: NOW }), true);
  assert.equal(c.isMuted({ personKey: 'name:z', kind: 'open_loop', now: NOW }), true);
  assert.equal(c.isMuted({ personKey: 'name:b', kind: 'shared_context', now: NOW }), true);
  assert.equal(c.isMuted({ personKey: 'name:b', kind: 'open_loop', now: NOW }), true, 'kind-wide mute');
  assert.equal(c.isMuted({ personKey: 'name:z', kind: 'shared_context', now: NOW }), false);
  // Expiry is the clock, not a delete.
  assert.equal(c.isMuted({ personKey: 'name:a', kind: 'anything', now: NOW + 2 * HOUR }), false);
  // A mute of nothing is refused at the API and at the schema.
  assert.throws(() => c.mute({ untilAt: NOW + HOUR, now: NOW }), /mute of nothing/);
  assert.throws(() => c.mute({ personKey: 'name:a', untilAt: NOW - 1, now: NOW }), /future timestamp/);
});

test('dismissal reasons are the five on the card, and never-this-person suppresses in the same act', () => {
  const db = openDb(':memory:');
  const c = ctl(db);
  assert.deepEqual([...DISMISS_REASONS],
    ['wrong-person', 'wrong-time', 'never-this-person', 'not-this-kind', 'not-useful']);
  c.dismiss({ personKey: 'name:a', kind: 'open_loop', reason: 'wrong-time', ruleVersion: 'v2', now: NOW });
  assert.equal(c.isSuppressed('name:a'), false, 'wrong-time is feedback, not suppression');
  c.dismiss({ personKey: 'name:b', kind: 'open_loop', reason: 'never-this-person', ruleVersion: 'v2', now: NOW });
  assert.equal(c.isSuppressed('name:b'), true, 'the one-tap permanent control');
  c.dismiss({ personKey: 'name:c', kind: 'open_loop', ruleVersion: 'v2', now: NOW }); // no reason: allowed
  assert.throws(() => c.dismiss({ personKey: 'name:d', kind: 'open_loop', reason: 'meh', ruleVersion: 'v2' }),
    /reason must be one of/);
  assert.throws(() => c.recordEvent({ personKey: 'name:d', kind: 'open_loop', event: 'shown',
    reason: 'not-useful', ruleVersion: 'v2' }), /only a dismissal/);
  const events = db.prepare('SELECT event, reason FROM rm_card_event ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(events, [
    { event: 'dismissed', reason: 'wrong-time' },
    { event: 'dismissed', reason: 'never-this-person' },
    { event: 'dismissed', reason: null },
  ]);
});

// 'not-this-kind' is the analogous one-tap control to 'never-this-person',
// scoped to a person+kind pair rather than the whole person: a card the
// owner says is the wrong KIND of thing to be shown for them mutes that
// kind, for them, for NOT_THIS_KIND_MUTE_DAYS -- never a global kind mute
// (that is a settings-surface decision) and never every kind for them
// (that would be 'never-this-person').
test("'not-this-kind' mutes this person for this kind, and only this kind", () => {
  const db = openDb(':memory:');
  const c = ctl(db);
  c.dismiss({ personKey: 'name:e', kind: 'owe', reason: 'not-this-kind', ruleVersion: 'owe-v1', now: NOW });
  assert.equal(c.isMuted({ personKey: 'name:e', kind: 'owe', now: NOW }), true, 'owe is muted for this person');
  assert.equal(c.isMuted({ personKey: 'name:e', kind: 'reconnect', now: NOW }), false,
    'a different kind, same person, is untouched');
  assert.equal(c.isSuppressed('name:e'), false, 'not-this-kind never suppresses the person outright');

  const mute = db.prepare('SELECT person_key, kind, until_at FROM rm_mute').get();
  assert.equal(mute.person_key, 'name:e');
  assert.equal(mute.kind, 'owe');
  assert.equal(mute.until_at, NOW + NOT_THIS_KIND_MUTE_DAYS * 86_400_000);

  // Just past the mute window: no longer muted.
  assert.equal(
    c.isMuted({ personKey: 'name:e', kind: 'owe', now: NOW + (NOT_THIS_KIND_MUTE_DAYS + 1) * 86_400_000 }),
    false
  );
});

test('the global cap counts every kind together, and an unconfigured cap shows nothing', () => {
  const c = ctl(openDb(':memory:'));
  const shown = (kind, at) => c.recordEvent({ personKey: 'name:x', kind, event: 'shown', ruleVersion: 'v2', now: at });
  assert.equal(c.allowCard({ personKey: 'name:x', kind: 'open_loop', cap: CAP, now: NOW }).allowed, true);
  shown('open_loop', NOW - 2 * HOUR);
  shown('explicit_commitment', NOW - HOUR); // a DIFFERENT kind still counts
  assert.deepEqual(c.allowCard({ personKey: 'name:x', kind: 'shared_context', cap: CAP, now: NOW }),
    { allowed: false, reason: 'global-cap' });
  // Outside the window the old showings age out.
  assert.equal(c.allowCard({ personKey: 'name:x', kind: 'shared_context',
    cap: CAP, now: NOW + 24 * HOUR }).allowed, true);
  // No cap, or a malformed one, fails CLOSED -- thresholds come from the
  // sealed Phase 0 gates artifact, never from a default someone invented.
  assert.deepEqual(c.allowCard({ personKey: 'name:x', kind: 'open_loop', now: NOW }),
    { allowed: false, reason: 'global-cap' });
  assert.equal(c.underGlobalCap({ max: -1, windowMs: HOUR, now: NOW }), false);
});

test('the event record is append-only in fact', () => {
  const db = openDb(':memory:');
  const c = ctl(db);
  c.recordEvent({ personKey: 'name:x', kind: 'open_loop', event: 'shown', ruleVersion: 'v2', now: NOW });
  c.suppress('name:x', NOW); // a row must exist for a BEFORE UPDATE trigger to have anything to fire on
  assert.throws(() => db.prepare("UPDATE rm_card_event SET event = 'accepted' WHERE id = 1").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM rm_card_event WHERE id = 1').run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE rm_suppression SET person_key = 'name:other'").run(), /never by edit/,
    'suppression rows flip by insert/delete, never by edit');
});

test('time bands are local and total', () => {
  const at = (h) => new Date(2027, 0, 1, h, 30).getTime();
  assert.equal(timeBand(at(6)), 'morning');
  assert.equal(timeBand(at(13)), 'afternoon');
  assert.equal(timeBand(at(19)), 'evening');
  assert.equal(timeBand(at(23)), 'night');
  assert.equal(timeBand(at(2)), 'night');
});

test('the service wires the controls through the shared resolutions store', () => {
  const ctxDb = openDb(':memory:');
  const res = new DatabaseSync(':memory:');
  const svc = createRelationshipMemory({ contextDb: ctxDb, resolutionsDb: res });
  svc.controls.suppress('name:jon smith', NOW);
  assert.equal(svc.controls.isSuppressed('name:jonathan smith'), false);
  // The owner's merge decision, recorded through the service's OWN identity
  // seam, must widen the suppression with no other plumbing.
  svc.identity.decide('name:jon smith', 'name:jonathan smith', 'same', NOW);
  assert.equal(svc.controls.isSuppressed('name:jonathan smith'), true);
});

// cardStats (/stats.cards): counted facts off rm_card_event alone, split per
// kind, windowed and all-time. No verdict, no threshold -- these tests check
// the numbers, not a pass/fail line (there is none to check).
function insertCardEvent(db, { kind, event, reason = null, snapshotId = null, ruleVersion = 'v1', createdAt }) {
  db.prepare(
    'INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at) ' +
    "VALUES ('name:whoever', ?, ?, ?, ?, NULL, ?, 'morning', ?)"
  ).run(kind, snapshotId, event, reason, ruleVersion, createdAt);
}

test('cardStats: per-kind split, acceptRate null on zero shown, reason shares off dismissals, distinct local days', () => {
  const db = openDb(':memory:');
  const DAY = 86_400_000;
  const now = Date.parse('2026-06-01T12:00:00Z');

  // owe: 4 shown across 3 distinct days (two on the same day), 2 accepted,
  // 2 dismissed (one 'never-this-person', one with no reason), all within
  // the default 56-day window.
  insertCardEvent(db, { kind: 'owe', event: 'shown', createdAt: now - 1 * DAY });
  insertCardEvent(db, { kind: 'owe', event: 'shown', createdAt: now - 1 * DAY + 3_600_000 }); // same local day as above
  insertCardEvent(db, { kind: 'owe', event: 'shown', createdAt: now - 2 * DAY });
  insertCardEvent(db, { kind: 'owe', event: 'shown', createdAt: now - 3 * DAY });
  insertCardEvent(db, { kind: 'owe', event: 'accepted', createdAt: now - 3 * DAY });
  insertCardEvent(db, { kind: 'owe', event: 'accepted', createdAt: now - 2 * DAY });
  insertCardEvent(db, { kind: 'owe', event: 'dismissed', reason: 'never-this-person', createdAt: now - 1 * DAY });
  insertCardEvent(db, { kind: 'owe', event: 'dismissed', reason: null, createdAt: now - 1 * DAY });
  insertCardEvent(db, { kind: 'owe', event: 'opened', createdAt: now - 1 * DAY });

  // A shown event well OUTSIDE the 56-day window: counts in allTime, not in
  // the windowed perKind.
  insertCardEvent(db, { kind: 'owe', event: 'shown', createdAt: now - 200 * DAY });

  // reconnect: never shown at all.
  const stats = cardStats(db, { now, windowDays: 56 });

  assert.equal(stats.windowDays, 56);
  assert.equal(stats.since, now - 56 * DAY);

  const owe = stats.perKind.owe;
  assert.equal(owe.shown, 4);
  assert.equal(owe.opened, 1);
  assert.equal(owe.accepted, 2);
  assert.equal(owe.dismissed, 2);
  assert.equal(owe.daysServed, 3, 'three distinct local calendar dates, not four rows');
  assert.equal(owe.acceptRate, 0.5);
  assert.equal(owe.openRate, 0.25);
  assert.deepEqual(owe.dismissReasons, {
    'wrong-person': 0, 'wrong-time': 0, 'never-this-person': 1, 'not-this-kind': 0, 'not-useful': 0, none: 1,
  });
  assert.equal(owe.neverThisPersonShare, 0.5, 'share of DISMISSALS (2), not of shown (4)');
  assert.equal(owe.notUsefulShare, 0);

  const reconnect = stats.perKind.reconnect;
  assert.equal(reconnect.shown, 0);
  assert.equal(reconnect.acceptRate, null, 'null, never a bare 0, when nothing was shown');
  assert.equal(reconnect.openRate, null);
  assert.equal(reconnect.neverThisPersonShare, null, 'null, never a bare 0, when nothing was dismissed');
  assert.equal(reconnect.notUsefulShare, null);

  // allTime includes the row from 200 days ago; the windowed perKind does not.
  assert.equal(stats.allTime.owe.shown, 5);
  assert.equal(stats.perKind.owe.shown, 4);

  assert.equal(stats.perKind.verdict, undefined, 'no verdict field anywhere in the shape');
  assert.equal(owe.verdict, undefined);
});
