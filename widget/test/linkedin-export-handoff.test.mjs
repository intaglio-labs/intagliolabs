// REQUEST NOW, IMPORT LATER.
//
// Screen 4 asked for a file nobody has. LinkedIn does not hand out an export —
// it emails you one, minutes later for the basic archive and up to a day for the
// full one — so the one button on that screen ("choose the file") was a wall for
// every owner meeting it for the first time, and the only way past was skip.
// Whoever skipped never came back, because the flow they would have to reopen is
// the one they finished that morning.
//
// So the screen asks, and the app waits instead of the owner:
//
//   request   a host-pinned door to LinkedIn's own download page, with the
//             onboarding scrim getting out of the browser's way exactly as it
//             does for Google sign-in.
//   have it   the picker, which now also takes the zip LinkedIn actually sends.
//   later     goes on. Nothing in the flow blocks on this file.
//   found it  a Downloads watcher notices the archive landing, whenever that is,
//             and offers to import it with one press.
//
// And two screens stop blaming the reader for an empty group: founder and
// investor are decided from the export's job titles, so with no export there is
// nobody to BE either, and hermes says `modeFallback: 'linkedin-pending'` rather
// than letting the card and the first-load screen report a shortage of history.
//
// Source scan, like the other widget tests — with one exception at the bottom,
// which runs the real /usr/bin/unzip against a fixture archive built here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const bridge = read('widget/src/Bridge.swift');
const mainSwift = read('widget/src/main.swift');
const windows = read('widget/src/Windows.swift');
const watch = read('widget/src/ExportWatch.swift');
const onboardingJs = read('widget/ui/onboarding.js');
const onboardingHtml = read('widget/ui/onboarding.html');
const connectionsJs = read('widget/ui/connections.js');
const reconnectJs = read('widget/ui/reconnect.js');
const reconnectHtml = read('widget/ui/reconnect.html');

/// Comments in these files describe the very behaviour being pinned — and, by
/// house convention, the sentence each one replaced. A naive `includes` finds
/// the fix in the prose about the defect, and the defect in the prose about the
/// fix.
const code = (text) => text
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
  .join('\n');

const swiftCase = (name) => {
  const re = new RegExp(`\\n    case "${name}":([\\s\\S]*?)\\n    case "`, 'u');
  const m = re.exec(bridge);
  assert.ok(m, `case "${name}" not found in Bridge.swift`);
  return m[1];
};

// -------------------------------------------------- (a) request a copy

