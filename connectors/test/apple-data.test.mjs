import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesFromContacts, normalizePhone, normalizeEmail } from '../sources/contacts.mjs';
import { msToAppleSeconds, helperAvailable, AppleDataError } from '../lib/apple-data.mjs';

// THE INVARIANT THAT MATTERS. The spine keys on the normalised identifier, so
// the two backends must normalise identically or a backend switch orphans every
// identifier already stored. The helper deliberately returns raw values and this
// converter runs the SAME normaliser the sqlite path uses.
test('both backends produce the same identifier for the same number', () => {
  const [entry] = entriesFromContacts([
    { displayName: 'A Person', phones: ['+1 (555) 010-0199'], emails: [] },
  ]);
  assert.equal(entry.identifier, normalizePhone('+1 (555) 010-0199'));
  assert.equal(entry.kind, 'phone');
  assert.equal(entry.displayName, 'A Person');
});

test('one contact fans out to one entry per number and address', () => {
  const entries = entriesFromContacts([
    { displayName: 'A Person', phones: ['555-0100', '555-0101'], emails: ['a@example.com'] },
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.kind), ['phone', 'phone', 'email']);
  assert.equal(entries[2].identifier, normalizeEmail('a@example.com'));
});

test('a contact with no name carries no identity and is dropped', () => {
  assert.deepEqual(entriesFromContacts([{ displayName: '  ', phones: ['555-0100'] }]), []);
  assert.deepEqual(entriesFromContacts([{ phones: ['555-0100'] }]), []);
});

test('junk from the helper does not take the pass down', () => {
  assert.deepEqual(entriesFromContacts(null), []);
  assert.deepEqual(entriesFromContacts([null, 'nope', {}]), []);
  assert.deepEqual(
    entriesFromContacts([{ displayName: 'A Person', phones: 'not-an-array', emails: null }]),
    []
  );
});

// An unnormalisable number must not become an identifier — an empty one would
// collide every bad row in the address book onto a single spine entry.
test('an unusable number yields no entry rather than an empty identifier', () => {
  const entries = entriesFromContacts([{ displayName: 'A Person', phones: ['---'], emails: [''] }]);
  assert.deepEqual(entries, []);
});

// The helper speaks Apple absolute seconds because that is what the sqlite
// columns hold, so buildRows() cannot tell the backends apart.
test('the epoch handed to the helper is Apple absolute seconds', () => {
  assert.equal(msToAppleSeconds(978_307_200_000), 0, '2001-01-01 UTC is zero');
  assert.equal(msToAppleSeconds(978_307_200_000 + 86_400_000), 86_400);
});

test('a missing helper is reported, not thrown', () => {
  assert.equal(helperAvailable('/nope/not/here/apple-data'), false);
  assert.ok(new AppleDataError('x', { denied: true }).denied);
});

// ── attendee ordering ────────────────────────────────────────────────────────
//
// connectors/AGENTS.md names attendees as its own example of the rule: hermes
// canonicalizes object KEY order for the content hash but keeps ARRAY order,
// because it cannot know which arrays are sets. EventKit promises no stable
// participant order, so an unsorted list reads as an EDIT on every delivery --
// the row's hash changes, hermes treats an unchanged meeting as modified, and
// invalidateClaimsForChangedRow retires claims nothing contradicted.
import { attendeesOf } from '../sources/calendar.mjs';

const bea = { name: 'Bea', email: 'BEA@Example.com', isMe: false };
const al = { name: 'Al', email: 'al@example.com', isMe: false };

test('the same people in a different order normalise identically', () => {
  assert.deepEqual(attendeesOf({ attendees: [bea, al] }), attendeesOf({ attendees: [al, bea] }));
});

test('they sort by email, which is the identity', () => {
  const out = attendeesOf({ attendees: [bea, al] });
  assert.deepEqual(out.map((p) => p.email), ['al@example.com', 'bea@example.com']);
});

test('emails are lowercased, or the join to contacts misses on case alone', () => {
  const [, b] = attendeesOf({ attendees: [al, bea] });
  assert.equal(b.email, 'bea@example.com');
});

test('name breaks the tie for participants with no address', () => {
  const out = attendeesOf({
    attendees: [{ name: 'Zoe', isMe: false }, { name: 'Ada', isMe: false }],
  });
  assert.deepEqual(out.map((p) => p.name), ['Ada', 'Zoe']);
});

test('the owner is dropped: "who else was there" is the question', () => {
  const out = attendeesOf({ attendees: [al, { name: 'Me', email: 'me@example.com', isMe: true }] });
  assert.deepEqual(out.map((p) => p.email), ['al@example.com']);
});

test('a participant with neither name nor address contributes nothing', () => {
  assert.deepEqual(attendeesOf({ attendees: [{ isMe: false }] }), []);
  assert.deepEqual(attendeesOf({}), []);
  assert.deepEqual(attendeesOf(null), []);
});

// ── attendees as identities ──────────────────────────────────────────────────
//
// 706 distinct attendee emails on this machine, all 706 carrying a name, and
// only 19 of them in the address book. Without this the timeline renders them
// as raw email addresses.
import { attendeeIdentities } from '../sources/calendar.mjs';

const ev = (attendees, organizer) => ({ attendees, organizer });

test('an attendee with a name and an address becomes an identity', () => {
  const out = attendeeIdentities([
    ev([{ name: 'Al Baker', email: 'AL@example.com', isMe: false }]),
  ]);
  assert.deepEqual(out, [
    { identifier: 'al@example.com', displayName: 'Al Baker', kind: 'email', source: 'calendar' },
  ]);
});

test('they are written at calendar rank, never as address-book truth', () => {
  const [one] = attendeeIdentities([ev([{ name: 'Al', email: 'al@example.com', isMe: false }])]);
  assert.equal(one.source, 'calendar', 'a name an invite supplied is not a name the owner chose');
});

test('the organizer counts too', () => {
  const out = attendeeIdentities([ev([], { name: 'Bea', email: 'bea@example.com', isMe: false })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].displayName, 'Bea');
});

test('the owner is never an identity in their own calendar', () => {
  assert.deepEqual(attendeeIdentities([ev([{ name: 'Me', email: 'me@example.com', isMe: true }])]), []);
});

test('an attendee with no address contributes nothing to the spine', () => {
  // A name alone cannot key anything — the spine is identifier-first.
  assert.deepEqual(attendeeIdentities([ev([{ name: 'Nameless Phone', isMe: false }])]), []);
});

test('one person across many events yields one identity, stably named', () => {
  const out = attendeeIdentities([
    ev([{ name: 'Al Baker', email: 'al@example.com', isMe: false }]),
    ev([{ name: 'Al B.', email: 'al@example.com', isMe: false }]),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].displayName, 'Al Baker', 'first seen wins, so the label does not flicker');
});
