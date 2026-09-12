// WHAT A SOURCE WHOSE CURSORS VANISH MID-LIFE IS OWED: to be rescheduled like
// any other source. Forward pass first, then its classification, then a slice
// of history — on every cycle, not once an hour.
//
// THE 2026-09-12 STALL, which is what these pin. Mail's cursors were deleted
// out of state.db under a running install. Its forward floor fell back to the
// cold-start one (January 1st of the current year, because `mail.backfillDays`
// is larger than the year is old), so the window reopened to months of mail and
// the pass ran to its own per-account cap — 2,000 messages at ~90 API calls a
// minute, ~22 minutes per mailbox, over an hour for three. Nothing above it
// noticed:
//
//   * runSource() deletes the source from `nextRuns` for the whole call, so for
//     that hour mail was absent from activity.json's queue and read as never
//     scheduled. It was running the entire time.
//   * the history slice is only reached AFTER the forward pass returns, so the
//     year barrier parked on a source that could not get to its own history.
//   * mail_account_scan is logged when a mailbox FINISHES, so the log was
//     silent for the whole hour and every restart reset the clock.
//
// Every fixture here is synthetic; the repo is public. Addresses are
// example.test, and the state.db shapes below are the live key NAMES with the
// household's addresses replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A NAMESPACE IMPORT, deliberately: a named import of a constant the daemon
// does not export yet is a module-load error, and a load error fails this whole
// file with one unhelpful line instead of letting each assertion below say what
// it actually found.
import * as daemon from '../daemon.mjs';
import { createMailSource } from '../sources/mail.mjs';
import { openStateDb } from '../lib/state.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { info() {}, warn() {}, error() {} };

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hazlie-purged-sched-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fakeState = (cursors = {}) => {
  const map = new Map(Object.entries(cursors));
  return {
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

// ---------------------------------------------------------------------------
// (a) the daemon bounds the forward pass, and still reaches history after it
// ---------------------------------------------------------------------------

test('the forward pass is handed a budget, and the history slice still follows it', async (t) => {
  const dir = sandbox(t);
  const passes = [];
  const source = {
    name: 'imessage',
    walksHistory: true,
    needs: async () => [],
    run: async (ctx) => {
      passes.push({ history: ctx.history === true, deadline: ctx.deadline });
      return ctx.history === true ? { historyDone: true, historyHasOlder: false } : {};
    },
  };
  const instance = daemon.createDaemon({
    config: { retention: { maintainHour: '03:30' } },
    state: fakeState(),
    log: silent,
    sources: [source],
    ingestOpts: {},
    cacheDir: dir,
    activityPath: join(dir, 'activity.json'),
  });
  const armedAt = Date.now();
  assert.equal(
    Number.isFinite(daemon.FORWARD_BUDGET_MS),
    true,
    'the daemon must publish a forward-pass budget'
  );
  try {
    instance.start();
    await sleep(1_400);
  } finally {
    instance.stop();
  }

  assert.equal(passes.length >= 2, true, 'the forward pass must be followed by a history slice');
  const [forward, history] = passes;
  assert.equal(forward.history, false);
  // THE ASSERTION THE STALL TURNS ON. An unbounded forward pass is a pass the
  // daemon cannot get back from: no history slice, no reschedule, and no row in
  // the activity queue for as long as it runs.
  assert.equal(
    Number.isFinite(forward.deadline),
    true,
    'the forward pass must be given a deadline, exactly as the history pass is'
  );
  assert.equal(forward.deadline >= armedAt, true);
  assert.equal(forward.deadline <= Date.now() + daemon.FORWARD_BUDGET_MS, true);
  assert.equal(history.history, true, 'history runs after the bounded forward pass, not instead of it');
});

// ---------------------------------------------------------------------------
// (a) and mail actually honours it, on a page boundary, for every mailbox
// ---------------------------------------------------------------------------

// Endless newest-first pages, a paced clock, and three mailboxes: the shape of
// a forward window reopened to January 1st. `sleep` advances the clock, so the
// pacer's 667ms per API call is what spends the budget — which is exactly what
// spends it on the real machine.
function cappedMailbox({ deadline }) {
  const BASE = new Date(2026, 5, 1, 12, 0, 0).getTime();
  let clock = BASE;
  const scans = [];
  const state = (() => {
    const map = new Map();
    return {
      getCursor: (k) => map.get(k) ?? null,
      setCursor: (k, v) => map.set(k, String(v)),
      deleteCursor: (k) => map.delete(k),
    };
  })();
  let issued = 0;
  const source = createMailSource({
    accountsForScope: () => [
      { email: 'one@example.test' },
      { email: 'two@example.test' },
      { email: 'three@example.test' },
    ],
    sleep: async (ms) => { clock += ms; },
    makeClient: () => ({
      listMessages: async ({ q, pageToken }) => {
        if (q.startsWith('before:')) return { messages: [] };
        const page = Number(pageToken ?? 0);
        return {
          messages: Array.from({ length: 100 }, (_, i) => ({ id: `p${page}-${i}` })),
          nextPageToken: String(page + 1),
        };
      },
      getMessage: async (id) => {
        issued += 1;
        return {
          id,
          // Descending, and never below the January 1st floor: a message under
          // the floor would end the window honestly and prove nothing.
          internalDate: String(BASE - issued * 60_000),
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'Message-ID', value: `<${id}@example.test>` },
              { name: 'From', value: 'friend@example.test' },
              { name: 'To', value: 'owner@example.test' },
              { name: 'Subject', value: id },
            ],
            body: { data: Buffer.from(id).toString('base64url') },
          },
        };
      },
    }),
  });
  const ctx = {
    state,
    // The live setting: 1,400 days, so the rolling floor is older than the year
    // and `freshFloor` collapses to January 1st.
    config: { mail: { backfillDays: 1400 } },
    home: '/tmp/mail-budget-test-home',
    now: () => clock,
    history: false,
    ingest: async (rows) => ({ inserted: rows.length, updated: 0, unchanged: 0 }),
    log: {
      info: (event, fields) => { if (event === 'mail_account_scan') scans.push(fields); },
      warn() {},
    },
    ...(deadline === null ? {} : { deadline: BASE + deadline }),
  };
  return { source, ctx, state, scans, BASE };
}

