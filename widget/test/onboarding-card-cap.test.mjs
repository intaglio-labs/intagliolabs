// THE PRESS THAT STARTS THE READER ALSO RECORDS THE NUMBER THE SCREEN SHOWED.
//
// hermes fails closed on the daily reconnect card: with
// relationshipMemory.capPerDay absent from ~/.hazlie/connectors/config.json it
// serves nothing and says 'no-cap-configured', because a threshold is the
// owner's to set and never one the server invents. The config this app writes
// on a fresh install is `{}`. On the clean-machine retest that combination
// meant the card could never appear at all.
//
// The fix is not a default in hermes. It is that screen 1 says "one person a
// day" and "one card a day" directly above the button, so pressing it IS the
// owner choosing one a day -- and startReadingSources writes that down. This
// file pins the three things that argument depends on: the screen still makes
// the claim, the press still records it, and it is recorded BEFORE the reader
// starts rather than at some later moment nobody can point at.
//
// AND A PRESS IS NOT A REQUEST. The post used to be fire-and-forget: hermes
// answers `{"state":"down"}` on a refused connection and the handler only
// logged it, so a first launch where hermes was still warming -- the ordinary
// case, since the same launch starts it -- left capPerDay unwritten anyway and
// the card could never appear. The owner's choice is now RECORDED first and
// the delivery retried, within the launch and again on the next one, until it
// lands once. That is pinned here too.
//
// A source scan, because there is nothing runnable here: the ordering lives in
// one Swift function and the sentence lives in one HTML file, and they drift
// apart silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const swift = readFileSync(join(WIDGET, 'src', 'Bridge.swift'), 'utf8');
const main = readFileSync(join(WIDGET, 'src', 'main.swift'), 'utf8');
const html = readFileSync(join(WIDGET, 'ui', 'onboarding.html'), 'utf8');

// The body of one function, up to its closing brace: the assertions below are
// about what THAT function does, and a match somewhere else in a 3000-line
// file would satisfy a whole-file search while leaving the fresh install
// exactly as broken.
function bodyOf(signature) {
  const start = swift.indexOf(signature);
  assert.ok(start > 0, `${signature} must still exist under that name`);
  const end = swift.indexOf('\n  }', start);
  assert.ok(end > start, `the body of ${signature} must be findable`);
  return swift.slice(start, end);
}

const startReadingSourcesBody = () =>
  bodyOf('private func startReadingSources() -> Bool {');

test('starting the reader records the daily card settings first', () => {
  const body = startReadingSourcesBody();
  const record = body.indexOf('recordCardDefaults()');
  assert.ok(record > 0,
    'startReadingSources must record the daily card settings; without them a fresh\n' +
    "install never gets a capPerDay and hermes' card route answers no-cap-configured\n" +
    'forever');

  const post = bodyOf('private func postCardDefaults(attempt: Int) {');
  assert.match(post, /"admin\/config\/card"/u,
    'the settings must still reach hermes at admin/config/card');
  assert.match(post, /"capPerDay": 1/u,
    'the cap posted must be the one screen 1 promises: one a day');
  // The producer has the same shape of problem as the cap: hermes reads an
  // absent relationshipMemory.producer as the legacy matcher path, and the card
  // this app ships is the eligibility producer's. A fresh install that records
  // a cap but no producer turns the feature on pointing at the wrong producer.
  assert.match(post, /"producer": "eligibility"/u,
    'the producer the shipped card comes from must be recorded with the cap');

  const readerStart = body.indexOf('Connectors.shared.start()');
  assert.ok(readerStart > 0, 'startReadingSources must still start the reader');
  assert.ok(record < readerStart,
    'the cap is recorded before the reader starts: the press that turns reading on is\n' +
    'the same press that chooses one card a day, and ordering them the other way puts\n' +
    'the write behind whatever the reader does on its first pass');
});

