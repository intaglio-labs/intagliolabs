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

test('the already-provisioned branch acts on it, last', () => {
  const body = bodyOf('static func ensureBackend() {');
  // ~~`guard !fm.fileExists(atPath: connectPlist.path)`~~ — the skip is decided
  // by backendState now, because a plist on its own said nothing about whether
  // the runtime it names was ever staged. See the live 2026-09-14 failure below.
  const guardAt = body.indexOf('guard state != .ready else');
  const healAt = body.indexOf('bootstrapUnloadedAgents()');
  assert.ok(guardAt > 0, 'the repairs still sit behind one guard, on the healthy branch');
  assert.ok(healAt > guardAt,
    'the repair belongs on the branch that guard takes; that guard is the reason\n' +
    'a booted-out service was never noticed');
  const returnAt = body.indexOf('return', healAt);
  assert.ok(returnAt > healAt,
    'it has to run before that branch returns, or it never runs at all');

  // ROUND-1 REVIEW, FINDING 6. The other two repairs on this branch both move
  // launchd jobs about — repairLlamaAgent installs one, the legacy retirement
  // boots old labels out and kickstarts the new ones — so a sweep that ran
  // first would read a picture they were about to change and bootstrap against
  // them.
  const llamaAt = body.indexOf('repairLlamaAgent()');
  const legacyAt = body.indexOf('retireLegacyBackendAgents()');
  assert.ok(llamaAt > 0 && llamaAt < healAt, 'the llama repair runs before the sweep');
  assert.ok(legacyAt > 0 && legacyAt < healAt, 'so does the legacy retirement');
  // ~~and the one agent it must be told about is the one just installed~~ —
  // round-1 finding 6 handed the llama label from repairLlamaAgent to the sweep
  // so the sweep could skip it, which made the collision harmless without making
  // the label have ONE owner. The sweep does not touch it at all now, so there
  // is nothing to hand over and `skipping:` is gone with it.
  const sweep = bodyOf('private static func bootstrapUnloadedAgents() {');
  assert.match(sweep, /for label in agentsInOrder where label != llamaLabel/u,
    'the sweep skips the llama label outright, by name');
  assert.doesNotMatch(sweep, /justInstalled|skipping/u,
    'a hand-over parameter with one possible value and no remaining caller');
  assert.doesNotMatch(body, /skipping:/u);
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
  const caller = bodyOf("private static func bootstrapUnloadedAgents() {");
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

  // ROUND-2 REVIEW, FINDING 4. installAgent bakes Bundle.main.resourceURL into
  // @REPO@, and a launchd plist names a PATH rather than a commit — so
  // re-rendering while this app runs from a mounted DMG or ~/Downloads writes a
  // KeepAlive agent pointed at a volume about to be ejected. That is a worse
  // stale plist than the one being repaired, and it is the deployment hazard
  // CLAUDE.md names: whatever is on disk at restart is what a privileged daemon
  // executes.
  const rerender = caller.slice(guardAt, bootstrapAt);
  const permanentAt = rerender.indexOf('guard runningFromPermanentInstall else');
  const installAt = rerender.indexOf('installAgent(label)');
  assert.ok(permanentAt > 0 && permanentAt < installAt,
    'the where-does-this-app-live test comes BEFORE the re-render, or the plist is\n' +
    'already pointing at the DMG');
  const permanent = /static var runningFromPermanentInstall: Bool \{\n([\s\S]*?)\n  \}/u
    .exec(swift)?.[1] ?? '';
  assert.ok(permanent, 'runningFromPermanentInstall not found');
  assert.match(code(permanent), /path\.hasPrefix\("\/Applications\/"\)/u);
  // BOTH APPLICATIONS FOLDERS (round-3 review, finding 1). Bridge's
  // `inApplications` and main.swift's stale-copy delete check only the system
  // one, and are right to: both are about the move THIS app offers, and that
  // move has one destination. The question here is different — will this path
  // still be there at the next login — and ~/Applications answers yes just as
  // well; staleGrantBundle already looks for a previous install in both places.
  // Accepting only one left a per-user install unable to re-render a stale
  // plist, so its reader stayed dead until the next login.
  assert.match(code(permanent), /path\.hasPrefix\("\\\(home\)\/Applications\/"\)/u,
    'a per-user install is a real install; ask about both folders');
  assert.match(code(permanent), /homeDirectoryForCurrentUser/u,
    'the home is read rather than spelled out — a literal /Users/… would be wrong\n' +
    'under a relocated home, or one that resolves through /private');
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
  // ...AND IT IS WAITED FOR AFTER THE KILL (round-2 review, finding 5).
  // terminate() is a SIGTERM and an immediate return, so returning straight
  // after it left a child this process still owns — on a path that runs again
  // at every Full Disk Access edge, which is how one wedged launchctl becomes
  // several. Bounded too: an unbounded wait is what this function exists to
  // avoid.
  const overran = body.slice(body.indexOf('p.terminate()'));
  assert.match(overran, /while p\.isRunning, Date\(\) < goneBy/u,
    'terminate alone does not reap; the child has to be seen to go');
  assert.match(swift, /private static let agentProbeReapTimeout: TimeInterval = \d+/u,
    'and that wait is bounded by its own named constant');
  // Both failures answer "could not tell", so neither leads to an action.
  assert.match(body, /do \{ try p\.run\(\) \} catch \{ return nil \}/u);
  assert.match(body, /return nil/u);
  assert.match(body, /return p\.terminationStatus == 0/u);
  assert.match(swift, /private static let agentProbeTimeout: TimeInterval = \d+/u,
    'the bound is a named constant, so the log line and the wait cannot disagree');
});

