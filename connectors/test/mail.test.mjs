import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailSource } from '../sources/mail.mjs';
import { messageToRow } from '../lib/mailRows.mjs';

function memoryState() {
  const values = new Map();
  return {
    getCursor: (key) => values.get(key) ?? null,
    setCursor: (key, value) => values.set(key, String(value)),
    deleteCursor: (key) => values.delete(key),
  };
}

const YEAR = {
  year: 2026,
  fromTs: new Date(2026, 0, 1).getTime(),
  toTs: new Date(2027, 0, 1).getTime(),
};

const message = (id, day) => ({
  id,
  internalDate: String(YEAR.fromTs + day * 86_400_000),
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'Message-ID', value: `<${id}@example.test>` },
      { name: 'From', value: 'friend@example.test' },
      { name: 'To', value: 'owner@example.test' },
      { name: 'Subject', value: `message ${id}` },
    ],
    body: { data: Buffer.from(`body ${id}`).toString('base64url') },
  },
});

// Three synthetic pages shared by the historyPagesPerPass tests below: enough
// pages that a default (5-page) budget drains them all in one pass, while
// `historyPagesPerPass: 1` still walks them one page — and one source.run()
// call — at a time.
function threeYearPages() {
  const pages = new Map([
    ['', { messages: [{ id: 'a' }], nextPageToken: 'page-2' }],
    ['page-2', { messages: [{ id: 'b' }], nextPageToken: 'page-3' }],
    ['page-3', { messages: [{ id: 'c' }] }],
  ]);
  const full = new Map([
    ['a', message('a', 1)],
    ['b', message('b', 2)],
    ['c', message('c', 3)],
  ]);
  return { pages, full };
}

test('historyPagesPerPass: 1 reproduces today\'s behavior — one page, and one durable-token persist, per pass', async () => {
  const { pages, full } = threeYearPages();
  const yearPageTokens = [];
  const tokensAfterEachRun = [];
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => ({
      listMessages: async ({ q, pageToken }) => {
        if (q.startsWith('before:')) return { messages: [] };
        yearPageTokens.push(pageToken ?? '');
        return pages.get(pageToken ?? '');
      },
      getMessage: async (id) => full.get(id),
    }),
  });
  const state = memoryState();
  const ingested = [];
  const ctx = {
    state,
    config: { mail: { historyPagesPerPass: 1 } },
    home: '/tmp/mail-test-home',
    now: () => YEAR.fromTs + 200 * 86_400_000,
    history: true,
    historyWindow: YEAR,
    ingest: async (rows) => {
      ingested.push(...rows);
      return { inserted: rows.length, updated: 0, unchanged: 0 };
    },
    log: { info() {}, warn() {} },
  };

  const first = await source.run(ctx);
  tokensAfterEachRun.push(state.getCursor('mail:owner@example.test:history-year:2026:page'));
  const second = await source.run(ctx);
  tokensAfterEachRun.push(state.getCursor('mail:owner@example.test:history-year:2026:page'));
  const third = await source.run(ctx);
  tokensAfterEachRun.push(state.getCursor('mail:owner@example.test:history-year:2026:page'));

  assert.equal(first.historyDone, false);
  assert.equal(second.historyDone, false);
  assert.equal(third.historyDone, true);
  assert.deepEqual(yearPageTokens, ['', 'page-2', 'page-3']);
  // The durable token is persisted after every one-page pass, not just at the
  // very end — a page token, then another, then cleared once the year is done.
  assert.deepEqual(tokensAfterEachRun, ['page-2', 'page-3', null]);
  assert.equal(ingested.length, 3);
  assert.equal(state.getCursor('mail:owner@example.test:history-year:2026:page'), null);
  assert.equal(state.getCursor('mail:owner@example.test:history-year:2026:done'), '1');
});

test('default historyPagesPerPass (5) drains all 3 available pages in a single pass, persisting the token after each', async () => {
  const { pages, full } = threeYearPages();
  const yearPageTokens = [];
  const tokensDuringRun = [];
  const state = memoryState();
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => ({
      listMessages: async ({ q, pageToken }) => {
        if (q.startsWith('before:')) return { messages: [] };
        yearPageTokens.push(pageToken ?? '');
        const result = pages.get(pageToken ?? '');
        // Snapshot the durable token right after this page's list call
        // resolves — later than that and the source's own bookkeeping for
        // this same page would already have overwritten it.
        tokensDuringRun.push(state.getCursor('mail:owner@example.test:history-year:2026:page'));
        return result;
      },
      getMessage: async (id) => full.get(id),
    }),
  });
  const ingested = [];
  const ctx = {
    state,
    config: {}, // no override: exercises the DEFAULT_HISTORY_PAGES_PER_PASS of 5
    home: '/tmp/mail-test-home',
    now: () => YEAR.fromTs + 200 * 86_400_000,
    history: true,
    historyWindow: YEAR,
    ingest: async (rows) => {
      ingested.push(...rows);
      return { inserted: rows.length, updated: 0, unchanged: 0 };
    },
    log: { info() {}, warn() {} },
  };

  const result = await source.run(ctx);

  assert.equal(result.historyDone, true, 'all 3 pages fit inside the 5-page budget, so the year finishes in one pass');
  assert.deepEqual(yearPageTokens, ['', 'page-2', 'page-3']);
  assert.equal(ingested.length, 3);
  // Token as observed BEFORE this page's own persist: '', 'page-2', 'page-3'
  // — proof each earlier page's token was already durable before the next
  // page's list call went out, not just once at the very end of the pass.
  assert.deepEqual(tokensDuringRun, [null, 'page-2', 'page-3']);
  assert.equal(state.getCursor('mail:owner@example.test:history-year:2026:page'), null);
  assert.equal(state.getCursor('mail:owner@example.test:history-year:2026:done'), '1');
});

