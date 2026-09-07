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
