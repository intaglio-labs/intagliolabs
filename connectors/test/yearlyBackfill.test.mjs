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

test('a product barrier completes People before connector history enters the prior year', () => {
  const state = memoryState();
  const q = createYearlyBackfill({
    state, connectors: ['imessage', 'calendar'], barriers: ['people'], now: () => NOW,
  });
  q.classify('imessage', true);
  q.classify('calendar', true);
  q.record('imessage', { historyDone: true, historyHasOlder: true });
  q.record('calendar', { historyDone: true, historyHasOlder: true });
  assert.deepEqual(q.snapshot().pending, ['people']);
  assert.equal(q.advance(), false, '2025 must wait for 2026 People completion');
  assert.equal(q.recordBarrier('people'), true);
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

// A ROSTER MEMBER NOBODY WILL EVER CLASSIFY IS A DEADLOCK, NOT A WAIT.
//
// advance() holds the year until every roster member has been classified once,
// which is right for a source that is merely slow to start. It is fatal for one
// that is not scheduled at all: nothing will call classify() for it, ever, so
// the year never decrements, `complete` is never set, and every OTHER source's
// history stops at the current year. That is exactly what a registry-disabled
// history source did while the roster was still built from the full catalogue.
test('a roster member that is never scheduled cannot stall the barrier', () => {
  const state = memoryState();
  state.setCursor('yearly-backfill:connector:imessage:done:2026', '1');
  const q = createYearlyBackfill({
    state,
    connectors: ['imessage', 'matrix'],
    now: () => NOW,
  });
  q.classify('imessage', true);

  assert.equal(q.advance(), false, 'an unclassified roster member still holds the year');
  assert.equal(q.snapshot().year, 2026);

  assert.equal(q.withdraw('matrix'), true);
  assert.equal(q.snapshot().classified, true,
    'a withdrawn member counts as classified — it is inactive, not pending');
  assert.equal(q.advance(), true);
  assert.equal(q.snapshot().year, 2025, 'the barrier moves for the sources that DO run');
  assert.deepEqual(q.snapshot().active, ['imessage']);
  assert.equal(q.withdraw('granola'), false, 'a name off the roster is not a member to withdraw');
});

test('a withdrawn source that comes back rejoins the barrier', () => {
  const state = memoryState();
  const q = createYearlyBackfill({ state, connectors: ['imessage', 'matrix'], now: () => NOW });
  q.classify('imessage', true);
  q.withdraw('matrix');
  assert.equal(q.snapshot().classified, true);

  // Re-enabled mid-process: its next tick classifies it, and the barrier waits
  // for its 2026 the same as everyone else's.
  q.classify('matrix', true);
  assert.deepEqual(q.snapshot().pending.sort(), ['imessage', 'matrix']);
  assert.equal(q.advance(), false);
});

// NOTHING TO WALK IS FINISHED, NOT FOREVER UNFINISHED.
//
// advance() returned false while `active` was empty, so an install where every
// history source is unavailable — now reachable in one step, because an
// unreadable feature registry is ALL_OFF — never set COMPLETE. Nothing was
// stuck on a year, because nothing was walking one; what was stuck is every
// consumer of `historyComplete`, which stays false: calendar and granola keep
// clipping their ordinary scans to the current year, waiting on a backfill that
// no source will ever run.
test('an empty active roster completes instead of waiting for nobody', () => {
  const state = memoryState();
  const q = createYearlyBackfill({ state, connectors: ['imessage', 'granola'], now: () => NOW });
  q.classify('imessage', false);
  assert.equal(q.advance(), false, 'one member is still unclassified — that is a real wait');

  q.classify('granola', false);
  assert.deepEqual(q.snapshot().active, []);
  assert.equal(q.advance(), true, 'every source classified, none of them available: done');
  assert.equal(q.snapshot().complete, true);
  assert.equal(q.snapshot().year, 2026, 'and no year was walked, because there was nothing to walk');
});

test('a withdrawn-to-empty roster completes the same way', () => {
  const state = memoryState();
  const q = createYearlyBackfill({ state, connectors: ['matrix'], now: () => NOW });
  q.withdraw('matrix');
  assert.equal(q.advance(), true);
  assert.equal(q.snapshot().complete, true);
});

// AND IT IS NOT A ONE-WAY DOOR. Completion from an empty roster is the same
// durable mark a finished walk leaves, and the same re-authorization path
// reopens it: a source that becomes available later reopens the current year.
test('a source that arrives after an empty-roster completion reopens the walk', () => {
  const state = memoryState();
  const q = createYearlyBackfill({ state, connectors: ['imessage'], now: () => NOW });
  q.classify('imessage', false);
  assert.equal(q.advance(), true);
  assert.equal(q.snapshot().complete, true);

  q.classify('imessage', true);
  assert.equal(q.snapshot().complete, false, 'an authorized source has history to read');
  assert.equal(q.snapshot().year, 2026);
  assert.deepEqual(q.snapshot().pending, ['imessage']);
});

// The restart path has to settle it too: with nothing active, no source will
// ever call advance(), so reconcile() breaking out on an empty roster left the
// mark unset until something was connected.
test('restart reconciliation settles an install with no history sources', () => {
  const state = memoryState();
  const q = createYearlyBackfill({ state, connectors: ['imessage'], now: () => NOW });
  q.classify('imessage', false);
  const recovery = q.reconcile();
  assert.equal(recovery.complete, true);
  assert.equal(state.getCursor('yearly-backfill:complete'), '1');
});

// A SOURCE THAT COMES BACK IS NOT A SOURCE THAT ARRIVED (round-4 finding 3).
//
// classify(name, false) after the daemon's needs()-failure tolerance, followed
// by the recovering tick's classify(name, true), used to read as an
// activation: the walk was rewound to the current year, COMPLETE was deleted
// and every barrier reopened -- for EVERY source, not just the one that
// blipped. A store locked by a backup for three polling intervals therefore
// cost a multi-year backfill its whole position.
//
// The rewind exists for a real case and must survive: a source the walk has
// genuinely left years behind has no other way back. So the question is not
// "was it inactive" but "is there a year above the walk that this source has
// not done", and the walk's OWN year is not one of them -- it is in progress
// for everybody.
test('a source that goes unavailable and recovers keeps the walk where it was', () => {
  const state = memoryState();
  // A backfill that has walked 2026 down to 2015: every year above the current
  // one is complete for both sources, which is what advance() required to get
  // here.
  state.setCursor('yearly-backfill:year', '2015');
  for (let year = 2026; year > 2015; year -= 1) {
    state.setCursor(`yearly-backfill:connector:imessage:done:${year}`, '1');
    state.setCursor(`yearly-backfill:connector:mail:done:${year}`, '1');
    state.setCursor(`yearly-backfill:barrier:people:done:${year}`, '1');
  }
  const backfill = createYearlyBackfill({
    state,
    connectors: ['imessage', 'mail'],
    barriers: ['people'],
    now: () => NOW,
  });
  backfill.classify('imessage', true);
  backfill.classify('mail', true);
  assert.equal(backfill.snapshot().year, 2015, 'the restart picks the walk up where it left off');

  // Three failed ticks: the daemon's tolerance is spent and mail leaves the
  // barrier so the walk is not frozen on it.
  backfill.classify('mail', false);
  assert.equal(backfill.snapshot().year, 2015, 'leaving is not what rewinds');

  // The store unlocks.
  backfill.classify('mail', true);
  assert.equal(backfill.snapshot().year, 2015,
    'and coming back must not drag eleven years of finished work to the top');
  assert.equal(state.getCursor('yearly-backfill:complete'), null);
  assert.equal(state.getCursor('yearly-backfill:barrier:people:done:2026'), '1',
    'nor reopen a barrier that was crossed a decade of years ago');
  assert.equal(state.getCursor('yearly-backfill:connector:mail:done:2026'), '1');
});

// THE REWIND THE ABOVE MUST NOT COST US. Same shape, except this source really
// was absent while the walk moved: it has no 2019, and nothing else will ever
// go back for it.
test('a source the walk actually left behind still rewinds to the current year', () => {
  const state = memoryState();
  state.setCursor('yearly-backfill:year', '2015');
  for (let year = 2026; year > 2015; year -= 1) {
    state.setCursor(`yearly-backfill:connector:imessage:done:${year}`, '1');
    state.setCursor(`yearly-backfill:barrier:people:done:${year}`, '1');
    // mail was unavailable for 2019 and 2018 and has no checkpoint for them.
    if (year !== 2019 && year !== 2018) {
      state.setCursor(`yearly-backfill:connector:mail:done:${year}`, '1');
    }
  }
  const backfill = createYearlyBackfill({
    state,
    connectors: ['imessage', 'mail'],
    barriers: ['people'],
    now: () => NOW,
  });
  backfill.classify('imessage', true);
  backfill.classify('mail', true);
  assert.equal(backfill.snapshot().year, 2026,
    'a source missing a year above the walk gets the walk back');
  assert.equal(state.getCursor('yearly-backfill:barrier:people:done:2026'), null,
    'and the catch-up reopens the current-year barrier it has to cross again');
});

// A source that blips INSIDE the year the walk is on has missed nothing at
// all: nobody has finished this year yet, including the sources that never
// went away.
test('a blip inside the current year is not a catch-up', () => {
  const state = memoryState();
  const backfill = createYearlyBackfill({
    state,
    connectors: ['imessage', 'mail'],
    now: () => NOW,
  });
  backfill.classify('imessage', true);
  backfill.classify('mail', true);
  backfill.record('imessage', { historyDone: true, historyHasOlder: true });
  backfill.classify('mail', false);
  backfill.classify('mail', true);
  assert.equal(state.getCursor('yearly-backfill:connector:imessage:done:2026'), '1',
    'the recovery left the other source its finished year');
  assert.equal(backfill.snapshot().year, 2026);
});
