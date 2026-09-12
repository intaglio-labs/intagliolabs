// ONBOARDING'S LAST TWO SERVER SURFACES: the engine opt-in, and the live
// first-load table.
//
// Both are counts-only routes behind the bearer, and both exist because the
// screens above them were about to lie. The engine switch decides whether
// message excerpts leave this Mac, so the value it writes has to survive the
// connectors daemon's own config validator or the next daemon start dies on
// it. The progress table says "connected, nobody found yet" in amber, and the
// first version of that arithmetic would have said it about LinkedIn on the
// most common input there is.
//
// Real server, real SQLite, heterogeneous fixture — the style of
// relationship-routes.test.mjs. HOME is redirected to a tmpdir so the config
// write and the state.db read land inside the test rather than on the
// machine's own files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { start } from '../server/hermes.mjs';
import { validateConfig } from '../../connectors/daemon.mjs';

const TOKEN = 'f'.repeat(64);

// state.db, as connectors/lib/state.mjs creates it. Only the two tables the
// progress route reads; a fixture that mirrored the whole schema would rot
// against the real one without ever testing more.
const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS contact_ids(
  identifier   TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL,
  person_ref   TEXT,
  source       TEXT NOT NULL DEFAULT 'contacts',
  updated_ts   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_log(
  id          INTEGER PRIMARY KEY,
  connector   TEXT NOT NULL,
  started_ts  INTEGER NOT NULL,
  finished_ts INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  ingested    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  unchanged   INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
`;

// A test home, so the config write and the state.db read cannot touch the
// machine's own. os.homedir() reads $HOME on POSIX, which is what every path
// under test resolves through.
// AWAITED, not returned. The first version of this helper returned fn(home)
// from inside a try/finally, so `finally` restored $HOME the instant the
// promise was created and every path under test resolved against the real
// home while the assertions ran against the tmp one.
async function withHome(fn, serverOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'onboarding-home-'));
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    await fn(home, serverOpts);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

async function withServer(home, fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onboarding-db-'));
  const server = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: 'd'.repeat(64),
    bearerToken: TOKEN,
    ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await fn({ call, db: server.db, base, home });
  } finally {
    await server.close();
  }
}

const configPath = (home) => join(home, '.hazlie', 'connectors', 'config.json');
const readConfig = (home) => JSON.parse(readFileSync(configPath(home), 'utf8'));

// ---------------------------------------------------------------- the opt-in

test('turning the engine on writes a config the connectors daemon still accepts', async () => {
  await withHome(async (home) => {
    // An existing config with an unrelated key and an unrelated
    // relationshipMemory setting: the write must preserve both. A cap the
    // owner set is what gates the daily card at all, so losing it here would
    // switch the whole feature off as a side effect of opting in.
    writeFileSync(configPath(home), JSON.stringify({
      selfName: 'Owner',
      relationshipMemory: { capPerDay: 3, mode: 'any' },
    }, null, 2));

    await withServer(home, async ({ call }) => {
      const res = await call('POST', '/admin/config/engine', { engine: 'claude-cli' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { state: 'ok', engine: 'claude-cli', changed: true });
    });

    const written = readConfig(home);
    assert.equal(written.relationshipMemory.engine, 'claude-cli');
    assert.equal(written.relationshipMemory.capPerDay, 3, 'the cap survives the write');
    assert.equal(written.relationshipMemory.mode, 'any');
    assert.equal(written.selfName, 'Owner', 'an unrelated top-level key survives');

    // THE REGRESSION THIS BLOCK EXISTS FOR. An unknown config key does not
    // make the daemon complain; it makes the daemon refuse to start, and the
    // symptom is every source reading zero rows with an opaque log line.
    // relationshipMemory is in TOP_KEYS and validateConfig does not descend
    // into it — assert that rather than trusting it.
    assert.doesNotThrow(() => validateConfig(written));
  });
});

test('turning it off deletes the key rather than writing an off value', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({
      relationshipMemory: { capPerDay: 3, engine: 'claude-cli' },
    }, null, 2));
    await withServer(home, async ({ call }) => {
      const res = await call('POST', '/admin/config/engine', { engine: 'local' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).engine, 'local');
    });
    const written = readConfig(home);
    // ABSENT, not 'llama' and not 'local'. engines.mjs reads an absent key as
    // the loopback engine; any string here would be a fourth state nothing
    // consumes, and the next reader would have to guess which strings mean off.
    assert.ok(!('engine' in written.relationshipMemory), 'the key is gone');
    assert.equal(written.relationshipMemory.capPerDay, 3);
    assert.doesNotThrow(() => validateConfig(written));
  });
});

test('opting out with nothing to opt out of writes no file at all', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    const before = readFileSync(configPath(home), 'utf8');
    await withServer(home, async ({ call }) => {
      const res = await call('POST', '/admin/config/engine', { engine: 'local' });
      assert.deepEqual(await res.json(), { state: 'ok', engine: 'local', changed: false });
    });
    // An empty relationshipMemory object left behind by a "turn it off" press
    // reads, to the next person, like a setting somebody configured.
    assert.equal(readFileSync(configPath(home), 'utf8'), before);
  });
});

test('any engine name but the two is a 400 and writes nothing', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    await withServer(home, async ({ call }) => {
      for (const engine of ['gpt', 'llama', '', null]) {
        const res = await call('POST', '/admin/config/engine', { engine });
        assert.equal(res.status, 400, `"${engine}" must be refused`);
      }
      // A closed field list, like every other admin POST: a body that also
      // carries capPerDay must not smuggle it through this route.
      const extra = await call('POST', '/admin/config/engine', { engine: 'local', capPerDay: 99 });
      assert.equal(extra.status, 400);
    });
    assert.deepEqual(readConfig(home), { selfName: 'Owner' }, 'nothing was written');
  });
});

// A page cannot flip the privacy switch, whether or not its origin is one the
// server has been told to talk to. The two refusals differ on purpose and the
// distinction is worth pinning: an UNKNOWN origin never authenticates at all
// (401), while an ALLOWED one authenticates as the browser channel and is then
// refused the capability (403). A future edit that widened admin to the
// browser channel would only be caught by the second case.
const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';

test('the engine route refuses the browser channel in both of its shapes', async () => {
  await withHome(async (home, serverOpts) => {
    writeFileSync(configPath(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    await withServer(home, async ({ base }) => {
      const ask = (origin) => fetch(`${base}/admin/config/engine`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          Origin: origin,
        },
        body: JSON.stringify({ engine: 'claude-cli' }),
      });
      assert.equal((await ask('https://example.test')).status, 401,
        'an unknown origin does not authenticate, bearer header or not');
      const allowed = await ask(ALLOWED_ORIGIN);
      assert.equal(allowed.status, 403,
        'an allowed origin authenticates as a browser and is refused the capability');
    }, serverOpts);
    assert.deepEqual(readConfig(home), { selfName: 'Owner' }, 'neither attempt wrote anything');
  }, { allowedOrigins: ALLOWED_ORIGIN });
});
