// WHAT A SOURCE THAT IS WAITING FOR A SIGN-IN IS OWED: to be asked again soon,
// and to be asked AT ONCE when the app says the owner has just done it.
//
// THE 2026-09-12 ONBOARDING RUN, which is what these pin. The connectors daemon
// starts at app launch — before screen 3's Google sign-in and before screen 4's
// LinkedIn export. Both sources answered needs() with a missing prerequisite at
// 20:51 and were rescheduled at their FULL polling interval, fifteen minutes
// away, and filtered out of activity.json's queue on the way. Ten minutes after
// the token file and the export had landed, neither had been asked again and
// nothing anywhere said they were waiting. The first clean run only picked them
// up because the app was reinstalled, which restarted the daemon — a reinstall
// is not a feature.
//
// Three separate things, and the tests are separate for the same reason:
//
//   * the wait is now a minute, doubling back up to the interval;
//   * the daemon re-probes every waiting source the moment it is nudged;
//   * a waiting source is NAMED in the activity file rather than silently
//     dropped — while still staying out of `queue`, because listing an
//     unconnected account as pending work is the complaint the queue filter was
//     added for.
//
// Every fixture is synthetic. `imessage` and `calendar` throughout: an optional
// connector is gated by its own connect action and would be testing something
// else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A namespace import so a constant this checkout does not export yet fails the
// assertion that wants it rather than the whole file's module load.
import * as daemon from '../daemon.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { info() {}, warn() {}, error() {} };

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hazlie-not-ready-'));
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

// A source that is missing a prerequisite until the test says otherwise, which
// is the shape of every connector on this screen: the token file or the export
// appears under a daemon that has already asked once and been told no.
function gatedSource(name, { missing = ['waiting for the owner'] } = {}) {
  const state = { ready: false, probes: 0, runs: 0 };
  return {
    state,
    source: {
      name,
      walksHistory: false,
      needs: async () => {
        state.probes += 1;
        return state.ready ? [] : [...missing];
      },
      run: async () => {
        state.runs += 1;
        return {};
      },
    },
  };
}

function build(t, sources, opts = {}) {
  const dir = sandbox(t);
  const activityPath = join(dir, 'activity.json');
  const instance = daemon.createDaemon({
    config: { retention: { maintainHour: '03:30' } },
    state: fakeState(),
    log: silent,
    sources,
    ingestOpts: {},
    cacheDir: dir,
    activityPath,
    ...opts,
  });
  t.after(() => instance.stop());
  return { instance, activityPath };
}

const snapshotOf = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ---------------------------------------------------------------------------
// (a) the wait ends on its own, without a restart
// ---------------------------------------------------------------------------

test('a source that becomes ready is re-probed within the back-off, not at the interval', async (t) => {
  const { state, source } = gatedSource('imessage');
  // 200 ms stands in for the shipped minute. The point of the assertion is that
  // the next probe is the BACK-OFF rather than the interval, and at the default
  // interval this source's second question would be 900 seconds away.
  const { instance } = build(t, [source], { reprobeFloorMs: 200 });

  instance.start();
  // The first tick is armed at 1 s and answers "not ready".
  await sleep(1_200);
  assert.equal(state.runs, 0, 'a source with a missing prerequisite must not run');
  assert.ok(state.probes >= 2, 'startup probes once and the first tick probes again');

  // The owner finishes signing in, under a daemon nobody restarted.
  state.ready = true;
  await sleep(700);

  assert.ok(
    state.runs >= 1,
    `a source that became ready was never asked again: ${state.runs} runs, ${state.probes} probes`
  );
});

// ---------------------------------------------------------------------------
// (b) the back-off doubles, and stops at the interval
// ---------------------------------------------------------------------------

test('the not-ready back-off grows to the interval and never past it', () => {
  assert.equal(
    daemon.NOT_READY_REPROBE_MS,
    60_000,
    'the first re-probe is a minute; fifteen is what this fixes'
  );
  // The scheduler's own number, so it must survive the retry arithmetic rather
  // than falling back to the interval the way an absent field does.
  assert.equal(daemon.sourceRetryDelay({ notReadyDelayMs: 60_000 }, 900_000), 60_000);
  assert.equal(daemon.sourceRetryDelay({ notReadyDelayMs: 240_000 }, 900_000), 240_000);
  // Past the interval it IS the interval: a source nobody is going to connect
  // must settle back onto its ordinary cadence rather than poll a missing file.
  assert.equal(daemon.sourceRetryDelay({ notReadyDelayMs: 1_800_000 }, 900_000), 900_000);
  // A source's own short-retry request is still capped at a minute, unchanged.
  assert.equal(daemon.sourceRetryDelay({ nextDelayMs: 900_000 }, 900_000), 60_000);
  assert.equal(daemon.sourceRetryDelay({}, 900_000), 900_000);
});

// ---------------------------------------------------------------------------
// (c) the nudge: the app says the owner just signed in
// ---------------------------------------------------------------------------