test('the pages-per-pass budget stops early when the year finishes before the budget is spent', async () => {
  // Only 2 pages exist even though the budget (set to 5) would allow more —
  // the loop must stop at year-done, not spin further iterations.
  const pages = new Map([
    ['', { messages: [{ id: 'a' }], nextPageToken: 'page-2' }],
    ['page-2', { messages: [{ id: 'b' }] }],
  ]);
  const full = new Map([
    ['a', message('a', 1)],
    ['b', message('b', 2)],
  ]);
  const listCalls = [];
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => ({
      listMessages: async ({ q, pageToken }) => {
        listCalls.push({ q, pageToken: pageToken ?? '' });
        if (q.startsWith('before:')) return { messages: [] };
        return pages.get(pageToken ?? '');
      },
      getMessage: async (id) => full.get(id),
    }),
  });
  const state = memoryState();
  const ingested = [];
  const ctx = {
    state,
    config: { mail: { historyPagesPerPass: 5 } },
    home: '/tmp/mail-test-home',
    now: () => YEAR.fromTs + 200 * 86_400_000,
    history: true,
    historyWindow: YEAR,
    ingest: async (rows) => {
      ingested.push(...rows);
      return { inserted: rows.length, updated: 0, unchanged: 0 };
    },
    log: { info() {}, warn() {} },
  };

  const result = await source.run(ctx);

  assert.equal(result.historyDone, true);
  assert.equal(ingested.length, 2);
  // Exactly 2 year-window list calls plus the one "is there anything older"
  // probe — never a 3rd or subsequent year-window page the budget would have
  // allowed but the drained year had nothing left to give.
  const yearCalls = listCalls.filter((c) => !c.q.startsWith('before:'));
  assert.equal(yearCalls.length, 2, 'must stop once the year is drained, not spend the rest of the budget');
  assert.equal(state.getCursor('mail:owner@example.test:history-year:2026:page'), null);
  assert.equal(state.getCursor('mail:owner@example.test:history-year:2026:done'), '1');
});

test('a page of N stubs is paced at 60000/getsPerMinute ms between messages.get calls', async () => {
  const N = 4;
  const stubs = Array.from({ length: N }, (_, i) => ({ id: `m${i}` }));
  const sleeps = [];
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => ({
      listMessages: async () => ({ messages: stubs }),
      getMessage: async (id) => message(id, 1),
    }),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const ctx = {
    state: memoryState(),
    config: { mail: { getsPerMinute: 90 } },
    home: '/tmp/mail-test-home',
    now: () => YEAR.fromTs,
    ingest: async (rows) => ({ inserted: rows.length, updated: 0, unchanged: 0 }),
    log: { info() {}, warn() {} },
  };

  await source.run(ctx);

  const spacingMs = 60_000 / 90;
  assert.equal(sleeps.length, N - 1, `${N} stubs must produce ${N - 1} spacing waits`);
  for (const ms of sleeps) assert.equal(ms, spacingMs);
});

test('mail.getsPerMinute from config changes the spacing between messages.get calls', async () => {
  const stubs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const sleeps = [];
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => ({
      listMessages: async () => ({ messages: stubs }),
      getMessage: async (id) => message(id, 1),
    }),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const ctx = {
    state: memoryState(),
    config: { mail: { getsPerMinute: 30 } },
    home: '/tmp/mail-test-home',
    now: () => YEAR.fromTs,
    ingest: async (rows) => ({ inserted: rows.length, updated: 0, unchanged: 0 }),
    log: { info() {}, warn() {} },
  };

  await source.run(ctx);

  const spacingMs = 60_000 / 30;
  assert.equal(sleeps.length, 2);
  for (const ms of sleeps) assert.equal(ms, spacingMs, 'a lower getsPerMinute must widen the spacing');
});

test('mail failures never copy account addresses or provider bodies into logs', async () => {
  const events = [];
  const source = createMailSource({
    accountsForScope: () => [{ email: 'private-owner@example.test' }],
    makeClient: () => ({
      listMessages: async () => {
        throw new Error('provider echoed a private subject and private-owner@example.test');
      },
    }),
  });
  const ctx = {
    state: memoryState(),
    config: {},
    home: '/tmp/mail-test-home',
    now: () => YEAR.fromTs,
    ingest: async () => ({ inserted: 0, updated: 0, unchanged: 0 }),
    log: {
      info(event, fields) { events.push({ event, fields }); },
      warn(event, fields) { events.push({ event, fields }); },
    },
  };

  await assert.rejects(source.run(ctx), /^Error: all 1 mail account\(s\) failed$/u);
  const written = JSON.stringify(events);
  assert.doesNotMatch(written, /private-owner|private subject|example\.test/u);
  assert.match(written, /"accountIndex":0/u);
});

