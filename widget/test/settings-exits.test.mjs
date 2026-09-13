// THE OWNER CAN TURN IT OFF, AND CHANGE THE ONE SWITCH THAT SENDS ANYTHING OFF
// THIS MAC.
//
// The app is LSUIElement: no menu bar, no ⌘Q, no status item, and launch agents
// that come back at every login. Before the surface review (2026-09-13) the only
// ways to stop it were Activity Monitor and widget/uninstall.sh — a shell script
// in a repo, which on a cofounder's Mac means it cannot be turned off at all.
// And `setEngine` was granted to the onboarding flow alone, so once setup was
// finished nobody could see or change whether excerpts leave the machine.
//
// Source-shaped, like the rest of widget/test: no Swift toolchain, no webview.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WIDGET, p), 'utf8');
const bridge = read('src/Bridge.swift');
const uninstall = read('src/Uninstall.swift');
const connections = read('ui/connections.js');
const connectors = read('src/Connectors.swift');
const onboardingHtml = read('ui/onboarding.html');
const palette = read('ui/palette.css');

const connectionsGrants = (() => {
  const block = /"connections": \[([\s\S]*?)\],\n {4}\/\//u.exec(bridge);
  assert.ok(block, 'the connections capability list was not found');
  return new Set([...block[1].matchAll(/"([A-Za-z]+)"/gu)].map((m) => m[1]));
})();

test('settings may ask for the engine, and quit, and uninstall', () => {
  for (const verb of ['engineProbe', 'setEngine', 'quitApp', 'uninstallApp']) {
    assert.ok(connectionsGrants.has(verb), `the connections page must be granted ${verb}`);
    assert.match(bridge, new RegExp(`case "${verb}":`, 'u'), `${verb} must be handled`);
  }
});

test('the two grants no page ever called are gone, case and all', () => {
  // A granted-but-uncalled verb is a re-widened surface (Bridge.swift's own
  // header), and connections.js used to claim in a comment that openOnboarding
  // had already gone. It had not.
  for (const verb of ['openOnboarding', 'markHandheld']) {
    assert.ok(!connectionsGrants.has(verb), `${verb} must not be granted to settings`);
    assert.doesNotMatch(bridge, new RegExp(`^ {4}case "${verb}":`, 'mu'),
      `${verb} must not be handled either — nothing may call it`);
  }
  // Native's own openOnboarding is untouched: first run, a resumed flow and the
  // `onboarding` URL scheme all still reach it.
  assert.match(read('src/main.swift'), /func openOnboarding\(resume: Bool\)/u);
});

test('quit replies before it terminates, or the page waits on a dead promise', () => {
  const body = /case "quitApp":([\s\S]*?)case "uninstallApp":/u.exec(bridge)?.[1];
  assert.ok(body, 'the quitApp case was not found');
  const replyAt = body.indexOf('reply(webView, id,');
  const terminateAt = body.indexOf('NSApp.terminate');
  assert.ok(replyAt > -1 && terminateAt > -1, 'quit must both answer and terminate');
  assert.ok(replyAt < terminateAt, 'the reply must be sent before the app is torn down');
  assert.match(body, /asyncAfter/u, 'and the teardown must not race the reply out of the view');
});

