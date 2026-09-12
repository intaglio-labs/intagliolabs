import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createYearlyBackfill,
  localYearBounds,
  yearlyBackfillCoverage,
} from '../lib/yearlyBackfill.mjs';
// A namespace import for anything added since, so a missing export fails its own
// assertion rather than the whole file's module load.
import * as yearly from '../lib/yearlyBackfill.mjs';
const PROVISIONAL_MAX_MS = yearly.PROVISIONAL_MAX_MS;

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

// --------------------------------------------------------------- new year's day

// THE FIRST CONNECTOR TO TICK AFTER NEW YEAR TOOK THE YEAR WITH IT.
//
// `exhausted` means the walk reached the BEGINNING of a connector's store. It is
// a statement about older data, and on 1 January the walk is standing in a year
// newer than anything it has seen. On that morning the first connector to
// classify finds the new year undone, rewinds, and sets YEAR to it; every
// connector after that sees year() === currentYear, finds nothing missed, and
// keeps its exhausted mark. done() then answers true for a year that connector
// has never scanned, and the new year is never read for it at all.
test('a connector exhausted last year still gets the new year', () => {
  const state = memoryState();
  const newYear = new Date(2027, 0, 1, 9).getTime();
  const now = () => newYear;
  // Where the walk stood on 31 December: both had finished 2026, and `mail` had
  // also reached the beginning of its store. imessage had not, which is what
  // makes it the connector that opens the new year.
  state.setCursor('yearly-backfill:year', '2026');
  state.setCursor('yearly-backfill:connector:imessage:done:2026', '1');
  state.setCursor('yearly-backfill:connector:mail:done:2026', '1');
  state.setCursor('yearly-backfill:connector:mail:exhausted', '1');

  const backfill = createYearlyBackfill({
    state, connectors: ['imessage', 'mail'], barriers: [], now,
  });
  // imessage goes first and takes the year with it.
  backfill.classify('imessage', true);
  assert.equal(Number(state.getCursor('yearly-backfill:year')), 2027,
    'the first connector to tick opens the new year');
  // mail follows, and finds the walk already standing in a year it has never
  // scanned.
  backfill.classify('mail', true);

  assert.ok(backfill.task('imessage'), 'imessage gets 2027');
  assert.ok(
    backfill.task('mail'),
    'mail kept an exhaustion mark from 2026 and would never scan 2027'
  );
  assert.equal(backfill.task('mail').year, 2027);
});

// THE SAME MORNING ON AN INSTALL WHOSE WALK HAD ACTUALLY FINISHED. Every
// timeline exhausted means COMPLETE was set in December; the first connector
// reopens through completedBeforeAuthorization rather than missedYears, and the
// second still has to lose a mark that is about a year below this one.
test('a finished walk reopens for the new year for every connector, not just the first', () => {
  const state = memoryState();
  const now = () => new Date(2027, 0, 1, 9).getTime();
  state.setCursor('yearly-backfill:year', '2026');
  state.setCursor('yearly-backfill:complete', '1');
  for (const connector of ['imessage', 'mail']) {
    state.setCursor(`yearly-backfill:connector:${connector}:done:2026`, '1');
    state.setCursor(`yearly-backfill:connector:${connector}:exhausted`, '1');
  }
  const backfill = createYearlyBackfill({
    state, connectors: ['imessage', 'mail'], barriers: [], now,
  });
  backfill.classify('imessage', true);
  backfill.classify('mail', true);

  assert.equal(state.getCursor('yearly-backfill:complete'), null);
  assert.equal(backfill.task('imessage')?.year, 2027);
  assert.equal(backfill.task('mail')?.year, 2027,
    'the second connector kept a December exhaustion mark over a January year');
});

// AND THE NARROWNESS IS THE POINT. A connector exhausted mid-walk -- it joined
// at 2020 because its store begins there -- must keep its mark, or every launch
// costs it a re-scan of a year it correctly finished.
test('a connector exhausted mid-walk keeps its mark', () => {
  const state = memoryState();
  const now = () => NOW; // 2026
  state.setCursor('yearly-backfill:year', '2020');
  for (let y = 2026; y >= 2020; y -= 1) {
    state.setCursor(`yearly-backfill:connector:imessage:done:${y}`, '1');
    state.setCursor(`yearly-backfill:connector:mail:done:${y}`, '1');
  }
  state.setCursor('yearly-backfill:connector:mail:exhausted', '1');

  const backfill = createYearlyBackfill({
    state, connectors: ['imessage', 'mail'], barriers: [], now,
  });
  backfill.classify('imessage', true);
  backfill.classify('mail', true);

  assert.equal(state.getCursor('yearly-backfill:connector:mail:exhausted'), '1',
    'the walk is nowhere near the current year; nothing here is a new year');
  assert.equal(backfill.task('mail'), null);
});

// ------------------------------------------------ a completion nobody could mean