// ---------------------------------------------------------------------------
// THE FORWARD SCAN'S CAP. Gmail lists NEWEST-FIRST, so the messages
// MAX_MESSAGES_PER_ACCOUNT cuts off are the OLDEST ones in the window -- and
// the cursor used to be moved to the NEWEST row that landed, which declared
// every one of them handled. These two tests are the fixture that told them
// apart: 2,500 messages newest-first against a 2,000 cap.
// ---------------------------------------------------------------------------

const CURSOR_KEY = 'mail:owner@example.test:internalDate';
const GAP_FROM_KEY = 'mail:owner@example.test:forward-gap-from';
const GAP_UNTIL_KEY = 'mail:owner@example.test:forward-gap-until';

const fullMessage = (id, ts) => ({
  id,
  internalDate: String(ts),
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'Message-ID', value: `<${id}@example.test>` },
      { name: 'From', value: 'friend@example.test' },
      { name: 'To', value: 'owner@example.test' },
      { name: 'Subject', value: `message ${id}` },
    ],
    body: { data: Buffer.from(`body ${id}`).toString('base64url') },
  },
});

// A whole mailbox with the timestamps given EXPLICITLY, index 0 newest, ties
// allowed. Ties are the point: Gmail orders equal internalDates arbitrarily,
// modelled here as "arbitrary but stable" — the array's own order — so a cap
// that cuts through a run of identical timestamps cuts it in the same place
// every time and a test can name the messages it left behind.
//
// It answers `after:`/`before:` in whole seconds the way Gmail does, pages 100
// at a time, and every stub it hands out is a real message it can also
// `getMessage` — so the source's exact JS bound has something true to test
// against. `onGet(id, nth)` may throw to model a provider failure.
function mailboxOf(stamps, { pageSize = 100, onGet = null } = {}) {
  const all = stamps.map((ts, i) => ({ id: `m${i}`, ts }));
  const byId = new Map(all.map((m) => [m.id, m]));
  const listCalls = [];
  const fetched = [];
  return {
    all,
    listCalls,
    fetched,
    client: {
      listMessages: async ({ q, pageToken, maxResults = pageSize }) => {
        listCalls.push(q);
        const after = /after:(-?\d+)/u.exec(q);
        const before = /before:(-?\d+)/u.exec(q);
        const lo = after ? Number(after[1]) * 1000 : Number.NEGATIVE_INFINITY;
        const hi = before ? Number(before[1]) * 1000 : Number.POSITIVE_INFINITY;
        const window = all.filter((m) => m.ts >= lo && m.ts <= hi);
        const offset = pageToken ? Number(pageToken) : 0;
        const slice = window.slice(offset, offset + maxResults);
        const next = offset + maxResults < window.length ? String(offset + maxResults) : undefined;
        return { messages: slice.map((m) => ({ id: m.id })), ...(next ? { nextPageToken: next } : {}) };
      },
      getMessage: async (id) => {
        fetched.push(id);
        if (onGet) await onGet(id, fetched.length);
        return fullMessage(id, byId.get(id).ts);
      },
    },
  };
}

function mailbox({ count, newestTs, stepMs = 60_000, pageSize = 100 }) {
  return mailboxOf(Array.from({ length: count }, (_, i) => newestTs - i * stepMs), { pageSize });
}

// The provider's own shape for a status failure: gmailClient.mjs attaches
// `status` to the Error it throws, and the source's 404 handling reads it.
function httpError(status) {
  const error = new Error(`Gmail messages.get failed: HTTP ${status}`);
  error.status = status;
  return error;
}

// MAX_MESSAGES_PER_ACCOUNT in sources/mail.mjs. Not exported, and the fixtures
// below have to straddle it, so it is named here rather than spelled 2000 in
// six places.
const MAX_PER_ACCOUNT = 2000;
const distinctIds = (rows) => new Set(rows.map((r) => r.entity_id));

function forwardCtx(state, ingested, { now }) {
  return {
    state,
    config: {},
    home: '/tmp/mail-test-home',
    now: () => now,
    ingest: async (rows) => {
      ingested.push(...rows);
      return { inserted: rows.length, updated: 0, unchanged: 0 };
    },
    log: { info() {}, warn() {} },
  };
}

test('a forward window the per-account cap cut records the unfetched older range instead of skipping it', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const box = mailbox({ count: 2500, newestTs: NOW - 60_000 });
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => box.client,
    sleep: async () => {},
  });
  const state = memoryState();
  const ingested = [];
  await source.run(forwardCtx(state, ingested, { now: NOW }));

  // 2,000 is MAX_MESSAGES_PER_ACCOUNT: the newest 2,000 of the 2,500 landed.
  assert.equal(box.fetched.length, 2000, 'the cap still bounds one pass');
  assert.equal(ingested.length, 2000);

  const newest = box.all[0].ts;
  const oldestLanded = box.all[1999].ts;
  assert.equal(state.getCursor(CURSOR_KEY), String(newest), 'the forward cursor still reaches the newest landed row');

  // THE POINT. The 500 messages older than oldestLanded were never listed.
  // Without a recorded gap the cursor above puts them permanently behind it.
  assert.equal(
    state.getCursor(GAP_UNTIL_KEY),
    String(oldestLanded),
    'the ceiling of the unfetched hole is the oldest row that DID land'
  );
  const gapFrom = Number(state.getCursor(GAP_FROM_KEY));
  assert.ok(Number.isFinite(gapFrom) && gapFrom > 0, 'the hole must have a recorded floor');
  assert.ok(gapFrom < oldestLanded, 'the floor must sit below the ceiling');
  assert.ok(gapFrom <= box.all[2499].ts, 'the floor must reach at or below the oldest message in the window');
});

