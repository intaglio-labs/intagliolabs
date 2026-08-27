// What the owner is told when the local model is not running.
//
// Not a hypothetical state: widget/build.sh kickstarts llama-server on every
// deploy, and it takes ~3s to load its weights. A question asked in that window
// used to come back as `500 {"error":"fetch failed"}`, which the widget renders
// as "something went wrong on this app's side" -- the app-bug string, for a
// condition that is neither a bug nor permanent.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isUnreachable,
  unreachableError,
  LLAMA_UNREACHABLE_STATUS,
} from '../server/llamaReady.mjs';

test('a refused connection is recognised however undici wrapped it', () => {
  // What node actually throws: a TypeError with the real reason on `cause`.
  assert.ok(isUnreachable(Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:51780'), { code: 'ECONNREFUSED' }),
  })));
  assert.ok(isUnreachable(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
  assert.ok(isUnreachable(new TypeError('fetch failed')), 'the bare message is the fallback');
});

// The narrowness is the point. If a timeout or a cancel were mistaken for "the
// model is down", the owner would be told to wait for something that is already
// running, and a real fault would be reported as a restart.
test('a timeout, an abort and an HTTP error are NOT "not running"', () => {
  assert.equal(isUnreachable(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' })), false);
  assert.equal(isUnreachable(new DOMException('signal timed out', 'TimeoutError')), false);
  assert.equal(isUnreachable(new Error('llama-server returned 500')), false);
  assert.equal(isUnreachable(new Error('unexpected redirect')), false);
  assert.equal(isUnreachable(null), false);
  assert.equal(isUnreachable(undefined), false);
});

// 503 is the contract between hermes and the widget: Bridge maps 502 and 503 to
// the "down" state, which is the only state whose copy says the model is
// restarting. Changing this number silently reverts the fix.
test('the status is the one the widget maps to "down"', () => {
  assert.equal(LLAMA_UNREACHABLE_STATUS, 503);
  const err = unreachableError();
  assert.equal(err.status, 503);
  assert.match(err.message, /llama-server is unreachable/);
});
