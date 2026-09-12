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
const html = readFileSync(join(WIDGET, 'ui', 'onboarding.html'), 'utf8');

// The body of startReadingSources, up to the closing brace of its return: the
// assertions below are about what THIS function does, and a matching call
// somewhere else in a 3000-line file would satisfy a whole-file search while
// leaving the fresh install exactly as broken.
function startReadingSourcesBody() {
  const start = swift.indexOf('private func startReadingSources() -> Bool {');
  assert.ok(start > 0, 'startReadingSources must still exist under that name');
  const end = swift.indexOf('\n  }', start);
  assert.ok(end > start, 'the function body must be findable');
  return swift.slice(start, end);
}

test('starting the reader records the daily card settings first', () => {
  const body = startReadingSourcesBody();
  const post = body.indexOf('"admin/config/card"');
  assert.ok(post > 0,
    'startReadingSources must post admin/config/card; without it a fresh install\n' +
    "never gets a capPerDay and hermes' card route answers no-cap-configured forever");
  const call = body.slice(post, post + 200);
  assert.match(call, /"capPerDay": 1/u,
    'the cap posted must be the one screen 1 promises: one a day');
  // The producer has the same shape of problem as the cap: hermes reads an
  // absent relationshipMemory.producer as the legacy matcher path, and the card
  // this app ships is the eligibility producer's. A fresh install that records
  // a cap but no producer turns the feature on pointing at the wrong producer.
  assert.match(call, /"producer": "eligibility"/u,
    'the producer the shipped card comes from must be recorded with the cap');

  const readerStart = body.indexOf('Connectors.shared.start()');
  assert.ok(readerStart > 0, 'startReadingSources must still start the reader');
  assert.ok(post < readerStart,
    'the cap is recorded before the reader starts: the press that turns reading on is\n' +
    'the same press that chooses one card a day, and ordering them the other way puts\n' +
    'the write behind whatever the reader does on its first pass');
});

test('the settings write cannot stop the reader from starting', () => {
  const body = startReadingSourcesBody();
  // Fire and forget through relHermes, whose completion runs off the request.
  // A card that appears tomorrow is not a precondition for reading today, so a
  // hermes that is not up yet must not leave every source unread.
  assert.match(body, /relHermes\("POST", "admin\/config\/card"/u,
    'the post goes through relHermes, which is asynchronous and bearer-authenticated');
  const post = body.indexOf('"admin/config/card"');
  const tail = body.slice(post);
  assert.doesNotMatch(tail.slice(0, tail.indexOf('Connectors.shared.start()')), /\breturn\b/u,
    'no early return between recording the cap and starting the reader');
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
