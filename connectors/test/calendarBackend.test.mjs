import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCalendarSource } from '../sources/calendar.mjs';
import { validateConfig } from '../daemon.mjs';

const sandbox = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-backend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function fakeCtx(t, { config, client, held = [] }) {
  const ingested = [];
  const deletedIds = [];
  return {
    ingested,
    deletedIds,
    ctx: {
      config,
      cacheDir: sandbox(t),
      now: () => Date.parse('2026-08-19T12:00:00Z'),
      backfill: false,
      log: { info() {}, warn() {} },
      ingest: async (rows) => {
        ingested.push(...rows);
        return { ingested: rows.length, updated: 0, unchanged: 0 };
      },
      admin: {
        entities: async () => held,
        deleteEntities: async ({ entityIds }) => {
          deletedIds.push(...entityIds);
          return { deleted: entityIds.length };
        },
      },
      gcalClientFactory: () => client,
    },
  };
}

const event = (uid, startIso, endIso) => ({
  id: uid,
  iCalUID: uid,
  summary: 'Sync',
  start: { dateTime: startIso },
  end: { dateTime: endIso },
});

// The gate exists so an unprovisioned Google backend waits quietly instead of
// failing mid-run after a socket is already open.
test('needs() demands OAuth files only when the backend is google', () => {
  const source = createCalendarSource();
  assert.deepEqual(source.needs({ config: {} }), [], 'the local backend has no secret prerequisite');
  assert.deepEqual(source.needs(), [], 'no config at all still means local');

  const missing = source.needs({
    config: { calendar: { backend: 'google' } },
    tokensPath: '/nope/tokens.json',
    clientIdPath: '/nope/id.txt',
    clientSecretPath: '/nope/secret.txt',
  });
  assert.equal(missing.length, 3);
  assert.ok(missing.some((m) => m.includes('ops/gcal-auth.mjs')), 'must name the fix');
});

test('the google backend ingests rows shaped like the local ones', async (t) => {
  const client = {
    listCalendars: async () => [{ id: 'primary', summary: 'Mtgs', timeZone: 'America/Los_Angeles' }],
    listEvents: async () => [event('a@g', '2026-08-18T09:00:00Z', '2026-08-18T10:00:00Z')],
  };
  const { ctx, ingested } = fakeCtx(t, { config: { calendar: { backend: 'google' } }, client });
  await createCalendarSource().run(ctx);
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].source, 'calendar');
  assert.equal(ingested[0].meta.calendar, 'Mtgs');
  assert.ok(Number.isFinite(ingested[0].meta.start_ms));
});

// Deselected calendars are ones the owner has chosen not to look at.
test('unticked and deleted calendars are not ingested', async (t) => {
  const asked = [];
  const client = {
    listCalendars: async () => [
      { id: 'yes', summary: 'Mtgs' },
      { id: 'unticked', summary: 'Noise', selected: false },
      { id: 'gone', summary: 'Old', deleted: true },
    ],
    listEvents: async ({ calendarId }) => {
      asked.push(calendarId);
      return [event(`${calendarId}@g`, '2026-08-18T09:00:00Z', '2026-08-18T10:00:00Z')];
    },
  };
  const { ctx } = fakeCtx(t, { config: { calendar: { backend: 'google' } }, client });
  await createCalendarSource().run(ctx);
  assert.deepEqual(asked, ['yes']);
});

// One meeting on two calendars is one meeting.
test('the same event on two calendars is ingested once', async (t) => {
  const client = {
    listCalendars: async () => [
      { id: 'work', summary: 'Work' },
      { id: 'personal', summary: 'Personal' },
    ],
    listEvents: async () => [event('shared@g', '2026-08-18T09:00:00Z', '2026-08-18T10:00:00Z')],
  };
  const { ctx, ingested } = fakeCtx(t, { config: { calendar: { backend: 'google' } }, client });
  await createCalendarSource().run(ctx);
  assert.equal(ingested.length, 1);
});

// Reconciliation is what makes the two backends mutually exclusive: whatever
// this pass did not observe inside the window gets deleted.
test('entities in the window that Google no longer returns are deleted', async (t) => {
  const client = {
    listCalendars: async () => [{ id: 'primary', summary: 'Mtgs' }],
    listEvents: async () => [event('kept@g', '2026-08-18T09:00:00Z', '2026-08-18T10:00:00Z')],
  };
  const { ctx, deletedIds } = fakeCtx(t, {
    config: { calendar: { backend: 'google' } },
    client,
    held: [{ entity_id: 'calendar:stale@g:123' }, { entity_id: `calendar:kept@g:${Math.floor(Date.parse('2026-08-18T09:00:00Z') / 1000)}` }],
  });
  await createCalendarSource().run(ctx);
  assert.deepEqual(deletedIds, ['calendar:stale@g:123']);
});

test('config validation accepts the two backends and rejects anything else', () => {
  assert.doesNotThrow(() => validateConfig({ calendar: { backend: 'google' } }));
  assert.doesNotThrow(() => validateConfig({ calendar: { backend: 'local' } }));
  assert.doesNotThrow(() => validateConfig({ calendar: {} }));
  assert.throws(() => validateConfig({ calendar: { backend: 'gmail' } }), /must be one of/u);
  assert.throws(() => validateConfig({ calendar: { backends: 'google' } }), /unknown key/u);
});
