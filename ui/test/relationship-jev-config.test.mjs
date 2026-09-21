// The judgment engine's settings: written under relationshipMemory.jev by a
// bearer-only closed-field route, validated by owner.mjs, read back by
// GET /admin/config/card as a status block, and -- the regression this file
// exists for -- still accepted by the connectors daemon's validateConfig, which
// kills the daemon on an unknown TOP-LEVEL key (connectors/AGENTS.md). Every
// test here fails against a tree without the route (404) or the status block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/hermes.mjs';
import { validateConfig } from '../../connectors/daemon.mjs';
import { setRelationshipJev, validateRelationshipJev, JEV_FIELDS } from '../server/people/owner.mjs';

const TOKEN = 'f'.repeat(64);

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'jev-config-home-'));
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true });
  mkdirSync(join(home, '.hazlie', 'secrets'), { recursive: true, mode: 0o700 });
  await fn(home);
}
const configPath = (home) => join(home, '.hazlie', 'connectors', 'config.json');
const readConfig = (home) => JSON.parse(readFileSync(configPath(home), 'utf8'));

async function withServer(home, fn, opts = {}) {
  // The database lives where an install keeps it, because the judgment
  // engine's key is resolved from the database's own install home.
  mkdirSync(join(home, '.hazlie', 'context'), { recursive: true, mode: 0o700 });
  chmodSync(join(home, '.hazlie', 'context'), 0o700);
  const server = await start({
    port: 0, dbPath: join(home, '.hazlie', 'context', 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    peopleProjectionAutoRebuild: false, ownerConfigPath: configPath(home), ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body, headers = {}) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try { await fn({ call, db: server.db }); } finally { await server.close(); }
}

test('the settings route writes under relationshipMemory, preserves siblings, and the daemon still accepts the file', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({ selfName: 'Owner', relationshipMemory: { capPerDay: 1, producer: 'eligibility' } }));
    await withServer(home, async ({ call }) => {
      const res = await call('POST', '/admin/config/jev', { dailyTokenBudget: 1_000_000, judgments: { distill: false } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.state, 'ok');
      assert.equal(body.changed, true);
      assert.deepEqual(body.jev, { dailyTokenBudget: 1_000_000, judgments: { distill: false } });
      // A second write merges judgments rather than replacing the object.
      const again = await (await call('POST', '/admin/config/jev', { judgments: { sweep: false } })).json();
      assert.deepEqual(again.jev.judgments, { distill: false, sweep: false });
      // The same write again is not a write.
      const same = await (await call('POST', '/admin/config/jev', { judgments: { sweep: false } })).json();
      assert.equal(same.changed, false);
    });
    const written = readConfig(home);
    assert.equal(written.selfName, 'Owner');
    assert.equal(written.relationshipMemory.capPerDay, 1, 'the cap survives');
    assert.equal(written.relationshipMemory.producer, 'eligibility');
    assert.deepEqual(written.relationshipMemory.jev, { dailyTokenBudget: 1_000_000, judgments: { distill: false, sweep: false } });
    assert.doesNotThrow(() => validateConfig(written), 'the connectors daemon must start with this file');
  });
});

test('unknown fields, wrong types and the browser channel are refused and write nothing', async () => {
  await withHome(async (home) => {
    await withServer(home, async ({ call }) => {
      assert.equal((await call('POST', '/admin/config/jev', { keyPath: '/somewhere/else' })).status, 400, 'keyPath is not settable over HTTP');
      assert.equal((await call('POST', '/admin/config/jev', { model: 'gpt-4' })).status, 400);
      assert.equal((await call('POST', '/admin/config/jev', { dailyTokenBudget: -1 })).status, 400);
      assert.equal((await call('POST', '/admin/config/jev', { judgments: { bogus: true } })).status, 400);
      assert.equal((await call('POST', '/admin/config/jev', { enabled: 'yes' })).status, 400);
      assert.equal((await call('POST', '/admin/config/jev', [1, 2])).status, 400);
      const form = await fetch(`http://127.0.0.1:${new URL(await (await call('GET', '/health')).url).port}/admin/config/jev`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' }, body: '{}',
      });
      assert.equal(form.status, 415);
    });
    assert.throws(() => readFileSync(configPath(home)), 'nothing was written');
  });
});

test('the validator is the single closed set the route uses', () => {
  assert.deepEqual([...JEV_FIELDS], ['enabled', 'model', 'timeoutMs', 'maxRetries', 'dailyTokenBudget', 'judgments']);
  assert.throws(() => validateRelationshipJev({ timeoutMs: 10 }), /timeoutMs/u);
  assert.throws(() => validateRelationshipJev({ maxRetries: 9 }), /maxRetries/u);
  assert.doesNotThrow(() => validateRelationshipJev({ enabled: false, model: 'jev-1.13.0', timeoutMs: 8000, maxRetries: 3, dailyTokenBudget: 0, judgments: { quote: true } }));
  const dir = mkdtempSync(join(tmpdir(), 'jev-setter-'));
  const path = join(dir, 'config.json');
  const first = setRelationshipJev({ enabled: false, configPath: path });
  assert.deepEqual(first, { jev: { enabled: false }, changed: true });
  assert.deepEqual(setRelationshipJev({ enabled: false, configPath: path }), { jev: { enabled: false }, changed: false });
});

test('GET /admin/config/card reports the judgment engine as unconfigured with no key, and as ok with one', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({ relationshipMemory: { capPerDay: 1 } }));
    await withServer(home, async ({ call }) => {
      const out = await (await call('GET', '/admin/config/card')).json();
      assert.deepEqual(out.jev, { state: 'unconfigured', enabled: false, callsToday: 0, inputTokensToday: 0, costUsdToday: 0 });
    });
    // A key placed under the install's own secrets dir flips the state, with
    // no restart and no call made.
    writeFileSync(join(home, '.hazlie', 'secrets', 'typesafe-api-key.txt'), 'apikey_test_' + 'b'.repeat(40) + '\n', { mode: 0o600 });
    await withServer(home, async ({ call }) => {
      const out = await (await call('GET', '/admin/config/card')).json();
      assert.equal(out.jev.state, 'ok');
      assert.equal(out.jev.enabled, true);
      assert.equal(out.jev.callsToday, 0);
    });
    // And `enabled:false` in config is the one way to switch it off with a key present.
    setRelationshipJev({ enabled: false, configPath: configPath(home) });
    await withServer(home, async ({ call }) => {
      const out = await (await call('GET', '/admin/config/card')).json();
      assert.equal(out.jev.state, 'unconfigured');
    });
  });
});