test('a reopened forward window stops on a page boundary, and every mailbox gets a turn', async () => {
  const { source, ctx, state, scans, BASE } = cappedMailbox({ deadline: 10_000 });
  await source.run(ctx);

  // ONE PAGE EACH, not 2,000 messages each. Before the budget reached the
  // forward pass this read [2000, 2000, 2000] — 6,000 paced gets, well over an
  // hour of wall clock inside a single source.run().
  assert.deepEqual(
    scans.map((s) => s.fetched),
    [100, 100, 100],
    'each mailbox stops at a page boundary once its slice of the budget is spent'
  );
  assert.deepEqual(scans.map((s) => s.accountIndex), [0, 1, 2],
    'the first mailbox must not spend the whole budget and starve the others');

  // AND THE STOP IS RESUMABLE. The page that ran wrote the hole it leaves
  // behind before it raised the cursor, so the next pass drains from here
  // rather than starting the window again.
  assert.equal(
    state.getCursor('mail:one@example.test:forward-gap-from'),
    String(new Date(2026, 0, 1).getTime()),
    'the reopened window floors at January 1st, and the hole below it is recorded'
  );
  assert.equal(
    Number(state.getCursor('mail:one@example.test:forward-gap-until')) > 0,
    true
  );
  assert.equal(Number(state.getCursor('mail:one@example.test:internalDate')) > 0, true);
});

test('with no deadline handed over, the pass behaves exactly as it always did', async () => {
  // The other half of the discriminator: the budget is a deadline the CALLER
  // supplies, so a source driven without one is unchanged.
  const { source, ctx, scans } = cappedMailbox({ deadline: null });
  await source.run(ctx);
  assert.deepEqual(scans.map((s) => s.fetched), [2000, 2000, 2000]);
});

// ---------------------------------------------------------------------------
// (b) one connector's purge leaves the scheduler in a state it can leave
// ---------------------------------------------------------------------------