test('nothing available does not declare a walk deep in the past finished', () => {
  const state = memoryState();
  const now = () => NOW; // 2026
  state.setCursor('yearly-backfill:year', '2015');
  for (let y = 2026; y >= 2016; y -= 1) {
    state.setCursor(`yearly-backfill:connector:imessage:done:${y}`, '1');
  }
  const backfill = createYearlyBackfill({
    state, connectors: ['imessage'], barriers: [], now,
  });
  backfill.classify('imessage', false);
  assert.equal(backfill.advance(), false);
  assert.equal(state.getCursor('yearly-backfill:complete'), null,
    'COMPLETE is durable, and at 2015 it hides every year below it forever');

  // The same branch on a machine that never walked at all is still the answer
  // it was written to give.
  const fresh = memoryState();
  const vacant = createYearlyBackfill({
    state: fresh, connectors: ['imessage'], barriers: [], now,
  });
  vacant.classify('imessage', false);
  assert.equal(vacant.advance(), true);
  assert.equal(fresh.getCursor('yearly-backfill:complete'), '1',
    'nothing to walk is still FINISHED where the walk never started');
});

test('a classification made on a guess does not move the walk', () => {
  const state = memoryState();
  const now = () => NOW;
  state.setCursor('yearly-backfill:year', '2026');
  state.setCursor('yearly-backfill:connector:mail:done:2026', '1');
  const backfill = createYearlyBackfill({
    state, connectors: ['imessage', 'mail'], barriers: [], now,
  });
  backfill.classify('mail', true);
  backfill.classify('imessage', false, { unanswered: true });

  assert.deepEqual(backfill.snapshot().provisional, ['imessage']);
  assert.equal(backfill.advance(), false, 'a needs() that threw is not evidence');
  assert.equal(Number(state.getCursor('yearly-backfill:year')), 2026);

  // The first real answer ends the wait, whatever it says.
  backfill.classify('imessage', false);
  assert.deepEqual(backfill.snapshot().provisional, []);
  assert.equal(backfill.advance(), true);
  assert.equal(Number(state.getCursor('yearly-backfill:year')), 2025);
});

// ------------------------------------------------- the sprint's narrowed barrier

// THE BARRIER IS ONLY AS FAST AS ITS SLOWEST MEMBER, which is right for the
// steady state and wrong for the first half hour. Live on 2026-09-12 run three:
// iMessage took 24,105 rows of the current year in 64 seconds and then the walk
// sat still, because mail -- eight months of history at ninety API calls a
// minute -- also had to finish that year before anybody could start the one the
// card's 180-day threshold actually lives in.
test('a sprint advances the year on its own roster and leaves the rest trailing', () => {
  const state = memoryState();
  const now = () => NOW; // 2026
  const backfill = createYearlyBackfill({
    state,
    connectors: ['imessage', 'mail'],
    barriers: [],
    now,
    sprintingRoster: () => ['imessage'],
  });
  backfill.classify('imessage', true);
  backfill.classify('mail', true);

  // Only the sprinting source finishes the year.
  backfill.record('imessage', { historyDone: true, historyHasOlder: true }, 2026);
  assert.equal(backfill.advance(), true, 'mail must not hold the sprint');
  assert.equal(Number(state.getCursor('yearly-backfill:year')), 2025);
  assert.deepEqual(backfill.snapshot().trailing, ['mail']);
  assert.deepEqual(JSON.parse(state.getCursor('yearly-backfill:trailing')), ['mail'],
    'and it is durable, or a restart reads the source as late rather than behind');
});

test('without a sprint the slow source holds the year exactly as before', () => {
  const state = memoryState();
  const now = () => NOW;
  const backfill = createYearlyBackfill({
    state, connectors: ['imessage', 'mail'], barriers: [], now,
  });
  backfill.classify('imessage', true);
  backfill.classify('mail', true);
  backfill.record('imessage', { historyDone: true, historyHasOlder: true }, 2026);

  assert.equal(backfill.advance(), false, 'the narrowing is the phase, not a new rule');
  assert.equal(state.getCursor('yearly-backfill:year'), null);
  assert.equal(state.getCursor('yearly-backfill:trailing'), null);
});

// A TRAILING SOURCE WALKS ITS OWN BACKLOG, newest-first, down to where everybody
// else is -- and then rejoins.
test('a trailing source is handed the year it still owes, not the shared one', () => {
  const state = memoryState();
  const now = () => NOW;
  state.setCursor('yearly-backfill:year', '2024');
  state.setCursor('yearly-backfill:trailing', JSON.stringify(['mail']));
  // The state a sprint leaves: the sprinter has receipts for the years the walk
  // came through, and the trailing source has none for any of them. Without the
  // sprinter's receipts IT would read as the one that is late, which is a
  // different test (and the rewind is right there).
  state.setCursor('yearly-backfill:connector:imessage:done:2026', '1');
  state.setCursor('yearly-backfill:connector:imessage:done:2025', '1');
  const backfill = createYearlyBackfill({
    state, connectors: ['imessage', 'mail'], barriers: [], now,
  });
  backfill.classify('imessage', true);
  backfill.classify('mail', true);

  assert.equal(backfill.task('mail').year, 2026, 'the oldest year it is missing above the walk');
  assert.equal(backfill.task('imessage').year, 2024, 'and everybody else is where they were');

  // It finishes 2026; 2025 is still above the shared year, so it takes that next.
  backfill.record('mail', { historyDone: true, historyHasOlder: true }, 2026);
  assert.equal(backfill.task('mail').year, 2025);

  // Caught up: it stops trailing and rejoins the barrier at the shared year.
  backfill.record('mail', { historyDone: true, historyHasOlder: true }, 2025);
  assert.equal(backfill.task('mail').year, 2024);
  assert.deepEqual(backfill.snapshot().trailing, []);
  assert.equal(state.getCursor('yearly-backfill:trailing'), null);
});