test('the next pass drains the recorded gap and clears it, so nothing behind the cursor is lost', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const box = mailbox({ count: 2500, newestTs: NOW - 60_000 });
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => box.client,
    sleep: async () => {},
  });
  const state = memoryState();

  const firstIngested = [];
  await source.run(forwardCtx(state, firstIngested, { now: NOW }));
  assert.equal(firstIngested.length, 2000);

  const secondIngested = [];
  await source.run(forwardCtx(state, secondIngested, { now: NOW }));

  // The fresh window (from the cursor up) has nothing new; the whole pass goes
  // to the hole, which is 500 messages and fits inside one cap.
  //
  // 502, not 500, and the two extra are the design rather than slop: both
  // boundaries are INCLUSIVE so that a message sharing a boundary
  // internalDate cannot fall between two windows (see the forward-scan
  // comment on ties), which re-reads the row AT the cursor and the row AT the
  // gap ceiling. hermes dedupes them on (source, entity_id); an exclusive
  // bound would save these two reads and lose their same-millisecond twins
  // forever.
  const ids = new Set(secondIngested.map((r) => r.entity_id ?? r.uid ?? r.id));
  assert.equal(secondIngested.length, 502, 'the 500 the cap cut off, plus the two inclusive boundary rows');
  assert.equal(ids.size, 502);
  assert.equal(state.getCursor(GAP_FROM_KEY), null, 'a fully drained hole leaves no gap cursors behind');
  assert.equal(state.getCursor(GAP_UNTIL_KEY), null);

  // Between the two passes EVERY message in the mailbox has been fetched --
  // the invariant the old cursor broke. Not "exactly once": Gmail's
  // `after:`/`before:` are whole seconds, so each window is deliberately a
  // little wider than its exact bound and a boundary message is re-fetched
  // and then dropped by the JS bound check. That costs a dedupe; the bound
  // being too NARROW would cost the message forever.
  assert.equal(new Set(box.fetched).size, 2500, 'every message was reached');
  assert.ok(box.fetched.length <= 2500 + 4, `boundary re-fetches must stay tiny, saw ${box.fetched.length}`);
});

test('the successful scan log carries accountIndex, never the account address', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const box = mailbox({ count: 3, newestTs: NOW - 60_000 });
  const events = [];
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => box.client,
    sleep: async () => {},
  });
  const state = memoryState();
  await source.run({
    ...forwardCtx(state, [], { now: NOW }),
    log: {
      info: (event, fields) => events.push({ event, fields }),
      warn: (event, fields) => events.push({ event, fields }),
    },
  });

  const scan = events.find((e) => e.event === 'mail_account_scan');
  assert.ok(scan, 'the success path must log');
  assert.equal(scan.fields.accountIndex, 0);
  assert.equal(scan.fields.account, undefined, 'the address is private data and connectors.log is persistent');
  assert.doesNotMatch(JSON.stringify(scan), /owner@example\.test/u);
});

test('the history page loop stops at the daemon\'s time budget, not only between passes', async () => {
  // HISTORY_BUDGET_MS is checked around source.run() in the daemon, so a pass
  // that drains 5 pages of its own overran the budget by minutes with nothing
  // able to notice until it returned. The deadline now reaches the page loop.
  const T0 = YEAR.fromTs + 200 * 86_400_000;
  let clock = T0;
  const listCalls = [];
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => ({
      listMessages: async ({ q, pageToken }) => {
        if (q.startsWith('before:')) return { messages: [] };
        listCalls.push(pageToken ?? '');
        clock += 15_000; // each page costs 15s of the 20s budget
        return { messages: [{ id: `p${listCalls.length}` }], nextPageToken: `t${listCalls.length}` };
      },
      getMessage: async (id) => message(id, 5),
    }),
    sleep: async () => {},
  });
  const state = memoryState();
  await source.run({
    state,
    config: { mail: { historyPagesPerPass: 5 } },
    home: '/tmp/mail-test-home',
    now: () => clock,
    history: true,
    historyWindow: YEAR,
    deadline: T0 + 20_000,
    ingest: async (rows) => ({ inserted: rows.length, updated: 0, unchanged: 0 }),
    log: { info() {}, warn() {} },
  });

  assert.equal(listCalls.length, 2, 'page 0 always runs; the budget stops the loop before page 2 of 5');
  assert.equal(
    state.getCursor('mail:owner@example.test:history-year:2026:page'),
    't2',
    'the durable token is left exactly where the budget stopped, so the next pass resumes there'
  );
});