test('purging one connector reopens the product barrier for the year the walk restarts at', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  const year = new Date().getFullYear();

  // The live key shapes, addresses masked.
  state.setCursor('mail:owner@example.test:internalDate', '1789235370000');
  state.setCursor('mail:owner@example.test:forward-gap-from', '1767243600000');
  state.setCursor('mail:owner@example.test:forward-gap-until', '1776713515000');
  state.setCursor(`mail:owner@example.test:history-year:${year}:page`, 'token');
  state.setCursor('mail:history-slices-per-pass', '1');
  state.setCursor(`yearly-backfill:connector:mail:done:${year}`, '1');
  state.setCursor(`yearly-backfill:connector:mail:done:${year - 1}`, '1');
  state.setCursor(`yearly-backfill:connector:imessage:done:${year}`, '1');
  state.setCursor('yearly-backfill:year', String(year - 3));
  state.setCursor('yearly-backfill:complete', '1');
  state.setCursor('yearly-backfill:people-barrier-version', '1');
  state.setCursor(`yearly-backfill:barrier:people:done:${year}`, '1');
  state.setCursor(`yearly-backfill:barrier:people:done:${year - 1}`, '1');

  state.deleteCursors('mail');

  // Deleting the saved year sends the walk back to the current one. A barrier
  // still marked done THERE says the product phase for that year is finished —
  // over a corpus the purge just removed. advance() would step straight past it
  // and the People profiles for this connector's rows would never be rebuilt.
  assert.equal(
    state.getCursor(`yearly-backfill:barrier:people:done:${year}`),
    null,
    'the year the walk restarts at cannot still be marked done for the product barrier'
  );
  // Only that year. Older barriers are somebody else's finished work.
  assert.equal(state.getCursor(`yearly-backfill:barrier:people:done:${year - 1}`), '1');
  assert.equal(state.getCursor('yearly-backfill:year'), null);
  assert.equal(state.getCursor('yearly-backfill:complete'), null);
  assert.equal(state.getCursor(`yearly-backfill:connector:imessage:done:${year}`), '1');
  assert.equal(state.getCursor('mail:history-slices-per-pass'), '1');
  assert.equal(state.getCursor('mail:owner@example.test:forward-gap-from'), null);
});

test('the global reset is a call of its own, and a purge can decline it', (t) => {
  const state = openStateDb(join(sandbox(t), 'state.db'));
  t.after(() => state.close());
  const year = new Date().getFullYear();

  const seed = () => {
    state.setCursor('mail:owner@example.test:internalDate', '1789235370000');
    state.setCursor(`yearly-backfill:connector:mail:done:${year}`, '1');
    state.setCursor('imessage:history-min-date', '519032413000000000');
    state.setCursor(`imessage:history-year:${year}:ceiling`, '788947280801949056');
    state.setCursor(`yearly-backfill:connector:imessage:done:${year}`, '1');
    state.setCursor(`yearly-backfill:connector:imessage:done:${year - 1}`, '1');
    state.setCursor('yearly-backfill:year', String(year));
    state.setCursor('yearly-backfill:complete', '1');
    state.setCursor(`yearly-backfill:barrier:people:done:${year}`, '1');
  };

  // ONE CONNECTOR'S NAMESPACE AND NOTHING ELSE. `changes` counts only that.
  seed();
  assert.equal(state.deleteCursors('mail', { reopenYearly: false }), 2);
  assert.equal(state.getCursor('mail:owner@example.test:internalDate'), null);
  assert.equal(state.getCursor(`yearly-backfill:connector:mail:done:${year}`), null);
  for (const [kept, value] of [
    ['imessage:history-min-date', '519032413000000000'],
    [`imessage:history-year:${year}:ceiling`, '788947280801949056'],
    [`yearly-backfill:connector:imessage:done:${year}`, '1'],
    [`yearly-backfill:connector:imessage:done:${year - 1}`, '1'],
    ['yearly-backfill:year', String(year)],
    ['yearly-backfill:complete', '1'],
    [`yearly-backfill:barrier:people:done:${year}`, '1'],
  ]) {
    assert.equal(state.getCursor(kept), value, `${kept} is not this purge's business`);
  }

  // THE OTHER HALF, ON ITS OWN AND COUNTED ON ITS OWN. Three shared keys, and
  // still not one of the other connector's year receipts: reopening the walk at
  // the current year re-uses every year imessage already finished.
  assert.equal(state.reopenYearlyWalk(), 3);
  assert.equal(state.getCursor('yearly-backfill:complete'), null);
  assert.equal(state.getCursor('yearly-backfill:year'), null);
  assert.equal(state.getCursor(`yearly-backfill:barrier:people:done:${year}`), null);
  assert.equal(state.getCursor(`yearly-backfill:connector:imessage:done:${year}`), '1');
  assert.equal(state.getCursor(`yearly-backfill:connector:imessage:done:${year - 1}`), '1');
  assert.equal(state.getCursor('imessage:history-min-date'), '519032413000000000');
});