test('the settings write cannot stop the reader from starting', () => {
  const body = startReadingSourcesBody();
  // Asynchronous through relHermes, whose completion runs off the request. A
  // card that appears tomorrow is not a precondition for reading today, so a
  // hermes that is not up yet must not leave every source unread.
  assert.match(bodyOf('private func postCardDefaults(attempt: Int) {'),
    /relHermes\("POST", "admin\/config\/card"/u,
    'the post goes through relHermes, which is asynchronous and bearer-authenticated');
  const record = body.indexOf('recordCardDefaults()');
  const tail = body.slice(record);
  assert.doesNotMatch(tail.slice(0, tail.indexOf('Connectors.shared.start()')), /\breturn\b/u,
    'no early return between recording the cap and starting the reader');
});

test('the choice is written down before the attempt to deliver it', () => {
  const body = bodyOf('private func recordCardDefaults() {');
  const flag = body.indexOf('Bridge.cardDefaultsPending = true');
  assert.ok(flag > 0,
    'the press must be recorded as pending before anything is sent; a crash or a quit\n' +
    'mid-retry otherwise loses the choice the owner made with no trace of it anywhere');
  const post = body.indexOf('postCardDefaults(attempt: 0)');
  assert.ok(post > flag,
    'the flag is set FIRST -- setting it after the post is a window in which the\n' +
    'process can die having neither delivered the choice nor remembered it');
});

test('a refused post is retried, boundedly, and the flag clears only on success', () => {
  const body = bodyOf('private func postCardDefaults(attempt: Int) {');
  assert.match(body, /state == "ok"/u,
    'only an "ok" reply may end the retries: relHermes answers state "down" on a\n' +
    'refused connection and "auth" before the bearer token exists, and both of those\n' +
    'are the warming hermes this retry was written for');
  const ok = body.indexOf('state == "ok"');
  const clear = body.indexOf('Bridge.cardDefaultsPending = false');
  assert.ok(clear > ok,
    'the pending flag is cleared inside the success branch and nowhere else');
  assert.match(body, /attempt < Bridge\.cardDefaultsRetryDelays\.count/u,
    'the retries must be bounded by the delay table rather than looping forever');
  assert.match(body, /postCardDefaults\(attempt: attempt \+ 1\)/u,
    'each retry must advance the attempt, or the bound above never bites');

  const table = /cardDefaultsRetryDelays: \[Double\] = \[([^\]]*)\]/u.exec(swift);
  assert.ok(table, 'the delay table must still be a literal array');
  const delays = table[1].split(',').map((n) => Number(n.trim()));
  assert.ok(delays.every((n) => Number.isFinite(n) && n > 0), 'every delay must be a positive number');
  assert.ok(delays.length + 1 >= 8,
    `a warming hermes wants several attempts, not two (got ${delays.length + 1})`);
  const total = delays.reduce((a, b) => a + b, 0);
  assert.ok(total >= 60 && total <= 240,
    `the window must cover a hermes warm-up without polling for ever (got ${total}s)`);
});

test('a launch that could not deliver the choice tries again at the next one', () => {
  assert.match(swift, /func resumeCardDefaultsIfPending\(\)/u,
    'there must be a resume path; without it a machine whose hermes was down for the\n' +
    'whole of one session never records the choice at all');
  const resume = bodyOf('func resumeCardDefaultsIfPending() {');
  assert.match(resume, /guard Bridge\.cardDefaultsPending else \{ return \}/u,
    'the resume must be a no-op once the settings have landed -- every launch after\n' +
    'the first success otherwise re-posts them');
  assert.match(main, /bridge\.resumeCardDefaultsIfPending\(\)/u,
    'applicationDidFinishLaunching must call it; a resume nothing calls is a flag that\n' +
    'is set for ever and a card that never appears');
});

test('screen 1 still says the number the press records', () => {
  // If this copy ever changes, the write above stops being the owner's choice
  // and becomes a threshold invented by the app -- which is the thing hermes'
  // fail-closed rule exists to prevent. Change the copy, and this write needs
  // its own answer, not a passing test.
  assert.match(html, /one person a day/u,
    "onboarding's first screen must still promise one person a day");
  assert.match(html, /one card a day/u,
    'the paragraph under it must still promise one card a day');
});

test('the mode row still promises the choice is kept', () => {
  // The other half of the same screen: POST /admin/relationship/mode now
  // persists relationshipMemory.mode because this sentence says it does.
  assert.match(html, /your choice is kept by the reader/u,
    'the note under the mode row must still promise the choice survives a restart');
  assert.match(swift, /relHermes\("POST", "admin\/relationship\/mode"/u,
    'the mode row must still reach hermes, which is what writes it down');
});

test('leaving screen 2 and entering screen 6 both start the reader, grants or no grants', () => {
  // On the second clean-machine run (2026-09-12) every grant was already in
  // place, so no permission ever turned green on screen 2, startedSources()
  // never fired, and the daily card's settings stayed unwritten until the
  // LinkedIn import happened to call it. The two screens that bracket the
  // reading now ask for it unconditionally; native makes the call idempotent.
  const js = readFileSync(join(WIDGET, 'ui', 'onboarding.js'), 'utf8');
  assert.match(js, /permNext\.addEventListener\('click', \(\) => \{\s*startedSources\(\);\s*nextScreen\(\);\s*\}\)/u,
    "screen 2's next starts the reader before moving on");
  assert.match(js, /function enterLoad\(\) \{[\s\S]{0,400}startedSources\(\);[\s\S]{0,80}startLoadPolling\(\)/u,
    'entering the first-load screen starts the reader before polling for rows');
});
