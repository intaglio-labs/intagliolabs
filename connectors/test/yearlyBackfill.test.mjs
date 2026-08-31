import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createYearlyBackfill,
  localYearBounds,
  yearlyBackfillCoverage,
} from '../lib/yearlyBackfill.mjs';

function memoryState() {
  const values = new Map();
  return {
    values,
    getCursor: (key) => values.get(key) ?? null,
    setCursor: (key, value) => values.set(key, String(value)),
    deleteCursor: (key) => values.delete(key),
    deleteCursors: (prefix) => {
      let deleted = 0;
      for (const key of [...values.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}:`)) {
          values.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

const NOW = new Date(2026, 7, 28, 12).getTime();

test('local year bounds match the same local-year buckets the people graph uses', () => {
  assert.deepEqual(localYearBounds(2026), {
    year: 2026,
    fromTs: new Date(2026, 0, 1).getTime(),
    toTs: new Date(2027, 0, 1).getTime(),
  });
});

test('coverage reports durable year checkpoints without cursor values', () => {
  const state = memoryState();
  state.setCursor('yearly-backfill:year', '2025');
  state.setCursor('yearly-backfill:connector:imessage:done:2026', '1');
  state.setCursor('yearly-backfill:connector:calendar:exhausted', '1');
  const coverage = yearlyBackfillCoverage({
    state,
    connectors: ['imessage', 'calendar'],
    now: () => NOW,
  });
  assert.deepEqual(coverage, {
    year: 2025,
    complete: false,
    connectors: [
      { connector: 'imessage', completedYears: [2026], exhausted: false, pending: true },
      { connector: 'calendar', completedYears: [], exhausted: true, pending: false },
    ],
  });
});

test('all available sources finish a year before the barrier moves backwards', () => {
  const state = memoryState();
  const q = createYearlyBackfill({ state, connectors: ['imessage', 'calendar', 'mail'], now: () => NOW });
  q.classify('imessage', true);
  q.classify('calendar', true);
  q.classify('mail', true);
  assert.equal(q.task('imessage').year, 2026);
  q.record('imessage', { historyDone: true, historyHasOlder: true });
  q.record('calendar', { historyDone: true, historyHasOlder: true });
  assert.equal(q.advance(), false, 'mail still owns the 2026 barrier');
  q.record('mail', { historyDone: true, historyHasOlder: true });
  assert.equal(q.advance(), true);
  assert.equal(q.snapshot().year, 2025);
});

test('restart reconciliation skips a completed durable barrier', () => {
  const state = memoryState();
  state.setCursor('yearly-backfill:year', '2024');
  for (const year of [2026, 2025, 2024]) {
    state.setCursor(`yearly-backfill:connector:matrix:done:${year}`, '1');
    state.setCursor(`yearly-backfill:connector:calendar:done:${year}`, '1');
  }
  // Calendar had already scanned farther before Matrix joined. Matrix is the
  // first source that still has work once the 2024 barrier is reconciled.
  state.setCursor('yearly-backfill:connector:calendar:done:2023', '1');
  const q = createYearlyBackfill({
    state,
    connectors: ['matrix', 'calendar'],
    now: () => NOW,
  });
  q.classify('matrix', true);
  q.classify('calendar', true);

  const recovered = q.reconcile();

  assert.equal(recovered.fromYear, 2024);
  assert.equal(recovered.year, 2023);
  assert.equal(recovered.advanced, 1);
  assert.deepEqual(recovered.pending, ['matrix']);
  assert.equal(q.task('matrix')?.year, 2023);
});

test('unavailable sources do not block and calendar stops at the oldest real timeline', () => {
  const state = memoryState();
  const q = createYearlyBackfill({ state, connectors: ['imessage', 'calendar', 'mail'], now: () => NOW });
  q.classify('imessage', true);
  q.classify('calendar', true);
  q.classify('mail', false);
  q.record('imessage', { historyDone: true, historyHasOlder: false });
  q.record('calendar', { historyDone: true, historyHasOlder: true });
  assert.equal(q.advance(), true);
  assert.equal(q.snapshot().complete, true);
  assert.equal(q.snapshot().year, 2026, 'calendar alone cannot create an older year');
});

test('a connector authorized later reopens at the current year without erasing other checkpoints', () => {
  const state = memoryState();
  const q = createYearlyBackfill({ state, connectors: ['imessage', 'mail'], now: () => NOW });
  q.classify('imessage', true);
  q.classify('mail', false);
  q.record('imessage', { historyDone: true, historyHasOlder: false });
  q.advance();
  assert.equal(q.snapshot().complete, true);
  q.classify('mail', true);
  assert.equal(q.snapshot().complete, false);
  assert.equal(q.task('imessage'), null, 'its prior 2026 checkpoint remains useful');
  assert.equal(q.task('mail').year, 2026);
});

test('authorization after restart reopens durable completion', () => {
  const state = memoryState();
  state.setCursor('yearly-backfill:complete', '1');
  state.setCursor('yearly-backfill:year', '2024');
  state.setCursor('yearly-backfill:connector:matrix:exhausted', '1');
  const q = createYearlyBackfill({ state, connectors: ['matrix'], now: () => NOW });

  q.classify('matrix', true);

  assert.equal(q.snapshot().complete, false);
  assert.equal(q.snapshot().year, 2026);
  assert.equal(q.task('matrix')?.year, 2026);
});

test('authorization after restart catches up from current year while older years are running', () => {
  const state = memoryState();
  state.setCursor('yearly-backfill:year', '2024');
  state.setCursor('yearly-backfill:connector:imessage:done:2026', '1');
  const q = createYearlyBackfill({
    state,
    connectors: ['imessage', 'mail'],
    now: () => NOW,
  });

  q.classify('imessage', true);
  q.classify('mail', true);

  assert.equal(q.snapshot().year, 2026);
  assert.equal(q.task('imessage'), null);
  assert.equal(q.task('mail')?.year, 2026);
});

test('a newly discovered stream reopens every completed year for only that connector', () => {
  const state = memoryState();
  state.setCursor('yearly-backfill:complete', '1');
  state.setCursor('yearly-backfill:year', '2023');
  state.setCursor('yearly-backfill:connector:matrix:done:2026', '1');
  state.setCursor('yearly-backfill:connector:matrix:done:2025', '1');
  state.setCursor('yearly-backfill:connector:imessage:done:2026', '1');
  const q = createYearlyBackfill({ state, connectors: ['matrix', 'imessage'], now: () => NOW });
  q.classify('matrix', true);
  q.classify('imessage', true);

  assert.equal(q.reopen('matrix'), true);

  assert.equal(q.snapshot().complete, false);
  assert.equal(q.snapshot().year, 2026);
  assert.equal(q.task('matrix')?.year, 2026);
  assert.equal(q.task('imessage'), null, 'unrelated completion remains intact');
  assert.equal(state.getCursor('yearly-backfill:connector:matrix:done:2025'), null);
});