test('no deadline in ctx keeps the full pages-per-pass budget, as an older daemon supplies none', async () => {
  const T0 = YEAR.fromTs + 200 * 86_400_000;
  const listCalls = [];
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => ({
      listMessages: async ({ q, pageToken }) => {
        if (q.startsWith('before:')) return { messages: [] };
        listCalls.push(pageToken ?? '');
        return { messages: [{ id: `p${listCalls.length}` }], nextPageToken: `t${listCalls.length}` };
      },
      getMessage: async (id) => message(id, 5),
    }),
    sleep: async () => {},
  });
  await source.run({
    state: memoryState(),
    config: { mail: { historyPagesPerPass: 3 } },
    home: '/tmp/mail-test-home',
    now: () => T0,
    history: true,
    historyWindow: YEAR,
    ingest: async (rows) => ({ inserted: rows.length, updated: 0, unchanged: 0 }),
    log: { info() {}, warn() {} },
  });
  assert.equal(listCalls.length, 3);
});

// ---------------------------------------------------------------------------
// TIES, DELETIONS, AND WHAT A KILLED PASS LOSES.
//
// The tests above space their fixtures a minute apart, which is exactly the
// assumption the forward scan cannot make: internalDate is milliseconds,
// Gmail orders equal ones arbitrarily, and the per-account cap can cut a run
// of identical timestamps in half. These six fixtures are the ones that tell
// the boundary rules apart -- each fails against the pre-2026-09-09 scan.
// ---------------------------------------------------------------------------

const forwardSource = (box) => createMailSource({
  accountsForScope: () => [{ email: 'owner@example.test' }],
  makeClient: () => box.client,
  sleep: async () => {},
});

test('messages sharing one internalDate across the cap boundary all land, over as many passes as it takes', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const NEWEST = NOW - 60_000;
  // 2,105 messages a minute apart EXCEPT for ten that share one internalDate
  // and straddle the 2,000 cap: indices 1995-1999 are read by the first pass,
  // 2000-2004 are not, and no timestamp can tell the two halves apart. An
  // exclusive ceiling writes the tie as "read" and drops the five it never
  // fetched from every future window -- the fresh one rejects <= cursor, the
  // drain rejects >= until, and nothing else ever looks there.
  const TIE = NEWEST - 1995 * 60_000;
  const stamps = Array.from({ length: 2105 }, (_, i) => {
    if (i < 1995) return NEWEST - i * 60_000;
    if (i <= 2004) return TIE;
    return TIE - (i - 2004) * 60_000;
  });
  const box = mailboxOf(stamps);
  const source = forwardSource(box);
  const state = memoryState();
  const ingested = [];

  await source.run(forwardCtx(state, ingested, { now: NOW }));
  assert.equal(box.fetched.length, MAX_PER_ACCOUNT, 'the cap still bounds one pass');
  assert.equal(
    state.getCursor(GAP_UNTIL_KEY),
    String(TIE),
    'the ceiling is the shared timestamp itself, and it is inclusive'
  );

  // Bounded, so a hole that stops shrinking fails the test instead of hanging.
  for (let pass = 0; pass < 4 && state.getCursor(GAP_FROM_KEY) !== null; pass += 1) {
    await source.run(forwardCtx(state, ingested, { now: NOW }));
  }
  assert.equal(state.getCursor(GAP_FROM_KEY), null, 'the hole drains');
  assert.equal(state.getCursor(GAP_UNTIL_KEY), null);

  const ids = distinctIds(ingested);
  for (const i of [1995, 1999, 2000, 2004]) {
    assert.ok(ids.has(`mail:m${i}@example.test`), `m${i} shares the boundary timestamp and must still land`);
  }
  assert.equal(ids.size, 2105, 'every message in the mailbox eventually lands');
});

test('a 404 from messages.get is a deleted message: the page still lands, the cursor still advances', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const stamps = Array.from({ length: 5 }, (_, i) => NOW - (i + 1) * 60_000);
  const box = mailboxOf(stamps, {
    onGet: (id) => {
      // Deleted between messages.list and messages.get -- the one provider
      // answer that means "there is nothing here", ever.
      if (id === 'm2') throw httpError(404);
    },
  });
  const source = forwardSource(box);
  const state = memoryState();
  const ingested = [];
  const events = [];

  await source.run({
    ...forwardCtx(state, ingested, { now: NOW }),
    log: { info: (event, fields) => events.push({ event, fields }), warn: (event, fields) => events.push({ event, fields }) },
  });

  const ids = distinctIds(ingested);
  assert.equal(ids.size, 4, 'the other four messages on the page are ingested');
  assert.ok(!ids.has('mail:m2@example.test'));
  assert.equal(state.getCursor(CURSOR_KEY), String(stamps[0]), 'and the pass advances past the deleted message');
  const scan = events.find((e) => e.event === 'mail_account_scan');
  assert.equal(scan.fields.skipped, 1, 'counted, so a rising count is visible');
  assert.equal(scan.fields.rows, 4);
  assert.doesNotMatch(JSON.stringify(scan), /m2@|owner@example\.test/u, 'a count, never an id or an address');
});

