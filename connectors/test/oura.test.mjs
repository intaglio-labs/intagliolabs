// The Oura connector: client (mode selection, pagination, the rotation-safe
// token manager), source aggregation (golden day rows, completed-day
// exclusion), an e2e pass against the REAL hermes, and one LIVE smoke against
// Oura's unauthenticated sandbox (no auth, no personal data) to validate the
// URL shapes against the real service.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OURA_API_BASE,
  OURA_SANDBOX_AUTH,
  OURA_SANDBOX_BASE,
  OURA_TOKEN_URL,
  createOuraClient,
} from '../lib/ouraClient.mjs';
import ouraSource, {
  DEFAULT_BACKFILL_DAYS,
  STEADY_WINDOW_DAYS,
  buildRows,
  endOfLocalDayMs,
  localDayString,
  shiftLocalDay,
} from '../sources/oura.mjs';
import { loadSources } from '../daemon.mjs';
import { ingest } from '../lib/ingestClient.mjs';
import { start } from '../../ui/server/hermes.mjs';

// A fixed "now" so the fixture's day math is deterministic. Constructed from
// LOCAL components, so the derived day strings are the same on any machine
// regardless of its zone.
const NOW = new Date(2026, 7, 19, 9, 30, 0).getTime();
const TODAY = localDayString(new Date(NOW));
const D1 = shiftLocalDay(TODAY, -2);
const D2 = shiftLocalDay(TODAY, -1);

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeLog() {
  const lines = [];
  const push = (level) => (event, fields = {}) => lines.push({ level, event, ...fields });
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

// Owner-only secrets in a mkdtemp dir (mkdtemp dirs are 0700, which is what
// readSecretJson/readSecretLine demand of the parent).
function makeSecrets(dir, tokens) {
  const tokensPath = join(dir, 'oura-tokens.json');
  if (tokens) writeFileSync(tokensPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  const clientIdPath = join(dir, 'oura-client-id.txt');
  writeFileSync(clientIdPath, 'cid-123\n', { mode: 0o600 });
  const clientSecretPath = join(dir, 'oura-client-secret.txt');
  writeFileSync(clientSecretPath, 'csecret-456\n', { mode: 0o600 });
  return { tokensPath, clientIdPath, clientSecretPath };
}

const FRESH_TOKENS = () => ({
  access_token: 'old-access',
  refresh_token: 'old-refresh',
  token_type: 'Bearer',
  expires_in: 86_400,
  scope: 'daily',
  obtained_at: NOW - 1_000, // just minted
});
const STALE_TOKENS = () => ({ ...FRESH_TOKENS(), obtained_at: NOW - 87_000_000 }); // past expiry

// Fixture data mirroring the real v2 record shapes. daily_stress carries no
// `meta` on purpose (some collections ship without one — defensive access).
// D1's sleep periods arrive OUT of bedtime order to prove the source sorts.
function fixtureCollections() {
  return {
    daily_sleep: [
      { id: 'ds-1', day: D1, score: 85, timestamp: `${D1}T08:01:00-07:00`, meta: { version: 1, updated_at: `${D1}T09:00:00Z` } },
      { id: 'ds-2', day: D2, score: 90, timestamp: `${D2}T07:45:00-07:00`, meta: { version: 1, updated_at: `${D2}T09:00:00Z` } },
    ],
    sleep: [
      // the nap, listed first
      { id: 'sp-2', day: D1, type: 'late_nap', bedtime_start: `${D1}T14:00:00-07:00`, bedtime_end: `${D1}T15:05:00-07:00`, total_sleep_duration: 3600, deep_sleep_duration: 600, rem_sleep_duration: 300, light_sleep_duration: 2700, awake_time: 0, average_hrv: 44, meta: { version: 1 } },
      { id: 'sp-1', day: D1, type: 'long_sleep', bedtime_start: `${D1}T00:10:00-07:00`, bedtime_end: `${D1}T08:00:00-07:00`, total_sleep_duration: 25_200, deep_sleep_duration: 4500, rem_sleep_duration: 5400, light_sleep_duration: 15_300, awake_time: 1800, average_hrv: 52, meta: { version: 1 } },
      { id: 'sp-3', day: D2, type: 'long_sleep', bedtime_start: `${D2}T00:05:00-07:00`, bedtime_end: `${D2}T07:45:00-07:00`, total_sleep_duration: 27_000, deep_sleep_duration: 5400, rem_sleep_duration: 5400, light_sleep_duration: 16_200, awake_time: 900, average_hrv: 61, meta: { version: 1 } },
    ],
    daily_readiness: [
      { id: 'dr-1', day: D1, score: 82, temperature_deviation: -0.2, meta: { version: 2, updated_at: `${D1}T10:00:00Z` } },
    ],
    daily_activity: [
      { id: 'da-1', day: D1, score: 78, steps: 9432, active_calories: 512, meta: { version: 1 } },
      { id: 'da-today', day: TODAY, steps: 120 }, // incomplete day: must never be written
    ],
    daily_stress: [
      { id: 'st-1', day: D1, stress_high: 3900, recovery_high: 7800, day_summary: 'normal' }, // no meta field
    ],
    workout: [
      { id: 'w-1', activity: 'running', label: '', intensity: 'moderate', calories: 210, day: D1, start_datetime: `${D1}T07:00:00-07:00`, end_datetime: `${D1}T07:32:00-07:00`, meta: { version: 1 } },
    ],
  };
}

// Routes GETs by collection name, records every request.
function fixtureFetch(collections, requests = []) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    requests.push({
      url: String(url),
      pathname: u.pathname,
      params: Object.fromEntries(u.searchParams),
      auth: init?.headers?.Authorization ?? null,
    });
    const name = u.pathname.split('/').pop();
    return jsonRes({ data: collections[name] ?? [], next_token: null });
  };
}