test('the request door takes no URL from the page at all', () => {
  const body = code(swiftCase('openLinkedInExport'));
  // openProfile pins a HOST because its path is per-person and comes out of the
  // owner's own export. There is nothing per-person about the download page, so
  // this pins the whole string — which means there is no payload to get wrong.
  assert.doesNotMatch(body, /payload\[/u,
    'the page must not be able to say where this goes');
  assert.match(body, /Bridge\.linkedInExportPage/u);
  assert.match(bridge, /static let linkedInExportPage = "https:\/\/www\.linkedin\.com\/mypreferences\/d\/download-my-data"/u);
});

test('the one address it opens is the one the allowlist holds', () => {
  // Two copies of the literal — one in allowedExternal, where
  // connectors/test/openExternal.test.mjs can read it, and one as the constant
  // this verb opens. The guard is what stops them drifting into a door that
  // silently does nothing; this is what stops the guard being deleted.
  const body = code(swiftCase('openLinkedInExport'));
  assert.match(body, /guard allowedExternal\.contains\(Bridge\.linkedInExportPage\)/u,
    'an address not on the allowlist must not be opened by a second door either');
  const at = bridge.indexOf('let allowedExternal');
  const block = bridge.slice(at, bridge.indexOf(']', at));
  assert.ok(block.includes('"https://www.linkedin.com/mypreferences/d/download-my-data"'),
    'the download page is not in allowedExternal, so the guard above refuses everything');
});

test('a browser that opened makes the scrim yield; one that did not, does not', () => {
  // The same hole Google sign-in fell into and System Settings before it: the
  // onboarding panel is full-screen at .floating, a browser window is an
  // ordinary one, and the page the owner was just sent to opens UNDERNEATH a
  // scrim that swallows every click on it.
  const body = code(swiftCase('openLinkedInExport'));
  assert.match(body, /let openedExport = NSWorkspace\.shared\.open\(exportPage\)/u);
  assert.match(body, /if openedExport \{ delegate\?\.yieldOnboardingToBrowser\(\) \}/u,
    'the yield is gated on the launch macOS actually accepted');
  const opened = body.indexOf('NSWorkspace.shared.open(exportPage)');
  const yielded = body.indexOf('yieldOnboardingToBrowser()');
  assert.ok(opened > -1 && yielded > opened, 'and it happens after the launch, not before it');
  // The page has to be able to tell a refusal from a success, or it paints
  // "waiting for you in the browser" over a browser that never opened.
  assert.match(body, /"opened": openedExport/u);
});

test('only onboarding may open it', () => {
  const caps = /static let pageCapabilities: \[String: Set<String>\] = \[([\s\S]*?)\n  \]/u
    .exec(bridge)?.[1];
  assert.ok(caps, 'pageCapabilities not found');
  // Both halves, or "no other page has it" is trivially true of a verb that
  // does not exist — which is what this assertion said before the verb did.
  const onboarding = /"onboarding": \[([\s\S]*?)\],\n/u.exec(bridge)?.[1] ?? '';
  assert.ok(onboarding.includes('"openLinkedInExport"'),
    'the screen that asks for the export cannot open the page it asks from');
  const pages = [...caps.matchAll(/"([a-z-]+)": \[([\s\S]*?)\],\n/gu)]
    .filter(([, page]) => page !== 'onboarding')
    .filter(([, , list]) => list.includes('"openLinkedInExport"'))
    .map(([, page]) => page);
  assert.deepEqual(pages, [],
    'the settings shelf reaches the same page through openExternal; a second grant ' +
      'would be the same door twice, on a page that already has the picker');
});

test('the screen asks, and then does not wait', () => {
  assert.match(onboardingJs, /hzPost\('openLinkedInExport'\)/u);
  const handler = /linkedInRequest\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\}\);/u
    .exec(onboardingJs)?.[1];
  assert.ok(handler, 'the request button has no handler');
  // NO POLL, NO GATE. The file arrives in ten minutes or tomorrow, and the flow
  // is not sitting on this screen for either. Screen 3 polls Google for ten
  // minutes because consent finishes in that window; this one never does.
  assert.doesNotMatch(code(handler), /setInterval|setTimeout|nextScreen\(\)/u,
    'nothing about this press may advance or block the flow');
  // A refusal names the page the owner can reach by hand, because the button
  // that would have taken them there is the thing that just failed.
  assert.match(handler, /out\.opened !== true/u);
  assert.match(handler, /data privacy/u);
});

test('screen 4 says the three things that decide when the file arrives', () => {
  const screen = /<div class="ob-screen" id="screenLinkedIn"([\s\S]*?)<\/div>\n\n  <!--/u
    .exec(onboardingHtml)?.[1] ?? '';
  assert.ok(screen, 'screen 4 not found');
  const visible = screen.replace(/<!--[\s\S]*?-->/gu, '');
  // Ticking the wrong thing on LinkedIn's page is the difference between a file
  // in ten minutes and a file tomorrow, and it cannot be corrected — you request
  // again. So it is a numbered list, like the Full Disk Access steps.
  const steps = [...visible.matchAll(/<li>([\s\S]*?)<\/li>/gu)].map((m) => m[1]);
  assert.equal(steps.length, 3, 'the guidance is three lines');
  assert.match(steps[0], /connections/u, 'which box to tick');
  assert.match(steps[1], /request/u, 'and the press that sends it');
  assert.match(steps[2], /ten\s+minutes/u, 'and how long it takes');
  assert.match(steps[2], /day/u, 'including the full archive, which does not take ten minutes');
  // Three doors, and the one that goes on is not called "skip" any more: with
  // the file arriving later by design, going on is the ordinary path.
  assert.match(visible, /id="linkedInRequest">request a copy</u);
  assert.match(visible, /id="linkedInPick">i have it</u);
  assert.match(visible, /id="linkedInSkip">later</u);
});