// ---------------------------------------------------------------------------
// (b) and a roster member nothing can classify no longer holds the walk
// ---------------------------------------------------------------------------

test('a history source whose needs() keeps throwing stops holding the yearly walk', async (t) => {
  const dir = sandbox(t);
  const activityPath = join(dir, 'activity.json');
  const instance = daemon.createDaemon({
    // A tick every 50ms, so the tolerance is reached inside a test rather than
    // inside three quarters of an hour. createDaemon takes the config it is
    // given; MIN_INTERVAL_S is validateConfig's floor for a config read off
    // disk, which is not this path.
    config: { retention: { maintainHour: '03:30' }, intervals: { whatsapp: 0.05, imessage: 0.05 } },
    state: fakeState({
      [`yearly-backfill:connector:imessage:done:${new Date().getFullYear()}`]: '1',
    }),
    log: silent,
    sources: [
      {
        name: 'whatsapp',
        walksHistory: true,
        // An unreadable store, a token file mid-rewrite. This call sat outside
        // every try in the daemon: it rejected past runSource into schedule()'s
        // catch, which logs and reschedules and never classifies — so this
        // roster member was one advance() waited on forever, and the year never
        // moved for anybody else either.
        needs: async () => { throw new Error('prerequisite probe failed'); },
        run: async () => ({}),
      },
      { name: 'imessage', walksHistory: true, needs: async () => [], run: async () => ({}) },
    ],
    ingestOpts: {},
    cacheDir: dir,
    activityPath,
  });
  try {
    instance.start();
    // Long enough for the startup probe plus NEEDS_FAILURE_TOLERANCE ticks.
    await sleep(1_400);
  } finally {
    instance.stop();
  }

  const snapshot = JSON.parse(readFileSync(activityPath, 'utf8'));
  assert.equal(
    snapshot.backfillYear,
    new Date().getFullYear() - 1,
    'the current year is complete for every source that can be classified, so the walk moves on'
  );
  assert.deepEqual(snapshot.backfill, ['imessage']);
});

// ---------------------------------------------------------------------------
// (c) ...and a source that merely FLAPS keeps its place in the walk
// ---------------------------------------------------------------------------

test('a needs() that throws once does not rewind the shared walk to this year', async (t) => {
  const dir = sandbox(t);
  const activityPath = join(dir, 'activity.json');
  const currentYear = new Date().getFullYear();
  const walkYear = 2015;
  // A walk well down in the backfill, with both sources finished for the year
  // they were authorized in. That second part matters: without a current-year
  // receipt, classify()'s joinedMidBackfill arm rewinds a source that is
  // simply new, which is a different rule than the one under test.
  const state = fakeState({
    'yearly-backfill:year': String(walkYear),
    [`yearly-backfill:connector:imessage:done:${currentYear}`]: '1',
    [`yearly-backfill:connector:whatsapp:done:${currentYear}`]: '1',
  });

  // THE DISCRIMINATING SHAPE: throw once, then answer normally. A daemon that
  // reads the first throw as "inactive" reads the next tick as a RE-ACTIVATION,
  // and a re-activation deletes COMPLETE, sets the year to the current one and
  // reopens its barriers — for every source, not just this one. Under a source
  // that throws every few ticks (a token file being rewritten) that is not a
  // stall, it is an oscillation: the walk is dragged back to this year forever
  // and the older years are never reached.
  let probes = 0;
  const instance = daemon.createDaemon({
    config: { retention: { maintainHour: '03:30' }, intervals: { whatsapp: 0.05, imessage: 0.05 } },
    state,
    log: silent,
    sources: [
      {
        name: 'whatsapp',
        walksHistory: true,
        needs: async () => {
          probes += 1;
          if (probes === 1) throw new Error('token file mid-rewrite');
          return [];
        },
        run: async () => ({}),
      },
      { name: 'imessage', walksHistory: true, needs: async () => [], run: async () => ({}) },
    ],
    ingestOpts: {},
    cacheDir: dir,
    activityPath,
  });
  try {
    instance.start();
    await sleep(1_200);
  } finally {
    instance.stop();
  }

  assert.ok(probes > 1, 'the source recovered and was probed again');
  assert.equal(state.getCursor('yearly-backfill:year'), String(walkYear),
    'one bad probe does not cost the backfill eleven years of progress');
  assert.equal(state.getCursor('yearly-backfill:complete'), null);
});

