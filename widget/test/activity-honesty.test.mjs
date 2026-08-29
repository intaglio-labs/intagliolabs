// The activity panel may not state a time it cannot measure.
//
// The owner watched the header read "~ 0.2 hrs left" on pass after pass while
// history pagination ran thousands of events deep, and asked the only sensible
// question: "why doesnt it ever progress from the first one / how do i knoe its
// working / how much is left" (2026-08-29).
//
// It was not stuck. The arithmetic was ceil(rooms / pagesPerPass) — with 9 rooms
// and a rate of 11 that is 1 — so the answer was always exactly one interval
// away. The variable was honestly named minimumPasses and then rendered as a
// forecast. A lower bound presented as time remaining is not measuring what its
// label claims, which is what CLAUDE.md's first hard rule is about.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const daemonRaw = readFileSync(join(ROOT, 'connectors/daemon.mjs'), 'utf8');
// CODE ONLY. This file explains the arithmetic it removed by naming it, so a
// raw scan matches the retraction and reports the fixed bug as still present.
const daemon = daemonRaw.split('\n').filter((l) => !/^\s*\/\//u.test(l)).join('\n');
const connectors = readFileSync(join(ROOT, 'widget/src/Connectors.swift'), 'utf8');

test('matrix history contributes no completion time', () => {
  // The whole defect in one line: this pushed a completion time derived from a
  // floor. Pagination is opaque; a room can need one more page or four hundred.
  assert.doesNotMatch(
    daemon,
    /minimumPasses/u,
    'a minimum number of passes must not be turned into an ETA'
  );
});

test('it reports a count of conversations instead', () => {
  assert.match(daemon, /backfillRooms = rooms/u, 'the daemon must publish the room count');
  assert.match(daemon, /backfillRooms,/u, 'and include it in the published object');
});

test('a backfill with no estimate is still published', () => {
  // Otherwise removing the false ETA would have made the panel go silent, which
  // is a worse answer to "how do I know it is working" than a wrong number.
  assert.match(
    daemon,
    /return backfill\.length === 0 \? null : \{ backfill, backfillRooms \}/u,
    'work with no knowable end must still surface'
  );
});

test('the UI renders the count, not a duration', () => {
  assert.match(connectors, /raw\["backfillRooms"\] as\? Int/u);
  assert.match(connectors, /conversation\\\(rooms == 1 \? "" : "s"\)/u,
    'the row should say how many conversations');
});
