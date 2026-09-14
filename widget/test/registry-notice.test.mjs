// THE ONE LINE ABOVE THE SHELF, AND THE COLOUR IT IS DRAWN IN.
//
// Run, not read, like connector-visibility: the choice of notice is a pure
// decision over a status payload, and the two bugs it carried are exactly the
// kind a source scan cannot see.
//
//   * The alarm colour was set on the registry path and cleared only on the
//     "everything is fine" path. Repair a broken registry and then take connect
//     down, and "checking connector status…" — a routine, transient line —
//     rendered in --status-bad, because the element kept the colour the outage
//     left on it.
//   * A registry repaired under a running daemon clears this page's answer
//     while the daemon is still holding ALL_OFF and scheduling nothing. The
//     shelf then went quiet about a machine that is ingesting nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const connectionsJs = readFileSync(join(UI, 'connections.js'), 'utf8');

function block(source, start, end, what) {
  const at = source.indexOf(start);
  assert.ok(at > 0, `could not find ${what} — has it been renamed?`);
  const close = source.indexOf(`\n${end}`, at);
  assert.ok(close > at, `could not find the end of ${what}`);
  return source.slice(at, close + end.length + 1);
}

const context = createContext({});
runInContext([
  block(connectionsJs, 'const NOTICES = {', '};', 'NOTICES'),
  block(connectionsJs, 'function noticeFor(data) {', '}', 'noticeFor'),
  'this.pick = (data) => noticeFor(data);',
  'this.notices = NOTICES;',
].join('\n'), context);

test('a healthy payload says nothing at all', () => {
  assert.equal(context.pick({ state: 'ok', registryState: 'ok', daemonRegistryState: 'ok' }), null);
  assert.equal(context.pick({ state: 'ok' }), null, 'an older connect sends neither field');
});

test('an unreadable registry is the alarm, and it says what to do twice over', () => {
  const chosen = context.pick({ state: 'ok', registryState: 'invalid' });
  assert.equal(chosen.alarm, true);
  assert.match(chosen.text, /reinstall/u);
  // THE SECOND HALF. The daemon caches the registry at module scope, so putting
  // the file back is not the end of it — the process holding ALL_OFF has to go
  // round again or nothing is scheduled after the repair.
  assert.match(chosen.text, /restart the app/u);
  assert.equal(context.pick({ state: 'ok', registryState: 'missing' }).alarm, true);
});

// THE DISCRIMINATING CASE. This page can read the registry; the daemon that is
// actually doing the ingesting cannot, and will not until it restarts.
test('a daemon still on the old registry is its own sentence', () => {
  const chosen = context.pick({ state: 'ok', registryState: 'ok', daemonRegistryState: 'invalid' });
  assert.ok(chosen, 'silence here is a shelf that looks healthy while nothing runs');
  assert.equal(chosen.alarm, true);
  assert.match(chosen.text, /restart/u);
  assert.notEqual(chosen.text, context.notices.registry,
    'it is a different situation from a bundle that cannot be read, and needs different words');
});

// THE COLOUR IS PART OF THE ANSWER, not a side effect left on the element. A
// transient "cannot reach connect" is not an alarm, and must clear whatever the
// previous notice painted.
test('the ordinary states are not alarms', () => {
  for (const state of ['down', 'auth', 'noroute', 'pending', 'error']) {
    const chosen = context.pick({ state });
    assert.ok(chosen, `${state} still says something`);
    assert.equal(chosen.alarm, false, `${state} must not inherit the alarm colour`);
  }
  assert.equal(context.pick({ state: 'down', registryState: 'invalid' }).alarm, false,
    'a payload we could not trust enough to render is reported as itself');
});

// AND EVERY PATH GOES THROUGH ONE SETTER, which is what makes the reset
// structural rather than three places to remember.
test('the shelf has exactly one place that writes the notice', () => {
  const writes = connectionsJs.match(/notice\.style\.color\s*=/gu) ?? [];
  assert.equal(writes.length, 1, 'more than one writer is how the colour got left behind');
  const assignments = connectionsJs.match(/notice\.hidden\s*=/gu) ?? [];
  assert.equal(assignments.length, 1, 'and the same for what is shown');
});
