// Where the files cursor lands, and specifically what happens when the scan
// cap falls in the middle of a group of files sharing one mtime.
//
// This had no test and a guard that could never fire. The old code read
// `if (capped && maxMtime === floor.ms)`, but candidates are filtered to
// mtime > floor, so the last delivered mtime is never equal to the floor —
// the condition was unreachable by construction. Meanwhile the loss it was
// written to bound happened on every capped scan: files sharing the boundary
// millisecond that did not fit fell to `mtime > cursor` next run and were
// never offered again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFileCursor } from '../sources/files.mjs';

const f = (mtime) => ({ mtime });

test('an uncapped scan advances to the last delivered mtime', () => {
  const batch = [f(10), f(20), f(30)];
  assert.deepEqual(nextFileCursor({ batch, candidates: batch, capped: false }), {
    cursor: 30,
    dropped: 0,
    stalled: false,
  });
});

test('nothing delivered leaves the cursor alone', () => {
  for (const batch of [[], undefined, null]) {
    assert.equal(nextFileCursor({ batch, candidates: [], capped: true }).cursor, null);
  }
});

test('a capped scan rewinds one ms so the boundary tie is re-offered', () => {
  // Three files share mtime 30; only one fits. Advancing to 30 would drop the
  // other two forever. Rewinding to 29 re-offers all three next run — the
  // delivered one comes back `unchanged`, the other two finally land.
  const batch = [f(10), f(20), f(30)];
  const candidates = [...batch, f(30), f(30)];
  const out = nextFileCursor({ batch, candidates, capped: true });
  assert.equal(out.cursor, 29, 'must include mtime 30 on the next scan');
  assert.equal(out.stalled, false);
  assert.equal(out.dropped, 0);
});

test('rewinding still makes progress — the batch is not all one mtime', () => {
  // The worry with rewinding is a loop. It cannot loop here: the next scan
  // starts at 29, so everything below 30 is already behind the cursor and only
  // the tie is repeated.
  const batch = [f(10), f(20), f(30)];
  const out = nextFileCursor({ batch, candidates: batch, capped: true });
  assert.ok(out.cursor > batch[0].mtime, 'the cursor still moved past the earlier files');
});

test('a tie WIDER than the cap steps past it and reports the loss', () => {
  // The case the original comment feared and the code never reached: every
  // file in the batch shares one mtime and more are waiting. Re-offering would
  // deliver the same files forever and the connector would never advance, so
  // this steps past — a bounded, reported loss beats an unbounded stall.
  const batch = [f(50), f(50), f(50)];
  const candidates = [f(50), f(50), f(50), f(50), f(50)];
  const out = nextFileCursor({ batch, candidates, capped: true });
  assert.equal(out.cursor, 51, 'must move past the tie to avoid stalling');
  assert.equal(out.stalled, true);
  assert.equal(out.dropped, 2, 'and say how many were left behind');
});

test('a single-file capped batch is treated as the wide-tie case', () => {
  // batch[0] === batch[last], so it takes the step-past branch. Correct: a cap
  // of one cannot re-offer without stalling.
  const out = nextFileCursor({ batch: [f(7)], candidates: [f(7), f(7)], capped: true });
  assert.equal(out.cursor, 8);
  assert.equal(out.stalled, true);
  assert.equal(out.dropped, 1);
});

test('dropped never goes negative on a malformed candidate list', () => {
  const out = nextFileCursor({ batch: [f(5), f(5)], candidates: [], capped: true });
  assert.equal(out.dropped, 0);
});