// ------------------------------- a plist is not a provisioned install

// LIVE, 2026-09-14, and the thing every other repair in this file missed.
//
// A first run with a fresh ~/.hazlie and the three io.intaglio.* plists still in
// ~/Library/LaunchAgents. ensureBackend's skip was decided by the connect plist
// alone, so it returned early; provision() is the ONLY thing that stages
// ~/.hazlie/bin/node, so it was never staged; and every agent's
// ProgramArguments[0] is that binary. All three sat at `last exit code = 78`
// (EX_CONFIG), `state = spawn scheduled`, no pid, empty logs — and onboarding
// stalls at screen 3, which needs hermes to sign in.
//
// The stale-plist repair could not save it and should not have: it saw node
// missing, correctly, and routed to installAgent — which re-renders a plist
// naming a file that still is not there. Re-rendering repairs a plist pointing
// at the WRONG path. This one's path was right and empty.
//
// A plist lives in ~/Library/LaunchAgents and the runtime it names lives in
// ~/.hazlie. Deleting either does not delete the other, so one of them cannot
// stand in for both.
const backendState = (connectPlistExists, runtimeStaged) => {
  if (!connectPlistExists) return 'unprovisioned';
  return runtimeStaged ? 'ready' : 'runtimeMissing';
};

// `bundleHasLlama` is what keeps this from being a re-provisioning loop:
// provision() stages the llama runtime only when the bundle carries one, so a
// build without it must not be asked for a file it can never produce.
const runtimeStaged = (bundleHasLlama, node, libnode, llama) => {
  if (!node || !libnode) return false;
  return bundleHasLlama ? llama : true;
};

test('a plist with no runtime under it is provisioned, not repaired', () => {
  const decision = bodyOf('static func backendState(connectPlistExists: Bool, runtimeStaged: Bool) -> BackendState');
  assert.match(decision, /guard connectPlistExists else \{ return \.unprovisioned \}/u,
    'no plist is still provision()\'s own case, exactly as before');
  assert.match(decision, /return runtimeStaged \? \.ready : \.runtimeMissing/u);
  assert.doesNotMatch(decision, /FileManager|fileExists/u, 'the facts are the caller\'s');

  // Unchanged: a machine with nothing installed, and a healthy one.
  assert.equal(backendState(false, false), 'unprovisioned');
  assert.equal(backendState(false, true), 'unprovisioned');
  assert.equal(backendState(true, true), 'ready');
  // THE LIVE FAILURE: plists from the previous install, ~/.hazlie emptied.
  assert.equal(backendState(true, false), 'runtimeMissing');
});

