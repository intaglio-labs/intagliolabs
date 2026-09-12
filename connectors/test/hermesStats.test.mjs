// hermes-stats — the probe that stopped the house's ingestion on 2026-09-12.
//
// The machine state these tests encode really happened. Hermes was alive and
// answering /health in 1-18ms, but GET /stats -- which walked every person in
// the house twice, once for sweepStatus and once for lookupStatus -- took
// 15.9s, 9.1s, 6.1s and 1.0s on four consecutive calls while the people core
// warmed after an install. This check gave it 4s, FAILed on the timeout,
// daemon.mjs' partitionChecks treats every non-`fda-*` FAIL as fatal, and the
// daemon exited. Nothing restarted it; ingestion stopped until somebody did it
// by hand.
//
// So the first test below is that exact state -- a server answering /health
// instantly while /stats stalls past the budget -- and the rest fence the ways
// the downgrade could be made too generous. A slow diagnostic route is a WARN;
// a port that is not hermes is still a FAIL.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkHermesStats, HERMES_STATS_TIMEOUT_MS } from '../lib/checks.mjs';
import { partitionChecks } from '../daemon.mjs';

const TOKEN = 'a'.repeat(64);

// A stub hermes: /health is instant and exact, /stats answers however the test
// asks it to. Returns the env checkHermesStats reads, so no test touches the
// real ~/.hazlie.
async function stubHermes({ statsDelayMs = 0, statsStatus = 200, statsBody = '{"rows":42}' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-stats-check-'));
  const tokenPath = join(dir, 'hermes-token.txt');
  writeFileSync(tokenPath, `${TOKEN}\n`);
  chmodSync(tokenPath, 0o600);

  const timers = new Set();
  const srv = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/stats') {
      const answer = () => {
        res.writeHead(statsStatus, { 'Content-Type': 'application/json' });
        res.end(statsBody);
      };
      if (statsDelayMs > 0) timers.add(setTimeout(answer, statsDelayMs));
      else answer();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    port,
    env: { HAZLIE_HERMES_URL: `http://127.0.0.1:${port}`, HERMES_TOKEN_FILE: tokenPath },
    // Closing the listener and discarding the token file are separate steps on
    // purpose: the unreachable-port test needs a dead port and a VALID bearer
    // on disk, or it proves the token check rather than the connection.
    async closeServer() {
      for (const t of timers) clearTimeout(t);
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(r));
    },
    async stop() {
      await this.closeServer();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const run = (h, opts) => checkHermesStats(h.env, join(tmpdir(), 'no-such-home'), {}, opts);

test('a /stats slower than the budget is a WARN — hermes is alive, its diagnostic route is slow', async () => {
  const h = await stubHermes({ statsDelayMs: 1500 });
  try {
    // The precondition that makes this a WARN and not a FAIL: the same process
    // answers /health immediately, which is what hermes-health checks and what
    // it did throughout the real incident.
    const started = Date.now();
    const health = await fetch(`http://127.0.0.1:${h.port}/health`);
    assert.equal(await health.text(), '{"ok":true}');
    assert.ok(Date.now() - started < 500, 'precondition: hermes answers /health at once');

    const r = await run(h, { timeoutMs: 150 });
    assert.equal(r.status, 'WARN', 'a slow /stats must not be the FAIL that killed the daemon');
    assert.match(r.detail, /did not answer within 150ms/u);
    // The fix has to send the reader to the check that DOES speak to liveness,
    // or the WARN is one more line nobody can act on.
    assert.match(r.fix, /hermes-health/u);
    assert.match(r.fix, /computedAt/u);
  } finally {
    await h.stop();
  }
});

test('and that WARN is not fatal, so the daemon keeps ingesting', async () => {
  const h = await stubHermes({ statsDelayMs: 1500 });
  try {
    const r = await run(h, { timeoutMs: 150 });
    // partitionChecks needs no per-check severity: it already filters on FAIL.
    const { fatal, fdaBlocked } = partitionChecks([r, { name: 'hermes-health', status: 'PASS' }]);
    assert.deepEqual(fatal, [], 'a WARN must never reach the fatal list');
    assert.equal(fdaBlocked.size, 0);
  } finally {
    await h.stop();
  }
});

test('a /stats that answers in time is still the PASS', async () => {
  const h = await stubHermes();
  try {
    const r = await run(h, { timeoutMs: 2000 });
    assert.equal(r.status, 'PASS');
    assert.match(r.detail, /42 context rows/u);
  } finally {
    await h.stop();
  }
});

test('an unreachable port is still a FAIL — nothing there is not the same as slow', async () => {
  const h = await stubHermes();
  await h.closeServer();
  try {
    const r = await run(h, { timeoutMs: 2000 });
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /ECONNREFUSED/u);
    assert.match(r.fix, /hermes-health/u);
  } finally {
    await h.stop();
  }
});

test('a 200 carrying somebody else’s body is still a FAIL', async () => {
  const h = await stubHermes({ statsBody: '{"ok":true}' });
  try {
    const r = await run(h, { timeoutMs: 2000 });
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /unexpected shape/u);
  } finally {
    await h.stop();
  }
});

test('a 401 is still a FAIL, and still names the token mismatch', async () => {
  const h = await stubHermes({ statsStatus: 401, statsBody: '{"error":"unauthorized"}' });
  try {
    const r = await run(h, { timeoutMs: 2000 });
    assert.equal(r.status, 'FAIL');
    assert.match(r.fix, /setup-llm\.sh/u);
  } finally {
    await h.stop();
  }
});

test('the production budget is 10s, not the 4s that timed out under load', () => {
  assert.equal(HERMES_STATS_TIMEOUT_MS, 10_000);
});
