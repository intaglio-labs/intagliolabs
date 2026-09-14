// A PLIST ON DISK IS NOT A SERVICE LAUNCHD IS RUNNING.
//
// ensureBackend's fast path returns the moment `io.intaglio.connect.plist`
// exists, and every install path in Provision bootstraps only at the moment it
// WRITES a plist. So a Mac whose agents have been booted out with their plists
// left behind stays that way across a quit and a relaunch. Walked on
// 2026-09-14: `launchctl bootout gui/501/io.intaglio.hermes` and `...connect`
// left only llama-server and the app in `launchctl list`, relaunching the app
// brought neither back, the connectors child failed its connect-health preflight
// (127.0.0.1:51788/api/status unreachable) and logged `daemon_failed_to_start`,
// and a manual `launchctl bootstrap` of both plists was the entire fix.
//
// Booted out by hand there, but the state is reachable without hands:
// Uninstall.run removes each plist after its bootout and, when that removal
// throws, appends a failure and CONTINUES -- and a failed uninstall deliberately
// leaves the app running.
//
// Source scan, like the other widget tests: there is no launchd on the other end
// of a `node --test`. The decision itself is a pure function of two booleans and
// is exercised as one below; the live check is in the report.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const swift = readFileSync(join(WIDGET, 'src', 'Provision.swift'), 'utf8');

/// Comments out: the prose above this fix describes the very defect being
/// pinned, so a naive search finds the bug's own description.
const code = (text) => text
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\/\/)/u.test(line))
  .join('\n');

function bodyOf(signature) {
  const start = swift.indexOf(signature);
  assert.ok(start > 0, `${signature} must still exist under that name`);
  const end = swift.indexOf('\n  }', start);
  assert.ok(end > start, `the body of ${signature} must be findable`);
  return code(swift.slice(start, end));
}

// The decision, as the Swift states it, re-evaluated here over every input.
// This is the whole of agentAction: a plist that is not there is not this
// repair's business, a loaded job is left alone, and the remaining case is the
// one that survived a relaunch.
function decide(plistExists, loaded) {
  if (!plistExists) return 'notInstalled';
  return loaded ? 'loaded' : 'bootstrap';
}

test('the decision is a named pure function of plist-exists and loaded', () => {
  const body = bodyOf('static func agentAction(plistExists: Bool, loaded: Bool) -> AgentAction');
  assert.match(body, /guard plistExists else \{ return \.notInstalled \}/u,
    'a missing plist belongs to provision()/installAgent, not to this repair');
  assert.match(body, /return loaded \? \.loaded : \.bootstrap/u);
  // No launchctl inside the decision: the probe is the caller's, so the
  // decision can be read without a launchd on the other end.
  assert.doesNotMatch(body, /launchctl|Process\(\)/u);
  for (const label of ['io.intaglio.hermes', 'io.intaglio.llama-server', 'io.intaglio.connect']) {
    assert.ok(swift.includes(`"${label}"`), `${label} must still be an agent this file knows`);
  }
  assert.equal(decide(false, false), 'notInstalled');
  assert.equal(decide(false, true), 'notInstalled');
  assert.equal(decide(true, true), 'loaded');
  // THE CASE THAT SURVIVED A RELAUNCH.
  assert.equal(decide(true, false), 'bootstrap');
});

test('the already-provisioned branch acts on it', () => {
  const body = bodyOf('static func ensureBackend() {');
  const guardAt = body.indexOf('guard !fm.fileExists(atPath: connectPlist.path)');
  const healAt = body.indexOf('bootstrapUnloadedAgents()');
  assert.ok(guardAt > 0, 'the fast path still turns on the connect plist existing');
  assert.ok(healAt > guardAt,
    'the repair belongs on the branch the plist-exists guard takes; that guard is\n' +
    'the reason a booted-out service was never noticed');
  const returnAt = body.indexOf('return', guardAt);
  assert.ok(healAt < returnAt,
    'it has to run before that branch returns, or it never runs at all');
});

test('a healthy Mac is a no-op, and a running service is never bounced', () => {
  const body = bodyOf('private static func bootstrapUnloadedAgents() {');
  assert.match(body, /for label in agentsInOrder/u,
    'hermes first: it migrates and opens the database the other two talk to');
  // Nothing is kickstarted. kickstart(-k) stops and restarts, which is a thing
  // to do when a plist CHANGED, not when a launch finds a healthy service.
  assert.doesNotMatch(body, /kickstart\(/u,
    'a service launchd already has is not something a relaunch gets to restart');
  assert.match(body, /case \.notInstalled, \.loaded:\n\s*continue/u);
  assert.match(body, /bootstrap\(plist\)/u);
  // No subprocess at all for an agent whose plist is absent: the probe is
  // short-circuited behind the file check.
  assert.match(body, /loaded: exists && isAgentLoaded\(label\)/u,
    'no plist, no launchctl call');
  // The same wait provision() takes after hermes, for the same reason.
  assert.match(body, /if label == "io\.intaglio\.hermes" \{ waitForHermes\(\) \}/u);
});

test('the probe asks about one label and cannot deadlock on its own output', () => {
  const body = bodyOf('private static func isAgentLoaded(_ label: String) -> Bool');
  // `launchctl list` prints every job on the Mac; Uninstall.loadedLabels has to
  // drain its pipe before waiting or it deadlocks on a full buffer. A per-label
  // `print` with both streams discarded has neither problem.
  assert.match(body, /"print", "gui\/\\\(getuid\(\)\)\/\\\(label\)"/u);
  assert.doesNotMatch(body, /"list"/u);
  assert.doesNotMatch(body, /Pipe\(\)/u, 'discard the output; there is a lot of it');
  assert.match(body, /standardOutput = FileHandle\.nullDevice/u);
  assert.match(body, /standardError = FileHandle\.nullDevice/u);
  // A launchctl that will not run answers "loaded", so a broken probe does
  // nothing rather than bootstrapping on a guess.
  assert.match(body, /do \{ try p\.run\(\) \} catch \{ return true \}/u);
  assert.match(body, /return p\.terminationStatus == 0/u);
});
