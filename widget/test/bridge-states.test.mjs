// A REPLY IS NOT A SUCCESS, AND EVERY .catch IN THIS BATCH WAS DECORATION.
//
// Bridge.reply (Bridge.swift) always sends `ok: true` — it is the envelope
// saying the message was dispatched, not the verb saying it worked — and
// window.__hzDispatch rejects only on `!ok`. So `hzPost` NEVER rejects for a
// handled verb. relHermes, which every reader-facing verb goes through, answers
// `{state:'down'}` for any transport failure and `{state:'auth'}` when there is
// no bearer yet, and both of those RESOLVE.
//
// Two of the three surfaces that got this wrong were privacy readouts: the
// engine switch painted itself off for a write that never landed, and the
// daily-card row read `{state:'down'}` as a configured engine and said "reading
// on this Mac" while the config on disk said the opposite.
//
// This file pins the shape that makes those states visible. It is deliberately
// about `state`, not about `catch`: a catch may stay where a genuine throw is
// possible, but it may never be the ONLY thing standing between a failed write
// and a switch that claims it succeeded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WIDGET, p), 'utf8');
const bridgeJs = read('ui/bridge.js');
const bridgeSwift = read('src/Bridge.swift');
const connections = read('ui/connections.js');
const onboarding = read('ui/onboarding.js');
const reconnect = read('ui/reconnect.js');

test('the premise still holds: a handled verb always resolves', () => {
  // If either of these ever changes, the explicit state checks below become
  // belt and braces rather than the mechanism — worth knowing, not worth
  // removing them over.
  assert.match(bridgeSwift, /let envelope: \[String: Any\] = \["id": id, "ok": true, "data": data\]/u,
    'reply() sends ok:true for every handled verb');
  assert.match(bridgeJs, /if \(envelope\.ok\) entry\.resolve\(envelope\.data\);/u,
    'and the page resolves on that envelope');
  assert.match(bridgeSwift, /guard let tok = bearerToken\(\) else \{ done\(\["state": "auth"\]\); return \}/u);
  assert.match(bridgeSwift, /done\(\["state": "down"\]\); return/u,
    'a hermes that is not up is a resolved reply carrying a state');
});

