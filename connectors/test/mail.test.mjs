import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailSource } from '../sources/mail.mjs';

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

// A whole mailbox, newest-first, that answers `after:`/`before:` in seconds
// the way Gmail does and pages 100 at a time. Every stub it hands out is a
// real message this stub can also `getMessage`, so the source's own exact
// bound check has something true to test against.
function mailbox({ count, newestTs, stepMs = 60_000, pageSize = 100 }) {
  const all = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    ts: newestTs - i * stepMs, // index 0 is the newest
  }));
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
        const after = /after:(\d+)/u.exec(q);
        const before = /before:(\d+)/u.exec(q);
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
        const m = byId.get(id);
        return {
          id,
          internalDate: String(m.ts),
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
        };
      },
    },
  };
}

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

  // The fresh window (after: the cursor) has nothing new; the whole pass goes
  // to the hole, which is 500 messages and fits inside one cap.
  const ids = new Set(secondIngested.map((r) => r.entity_id ?? r.uid ?? r.id));
  assert.equal(secondIngested.length, 500, 'the second pass reads exactly the 500 the cap cut off');
  assert.ok(ids.size > 0);
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