test('a 5xx part way through a window keeps every page already ingested, and the next pass drains the rest', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const NEWEST = NOW - 60_000;
  const stamps = Array.from({ length: 250 }, (_, i) => NEWEST - i * 60_000);
  // Fails on the 150th get: page 1 (100 messages) is complete, page 2 is not.
  let box = mailboxOf(stamps, { onGet: (id, nth) => { if (nth === 150) throw httpError(503); } });
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => box.client,
    sleep: async () => {},
  });
  const state = memoryState();
  const ingested = [];

  await assert.rejects(
    source.run(forwardCtx(state, ingested, { now: NOW })),
    /^Error: all 1 mail account\(s\) failed$/u,
    'a 5xx is not a deletion: it still fails the account'
  );

  assert.equal(ingested.length, 100, 'page 1 was ingested before page 2 failed, not held to the end of the window');
  assert.equal(state.getCursor(CURSOR_KEY), String(NEWEST), 'and page 1 progress is durable');
  assert.equal(
    state.getCursor(GAP_UNTIL_KEY),
    String(stamps[99]),
    'the hole recorded starts at the bottom of the page that landed'
  );
  assert.ok(Number(state.getCursor(GAP_FROM_KEY)) > 0, 'with a floor, so the next pass can drain it');

  // The same account, next cycle, provider healthy.
  box = mailboxOf(stamps);
  await source.run(forwardCtx(state, ingested, { now: NOW }));
  assert.equal(distinctIds(ingested).size, 250, 'the failed pass cost a page, not the mailbox');
  assert.equal(state.getCursor(GAP_FROM_KEY), null);
  assert.equal(state.getCursor(GAP_UNTIL_KEY), null);
});

test('a window whose messages all sit at or below the cursor stops at the floor instead of spending the cap', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const C = NOW - 60_000 + 999; // 999ms into its own second, which the query rounds
  // Five messages sit exactly ON the cursor -- an exclusive bound calls them
  // handled and never reads them -- and 2,100 more sit in the same second just
  // BELOW it, three to a millisecond. That is enough to spend the whole
  // per-account cap on messages no bound can accept, land nothing, record
  // nothing, and repeat the identical pass every cycle.
  const stamps = [
    C, C, C, C, C,
    ...Array.from({ length: 2100 }, (_, i) => C - 1 - Math.floor(i / 3)),
  ];
  const box = mailboxOf(stamps);
  const source = forwardSource(box);
  const state = memoryState();
  const ingested = [];
  state.setCursor(CURSOR_KEY, String(C));

  await source.run(forwardCtx(state, ingested, { now: NOW }));

  assert.equal(distinctIds(ingested).size, 5, 'the ties AT the cursor are inside the window, not behind it');
  assert.ok(box.fetched.length < 20, `the scan stops below the floor, it does not spend the cap: ${box.fetched.length} gets`);
  // No gap, and that is the honest answer rather than a fall-through: a gap
  // records a hole ABOVE the floor, and everything unread here is below it,
  // where the yearly history walk lives.
  assert.equal(state.getCursor(GAP_FROM_KEY), null);
  assert.equal(state.getCursor(GAP_UNTIL_KEY), null);
  assert.equal(state.getCursor(CURSOR_KEY), String(C));

  const afterFirst = box.fetched.length;
  await source.run(forwardCtx(state, ingested, { now: NOW }));
  assert.equal(box.fetched.length, afterFirst * 2, 'and the next pass is the same cheap pass, not a 2,000-get no-op');
});

test('two truncations in a row walk the ceiling DOWN, page by page, and never widen it back', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const state = memoryState();
  // Sampled from inside the second pass: the stored ceiling as the drain is
  // still running. A window that persists its progress only when it returns
  // leaves every one of these equal to where the pass started, which is the
  // difference between losing a page to a kill and losing 2,000 messages.
  let watching = false;
  const midPass = [];
  const box = mailboxOf(Array.from({ length: 4500 }, (_, i) => NOW - 60_000 - i * 60_000), {
    onGet: (_id, nth) => {
      if (watching && nth % 500 === 0) midPass.push(state.getCursor(GAP_UNTIL_KEY));
    },
  });
  const source = forwardSource(box);
  const ingested = [];

  await source.run(forwardCtx(state, ingested, { now: NOW }));
  const floorAfterFirst = state.getCursor(GAP_FROM_KEY);
  const ceilingAfterFirst = Number(state.getCursor(GAP_UNTIL_KEY));

  // Pass 2's drain is itself cut by the cap: the second truncation.
  watching = true;
  await source.run(forwardCtx(state, ingested, { now: NOW }));
  watching = false;
  assert.ok(midPass.length >= 2, 'the second pass must be long enough to sample');
  assert.ok(
    midPass.some((v) => Number(v) < ceilingAfterFirst),
    `the drain lowers the stored ceiling as it goes, not once at the end: saw ${JSON.stringify(midPass)}`
  );
  const ceilingAfterSecond = Number(state.getCursor(GAP_UNTIL_KEY));
  assert.ok(
    ceilingAfterSecond < ceilingAfterFirst,
    `a truncated drain must lower the ceiling: ${ceilingAfterSecond} vs ${ceilingAfterFirst}`
  );
  assert.equal(state.getCursor(GAP_FROM_KEY), floorAfterFirst, 'and never move the floor');

  await source.run(forwardCtx(state, ingested, { now: NOW }));
  assert.equal(state.getCursor(GAP_FROM_KEY), null, 'the third pass finishes the hole');
  assert.equal(state.getCursor(GAP_UNTIL_KEY), null);
  assert.equal(distinctIds(ingested).size, 4500, 'and all 4,500 messages landed');
  // Inclusive boundaries re-read a boundary row per window; nothing re-reads a
  // whole stretch already ingested.
  assert.ok(
    box.fetched.length - 4500 <= 100,
    `overlap across three passes must stay under one page, saw ${box.fetched.length - 4500}`
  );
});

