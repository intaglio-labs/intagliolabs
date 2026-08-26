// Tests for the on-demand "am i up to date?" surface. It shares the watchdog's
// staleness policy, so these check the DETECTION intent and the RENDERING —
// that the freshness read is worded truthfully and calls out the right fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { detectSyncStatus, answerSyncStatus } from '../server/status/sync-status.mjs';

const NOW = Date.parse('2026-08-21T12:00:00Z');
const daysAgo = (d) => NOW - d * 86400000;

// Two in-memory stores shaped like the real ones: context(source, ts) and the
// connectors state.db run_log(connector, ok, finished_ts).
function stores({ rows = {}, runs = {} }) {
  const ctx = new DatabaseSync(':memory:');
  ctx.exec('CREATE TABLE context (source TEXT, ts INTEGER)');
  for (const [source, ts] of Object.entries(rows)) {
    ctx.prepare('INSERT INTO context (source, ts) VALUES (?, ?)').run(source, ts);
  }
  const state = new DatabaseSync(':memory:');
  state.exec('CREATE TABLE run_log (connector TEXT, ok INTEGER, finished_ts INTEGER)');
  for (const [connector, ts] of Object.entries(runs)) {
    state.prepare('INSERT INTO run_log (connector, ok, finished_ts) VALUES (?, 1, ?)').run(connector, ts);
  }
  return { ctx, state };
}

test('fires on freshness questions, not on content questions about a person', () => {
  assert.equal(detectSyncStatus('am i up to date on my messages?'), true);
  assert.equal(detectSyncStatus('is anything behind?'), true);
  assert.equal(detectSyncStatus('are my whatsapp messages syncing?'), true);
  assert.equal(detectSyncStatus('sync status'), true);
  // Content questions must fall through to the normal answer path.
  assert.equal(detectSyncStatus("what's the latest from Dana?"), false);
  assert.equal(detectSyncStatus('who are the investors I talked to'), false);
});

// THE FREEZE, surfaced on demand. whatsapp is a rows source: a connector that
// "ran ok" one minute ago against a two-month-old store must still read stale.
test('a frozen whatsapp reads stale even though its connector just ran ok', () => {
  const { ctx, state } = stores({
    rows: { imessage: daysAgo(0), mail: daysAgo(0), whatsapp: daysAgo(66) },
    runs: { mail: daysAgo(0), whatsapp: NOW }, // whatsapp "ran" just now
  });
  const out = answerSyncStatus(ctx, state, { now: NOW });
  assert.deepEqual(out.stale, ['whatsapp']);
  assert.equal(out.count, 1);
  assert.ok(out.text.includes('your whatsapp'));
  assert.ok(out.text.includes('open whatsapp on your mac'), out.text);
  assert.ok(out.text.includes('everything else is current'), out.text);
  ctx.close();
  state.close();
});

test('everything current reads as up to date, no fix mentioned', () => {
  const { ctx, state } = stores({
    rows: { imessage: daysAgo(0), mail: daysAgo(0), whatsapp: daysAgo(1) },
  });
  const out = answerSyncStatus(ctx, state, { now: NOW });
  assert.equal(out.count, 0);
  assert.ok(out.text.startsWith("you're up to date"), out.text);
  assert.ok(!/open whatsapp|might be down/u.test(out.text), 'no remedy when nothing is wrong');
  ctx.close();
  state.close();
});

// A source the owner never connected is not "behind" — it must not appear as a
// fault in the status any more than the watchdog alerts on it.
test('a never-ingested source is omitted, not reported as behind', () => {
  const { ctx, state } = stores({ rows: { imessage: daysAgo(0) } });
  const out = answerSyncStatus(ctx, state, { now: NOW });
  assert.equal(out.count, 0);
  assert.ok(!/whatsapp|linkedin/u.test(out.text), 'unconnected sources stay silent');
  ctx.close();
  state.close();
});

// The status is written as Intaglio Labs — lowercase, plain, no monitoring vocabulary.
test('the status reads like Intaglio Labs', () => {
  const { ctx, state } = stores({
    rows: { imessage: daysAgo(0), whatsapp: daysAgo(40) },
  });
  const out = answerSyncStatus(ctx, state, { now: NOW });
  assert.ok(!/error|failed|WARN|exception|STALE/u.test(out.text), out.text);
  assert.ok(!/^[A-Z]/u.test(out.text), 'lowercase opener');
  ctx.close();
  state.close();
});