function makeCtx({ collections = fixtureCollections(), requests = [], config, backfill = false, ingestImpl, state, tokensPath } = {}) {
  const captured = [];
  const log = fakeLog();
  const ctx = {
    state: state ?? { cursors: {}, setCursor(name, value) { this.cursors[name] = value; }, getCursor() { return null; } },
    ingest:
      ingestImpl ??
      (async (rows) => {
        captured.push(...rows);
        return { inserted: rows.length, updated: 0, unchanged: 0 };
      }),
    admin: {},
    config: config ?? { oura: { sandbox: true } },
    cacheDir: '/nonexistent-cache',
    log,
    now: () => NOW,
    backfill,
    fetchImpl: fixtureFetch(collections, requests),
    ...(tokensPath !== undefined ? { ouraTokensPath: tokensPath } : {}),
  };
  return { ctx, captured, requests, log };
}

// --- day math ---------------------------------------------------------------

test('local day helpers do component math in the local zone', () => {
  assert.equal(localDayString(new Date(2026, 0, 1, 0, 0, 1)), '2026-01-01');
  assert.equal(shiftLocalDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftLocalDay('2026-01-01', -7), '2025-12-25');
  // end of local day = one ms before the local midnight that follows it
  assert.equal(endOfLocalDayMs('2026-08-17'), new Date(2026, 7, 18).getTime() - 1);
});

// --- client: pagination and mode selection -----------------------------------

test('pagination stitches pages and follow-ups carry ONLY next_token', async () => {
  const requests = [];
  const pages = [
    { data: [{ id: 'a' }, { id: 'b' }], next_token: 'tok1' },
    { data: [{ id: 'c' }], next_token: null },
  ];
  let call = 0;
  const fetchImpl = async (url) => {
    requests.push(new URL(String(url)));
    return jsonRes(pages[call++]);
  };
  const client = createOuraClient({ sandbox: true, fetchImpl, log: fakeLog(), now: () => NOW });
  const records = await client.fetchCollection('daily_sleep', { start_date: D1, end_date: D2 });
  assert.deepEqual(records.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get('start_date'), D1);
  assert.equal(requests[0].searchParams.get('end_date'), D2);
  assert.equal(requests[0].searchParams.get('next_token'), null);
  // the second page sends the token and NOTHING else
  assert.deepEqual([...requests[1].searchParams.keys()], ['next_token']);
  assert.equal(requests[1].searchParams.get('next_token'), 'tok1');
});

