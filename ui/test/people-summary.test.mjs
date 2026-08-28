// Tests for the year summary (people/summary.mjs): the guard that refuses to
// call the model on thin input (measured: an empty sample produced confident
// fiction), the even sampling, and the request shape — with a fake fetch, so
// no test ever needs a model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import {
  gatherRows,
  summarizeYear,
  sampleRows,
  MIN_ROWS,
  openSummariesDb,
  SUMMARY_REVISION,
} from '../server/people/summary.mjs';

const NOW = new Date(2027, 0, 1).getTime();

function spineDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  const ins = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name] of pairs) ins.run(id, name, 'phone', NOW);
  return db;
}

const HANDLE = '+18085550100';
const LLAMA = { baseUrl: 'http://127.0.0.1:51780', apiKey: () => 'k' };

function msgRow(ts, text, fromMe = false) {
  return { ts, source: 'imessage', entity_id: `s:${ts}:${text.length}`, text, meta: { chat_handle: HANDLE, is_from_me: fromMe } };
}

test('thin input never reaches the model — the guard answers instead', async () => {
  const ctx = openDb(':memory:');
  insertRows(ctx, [msgRow(new Date(2026, 3, 1).getTime(), 'a single long-enough message about surfing')]);
  const spine = spineDb([[HANDLE, 'Sam Lee']]);
  let called = 0;
  const out = await summarizeYear(ctx, spine, {
    personKey: 'name:sam lee', year: 2026, now: NOW,
    owner: { addresses: new Set(), names: [] },
    llama: LLAMA,
    fetchFn: async () => { called += 1; throw new Error('must not be called'); },
    summariesDb: openSummariesDb(':memory:'),
  });
  assert.equal(called, 0, 'no model call on thin input');
  assert.equal(out.text, null);
  assert.match(out.reason, /substantive messages/u);
});

test('a real sample produces a summary, and the request stays on the given base', async () => {
  const ctx = openDb(':memory:');
  const y0 = new Date(2026, 1, 1).getTime();
  insertRows(ctx, Array.from({ length: 30 }, (_, i) =>
    msgRow(y0 + i * 86_400_000, `long enough message number ${i} about the surf trip planning`, i % 2 === 0)));
  const spine = spineDb([[HANDLE, 'Sam Lee']]);
  let url = null;
  let body = null;
  const out = await summarizeYear(ctx, spine, {
    personKey: 'name:sam lee', year: 2026, now: NOW,
    owner: { addresses: new Set(), names: [] },
    llama: LLAMA,
    fetchFn: async (u, opts) => {
      url = u; body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'You two mostly planned a surf trip.' } }] }) };
    },
    // ALWAYS injected: without it this test once wrote its fixture into the
    // owner's real summaries.db and then failed against its own stale row.
    summariesDb: openSummariesDb(':memory:'),
  });
  assert.equal(url, 'http://127.0.0.1:51780/v1/chat/completions');
  assert.equal(out.text, 'You two mostly planned a surf trip.');
  assert.ok(out.sampled >= MIN_ROWS && out.of === 30);
  assert.match(body.messages[1].content, /you: /u, 'owner side labeled');
  assert.match(body.messages[1].content, /Sam: /u, 'their side labeled by first name');
  assert.match(body.messages[0].content, /Start directly with the subject/u);
  assert.match(body.messages[0].content, /do not name either person/u);
});

test('summary revision invalidates cached participant-led wording', () => {
  assert.equal(SUMMARY_REVISION, 4);
});

test('sampleRows spreads evenly and caps', () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ i }));
  const s = sampleRows(rows, 120);
  assert.equal(s.length, 120);
  assert.equal(s[0].i, 0);
  assert.ok(s[119].i > 500, 'reaches the tail of the year');
});

test('year summaries include social DMs and exclude social rooms', () => {
  const ctx = openDb(':memory:');
  const y = new Date(2026, 2, 1).getTime();
  const sources = ['messenger', 'instagram', 'twitter', 'telegram', 'discord', 'slack', 'linkedin'];
  const idToKey = new Map();
  const rows = sources.map((source, i) => {
    const handle = `${source}_person`;
    idToKey.set(handle, `name:${source} person`);
    return {
      ts: y + i * 86_400_000,
      source,
      entity_id: `${source}:summary-direct`,
      text: `a substantive direct message about our ${source} project plans`,
      meta: { chat_handle: handle, is_group: false, is_from_me: i % 2 === 0 },
    };
  });
  rows.push({
    ts: y + 20 * 86_400_000,
    source: 'discord',
    entity_id: 'discord:summary-room',
    text: 'a substantive room message that must not enter a two-person summary',
    meta: {
      chat_handle: 'discord_room', sender_handle: 'discord_group_sender',
      is_group: true, is_from_me: false,
    },
  });
  idToKey.set('discord_group_sender', 'name:discord group sender');
  insertRows(ctx, rows);

  for (const source of sources) {
    const gathered = gatherRows(ctx, idToKey, `name:${source} person`, 2026);
    assert.equal(gathered.length, 1, `${source} direct message included`);
  }
  assert.deepEqual(
    gatherRows(ctx, idToKey, 'name:discord group sender', 2026),
    [],
    'room text cannot be summarized as a two-person conversation',
  );
});

test('a persisted summary is reused, and regenerates only after real drift', async () => {
  const ctx = openDb(':memory:');
  const y0 = new Date(2026, 1, 1).getTime();
  insertRows(ctx, Array.from({ length: 30 }, (_, i) =>
    msgRow(y0 + i * 86_400_000, `long enough message number ${i} about the surf trip planning`, i % 2 === 0)));
  const spine = spineDb([[HANDLE, 'Sam Lee']]);
  const { summaryStillValid } = await import('../server/people/summary.mjs');
  const sdb = openSummariesDb(':memory:');
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: `summary v${calls}` } }] }) };
  };
  const opts = { personKey: 'name:sam lee', year: 2026, now: NOW, owner: { addresses: new Set(), names: [] }, llama: LLAMA, fetchFn, summariesDb: sdb };
  const first = await summarizeYear(ctx, spine, opts);
  assert.equal(first.text, 'summary v1');
  const second = await summarizeYear(ctx, spine, opts);
  assert.equal(calls, 1, 'no second model call');
  assert.equal(second.text, 'summary v1');
  assert.equal(second.cached, true);
  // Small drift stays cached; large drift regenerates.
  assert.ok(summaryStillValid(30, 40));
  insertRows(ctx, Array.from({ length: 25 }, (_, i) =>
    msgRow(y0 + (40 + i) * 3600_000, `a brand new long enough message ${i} about something else entirely`)));
  const third = await summarizeYear(ctx, spine, opts);
  assert.equal(calls, 2, 'drift past the threshold regenerates');
  assert.equal(third.text, 'summary v2');
  sdb.close();
});
