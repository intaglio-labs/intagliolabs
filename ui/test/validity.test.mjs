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

// A BARE WEEKDAY is how the model actually writes time. Measured on the
// re-distilled corpus: of 89 plans, 51 name no time at all; of the 38 that do,
// 17 say only "on Tuesday" and just 1 wrote the ISO date the prompt asks for.
// Resolving those took valid_to coverage from 2% of intentions to 21%.
const FRIDAY = Date.UTC(2026, 2, 6); // 2026-03-06 is a Friday

test('a weekday resolves to the next such day after it was said', () => {
  assert.equal(
    validToFor({ kind: 'plan', text: 'The owner flies on Tuesday.' }, { observedAt: FRIDAY }),
    Date.UTC(2026, 2, 10, 23, 59, 59, 999),
    'Friday -> the following Tuesday'
  );
});

// A plan is written before the thing it plans, so "Friday" said on a Friday
// means the next one rather than that same morning.
test('the same weekday means a week ahead, not today', () => {
  assert.equal(
    validToFor({ kind: 'plan', text: 'The owner flies on Friday.' }, { observedAt: FRIDAY }),
    Date.UTC(2026, 2, 13, 23, 59, 59, 999)
  );
});

test('a weekday needs an observation time, or it means nothing', () => {
  assert.equal(validToFor({ kind: 'plan', text: 'The owner flies on Tuesday.' }), null);
});

test('an explicit date still wins over a weekday in the same sentence', () => {
  assert.equal(
    validToFor(
      { kind: 'plan', text: 'The owner flies Tuesday 2026-04-02.' },
      { observedAt: FRIDAY }
    ),
    Date.UTC(2026, 3, 2, 23, 59, 59, 999)
  );
});

test('a weekday inside a standing fact still does not expire it', () => {
  assert.equal(
    validToFor({ kind: 'preference', text: 'The owner prefers Tuesday meetings.' }, { observedAt: FRIDAY }),
    null
  );
});

// ── resolvePhrase ────────────────────────────────────────────────────────────
//
// The model copies the words; this does the arithmetic. That split exists
// because the model obeyed the JSON grammar on 1,030 of 1,030 calls and the
// prose instruction to resolve a date on 1 of 38 — and when handed a
// pattern-constrained date field it emitted a well-formed date every time and
// still wrote the day the message was SENT.
import { resolvePhrase } from '../server/memory/validity.mjs';

const WED = Date.UTC(2026, 2, 4); // 2026-03-04, a Wednesday
const day = (y, m, d) => Date.UTC(y, m - 1, d, 23, 59, 59, 999);

test('the everyday relative words', () => {
  assert.equal(resolvePhrase('tomorrow', WED), day(2026, 3, 5));
  assert.equal(resolvePhrase('today', WED), day(2026, 3, 4));
  assert.equal(resolvePhrase('tonight', WED), day(2026, 3, 4), 'tonight is still today');
  assert.equal(resolvePhrase('day after tomorrow', WED), day(2026, 3, 6));
});

test('a weekday goes forward, and its own day goes a week out', () => {
  assert.equal(resolvePhrase('friday', WED), day(2026, 3, 6), 'two days ahead');
  assert.equal(resolvePhrase('tuesday', WED), day(2026, 3, 10), 'not yesterday — the next one');
  assert.equal(resolvePhrase('wednesday', WED), day(2026, 3, 11), 'a plan precedes its day');
  assert.equal(resolvePhrase('next tuesday', WED), resolvePhrase('tuesday', WED), '"next" adds nothing');
});

// A vague span is over when the span is. Picking a day inside it would invent
// precision the message never had.
test('a vague span resolves to the end of the span', () => {
  assert.equal(resolvePhrase('next week', WED), day(2026, 3, 15));
  assert.equal(resolvePhrase('next week sometime', WED), day(2026, 3, 15));
  assert.equal(resolvePhrase('the weekend', WED), day(2026, 3, 7), 'the Saturday it starts');
});

test('a day of the month rolls to the next occurrence', () => {
  assert.equal(resolvePhrase('the 14th', WED), day(2026, 3, 14), 'still ahead this month');
  assert.equal(resolvePhrase('the 2nd', WED), day(2026, 4, 2), 'already gone — next month');
});

test('an explicit date in the phrase beats every relative reading', () => {
  assert.equal(resolvePhrase('2026-04-02', WED), day(2026, 4, 2));
  assert.equal(resolvePhrase('march 20', WED), day(2026, 3, 20));
  assert.equal(resolvePhrase('tuesday 2026-04-02', WED), day(2026, 4, 2));
});

test('nothing recognisable means no expiry, never a guess', () => {
  assert.equal(resolvePhrase('', WED), null);
  assert.equal(resolvePhrase('learn portuguese', WED), null);
  assert.equal(resolvePhrase('tomorrow', null), null, 'no anchor, no answer');
  assert.equal(resolvePhrase(null, WED), null);
});

// The phrase is trusted over the prose because the model paraphrases in `text`
// and copies exactly in a field the grammar requires.
test('the structured phrase wins over the claim prose', () => {
  const claim = { kind: 'plan', text: 'The owner flies out on 2026-09-09.', when_phrase: 'tomorrow' };
  assert.equal(validToFor(claim, { observedAt: WED }), day(2026, 3, 5));
});

test('an empty phrase falls back to scanning the prose', () => {
  const claim = { kind: 'plan', text: 'The owner flies on 2026-04-02.', when_phrase: '' };
  assert.equal(validToFor(claim, { observedAt: WED }), day(2026, 4, 2));
});