// AND IT MUST NOT REWIND. This is the round-5 finding 1 machinery meeting a
// source that is missing years ON PURPOSE: read as a re-activation, missedYears
// drags the whole walk back to fetch them and the sprint is undone.
test('a trailing source does not rewind the walk when it classifies', () => {
  const state = memoryState();
  const now = () => NOW;
  state.setCursor('yearly-backfill:year', '2024');
  state.setCursor('yearly-backfill:trailing', JSON.stringify(['mail']));
  state.setCursor('yearly-backfill:connector:imessage:done:2026', '1');
  state.setCursor('yearly-backfill:connector:imessage:done:2025', '1');
  const backfill = createYearlyBackfill({
    state, connectors: ['imessage', 'mail'], barriers: [], now,
  });
  backfill.classify('mail', true);
  backfill.classify('imessage', true);

  assert.equal(Number(state.getCursor('yearly-backfill:year')), 2024,
    'a source that is behind by design is not a source that just came back');
  assert.equal(state.getCursor('yearly-backfill:complete'), null);
});

// AND THE COMPLETION MARK IS STILL THE WHOLE ROSTER'S. Writing COMPLETE off the
// sprinting source alone would declare a walk finished over a mailbox with
// months unread -- the durable lie round-5 finding 1 was about, arriving through
// the new gate.
test('a narrowed gate never narrows the completion mark', () => {
  const state = memoryState();
  const now = () => NOW;
  const backfill = createYearlyBackfill({
    state,
    connectors: ['imessage', 'mail'],
    barriers: [],
    now,
    sprintingRoster: () => ['imessage'],
  });
  backfill.classify('imessage', true);
  backfill.classify('mail', true);
  // imessage reaches the beginning of its store in the current year.
  backfill.record('imessage', { historyDone: true, historyHasOlder: false }, 2026);

  assert.equal(backfill.advance(), true);
  assert.equal(state.getCursor('yearly-backfill:complete'), null,
    'mail has years left; the walk is not finished because the sprinter is');
  assert.equal(Number(state.getCursor('yearly-backfill:year')), 2025);
});

// ------------------------------------------------- a guess with a clock on it

// ROUND-6 FINDING 6. `provisional` is cleared by an ordinary classify(), and on
// the throwing path that only happens once NEEDS_FAILURE_TOLERANCE ticks have
// failed -- three ticks at the default interval is forty-five minutes, during
// which advance() returns false for EVERY connector and the year never moves. A
// sprint source that finished the current year then has no task, no slice and no
// re-arm, and idles out the whole half hour the phase exists to spend. A Photos
// library held open by Photos.app was enough to buy that.
//
// The wait this is meant to buy is "one stagger, until the source's first real
// tick". Past that it is not a wait, it is the stall.
test('a guess stops holding the walk once it is older than the stagger it covers', () => {
  const state = memoryState();
  let clock = NOW;
  const backfill = createYearlyBackfill({
    state, connectors: ['imessage', 'photos'], barriers: [], now: () => clock,
  });
  state.setCursor('yearly-backfill:connector:imessage:done:2026', '1');
  backfill.classify('imessage', true);
  backfill.classify('photos', false, { unanswered: true });

  assert.equal(backfill.advance(), false, 'a fresh guess is still worth waiting on');
  assert.deepEqual(backfill.snapshot().provisional, ['photos']);

  // Still inside the window.
  clock += daemonProvisionalWindow() - 1_000;
  assert.equal(backfill.advance(), false);

  // Past it. The source has not recovered and has not failed its tolerance
  // either; the walk stops waiting regardless.
  clock += 2_000;
  assert.equal(backfill.advance(), true,
    'forty-five minutes of frozen walk is not a wait, it is the stall');
  assert.equal(Number(state.getCursor('yearly-backfill:year')), 2025);
  assert.deepEqual(backfill.snapshot().provisional, []);
});

function daemonProvisionalWindow() {
  assert.equal(typeof PROVISIONAL_MAX_MS, 'number', 'the bound has to be a real constant');
  assert.ok(PROVISIONAL_MAX_MS >= 90_000, 'it must still cover a full first-run stagger');
  assert.ok(PROVISIONAL_MAX_MS < 10 * 60_000, 'and be nowhere near the tolerance it replaces');
  return PROVISIONAL_MAX_MS;
}
