// THE PROBE MUST ASK THE QUESTION THE PAGE BUILDER WILL ASK.
//
// Onboarding screen 5 offers one switch that sends message excerpts off this
// Mac: use the owner's own Claude subscription to build person pages. It may
// only offer it when the installed client demonstrably works. The proof it
// uses is a real spawn — and a spawn is only proof if it is the SAME spawn.
//
// Two invocations of `claude` exist in this repo and they are not the same:
//
//   widget/src/FrontierRunner.swift  the owner-reviewed frontier handoff.
//                                    Passes --safe-mode; builds its own
//                                    environment with SHELL, LANG and LC_ALL
//                                    and an overridden PATH.
//   ui/server/relationship/engines.mjs  claudeArgs(). No --safe-mode, and
//                                    exactly five environment variables.
//
// engines.mjs is the one that will actually build pages if the switch goes on,
// so that is what EngineProbe.swift copies. The obvious wrong implementation
// is the other one — reuse the Swift that is already there — and it produces a
// probe that answers about an invocation nobody will make. Its own comment
// records that dropping USER and LOGNAME makes the client answer "Not logged
// in" (measured 2026-09-07), so the environment is not decoration either.
//
// This file compares the two argument lists token for token. It reads source,
// runs nothing, and needs no toolchain.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const probe = readFileSync(join(ROOT, 'widget', 'src', 'EngineProbe.swift'), 'utf8');
const engines = readFileSync(join(ROOT, 'ui', 'server', 'relationship', 'engines.mjs'), 'utf8');

// One token per array entry. A quoted entry becomes its literal value; an
// identifier or member expression becomes <var>, because the SYSTEM PROMPT and
// the MODEL are legitimately different strings on the two sides — what must
// match is that each sits in the same slot behind the same flag.
function tokens(body, quote) {
  const out = [];
  for (const raw of body.split(',')) {
    // Strip trailing comments and whitespace; skip the empty tail after the
    // final trailing comma.
    const entry = raw.replace(/\/\/[^\n]*/gu, '').trim();
    if (!entry) continue;
    if (entry.startsWith(quote)) {
      const end = entry.lastIndexOf(quote);
      out.push(entry.slice(1, end).replaceAll('\\"', '"').replaceAll("\\'", "'"));
    } else {
      out.push('<var>');
    }
  }
  return out;
}

test('the probe spawns exactly the argument list engines.mjs spawns', () => {
  const swiftBody = /process\.arguments = \[([\s\S]*?)\n {8}\]/u.exec(probe)?.[1];
  assert.ok(swiftBody, 'EngineProbe.swift has no process.arguments literal');
  const nodeBody = /function claudeArgs\(\{ system, model \}\) \{\s*return \[([\s\S]*?)\n {2}\];/u
    .exec(engines)?.[1];
  assert.ok(nodeBody, 'engines.mjs claudeArgs() not found — did it move or change shape?');

  const swiftArgs = tokens(swiftBody, '"');
  const nodeArgs = tokens(nodeBody, "'");
  assert.deepEqual(
    swiftArgs,
    nodeArgs,
    'EngineProbe.swift and engines.mjs claudeArgs() have drifted. The probe would ' +
      'then report on an invocation the page builder never makes — which is the ' +
      'whole failure this screen exists to prevent. Change both.'
  );
  // Named explicitly as well as implied by the comparison: this is the one
  // token whose presence silently changes what the client will do, and it is
  // the token the wrong implementation brings across from FrontierRunner.
  assert.ok(!swiftArgs.includes('--safe-mode'),
    'claudeArgs() does not pass --safe-mode, so the probe must not either');
});

test('the probe passes exactly the five variables engines.mjs passes', () => {
  const envBody = /private static func environment\(\) -> \[String: String\] \{([\s\S]*?)\n {2}\}/u
    .exec(probe)?.[1];
  assert.ok(envBody, 'EngineProbe.environment() not found');
  const keys = [...envBody.matchAll(/^\s{6}"([A-Z]+)":/gmu)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ['HOME', 'LOGNAME', 'PATH', 'TMPDIR', 'USER']);
  // And the same five on the node side, read from the spawn options rather
  // than from a list somebody wrote down twice.
  const nodeEnv = /env: \{([\s\S]*?)\n {8}\},/u.exec(engines)?.[1];
  assert.ok(nodeEnv, 'engines.mjs spawn env block not found');
  const nodeKeys = [...nodeEnv.matchAll(/^\s{10}([A-Z]+):/gmu)].map((m) => m[1]).sort();
  assert.deepEqual(nodeKeys, keys, 'the two environments must name the same variables');
});

test('the probe kills a wedged client rather than waiting on it', () => {
  assert.match(probe, /timeoutSeconds = 20/u, 'a setup screen has somebody watching it');
  assert.match(probe, /kill\(pid, SIGKILL\)/u,
    'a client that ignores a two-token prompt for twenty seconds can ignore a TERM');
  assert.match(probe, /DispatchSource\.makeTimerSource/u);
});

test('the probe parses at pipe EOF, not at process exit', () => {
  // ClaudeFrontierJob's hard-won ordering: parsing in the termination handler
  // reads a truncated tail and renders a real answer as a failure.
  assert.match(probe, /guard !settled, let status = exitStatus, stdoutClosed, stderrClosed else/u);
  assert.match(probe, /if data\.isEmpty \{[\s\S]{0,200}stdoutClosed = true/u);
});

test('failure is classified by the shared classifier, from error fields only', () => {
  assert.match(probe, /settle\(providerFailure\(\[structured, prose, err\]\.joined/u,
    'one substring list for both lanes, not a second copy');
  // A successful answer body must never reach the classifier: failure words
  // inside a model's own answer are not the provider failing.
  assert.match(probe, /envelope\?\["is_error"\] as\? Bool == true\s*\n?\s*\? \(envelope\?\["result"\]/u);
});

test('only a working client is reported as ok', () => {
  const finish = /private func maybeFinish\(\) \{([\s\S]*?)\n {4}\}/u.exec(probe)?.[1];
  assert.ok(finish, 'maybeFinish() not found');
  assert.match(finish, /status == 0,[\s\S]{0,200}envelope\["result"\] is String[\s\S]{0,120}settle\(\["state": "ok"\]\)/u,
    'exit 0 AND a result string — a client that runs and refuses is not ok');
  // Exactly one place says ok in the whole probe.
  assert.equal((probe.match(/"state": "ok"/gu) ?? []).length, 1);
});

test('the probe reads back the engine the config already selects', () => {
  // A replay of onboarding on a machine that already opted in must not draw
  // the switch off — that is an implied opt-out nobody made, one tap from
  // being written back as the real answer (design P12).
  assert.match(probe, /static func configuredEngine\(\) -> String/u);
  assert.match(probe, /memory\["engine"\] as\? String\s*\n?\s*else \{ return "local" \}/u,
    'an absent key means llama, which is engines.mjs\'s stated contract');
  assert.match(probe, /out\["engine"\] = configuredEngine\(\)/u,
    'every reply carries it, so the page never renders the toggle from a constant');
});

test('nothing in the probe reaches a shell', () => {
  assert.doesNotMatch(probe, /\/bin\/(?:sh|bash|zsh)/u);
  assert.doesNotMatch(probe, /launchPath/u);
  assert.match(probe, /process\.executableURL = binary/u);
});
