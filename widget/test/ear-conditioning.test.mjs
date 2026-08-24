// The signal-conditioning stage in front of the recognizer.
//
// Web Audio does not exist in node, so what is testable here is the CONTRACT —
// and the contract is the part that broke twice while writing it. Both failures
// were silent: one made the filter a no-op that looked installed, the other would
// have handed the recognizer an undefined stream. Neither throws where anyone
// would see it, because the whole function is wrapped in a fall back to raw audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { conditioned } from '../voice/lib/ear.js';

test('every path returns the same shape', () => {
  // node has no AudioContext, so this exercises the guard.
  const raw = { id: 'raw' };
  const out = conditioned(raw);
  assert.deepEqual(Object.keys(out).sort(), ['ctx', 'stream']);
  assert.equal(out.stream, raw, 'without Web Audio the recognizer still gets audio');
  assert.equal(out.ctx, null, 'and there is no context for stop() to leak');
});

test('a stream always comes back, whatever is thrown at it', () => {
  // The recognizer takes a MediaStream and nothing else. Returning undefined from
  // here deafens the ear, and the failure surfaces nowhere near this function.
  for (const input of [null, undefined, {}, 'not a stream', 0]) {
    const out = conditioned(input);
    assert.equal(out.stream, input, `fell through for ${JSON.stringify(input)}`);
    assert.equal(out.ctx, null);
  }
});

test('the context is returned, never captured', () => {
  // It was assigned to a closure variable this function cannot reach — a
  // ReferenceError that the catch swallowed, so the filter silently never applied
  // while every other sign said it had. Returning it is what makes that impossible.
  const src = conditioned.toString();
  assert.ok(!/\bshaper\s*=/u.test(src), 'conditioned() must not assign the caller state');
  assert.ok(/return \{ stream/u.test(src), 'it hands the context back instead');
});
