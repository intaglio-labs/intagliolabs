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
  const start = swiftBody(bridge, 'startReadingSources\\(\\) -> \\(configWritten: Bool, outcome: Connectors\\.StartOutcome\\)');
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
  assert.match(pass, /catch \{\n\s*blocked\.append\(TreeBlocker\(path: path, target: nil\)\)/u,
    'an EPERM on a root-owned directory is still named rather than discarded');
  // The blockers carry a path and a target as two fields since round-7 finding
  // 14; the String view is what the bridge and the page read.
  assert.match(connectors, /private\(set\) var treePermsBlockerDetails: \[TreeBlocker\]/u);
  assert.match(connectors, /var treePermsBlockers: \[String\]/u);
  // A symlink is not reported on sight: round-6 finding 3 is that the daemon
  // traverses it, so only a link whose TARGET fails is a blocker. Which
  // component that question is asked of is round-7 finding 3, pinned below.
  assert.match(pass, /let isLink = /u);
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
  assert.match(peek, /sprintSentence\(\)/u);
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

// ROUND-6 FINDING 15 said a failed poll left the previous answer standing; the
// fix cleared the flag before the early return, and round-7 finding 21 found
// what that bought. Both are pinned by 'a poll that never arrived does not end
// the sprint sentence' below: the flag is set from an answer and from nothing
// else, which is neither stale nor flickering.

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

// ------------------------------------------- the mode is empty, not the pool

// LIVE ON RUN THREE: twenty minutes in, the eligible pool held six people and
// none of them was an investor. "nobody qualifies yet, i need more history" is
// then false twice over — there IS history and there ARE people. What there is
// not is anybody in the group the owner picked on screen 1, and that is a
// different sentence with a different remedy.
test('an empty mode is named as an empty mode, with the count that proves it', () => {
  const peek = bodyOf(js, 'peekCard');
  assert.match(peek, /out\.reason === 'pool-exhausted-mode'/u);
  assert.match(peek, /paintModeShortfall\(out\)/u);
  // The generic pool sentence must not be what this reason reaches: it says the
  // opposite of what is true.
  const modeAt = peek.indexOf("'pool-exhausted-mode'");
  const poolAt = peek.indexOf('nobody qualifies yet');
  assert.ok(modeAt > -1 && poolAt > -1 && poolAt < modeAt,
    'the generic branch returns before this one, so they cannot collide');

  const paint = bodyOf(js, 'paintModeShortfall');
  assert.match(paint, /nobody quiet who is \$\{article\(mode\)\} \$\{mode\} yet/u,
    'the owner picked a word; say it back to them');
  assert.match(paint, /out\.counts\?\.any/u, 'and the count that says the pool is not the problem');
  assert.match(paint, /person' : 'people'/u, 'one person is not "1 people"');
});

// AN OFFER, NEVER A SWITCH. The mode is the owner's choice; this screen says
// what it currently costs and puts the alternative one press away. A flow that
// quietly widened the pool to produce a card would be the app deciding what the
// owner meant.
test('the widening is a button the owner presses, not something the screen does', () => {
  const source = code(js);
  // Nothing posts relMode except a click handler.
  const handler = /loadAnyMode\.addEventListener\('click', \(\) => \{\n([\s\S]*?)\n\}\);/u.exec(js);
  assert.ok(handler, 'the button has no click handler');
  const body = code(handler[1]);
  // The widening rides the REQUEST (round-7 finding 8): a one-off mode on the
  // peek, which hermes honours for that request and never persists.
  assert.match(body, /hzPost\('relCardPeek', \{ mode: 'any' \}\)/u);
  assert.match(body, /lastPeekAt = Date\.now\(\)/u,
    'stamped so the timer does not spend a second peek on top of the owner\'s');

  // The reason branch itself must not post anything: no auto-switch.
  const peek = bodyOf(js, 'peekCard');
  assert.doesNotMatch(peek, /hzPost\('relMode'/u,
    'a screen that switches the mode for the owner is deciding what they meant');

  // AND THE VERB HAS TO BE ONE THIS PAGE MAY CALL. Bridge gates every verb by
  // page, so a button wired to one the onboarding page is not allowed reaches
  // the owner as a press that silently does nothing.
  const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
  const allowed = /"onboarding": \[([\s\S]*?)\],\n/u.exec(bridge)?.[1] ?? '';
  assert.match(allowed, /"relMode"/u, 'the onboarding page must be allowed to write the mode');
  assert.match(allowed, /"relCardPeek"/u, 'and to ask again straight after');
});

test('the sprint sentence keeps its line while the mode row is up', () => {
  const peek = bodyOf(js, 'peekCard');
  const branch = peek.slice(peek.indexOf("'pool-exhausted-mode'"));
  assert.match(branch, /readerSprinting \? sprintSentence\(\) : ''/u,
    'both are true at once: the reader is still walking AND the mode is empty');
  // And the row is cleared on every other answer, so a remedy is never left
  // standing under a problem that has moved on.
  assert.match(peek, /hideModeShortfall\(\);/u);
  const clearedAt = peek.indexOf('hideModeShortfall()');
  const cardAt = peek.indexOf('if (out.card)');
  assert.ok(clearedAt > -1 && cardAt > -1 && clearedAt < cardAt);
});

// ------------------------------------------------------------- round-7 pins

// ROUND-7 FINDING 3. `resolvingSymlinksInPath` resolves the WHOLE path, so one
// intermediate link made every entry look linked: a `~/.hazlie` that is itself a
// symlink, or a home under /private, marked a logs directory this app genuinely
// owns as unrepairable instead of chmod-ing it. The question was always about
// the final component, because that is the one chmod would follow.
test('the link question is asked of the final component, not the whole path', () => {
  const pass = swiftBody(connectors, 'reassertTreePerms\\(\\)');
  assert.match(pass, /resourceValues\(forKeys: \[\.isSymbolicLinkKey\]\)/u,
    'lstat on the last component is the question; resolving the path is not');
  assert.doesNotMatch(pass, /let isLink = target != path/u,
    'comparing resolved against unresolved answers about every intermediate link too');
  // The mode is still read through the link, which is what the daemon does.
  assert.match(pass, /attributesOfItem\(atPath: target\)/u);
});

// ROUND-7 FINDING 13. `attributesOfItem` fails for a dangling link exactly as it
// does for a missing directory — and the daemon WARNs on one and FAILs on the
// other, so the one that kills the reader must not be dropped like the harmless
// one. `ln -s /Volumes/Gone/logs ~/.hazlie/logs` reported nothing wrong.
test('a link to nowhere is reported, not skipped like a missing directory', () => {
  const pass = swiftBody(connectors, 'reassertTreePerms\\(\\)');
  const guard = /guard let attrs = try\? fm\.attributesOfItem\(atPath: target\) else \{([\s\S]*?)\n      \}/u
    .exec(pass)?.[1];
  assert.ok(guard, 'the attributes guard moved');
  assert.match(guard, /if isLink \{ blocked\.append/u,
    'a broken link is a FAIL in the daemon and has to be named here');
});

// ROUND-7 FINDING 14. `blocked` gained "path → target" alongside plain paths, so
// anything downstream treating an entry as a path broke on that one element.
test('a blocker carries its path and its target as two fields', () => {
  assert.match(connectors, /struct TreeBlocker \{\n\s*let path: String\n\s*let target: String\?/u);
  assert.match(connectors, /var describedForOwner: String/u,
    'the arrow is a rendering decision and belongs at the edge');
  assert.match(connectors, /private\(set\) var treePermsBlockerDetails: \[TreeBlocker\]/u);
  // The bridge and the page still get sentences, which is all they ever wanted.
  assert.match(connectors, /var treePermsBlockers: \[String\] \{ treePermsBlockerDetails\.map/u);
});

// ROUND-7 FINDING 8. The button said it would widen one card and wrote the
// owner's mode to the config durably, with nothing on the screen saying so and
// no way back from it there. The peek takes a one-off mode instead.
test('widening the first card does not rewrite the standing choice', () => {
  const source = code(js);
  const handler = /loadAnyMode\.addEventListener\('click', \(\) => \{\n([\s\S]*?)\n\}\);/u.exec(js);
  assert.ok(handler, 'the button has no click handler');
  // SCREEN 6's OWN PATHS, not the whole file: screen 1's picker is where the
  // standing mode is set, and it still writes it.
  assert.doesNotMatch(code(handler[1]), /hzPost\('relMode'/u,
    'this button widens one card; the standing choice is not its to change');
  assert.doesNotMatch(bodyOf(js, 'peekCard'), /hzPost\('relMode'/u);
  assert.match(code(handler[1]), /hzPost\('relCardPeek', \{ mode: 'any' \}\)/u,
    'the widening rides the request, not the config');
  // And the copy says what it does.
  assert.match(source, /show me anyone, just this once/u);

  // The verb has to carry it. hermes reads ?mode= as askedMode, which wins for
  // that request only and never touches relationshipMemory.mode.
  const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
  const src = code(bridge);
  assert.match(src, /peekPath \+= "&mode=\\\(mode\)"/u);
  assert.match(src, /Bridge\.relationshipModes\.contains\(mode\)/u,
    'and only a mode hermes would accept');
});

// ROUND-7 FINDING 21. Clearing the flag before the early return fixed a stale
// sentence and bought a flicker: one failed poll mid-sprint dropped it, and the
// next peek fell through to "nobody qualifies yet — i need more history", which
// is the sentence the sprint branch exists to suppress and is false while the
// reader is mid-pass.
test('a poll that never arrived does not end the sprint sentence', () => {
  const paint = bodyOf(js, 'paintLoad');
  const guard = paint.indexOf("out.state !== 'ok'");
  const assigned = paint.indexOf('readerSprinting = out.sprint');
  assert.ok(guard > -1 && assigned > guard,
    'only a poll that answered may say the phase is over');
  assert.doesNotMatch(paint.slice(0, guard), /readerSprinting = false/u,
    'clearing it before the return is the flicker');
});

// THE PHASE NO LONGER STOPS AT LAST YEAR, so a screen that names one has to name
// the real one. The card wants somebody QUIET, and on a live install the first
// investor card only appeared once the walk was several years down — "reading
// last year" would have been true for about a minute of a half-hour window.
test('the sprint sentence names the year the reader is actually on', () => {
  const say = bodyOf(js, 'sprintSentence');
  assert.match(say, /readerSprintYear === currentYear - 1 \? 'last year'/u,
    'last year is still said as "last year", because that is how a person says it');
  assert.match(say, /String\(readerSprintYear\)/u, 'and any other year is named');
  // A daemon that does not publish the year gets a sentence without one: vague
  // rather than wrong.
  assert.match(say, /readerSprintYear === null/u);

  const paint = bodyOf(js, 'paintLoad');
  assert.match(paint, /readerSprintYear = readerSprinting && Number\.isInteger\(out\.sprint\.year\)/u,
    'the page reads the year the route relays');
});

// ROUND-8 (live): "show me anyone, just this once" is a look, not a choice — and
// the picker must not adopt it. On a one-off reply `servedMode` is the one-off
// and `mode` is still the owner's standing pick, so preferring servedMode would
// move the picker to 'any' because somebody pressed a button that says it is
// just this once.
test('a one-off look does not move the card picker', () => {
  const rc = readFileSync(join(ROOT, 'widget', 'ui', 'reconnect.js'), 'utf8');
  const adopt = /function adoptServerMode\(out\) \{\n([\s\S]*?)\n\}/u.exec(rc)?.[1];
  assert.ok(adopt, 'adoptServerMode not found');
  assert.match(code(adopt), /out\?\.oneOff === true/u,
    'the reply says which kind of look it was; the picker has to read it');
  // On a one-off it takes `mode`, which is the standing pick, and never
  // servedMode.
  //
  // THE RULE, NOT THE TWO LINES IT HAPPENED TO BE WRITTEN ON. This asserted the
  // literal `out?.oneOff === true\n ? (MODES.includes(out?.mode) ...)` and went
  // red the day a SECOND reply shape needed the same treatment: a pick held on
  // `modeFallback: 'linkedin-pending'` is also served under a mode the owner did
  // not choose, also sends `servedMode: 'any'` with `mode` still their own, and
  // carries no `oneOff`, because nobody asked for that widening. The two are one
  // rule now -- the server served something the owner did not pick, so read
  // `mode` -- and what this has to hold down is that a one-off is still on that
  // side of it, however the condition comes to be spelled.
  assert.match(code(adopt), /out\?\.oneOff === true \|\| /u,
    'a one-off must still be one of the cases that refuse servedMode');
  assert.match(code(adopt), /const held = /u);
  assert.match(code(adopt), /\? \(MODES\.includes\(out\?\.mode\) \? out\.mode : null\)/u,
    'and the held branch takes the standing pick');
  // The ordering is what makes it work: servedMode may only be preferred on the
  // branch that is NOT held.
  const heldAt = code(adopt).indexOf('const fromServer = held');
  const servedAt = code(adopt).indexOf('out.servedMode');
  assert.ok(heldAt > -1 && servedAt > heldAt,
    'servedMode must sit on the not-held branch, below the test for it');
});

// ---------------------------------------------- the widened card has to arrive

// LIVE ON RUN FIVE. The owner pressed "show me anyone, just this once", the flow
// finished — config mode still investor, correctly — and the reconnect panel that
// opened pulled under the STANDING mode and said "nothing to review" with the
// investor chip lit. The widening has to travel with the hand-off or it is not a
// hand-off: the card the owner asked for never reached them.
test('a card widened just this once survives the hand-off to the panel', () => {
  const peek = bodyOf(js, 'peekCard');
  assert.match(peek, /finishedOnOneOff = out\.oneOff === true && typeof out\.servedMode === 'string'/u,
    'servedMode is what the panel must ask for; `mode` on that reply is the standing pick');

  const fin = bodyOf(js, 'finish');
  assert.match(fin, /hzPost\('openReconnect', finishedOnOneOff === null/u,
    'the widening rides the hand-off');
  assert.match(fin, /\{ oneOffMode: finishedOnOneOff \}/u);

  const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
  const src = code(bridge);
  // Held for exactly one pull, and in memory: a widening that survived a
  // relaunch would be the durable write the button exists not to make.
  assert.match(src, /private var pendingOneOffMode: String\?/u);
  assert.doesNotMatch(src, /pendingOneOffMode.*UserDefaults|UserDefaults.*pendingOneOffMode/u);
  assert.match(src, /if let mode = payload\["oneOffMode"\] as\? String, Bridge\.relationshipModes\.contains\(mode\)/u);
  assert.match(src, /cardPath \+= "\?mode=\\\(mode\)"\n\s*pendingOneOffMode = nil/u,
    'spent on the first pull, so "just this once" is true');
});

test('the panel says a card came from somewhere the owner did not pick', () => {
  const rc = readFileSync(join(ROOT, 'widget', 'ui', 'reconnect.js'), 'utf8');
  const show = /function showOneOff\(out\) \{\n([\s\S]*?)\n\}/u.exec(rc)?.[1];
  assert.ok(show, 'showOneOff not found');
  assert.match(code(show), /out\?\.oneOff === true/u);
  assert.match(code(show), /shown once from \$\{served\}/u);
  // The chip beside it is still the owner's own — adoptServerMode keys on
  // oneOff — so without this line the picker reads as lying about the card.
  const render = /function render\(c\) \{\n([\s\S]*?)\n  const isOwe/u.exec(rc)?.[1];
  assert.ok(render, 'render() not found');
  assert.match(code(render), /oneOff\.hidden = true/u,
    'every path that draws a card clears a line about a different one');
});

// ROUND-8 FINDING 12. A widened peek that lands on the refill throttle answers a
// plain `pool-exhausted` with no counts — modeEmptyCounts returns nothing for
// 'any' — so clearing the row on the press took away the button that produced it
// for a reason that had not changed. Self-healing at the next poll, and it reads
// as the press having failed.
test('a press answered by a throttle does not take the button away', () => {
  const handler = /loadAnyMode\.addEventListener\('click', \(\) => \{\n([\s\S]*?)\n\}\);/u.exec(js);
  assert.ok(handler, 'the button has no click handler');
  assert.doesNotMatch(code(handler[1]), /hideModeShortfall\(\)/u,
    'the row goes when an ANSWER says so, not when the press is made');
  assert.match(code(handler[1]), /peekCard\(out, \{ fromOneOff: true \}\)/u,
    'and the answer has to know which press it is answering');

  const peek = bodyOf(js, 'peekCard');
  assert.match(peek, /if \(!\(fromOneOff && out\.reason === 'pool-exhausted'\)\) hideModeShortfall\(\);/u);
  // ...and it says what happened rather than reverting to a sentence about
  // something else.
  assert.match(peek, /still looking — try that again in a moment/u);
});
