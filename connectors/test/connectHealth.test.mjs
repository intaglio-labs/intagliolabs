// connect-health — the probe that would have named the 2026-08-23 outage.
//
// The scenario these tests encode really happened: the canonical ports moved,
// the installed launch agent was a copy rendered before the move, connect kept
// answering on the old port, and the widget drew "connect service unreachable"
// on every tile while `doctor` reported a clean bill of health because nothing
// in it looked at connect at all. The first test below is that exact machine
// state; the rest fence the ways a probe like this can lie.

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkConnectHealth } from '../lib/checks.mjs';

// A fetch that answers one status and records how it was called.
const answering = (status, seen = {}) => async (url, opts) => {
  seen.url = url;
  seen.opts = opts;
  return new Response(status === 401 ? '{"error":"unauthorized"}' : '', { status });
};

const refusing = async () => {
  throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
};

test('401 to an unauthenticated probe is the pass', async () => {
  const r = await checkConnectHealth({}, { fetchImpl: answering(401) });
  assert.equal(r.status, 'PASS');
  assert.match(r.detail, /51788/u);
});

test('the probe carries no bearer — a doctor must not spend the token to find a port', async () => {
  const seen = {};
  await checkConnectHealth({}, { fetchImpl: answering(401, seen) });
  assert.equal(seen.url, 'http://127.0.0.1:51788/api/status');
  const headers = new Headers(seen.opts?.headers ?? {});
  assert.equal(headers.get('authorization'), null);
});

test('a refused connection fails and points at the stale launch agent', async () => {
  const r = await checkConnectHealth({}, { fetchImpl: refusing });
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /ECONNREFUSED/u);
  // The detail has to connect the dead port to the thing the owner actually
  // saw, or the check is one more line of output nobody joins to the symptom.
  assert.match(r.detail, /status unknown/u);
  assert.match(r.fix, /setup-connectors\.sh/u);
  // The @REPO@ hazard is the reason this fix line is long. Losing it turns a
  // repair into a production repoint at a branchable tree.
  assert.match(r.fix, /@REPO@/u);
});

test('200 without a bearer is a failure, not a pass — an open route is worse than a dead one', async () => {
  const r = await checkConnectHealth({}, { fetchImpl: answering(200) });
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /not authenticating/u);
});

test('404 names both explanations, not just the flattering one', async () => {
  const r = await checkConnectHealth({}, { fetchImpl: answering(404) });
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /older than the route/u);
  assert.match(r.detail, /another process holds the port/u);
});

test('a redirect is refused, so a squatter cannot borrow another host’s status code', async () => {
  const seen = {};
  await checkConnectHealth({}, { fetchImpl: answering(401, seen) });
  assert.equal(seen.opts?.redirect, 'error');
});

test('HAZLIE_CONNECT_PORT retargets the probe, matching the widget’s own override', async () => {
  const seen = {};
  const r = await checkConnectHealth({ HAZLIE_CONNECT_PORT: '8790' }, { fetchImpl: answering(401, seen) });
  assert.equal(seen.url, 'http://127.0.0.1:8790/api/status');
  assert.equal(r.status, 'PASS');
});

test('an off-box override is refused before any request is made', async () => {
  let called = false;
  const r = await checkConnectHealth(
    { HAZLIE_CONNECT_PORT: '99999' },
    { fetchImpl: async () => { called = true; return new Response('', { status: 401 }); } }
  );
  assert.equal(r.status, 'FAIL');
  assert.equal(called, false);
});
