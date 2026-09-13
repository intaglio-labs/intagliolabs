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
  const runAt = body.indexOf('Uninstall.run()');
  assert.ok(confirmAt > -1 && runAt > confirmAt,
    'nothing may be removed before the owner has answered a native alert');
  assert.match(body, /reply\(webView, id, \["state": "ok", "cancelled": true\]\)/u,
    'a cancel is an answer the page must be able to tell from a failure');
  assert.match(body, /if outcome\.failures\.isEmpty \{[\s\S]{0,120}NSApp\.terminate/u,
    'a half-uninstall must stay on screen with its reason rather than quitting');
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
  assert.match(connections, /rows\.push\(engineRow\(\)\)/u);
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
  const row = /function engineRow\(\)([\s\S]*?)\n\}/u.exec(connections)?.[1] ?? '';
  assert.match(row, /if \(st === 'ok'\) \{[\s\S]{0,200}control\.replaceChildren\(sw\)/u,
    'no probe, no switch');
  assert.match(row, /control\.replaceChildren\(again\)/u,
    'and a failed probe offers a way to ask again instead');
  assert.doesNotMatch(row, /lastError|String\(err/u,
    'a raw engine error must never reach this row');
});

test('settings says the product has modes without guessing which one is on', () => {
  const call = /rows\.push\(factRow\(\{([\s\S]*?)\}\)\);/u.exec(connections)?.[1] ?? '';
  assert.match(call, /who it looks for/u);
  assert.match(call, /reconnect card/u, 'the row must point at where the picker lives');
  // Nothing native knows the standing mode without asking the reader for a
  // card, so the row must not claim one.
  assert.doesNotMatch(call, /founders only|investor'|'any'/u,
    'the row must not assert a mode it cannot read');
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
