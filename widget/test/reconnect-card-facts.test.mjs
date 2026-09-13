// WHAT THE CARD KNOWS AND NEVER SAID.
//
// On a fresh install the reconnect card showed: trigger counts, a name, a
// template tie sentence, one quote, a one-word role bucket, and the same counts
// again. Three restatements of two numbers, and nothing about the person —
// while the reply already carried their LinkedIn title, who wrote last and
// when, when the last meeting was, and the newest corroborated public-web
// change about them.
//
// This file loads the page's pure functions and runs them, rather than grepping
// for their source: the ones that matter here are formatters, and a formatter
// pinned by a regex is pinned against nothing. reconnect.js is a plain script
// that touches the DOM at load, so the functions are lifted out of the source
// text and evaluated on their own — the same trick the other UI tests use to
// avoid standing up a webview.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(WIDGET, 'ui', 'reconnect.js'), 'utf8');
const html = readFileSync(join(WIDGET, 'ui', 'reconnect.html'), 'utf8');

// Lift the named function declarations this file tests, with their bodies, and
// evaluate them together. A missing one is a failure here, not a silent skip.
function lift(names) {
  const parts = [];
  for (const name of names) {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > -1, `reconnect.js has no function ${name}`);
    const end = src.indexOf('\n}', at);
    assert.ok(end > at, `could not find the end of ${name}`);
    parts.push(src.slice(at, end + 2));
  }
  // The module constants those functions read. Lifted with them rather than
  // restated here: a copy of MONTHS in the test is a second source of truth
  // that can drift silently past the thing it is testing.
  for (const decl of [/const MONTHS = \[[\s\S]*?\];/u, /const asText = [^\n]*;/u,
    /const TEMPLATE_TIE =\s*\n[^\n]*;/u]) {
    const found = decl.exec(src)?.[0];
    assert.ok(found, `a constant the lifted functions read was not found: ${decl}`);
    parts.unshift(found);
  }
  // new Function over THIS REPO'S OWN SOURCE, read from disk in a test. Nothing
  // here crosses a trust boundary: the alternative is standing up a webview to
  // exercise four string formatters.
  // eslint-disable-next-line no-new-func
  return new Function(`${parts.join('\n')}\nreturn {${names.join(',')}};`)();
}

const fns = lift([
  'quietPhrase', 'whenPhrase', 'personField', 'whoLine', 'linkedSince', 'spokeLastLine',
  'historyLine', 'changedLine', 'sourceCount', 'triggerLine', 'tieLine',
]);

const DAY = 86400000;
// A fixed clock, mid-year, so "in <month>" and "N months ago" are both
// reachable and neither is an accident of the day the suite runs.
const NOW = Date.parse('2026-09-13T12:00:00Z');

test('a gap is said the way a person would say it', () => {
  assert.equal(fns.quietPhrase(3), '3d', 'a few days IS the natural unit');
  assert.equal(fns.quietPhrase(30), '4 weeks');
  assert.equal(fns.quietPhrase(200), '7 months');
  assert.equal(fns.quietPhrase(634), '2 years', 'the live run-4 card said "quiet 634 days"');
  assert.equal(fns.quietPhrase(365), 'about a year');
});

test('a timestamp becomes a month this year and a distance before that', () => {
  assert.equal(fns.whenPhrase(NOW, NOW), 'today');
  assert.equal(fns.whenPhrase(NOW - DAY, NOW), 'yesterday');
  assert.equal(fns.whenPhrase(NOW - 5 * DAY, NOW), '5 days ago');
  assert.equal(fns.whenPhrase(NOW - 21 * DAY, NOW), '3 weeks ago');
  // Inside this calendar year: a month name can be placed.
  assert.equal(fns.whenPhrase(Date.parse('2026-03-04T09:00:00Z'), NOW), 'in march');
  // Across the boundary it cannot, so it becomes a distance.
  assert.equal(fns.whenPhrase(Date.parse('2025-12-20T09:00:00Z'), NOW), '9 months ago');
  assert.equal(fns.whenPhrase(Date.parse('2023-09-01T09:00:00Z'), NOW), '3 years ago');
});