// ---------------------------------------------------------------------------
// (d) and the answer it gives about itself while it throws
// ---------------------------------------------------------------------------

test('a needs() throw clears the stale prerequisite answer and records a failed run', async (t) => {
  const dir = sandbox(t);
  const activityPath = join(dir, 'activity.json');
  const runs = [];
  const state = fakeState({});
  state.recordRun = (row) => runs.push(row);

  // Unprovisioned first, then unanswerable. `notReady` is a filter on the
  // activity queue: leaving the old answer standing kept the source hidden
  // from the queue on the strength of a check that no longer runs, and the
  // run log's newest entry stayed the last SUCCESS.
  let probes = 0;
  const instance = daemon.createDaemon({
    config: { retention: { maintainHour: '03:30' }, intervals: { whatsapp: 0.05 } },
    state,
    log: silent,
    sources: [
      {
        name: 'whatsapp',
        walksHistory: true,
        needs: async () => {
          probes += 1;
          if (probes <= 2) return ['the WhatsApp store is missing at <path>'];
          throw new Error('store locked by a backup');
        },
        run: async () => ({}),
      },
    ],
    ingestOpts: {},
    cacheDir: dir,
    activityPath,
  });
  try {
    instance.start();
    await sleep(1_300);
  } finally {
    instance.stop();
  }

  assert.ok(probes > 2, 'the source was probed after it started throwing');
  const snapshot = JSON.parse(readFileSync(activityPath, 'utf8'));
  assert.ok(
    (snapshot.queue ?? []).some((entry) => entry.connector === 'whatsapp'),
    "unknown is shown in the queue, not filtered out by last cycle's answer"
  );
  const failed = runs.filter((row) => row.ok === false);
  assert.ok(failed.length > 0, 'an unanswerable prerequisite check is a run that failed');
  assert.equal(typeof failed[0].error, 'string');
});

test('the startup probe says why a source was unavailable before any tick', async (t) => {
  const dir = sandbox(t);
  const lines = [];
  const instance = daemon.createDaemon({
    config: { retention: { maintainHour: '03:30' } },
    state: fakeState({}),
    log: { info() {}, error() {}, warn: (event, fields) => lines.push([event, fields]) },
    sources: [
      { name: 'whatsapp', walksHistory: true, needs: async () => { throw new Error('probe failed'); }, run: async () => ({}) },
    ],
    ingestOpts: {},
    cacheDir: dir,
    activityPath: join(dir, 'activity.json'),
  });
  try {
    instance.start();
    // SHORT OF THE FIRST TICK (1s + stagger). Only the startup pre-check has
    // run by now, and it used to swallow the error with a bare catch: the one
    // diagnostic for "why was this source unavailable at startup" did not
    // exist on the path that runs first.
    await sleep(400);
  } finally {
    instance.stop();
  }
  const failure = lines.find(([event]) => event === 'source_needs_failed');
  assert.ok(failure, 'the startup probe logs the failure it absorbed');
  assert.equal(failure[1].connector, 'whatsapp');
  assert.equal(failure[1].at, 'startup');
  // NAMES AND COUNTS, like every other line this logger carries.
  assert.equal(typeof failure[1].error, 'string');
});

// ---------------------------------------------------------------------------
// (e) and the LAST mailbox's gap drain is a turn, not a leftover
// ---------------------------------------------------------------------------

