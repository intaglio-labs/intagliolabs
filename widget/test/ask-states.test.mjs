// Every state the ask path can report has copy the reader can act on.
//
// A source scan, like bridge-capabilities.test.mjs and connectors' egress
// tripwire — no Swift toolchain needed. It exists because the two halves of
// this live in different languages and drifted apart silently: hermes learned
// to say "the model is not running" and Bridge's `default:` arm kept rendering
// it as "something went wrong on this app's side". Both directions of drift are
// invisible until somebody asks a question during a deploy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const bridge = readFileSync(join(WIDGET, 'src/Bridge.swift'), 'utf8');
const chat = readFileSync(join(WIDGET, 'ui/chat.js'), 'utf8');

// JUST THE ASK. Bridge answers several surfaces and each has its own copy --
// `noroute`, for instance, belongs to the connect page's /api/status and is
// nothing to do with a question. Scanning the whole file asserts a contract that
// does not exist, so this reads only the body of `func ask`.
function askBody() {
  const start = bridge.indexOf('private func ask(');
  assert.ok(start > 0, 'could not find func ask in Bridge.swift');
  const end = bridge.indexOf('self.askTask = task', start);
  assert.ok(end > start, 'could not find the end of func ask');
  return bridge.slice(start, end);
}

function askStates() {
  const found = new Set();
  for (const m of askBody().matchAll(/done\(\["state":\s*"([a-z]+)"/gu)) found.add(m[1]);
  return found;
}

test('every state Bridge can report has a line of copy for it', () => {
  const copy = new Set([...chat.matchAll(/^\s{2}([a-z]+):\s*["'`]/gmu)].map((m) => m[1]));
  const emitted = askStates();
  assert.ok(emitted.size > 3, `expected several states, found ${[...emitted]}`);
  // `ok` carries an answer rather than a message, `error` supplies its own, and
  // `cancelled` is deliberately silent -- the owner stopped it and knows.
  const needsCopy = [...emitted].filter((s) => !['ok', 'error', 'cancelled'].includes(s));
  for (const state of needsCopy) {
    assert.ok(copy.has(state), `Bridge can report "${state}" but chat.js has no copy for it`);
  }
});

// THE REGRESSION THIS FILE EXISTS FOR. hermes answers 503 when llama-server is
// unreachable and the /lane/local proxy has always answered 502. Neither was
// mapped, so both fell to `default:` and were reported as an app bug.
test('a model that is not running is reported as down, not as an app bug', () => {
  assert.match(
    askBody(),
    /case\s+503:\s*done\(\["state":\s*"down"\]\)/u,
    'Bridge must map 503 to the "down" state'
  );
  // AND 502 MUST NOT BE THERE. hermes sends 502 for a non-OK answer from a model
  // it DID reach -- a bad key, a model-side 500 -- and "it should come back on
  // its own" would hide a fault that needs the owner.
  assert.ok(
    !/case\s+[0-9,\s]*502[0-9,\s]*:\s*done\(\["state":\s*"down"\]\)/u.test(askBody()),
    '502 means the model answered with an error and must not read as downtime'
  );
  assert.match(
    askBody(),
    /case\s+504:\s*done\(\["state":\s*"slow"\]\)/u,
    'a model that never answered needs its own state, not the app-bug string'
  );
  assert.match(
    chat.match(/^\s{2}down:.*$/mu)?.[0] ?? '',
    /isn't running/u,
    'and "down" must say the model is not running'
  );
});

// The generic arm is the last resort, and it must stay last: if it ever catches
// a status with an honest explanation, the reader is told the wrong thing.
test('the generic app-bug string is the fallback, not the common case', () => {
  const cases = [...askBody().matchAll(/case\s+([0-9,\s]+):/gu)].map((m) => m[1].trim());
  assert.ok(cases.includes('200'), `expected a 200 arm, found ${cases}`);
  assert.ok(cases.some((c) => c.includes('503')), 'expected 503 handled before default');
  assert.ok(cases.some((c) => c.includes('401')), 'expected auth handled before default');
});
