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

// COMMENTS STRIPPED. This repository keeps what it removed, struck through, in
// the comment above the thing that replaced it — so a scan for a retired name
// finds its own gravestone unless the prose is taken out first.
const bare = (text) => text.replace(/\/\/[^\n]*/gu, '');
const bareCss = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '');

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
  // THE REAL NUMBER, NEVER A WORD FOR IT. ~~`n === 1 ? 'one card a day' : ...`~~
  // spelled the singular out, so an owner whose config says 50 read a row that
  // looked hard-coded to "one card a day" and could not tell the difference
  // between a setting and a sentence.
  assert.match(row, /bits\.push\(`\$\{cfg\.capPerDay\} a day`\)/u,
    'the cap is printed as the digit the config holds');
  assert.doesNotMatch(bare(row), /one card a day/u,
    'no spelled-out cap may ship — it reads as a hard-coded one');
  // The engine is STILL said here, for an owner who cannot see the switch above
  // (no claude on this Mac, or a probe that failed) — but as the row's hover,
  // not as a third clause on a line that is already a mode and a number.
  assert.match(row, /configEngine\(cfg\) === 'claude-cli' \? 'reading with claude' : 'reading on this Mac'/u,
    'the row says which way the engine is set, for an owner who cannot see the switch');
  // ~~`el.title = `${CARD_HELP} ${engine}.``~~ — the help sentence has two forms
  // since the group picker went behind `timeline` (2026-09-13): one that names
  // the chips on the card, for the flag, and one that does not, for the product
  // as it ships. `help` is whichever of the two this render chose, and the pin
  // is unchanged in what it is about — the engine rides the hover, where it
  // costs the column no height.
  assert.match(row, /const help = modesOn \? CARD_HELP_MODES : CARD_HELP;/u);
  assert.match(row, /el\.title = `\$\{help\} \$\{engine\}\.`/u,
    'and it says it on the hover, where it costs the column no height');
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
  assert.ok(connections.includes('three chips at the top'),
    'and it points at where the picker lives');
  // THE SHAPE. This row was unreadable on the panel it ships in (run 6): its
  // value wore .setting-value — the right-hand read-out built to hold a NUMBER
  // for the size slider — while carrying a ~47-character sentence, and as a
  // sibling flex item that width competed with the text column, which carries
  // min-width: 0 and therefore lost. It was fixed by stacking label, value and
  // description in the column.
  //
  // The description is GONE now (2026-09-13) and the stack with it: there is no
  // second party to the width fight, and the row is a label and a value on one
  // line like every other row here. What must hold is that neither of them can
  // wrap: the value shrinks and ellipsizes first, the label after it.
  assert.match(row, /el\.append\(label, said\);/u, 'label left, value right, one line');
  assert.doesNotMatch(bare(row), /className = 'setting-note'/u,
    'no paragraph under this label — the sentence is the row title');
  assert.doesNotMatch(bare(row), /className = 'setting-value/u,
    '.setting-value was the slider read-out, and it is gone with the slider');
  assert.match(palette, /\.setting-said \{[\s\S]{0,240}text-overflow: ellipsis;/u,
    'and it ellipsizes rather than pushing the row onto a second line');
  assert.doesNotMatch(/\.setting-said \{[^}]*\}/u.exec(bareCss(palette))?.[0] ?? '',
    /overflow-wrap/u,
    'wrapping was the fix for a stacked row; this one may not wrap at all');
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
  // .setting-btn is the pill quit, uninstall and "check" all wear. A row whose
  // button has no rule is a button that inherits the panel's default and reads
  // as text.
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
  // AND IT MUST NOT ASK FOR THE UNZIPPING EITHER. The import takes
  // Connections.csv out of the archive now, so a card still reading "unzip it
  // and choose Connections.csv here" was asking the owner to do by hand the job
  // its own picker had just been taught, and contradicting that picker's
  // message ("choose the zip LinkedIn sent you") on the same install — review
  // finding 9. Code only, because the sentence it replaced is kept above it,
  // struck, like every other one in this repo.
  assert.doesNotMatch(hint.replace(/\/\/[^\n]*/gu, ''), /unzip it/u,
    'the zip is the only thing LinkedIn sends, and the app opens it now');
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
  assert.match(row, /busyRetries = 0;[\s\S]{0,600}control\.replaceChildren\(busy\)/u,
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

// ─────────────────────────────────────────────────────────────────────────────
// ONE LINE PER ROW.
//
// The owner opened Settings on 2026-09-13 and said "what the fuck are these
// settings??? so much fucking text??". The screenshot is nine cards in a 312px
// window, four of which are a control; the rest is prose — a paragraph under
// every label, plus "?" bubbles hiding a second paragraph behind each of two
// of them. One row printed its name one word per line for eleven lines.
//
// The rule now: a bold name on the left, the control on the right, and nothing
// underneath. Explanation lives in the row's `title`, which is a native hover
// that costs the column no height. The one exception is uninstall — the press
// that cannot be taken back keeps one short line on the surface.
//
// Three ways this regresses, so three pins: a builder growing a paragraph
// again, a row shipping without its hover, and a label growing until the row
// wraps. The third is the one that cannot be seen in a diff, so it is computed.

const builders = (name) => {
  const at = connections.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} was not found`);
  // To the next top-level function, which is where every builder here ends.
  const rest = connections.slice(at + 1);
  const end = rest.indexOf('\nfunction ');
  return rest.slice(0, end === -1 ? rest.length : end);
};
const ROW_BUILDERS = ['settingRow', 'cardConfigRow', 'engineRow', 'performanceRow', 'actionRow'];

test('no settings row has a paragraph under it, except uninstall', () => {
  // .setting-note is THE paragraph class. Exactly one builder may still make
  // one, and only one row may pass it anything to say.
  const makers = [...bare(connections).matchAll(/className = 'setting-note'/gu)];
  assert.equal(makers.length, 1, 'only one builder may create a note line');
  assert.ok(builders('actionRow').includes("className = 'setting-note'"),
    'and it is actionRow, because `say` narrates an uninstall into that line');
  for (const name of ROW_BUILDERS.filter((n) => n !== 'actionRow')) {
    assert.doesNotMatch(bare(builders(name)), /setting-note/u,
      `${name} must not put a line under its label`);
  }
  // ONE `note:` IN THE WHOLE PANEL. quit's sentence moved to its hover with
  // everything else; uninstall's did not, and what it kept is nine words.
  const render = /async function renderSettings\(\) \{([\s\S]*?)settings\.replaceChildren/u
    .exec(connections)?.[1] ?? '';
  const notes = [...render.matchAll(/\n\s*note: ([A-Z_]+),/gu)].map((m) => m[1]);
  assert.deepEqual(notes, ['UNINSTALL_NOTE'],
    'uninstall is the only row that may say anything under its label');
  const copy = /const UNINSTALL_NOTE = '([^']*)';/u.exec(connections)?.[1] ?? '';
  assert.ok(copy, 'UNINSTALL_NOTE was not found');
  assert.ok(copy.split(/\s+/u).length <= 9, `the one surviving line is ${copy.split(/\s+/u).length} words`);
  assert.match(copy, /data stays/u, 'and it spends them on the promise that matters');
  // An empty note must occupy nothing: it is built for every action row so
  // `say` has somewhere to write, and quit's is empty until something fails.
  assert.match(palette, /\.setting-note:empty \{ display: none; \}/u);
});

test('the "?" bubbles are gone, copy and all', () => {
  for (const gone of ['infoHint', 'settingHint', 'setting-hint']) {
    assert.ok(!bare(connections).includes(gone), `${gone} must not survive the paragraph cull`);
    assert.ok(!bareCss(palette).includes(`.${gone}`), `${gone} must not keep a rule either`);
  }
  // The COPY survived, on the rows it explained. A cull that dropped the
  // sentences would have taken the answers with the icons.
  assert.ok(connections.includes('maxx does more work in each pass'),
    'the performance explanation is the row hover now');
  assert.ok(connections.includes('It still allows manual sleep and lid-close.'),
    'and so is keep-awake"s');
  assert.ok(connections.includes('Your Mac is importing and indexing everything privately.'),
    'and the estimate answers "why is this taking so long" on its own hover');
});

test('every row carries its explanation as a hover', () => {
  for (const name of ROW_BUILDERS) {
    assert.match(builders(name), /\.title = /u, `${name} must set a title`);
  }
  const render = /async function renderSettings\(\) \{([\s\S]*?)settings\.replaceChildren/u
    .exec(connections)?.[1] ?? '';
  // Every row built from the generic builders is handed one. A row with no
  // hover is a control with no explanation anywhere at all now.
  const calls = [...render.matchAll(/(settingRow|actionRow)\(\{([\s\S]*?)\n  \}\)\)/gu)];
  assert.ok(calls.length >= 4, 'the generic rows were not found');
  for (const [, fn, body] of calls) {
    assert.match(body, /\n\s*help: /u, `a ${fn} is missing its help text`);
  }
});

// The panel is 312px and cannot grow sideways: fitConnections only ever tells
// native a HEIGHT. So a label that outgrows its row does not widen anything —
// it wraps, which is the failure this whole change is about, and it cannot be
// seen by reading the diff. The arithmetic is exact rather than approximate
// because the panel is monospace: every glyph is one advance.
test('no row can wrap at the width this panel actually is', () => {
  // .win: 20px padding + 1px border a side. .setting: 8px padding + 1px border
  // a side. The row's own flex gap between name and control is 10px.
  const ROW_INNER = 312 - 2 * (20 + 1) - 2 * (8 + 1);
  const GAP = 10;
  // IBM Plex Mono is neither bundled nor installed, so `--mono` resolves to
  // ui-monospace (SF Mono, 0.600 em) and falls back to Menlo (0.60205 em).
  // Budget with the wider of the two.
  const ADV = 0.60205;
  const text = (t, px, tracking = 0) => t.length * (px * ADV + tracking);
  const name = (t) => text(t, 12);                 // .setting-name
  const said = (t) => text(t, 11);                 // .setting-said
  const warn = (t) => text(t, 10);                 // .setting-said.setting-warn
  const pill = (t) => text(t, 10, 1) + 2 * 12 + 2; // .setting-btn: padding + border
  const SWITCH = 34;                               // .switch
  // Every row this panel can render, with its widest control. The value rows
  // are given a realistic worst case rather than today's config.
  const rows = [
    ['claude reads & drafts', SWITCH],
    ['claude reads & drafts', pill('check')],
    ['claude reads & drafts', said('checking…')],
    // The failure marker shares the row WITH the switch, plus the slot's gap.
    ['claude reads & drafts', warn('unsaved') + 8 + SWITCH],
    ['daily card', said('investor · 100 a day')],
    ['animations', SWITCH],
    ['sounds', SWITCH],
    ['keep mac awake', SWITCH],
    ['use less power', SWITCH],
    ['quit', pill('quit')],
    ['uninstall', pill('uninstall')],
    ['activity', said('~ 12.5 HRS LEFT')],
    // THE ROW THAT SHIPPED WRAPPING, because it was never put in this budget.
    // Live on the run: the label rendered "linke…" and the value was cut. Its
    // three states are all here now — the sentence each one abbreviates is the
    // row's hover, which costs the line nothing.
    ['linkedin', said('export ready · open email')],
    ['linkedin', said('waiting for your file')],
    ['linkedin', said('2,970 · 13 sep')],
  ];
  for (const [label, control] of rows) {
    assert.ok(connections.includes(`'${label}'`),
      `"${label}" is not a label this panel renders — retire it from the budget`);
    const used = name(label) + GAP + control;
    assert.ok(used <= ROW_INNER,
      `"${label}" needs ${Math.ceil(used)}px of ${ROW_INNER}px — it will wrap`);
  }
  // And the label may not wrap even if something does outgrow the row. The rule
  // is on .setting-name itself: quit and uninstall keep a text column between
  // the row and their name, so a child selector would miss exactly the two rows
  // that have something else in that column.
  const rule = /\n\.setting-name \{[^}]*\}/u.exec(palette)?.[0] ?? '';
  assert.match(rule, /white-space: nowrap;/u);
  assert.match(rule, /text-overflow: ellipsis;/u);
  assert.match(palette, /\.setting > \.setting-name \{ flex: 1 1 auto; min-width: 0; \}/u,
    'and it takes the room the control does not');
  // ...EXCEPT WHERE THE NAME IS THE SHORTER OF THE TWO. `min-width: 0` lets the
  // label shrink before the value does, which on the LinkedIn row produced
  // "linke…" beside a value that was itself cut: both halves unreadable, and
  // the label is the half that says which setting this is. A row may opt out,
  // and then only the value ellipsizes.
  assert.match(palette, /\.setting > \.setting-name-keep \{ flex: 0 0 auto; \}/u);
  assert.match(connections, /className = 'setting-name setting-name-keep'/u,
    'the linkedin row is the one that needs it');
});

test('the linkedin row is a label and a value, like the daily card row', () => {
  // The same shape test the daily-card row gets, for the same reason: that row
  // was unreadable on the panel it ships in, and the answer was one line with
  // the value shrinking first. This row then shipped breaking the same rule.
  const row = /function linkedInRow\(\) \{([\s\S]*?)\n\}/u.exec(connections)?.[1] ?? '';
  assert.ok(row, 'linkedInRow() not found');
  assert.match(row, /row\.append\(label, said\);/u, 'label left, value right, one line');
  assert.doesNotMatch(bare(row), /className = 'setting-note'/u,
    'no paragraph under this label — the sentence is the row title');
  assert.doesNotMatch(bare(row), /className = 'setting-value/u);
  assert.doesNotMatch(bare(row), /setting-col/u, 'and it does not stack');
  // EVERY ABBREVIATION HAS ITS SENTENCE ON THE HOVER. The line is four words
  // because the panel is 312px; what it means may not be lost with the width.
  assert.match(row, /row\.title = hover/u);
  for (const full of ['drop it here', 'open the email']) {
    assert.ok(connections.includes(full),
      `"${full}" left the row and must still be somewhere the owner can read it`);
  }
});

test('the activity row is the one row that stacks, and it is capped', () => {
  // It is a header and a live list, so it cannot be one line. What it can be is
  // bounded: three task lines, and the rest reachable by scrolling.
  assert.match(connections, /el\.className = 'setting setting-col activity-setting'/u);
  assert.match(palette, /\.activity-list \{\s*\n\s*max-height: 55px;/u,
    'three 15px lines and two 5px gaps — the cap is the whole point');
});
