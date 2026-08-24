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