// -------------------------------------------------- (2) the file finds you

test('the watcher does not run for a Mac that already has an export', () => {
  const begin = /func begin\(bridge: Bridge\) \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '';
  assert.ok(begin, 'ExportWatch.begin not found');
  assert.match(code(begin), /guard !Bridge\.linkedInExportInstalled else \{ return \}/u,
    'an owner who imported months ago must never meet the Downloads prompt at all');
  // ...and the check is the import's own rule, not fileExists: a file the
  // connector cannot read is not an export the owner has.
  const installed = /static var linkedInExportInstalled: Bool \{([\s\S]*?)\n  \}/u
    .exec(bridge)?.[1] ?? '';
  assert.match(installed, /linkedInKind\(of: head\)/u);
  assert.match(installed, /kind\.name == "Connections\.csv"/u);
});

test('it watches Downloads and Desktop, and takes a denial silently', () => {
  assert.match(watch, /appendingPathComponent\("Downloads", isDirectory: true\)/u);
  assert.match(watch, /appendingPathComponent\("Desktop", isDirectory: true\)/u);
  const w = /private func watch\(_ directory: URL\) \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '';
  assert.match(w, /open\(directory\.path, O_EVTONLY\)/u);
  assert.match(code(w), /guard fd >= 0 else \{/u,
    'a refused folder must not throw, prompt again, or disable the picker');
  assert.match(w, /DispatchSource\.makeFileSystemObjectSource/u);
  assert.match(w, /source\.setCancelHandler \{ close\(fd\) \}/u,
    'a cancelled source that leaks its descriptor is a file handle held forever');
});

test('it offers, and never imports on its own', () => {
  // A file appearing in Downloads is not consent to read it. Nothing in this
  // file may call the import except in answer to a press.
  const offer = /private func offer\(_ url: URL\) \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '';
  assert.match(offer, /ModelSetup\.notify/u, 'the app has one notifier, and this is it');
  assert.doesNotMatch(offer, /importLinkedIn/u);
  const scan = /private func scan\(\) \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '';
  assert.doesNotMatch(scan, /importLinkedIn/u, 'the scan may look at names and nothing else');
  // The one call there is, and what it is guarded on.
  const press = /didReceive response: UNNotificationResponse,[\s\S]*?\n  \}/u.exec(watch)?.[0] ?? '';
  assert.match(press, /bridge\.importLinkedIn\(files: \[URL\(fileURLWithPath: path\)\]\)/u,
    'and it goes through the same import as the picker, not a looser one');
  assert.match(code(press), /identifier == Self\.importAction\s*\n\s*\|\| identifier == UNNotificationDefaultActionIdentifier/u,
    'a dismissal is not a yes');
});