test('the runtime test names every file the agents actually run', () => {
  const rule = bodyOf('static func runtimeStaged(');
  assert.match(rule, /guard node, libnode else \{ return false \}/u,
    'every agent runs ~/.hazlie/bin/node, and build.sh points its wrapper at\n' +
    '@executable_path/../lib for the dylib — neither is optional for any of them');
  assert.match(rule, /return bundleHasLlama \? llama : true/u,
    'a bundle with no llama runtime must not be asked for one, or every launch\n' +
    're-provisions and every launch bounces the agents');

  // The live shape: the plists' interpreter is simply not there.
  assert.equal(runtimeStaged(true, false, false, false), false);
  assert.equal(runtimeStaged(true, false, true, true), false);
  // A staged node whose dylib went with a half-deleted home.
  assert.equal(runtimeStaged(true, true, false, true), false);
  // Node is fine and the llama runtime this bundle ships was never staged.
  assert.equal(runtimeStaged(true, true, true, false), false);
  // ...and the same machine, from a build that ships no llama runtime.
  assert.equal(runtimeStaged(false, true, true, false), true);
  assert.equal(runtimeStaged(true, true, true, true), true);

  // The reader of those four facts asks about the bundle, not about a flag.
  const probe = /private static var runtimeStagedHere: Bool \{\n([\s\S]*?)\n  \}/u
    .exec(swift)?.[1] ?? '';
  assert.ok(probe, 'runtimeStagedHere not found');
  assert.match(code(probe), /backend\.appendingPathComponent\("llama\/bin\/llama-server"\)/u);
  assert.match(code(probe), /hazlie\.appendingPathComponent\("bin\/node"\)/u);
  assert.match(code(probe), /\$0\.hasPrefix\("libnode"\)/u,
    'the dylib is versioned, so it is matched by prefix rather than named');
});

