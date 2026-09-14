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
//
// `loaded` is a tri-state: null is "the probe could not answer", which is not
// the same as "it is loaded" and justifies doing nothing this launch.
function decide(plistExists, loaded) {
  if (!plistExists) return 'notInstalled';
  if (loaded === null) return 'unknown';
  return loaded ? 'loaded' : 'bootstrap';
}

test('the decision is a named pure function of plist-exists and loaded', () => {
  const body = bodyOf('static func agentAction(plistExists: Bool, loaded: Bool?) -> AgentAction');
  assert.match(body, /guard plistExists else \{ return \.notInstalled \}/u,
    'a missing plist belongs to provision()/installAgent, not to this repair');
  assert.match(body, /guard let loaded else \{ return \.unknown \}/u,
    'a probe that could not answer is its own case, not a Bool defaulted one way');
  assert.match(body, /return loaded \? \.loaded : \.bootstrap/u);
  // No launchctl inside the decision: the probe is the caller's, so the
  // decision can be read without a launchd on the other end.
  assert.doesNotMatch(body, /launchctl|Process\(\)/u);
  for (const label of ['io.intaglio.hermes', 'io.intaglio.llama-server', 'io.intaglio.connect']) {
    assert.ok(swift.includes(`"${label}"`), `${label} must still be an agent this file knows`);
  }
  assert.equal(decide(false, false), 'notInstalled');
  assert.equal(decide(false, true), 'notInstalled');
  assert.equal(decide(false, null), 'notInstalled');
  assert.equal(decide(true, true), 'loaded');
  // A launchctl that would not run, or would not answer in time.
  assert.equal(decide(true, null), 'unknown');
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
  assert.match(body, /case \.notInstalled, \.loaded, \.unknown:\n\s*continue/u,
    'a probe that could not answer takes no action, like a healthy service');
  assert.match(body, /bootstrap\(plist\)/u);
  // No subprocess at all for an agent whose plist is absent: the probe is
  // short-circuited behind the file check.
  assert.match(body, /loaded: exists \? probeAgentLoaded\(label\) : nil/u,
    'no plist, no launchctl call');
  // AND NO WAIT ON HERMES (round-1 review, finding 5). provision() waits because
  // it goes on to bootstrap connect and hand the reader a database in the same
  // pass; nothing here talks to hermes afterwards, and `launchctl bootstrap`
  // returns when launchd accepts the job rather than when the process serves --
  // so the wait bought no ordering, only up to fifteen seconds of a launch path
  // on the Mac that is already unwell.
  assert.doesNotMatch(body, /waitForHermes/u,
    'the repair must not block a launch on a service it is not about to use');
});

// ROUND-1 REVIEW, FINDING 5. A plist naming a path nothing lives at any more --
// the shape a stale plist takes after the app moves -- cannot be repaired by
// bootstrapping it: launchd accepts the job, the job dies, the next launch finds
// it unloaded and does the same again, for ever. That wants the plist
// re-rendered from the bundle's template, which is what fixes the paths.
const pathsExist = (args, present) => {
  const paths = args.slice(0, 2).filter((a) => a.startsWith('/'));
  if (paths.length === 0) return false;
  return paths.every((p) => present.includes(p));
};

test('a plist that points at something gone is re-rendered, not re-bootstrapped', () => {
  const body = bodyOf('static func agentProgramPathsExist(');
  assert.match(body, /programArguments\.prefix\(2\)\.filter \{ \$0\.hasPrefix\("\/"\) \}/u,
    'the interpreter and what it runs; everything after is flags, and llama-server\n' +
    'has a models directory among them that legitimately appears later');
  assert.match(body, /guard !paths\.isEmpty else \{ return false \}/u);
  assert.match(body, /paths\.allSatisfy\(fileExists\)/u);
  // Injected filesystem: the rule is exercised, not just read.
  assert.match(body, /fileExists: \(String\) -> Bool/u);

  const node = '/Users/x/.hazlie/bin/node';
  const script = '/Applications/Intaglio Labs.app/Contents/Resources/backend/ui/server/hermes.mjs';
  assert.equal(pathsExist([node, script], [node, script]), true);
  // The app moved: the interpreter is there, the script is not.
  assert.equal(pathsExist([node, script], [node]), false);
  assert.equal(pathsExist([node, script], [script]), false);
  // Flags past the first two are not evidence of staleness.
  assert.equal(pathsExist([node, script, '/gone/models'], [node, script]), true);
  assert.equal(pathsExist(['/usr/bin/env', 'node', '/gone/x'], ['/usr/bin/env']), true);
  // Nothing checkable in the first two entries is not a pass.
  assert.equal(pathsExist(['node', 'server.mjs'], []), false);
  assert.equal(pathsExist([], []), false);

  // ...and the caller routes on it, to installAgent rather than bootstrap.
  const caller = bodyOf('private static func bootstrapUnloadedAgents() {');
  const guardAt = caller.indexOf('guard let args = programArguments(of: plist)');
  const bootstrapAt = caller.indexOf('bootstrap(plist)');
  assert.ok(guardAt > 0 && guardAt < bootstrapAt, 'validate before bootstrapping, not after');
  assert.match(caller.slice(guardAt, bootstrapAt), /installAgent\(label\)/u,
    'the repair for a stale plist is to write it again from the template');
  // A plist that cannot be read or parsed takes the same route, for the same
  // reason: bootstrapping it cannot help either.
  const reader = bodyOf('private static func programArguments(of plist: URL) -> [String]?');
  assert.match(reader, /PropertyListSerialization/u);
  assert.match(reader, /else \{ return nil \}/u);
});

test('the probe asks about one label, is bounded, and cannot deadlock on its output', () => {
  const body = bodyOf('private static func probeAgentLoaded(_ label: String) -> Bool?');
  // `launchctl list` prints every job on the Mac; Uninstall.loadedLabels has to
  // drain its pipe before waiting or it deadlocks on a full buffer. A per-label
  // `print` with both streams discarded has neither problem.
  assert.match(body, /"print", "gui\/\\\(getuid\(\)\)\/\\\(label\)"/u);
  assert.doesNotMatch(body, /"list"/u);
  assert.doesNotMatch(body, /Pipe\(\)/u, 'discard the output; there is a lot of it');
  assert.match(body, /standardOutput = FileHandle\.nullDevice/u);
  assert.match(body, /standardError = FileHandle\.nullDevice/u);
  // BOUNDED (round-1 review, finding 7). waitUntilExit is not, and this sits on
  // a launch path: the Mac where launchctl is wedged is exactly the one where an
  // unbounded wait is worst.
  assert.doesNotMatch(body, /waitUntilExit/u, 'an unbounded wait on a launch path');
  assert.match(body, /Date\(\)\.addingTimeInterval\(agentProbeTimeout\)/u);
  assert.match(body, /while p\.isRunning, Date\(\) < deadline/u);
  assert.match(body, /guard !p\.isRunning else \{/u, 'a probe that overran is killed, not awaited');
  // Both failures answer "could not tell", so neither leads to an action.
  assert.match(body, /do \{ try p\.run\(\) \} catch \{ return nil \}/u);
  assert.match(body, /return nil/u);
  assert.match(body, /return p\.terminationStatus == 0/u);
  assert.match(swift, /private static let agentProbeTimeout: TimeInterval = \d+/u,
    'the bound is a named constant, so the log line and the wait cannot disagree');
});
