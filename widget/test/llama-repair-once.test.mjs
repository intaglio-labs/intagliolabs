// THE REPAIR THAT CAN RACE ITSELF.
//
// provision() installs the llama agent only when a model is present, so an
// install that once read as "no weights" keeps the connect plist that ends
// ensureBackend's first branch early and would never gain the agent. The
// repair in that branch fixes it -- and it is safe against provision(), which
// is the mutually exclusive other branch.
//
// It is not safe against ITSELF. ensureBackend hops to a global queue, so two
// calls in one launch run their bodies concurrently: both pass the "no plist"
// test, both reach installAgent, and installAgent boots the agent OUT and
// bootstraps it back in. The second bootout can land on the first bootstrap
// and leave no agent at all -- precisely the state the repair exists to end.
//
// Pinned here: the repair happens in one named place, under a lock, at most
// once per launch, and the flag is set only when an attempt is actually made
// (weights that arrive later in the same session still get their agent).
//
// Source scan, like the other widget tests -- no Swift toolchain here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const swift = readFileSync(join(WIDGET, 'src', 'Provision.swift'), 'utf8');

/// Comments out: the prose above the repair names the lock, the flag and the
/// agent, so a naive search would find the fix in the paragraph describing the
/// bug.
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

const source = code(swift);

test('the repair lives in one named place that ensureBackend calls', () => {
  assert.match(source, /private static func repairLlamaAgent\(\)/u,
    'the repair must be its own function; inline in ensureBackend there is nothing for a\n' +
    'lock or a once-flag to guard');
  // ~~called straight from ensureBackend~~ — the three repairs an installed
  // machine is owed moved into runInstalledRepairs(), because a dev build that
  // cannot stage a runtime owes the same three (round-4 review, finding 4).
  assert.match(bodyOf('private static func runInstalledRepairs() {'), /repairLlamaAgent\(\)/u,
    'the repair must still run for an install that already has its plists');
  assert.match(bodyOf('static func ensureBackend() {'), /runInstalledRepairs\(\)/u,
    'and ensureBackend must still be what reaches it');
});

test('the repair takes a lock and holds it across the install', () => {
  assert.match(source, /llamaRepairLock = NSLock\(\)/u,
    'concurrent ensureBackend calls must be serialised by something');
  const body = bodyOf('private static func repairLlamaAgent() {');
  const lock = body.indexOf('llamaRepairLock.lock()');
  const install = body.indexOf('installAgent(llamaLabel)');
  assert.ok(lock >= 0, 'the repair must take the lock');
  assert.ok(install > lock,
    'the lock must be held ACROSS installAgent, not just around the flag: it is the\n' +
    "launchctl bootout/bootstrap pair that must not interleave, and a lock released\n" +
    'before it leaves exactly the race it was added to close');
  assert.match(body, /defer \{ llamaRepairLock\.unlock\(\) \}/u,
    'the unlock must be a defer, or an early return out of the guards below keeps the\n' +
    'lock for the life of the process');
});

test('the second caller of a launch does not repeat the install', () => {
  const body = bodyOf('private static func repairLlamaAgent() {');
  assert.match(body, /guard !llamaRepairAttempted/u,
    'a once-flag must short-circuit the second caller; the lock alone only makes the two\n' +
    'bootout/bootstrap pairs sequential rather than stopping the second');
  // The flag is no longer what serialises them -- see the test below -- so
  // what has to hold is that a SUCCEEDED repair is never repeated. The flag
  // itself moved into note(repair:as:) when the bootstrap branch had to obey the
  // same rule (round-4 review, finding 1).
  assert.match(body, /installAgent\(llamaLabel\)/u, 'the install must still be here');
  assert.match(bodyOf('private static func note(repair worked: Bool, as what: String)'),
    /llamaRepairAttempted = true/u, 'and the flag with it');
});

// A FAILED INSTALL IS NOT AN ATTEMPT SPENT (round-5 finding 21).
//
// The flag was raised before installAgent ran, so a `launchctl bootstrap` that
// failed transiently -- most plausibly against an agent still booting out from
// the previous run -- burnt the launch's one attempt, and ensureBackend()
// calling again minutes later did nothing at all.
//
// The interleaving guarantee never depended on that ordering: the LOCK is held
// across installAgent, so no second caller can be inside it to observe an
// intermediate flag. Raising the flag only on success costs nothing and gives
// the failure a way back.
test('a failed install is retried, behind a backoff, rather than burning the launch', () => {
  // SCOPED TO THE INSTALL BRANCH. The bootstrap case beside it raises the same
  // flag, and earlier in the file, so a whole-body indexOf finds that one and
  // says nothing about the ordering this test is here for.
  const body = bodyOf('private static func repairLlamaAgent() {');
  // ~~the flag textually after installAgent, inside its success branch~~ — both
  // branches hand their OUTCOME to note(repair:as:) now, which is a stronger
  // form of the same rule: the flag cannot be set by a caller that did not look
  // (round-4 review, finding 1).
  const note = bodyOf('private static func note(repair worked: Bool, as what: String)');
  const flag = note.indexOf('llamaRepairAttempted = true');
  const success = note.indexOf('if worked {');
  const failure = note.indexOf('llamaRepairFailures += 1');
  assert.ok(success >= 0 && flag > success && failure > flag,
    'the flag lives inside the success branch, and the failure path is the one that\n' +
    'counts and backs off');
  assert.match(body, /note\(repair: installAgent\(llamaLabel\), as: "install"\)/u,
    'the install hands its real answer over rather than assuming one');

  assert.match(note, /llamaRepairNotBefore/u,
    'a failure must leave a time before which the next try is pointless; without one the\n' +
    'retry is an unbounded launchctl loop on a machine where the install keeps failing');
  assert.match(body, /guard !llamaRepairAttempted, Date\(\) >= llamaRepairNotBefore else \{ return \}/u,
    'and that backoff must be checked in the same guard that checks the flag');
  assert.match(note, /llamaRepairFailures \+= 1/u, 'the backoff must grow with the failures');
  assert.match(note, /min\(\s*llamaRepairBackoffCeiling/u,
    'and be capped, so a permanently broken install backs off to a ceiling rather than to hours');
});

test('a Mac whose weights arrive later still gets its agent', () => {
  const body = bodyOf('private static func repairLlamaAgent() {');
  const guard = body.indexOf('ModelSetup.isInstalled');
  // The flag is raised inside note(repair:as:), which only the .install and
  // .bootstrap branches reach — and llamaRepair() answers .none before either
  // of them when there are no weights. Same property, expressed by the switch.
  const flag = body.indexOf('note(repair:');
  assert.ok(guard > 0, 'the repair must still only run for an install that has weights');
  assert.ok(guard < flag,
    'the weights-and-no-plist guard must come BEFORE the flag is set. Marking the repair\n' +
    'attempted on a machine that had no weights yet means the agent is never installed\n' +
    'for weights that land later in the same session');
});

test('nothing else installs the llama agent behind the lock back', () => {
  // One place, or the lock is decoration: a second call site would race the
  // guarded one exactly as the two ensureBackend callers used to race.
  const sites = [...source.matchAll(/installAgent\(llamaLabel\)/gu)];
  assert.equal(sites.length, 1,
    `the llama agent must be installed from exactly one place (found ${sites.length})`);
});