test('a missing runtime takes the full path, and never a re-render alone', () => {
  const body = bodyOf('static func ensureBackend() {');
  assert.match(body, /runtimeStaged: runtimeStagedHere/u,
    'the skip has to ask both halves; a plist alone is what got this wrong');
  assert.match(body, /guard state != \.ready else \{/u,
    'only `ready` takes the repair path — `runtimeMissing` falls through to provision');
  // The dev-build guard still stands in front of provisioning on BOTH paths
  // that reach it, or a build with no bundled backend tries to stage from one.
  const guardAt = body.indexOf('connect/server.mjs');
  const provisionAt = body.indexOf('try provision()');
  assert.ok(guardAt > 0 && guardAt < provisionAt);

  // AND THE FULL PATH COPES WITH THE PLISTS ALREADY BEING THERE, which is the
  // whole situation it is now reached in. installAgent rewrites the plist and
  // then boots the label OUT before bootstrapping it, so a job that is loaded
  // and failing (spawn scheduled, exit 78, under KeepAlive and a 60s throttle)
  // is replaced rather than left to its back-off.
  const install = bodyOf('static func installAgent(_ label: String) -> Bool');
  const bootoutAt = install.indexOf('"bootout", "gui/\\(getuid())/\\(label)"');
  const bootstrapAt = install.indexOf('bootstrap(dst)');
  assert.ok(bootoutAt > 0 && bootoutAt < bootstrapAt,
    'bootout before bootstrap, or bootstrapping an already-loaded job is a no-op\n' +
    'and the failing one stays');
  const prov = bodyOf('private static func provision() throws {');
  assert.match(prov, /installAgent\(label\)/u, 'provisioning installs through that same path');
  assert.match(prov, /hazlie\.appendingPathComponent\("bin\/node"\)/u,
    'and it is the only thing that stages the binary all of this is about');
});

// ------------------------------- the one agent that needs more than a plist

// "A plist launchd has no job for" is the wrong question for io.intaglio.llama-server.
// That agent cannot start without weights, so on a Mac with an old plist and no
// model the sweep bootstrapped it at every launch, the job died at every launch,
// and the next launch found it unloaded again — the same non-converging shape
// the stale-plist check was added for, arriving through a path that is not stale
// at all: `llama-server` really is where the plist says it is, and there is
// simply nothing for it to load.
//
// So the label left the sweep entirely and repairLlamaAgent owns its whole
// lifecycle. That is the option that leaves ONE owner: gating the sweep on the
// model instead would have left two functions acting on one label under
// conditions that merely do not overlap today, which is what round-1 finding 6
// already had to paper over with a `skipping:` hand-over.
const llamaRepair = (modelInstalled, plistExists, loaded) => {
  if (!modelInstalled) return 'none';
  if (!plistExists) return 'install';
  if (loaded === null) return 'unknown';
  return loaded ? 'none' : 'bootstrap';
};

test('the llama agent is not bootstrapped for want of weights', () => {
  const rule = bodyOf('static func llamaRepair(');
  assert.match(rule, /guard modelInstalled else \{ return \.none \}/u,
    'no weights, no agent — this is the loop being closed, and it comes first');
  assert.match(rule, /guard plistExists else \{ return \.install \}/u);
  assert.match(rule, /guard let loaded else \{ return \.unknown \}/u);
  assert.match(rule, /return loaded \? \.none : \.bootstrap/u);
  // ModelSetup.isInstalled is the existing answer to "is there a model", and the
  // one provision() and this repair have always used. No second check.
  assert.doesNotMatch(rule, /ModelSetup|fileExists|model\.gguf/u,
    'the facts are the caller\'s, so the model-link resolution stays in one place');

  // THE LOOP: an old plist, no model. Whether launchd has the job or not.
  assert.equal(llamaRepair(false, true, false), 'none');
  assert.equal(llamaRepair(false, true, true), 'none');
  assert.equal(llamaRepair(false, true, null), 'none');
  // ...and with no plist either, still nothing: provision() skips the agent on a
  // machine with no weights, and this must not undo that.
  assert.equal(llamaRepair(false, false, null), 'none');
  // Weights and no plist — what this repair has always been for.
  assert.equal(llamaRepair(true, false, null), 'install');
  // Weights, a plist, and no job: the case the sweep was covering badly.
  assert.equal(llamaRepair(true, true, false), 'bootstrap');
  // Weights and a healthy job, or a probe that could not answer.
  assert.equal(llamaRepair(true, true, true), 'none');
  assert.equal(llamaRepair(true, true, null), 'unknown');
});

test('one owner for that label, and the model test it already had', () => {
  const repair = bodyOf('private static func repairLlamaAgent() {');
  assert.match(repair, /modelInstalled: ModelSetup\.isInstalled/u,
    'the existing answer to "is there a model", not a second one');
  assert.match(repair, /loaded: exists \? probeAgentLoaded\(llamaLabel\) : nil/u,
    'no plist, no launchctl call — the same short-circuit the sweep uses');
  assert.match(repair, /case \.none, \.unknown:\n\s*return/u);
  assert.match(repair, /bootstrap\(plist\)/u, 'the unloaded case is handled here now');
  // Once per launch, like the install beside it: an agent that HAS weights and
  // dies anyway gets one attempt a launch rather than one per ensureBackend.
  const bootstrapBranch = repair.slice(repair.indexOf('case .bootstrap:'),
                                       repair.indexOf('case .install:'));
  assert.match(bootstrapBranch, /llamaRepairAttempted = true/u,
    'or the bootstrap is the very loop this change closes, one level up');

  // ...and nowhere else touches the label. `installAgent(llamaLabel)` is pinned
  // to one call site in llama-repair-once.test.mjs; this is the other half.
  const sweep = bodyOf('private static func bootstrapUnloadedAgents() {');
  assert.match(sweep, /label != llamaLabel/u);
  assert.match(swift, /static let llamaLabel = "io\.intaglio\.llama-server"/u,
    'named once, because provisioning, installAgent and the sweep all ask about it');
});