test('a drain that reaches its floor deletes BOTH gap keys, including when the ceiling has come down to meet it', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const NEWEST = NOW - 60_000;
  const U = NEWEST - 3_600_000;   // the stored ceiling: an hour of drained mail above it
  const F = U - 1990 * 60_000;    // the stored floor, with 30 messages sitting ON it
  const stamps = [
    NEWEST,
    ...Array.from({ length: 1990 }, (_, i) => U - i * 60_000),
    ...Array.from({ length: 30 }, () => F),
  ];
  const box = mailboxOf(stamps);
  const source = forwardSource(box);
  const state = memoryState();
  const ingested = [];
  // The state a previous truncated pass left behind.
  state.setCursor(CURSOR_KEY, String(NEWEST));
  state.setCursor(GAP_FROM_KEY, String(F));
  state.setCursor(GAP_UNTIL_KEY, String(U));

  // Pass A: the drain is cut by the cap inside the run of ties at the floor,
  // so its lowest row IS the floor and the ceiling comes down to meet it.
  await source.run(forwardCtx(state, ingested, { now: NOW }));
  assert.equal(state.getCursor(GAP_FROM_KEY), String(F));
  assert.equal(
    state.getCursor(GAP_UNTIL_KEY),
    String(F),
    'until === from is a real one-millisecond hole: the cap cut the run of ties at the floor'
  );

  // Pass B: that hole must still be drained -- until === from is not absence --
  // and finishing it must remove both keys rather than leave them behind.
  await source.run(forwardCtx(state, ingested, { now: NOW }));
  const ids = distinctIds(ingested);
  for (let i = 1991; i <= 2020; i += 1) {
    assert.ok(ids.has(`mail:m${i}@example.test`), `m${i} sits on the gap floor and must land`);
  }
  assert.equal(state.getCursor(GAP_FROM_KEY), null, 'a drained hole leaves no keys behind');
  assert.equal(state.getCursor(GAP_UNTIL_KEY), null);
  assert.equal(ids.size, 2021);
});

// ---------------------------------------------------------------------------
// Review G finding 3: A PAGE THAT LANDED NOTHING IS NOT PROGRESS. The
// per-page `onPage` writes dropped the window-level `landed > 0` check the
// old single write had, and the boundaries moved before messageToRow rather
// than only for rows that survived it. A page whose every in-window message
// yielded no row therefore moved the cursor past all of them -- and on a
// window that was NOT truncated, no gap was recorded either, so nothing ever
// looked there again.
//
// That state is not reachable through today's messageToRow (see the `toRow`
// seam's own comment in sources/mail.mjs: every in-window message with a
// finite internalDate produces a row), which is exactly why the branch
// needed a seam to be tested at all rather than being left as unrun code
// guarding the one thing in this connector that cannot be recovered.
// ---------------------------------------------------------------------------

const nullRowSource = (box, dropIds) => createMailSource({
  accountsForScope: () => [{ email: 'owner@example.test' }],
  makeClient: () => box.client,
  sleep: async () => {},
  toRow: (parsed, opts) => (dropIds.has(String(opts.uid)) ? null : messageToRow(parsed, opts)),
});

test('a single untruncated page whose every message yields no row records a gap instead of jumping it', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  // Five messages, one page, no page token, nothing below the floor: the
  // window finishes rather than truncating, so a truncation gap is not what
  // saves these.
  const stamps = Array.from({ length: 5 }, (_, i) => NOW - (i + 1) * 60_000);
  const box = mailboxOf(stamps);
  const state = memoryState();
  const ingested = [];

  const source = nullRowSource(box, new Set(['m0', 'm1', 'm2', 'm3', 'm4']));
  await source.run(forwardCtx(state, ingested, { now: NOW }));

  assert.equal(ingested.length, 0, 'sanity: the whole page yielded no row');
  assert.equal(
    state.getCursor(CURSOR_KEY),
    String(stamps[0]),
    'the cursor still advances -- holding it would livelock the account on the same gets every cycle'
  );
  assert.equal(
    state.getCursor(GAP_UNTIL_KEY),
    String(stamps[0]),
    "but the page's own ceiling is recorded, so the messages it passed over stay reachable"
  );
  assert.equal(state.getCursor(GAP_FROM_KEY), String(stamps[4]), 'down to its own floor');

  // And the hole is drainable: same account, next cycle, rows landing again.
  const source2 = forwardSource(mailboxOf(stamps));
  await source2.run(forwardCtx(state, ingested, { now: NOW }));
  assert.equal(distinctIds(ingested).size, 5, 'every message the null page skipped is read on the next pass');
  assert.equal(state.getCursor(GAP_FROM_KEY), null, 'and the hole closes rather than being re-read forever');
  assert.equal(state.getCursor(GAP_UNTIL_KEY), null);
});