test('uninstall asks natively first, and only quits when nothing failed', () => {
  const body = /case "uninstallApp":([\s\S]*?)\n {4}case "prefs":/u.exec(bridge)?.[1];
  assert.ok(body, 'the uninstallApp case was not found');
  const confirmAt = body.indexOf('Uninstall.confirm');
  const runAt = body.indexOf('Uninstall.run');
  assert.ok(confirmAt > -1 && runAt > confirmAt,
    'nothing may be removed before the owner has answered a native alert');
  assert.match(body, /reply\(webView, id, \["state": "ok", "cancelled": true\]\)/u,
    'a cancel is an answer the page must be able to tell from a failure');
  assert.match(body, /if outcome\.failures\.isEmpty \{[\s\S]{0,160}NSApp\.terminate/u,
    'a half-uninstall must stay on screen with its reason rather than quitting');
  // OFF THE MAIN THREAD, or the window freezes with nothing on screen saying
  // why: every step is a launchctl call with a waitUntilExit.
  assert.match(body, /DispatchQueue\.global\(qos: \.userInitiated\)\.async/u);
  assert.match(body, /__hzUninstallStep/u, 'and each step is narrated into the row that was pressed');
});

test('uninstall never deletes what it read', () => {
  // The one irreversible step in widget/uninstall.sh, and the one this must not
  // take on a single press: there are no backups of ~/.hazlie anywhere, by
  // design. The row and the alert both promise it is left.
  const removals = [...uninstall.matchAll(/removeItem\([^\n]*/gu)].map((m) => m[0]);
  assert.ok(removals.length > 0, 'the uninstall must remove something');
  for (const line of removals) {
    assert.doesNotMatch(line, /dataHome|hazlie(?!\w)/u,
      `uninstall must never delete the data home: ${line}`);
  }
  assert.match(uninstall, /static var dataHome/u);
  assert.match(uninstall, /out\.dataKept|dataKept: String = Uninstall\.dataHome/u,
    'and it must report the path it left, because the app quits right after');
  assert.match(connections, /removed\. everything it read is still in \$\{out\.dataKept/u,
    'the row says so in the last line the owner reads');
});

test('uninstall covers both launch-agent namespaces and removes the plist', () => {
  // A pre-rename install has com.hazlie.* agents. An uninstall that only knew
  // today's namespace would leave them running under launchd for ever — the
  // same trap Provision.retireConnectorsAgent records.
  assert.match(uninstall, /labelPrefixes = \["io\.intaglio\.", "com\.hazlie\."\]/u);
  assert.match(uninstall, /"bootout", "gui\/\\\(getuid\(\)\)\/\\\(label\)"/u,
    'the job must be booted out of this user domain');
  assert.match(uninstall, /removeItem\(at: plist\)/u,
    'and the plist removed, or launchd brings it back at the next login');
  // `launchctl list` is bigger than a pipe buffer; waiting before reading it
  // deadlocks. Pinned because the failure is a hang, not an error.
  const loaded = /private static func loadedLabels\(\)[\s\S]*?\n {2}\}/u.exec(uninstall)?.[0] ?? '';
  assert.ok(loaded.indexOf('readDataToEndOfFile') < loaded.indexOf('waitUntilExit'),
    'read the pipe before waiting on the process, or a full buffer deadlocks');
});

test('settings carries the engine switch, and the same words onboarding used', () => {
  assert.match(connections, /rows\.push\(engineRow\(cardConfig\)\)/u);
  // ONE PRIVACY PROMISE, NOT TWO. The sentence under the switch decides what
  // the owner believes about where their messages go; two wordings for one
  // switch is two promises and only one of them was read.
  const promise = "when this is on, excerpts of your messages go to anthropic";
  assert.ok(connections.includes(promise), 'settings must carry the privacy sentence');
  assert.ok(onboardingHtml.includes(promise.replace(/'/gu, '&#8217;')) ||
    onboardingHtml.includes(promise), 'and onboarding must still carry the same one');
  // The switch is offered only when the probe actually worked: "you have it"
  // and "it works" are different questions, and only the second may put a
  // switch on screen that sends message excerpts off this Mac.
  const row = /function engineRow\(configPromise\)([\s\S]*?)\n\}/u.exec(connections)?.[1] ?? '';
  assert.match(row, /if \(st !== 'ok'\) \{[\s\S]{0,200}control\.replaceChildren\(again\)/u,
    'no probe, no switch — a failed probe offers a way to ask again instead');
  assert.match(row, /control\.replaceChildren\(sw\)/u, 'and a working one offers the switch');
  // A MISSING `engine` IS NOT AN OPT-OUT. Reading an absent field as false on
  // this switch is a privacy answer nobody gave, one tap from being written
  // back as the real one.
  assert.doesNotMatch(row, /paintSwitch\(out\.engine === 'claude-cli'\)/u,
    'the switch must not read a missing field as off');
  assert.match(row, /const engine = fromProbe \?\? configEngine\(await configPromise\);/u,
    'the config reply answers when the probe does not, absent key included');
  assert.match(row, /if \(engine !== 'claude-cli' && engine !== 'local'\) \{/u,
    'and with neither able to say, there is no switch at all');
  assert.doesNotMatch(row, /lastError|String\(err/u,
    'a raw engine error must never reach this row');
});

test('the daily-card row reads the config, and asserts nothing when it cannot', () => {
  // A READ, NOT A RUN. The card peek would answer the same question and spend a
  // cap slot, start a person's cooldown and flip the producers' turn — for a
  // panel nobody asked a card from. GET /admin/config/card touches none of it.
  assert.ok(connectionsGrants.has('cardConfig'), 'settings must be allowed to ask');
  const verb = /case "cardConfig":([\s\S]*?)\n\n/u.exec(bridge)?.[1] ?? '';
  assert.match(verb, /relHermes\("GET", "admin\/config\/card", json: nil\)/u,
    'a GET with no body: the page cannot write a setting through this door');
  const row = /function cardConfigRow\(configPromise\)([\s\S]*?)\n\}/u.exec(connections)?.[1] ?? '';
  assert.ok(row, 'the daily-card row was not found');
  assert.match(row, /cfg\?\.mode/u);
  assert.match(row, /Number\.isInteger\(cfg\?\.capPerDay\)/u,
    'a cap that is not a whole number is not a cap');
  assert.match(row, /n === 1 \? 'one card a day'/u, 'and "1 cards a day" never ships');
  assert.match(row, /configEngine\(cfg\) === 'claude-cli' \? 'reading with claude' : 'reading on this Mac'/u,
    'the row says which way the engine is set, for an owner who cannot see the switch');
  // ABSENT IS NOT UNKNOWN: the route sends `engine: null` for a key that has
  // never been written, and an absent key IS the loopback model (engines.mjs).
  // Only a reply that never came is unknown.
  const engineOf = /function configEngine\(cfg\)([\s\S]*?)\n\}/u.exec(connections)?.[1] ?? '';
  assert.match(engineOf, /if \(cfg === null \|\| cfg === undefined\) return null;/u);
  assert.match(engineOf, /return cfg\.engine === 'claude-cli' \? 'claude-cli' : 'local';/u,
    "every answer but 'claude-cli' means nothing leaves this Mac");
  // A reader that is still starting up must not be reported as a setting.
  assert.match(row, /bits\.length > 0 \? bits\.join\(' · '\) : '—'/u,
    'nothing known must render as nothing known, never as a default');
  assert.match(row, /three chips at the top/u, 'and it points at where the picker lives');
  // THE SHAPE, because the first version of this row was unreadable on the
  // panel it ships in (run 6): its value wore .setting-value — the right-hand
  // read-out built to hold a NUMBER for the size slider — while carrying a
  // ~47-character sentence. As a sibling flex item that width competed with
  // the text column, which carries min-width: 0 and therefore lost: the label
  // rendered one word per line with the value printed across the description.
  //
  // Every row in this panel puts its words in the text column and its CONTROL
  // beside it. This row has no control, so all three lines go in the column.
  assert.match(row, /text\.append\(label, said, note\);\s*\n\s*el\.append\(text\);/u,
    'label, value and description stack inside the text column');
  assert.doesNotMatch(row, /el\.append\(text, said\)/u,
    'the value must not be a right-hand slot competing with the description');
  assert.doesNotMatch(row, /className = 'setting-value/u,
    '.setting-value is the slider read-out, and this value is a sentence');
  assert.match(palette, /\.setting-said \{[\s\S]{0,200}overflow-wrap: anywhere;/u,
    'and it wraps rather than pushing the row wider than the panel');
  // No absolute positioning anywhere in the rows: the panel measures its own
  // content height to size the window, and an out-of-flow row is invisible to
  // that measurement.
  assert.doesNotMatch(palette, /\.setting-said \{[^}]*position: absolute/u);
  // ONE QUESTION PER OPEN, not one per row — and a reply that is not ok
  // resolves to null, because {state:'down'} is truthy and every reader of this
  // promise treats a truthy value as a configuration.
  assert.match(connections, /const cardConfig = hzPost\('cardConfig'\)\s*\n\s*\.then\(\(out\) => \(landed\(out\) \? out : null\)\)/u);
  assert.match(connections, /rows\.push\(cardConfigRow\(cardConfig\)\)/u);
});

test('the new rows have a control shape to render into', () => {
  // .setting-btn is the pill quit, uninstall and "check again" all wear. A row
  // whose button has no rule is a button that inherits the panel's default and
  // reads as text.
  assert.match(palette, /^\.setting-btn \{/mu);
  assert.match(palette, /^\.setting-btn-danger \{/mu);
  assert.match(palette, /^\.setting-control \{/mu);
});

test('the shelf offers the LinkedIn picker instead of a dotfile path', () => {
  // Two contradictory instructions for one job: this hint told the owner to put
  // Connections.csv in ~/.hazlie/imports/linkedin by hand, while onboarding
  // screen 4 did it with a native picker. One way now, and it is the picker.
  const hint = /'linkedin-export': \{([\s\S]*?)\n {2}\},/u.exec(connections)?.[1] ?? '';
  assert.ok(hint, 'the export hint was not found');
  assert.doesNotMatch(hint.replace(/\/\/[^\n]*/gu, ''), /~\/\.hazlie/u,
    'a raw dotfile path in a tooltip is an invitation to go editing one by hand');
  assert.ok(connectionsGrants.has('importLinkedIn'), 'the page must be allowed to ask');
  assert.match(connections, /pickLinkedInExport\(pick, tip\)/u);
  // Every branch native can answer with is said, including the two that have a
  // remedy in them. A picker that only knows "ok" leaves a French export or a
  // zip looking like the button did nothing.
  const picker = /const pickLinkedInExport = \(button, tip\) => \{([\s\S]*?)\n {2}\};/u.exec(connections)?.[1] ?? '';
  for (const reason of ['zip', 'columns', 'newer', 'duplicate']) {
    assert.match(picker, new RegExp(`out\\.reason === '${reason}'`, 'u'),
      `the card must answer a ${reason} result`);
  }
  assert.match(picker, /out\.state === 'cancelled'/u, 'and a cancel must say nothing at all');
});

test('an idle activity row says which kind of idle it is', () => {
  // One sentence covered three states: finished, never started, and stopped.
  // Only the first is fine, and the other two are the owner's to fix.
  assert.match(bridge, /"reading": Connectors\.shared\.isRunning/u,
    'the reply must carry whether the thing that does the work is up');
  const paint = /if \(!items\.length\) \{([\s\S]*?)\n {4}\} else \{/u.exec(connections)?.[1] ?? '';
  assert.match(paint, /reading === false\s*\n?\s*\? 'nothing is running\.'/u);
  assert.match(paint, /everything it can see is read/u);
  assert.match(paint, /hzPost\('startSources'\)/u,
    'a stopped reader needs the same "start it" the onboarding banner offers');
});

test('the uninstall never touches the reader from a background queue', () => {
  // Connectors is MAIN-THREAD-CONFINED: plain vars, no lock, no queue. Every
  // other caller honours that — main.swift wraps start() in a main hop,
  // startReadingSources carries a dispatchPrecondition, and the child's
  // terminationHandler hops to main before touching `process`. The uninstall
  // runs on a global queue (it must; it blocks), and the settings panel is
  // polling `activity` every two seconds, which reads isRunning on main. A
  // non-atomic Optional<Process> read against a concurrent write is a
  // use-after-free, not a stale value.
  const stop = /func stopAndWait\(timeout: TimeInterval = 5\) -> Bool \{([\s\S]*?)\n {2}\}/u
    .exec(connectors)?.[1] ?? '';
  assert.ok(stop, 'stopAndWait was not found');
  assert.match(stop, /DispatchQueue\.main\.sync \{\s*\n\s*stopping = true/u,
    'the mutations hop to main; only the wait blocks on the caller’s queue');
  // And the handle is kept until the child is PROVEN gone: dropping it early
  // means nothing can re-signal or reap that process, isRunning lies about it,
  // and a later start() spawns a second daemon against the same SQLite files.
  const signal = /DispatchQueue\.main\.sync \{([\s\S]*?)\n {4}\}/u.exec(stop)?.[1] ?? '';
  assert.match(signal, /stopping = true/u);
  assert.doesNotMatch(signal, /process = nil/u,
    'the handle survives the stop signal — it is cleared by the wait, not by the ask');
  assert.match(stop, /guard !child\.isRunning else \{[\s\S]{0,220}return false/u,
    'a child that will not go is reported, with its handle still owned');
  assert.match(stop, /self\.process === child/u,
    'and cleared only when it is still the child that was waited on');
  // A raw SIGKILL on a pid we may already have stopped owning is a TOCTOU
  // against pid recycling. A child that will not stop is reported, not shot.
  assert.doesNotMatch(stop, /SIGKILL/u, 'an unstoppable child is a failure to report, not a pid to signal');
  const restore = /if !out\.failures\.isEmpty \{([\s\S]*?)\n {4}\}/u.exec(uninstall)?.[1] ?? '';
  assert.match(restore, /DispatchQueue\.main\.sync/u, 'and the restart goes back through main too');
});

test('a failed delete stops the uninstall before it deletes the running app', () => {
  // appBundles() puts the RUNNING bundle last on purpose. Without a break, a
  // pre-rename copy that cannot be deleted is recorded as a failure and the
  // live app is deleted anyway — leaving an app that has removed itself, whose
  // reader cannot restart because its backend went with the bundle.
  const loop = /for path in appBundles\(\) \{([\s\S]*?)\n {6}\}/u.exec(uninstall)?.[1] ?? '';
  assert.ok(loop, 'the delete loop was not found');
  assert.match(loop, /break/u, 'the loop must stop at the first failure');
  // And the restart's own answer decides what the row claims, rather than the
  // row asserting that something is reading.
  assert.match(uninstall, /var readerRestarted/u);
  assert.match(uninstall, /out\.readerRestarted = /u,
    "the restore records what start() actually answered");
  assert.match(connections, /out\.readerRestarted === true/u,
    'the page may only say it is still reading when the restart said so');
});

test('one launchctl enumeration, not one per agent', () => {
  // loadedLabels() enumerates every job on the Mac and drains the pipe. It was
  // called once per label, inside the loop, on the path whose whole point is
  // not to block.
  const body = /static func run\(progress[\s\S]*?\n {2}\}/u.exec(uninstall)?.[0] ?? '';
  const firstCall = body.indexOf('loadedLabels()');
  const loopAt = body.indexOf('for (index, label) in labels.enumerated()');
  assert.ok(firstCall > -1 && loopAt > -1, 'the enumeration and the loop must both be in run()');
  assert.ok(firstCall < loopAt,
    'loadedLabels() must be hoisted above the loop, not spawned once per agent');
  assert.match(body, /stillLoaded/u, 'what launchd still has loaded is what decides');
});

test('a profile link is rebuilt from its parts, not forwarded as written', () => {
  // Comments stripped: the line that removed the truncation says what it
  // removed, and a pin over prose is not a pin.
  const verb = (/case "openProfile":([\s\S]*?)\n\n/u.exec(bridge)?.[1] ?? '')
    .replace(/\/\/[^\n]*/gu, '');
  assert.ok(verb, 'openProfile was not found');
  // Scheme, host and path prefix were already pinned. What was not: the export
  // row's ?trk= tracking parameter rode along to LinkedIn on every click, and
  // a >300-character row was TRUNCATED BEFORE PARSING, so it opened a silently
  // different path.
  assert.match(verb, /URLComponents/u, 'rebuild from components');
  assert.doesNotMatch(verb, /prefix\(300\)/u, 'a too-long row is refused, never trimmed into a new url');
  assert.match(verb, /guard asked\.count <= \d+,/u, 'length is a refusal, before parsing');
  assert.match(verb, /query = nil/u);
  assert.match(verb, /fragment = nil/u);
});

test('the start button’s answer survives the next repaint', () => {
  // The activity row repaints every two seconds and begins by emptying itself.
  // The refusal was written into a node that repaint destroys, so the whole
  // StartOutcome change was invisible about two seconds after the press.
  assert.match(connections, /let startNote = null;/u,
    'the refusal must live in state the repaint reads');
  const paint = /if \(!items\.length\) \{([\s\S]*?)\n {4}\} else \{/u.exec(connections)?.[1] ?? '';
  assert.match(paint, /startNote/u, 'and the repaint must read it');
  assert.match(connections, /startNote = null;[\s\S]{0,400}hzPost\('startSources'\)/u,
    'a fresh press clears the last answer before asking again');
});

test('"reading now" is not claimed for a config that was never written', () => {
  const handler = /start\.addEventListener\('click'([\s\S]*?)\n {8}\}\);/u.exec(connections)?.[1] ?? '';
  assert.match(handler, /landed\(out\)/u,
    'state decides first: a failed config write is not a reading daemon');
});

test('the busy-probe retry does not exhaust itself for the session', () => {
  const row = /function engineRow\(configPromise\)([\s\S]*?)\n\}/u.exec(connections)?.[1] ?? '';
  assert.match(row, /busyRetries = 0;[\s\S]{0,600}state\.textContent = 'checking…'/u,
    'a manual press starts the budget again');
  assert.match(row, /if \(out\?\.state !== 'busy'\) busyRetries = 0;/u,
    'and any real answer resets it');
});

test('the engine row’s timing line reads correctly in both directions', () => {
  // ENGINE_TIMING was written about turning it OFF and shown for both.
  const timing = /const ENGINE_TIMING = ([\s\S]*?);\n/u.exec(connections)?.[1] ?? '';
  assert.ok(timing, 'ENGINE_TIMING was not found');
  assert.doesNotMatch(timing, /turning it off/u, 'the same sentence is shown when it is turned on');
  assert.match(timing, /the next person it reads about/u, 'and it still says what it means');
});