test('a missing or impossible timestamp prints nothing at all', () => {
  // The columns are nullable and a card must never say "NaN months ago".
  for (const bad of [null, undefined, 0, -1, 'yesterday', NaN, NOW + 10 * DAY]) {
    assert.equal(fns.whenPhrase(bad, NOW), null, `${String(bad)} must not become a phrase`);
  }
  assert.equal(fns.spokeLastLine({ person: {} }), '');
  assert.equal(fns.spokeLastLine({}), '');
  assert.equal(fns.changedLine({}), '');
  assert.equal(fns.whoLine({ person: { title: null, company: null } }), '');
});

test('the fields are read whether hermes nests them or not', () => {
  // THE CONFIRMED SHAPE: `card.person = { title, company, industry, connectedOn,
  // url }`, and lastFromThem / lastFromOwner / lastSeen / lastMeetingDaysAgo
  // top-level on the card. The fallback read of the other position is kept for
  // a card built by an older hermes, so a version skew is a missing line rather
  // than a blank card.
  const wire = {
    person: { title: 'Partner', company: 'Sequoia', industry: 'venture capital', connectedOn: 1600000000000, url: 'u' },
    lastFromThem: NOW - 240 * DAY,
    lastFromOwner: NOW - 400 * DAY,
    lastSeen: NOW - 240 * DAY,
    lastMeetingDaysAgo: 700,
    evidence: { messages: 21, dormancyDays: 240, meetings: 1 },
  };
  assert.equal(fns.whoLine(wire), 'Partner at Sequoia');
  assert.match(fns.spokeLastLine(wire), /^they wrote last, /u);
  assert.match(fns.historyLine(wire), /^21 messages · met 1×, last 2 years ago$/u);
  assert.equal(fns.triggerLine({ ...wire, kind: 'reconnect' }), 'quiet 8 months');
  assert.equal(fns.personField({ person: { title: 'Partner' } }, 'title'), 'Partner');
  assert.equal(fns.personField({ title: 'Partner' }, 'title'), 'Partner');
  assert.equal(fns.personField({ person: {} }, 'title'), null);
  // Nested wins when both are there, because that is the fresher writer.
  assert.equal(fns.personField({ person: { title: 'new' }, title: 'old' }, 'title'), 'new');
});

test('a LinkedIn title is what the person calls their job', () => {
  assert.equal(fns.whoLine({ person: { title: 'Partner', company: 'Sequoia' } }), 'Partner at Sequoia');
  assert.equal(fns.whoLine({ person: { title: 'Partner' } }), 'Partner');
  assert.equal(fns.whoLine({ person: { company: 'Sequoia' } }), 'Sequoia');
  // Whitespace-only columns are not a title.
  assert.equal(fns.whoLine({ person: { title: '   ', company: '' } }), '');
});

test('who wrote last is decided by the later of the two, not by which exists', () => {
  const them = NOW - 240 * DAY;
  const mine = NOW - 400 * DAY;
  // A fixture where the wrong rule and the right one disagree: they wrote more
  // recently, but the owner's side is present too and is the older of the pair.
  assert.match(fns.spokeLastLine({ person: { lastFromThem: them, lastFromOwner: mine } }),
    /^they wrote last, /u);
  assert.match(fns.spokeLastLine({ person: { lastFromThem: mine, lastFromOwner: them } }),
    /^you wrote last, /u);
  assert.match(fns.spokeLastLine({ person: { lastFromOwner: mine } }), /^you wrote last, /u);
  // Neither side known, but there was contact.
  assert.match(fns.spokeLastLine({ person: { lastSeen: them } }), /^you last spoke /u);
  // And a lastSeen must not override a side that IS known.
  assert.match(fns.spokeLastLine({ person: { lastFromThem: them, lastSeen: NOW } }),
    /^they wrote last, /u);
});

