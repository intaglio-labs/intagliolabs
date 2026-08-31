// Background summarisation follows an explicit performance setting. Both modes
// continue on battery; Battery Saver lowers concurrency instead of pausing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mayWarmInBackground, performanceMode } from '../server/people/power.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hermes = readFileSync(join(ROOT, 'server/hermes.mjs'), 'utf8');

test('both modes continue background processing', async () => {
  assert.equal(await mayWarmInBackground(), true);
  const dir = mkdtempSync(join(tmpdir(), 'intaglio-performance-'));
  const file = join(dir, 'mode');
  try {
    writeFileSync(file, 'battery_saver\n', { mode: 0o600 });
    assert.equal(performanceMode({ file }), 'battery_saver');
    writeFileSync(file, 'god_mode\n', { mode: 0o600 });
    assert.equal(performanceMode({ file }), 'god_mode');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or malformed mode preserves processing in god mode', () => {
  assert.equal(performanceMode({ file: '/definitely/missing/intaglio-mode' }), 'god_mode');
  const dir = mkdtempSync(join(tmpdir(), 'intaglio-performance-'));
  const file = join(dir, 'mode');
  try {
    writeFileSync(file, 'pause_everything\n', { mode: 0o600 });
    assert.equal(performanceMode({ file }), 'god_mode');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warming always runs and remains bounded', () => {
  assert.match(hermes, /mayWarmInBackground\(\)\.then/u,
    'the year-open enqueue must pass through the workload-policy seam');
  // ~~/warmable\.slice\(0, WARM_AHEAD\)/~~ — that bounded the HEADCOUNT, which is
  // exactly the limit that turned out not to bind: twelve people is modest
  // until one is worth twenty chunks. The selection moved into pickWarmSet,
  // which prices them, and the tests at the bottom of this file exercise it
  // directly instead of asserting on the shape of a call here.
  assert.match(hermes, /pickWarmSet\(warmable, year\)/u,
    'even on AC it must warm a bounded, PRICED set rather than the whole page');
  assert.match(hermes, /performanceMode\(\) === 'battery_saver'[\s\S]*?\? 1/u,
    'Battery Saver must reduce concurrency rather than pausing work');
});

// AND MAY NOT COOK THE MACHINE ON MAINS EITHER.
//
// The battery gate above was the wrong axis, and the owner's fans proved it a
// second time on 2026-08-30 — on AC both times. WARM_AHEAD bounded the
// HEADCOUNT and nothing bounded the cost: one People year-open queued twelve
// people, one of them a 12,000-message friendship worth twenty chunks, and a
// chunk measured ~90s of solid GPU (summary_chunks advanced by exactly one per
// 90s for two and a quarter hours, on 28,160-token batch prompts against a
// 32,768 context).
//
// These exercise the REAL selection, imported, not a copy of its arithmetic.

import {
  estimateChunks, pickWarmSet,
  WARM_AHEAD, WARM_PERSON_CHUNK_CAP, WARM_CHUNK_BUDGET,
} from '../server/people/summary.mjs';

test('a person costs at least one chunk, and scales with their rows', () => {
  assert.equal(estimateChunks(0), 0, 'nobody is not work');
  assert.equal(estimateChunks(undefined), 0);
  assert.equal(estimateChunks(1), 1, 'a tiny thread is still one call');
  assert.equal(estimateChunks(600), 1);
  assert.equal(estimateChunks(601), 2, 'past the row cap it splits');
  assert.equal(estimateChunks(12_000), 20, 'the friendship that started this');
});

test('the per-person cap binds even when the budget could afford it', () => {
  // 8 chunks: over WARM_PERSON_CHUNK_CAP (4) but well under WARM_CHUNK_BUDGET
  // (12). Only the per-person cap can reject this one, so removing that guard
  // makes this test fail — which the first version of it did not.
  const mid = { key: 'mid', messages: 600 * 8 };
  assert.ok(estimateChunks(mid.messages) > WARM_PERSON_CHUNK_CAP);
  assert.ok(estimateChunks(mid.messages) <= WARM_CHUNK_BUDGET);
  assert.deepEqual(pickWarmSet([mid], 2026), [],
    'a person too expensive to warm must be skipped on their own account');
});

test('one heavy relationship cannot eat the warm budget', () => {
  const whale = { key: 'whale', messages: 12_000 };
  const small = Array.from({ length: 5 }, (_, i) => ({ key: `s${i}`, messages: 300 }));
  const picked = pickWarmSet([whale, ...small], 2026);
  assert.ok(!picked.some((p) => p.key === 'whale'), 'the whale must be skipped');
  assert.equal(picked.length, 5, 'and the cheap people behind it still warm');
});

test('the budget binds before the headcount does', () => {
  // Six people at three chunks each is 18 against a budget of 12, and six is
  // well under WARM_AHEAD — so only the budget can stop this.
  const people = Array.from({ length: 6 }, (_, i) => ({ key: `p${i}`, messages: 600 * 3 }));
  assert.ok(people.length < WARM_AHEAD);
  assert.equal(pickWarmSet(people, 2026).length, 4,
    'four at three chunks fills the budget exactly');
});

test('a person who overflows the budget does not truncate the list behind them', () => {
  // `continue`, not `break`. Ten chunks are spent, the next costs four and will
  // not fit, and a one-chunk person behind them still should. Swapping that
  // continue for a break drops "tiny" — the earlier version of this test used a
  // person the PER-PERSON cap rejected first, so it never reached this line.
  const people = [
    { key: 'a', messages: 600 * 4 },
    { key: 'b', messages: 600 * 4 },
    { key: 'c', messages: 600 * 2 },
    { key: 'overflow', messages: 600 * 4 },
    { key: 'tiny', messages: 600 * 1 },
  ];
  assert.deepEqual(pickWarmSet(people, 2026).map((p) => p.key), ['a', 'b', 'c', 'tiny']);
});

test('headcount still binds when everyone is cheap', () => {
  const people = Array.from({ length: 40 }, (_, i) => ({ key: `p${i}`, messages: 20 }));
  const picked = pickWarmSet(people, 2026);
  assert.ok(picked.length <= WARM_AHEAD);
  assert.ok(picked.length <= WARM_CHUNK_BUDGET);
});

test('the caps are the ones hermes actually uses', () => {
  // hermes must not carry its own copies; they moved to summary.mjs precisely
  // so there is one set of numbers.
  assert.match(hermes, /pickWarmSet\(warmable, year\)/u, 'hermes must call the real selection');
  const code = hermes.split('\n').filter((l) => !/^\s*\/\//u.test(l)).join('\n');
  assert.doesNotMatch(code, /const WARM_(AHEAD|CHUNK_BUDGET|PERSON_CHUNK_CAP)\s*=/u,
    'a second copy of a cap is how the two drift');
  assert.ok(WARM_PERSON_CHUNK_CAP < WARM_CHUNK_BUDGET,
    'a per-person cap at or above the budget would let one person take it all');
});
