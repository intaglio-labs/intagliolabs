// The Notion client's 429 path, which had no test and no ceiling.
//
// It used to `return request(...)` recursively with no attempt count, so a
// workspace that stayed rate-limited retried at roughly one request per second
// forever. The source never returned, so its timer never rescheduled, so the
// notion connector stopped for good — while looking busy rather than broken.
// An unbounded retry inside a resident poller is a hang with a progress
// indicator.
//
// Giving up is safe here in a way it would not be for a write: the cursor is
// unchanged, so the only cost of failing now is one skipped cycle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotionClient, MAX_RATE_LIMIT_RETRIES } from '../lib/notionClient.mjs';

// The client reads its key through the secrets gauntlet, so the fixture has to
// satisfy it: an 0600 file inside an 0700 directory.
const dirs = [];
function keyFile() {
  const dir = mkdtempSync(join(tmpdir(), 'hz-notion-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const p = join(dir, 'notion-api-key.txt');
  writeFileSync(p, 'secret_abcdefghijklmnop\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const rateLimited = () =>
  new Response('{}', { status: 429, headers: { 'retry-after': '0' } });

test('a persistent 429 gives up after the ceiling instead of retrying forever', async () => {
  let calls = 0;
  const client = createNotionClient({
    keyPath: keyFile(),
    fetchImpl: async () => {
      calls += 1;
      return rateLimited();
    },
    sleepImpl: async () => {},
    minIntervalMs: 0,
  });
  await assert.rejects(() => client.search({}), /still rate limited/u);
  assert.equal(
    calls,
    MAX_RATE_LIMIT_RETRIES + 1,
    'one initial attempt plus the retries, then it stops'
  );
});

test('a 429 that clears is retried and succeeds', async () => {
  // The ceiling must not have turned a transient rate-limit into a failure.
  let calls = 0;
  const client = createNotionClient({
    keyPath: keyFile(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return rateLimited();
      return new Response(JSON.stringify({ results: [], has_more: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    sleepImpl: async () => {},
    minIntervalMs: 0,
  });
  const out = await client.search({});
  assert.equal(calls, 2);
  assert.deepEqual(out.results, []);
});

test('the rate-limit error carries a status and code the caller can act on', async () => {
  const client = createNotionClient({
    keyPath: keyFile(),
    fetchImpl: async () => rateLimited(),
    sleepImpl: async () => {},
    minIntervalMs: 0,
  });
  try {
    await client.search({});
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'rate_limited');
  }
});