test('each number has one home on the card', () => {
  // Review finding 17. The live run-4 card printed messages/quiet/meetings in
  // the trigger, again in the tie sentence and a third time in the history row.
  const card = {
    kind: 'reconnect',
    evidence: { messages: 21, dormancyDays: 634, meetings: 1, lastMeetingDaysAgo: 700 },
  };
  const trigger = fns.triggerLine(card);
  const history = fns.historyLine(card);
  assert.equal(trigger, 'quiet 2 years', 'the trigger owns why now, and only that');
  assert.doesNotMatch(trigger, /21|message|met/u, 'counts do not belong in the trigger');
  assert.match(history, /21 messages/u);
  assert.match(history, /met 1×, last 2 years ago/u, 'and the meeting date it always had');
  assert.doesNotMatch(history, /quiet/u, 'the silence is said once, at the top');
  // Singulars, because "1 messages" shipped on a live card.
  assert.match(fns.historyLine({ evidence: { messages: 1, meetings: 0 } }), /^1 message$/u);
  // A card with nothing to count says nothing rather than printing zeroes.
  assert.equal(fns.historyLine({ evidence: { messages: 0, meetings: 0 } }), '');
  // THE NULL TRAP, on the exact field cardFacts.mjs warns about: Number(null)
  // is 0, so a finite-number test written the obvious way turns "we cannot say
  // when you last met" into "you met today".
  for (const unknown of [null, undefined, 'never']) {
    const line = fns.historyLine({ lastMeetingDaysAgo: unknown, evidence: { meetings: 2, messages: 0 } });
    assert.equal(line, 'met 2×', `${String(unknown)} must not become a date`);
  }
  // And the shipping shape: the count is top-level on the card, beside `person`.
  assert.match(fns.historyLine({ lastMeetingDaysAgo: 700, evidence: { meetings: 1, messages: 0 } }),
    /met 1×, last 2 years ago/u);
});

test('a public-web change carries how many sources stand behind it', () => {
  // THE SHIPPING SHAPE (cardFacts.mjs changedForCard): { text, at, sources: a
  // COUNT, sourceUrls: the list it used to be, url, kind, quote, date,
  // corroboration } — or null.
  assert.equal(
    fns.changedLine({ changed: { text: 'moved to anthropic', sources: 2, sourceUrls: ['a', 'b'], date: 'march 2026' } }),
    'moved to anthropic · 2 sources · march 2026'
  );
  assert.equal(fns.changedLine({ changed: { text: 'moved to anthropic', sources: 1 } }),
    'moved to anthropic · 1 source');
  // `date` is when the change happened; `at` is when this Mac looked it up. The
  // lookup time may stand in when the change carries no date of its own, and
  // must never displace one that does.
  const lookedUpAt = Date.parse('2026-03-04T09:00:00Z');
  assert.equal(
    fns.changedLine({ changed: { text: 'moved to anthropic', sources: 2, at: lookedUpAt, date: 'january 2026' } }),
    'moved to anthropic · 2 sources · january 2026'
  );
  assert.match(
    fns.changedLine({ changed: { text: 'moved to anthropic', sources: 2, at: lookedUpAt } }),
    /moved to anthropic · 2 sources · (in march|\d+ (months|years) ago)$/u
  );
  // The field changed MEANING rather than name, so the older array shape has to
  // answer too — and the obvious length test is wrong in both directions:
  // Number([]) is 0 and Number(['a']) is NaN.
  assert.equal(fns.sourceCount({ sources: ['a', 'b'] }), 2, 'an older list still counts');
  assert.equal(fns.sourceCount({ sources: 2 }), 2);
  assert.equal(fns.sourceCount({ sourceUrls: ['a'] }), 1, 'and the list under its new name');
  assert.equal(fns.sourceCount({ sources: 0 }), 0);
  assert.equal(fns.sourceCount({}), 0);
  assert.equal(fns.sourceCount({ sources: 'two' }), 0, 'a word is not a count');
  // No sources at all: the claim still shows, the count does not lie.
  assert.equal(fns.changedLine({ changed: { text: 'moved to anthropic' } }), 'moved to anthropic');
});