// Three mailboxes where the first two overrun the whole run budget on their
// own exempt first page — the shape a purge or a cursor loss produces — and
// the third has a small fresh window and an open hole below its cursor.
//
// The hole is the thing at stake. An equal slice of what is LEFT is zero by
// the time the third mailbox is reached, so its drain was gated on a deadline
// that had already passed and was skipped on every pass, forever: the mailbox
// looked busy (its fresh page ran) while `forward-gap-from` never moved.
function starvedDrain() {
  const BASE = new Date(2026, 5, 1, 12, 0, 0).getTime();
  let clock = BASE;
  const queries = [];
  const map = new Map();
  const state = {
    getCursor: (k) => map.get(k) ?? null,
    setCursor: (k, v) => map.set(k, String(v)),
    deleteCursor: (k) => map.delete(k),
  };
  // The third mailbox is caught up to yesterday and carries a hole from a
  // truncated pass some time before that.
  const GAP_FROM = BASE - 40 * 86_400_000;
  const GAP_UNTIL = BASE - 30 * 86_400_000;
  state.setCursor('mail:three@example.test:internalDate', String(BASE - 86_400_000));
  state.setCursor('mail:three@example.test:forward-gap-from', String(GAP_FROM));
  state.setCursor('mail:three@example.test:forward-gap-until', String(GAP_UNTIL));

  let issued = 0;
  const source = createMailSource({
    accountsForScope: () => [
      { email: 'one@example.test' },
      { email: 'two@example.test' },
      { email: 'three@example.test' },
    ],
    sleep: async (ms) => { clock += ms; },
    makeClient: ({ email }) => ({
      listMessages: async ({ q, pageToken }) => {
        queries.push({ email, q });
        if (q.startsWith('before:')) return { messages: [] };
        // The two cold mailboxes page forever: every page is full and hands
        // back another token, so each one spends its whole turn on page one.
        if (email !== 'three@example.test') {
          const page = Number(pageToken ?? 0);
          return {
            messages: Array.from({ length: 100 }, (_, i) => ({ id: `${email}-p${page}-${i}` })),
            nextPageToken: String(page + 1),
          };
        }
        // The caught-up mailbox: one short page and the window is finished,
        // which is what makes its gap eligible to be drained this pass.
        return { messages: [{ id: `three-${queries.length}` }] };
      },
      getMessage: async (id) => {
        issued += 1;
        // A drain query carries a `before:` bound; place its one message
        // inside the hole so the drain is seen to have read it.
        const inGap = String(id).startsWith('three-') && issued > 1;
        return {
          id,
          internalDate: String(inGap ? GAP_UNTIL - 1_000 : BASE - issued * 60_000),
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'Message-ID', value: `<${id}@example.test>` },
              { name: 'From', value: 'friend@example.test' },
              { name: 'To', value: 'owner@example.test' },
              { name: 'Subject', value: String(id) },
            ],
            body: { data: Buffer.from(String(id)).toString('base64url') },
          },
        };
      },
    }),
  });
  const ctx = {
    state,
    config: { mail: { backfillDays: 1400 } },
    home: '/tmp/mail-starve-test-home',
    now: () => clock,
    history: false,
    ingest: async (rows) => ({ inserted: rows.length, updated: 0, unchanged: 0 }),
    log: { info() {}, warn() {} },
    // The daemon's real forward budget, and the first two mailboxes each blow
    // it on one page (100 gets at 90 a minute is ~66s).
    deadline: BASE + 120_000,
  };
  return { source, ctx, state, queries, GAP_FROM, GAP_UNTIL };
}

test('the last mailbox drains its gap even when the budget is already spent', async () => {
  const { source, ctx, state, queries, GAP_FROM, GAP_UNTIL } = starvedDrain();
  await source.run(ctx);

  const drains = queries.filter(
    (entry) => entry.email === 'three@example.test'
      && entry.q.includes(`before:${Math.floor(GAP_UNTIL / 1000) + 1}`)
  );
  assert.equal(drains.length, 1,
    'the third mailbox got a turn at its own hole, not the remainder of a spent budget');
  // ...and only after its fresh window, which is still the first thing it does.
  const three = queries.filter((entry) => entry.email === 'three@example.test');
  assert.ok(three[0].q.startsWith('after:') && !three[0].q.includes('before:'),
    'the fresh window goes first; new mail outranks an old hole');
  // The drain read the hole to the bottom, so both keys go. Before the fix
  // these were still sitting there, pass after pass.
  assert.equal(state.getCursor('mail:three@example.test:forward-gap-from'), null);
  assert.equal(state.getCursor('mail:three@example.test:forward-gap-until'), null);
  assert.ok(GAP_FROM < GAP_UNTIL);
});