test('a page of nothing but deletions is not recorded as a hole', async () => {
  const NOW = Date.UTC(2026, 5, 1);
  const stamps = Array.from({ length: 3 }, (_, i) => NOW - (i + 1) * 60_000);
  // Every get 404s: the messages are gone, they were never placed inside the
  // window, and a gap naming them would be a hole nothing could ever fill.
  const box = mailboxOf(stamps, { onGet: () => { throw httpError(404); } });
  const state = memoryState();
  const ingested = [];

  await forwardSource(box).run(forwardCtx(state, ingested, { now: NOW }));

  assert.equal(ingested.length, 0);
  assert.equal(state.getCursor(GAP_FROM_KEY), null, 'no hole for messages that no longer exist');
  assert.equal(state.getCursor(GAP_UNTIL_KEY), null);
});

// ---------------------------------------------------------------------------
// ONE BOUNDED PAGE PER ACCOUNT PER PASS, AND WHOSE TURN IT IS TO GO FIRST.
//
// The forward budget is sliced across the mailboxes that still have to run, so
// a pass's cost is bounded by "each account's slice, plus at most one page it
// was already inside when the slice ran out". Dropping the drain's time gate
// gave every account a SECOND exempt page -- one in the fresh window and one in
// the drain -- which doubled the worst-case pass (~200s to ~400s at three
// mailboxes, ~400s to ~790s at six, against a 120s budget) and made the
// guarantee the slice arithmetic rests on untrue (round-4 finding 4).
//
// The starvation that removal was answering is real and is fixed the other
// way: the last mailbox was starving because it was ALWAYS the last mailbox.

// N mailboxes, each with one page of one message and an already-recorded gap,
// on a clock that spends 15s per list call against a budget that is already
// gone. Every account therefore has MIN_ACCOUNT_SLICE_MS (10s), spends it on
// the fresh window's one exempt page, and is out of time when the drain is
// considered.
function multiMailboxPass(count, { state, now: T0, passes = 1 } = {}) {
  const emails = Array.from({ length: count }, (_, i) => `owner${i}@example.test`);
  let clock = T0;
  const listCalls = [];
  const source = createMailSource({
    accountsForScope: () => emails.map((email) => ({ email })),
    makeClient: ({ email }) => ({
      listMessages: async ({ q }) => {
        listCalls.push({ email, kind: q.startsWith('after:') && q.includes('before:') ? 'drain' : 'fresh' });
        clock += 15_000;
        return { messages: [{ id: `${email}-1` }] };
      },
      getMessage: async (id) => ({ ...message(id, 5), id }),
    }),
    sleep: async () => {},
  });
  return { emails, listCalls, source, clock: () => clock, run: async () => {
    for (let pass = 0; pass < passes; pass += 1) {
      await source.run({
        state,
        config: {},
        home: '/tmp/mail-test-home',
        now: () => clock,
        // A budget already spent at the top of the pass: every account falls to
        // the MIN_ACCOUNT_SLICE_MS floor, which is the shape finding 19's
        // arithmetic is about and the harshest case for the drain gate.
        deadline: T0,
        ingest: async (rows) => ({ inserted: rows.length, updated: 0, unchanged: 0 }),
        log: { info() {}, warn() {} },
      });
    }
  } };
}

function seedGaps(state, emails, { now }) {
  for (const email of emails) {
    state.setCursor(`mail:${email}:forward-gap-from`, String(now - 400 * 86_400_000));
    state.setCursor(`mail:${email}:forward-gap-until`, String(now - 300 * 86_400_000));
  }
}

for (const count of [3, 6]) {
  test(`${count} mailboxes: an out-of-time account spends one page, not one per window`, async () => {
    const NOW = Date.UTC(2026, 5, 1);
    const state = memoryState();
    const pass = multiMailboxPass(count, { state, now: NOW });
    seedGaps(state, pass.emails, { now: NOW });
    await pass.run();

    assert.equal(pass.listCalls.length, count,
      'one list call per mailbox: the fresh window\'s exempt page and nothing else');
    assert.deepEqual(pass.listCalls.filter((c) => c.kind === 'drain'), [],
      'an account already past its slice does not also spend an exempt page in the drain');
    assert.deepEqual(
      [...new Set(pass.listCalls.map((c) => c.email))].sort(),
      [...pass.emails].sort(),
      'and every mailbox still gets its one page, which is what makes the walk monotone'
    );
    // The gate must not silently discard the hole it declined to read.
    for (const email of pass.emails) {
      assert.ok(Number(state.getCursor(`mail:${email}:forward-gap-from`)) > 0,
        'the gap is still on record for the pass that has budget for it');
    }
  });

  test(`${count} mailboxes: the pass rotates which mailbox goes first`, async () => {
    const NOW = Date.UTC(2026, 5, 1);
    const state = memoryState();
    const pass = multiMailboxPass(count, { state, now: NOW, passes: count + 1 });
    await pass.run();

    const firstOfEachPass = [];
    for (let i = 0; i < pass.listCalls.length; i += count) {
      firstOfEachPass.push(pass.listCalls[i].email);
    }
    assert.equal(firstOfEachPass.length, count + 1);
    assert.deepEqual(
      [...new Set(firstOfEachPass.slice(0, count))].sort(),
      [...pass.emails].sort(),
      'over a full cycle every mailbox takes a turn at the largest slice'
    );
    assert.equal(firstOfEachPass[count], firstOfEachPass[0], 'and then it wraps');
  });
}
