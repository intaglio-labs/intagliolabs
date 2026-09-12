// THE TWO THINGS THE OWNER DID ON SCREENS 3 AND 4, AND THE SCREEN THAT DID NOT
// MENTION THEM.
//
// On the second clean-machine onboarding run (2026-09-12) the connectors daemon
// started at app launch — before the Google sign-in and before the LinkedIn
// export. Both sources answered "not ready", and:
//
//   * nothing told the daemon the wait was over, so the reader would not have
//     looked again for a quarter of an hour (widget's half of that is the
//     nudge below; the daemon's half is connectors/test/notReadyReprobe);
//   * screen 6's table is built from rows and run history, so the two sources
//     the owner had just connected were the two it did not draw — and when they
//     ARE drawn, "connected, nobody found yet" would be a verdict on a search
//     that has not happened;
//   * and the card peek's wire word reached them verbatim: "no card yet —
//     pool-exhausted".
//
// Source scan, like the other widget tests — no toolchain, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const js = readFileSync(join(ROOT, 'widget', 'ui', 'onboarding.js'), 'utf8');
const connectors = readFileSync(join(ROOT, 'widget', 'src', 'Connectors.swift'), 'utf8');
const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');

/// Code only: the comments in these files describe the very defects being
/// pinned, so a naive `includes` finds the bug's own description.
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\/\/)/u.test(line))
  .join('\n');

function bodyOf(source, name) {
  const re = new RegExp(`\\nfunction ${name}\\(([^)]*)\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`, 'u');
  const m = re.exec(source);
  assert.ok(m, `${name}() not found`);
  return code(m[2]);
}

/// A Swift method body, matched on the `  }` at its own indentation.
function swiftBody(source, signature) {
  const re = new RegExp(`\\n  (?:private )?func ${signature} \\{\\n([\\s\\S]*?)\\n  \\}\\n`, 'u');
  const m = re.exec(source);
  assert.ok(m, `${signature} not found`);
  return code(m[1]);
}

// ------------------------------------------------------- the table's new word

test('a connected source nobody has read yet is neutral, not amber', () => {
  const copy = /const STATUS_COPY = \{\n([\s\S]*?)\n\};/u.exec(js);
  assert.ok(copy, 'STATUS_COPY not found');
  const body = code(copy[1]);
  assert.match(body, /waiting: 'reading soon'/u,
    'the route can answer `waiting`, and the page must have a sentence for it');
  // Without the entry the cell falls through to 'reading', which claims the
  // reader has reached a source it has not started.
  assert.doesNotMatch(body, /waiting: 'connected, nobody found yet'/u);

  const cell = bodyOf(js, 'statusCell');
  const colours = /const cls = \{([^}]*)\}/u.exec(cell);
  assert.ok(colours, 'statusCell no longer maps a status to a colour');
  assert.doesNotMatch(colours[1], /waiting/u,
    'waiting takes the grey default; amber is for a source that WAS read and found nobody');
});

// ----------------------------------------------------------- the peek's words

test('the card peek never shows the owner a wire word', () => {
  const peek = bodyOf(js, 'peekCard');
  assert.doesNotMatch(peek, /no card yet — \$\{out\.reason\}/u,
    'the raw reason reached the owner as "no card yet — pool-exhausted"');
  assert.match(peek, /out\.reason === 'pool-exhausted'/u,
    'the one reason a fresh install actually hits needs its own sentence');
  assert.match(peek, /nobody qualifies yet/u);
  assert.match(peek, /retryAfterMs/u, 'the route says when it will look again; say so');
  assert.match(peek, /checking again in \$\{minutes\} min/u);
});

// ------------------------------------------------------------------ the nudge

test('the app tells the reader to look again instead of restarting it', () => {
  const nudge = swiftBody(connectors, 'nudge\\(\\)');
  assert.match(nudge, /SIGUSR2/u, 'SIGUSR1 is reserved by node for its own debugger');
  assert.match(nudge, /p\.isRunning/u, 'signalling a dead pid is signalling somebody else');
  // SIGUSR2's default action is terminate, and the daemon installs its handler
  // only once node has booted. A guessed grace was round-6 finding 10; the
  // readiness marker the child writes is pinned in its own test below.
  assert.match(nudge, /nudgeReadyFile/u, 'a daemon that has not said it is armed is not signalled');
  assert.doesNotMatch(nudge, /terminate\(\)/u,
    'a missing token file is not a reason to throw away a pass in flight');
});

