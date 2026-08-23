// isDataless — the predicate the 45.6 GB rule rests on, which had no test.
//
// connectors/AGENTS.md § "files — the dataless rule": 96,262 of the 97,718
// files in the owner's cloud-mirror folders are dataless, and opening them
// would pull 45.6 GB down through iCloud on a timer. Everything that prevents
// that traces back to this one two-clause expression, and nothing exercised it.
//
// The stat objects here are fabricated on purpose. A genuinely dataless file
// cannot be created in a test — it is an iCloud placeholder — so the honest
// options were to fabricate the stat or to leave the rule untested. The
// predicate is pure and takes a stat, which makes fabricating it exact rather
// than approximate.
//
// WHAT IS STILL NOT COVERED, so a green line here is not read as more than it
// is: this proves the PREDICATE. It does not prove the CALL SITE in
// sources/files.mjs honours it, because extractText is a static import there
// and cannot be stubbed without changing that module's shape for testability.
// What guards the call site instead is `datalessOpenAttempts`, which counts
// refusals at the one place a read could happen and is reported in the
// files_scan log line — a number that goes non-zero the moment the guard stops
// holding, rather than the old `datalessNeverOpened: datalessSeen`, which was
// a copy of its own precondition and could not have noticed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isDataless } from '../lib/fileWalk.mjs';

// Only the two fields the predicate reads; naming it `stat` would imply the
// rest of a real stat is relevant, and it is not.
const s = (blocks, size) => ({ blocks, size });

test('a cloud placeholder — no blocks, non-zero size — is dataless', () => {
  assert.equal(isDataless(s(0, 1)), true);
  assert.equal(isDataless(s(0, 45_600_000_000)), true);
});

test('a materialized file is never dataless, however small', () => {
  assert.equal(isDataless(s(8, 1)), false);
  assert.equal(isDataless(s(1, 4096)), false);
});

test('an EMPTY file is not dataless — 0 blocks and 0 size is a real local file', () => {
  // The boundary the whole rule turns on. A genuinely empty file also reports
  // 0 blocks; treating it as dataless would be harmless here (it has nothing
  // to extract) but the distinction is what makes the predicate mean
  // "bytes live elsewhere" rather than "no bytes".
  assert.equal(isDataless(s(0, 0)), false);
});

test('it errs toward NOT reading, which is the safe direction', () => {
  // fileWalk.mjs:19-22 records the trade: a materialized neighbour can report
  // 0 blocks and be misread as dataless. That direction under-reads — a
  // document is skipped — instead of pulling gigabytes. This pins the sign of
  // the error so a future "fix" cannot quietly flip it to the expensive side.
  // Anything ambiguous must land on true (skip), never false (open).
  assert.equal(isDataless(s(0, 12)), true);
});

test('a stat missing the fields does not silently read the file', () => {
  // undefined === 0 is false, so a malformed stat currently returns false and
  // the file WOULD be opened. Pinned as the behaviour it is, not endorsed: if
  // a walk ever yields a partial stat this is the line that decides, and the
  // decision it makes today is the expensive one.
  assert.equal(isDataless({}), false);
  assert.equal(isDataless(s(undefined, 10)), false);
});
