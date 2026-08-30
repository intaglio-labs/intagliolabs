// Background summarisation may not flatten the owner's battery.
//
// Opening a People year enqueued every person on the page with >= MIN_ROWS
// messages for a full hierarchical summary — several local model calls each, and
// one 11,765-message friendship is 35 chunks before the reduce starts. Nothing
// in the path had any notion of power: PowerBudget.swift reads thermalState and
// isLowPowerModeEnabled, but it lives in the widget and hermes is a separate
// process. Opening one year on battery put the fans at full blast (owner,
// 2026-08-30, measured at 82% on battery).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { powerState, resetPowerCache, mayWarmInBackground } from '../server/people/power.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hermes = readFileSync(join(ROOT, 'server/hermes.mjs'), 'utf8');

test('the power state is readable and shaped', async () => {
  resetPowerCache();
  const p = await powerState();
  assert.equal(typeof p.onAC, 'boolean');
  assert.ok(p.percent === null || (p.percent >= 0 && p.percent <= 100));
  assert.equal(typeof p.known, 'boolean');
});

test('an unreadable power state is permissive, not silently disabling', async () => {
  // A wrong "yes" costs a warm laptop; a wrong "no" is a feature that never runs
  // and nobody can explain. Fail toward the explainable one.
  const src = readFileSync(join(ROOT, 'server/people/power.mjs'), 'utf8');
  assert.match(src, /resolve\(\{ onAC: true, percent: null, known: false \}\)/u,
    'a failed read must not permanently stop background work');
});

test('the answer is cached, so this is not a fork per page load', async () => {
  resetPowerCache();
  const a = await powerState({ now: 1_000 });
  const b = await powerState({ now: 1_500 });
  assert.strictEqual(a, b, 'inside the TTL the same object must come back');
  const c = await powerState({ now: 1_000 + 60_000 });
  assert.notStrictEqual(a, c, 'past the TTL it must re-read');
});

test('warming is gated on power and bounded even on AC', () => {
  assert.match(hermes, /mayWarmInBackground\(\)\.then/u,
    'the year-open enqueue must ask about power first');
  assert.match(hermes, /warmable\.slice\(0, WARM_AHEAD\)/u,
    'even on AC it must warm a bounded head, not the whole page');
  // The foreground path must NOT be gated: a person the owner actually opens is
  // priority 2 and has to work on battery.
  const at = hermes.indexOf('mayWarmInBackground');
  const p2 = hermes.indexOf('priority: 2');
  assert.ok(p2 === -1 || p2 < at || hermes.slice(at, at + 600).indexOf('priority: 2') === -1,
    'foreground summaries must not sit behind the power gate');
});

test('the gate admits nothing on battery', async () => {
  resetPowerCache();
  const p = await powerState();
  const may = await mayWarmInBackground();
  assert.equal(may, p.onAC, 'warming tracks AC power exactly');
});
