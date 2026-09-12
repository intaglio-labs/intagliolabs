// THE FIRST HALF HOUR ON A FRESH MAC, AND WHY IT NEEDS ONE.
//
// The reconnect card wants somebody who has gone QUIET -- RECONNECT_GATES asks
// for a person whose last activity is at least 180 days old. A fresh install's
// forward window reaches about 157 days back and the yearly walk is still inside
// the current year, so NOBODY in the loaded corpus can qualify until last year's
// history lands. And last year's history was paced at HISTORY_BUDGET_MS (20 s)
// per source per tick with ticks fifteen minutes apart: live on 2026-09-12 run
// two, thirty minutes after a fresh install the pool was empty in every mode,
// and iMessage's 2026 pass had gained 5.8k rows and then 9.9k rows in two ticks
// a quarter of an hour apart. The first card was hours away.
//
// So the sprint. Everything below is about its two edges -- what it speeds up,
// and what it must not touch.
//
// Every fixture is synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A namespace import, for the reason the other daemon tests give: a named
// import of an export this checkout does not have yet is a link error that
// fails the whole file with one unhelpful line.
import * as daemon from '../daemon.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { info() {}, warn() {}, error() {} };

// TEN MINUTES, stated in the fixture. It is what a history-walking source used
// to wait between slices, and every assertion below lands seconds after the
// first tick -- so the fixture says what is being discriminated against.
const INTERVAL_S = 600;

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hazlie-sprint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fakeState = (cursors = {}) => {
  const map = new Map(Object.entries(cursors));
  return {
    map,
    getCursor: (name) => map.get(name) ?? null,
    setCursor: (name, value) => map.set(name, String(value)),
    deleteCursor: (name) => map.delete(name),
    deleteCursors: (prefix) => {
      for (const key of [...map.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}:`)) map.delete(key);
      }
    },
    recordRun: () => {},
  };
};

// A local history source whose slices take real time, so the history loop's own
// budget bounds how many fit in ONE tick -- which is what makes the TICK COUNT
// (`calls.forward`, one per pass) the thing these tests measure. An instant
// source would drain its whole year inside a single tick and say nothing about
// how soon the next tick comes, which is the change under test.
function walker(name, { openSlices = 100, sliceMs = 40, clock = null } = {}) {
  const calls = { forward: 0, history: 0, deadlines: [], years: [] };
  let remaining = openSlices;
  return {
    calls,
    source: {
      name,
      walksHistory: true,
      needs: async () => [],
      run: async (ctx) => {
        if (ctx.history !== true) {
          calls.forward += 1;
          return {};
        }
        calls.history += 1;
        calls.deadlines.push(ctx.deadline);
        calls.years.push(ctx.historyWindow.year);
        await sleep(sliceMs);
        if (clock) clock.now += sliceMs;
        if (remaining > 0) {
          remaining -= 1;
          return { ingested: 1, historyProgressed: true };
        }
        return { historyDone: true, historyHasOlder: true, ingested: 1 };
      },
    },
  };
}

function build(t, sources, opts = {}) {
  const dir = sandbox(t);
  const activityPath = join(dir, 'activity.json');
  const state = opts.state ?? fakeState({});
  const instance = daemon.createDaemon({
    config: {
      retention: { maintainHour: '03:30' },
      intervals: Object.fromEntries(sources.map((s) => [s.name, INTERVAL_S])),
    },
    state,
    log: opts.log ?? silent,
    sources,
    ingestOpts: {},
    cacheDir: dir,
    activityPath,
    // A test cannot wait out a ten-second re-arm, let alone a thirty-minute
    // sprint. Same injection the re-probe floor takes.
    sprintRearmMs: 120,
    sprintHistoryBudgetMs: 60,
    ...opts.daemon,
  });
  t.after(() => instance.stop());
  return { instance, activityPath, state };
}

const snapshotOf = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ---------------------------------------------------------------------------
// (a) the thing it is for
// ---------------------------------------------------------------------------

test('a machine that has not finished last year takes several ticks in seconds', async (t) => {
  const chat = walker('imessage');
  const { instance } = build(t, [chat.source]);

  instance.start();
  // The first tick fires at 1 s. Without the sprint the second one is INTERVAL_S
  // away, so anything past one here can only be the re-arm.
  await sleep(2_200);

  assert.ok(
    chat.calls.forward >= 3,
    `last year needs many passes and got ${chat.calls.forward} in the time one used to take`
  );
  assert.ok(chat.calls.history >= chat.calls.forward,
    'every tick is a whole tick: the forward pass is not skipped to buy history');
});

test('the sprint hands the history pass a bigger budget', async (t) => {
  // FORTY-FIVE SECONDS, and the assertion is thirty. HISTORY_BUDGET_MS is twenty,
  // so any threshold under it is met by the ordinary budget too and the test
  // passes on a tree that has no sprint at all -- which is what the first
  // version of this did. `openSlices: 1` keeps the pass itself short: what is
  // asserted is the deadline HANDED to the source, not how long it spends.
  const chat = walker('imessage', { openSlices: 1 });
  const { instance } = build(t, [chat.source], {
    daemon: { sprintHistoryBudgetMs: 45_000 },
  });
  const armedAt = Date.now();
  instance.start();
  await sleep(1_400);
  assert.ok(chat.calls.deadlines.length > 0, 'the history pass never ran');
  assert.ok(
    chat.calls.deadlines[0] >= armedAt + 30_000,
    'a sprinting source gets the sprint budget, not the ordinary 20 s one'
  );
});

// ---------------------------------------------------------------------------
// (b) and the two edges it must not cross
// ---------------------------------------------------------------------------

// NETWORK SOURCES NEVER SPRINT. mail paces itself against a per-minute API
// budget it shares with nothing; re-arming it every ten seconds trades a first
// card for a 429. Two daemons rather than one, because the first-run stagger
// puts a second source ten seconds out and the point is what each does with the
// SAME window.
test('a network source keeps its interval while a local one sprints', async (t) => {
  const chat = walker('imessage');
  const mail = walker('mail');
  const local = build(t, [chat.source]);
  const remote = build(t, [mail.source]);

  local.instance.start();
  remote.instance.start();
  await sleep(2_200);

  assert.ok(chat.calls.forward >= 3, 'the local source is sprinting');
  assert.equal(mail.calls.forward, 1,
    `mail ran ${mail.calls.forward} times; its quota is not the sprint's to spend`);
});

// AND IT ENDS. Both ways: the year lands, or the half hour runs out.
test('the sprint stops when last year is recorded done', async (t) => {
  // Two slices of work in total, so the walk finishes the current year and then
  // last year within a couple of ticks -- and the second of those is the whole
  // condition. The pass that records it republishes on its way out, which is
  // what clears the claim from the activity file.
  const chat = walker('imessage', { openSlices: 2 });
  const { instance, state, activityPath } = build(t, [chat.source]);

  instance.start();
  await sleep(2_200);

  const lastYear = new Date().getFullYear() - 1;
  assert.equal(
    state.getCursor(`yearly-backfill:connector:imessage:done:${lastYear}`),
    '1',
    'the fixture has to actually reach last year, or this proves nothing'
  );
  assert.equal(snapshotOf(activityPath).sprint, undefined,
    'a finished phase stops claiming the machine is racing');

  const settled = chat.calls.forward;
  await sleep(700);
  assert.equal(chat.calls.forward, settled,
    'and the source is back on its interval');
});

test('the sprint stops when its own clock runs out', async (t) => {
  const clock = { now: Date.now() };
  const chat = walker('imessage', { sliceMs: 40, clock });
  const { instance, state } = build(t, [chat.source], {
    daemon: { now: () => clock.now, sprintMaxMs: 900 },
  });

  instance.start();
  await sleep(1_600);
  const sprinted = chat.calls.forward;
  assert.ok(sprinted >= 2, `it sprinted while the clock allowed it (${sprinted})`);
  assert.ok(
    Number.isFinite(Number(state.getCursor(daemon.SPRINT_STARTED_KEY))),
    'the start is durable, so a restart resumes the remainder'
  );

  clock.now += 5 * 60_000; // well past sprintMaxMs
  await sleep(700);
  assert.ok(
    chat.calls.forward - sprinted <= 1,
    'a spent sprint does not keep re-arming, however much history is left'
  );
});

// A MACHINE THAT HAS ALREADY SPENT ITS SPRINT TAKES NO SECOND ONE. The cursor
// outlives the process, which is what makes this a first LOAD rather than a mode
// the daemon drops into whenever a year is open.
test('a spent sprint is not handed out again by a restart', async (t) => {
  const spent = fakeState({
    [daemon.SPRINT_STARTED_KEY]: String(Date.now() - 60 * 60_000),
  });
  const chat = walker('imessage');
  const { instance, activityPath } = build(t, [chat.source], { state: spent });

  instance.start();
  await sleep(2_200);
  assert.equal(chat.calls.forward, 1,
    'an hour-old sprint is over; a restart must not hand the machine another half hour');
  assert.equal(snapshotOf(activityPath).sprint, undefined);
});

test('a restart inside the window keeps sprinting on what is left', async (t) => {
  const resumed = fakeState({
    [daemon.SPRINT_STARTED_KEY]: String(Date.now() - 1_000),
  });
  const chat = walker('imessage');
  const { instance, activityPath, state } = build(t, [chat.source], { state: resumed });
  const startedBefore = state.getCursor(daemon.SPRINT_STARTED_KEY);

  instance.start();
  await sleep(2_200);

  assert.ok(chat.calls.forward >= 3, 'a sprint already under way carries on across the restart');
  assert.equal(state.getCursor(daemon.SPRINT_STARTED_KEY), startedBefore,
    'and it keeps its original start, so the remainder shrinks rather than resetting');
  const sprint = snapshotOf(activityPath).sprint;
  assert.ok(sprint, 'the activity file says so');
  assert.equal(sprint.since, Number(startedBefore));
  assert.deepEqual(sprint.sources, ['imessage']);
});

// ---------------------------------------------------------------------------
// (c) what the owner's machine setting buys
// ---------------------------------------------------------------------------

test('the re-arm follows the performance mode the app was told to use', () => {
  assert.equal(daemon.SPRINT_REARM_MS, 10_000);
  // Twenty, not sixty: against the 60 s history budget a minute is a 25% duty
  // cycle for at most half an hour of disk-bound reads, and what the owner is
  // waiting on is their first card.
  assert.equal(daemon.SPRINT_REARM_GENTLE_MS, 20_000);
  assert.equal(daemon.defaultSprintRearmMs({ INTAGLIO_PERFORMANCE: 'full' }), 10_000);
  // A fresh install defaults to less-power, and so does a standalone run of the
  // daemon with nothing in its environment. Even so this is forty-five times the
  // cadence it replaces.
  assert.equal(daemon.defaultSprintRearmMs({}), 20_000);
  assert.equal(daemon.defaultSprintRearmMs({ INTAGLIO_PERFORMANCE: 'trickle' }), 20_000);
});

test('the sprint re-arm travels through the one place that replaces a timer', () => {
  // Never armed directly: scheduleSource is what guarantees one timer per
  // source, and two passes over one cursor is the overlap the whole scheduler
  // is built to make impossible.
  assert.equal(daemon.sourceRetryDelay({ sprintDelayMs: 10_000 }, 600_000), 10_000);
  // A source's own short-retry request still outranks it: that is about work
  // the sprint knows nothing of.
  assert.equal(daemon.sourceRetryDelay({ nextDelayMs: 5_000, sprintDelayMs: 10_000 }, 600_000), 5_000);
  // And it can never exceed the interval.
  assert.equal(daemon.sourceRetryDelay({ sprintDelayMs: 900_000 }, 600_000), 600_000);
  assert.equal(daemon.sourceRetryDelay({}, 600_000), 600_000);
});

// ---------------------------------------------------------------------------
// (d) and the barrier the sprint kept running into
// ---------------------------------------------------------------------------

// LIVE ON RUN THREE (22:09 UTC). The sprint fired and worked: iMessage took
// 24,105 rows of 2026 in 64 seconds, against 5.8k in a whole fifteen-minute tick
// before it. Then the walk stopped dead. The year is SHARED, so iMessage could
// not start 2025 until mail had also finished 2026 -- eight months of history at
// ninety API calls a minute, on the one source that must never sprint. The
// activity file showed backfill ['mail'] at 2026 and iMessage queued 803 seconds
// out, and 2025 is exactly where the card's 180-day threshold lives.
//
// So during a sprint the year advances on the sprint roster alone, and the
// sources left above it trail: they hold nobody, keep their own receipts, and
// walk the years they missed on their own afterwards.
function neverFinishes(name) {
  const calls = { years: [] };
  return {
    calls,
    source: {
      name,
      walksHistory: true,
      needs: async () => [],
      run: async (ctx) => {
        if (ctx.history !== true) return {};
        calls.years.push(ctx.historyWindow.year);
        await sleep(30);
        // Progress, and never an end: the shape of a mailbox with months to go.
        return { ingested: 1, historyProgressed: true };
      },
    },
  };
}

test('a network source that cannot finish the year does not hold the sprint', async (t) => {
  const chat = walker('imessage', { openSlices: 1 });
  const mail = neverFinishes('mail');
  const currentYear = new Date().getFullYear();
  // imessage first, so its tick lands inside the window; mail is probed at
  // startup and classified, which is all it has to do to hold the barrier.
  const { instance, state } = build(t, [chat.source, mail.source]);

  instance.start();
  await sleep(2_400);

  assert.equal(
    state.getCursor(`yearly-backfill:connector:imessage:done:${currentYear}`),
    '1',
    'the sprint finished the current year for the local source'
  );
  assert.ok(
    Number(state.getCursor('yearly-backfill:year')) <= currentYear - 1,
    'the walk never got past the current year, which is where it stalled live'
  );
  assert.ok(
    chat.calls.years.includes(currentYear - 1),
    `imessage never reached last year (walked ${chat.calls.years.join()}), `
      + "which is where the card's 180-day threshold lives"
  );
  assert.deepEqual(
    JSON.parse(state.getCursor('yearly-backfill:trailing') ?? '[]'),
    ['mail'],
    'the source that was left above the walk is recorded as behind by design'
  );
  assert.equal(
    state.getCursor(`yearly-backfill:connector:mail:done:${currentYear}`),
    null,
    'and it keeps its own receipts: it has not been credited with a year it never walked'
  );
});

// AND IT MUST NOT REWIND. A trailing source is missing exactly the years the
// sprint took the walk past. Read as a re-activation, missedYears drags the
// whole walk back to fetch them -- the sprint undone on mail's very next tick.
test('a trailing source keeps walking its own years without rewinding anybody', async (t) => {
  const currentYear = new Date().getFullYear();
  // The state a sprint leaves behind: the walk at last year, mail trailing and
  // still owing the current one.
  const after = fakeState({
    'yearly-backfill:year': String(currentYear - 1),
    'yearly-backfill:trailing': JSON.stringify(['mail']),
    [`yearly-backfill:connector:imessage:done:${currentYear}`]: '1',
    // An hour-old sprint: the phase is over, which is the point of this test.
    [daemon.SPRINT_STARTED_KEY]: String(Date.now() - 60 * 60_000),
  });
  const mail = neverFinishes('mail');
  const chat = walker('imessage', { openSlices: 50 });
  const { instance, state } = build(t, [mail.source, chat.source], { state: after });

  instance.start();
  await sleep(2_400);

  assert.equal(
    Number(state.getCursor('yearly-backfill:year')),
    currentYear - 1,
    'the walk kept its place; a trailing source is behind by design, not late'
  );
  assert.ok(mail.calls.years.length > 0, 'mail actually ran its history pass');
  assert.deepEqual(
    [...new Set(mail.calls.years)],
    [currentYear],
    'and it walks the year it still owes, not the one everybody else is on'
  );
});

// THE BARRIER WIDENS BACK OUT. Outside a sprint, a source that is simply slow
// holds the year exactly as it always did -- the narrowing is the phase, not a
// new rule about network sources.
test('with no sprint, a slow source still holds the year', async (t) => {
  const currentYear = new Date().getFullYear();
  const spent = fakeState({
    // An hour-old sprint: the phase is over.
    [daemon.SPRINT_STARTED_KEY]: String(Date.now() - 60 * 60_000),
  });
  const chat = walker('imessage', { openSlices: 1 });
  const mail = neverFinishes('mail');
  const { instance, state } = build(t, [chat.source, mail.source], { state: spent });

  instance.start();
  await sleep(2_400);

  // Absent means "never advanced": savedYear falls back to the current year, and
  // the cursor is only written when the walk actually moves.
  const saved = state.getCursor('yearly-backfill:year');
  assert.ok(
    saved === null || Number(saved) === currentYear,
    `nobody may be let past without a sprint; the walk reached ${saved}`
  );
  assert.deepEqual([...new Set(chat.calls.years)], [currentYear],
    'and the local source walked the current year only, held by the slow one');
  assert.equal(state.getCursor('yearly-backfill:trailing'), null,
    'and nothing was marked behind by design');
});

// THE STALL THAT LOOKED EMPTIEST FROM INSIDE THE LOOP. A sprint source that
// finished its year and is waiting for the barrier has no history window at all
// this tick, so a re-arm keyed off "did this pass read anything" saw zero and
// went back to sleep for the full interval. Waiting on a barrier the sprint is
// clearing is the state that most needs to come back soon.
test('a sprint source parked on a barrier comes back on the sprint cadence', async (t) => {
  const currentYear = new Date().getFullYear();
  // imessage is already done for the current year, and the People barrier is not
  // crossed -- so task() answers null and the history block never runs.
  const parked = fakeState({
    [`yearly-backfill:connector:imessage:done:${currentYear}`]: '1',
  });
  const chat = walker('imessage', { openSlices: 50 });
  const { instance } = build(t, [chat.source], {
    state: parked,
    daemon: {
      ingestOpts: { tokenFile: '/synthetic/hermes-token' },
      // Never answers, so the barrier stays uncrossed for the whole window.
      completePeopleYear: async () => ({ complete: false, retryAfterMs: 60_000 }),
    },
  });

  instance.start();
  await sleep(2_200);

  assert.ok(
    chat.calls.forward >= 3,
    `a source waiting on a barrier ticked ${chat.calls.forward} times; it used to sleep out the interval`
  );
  assert.equal(chat.calls.history, 0, 'and it genuinely had no history window to walk');
});