test('fetchCollection refuses malformed collection names and dates', async () => {
  const client = createOuraClient({ sandbox: true, fetchImpl: async () => jsonRes({ data: [] }), log: fakeLog() });
  await assert.rejects(client.fetchCollection('daily sleep', { start_date: D1, end_date: D2 }), /collection name/);
  await assert.rejects(client.fetchCollection('daily_sleep', { start_date: '19/08/2026', end_date: D2 }), /YYYY-MM-DD/);
  await assert.rejects(client.fetchCollection('daily_sleep', { start_date: D1 }), /"end_date"/);
});

test('tokens file absent selects sandbox: placeholder auth, sandbox URL, mode logged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    const requests = [];
    const log = fakeLog();
    const client = createOuraClient({
      tokensPath: join(dir, 'does-not-exist.json'),
      fetchImpl: fixtureFetch({ daily_sleep: [{ id: 'x', day: D1 }] }, requests),
      log,
      now: () => NOW,
    });
    assert.equal(client.mode, 'sandbox');
    const records = await client.fetchCollection('daily_sleep', { start_date: D1, end_date: D2 });
    assert.equal(records.length, 1);
    assert.ok(requests[0].url.startsWith(OURA_SANDBOX_BASE), requests[0].url);
    // the placeholder, never a real token (there is none to leak here)
    assert.equal(requests[0].auth, OURA_SANDBOX_AUTH);
    assert.deepEqual(
      log.lines.filter((l) => l.event === 'oura_client_mode'),
      [{ level: 'info', event: 'oura_client_mode', mode: 'sandbox', reason: 'tokens-missing' }]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit sandbox config wins even when tokens exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    const { tokensPath } = makeSecrets(dir, FRESH_TOKENS());
    const requests = [];
    const log = fakeLog();
    const client = createOuraClient({
      sandbox: true,
      tokensPath,
      fetchImpl: fixtureFetch({ daily_sleep: [] }, requests),
      log,
      now: () => NOW,
    });
    await client.fetchCollection('daily_sleep', { start_date: D1, end_date: D2 });
    assert.ok(requests[0].url.startsWith(OURA_SANDBOX_BASE));
    // even with real tokens on disk, sandbox mode sends only the placeholder
    assert.equal(requests[0].auth, OURA_SANDBOX_AUTH);
    assert.equal(log.lines[0].reason, 'configured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- client: token manager ----------------------------------------------------

test('api mode with fresh tokens: Bearer header, real base, no refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    const paths = makeSecrets(dir, FRESH_TOKENS());
    const requests = [];
    const client = createOuraClient({
      ...paths,
      fetchImpl: fixtureFetch({ daily_sleep: [{ id: 'x', day: D1 }] }, requests),
      log: fakeLog(),
      now: () => NOW,
    });
    assert.equal(client.mode, 'api');
    await client.fetchCollection('daily_sleep', { start_date: D1, end_date: D2 });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.startsWith(OURA_API_BASE));
    assert.equal(requests[0].auth, 'Bearer old-access');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proactive refresh: rotation is persisted atomically BEFORE the new token is first used', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    const paths = makeSecrets(dir, STALE_TOKENS());
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      if (String(url) === OURA_TOKEN_URL) {
        calls.push({ kind: 'refresh', body: init.body, contentType: init.headers['Content-Type'] });
        return jsonRes({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 86_400 });
      }
      // Recorded AT the moment of the new token's first use: what is on
      // disk right now is exactly what a crash right now would leave.
      const onDisk = JSON.parse(readFileSync(paths.tokensPath, 'utf8'));
      calls.push({
        kind: 'get',
        auth: init.headers?.Authorization,
        persistedAccess: onDisk.access_token,
        persistedRefresh: onDisk.refresh_token,
        prevExists: existsSync(`${paths.tokensPath}.prev`),
      });
      return jsonRes({ data: [{ id: 'x', day: D1 }], next_token: null });
    };
    const client = createOuraClient({ ...paths, fetchImpl, log: fakeLog(), now: () => NOW });
    await client.fetchCollection('daily_sleep', { start_date: D1, end_date: D2 });

    assert.deepEqual(calls.map((c) => c.kind), ['refresh', 'get']);
    // the refresh spent the OLD single-use token, form-encoded, with creds
    const form = new URLSearchParams(calls[0].body);
    assert.equal(calls[0].contentType, 'application/x-www-form-urlencoded');
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'old-refresh');
    assert.equal(form.get('client_id'), 'cid-123');
    assert.equal(form.get('client_secret'), 'csecret-456');
    // order of operations: at first use the NEW pair was already on disk
    assert.equal(calls[1].auth, 'Bearer new-access');
    assert.equal(calls[1].persistedAccess, 'new-access');
    assert.equal(calls[1].persistedRefresh, 'new-refresh');
    assert.equal(calls[1].prevExists, true);
    // final state: main file holds the new pair, .prev the old one
    const main = JSON.parse(readFileSync(paths.tokensPath, 'utf8'));
    assert.equal(main.access_token, 'new-access');
    assert.equal(main.refresh_token, 'new-refresh');
    assert.equal(main.obtained_at, NOW);
    const prev = JSON.parse(readFileSync(`${paths.tokensPath}.prev`, 'utf8'));
    assert.equal(prev.access_token, 'old-access');
    assert.equal(prev.refresh_token, 'old-refresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a 401 triggers one reactive refresh and one retry, which succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    const paths = makeSecrets(dir, FRESH_TOKENS()); // not stale: proactive path stays quiet
    const kinds = [];
    const fetchImpl = async (url, init = {}) => {
      if (String(url) === OURA_TOKEN_URL) {
        kinds.push('refresh');
        return jsonRes({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 86_400 });
      }
      const auth = init.headers?.Authorization;
      kinds.push(`get:${auth}`);
      if (auth === 'Bearer old-access') return jsonRes({ error: 'unauthorized' }, 401);
      return jsonRes({ data: [{ id: 'x', day: D1 }], next_token: null });
    };
    const client = createOuraClient({ ...paths, fetchImpl, log: fakeLog(), now: () => NOW });
    const records = await client.fetchCollection('daily_sleep', { start_date: D1, end_date: D2 });
    assert.equal(records.length, 1);
    assert.deepEqual(kinds, ['get:Bearer old-access', 'refresh', 'get:Bearer new-access']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second 401 after the refresh throws .status 401 — never a retry loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    const paths = makeSecrets(dir, FRESH_TOKENS());
    let refreshes = 0;
    let gets = 0;
    const fetchImpl = async (url) => {
      if (String(url) === OURA_TOKEN_URL) {
        refreshes += 1;
        return jsonRes({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 86_400 });
      }
      gets += 1;
      return jsonRes({ error: 'unauthorized' }, 401);
    };
    const client = createOuraClient({ ...paths, fetchImpl, log: fakeLog(), now: () => NOW });
    await assert.rejects(client.fetchCollection('daily_sleep', { start_date: D1, end_date: D2 }), (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /oura-auth/);
      return true;
    });
    assert.equal(refreshes, 1);
    assert.equal(gets, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid_grant is terminal: .status set, message names oura-auth, tokens file untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    const paths = makeSecrets(dir, STALE_TOKENS());
    let refreshes = 0;
    const fetchImpl = async (url) => {
      if (String(url) === OURA_TOKEN_URL) {
        refreshes += 1;
        return jsonRes({ error: 'invalid_grant' }, 400);
      }
      throw new Error('no collection request should happen with a dead grant');
    };
    const client = createOuraClient({ ...paths, fetchImpl, log: fakeLog(), now: () => NOW });
    await assert.rejects(client.fetchCollection('daily_sleep', { start_date: D1, end_date: D2 }), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /invalid_grant/);
      assert.match(error.message, /oura-auth/);
      return true;
    });
    assert.equal(refreshes, 1); // one attempt, no loop
    const onDisk = JSON.parse(readFileSync(paths.tokensPath, 'utf8'));
    assert.equal(onDisk.access_token, 'old-access'); // nothing was overwritten
    assert.equal(existsSync(`${paths.tokensPath}.prev`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the refresh is single-flighted: concurrent stale callers share one rotation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    const paths = makeSecrets(dir, STALE_TOKENS());
    let refreshes = 0;
    const fetchImpl = async (url) => {
      if (String(url) === OURA_TOKEN_URL) {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 20)); // hold the window open
        return jsonRes({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 86_400 });
      }
      return jsonRes({ data: [{ id: 'x', day: D1 }], next_token: null });
    };
    const client = createOuraClient({ ...paths, fetchImpl, log: fakeLog(), now: () => NOW });
    const [a, b] = await Promise.all([
      client.fetchCollection('daily_sleep', { start_date: D1, end_date: D2 }),
      client.fetchCollection('daily_activity', { start_date: D1, end_date: D2 }),
    ]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(refreshes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- source: shape, needs, aggregation ----------------------------------------

test('the daemon accepts sources/oura.mjs and maps it into its roster', async () => {
  const sources = await loadSources();
  const oura = sources.find((s) => s.name === 'oura');
  assert.ok(oura, 'oura source not loaded');
  assert.equal(typeof oura.needs, 'function');
  assert.equal(typeof oura.run, 'function');
});

test('needs() names the missing token file and the OAuth helper; all-present is ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    const paths = makeSecrets(dir, FRESH_TOKENS());
    assert.deepEqual(await ouraSource.needs(paths), []);
    const missing = await ouraSource.needs({ ...paths, tokensPath: join(dir, 'absent.json') });
    assert.equal(missing.length, 1);
    assert.match(missing[0], /oura-auth/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('golden aggregation: a nap day folds two sleep periods into one row per metric', () => {
  const { rows, skippedWorkoutIds } = buildRows(fixtureCollections(), TODAY);
  assert.deepEqual(skippedWorkoutIds, []);
  const byId = new Map(rows.map((r) => [r.entity_id, r]));

  const sleep = byId.get(`health:sleep:${D1}`);
  assert.equal(sleep.text, 'Slept 8h 00m in 2 periods (score 85): 1h 25m deep, 1h 35m REM, 5h 00m light, 30m awake.');
  assert.equal(sleep.ts, endOfLocalDayMs(D1));
  assert.equal(sleep.source, 'health');
  // meta carries the raw records — daily_sleep with its Oura id and meta
  // fields, and the periods SORTED by bedtime_start (the fixture had the
  // nap first)
  assert.equal(sleep.meta.daily_sleep.id, 'ds-1');
  assert.equal(sleep.meta.daily_sleep.meta.version, 1);
  assert.deepEqual(sleep.meta.sleep_periods.map((p) => p.id), ['sp-1', 'sp-2']);

  const hrv = byId.get(`health:hrv:${D1}`);
  assert.equal(hrv.text, 'Average overnight HRV 48 ms across 2 sleep periods.'); // (52+44)/2
  assert.equal(hrv.ts, endOfLocalDayMs(D1));

  assert.equal(byId.get(`health:readiness:${D1}`).text, 'Readiness score 82; body temperature -0.2°C from baseline.');
  assert.equal(byId.get(`health:activity:${D1}`).text, 'Activity: 9432 steps, 512 active calories (score 78).');
  assert.equal(byId.get(`health:stress:${D1}`).text, 'Stress: normal (1h 05m high stress, 2h 10m recovery).');
  assert.deepEqual(byId.get(`health:stress:${D1}`).meta, { daily_stress: fixtureCollections().daily_stress[0] });

  // the single-period day
  assert.equal(byId.get(`health:sleep:${D2}`).text, 'Slept 7h 30m (score 90): 1h 30m deep, 1h 30m REM, 4h 30m light, 15m awake.');
  assert.equal(byId.get(`health:hrv:${D2}`).text, 'Average overnight HRV 61 ms.');

  // the workout: keyed and timestamped by its own start, verbatim
  const workout = byId.get(`health:workout:${D1}T07:00:00-07:00`);
  assert.equal(workout.text, 'Workout: running, 32m, 210 calories, moderate intensity.');
  assert.equal(workout.ts, Date.parse(`${D1}T07:00:00-07:00`));
  assert.equal(workout.meta.workout.id, 'w-1');

  assert.equal(rows.length, 8); // D1: 5 metrics + workout; D2: sleep + hrv
});

test('completed-day exclusion: today never becomes a row, day strings are trusted', () => {
  const { rows } = buildRows(fixtureCollections(), TODAY);
  assert.equal(rows.find((r) => r.entity_id === `health:activity:${TODAY}`), undefined);
  assert.ok(rows.every((r) => !r.entity_id.endsWith(`:${TODAY}`)));
  // boundary: a day equal to "today" is excluded even if the API served it
  const { rows: none } = buildRows({ daily_activity: [{ id: 'x', day: TODAY, steps: 1 }] }, TODAY);
  assert.deepEqual(none, []);
});

test('hrv averages only the periods that measured it', () => {
  const { rows } = buildRows(
    {
      sleep: [
        { id: 'p1', day: D1, bedtime_start: `${D1}T00:00:00-07:00`, total_sleep_duration: 3600, average_hrv: 50 },
        { id: 'p2', day: D1, bedtime_start: `${D1}T13:00:00-07:00`, total_sleep_duration: 1200, average_hrv: null },
      ],
    },
    TODAY
  );
  const hrv = rows.find((r) => r.entity_id === `health:hrv:${D1}`);
  assert.equal(hrv.text, 'Average overnight HRV 50 ms.'); // one measured period, no "across" clause
});

test('a workout without a parseable start is skipped and reported by id, never half-written', () => {
  const { rows, skippedWorkoutIds } = buildRows(
    { workout: [{ id: 'w-bad', day: D1, activity: 'rowing' }] },
    TODAY
  );
  assert.deepEqual(rows, []);
  assert.deepEqual(skippedWorkoutIds, ['w-bad']);
});

// --- source: run(ctx) ----------------------------------------------------------

test('run() polls the steady 7-day window ending yesterday and maps the counts', async () => {
  const { ctx, captured, requests } = makeCtx();
  const counts = await ouraSource.run(ctx);
  assert.deepEqual(counts, { ingested: 8, updated: 0, unchanged: 0, deleted: 0 });
  assert.equal(captured.length, 8);
  // six collections, one page each, all sandbox (config.oura.sandbox=true)
  assert.equal(requests.length, 6);
  for (const r of requests) {
    assert.ok(r.url.startsWith(OURA_SANDBOX_BASE), r.url);
    assert.equal(r.auth, OURA_SANDBOX_AUTH);
    assert.equal(r.params.start_date, shiftLocalDay(TODAY, -STEADY_WINDOW_DAYS));
    assert.equal(r.params.end_date, shiftLocalDay(TODAY, -1)); // never today
  }
  assert.equal(ctx.state.cursors['oura:last_polled_day'], shiftLocalDay(TODAY, -1));
});

test('run() with backfill widens to config.oura.backfillDays, defaulting to 90', async () => {
  const a = makeCtx({ config: { oura: { sandbox: true, backfillDays: 30 } }, backfill: true });
  await ouraSource.run(a.ctx);
  assert.equal(a.requests[0].params.start_date, shiftLocalDay(TODAY, -30));
  const b = makeCtx({ config: { oura: { sandbox: true } }, backfill: true });
  await ouraSource.run(b.ctx);
  assert.equal(b.requests[0].params.start_date, shiftLocalDay(TODAY, -DEFAULT_BACKFILL_DAYS));
});

test('run() refuses to ingest sandbox sample data nobody asked for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oura-test-'));
  try {
    // tokens absent + sandbox NOT configured: the client falls back to
    // sandbox, and the source must refuse rather than write sample data
    // into the corpus as real health rows.
    let ingested = false;
    const { ctx } = makeCtx({
      config: { oura: {} },
      tokensPath: join(dir, 'absent.json'),
      ingestImpl: async () => {
        ingested = true;
        return { inserted: 0, updated: 0, unchanged: 0 };
      },
    });
    await assert.rejects(ouraSource.run(ctx), /sample data/);
    assert.equal(ingested, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- e2e against the REAL hermes ------------------------------------------------

const TEST_LLAMA_KEY = 'a'.repeat(64);
const TEST_BEARER_TOKEN = 'c'.repeat(64);
let hermes;
let hermesDir;
let hermesOpts;

before(async () => {
  hermesDir = mkdtempSync(join(tmpdir(), 'oura-e2e-')); // mkdtemp dirs are 0700
  const tokenFile = join(hermesDir, 'hermes-token.txt');
  writeFileSync(tokenFile, `${TEST_BEARER_TOKEN}\n`, { mode: 0o600 });
  hermes = await start({
    port: 0,
    dbPath: join(hermesDir, 'context.db'),
    llamaApiKey: TEST_LLAMA_KEY,
    bearerToken: TEST_BEARER_TOKEN,
  });
  hermesOpts = { baseUrl: `http://127.0.0.1:${hermes.port}`, tokenFile, backoffMs: 1 };
});

after(async () => {
  await hermes?.close();
  if (hermesDir) rmSync(hermesDir, { recursive: true, force: true });
});

test('e2e: two identical runs against real hermes — the second is all-unchanged', async () => {
  const ingestImpl = (rows) => ingest(rows, hermesOpts);
  const first = makeCtx({ ingestImpl });
  assert.deepEqual(await ouraSource.run(first.ctx), { ingested: 8, updated: 0, unchanged: 0, deleted: 0 });
  const second = makeCtx({ ingestImpl });
  assert.deepEqual(await ouraSource.run(second.ctx), { ingested: 0, updated: 0, unchanged: 8, deleted: 0 });
  // and an Oura recomputation (same entity, new values) lands as an update
  const recomputed = fixtureCollections();
  recomputed.daily_activity[0].steps = 9500;
  const third = makeCtx({ ingestImpl, collections: recomputed });
  assert.deepEqual(await ouraSource.run(third.ctx), { ingested: 0, updated: 1, unchanged: 7, deleted: 0 });
});

// --- LIVE sandbox smoke ----------------------------------------------------------

test('LIVE: the real Oura sandbox serves daily_sleep with no credential (URL-shape check)',
  {
    skip: process.env.HZ_LIVE_SMOKE === '1'
      ? false
      : 'live Oura sandbox smoke — set HZ_LIVE_SMOKE=1',
  },
  async () => {
  // No credential, no personal data: the sandbox generates sample records
  // and accepts the placeholder header. This is the one test that touches
  // the network, and it exists to catch the real service disagreeing with
  // our URL shapes (base path, date params, header requirement, next_token)
  // before the owner's tokens ever do — it already caught one thing: the
  // sandbox 400s without an Authorization header, hence OURA_SANDBOX_AUTH.
  //
  // GATED, and the date window PINNED, as of 2026-08-22. It used to run
  // unconditionally on every `npm test` in connectors/, which made the whole
  // suite require the internet and made a CI failure indistinguishable from
  // Oura having a bad afternoon. Worse, the window was
  // `localDayString(new Date())` minus 30 days, so the request — and any
  // failure it produced — depended on today's date and the host timezone.
  // A fixed window asks the same question of the same endpoint every time,
  // which is the only way its answer means anything.
  const client = createOuraClient({ sandbox: true, log: fakeLog(), now: Date.now });
  const end = '2026-08-01';
  const startDate = shiftLocalDay(end, -30);
  const records = await client.fetchCollection('daily_sleep', { start_date: startDate, end_date: end });
  assert.ok(Array.isArray(records));
  assert.ok(records.length > 0, 'sandbox returned no daily_sleep records');
  assert.equal(typeof records[0].day, 'string');
});