test('the counts are not said a third time by the producer’s template', () => {
  // THE CARD AS IT ACTUALLY RENDERS on a fresh install with no person page:
  // the trigger says the silence, the history row says the counts, and the tie
  // sentence between them said both again in different units.
  const template = 'Quiet 634 days · you two have 21 messages and 1 meeting';
  assert.equal(fns.tieLine({ kind: 'reconnect', sentence: template }), '',
    'the producer template is three statements of two numbers; the card keeps two');
  assert.equal(fns.tieLine({ kind: 'reconnect', sentence: 'Quiet 634 days' }), '',
    'and the no-counts form of the same template goes with it');
  assert.equal(fns.tieLine({ kind: 'reconnect', sentence: 'Quiet 1 day · you two have 1 message' }), '',
    'singulars included');
  // EVERYTHING ELSE STAYS. These are the three sentences that are not counts:
  // a page's own prose, the matcher producer's model-written line, and an Owe
  // card's receipt — none of which the card says anywhere else.
  const page = 'she asked whether you were still hiring and you never answered';
  assert.equal(fns.tieLine({ kind: 'reconnect', sentence: page }), page);
  const model = 'you worked together on the seed round and have not spoken since it closed';
  assert.equal(fns.tieLine({ kind: 'reconnect', sentence: model }), model);
  const owe = 'you said you would send the deck';
  assert.equal(fns.tieLine({ kind: 'owe', sentence: owe }), owe, 'an owe receipt is never a count');
  // A template that stops looking like itself renders, which is the safe way
  // for this to fail: a shown sentence is noise, a hidden one is a loss.
  assert.equal(fns.tieLine({ kind: 'reconnect', sentence: 'Quiet since March · 21 messages' }),
    'Quiet since March · 21 messages');
  assert.equal(fns.tieLine({ kind: 'reconnect', sentence: '' }), '');
});

test('the last three person facts reach the card', () => {
  // industry, connectedOn and url were computed, shipped and never rendered.
  assert.equal(fns.whoLine({ person: { title: 'Partner', industry: 'venture capital' } }),
    'Partner · venture capital', 'industry stands in for a company, never beside one');
  assert.equal(fns.whoLine({ person: { title: 'Partner', company: 'Sequoia', industry: 'venture capital' } }),
    'Partner at Sequoia', 'a company it has is better than a category it inferred');
  assert.equal(fns.whoLine({ person: { industry: 'venture capital' } }), 'venture capital');
  assert.equal(fns.linkedSince({ person: { connectedOn: Date.parse('2021-06-02T00:00:00Z') } }),
    'linked since 2021', 'the year, because the day is not a fact anybody holds');
  // Null is the ordinary case: parseConnectedOn answers null for every
  // non-English export, so this must print nothing rather than "linked since
  // 1970" or "linked since NaN".
  for (const bad of [null, undefined, 0, -1, 'june 2021', NaN]) {
    assert.equal(fns.linkedSince({ person: { connectedOn: bad } }), '',
      `${String(bad)} must not become a year`);
  }
});

test('the card has somewhere to put the two new lines', () => {
  assert.match(html, /id="rcChangedRow" hidden/u, 'and it starts hidden, like every optional row');
  assert.match(html, /id="rcChanged"/u);
  assert.match(html, /id="rcLeftWhen"/u);
  // .rc-facts div sets display, so [hidden] alone would change nothing — the
  // lesson this stylesheet already records for the role and left rows.
  const css = readFileSync(join(WIDGET, 'ui', 'reconnect.css'), 'utf8');
  assert.match(css, /\.rc-facts div\[hidden\] \{ display: none; \}/u);
  assert.match(css, /\.rc-left-when\[hidden\] \{ display: none; \}/u);
});

test('the empty card says which kind of nothing this is', () => {
  // "nothing to review" was shown for a spent cap, a muted queue and a fresh
  // install alike. The fresh install is the one that used to fall through.
  for (const reason of ['queue-empty', 'pool-exhausted', 'pool-exhausted-mode', 'unreachable']) {
    assert.match(src, new RegExp(`'${reason}':|\\b${reason}:`, 'u'),
      `${reason} must have words of its own`);
  }
  assert.match(src, /renderEmpty\(\{ reason: 'unreachable' \}\)/u,
    'a hermes that cannot be reached is not an empty queue');
  // Comments stripped: the line that removed it says what it removed.
  assert.doesNotMatch(src.replace(/\/\/[^\n]*/gu, ''), /console\.log/u,
    'and nothing logs to a demo machine’s console');
});
