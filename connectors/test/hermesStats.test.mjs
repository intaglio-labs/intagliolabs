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

import {
  checkHermesHealth,
  checkHermesStats,
  HERMES_HEALTH_TIMEOUT_MS,
  HERMES_STATS_TIMEOUT_MS,
} from '../lib/checks.mjs';
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

// --- hermes-health: the same conflation, one probe wide -------------------
//
// The /stats downgrade above leans on hermes-health being the honest liveness
// check ("hermes is alive (see hermes-health)"). It was not: it probed once
// with a 4s ceiling and FAILed, and a FAIL here is fatal in daemon.mjs'
// preflight. Hermes is single-threaded, so its ~7.6s synchronous people-core
// warm 250ms after listen() blocks /health too -- a preflight landing in that
// window killed the daemon exactly as /stats did, over a server that was about
// to be fine.
//
// A blocked /health is therefore retried; a refused one is not.

// A stub whose /health never answers for the first `blockFirst` requests and
// answers exactly like hermes after that. Holding the response open (rather
// than delaying it) is the real shape: the socket is accepted, the process is
// busy, nothing comes back.
async function stubHealth({ blockFirst = 0, body = '{"ok":true}' } = {}) {
  let seen = 0;
  const held = new Set();
  const srv = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end();
      return;
    }
    seen += 1;
    if (seen <= blockFirst) {
      held.add(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    port,
    env: { HAZLIE_HERMES_URL: `http://127.0.0.1:${port}` },
    get seen() { return seen; },
    async stop() {
      for (const res of held) res.destroy();
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(r));
    },
  };
}

// Real timeouts, toy sleeps: the backoff is counted, not waited for, so the
// test proves the loop rather than the clock.
function health(h, { timeoutMs = 120, backoffMs = [1, 1, 1] } = {}) {
  const slept = [];
  const run = checkHermesHealth(h.env, {}, {
    timeoutMs,
    backoffMs,
    sleep: async (ms) => { slept.push(ms); },
  });
  return { run, slept };
}

test('a hermes that is warming, not dead, is retried and PASSes', async () => {
  // THE 2026-09-12 SHAPE. The first two probes land inside the synchronous
  // warm and get nothing; the third lands after it. One probe called this a
  // dead hermes and exited the daemon.
  const h = await stubHealth({ blockFirst: 2 });
  try {
    const { run, slept } = health(h);
    const r = await run;
    assert.equal(r.status, 'PASS', 'a hermes that answered on the third probe is alive');
    assert.match(r.detail, /attempts: 3/u, 'and the PASS must say it took three');
    assert.equal(h.seen, 3, 'exactly three probes — no more than the answer needed');
    assert.deepEqual(slept, [1, 1], 'and it backed off between them');
  } finally {
    await h.stop();
  }
});

test('nothing listening is still an immediate FAIL — retrying cannot conjure a process', async () => {
  const h = await stubHealth();
  await h.stop();
  const started = Date.now();
  const { run, slept } = health(h, { backoffMs: [5000, 5000, 5000] });
  const r = await run;
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /ECONNREFUSED/u);
  assert.deepEqual(slept, [], 'a refused connection must not sleep through the backoff');
  assert.ok(Date.now() - started < 2000, 'and must not wait out the retry budget');
});

test('a hermes that never answers is still the FAIL, after the whole budget', async () => {
  const h = await stubHealth({ blockFirst: Infinity });
  try {
    const { run, slept } = health(h);
    const r = await run;
    assert.equal(r.status, 'FAIL', 'thirty seconds of silence is a wedged hermes');
    assert.match(r.detail, /did not answer within 120ms/u);
    assert.match(r.detail, /4 attempts/u, 'and the detail must say how hard it tried');
    assert.equal(h.seen, 4, 'four probes, not one and not forever');
    assert.deepEqual(slept, [1, 1, 1]);
  } finally {
    await h.stop();
  }
});

test('a squatter on the port is not retried — its answer will not change', async () => {
  // The identity gate is what stops household rows being POSTed at another
  // process. Retrying a deterministic wrong answer only delays the verdict.
  const h = await stubHealth({ body: '{"ok":true,"service":"vite"}' });
  try {
    const { run, slept } = health(h);
    const r = await run;
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /non-Hermes body/u);
    assert.equal(h.seen, 1, 'one probe is enough for an answer that is already final');
    assert.deepEqual(slept, []);
  } finally {
    await h.stop();
  }
});

test('the retry budget spans the synchronous warm it exists for', () => {
  // ~7.6s of straight-line work starting 250ms after listen(). A budget that
  // did not outlast it would be the same bug with more steps.
  assert.equal(HERMES_HEALTH_TIMEOUT_MS, 4000);
});