test('completing a connect screen nudges the reader that is already running', () => {
  const start = swiftBody(bridge, 'startReadingSources\\(\\) -> Bool');
  const startsIt = start.indexOf('Connectors.shared.start()');
  const nudges = start.indexOf('Connectors.shared.nudge()');
  assert.notEqual(startsIt, -1, 'startReadingSources must still start the daemon');
  assert.notEqual(nudges, -1,
    'start() is silent when the daemon is up, and those are the calls that matter');
  assert.ok(startsIt < nudges, 'nudge a daemon that exists: start first, then ask it to look');
});

// ---------------------------------------------------- the tree the reader refuses

// ROUND-5 FINDING 5. hazlie-tree-perms is FATAL in the daemon and reported only
// in the daemon's own log. reassertTreePerms tries to satisfy it at every start
// and cannot for three shapes the check fails on: a directory symlinked to a
// wider target (the check's statSync follows the link; this deliberately does
// not), a TREE_DIR path that exists and is not a directory, and a directory
// this app cannot chmod — one created by a sudo setup run and owned by root.
// On 2026-09-12 that was four dead starts with onboarding waiting for rows.
test('a tree the app cannot make owner-only is named, not swallowed', () => {
  const pass = swiftBody(connectors, 'reassertTreePerms\\(\\)');
  assert.doesNotMatch(pass, /try\? fm\.setAttributes/u,
    'a chmod that fails EPERM on a root-owned directory is the silent death itself');
  assert.match(pass, /catch \{\n\s*blocked\.append\(path\)/u);
  assert.match(connectors, /private\(set\) var treePermsBlockers: \[String\]/u);
  // A symlink is no longer reported on sight: round-6 finding 3 is that the
  // daemon traverses it, so only a link whose TARGET fails is a blocker. The
  // shared question is pinned in its own test below.
  assert.match(pass, /let isLink = target != path/u);
});

test('screen 6 says which paths to chmod instead of offering a button that cannot work', () => {
  const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
  assert.match(code(bridge), /body\["treePermsBlockers"\] = blockers/u,
    'the table doing the waiting is where the reason belongs');

  const paint = bodyOf(js, 'paintLoad');
  assert.match(paint, /out\.treePermsBlockers/u);
  assert.match(paint, /chmod 700/u, 'name the fix, not the condition');
  // The start button restarts a reader that will refuse again for the same
  // reason. Offering it is offering a loop.
  const after = paint.slice(paint.indexOf('treePermsBlockers'));
  assert.match(after, /loadStart\.hidden = true/u);
});

// ------------------------------------------- screen 3, and the browser tab in it

// ROUND-5 FINDING 9. The focus event beats `ops/gcal-auth.mjs` finishing its
// write by about a second, and zeroing the grace window there meant the probe it
// triggers reads zero live accounts with no window left — so the screen says
// "that sign-in did not finish" about a consent the owner just completed. The
// one event most likely to coincide with the race was the one that spent the
// protection against it.
test('coming back from the browser shortens the grace window instead of spending it', () => {
  const handler = /window\.addEventListener\('focus', \(\) => \{\n([\s\S]*?)\n\}\);/u.exec(js);
  assert.ok(handler, 'the focus handler moved');
  const body = code(handler[1]);
  assert.match(body, /googleOpenedAt = Date\.now\(\)/u,
    'the window is restarted, not cleared, while a sign-in is outstanding');
  assert.match(body, /googleWaitMs = GOOGLE_POLL_MS/u,
    'one more poll, not the whole minute the press bought');
  // And still reachable: an owner who really cancelled has to hear so.
  assert.match(body, /googleOpenedAt = 0/u,
    'with nothing outstanding the window stays spent');
});

// ROUND-5 FINDING 7. Re-entering screen 3 while consent is still open threw the
// press away: the screen said "not connected" about a browser tab the owner was
// looking at, and the poll that would have turned it green had been stopped, so
// nothing but another focus event ever corrected it.
test('re-entering screen 3 does not forget a sign-in that is still in the browser', () => {
  const body = bodyOf(js, 'enterGoogle');
  assert.match(body, /const outstanding = googleAsked && Date\.now\(\) - googleOpenedAt < googleWaitMs/u);
  assert.doesNotMatch(body, /^\s*googleAsked = false;/mu,
    'an unconditional clear is what loses the outstanding press');
  assert.match(body, /googleAsked = outstanding/u);
  // A visit with a press still in flight has to keep watching for it.
  assert.match(body, /startGooglePolling\(\)/u);
});

// --------------------------------------------- the pick, and whether it survives

// ROUND-5 FINDING 20. The mode route answers 200 with `persisted: false` when
// its config write fails, so hermes being down for a whole first session lost
// the owner's pick with nothing but a note they may have scrolled past — while
// `capPerDay`, chosen on the same screen, landed on a later launch.
test('the mode pick is written down and re-delivered, like the cap', () => {
  const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
  const src = code(bridge);
  assert.match(src, /static var cardModePending: String\?/u,
    'the choice has to outlive the session that could not deliver it');
  assert.match(src, /Bridge\.cardModePending = mode/u,
    'recorded before the POST, because the press is the decision');
  // `persisted` is the only word that means kept: the route answers 200 either
  // way, and 200 is exactly what it says when the write failed.
  assert.match(src, /out\["persisted"\] as\? Bool == true \{\s*\n\s*Bridge\.cardModePending = nil/u);
  assert.match(src, /func resumeCardModeIfPending\(\)/u);
  assert.match(src, /resumeCardModeIfPending\(\)/u, 'and something at launch has to call it');
});

test('a stale apology about the mode does not survive a replay of the flow', () => {
  const body = bodyOf(js, 'enterWelcome');
  assert.match(body, /modeNote\.textContent = ''/u);
  // And the sentence matches what now happens: the pick is held and retried.
  // Code only: the comment above the new copy quotes the old sentence to
  // explain why it went, which a raw scan would find.
  assert.doesNotMatch(code(js), /it will go back to the/u,
    'the old copy promised a revert that no longer happens');
  assert.match(code(js), /i am holding on to it/u);
});

// ROUND-5 FINDING 13. recordCardDefaults is reachable from three startedSources
// call sites and resumeCardDefaultsIfPending fires independently at launch, so a
// first launch with hermes down ran four chains of up to ten POSTs each against
// a hermes already struggling — the only condition under which the chains exist.
test('the card-defaults retry is one chain, not one per call site', () => {
  const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
  const src = code(bridge);
  assert.match(src, /private var cardDefaultsInFlight = false/u);
  // The guard carries a staleness clause since round-6 finding 14: a completion
  // that never arrives must not silence every later resume for the life of the
  // process.
  assert.match(src, /if cardDefaultsInFlight,/u);
  // And the flag has to be released on every exit, or one failed launch
  // silences every later attempt in the same session.
  const releases = src.match(/cardDefaultsInFlight = false/gu) ?? [];
  assert.ok(releases.length >= 2, 'both the success and the give-up path release it');
});

// ------------------------------------------ the export whose age nobody can tell

// ROUND-5 FINDING 22. The staging swap stamps the export's own date onto the
// installed copy so the refusal can ask how old it is. Two things going wrong
// together defeat it: an archive with no readable date AND a setResourceValues
// that throws. Both dates are then the moment the copy landed, installedVintage
// answers "now", and the owner's own file is refused as older than the one they
// have — permanently, with no way past it but deleting the file by hand. The
// fallback could not reach that case: it lived inside `if let vintage`.
test('a date this app could not record is not evidence to refuse the owner with', () => {
  const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
  const src = code(bridge);
  assert.match(src, /static var unstampedImports: \[String\]/u,
    'the app has to write down that it does not know');
  assert.match(src, /!Bridge\.unstampedImports\.contains\(kind\.name\),\n\s*let existing = Bridge\.installedVintage/u,
    'and the refusal has to consult it before it fires');
  // A `try?` that swallowed a second failure read exactly like a success.
  assert.match(src, /stampedVintage = \(try\? fallback\.setResourceValues\(vintageOnly\)\) != nil/u,
    'the fallback only counts if it landed');
  assert.match(src, /"unknownVintage": unknownVintage/u, 'and the flow is told');

  const paint = bodyOf(js, 'paintLinkedIn');
  assert.match(paint, /out\.unknownVintage/u);
  assert.match(paint, /could not tell how old it is/u);
});

// -------------------------------------------------- the first-load sprint, on screen 6

// The card wants somebody whose last activity is at least 180 days old, and a
// fresh install's forward window reaches about 157 days back — so "i need more
// history" is true and useless. The reader walks last year hard for the first
// half hour precisely to close that gap, and while it is doing so the honest
// sentence names the work rather than the shortfall.
test('screen 6 says what the reader is doing about an empty pool', () => {
  const paint = bodyOf(js, 'paintLoad');
  assert.match(paint, /readerSprinting = out\.sprint/u,
    'the table poll is the one the route tells; the peek is the one with a sentence');

  const peek = bodyOf(js, 'peekCard');
  assert.match(peek, /if \(readerSprinting\) \{/u);
  assert.match(peek, /reading last year so i can tell who has gone quiet/u);
  // ...and the pool sentence is still there for a machine that is NOT sprinting,
  // which is every machine past its first half hour.
  assert.match(peek, /nobody qualifies yet/u);
  const sprintAt = peek.indexOf('readerSprinting');
  const poolAt = peek.indexOf('nobody qualifies yet');
  assert.ok(sprintAt > -1 && sprintAt < poolAt,
    'the sprint line comes first, or it can never paint');
});

test('the app tells the reader which machine the owner asked for', () => {
  // The daemon's sprint re-arms in ten seconds at full speed and a minute
  // otherwise. The spawn environment is the one channel that already carries a
  // parent fact to this child; a config key would be a second writer for a
  // setting that already has one here.
  assert.match(connectors, /environment\["INTAGLIO_PERFORMANCE"\] = PowerBudget\.current == \.full \? "full" : "trickle"/u);
});

// ------------------------------------------------------------- round-6 pins

// ROUND-6 FINDING 3. checks.mjs uses statSync, which traverses a final symlink;
// attributesOfItem does not. `ln -s /Volumes/Data/logs ~/.hazlie/logs` with the
// target at 0700 PASSES the daemon's fatal check and the reader runs — while
// screen 6 said "i cannot start reading" and hid the only button on it. The
// round-5 fix shared the MODE between the two files and left the STAT SEMANTICS
// divergent, which is the same drift one level down.
test('the app asks the same question about a symlink that the daemon asks', () => {
  const pass = swiftBody(connectors, 'reassertTreePerms\\(\\)');
  assert.match(pass, /resolvingSymlinksInPath\(\)/u,
    'the daemon traverses the link; so must this, or they disagree about a working install');
  assert.match(pass, /attributesOfItem\(atPath: target\)/u,
    'and the mode question is asked of the target, not the link');
  // A link whose target is fine is silent. Only one whose target fails the
  // daemon's test is named — and it is named rather than chmod'd, because what
  // is on the other side is not this app's to widen or narrow.
  assert.match(pass, /if isLink \{\n\s*blocked\.append/u);
});

// ROUND-6 FINDING 10. SIGUSR2's default action is terminate, and the child
// installs its handler after node boots and evaluates seventeen static imports.
// Three seconds since lastStart is the parent's own bookkeeping measured against
// nothing the child ever said — and a first-ever launch with a cold page cache
// and a signature check of the bundled node is exactly the case the nudge exists
// for, and the one where a guess is worth least.
test('the nudge waits for the child to say it can take one', () => {
  const nudge = swiftBody(connectors, 'nudge\\(\\)');
  assert.doesNotMatch(nudge, /nudgeGrace/u, 'a guessed grace is not a readiness signal');
  assert.match(nudge, /nudgeReadyFile/u);
  // The marker names a pid, so one left by a previous daemon is ignored rather
  // than believed about the current child.
  assert.match(nudge, /== p\.processIdentifier/u);
  const daemonSrc = readFileSync(join(ROOT, 'connectors', 'daemon.mjs'), 'utf8');
  assert.match(code(daemonSrc), /function announceNudgeReady/u,
    'and the child has to write it');
  const arm = /function armNudge\(daemon, log\) \{([\s\S]*?)\n\}/u.exec(daemonSrc)?.[1];
  assert.ok(arm, 'armNudge not found');
  assert.match(arm, /announceNudgeReady\(\)/u, 'written when the handler is armed, not before');
});

// ROUND-6 FINDING 11. `startedTs` is published BEFORE the forward pass, and one
// pass is bounded by FORWARD_BUDGET_MS (120 s) plus a history slice — 60 s of it
// during the sprint. Ninety seconds was sized against the ordinary 20 s budget
// and was already short of the forward budget alone, so the menu showed nothing
// happening during the half hour when the most is happening.
test('the "syncing" row outlives a pass that is genuinely running', () => {
  assert.match(connectors, /static let syncingWindowMs: Double = 240_000/u);
  assert.doesNotMatch(code(connectors), /< 90_000/u,
    'the old window is shorter than one bounded forward pass');
  const daemonSrc = readFileSync(join(ROOT, 'connectors', 'daemon.mjs'), 'utf8');
  const forward = /export const FORWARD_BUDGET_MS = ([0-9_]+);/u.exec(daemonSrc)?.[1];
  const sprint = /export const SPRINT_HISTORY_BUDGET_MS = ([0-9_]+);/u.exec(daemonSrc)?.[1];
  assert.ok(forward && sprint, 'the two budgets this window has to cover');
  assert.ok(
    240_000 >= Number(forward.replace(/_/gu, '')) + Number(sprint.replace(/_/gu, '')),
    'the window must cover a forward pass plus a sprint history slice'
  );
});

// ROUND-6 FINDING 14. The in-flight flags are cleared on success and on giving
// up, which covers every completion — and a completion that never arrives is not
// one of them. The chains exist only when hermes is already struggling, which is
// the condition most likely to produce exactly that.
test('an in-flight flag that never completes does not silence every later resume', () => {
  const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
  const src = code(bridge);
  assert.match(src, /static let inFlightStaleAfter: TimeInterval/u);
  assert.match(src, /if cardDefaultsInFlight,\n\s*Date\(\)\.timeIntervalSince\(cardDefaultsInFlightSince\) < Bridge\.inFlightStaleAfter \{ return \}/u);
  assert.match(src, /if cardModeInFlight,\n\s*Date\(\)\.timeIntervalSince\(cardModeInFlightSince\) < Bridge\.inFlightStaleAfter \{ return \}/u);
});

// ROUND-6 FINDING 15. paintLoad returned before assigning when the poll failed,
// so a failed request left the previous poll's answer standing and the "reading
// last year" sentence outlived the phase.
test('a failed progress poll does not leave the sprint sentence on screen', () => {
  const paint = bodyOf(js, 'paintLoad');
  const cleared = paint.indexOf('readerSprinting = false');
  const guard = paint.indexOf("out.state !== 'ok'");
  assert.ok(cleared > -1 && guard > -1 && cleared < guard,
    'the flag has to be cleared BEFORE the early return, or a dead poll keeps it true');
});

// ROUND-6 FINDING 16. The pending mode is re-delivered at every launch until
// hermes answers persisted:true, so a value hermes will never accept is a full
// retry ladder on every launch for ever, with nothing recording that it has
// already failed a hundred times.
test('a mode hermes will never take is not retried until the end of the install', () => {
  const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
  const src = code(bridge);
  assert.match(src, /static let relationshipModes: Set<String> = \["founder", "investor", "any"\]/u);
  assert.match(src, /Bridge\.relationshipModes\.contains\(mode\)/u,
    'validated before it is remembered');
  assert.match(src, /cardModeMaxLaunches/u, 'and a ceiling on how long it is carried');

  // AND THE LIST MATCHES THE PICKER. Nothing crosses that boundary at build
  // time, so the pin is what stops the two drifting.
  const html = readFileSync(join(ROOT, 'widget', 'ui', 'onboarding.html'), 'utf8');
  const offered = [...html.matchAll(/data-mode="([a-z]+)"/gu)].map((m) => m[1]).sort();
  assert.deepEqual(offered, ['any', 'founder', 'investor'],
    'the picker offers exactly what Bridge accepts');
});