test('the privacy switch believes the reply, not the absence of a throw', () => {
  const row = /function engineRow\(configPromise\)([\s\S]*?)\n\}/u.exec(connections)?.[1] ?? '';
  assert.ok(row, 'engineRow was not found');
  const click = /sw\.addEventListener\('click', async \(\) => \{([\s\S]*?)\n {2}\}\);/u.exec(row)?.[1] ?? '';
  assert.ok(click, "the switch's click handler was not found");
  assert.match(click, /landed\(/u,
    'a write that did not land must repaint the switch — and a down hermes never throws');
  assert.doesNotMatch(click, /^\s*try \{\s*\n\s*await hzPost\('setEngine'[^\n]*\n\s*\} catch \{/mu,
    'a bare try/catch around setEngine catches nothing');
  // The owner has to be told, too: a switch that silently springs back is a
  // control the owner will simply press again.
  assert.match(click, /state\.textContent =/u, 'and the row must say why it sprang back');
});

test('onboarding’s engine switch is the same switch and gets the same check', () => {
  const click = /engineToggle\.addEventListener\('click', async \(\) => \{([\s\S]*?)\n\}\);/u.exec(onboarding)?.[1]
    ?? /engineToggle\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\}\);/u.exec(onboarding)?.[1] ?? '';
  assert.ok(click, "onboarding's engine toggle was not found");
  // Comments stripped. The old handler's own comment said "the switch must not
  // claim it landed", which matched a first draft of this assertion and made it
  // pass against the bug — a reminder that a pin over prose is not a pin.
  const code = click.replace(/\/\/[^\n]*/gu, '');
  assert.match(code, /landed\(out\)|out\?\.state === 'ok'/u,
    'the setup flow writes the same key through the same route and must check the same way');
  // A `.catch` may still sit on the call as a null-coalesce; what it may not be
  // is the thing that undoes the paint, because it never runs.
  assert.doesNotMatch(code, /\.catch\(\(\) => \{[\s\S]*setToggle\(!on\)/u,
    'the switch must not spring back from inside a catch that cannot fire');
});

test('the daily-card row tells a reader that did not answer from a setting', () => {
  // {state:'down'} is truthy, so `.catch(() => null)` could not produce the
  // null the "nothing is asserted when nothing answered" branch was written
  // for — the row stated "reading on this Mac" for a config it never read.
  assert.match(connections, /hzPost\('cardConfig'\)[\s\S]{0,200}landed\(out\) \? out : null/u,
    'the promise must resolve to null for any reply that is not ok');
  const row = /function cardConfigRow\(configPromise\)([\s\S]*?)\n\}/u.exec(connections)?.[1] ?? '';
  assert.match(row, /bits\.length > 0 \? bits\.join\(' · '\) : '—'/u,
    'and the em dash must still be what an unanswered read renders as');
});

test('the card panel tells a hermes that is down from an empty queue', () => {
  // renderEmpty({reason:'unreachable'}) lived in a catch that could not fire:
  // a down hermes resolves with {state:'down'} and no card, so the panel said
  // "nothing to review" for a reader that had not been asked.
  const pull = /async function pull\(\)([\s\S]*?)\n\}/u.exec(reconnect)?.[1] ?? '';
  assert.ok(pull, 'pull() was not found');
  assert.match(pull, /!reachedHermes\(out\)/u, 'a non-ok state is not an empty queue');
  assert.match(reconnect, /const reachedHermes = \(out\) => out\?\.state === 'ok';/u,
    'and what "reached" means is the reply state, not the absence of a throw');
  assert.match(pull, /reason: 'unreachable'/u);
  // The verdict post is the other half: `out.ok === false` is absent on a
  // transport failure, so the old test read a dropped verdict as a saved one.
  const verdict = /async function verdict\(event, extra = \{\}\)([\s\S]*?)\n\}/u.exec(reconnect)?.[1] ?? '';
  assert.match(verdict, /out\.state !== 'ok'/u,
    'a verdict that never reached hermes must not clear the card');
});

test('the start button reports a start that was refused', () => {
  // Connectors.start() returns silently on six different guards. Two of them
  // (stopping, model maintenance) are reachable states in which this button
  // did nothing and said nothing, for ever.
  assert.match(bridgeSwift, /"reading": started\.outcome\.isUp/u,
    'startSources must answer whether the daemon actually came up');
  assert.match(bridgeSwift, /"why": started\.outcome\.rawValue/u, 'and why, when it did not');
  // The outcome is the daemon's own answer, not a second guess at it.
  const connectors = read('src/Connectors.swift');
  assert.match(connectors, /enum StartOutcome: String \{/u);
  assert.match(connectors, /var isUp: Bool \{ self == \.started \|\| self == \.alreadyRunning \|\| self == \.queued \}/u,
    'a throttled start is one that will happen, and must not read as a refusal');
  for (const guardCase of ['stopping', 'modelMaintenance', 'missingRuntime', 'missingConfig']) {
    assert.match(connections, new RegExp(`${guardCase}:`, 'u'),
      `the page must have words for a start refused by ${guardCase}`);
  }
  const handler = /start\.addEventListener\('click', async \(\) => \{([\s\S]*?)\n {8}\}\);/u.exec(connections)?.[1]
    ?? /start\.addEventListener\('click'([\s\S]*?)\n {8}\}\);/u.exec(connections)?.[1] ?? '';
  assert.ok(handler, 'the start button handler was not found');
  assert.match(handler, /START_REFUSED|out\?\.reading/u,
    'the row must say what happened rather than sit on "starting…" for ever');
});