test('a nudge re-probes every waiting source at once, with no restart', async (t) => {
  const mail = gatedSource('calendar');
  const chat = gatedSource('imessage');
  // The shipped minute, deliberately: only the nudge can explain a run inside
  // this test's window.
  const { instance } = build(t, [mail.source, chat.source]);

  instance.start();
  await sleep(1_200);
  assert.equal(mail.state.runs + chat.state.runs, 0);

  mail.state.ready = true;
  chat.state.ready = true;
  const result = await instance.probeNotReady('test');

  assert.deepEqual(
    [...result.ready].sort(),
    ['calendar', 'imessage'],
    'a nudge answers for every waiting source, not just the first'
  );
  await sleep(300);
  assert.equal(mail.state.runs, 1, 'the nudged source ran');
  assert.equal(chat.state.runs, 1, 'and so did the other one');
});

test('a nudge for a source that is still not ready changes nothing', async (t) => {
  const { state, source } = gatedSource('imessage');
  const { instance } = build(t, [source]);

  instance.start();
  await sleep(1_200);
  const result = await instance.probeNotReady('test');

  assert.deepEqual(result.ready, [], 'a sign-in that has not happened is not a reason to run');
  await sleep(300);
  assert.equal(state.runs, 0);
});

// A nudge ARMS a source; the timer the back-off already armed for it must go.
// Two timers for one source is the overlap the whole scheduler is built to make
// impossible -- both passes read the same store and each moves a cursor the
// other reads.
test('a nudge replaces the pending timer rather than adding a second one', async (t) => {
  const { state, source } = gatedSource('imessage');
  const { instance } = build(t, [source], { reprobeFloorMs: 250 });

  instance.start();
  await sleep(1_200);
  assert.equal(state.runs, 0);

  state.ready = true;
  await instance.probeNotReady('test');
  // Well past the 250 ms the back-off had armed: a surviving second timer fires
  // inside this window and runs the source twice.
  await sleep(600);
  assert.equal(state.runs, 1, `the source ran ${state.runs} times for one nudge`);
});

// ---------------------------------------------------------------------------
// (d) waiting is SAID, and still not called pending work
// ---------------------------------------------------------------------------

test('a waiting source is named in the activity file and kept out of the queue', async (t) => {
  const { state, source } = gatedSource('imessage', {
    // The real messages embed absolute local paths; this asserts the count
    // travels and the strings do not.
    missing: ['/Users/someone/Library/Group Containers/whatever is missing'],
  });
  const { instance, activityPath } = build(t, [source], { reprobeFloorMs: 200 });

  instance.start();
  await sleep(1_200);

  const snapshot = snapshotOf(activityPath);
  assert.ok(
    !snapshot.queue.some((task) => task.connector === 'imessage'),
    'an account nobody connected is not pending work'
  );
  const waiting = snapshot.waiting ?? [];
  const row = waiting.find((entry) => entry.connector === 'imessage');
  assert.ok(row, `a waiting source said nothing at all: ${JSON.stringify(snapshot)}`);
  assert.equal(row.missing, 1, 'the count travels');
  assert.ok(Number.isFinite(row.nextTs), 'and when it will be asked again');
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /Group Containers/u,
    'the activity file must never carry a needs() message'
  );

  state.ready = true;
  await instance.probeNotReady('test');
  await sleep(300);
  const after = snapshotOf(activityPath);
  assert.equal(
    (after.waiting ?? []).some((entry) => entry.connector === 'imessage'),
    false,
    'a source that became ready stops being reported as waiting'
  );
});

// ---------------------------------------------------------------------------
// (e) and the signal cannot kill the process it is meant to wake
// ---------------------------------------------------------------------------

// SIGUSR2's DEFAULT ACTION IS TERMINATE. The app nudges because the owner
// finished a connect screen, and on a first run that is the same launch that
// spawned this process -- so the nudge races the boot it is nudging. A handler
// installed after the preflight leaves a window in which the app kills its own
// reader, and the failure looks exactly like the daemon crashing on startup.
//
// Source order, because the property IS the order: there is no way to observe
// the window from inside the process that would lose it.
test('the nudge handler is installed before anything that can take time', () => {
  const source = readFileSync(new URL('../daemon.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('if (isMain) {'));
  assert.ok(main.length > 0, 'the CLI entry moved');

  const handler = main.indexOf("process.on('SIGUSR2'");
  assert.notEqual(handler, -1, 'the daemon must handle the nudge at all');
  for (const slow of ['acquireDaemonLock(', 'await runChecks()', 'daemon.start()']) {
    const at = main.indexOf(slow);
    assert.notEqual(at, -1, `${slow} moved out of the CLI entry`);
    assert.ok(
      handler < at,
      `a nudge arriving before ${slow} terminates the daemon instead of waking it`
    );
  }
  // And one that arrives before there is a daemon is remembered, not dropped:
  // the startup probe answers for the readiness it saw, which may predate the
  // sign-in that caused the nudge.
  assert.match(main, /nudgePending = true/u);
});
