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

test('yearly mail history resumes one page at a time until the whole year is drained', async () => {
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
  const yearPageTokens = [];
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
    config: {},
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
  const second = await source.run(ctx);
  const third = await source.run(ctx);

  assert.equal(first.historyDone, false);
  assert.equal(second.historyDone, false);
  assert.equal(third.historyDone, true);
  assert.deepEqual(yearPageTokens, ['', 'page-2', 'page-3']);
  assert.equal(ingested.length, 3);
  assert.equal(state.getCursor('mail:owner@example.test:history-year:2026:page'), null);
  assert.equal(state.getCursor('mail:owner@example.test:history-year:2026:done'), '1');
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
