// When a claim stops being about the future.
import test from 'node:test';
import assert from 'node:assert/strict';

import { validToFor, isExpired, EXPIRING_KINDS, endOfDayUtc } from '../server/memory/validity.mjs';

const SAID = Date.UTC(2026, 2, 4); // 2026-03-04

test('a dated plan expires at the end of the day it names', () => {
  const to = validToFor({ kind: 'plan', text: 'The owner flies to Denver on 2026-03-05.' });
  assert.equal(to, Date.UTC(2026, 2, 5, 23, 59, 59, 999));
  // Live all through the day itself, which is the point of end-of-day.
  assert.equal(isExpired({ valid_to: to }, { now: Date.UTC(2026, 2, 5, 9) }), false);
  assert.equal(isExpired({ valid_to: to }, { now: Date.UTC(2026, 2, 6, 1) }), true);
});

// The whole reason this works now: the distiller resolves relative time into a
// real date before the claim is written. "tomorrow" was unparseable by anything,
// and 21% of plans carried exactly that.
test('an unresolved relative date yields no expiry, rather than a guess', () => {
  assert.equal(validToFor({ kind: 'plan', text: 'The owner flies to Denver tomorrow.' }), null);
  assert.equal(validToFor({ kind: 'plan', text: 'The owner plans to go next Tuesday.' }), null);
});

// A date inside a standing fact is part of the fact, not its expiry.
test('only intentions can expire', () => {
  const text = 'The owner has been vegetarian since 2026-01-04.';
  assert.equal(validToFor({ kind: 'fact', text }), null);
  assert.equal(validToFor({ kind: 'preference', text }), null);
  assert.equal(validToFor({ kind: 'constraint', text }), null);
  assert.deepEqual([...EXPIRING_KINDS].sort(), ['commitment', 'plan']);
  assert.ok(validToFor({ kind: 'plan', text: 'The owner will file on 2026-01-04.' }) !== null);
});

test('a month name without a year resolves against when it was said', () => {
  // April is after March, so the same year.
  assert.equal(
    validToFor({ kind: 'plan', text: 'The owner flies on April 2nd.' }, { observedAt: SAID }),
    Date.UTC(2026, 3, 2, 23, 59, 59, 999)
  );
  // February is behind March, so it means the next one.
  assert.equal(
    validToFor({ kind: 'plan', text: 'The owner flies on February 2nd.' }, { observedAt: SAID }),
    Date.UTC(2027, 1, 2, 23, 59, 59, 999)
  );
});

// Resolving against NOW rather than against the observation would let a claim
// distilled a year late become next year's plan.
test('a year-less date with no observation time gets no expiry', () => {
  assert.equal(validToFor({ kind: 'plan', text: 'The owner flies on April 2nd.' }), null);
});

test('an explicit year wins over the observation', () => {
  assert.equal(
    validToFor({ kind: 'plan', text: 'The owner flies on April 2, 2028.' }, { observedAt: SAID }),
    Date.UTC(2028, 3, 2, 23, 59, 59, 999)
  );
});

// 2026-02-31 rolls to March 3 in every Date implementation. A claim about a day
// that never existed should have no expiry rather than a silently moved one.
test('a date the calendar does not have yields no expiry', () => {
  assert.equal(endOfDayUtc(2026, 2, 31), null);
  assert.equal(validToFor({ kind: 'plan', text: 'The owner flies on 2026-02-31.' }), null);
  assert.equal(endOfDayUtc(2028, 2, 29), Date.UTC(2028, 1, 29, 23, 59, 59, 999), 'a real leap day stands');
});

test('no date at all means no expiry, which is the safe direction', () => {
  assert.equal(validToFor({ kind: 'plan', text: 'The owner plans to learn Portuguese.' }), null);
  assert.equal(isExpired({ valid_to: null }), false, 'undated claims never age out');
});

test('junk does not throw', () => {
  assert.equal(validToFor(null), null);
  assert.equal(validToFor({ kind: 'plan' }), null);
  assert.equal(validToFor({ kind: 'plan', text: 42 }), null);
  assert.equal(isExpired(null), false);
});
