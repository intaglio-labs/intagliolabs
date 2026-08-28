// The "initialize search" orchestration: build the map + review pile, record a
// decision, and confirm the loop closes — a confirmed merge both collapses the
// two people and stops the pair being asked again. In-memory DBs, no files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { peopleReview, decide, openResolutionsDb } from '../server/people/init.mjs';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const owner = { addresses: new Set(['me@x.com']), names: ['Me'] };

// A context store seeded so the graph splits one real person into two "Mikes":
// an iMessage handle with the display name Mike Chen, and an email from Michael
// Chen. No spine, so the code has no hard evidence to merge them — exactly the
// case the review queue exists for.
function seed() {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (ts INTEGER, source TEXT, speaker TEXT, entity_id TEXT, text TEXT, meta TEXT)');
  const rows = [
    [NOW - 2 * DAY, 'imessage', 'i:1', null, JSON.stringify({ chat_handle: '+15551111', is_from_me: false })],
    [NOW - 3 * DAY, 'calendar', 'c:1', null, JSON.stringify({ attendees: [{ email: '+15551111', name: 'Mike Chen' }] })],
    [NOW - 400 * DAY, 'mail', 'm:1', null, JSON.stringify({ from: ['michael.chen@acme.co'], to: ['me@x.com'] })],
    // Calendar context is capped at the deepest non-calendar connector. Keep
    // this event just inside the mail floor so it names the old relationship.
    [NOW - 399 * DAY, 'calendar', 'c:2', null, JSON.stringify({ attendees: [{ email: 'michael.chen@acme.co', name: 'Michael Chen' }] })],
  ];
  for (const r of rows) ctx.prepare('INSERT INTO context (ts, source, entity_id, text, meta) VALUES (?,?,?,?,?)').run(...r);
  const res = openResolutionsDb(':memory:');
  return { ctx, res };
}

test('init builds the map and surfaces the Mike/Michael pair to review', () => {
  const { ctx, res } = seed();
  const out = peopleReview(ctx, null, res, { days: 0, now: NOW, owner });
  assert.equal(out.people, 2);            // code split them, correctly
  assert.equal(out.review, 1);            // one pair needs the owner's eyes
  assert.equal(out.pairs.length, 1);
  assert.match(out.pairs[0].reason, /nickname/);
});

test('timeframe narrows the map — the old email drops out', () => {
  const { ctx, res } = seed();
  const out = peopleReview(ctx, null, res, { days: 30, now: NOW, owner });
  assert.equal(out.people, 1);            // only the recent Mike remains
  assert.equal(out.review, 0);            // nothing to merge against
});

test('a "same" decision closes the loop: merged AND never re-asked', () => {
  const { ctx, res } = seed();
  const before = peopleReview(ctx, null, res, { days: 0, now: NOW, owner });
  const a = before.pairs[0].a.key, b = before.pairs[0].b.key;

  decide(res, { a, b, verdict: 'same', now: NOW });

  const after = peopleReview(ctx, null, res, { days: 0, now: NOW, owner });
  assert.equal(after.people, 1);          // the two are now one person
  assert.equal(after.review, 0);          // and the pair is gone from the pile
});

test('a "different" decision leaves them split but stops the question', () => {
  const { ctx, res } = seed();
  const before = peopleReview(ctx, null, res, { days: 0, now: NOW, owner });
  const a = before.pairs[0].a.key, b = before.pairs[0].b.key;

  decide(res, { a, b, verdict: 'different', now: NOW });

  const after = peopleReview(ctx, null, res, { days: 0, now: NOW, owner });
  assert.equal(after.people, 2);          // still two people
  assert.equal(after.review, 0);          // but not asked again
});

test('skip leaves the pair to resurface', () => {
  const { ctx, res } = seed();
  const before = peopleReview(ctx, null, res, { days: 0, now: NOW, owner });
  decide(res, { a: before.pairs[0].a.key, b: before.pairs[0].b.key, verdict: 'skip', now: NOW });
  const after = peopleReview(ctx, null, res, { days: 0, now: NOW, owner });
  assert.equal(after.review, 1);          // skip decided nothing
});

test('decide rejects a missing or self-referential key', () => {
  const { res } = seed();
  assert.throws(() => decide(res, { a: 'x', b: '', verdict: 'same' }));
});