test('the offer is a press the owner can actually give', () => {
  // A notification with no action on it is a notice, not an offer, and the
  // category has to be registered before one naming it is sent.
  assert.match(watch, /UNNotificationAction\(\n\s*identifier: Self\.importAction, title: "import"/u);
  assert.match(watch, /center\.setNotificationCategories\(/u);
  assert.match(watch, /center\.delegate = self/u, 'or the press is delivered to nobody');
  // ModelSetup.notify is the app's one notifier and now carries a category.
  // Every existing caller passes neither argument and is unchanged.
  const notify = /static func notify\(title: String, body: String,([\s\S]*?)\n  \}/u
    .exec(read('widget/src/ModelSetup.swift'))?.[1] ?? '';
  assert.match(notify, /category: String\? = nil/u);
  assert.match(notify, /userInfo: \[String: Any\] = \[:\]/u);
});

test('it stops once there is an export, by either route', () => {
  assert.match(watch, /func stop\(\)/u);
  const report = /private func report\(_ out: \[String: Any\]\) \{([\s\S]*?)\n  \}/u
    .exec(watch)?.[1] ?? '';
  assert.match(report, /state == "ok"[\s\S]{0,400}stop\(\)/u,
    'an import that landed is the end of this watcher');
  const scan = /private func scan\(\) \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '';
  assert.match(code(scan), /if Bridge\.linkedInExportInstalled \{ stop\(\); return \}/u,
    'and so is one that landed some other way — the picker, the settings row, a drop');
  // Started at launch, after the gate above.
  assert.match(code(mainSwift), /ExportWatch\.shared\.begin\(bridge: self\.bridge\)/u);
});

test('the names it reacts to are the ones LinkedIn actually sends', () => {
  const looks = /static func looksLikeExport\(_ name: String\) -> Bool \{([\s\S]*?)\n  \}/u
    .exec(watch)?.[1] ?? '';
  assert.ok(looks, 'looksLikeExport not found');
  // Complete_ and Basic_ are the two archives; both hold Connections.
  assert.match(looks, /linkedindataexport/u);
  // Exact on the CSV, because "connections" on its own is an ordinary word and
  // a loose match would offer to import somebody's spreadsheet.
  assert.match(looks, /stem == "connections"/u);
  assert.match(looks, /connections \(/u, "and the browser's second download of one");
});

// -------------------------------------------------- (3) the settings row

test('the settings row is one line, and the line is the control', () => {
  assert.match(connectionsJs, /rows\.push\(linkedInRow\(\)\)/u, 'the row is not rendered');
  const row = /function linkedInRow\(\) \{([\s\S]*?)\n\}/u.exec(connectionsJs)?.[1] ?? '';
  assert.ok(row, 'linkedInRow() not found');
  // ONE LINE. Every row in this panel is a bold name and its control, and the
  // owner rejected paragraphs here on 2026-09-13 in those words.
  assert.match(row, /row\.className = 'setting';/u);
  assert.doesNotMatch(code(row), /setting-note|setting-col/u,
    'a line under the name is the one thing this panel does not do any more');
  assert.match(connectionsJs, /LINKEDIN_WAITING = 'waiting for your file · drop it here'/u);
  // ...and the installed state is counts and a date, which is all linkedInState
  // will tell a page about that file.
  assert.match(row, /connections\$\{dated\}/u);
  assert.match(row, /hzPost\('linkedInState'\)/u);
  assert.match(row, /hzPost\('importLinkedIn'\)/u, 'pressing the line opens the picker');
  // Every refusal is a few words on the line and the sentence on the hover,
  // because the row may not grow to hold a remedy.
  assert.match(connectionsJs, /const LINKEDIN_REFUSALS = \{/u);
});

test('the page is allowed to ask what is installed', () => {
  const caps = /"connections": \[([\s\S]*?)\],\n/u.exec(bridge)?.[1] ?? '';
  assert.ok(caps.includes('"linkedInState"'),
    'the row would render "waiting" forever on a Mac that has the file');
  assert.ok(caps.includes('"importLinkedIn"'));
});

test('a dropped file is taken natively, because a page never sees its path', () => {
  // WebKit hands JavaScript a File object with bytes and a name and no
  // location. Reading the bytes in the page and posting them would put the
  // owner's whole professional graph through the bridge, which is the thing
  // linkedInState's counts-only rule exists to prevent.
  assert.match(windows, /var onFileDrop: \(\(\[URL\]\) -> Bool\)\?/u);
  assert.match(windows, /override func performDragOperation\(_ sender: NSDraggingInfo\) -> Bool/u);
  assert.match(windows, /urlReadingFileURLsOnly/u);
  // Anything the handler does not claim behaves exactly as WebKit always did.
  assert.match(windows, /return super\.performDragOperation\(sender\)/u);
  // Installed on the settings panel only, and it goes through the same import.
  const install = /\(connectionsPanel\?\.contentView as\? ClickThroughWebView\)\?\.onFileDrop = \{([\s\S]*?)\n      \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.ok(install, 'the drop handler is not installed on the connections panel');
  assert.match(install, /ExportWatch\.looksLikeExport/u,
    'a drag of something else must fall through to WebKit');
  assert.match(install, /self\.bridge\.importLinkedIn\(files: wanted\)/u);
  assert.equal((mainSwift.match(/onFileDrop = /gu) ?? []).length, 1,
    'one page takes file drops, and it is the one with the picker on it');
});

test('an import nobody started here still repaints the surfaces that show it', () => {
  // The watcher's notification and a drop both land with no page involved, and
  // both surfaces read the export's state once, on entry.
  assert.match(bridge, /func linkedInExportChanged\(\)/u);
  assert.match(code(mainSwift), /window\.__hzLinkedInChanged/u);
  assert.match(connectionsJs, /window\.__hzLinkedInChanged = \(\)/u);
  assert.match(onboardingJs, /window\.__hzLinkedInChanged = \(\)/u);
  assert.match(onboardingJs, /if \(currentScreen !== '4'\) return;/u,
    'and the onboarding page only acts on it while that screen is up');
});

// -------------------------------------------------- (4) the mode fallback

test('the card says why the lit chip is not the card in hand', () => {
  const show = /function showModeFallback\(out\) \{([\s\S]*?)\n\}/u.exec(reconnectJs)?.[1] ?? '';
  assert.ok(show, 'showModeFallback() not found');
  assert.match(show, /out\?\.modeFallback === 'linkedin-pending'/u);
  assert.match(show, /cards start when your linkedin export lands/u);
  // 'any' needs no export, so the sentence would be false for it.
  assert.match(show, /mode !== 'any'/u);
  // Under the chips, which is what the line is about, and outside #rcCard,
  // because it is equally true of the empty state.
  const modesAt = reconnectHtml.indexOf('id="rcModes"');
  const lineAt = reconnectHtml.indexOf('id="rcFallback"');
  const cardAt = reconnectHtml.indexOf('id="rcCard"');
  assert.ok(modesAt > -1 && lineAt > modesAt && lineAt < cardAt);
  // Cleared on every answer, or it outlives the reply it describes.
  assert.match(reconnectJs, /showModeFallback\(out\);/u);
  const empty = /function renderEmpty\(out\) \{([\s\S]*?)\n\}/u.exec(reconnectJs)?.[1] ?? '';
  assert.match(empty, /showModeFallback\(out\)/u,
    'the two unreachable paths reach renderEmpty without passing pull()’s call');
});

// A HELD PICK MUST NOT BECOME A CHANGED ONE.
//
// ~~`assert.doesNotMatch(adoptServerMode, /modeFallback/)`~~ stood here and
// passed while the bug was live, which is the whole reason this test is written
// the other way round now. A fallback reply is `servedMode: 'any'` with `mode`
// still the owner's investor or founder and no `oneOff` — nobody asked for this
// widening — and adoptServerMode preferred servedMode on exactly that shape. It
// would have moved the picker to `any` and called writeMode: the owner's
// standing choice replaced permanently because a file had not arrived, under a
// line telling them their pick was merely being held.
//
// An assertion that something is ABSENT is true of a feature that does not
// exist yet and of a bug that has not been fixed. This one names the guard.
test('a fallback does not move the picker, the way a one-off does not', () => {
  const adopt = /function adoptServerMode\(out\) \{([\s\S]*?)\n\}/u.exec(reconnectJs)?.[1] ?? '';
  assert.ok(adopt, 'adoptServerMode() not found');
  assert.match(code(adopt),
    /const held = out\?\.oneOff === true \|\| typeof out\?\.modeFallback === 'string';/u,
    'the two cases are one rule: the server served something the owner did not pick');
  assert.match(code(adopt), /const fromServer = held\s*\n\s*\? \(MODES\.includes\(out\?\.mode\)/u,
    'and a held reply reads `mode`, which is the standing pick, never servedMode');
  // The write is what makes getting this wrong permanent rather than cosmetic.
  assert.match(adopt, /writeMode\(fromServer\)/u);
});

test('the fallback sentence rides the reason the server actually sends', () => {
  // THE BRANCH THIS LIVED IN COULD NEVER RUN. hermes suppresses
  // 'pool-exhausted-mode' while the pick is held — under the fallback the serve
  // mode is already 'any', so there is nothing to widen to and no counts to
  // report — and sends a plain 'pool-exhausted' with the flag on it instead.
  // The first version of this branch sat in paintModeShortfall, which peekCard
  // only reaches from 'pool-exhausted-mode': the sentence existed, the test
  // passed, and nothing could ever have painted it.
  const peek = /function peekCard\(out, \{ fromOneOff = false \} = \{\}\) \{([\s\S]*?)\n\}/u
    .exec(onboardingJs)?.[1] ?? '';
  assert.ok(peek, 'peekCard() not found');
  const exhausted = peek.indexOf("out.reason === 'pool-exhausted'");
  const modeExhausted = peek.indexOf("out.reason === 'pool-exhausted-mode'");
  const pending = peek.indexOf('linkedInPending(out)');
  assert.ok(exhausted > -1 && pending > exhausted && pending < modeExhausted,
    'the flag has to be read on the plain pool-exhausted branch, which is where it arrives');
  // Its own line, under whatever the status says: the house being empty and the
  // owner's group waiting on a file are both true, and only one is actionable.
  assert.match(peek, /if \(linkedInPending\(out\)\) paintModeShortfall\(out\);/u);
  const sprint = peek.indexOf('if (readerSprinting)', exhausted);
  assert.ok(sprint > pending, 'the sentence must be painted before the branch that returns');
});

test('the screen does not offer a widening that has already happened', () => {
  // Under the fallback hermes is serving from `any` already, and a one-off peek
  // NAMES a mode, which suppresses the fallback and comes back with the same
  // empty answer. The button could not change the screen it is on.
  const paint = /function paintModeShortfall\(out\) \{([\s\S]*?)\n\}/u.exec(onboardingJs)?.[1] ?? '';
  const pendingBranch = paint.slice(paint.indexOf('linkedInPending(out)'), paint.indexOf('const mode ='));
  assert.match(pendingBranch, /loadAnyMode\.hidden = true/u);
  // ...and it is still offered for the ordinary empty-mode case, which is what
  // it was built for.
  assert.match(paint.slice(paint.indexOf('const mode =')), /loadAnyMode\.hidden = false/u);
});

test('screen 6 says the same thing instead of blaming the history', () => {
  // "nobody quiet who is an investor yet" is true and useless: there is no
  // amount of reading that will produce an investor without the export.
  const paint = /function paintModeShortfall\(out\) \{([\s\S]*?)\n\}/u.exec(onboardingJs)?.[1] ?? '';
  assert.ok(paint, 'paintModeShortfall() not found');
  assert.match(paint, /linkedInPending\(out\)/u);
  assert.match(onboardingJs, /cards start when your linkedin export lands/u);
  // It replaces that sentence rather than joining it: the shortfall line is
  // returned from before the "nobody quiet" text is built.
  const pendingAt = paint.indexOf('linkedInPending(out)');
  const nobodyAt = paint.indexOf('nobody quiet');
  assert.ok(pendingAt > -1 && nobodyAt > pendingAt,
    'the fallback branch has to come first, or it can never paint');
});

test('the card and the first-load screen say it in the same words', () => {
  // Two wordings for one cause is two explanations, and the owner only gets to
  // believe one of them.
  const line = /cards start when your linkedin export lands/u;
  assert.match(reconnectJs, line);
  assert.match(onboardingJs, line);
  const shape = /\$\{mode\} cards start when your linkedin export lands/u;
  assert.match(reconnectJs, shape);
  assert.match(onboardingJs, shape);
});

// -------------------------------------------------- the export is ready

test('the widget gets one field, not the connector shelf', () => {
  const body = code(swiftCase('linkedInReady'));
  assert.match(body, /\$0\["id"\] as\? String == "linkedin-export"/u);
  assert.match(body, /row\?\["linkedinExportReady"\] as\? Double/u);
  // ONE FIELD OUT. The widget page must not be handed the whole status payload
  // just because the timestamp travels on it.
  assert.doesNotMatch(body, /self\.reply\(webView, id, data\)/u);
  assert.match(body, /out\["readyTs"\]/u);
  const caps = /"widget": \[([\s\S]*?)\],\n/u.exec(bridge)?.[1] ?? '';
  assert.ok(caps.includes('"linkedInReady"'));
  assert.ok(!caps.includes('"status"'), 'the shelf itself stays out of the widget');
});

test('nothing in Swift reads the marker file', () => {
  // connectors/lib/linkedinExport.mjs owns that note's whole lifetime: it
  // refuses to answer once an export is installed, and the linkedin connector
  // deletes it on the first run that sees one. A second reader with its own
  // idea of when the note is spent is how two surfaces come to disagree about
  // whether the owner still has an errand.
  for (const [name, src] of [['Bridge.swift', bridge], ['ExportWatch.swift', watch],
    ['main.swift', mainSwift]]) {
    assert.doesNotMatch(code(src), /export-ready\.json/u,
      `${name} reads the marker directly instead of asking the route that owns it`);
  }
});

test('the gear says which errand its glow is about, and takes it back', () => {
  const widgetJs = read('widget/ui/widget.js');
  assert.match(widgetJs, /hzPost\('linkedInReady'\)/u);
  assert.match(widgetJs, /your export is ready — open the email/u);
  // A TIMESTAMP IS THE WHOLE CONDITION. exportReadyAt answers null once the
  // export is installed, so the page has no second fact to combine and no way
  // to badge an errand already run.
  const check = /function checkLinkedInReady\(\) \{([\s\S]*?)\n\}/u.exec(widgetJs)?.[1] ?? '';
  assert.match(check, /Number\.isFinite\(Number\(out\?\.readyTs\)\)/u);
  assert.match(check, /window\.__hzGearNudge\(true\)/u);
  // The glow going off takes the sentence with it, or the hover keeps making a
  // claim after the thing that made it has gone.
  const nudge = /window\.__hzGearNudge = \(on\) => \{([\s\S]*?)\n\};/u.exec(widgetJs)?.[1] ?? '';
  assert.match(nudge, /if \(on !== true\) gearBtn\.title = 'Settings';/u);
  // Asked on load and on a wake -- the mail most likely arrived while the Mac
  // was asleep -- and never on a timer.
  assert.match(widgetJs, /__hzWake = \(\) => \{[^}]*checkLinkedInReady\(\);/u);
  assert.doesNotMatch(check, /setInterval/u);
});

test('the settings row rides the fetch the panel already makes', () => {
  assert.match(connectionsJs, /const LINKEDIN_READY = 'your export is ready — open the email'/u);
  // ONE READER OF THE NOTE ON THIS PAGE. refresh() asks connect for the shelf
  // on every open and every focus, and the timestamp is a field on the row it
  // already has -- a second bridge call would be two readers of one note.
  const refresh = /async function refresh\(\) \{([\s\S]*?)\n\}/u.exec(connectionsJs)?.[1] ?? '';
  assert.match(refresh, /\(data\.sources \?\? \[\]\)\.find\(\(s\) => s\.id === LINKEDIN_EXPORT_ID\)/u);
  assert.match(refresh, /noteLinkedInReady\(row\?\.linkedinExportReady \?\? null\)/u);
  // Off the raw sources, not the visible set: hiding the shelf tile does not
  // stop the owner waiting on the file, and the settings row is shown either way.
  assert.doesNotMatch(refresh.slice(0, refresh.indexOf('noteLinkedInReady')),
    /visibleSources[\s\S]*?noteLinkedInReady/u);
  // An installed export outranks both waiting lines, whichever answer lands
  // second -- the two facts arrive from different places at different times.
  const row = /function linkedInRow\(\) \{([\s\S]*?)\n\}/u.exec(connectionsJs)?.[1] ?? '';
  assert.match(row, /if \(installed\) return;/u);
  assert.match(row, /if \(readyTs !== null\) \{ say\(LINKEDIN_READY/u);
  // ...and null is an answer too, or the row keeps saying "open the email"
  // after the owner has.
  assert.match(row, /readyTs = Number\.isFinite\(Number\(ts\)\) \? Number\(ts\) : null;/u);
});

// -------------------------------------------------- the extraction, for real

// THE ONE TEST HERE THAT RUNS SOMETHING.
//
// Everything above is a source scan, because the Swift needs a toolchain and an
// AppKit session. The extraction does not: it is one `/usr/bin/unzip` invocation
// whose exact argv is written down in Bridge.swift, and the question that
// matters — does THAT argv pull exactly Connections.csv out of an archive shaped
// like LinkedIn's — is answerable here against a real archive.
//
// It is a genuine discriminator rather than a restatement. The export holds
// Profile.csv and Contacts.csv, both carrying an exact `First Name` column, and
// either of them landing at the destination destroys a good import. A pattern
// with a wildcard in it, or a rule that matched an entry's basename rather than
// its whole path, would pass a reading of the code and fail here.
const ZIP_ARGV = /arguments = \["-p", zip\.path, "([^"]+)"\]/u.exec(bridge)?.[1];

const haveZip = (() => {
  try {
    execFileSync('/usr/bin/zip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

test('the argv in Bridge.swift pulls Connections.csv and nothing else', { skip: !haveZip && 'no /usr/bin/zip on this machine' }, () => {
  assert.ok(ZIP_ARGV, 'the unzip invocation is gone or has changed shape');
  const dir = mkdtempSync(join(tmpdir(), 'hazlie-zip-'));
  try {
    // An archive shaped like LinkedIn's: the file we want, the two decoys that
    // share its anchor column, and a same-named entry one level down.
    const connections = 'First Name,Last Name,URL,Connected On\nAda,L,https://x/in/a,01 Jan 2020\n';
    writeFileSync(join(dir, 'Connections.csv'), connections);
    writeFileSync(join(dir, 'Profile.csv'), 'First Name,Last Name,Headline\nP,Q,r\n');
    writeFileSync(join(dir, 'Contacts.csv'), 'First Name,Last Name,Profile URL\nC,D,https://y\n');
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'Connections.csv'), 'NOT,THE,ONE\n');
    execFileSync('/usr/bin/zip', ['-q', '-r', 'export.zip',
      'Connections.csv', 'Profile.csv', 'Contacts.csv', 'nested'], { cwd: dir });

    const out = execFileSync('/usr/bin/unzip',
      ['-p', join(dir, 'export.zip'), ZIP_ARGV], { encoding: 'utf8' });
    assert.equal(out, connections,
      'the extraction took something other than the root Connections.csv');
    assert.doesNotMatch(out, /Headline|Profile URL|NOT,THE,ONE/u,
      'a decoy came out of the archive alongside it');

    // ...and the archive that opened fine with no Connections.csv in it, which
    // is the owner asking LinkedIn for the wrong thing. unzip answers 11, and
    // Bridge.swift keys its separate sentence on exactly that.
    execFileSync('/usr/bin/zip', ['-q', 'partial.zip', 'Profile.csv'], { cwd: dir });
    let status = 0;
    try {
      execFileSync('/usr/bin/unzip', ['-p', join(dir, 'partial.zip'), ZIP_ARGV],
        { stdio: 'ignore' });
    } catch (e) { status = e.status; }
    assert.equal(status, 11);
    assert.match(bridge, /terminationStatus == 11[\s\S]{0,120}return \.notFound/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
