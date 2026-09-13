// THE TWO HALVES OF "THE FILE FINDS YOU" THAT TOUCH THE REST OF THE MACHINE.
//
// The picker is a picker: the owner points at a file and the import checks it.
// These two are not. A drop hands a webview an arbitrary file the owner aimed
// at a settings panel, and the watcher opens two of the owner's folders and
// then talks to them unprompted. Both were written as if the happy path were
// the only path, and a contrarian review (2026-09-13) found what that cost:
//
//   1  a drop the export filter REJECTED fell through to WebKit, which
//      navigated the settings panel to the dropped file -- and the bridge
//      compartment is keyed on the VIEW, so the newly loaded document kept
//      `connections`: quitApp, uninstallApp, connectSecret, googleAuth. An
//      .html file dropped on the panel could call any of them.
//   2  the Downloads and Desktop consent dialogs fired from
//      applicationDidFinishLaunching -- i.e. over onboarding screens 1-3, while
//      screen 2 is telling its own story about a different grant -- and a
//      denial was permanent for the process.
//   3  neither the feature registry nor "this owner already has an export" was
//      consulted before any of that happened.
//
// Everything here is a source scan; a drag and a TCC dialog are live gestures
// with no surface to pin from node.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const bridge = read('widget/src/Bridge.swift');
const mainSwift = read('widget/src/main.swift');
const windows = read('widget/src/Windows.swift');
const watch = read('widget/src/ExportWatch.swift');
const connectionsJs = read('widget/ui/connections.js');
const onboardingJs = read('widget/ui/onboarding.js');
const widgetJs = read('widget/ui/widget.js');

/// These files' comments describe the very defects being pinned, and by house
/// convention the sentence each fix replaced.
const code = (text) => text
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
  .join('\n');

const swiftFunc = (src, signature) => {
  const re = new RegExp(`\\n  (?:@discardableResult\\n  )?(?:private |static |override )*func ${signature} \\{\\n([\\s\\S]*?)\\n  \\}\\n`, 'u');
  const m = re.exec(src);
  assert.ok(m, `${signature} not found`);
  return m[1];
};

// -------------------------------------------------- 1: the drop

test('an unmatched drop is refused, never handed to WebKit', () => {
  // WebKit's answer to a file drop on a page is to NAVIGATE to it. The panel
  // would become the dropped document, and Bridge.pageOf is keyed on the view
  // rather than the document, so that document inherits `connections` -- which
  // grants uninstallApp and quitApp. Dropping an .html file on the settings
  // panel was remote code with the owner's bridge attached.
  const perform = code(swiftFunc(windows, 'performDragOperation\\(_ sender: NSDraggingInfo\\) -> Bool'));
  // WebKit's own behaviour survives for every page that does NOT accept drops,
  // which is every page but this one -- so the super call may exist. What it
  // may not do is sit on a path reachable while a handler is installed: it is
  // the `else` of the guard that fails to find one, and there is no other.
  assert.match(perform,
    /guard let urls = droppedFiles\(sender\), let handler = onFileDrop else \{\n\s*return super\.performDragOperation\(sender\)\n\s*\}/u,
    'the only fall-through is the one taken when this view accepts no drops at all');
  assert.equal((perform.match(/super\.performDragOperation/gu) ?? []).length, 1,
    'a second fall-through is the bug coming back');
  // The handler no longer decides whether the drop is CONSUMED -- a `false`
  // from it is what used to mean "let WebKit have it" -- only what to do with
  // it. Its type is what enforces that.
  assert.match(perform, /handler\(urls\)\n\s*return true/u);
  assert.match(code(windows), /var onFileDrop: \(\(\[URL\]\) -> Void\)\?/u,
    'a Bool return is an invitation to write the fall-through again');
});

test('the panel is told when its drop was not an export', () => {
  // Swallowing the drop silently is the other half of the same bug: the owner
  // aimed a file at a row that says "drop it here" and nothing at all happened.
  const install = /onFileDrop = \{([\s\S]*?)\n      \}/u.exec(mainSwift)?.[1] ?? '';
  assert.match(install, /__hzLinkedInDropRefused/u,
    'an unmatched drop has to say so on the row the owner aimed at');
  assert.match(connectionsJs, /window\.__hzLinkedInDropRefused = /u);
  // The name goes through jsString, not interpolation: it is a filename off
  // the owner's disk on its way into a JavaScript string literal.
  assert.match(install, /jsString\(/u);
});

test('no webview may navigate to a file it was not built to show', () => {
  // The second fence behind finding 1, and the one that matters if any future
  // surface accepts a drop: `url?.isFileURL == true` allowed EVERY file on the
  // disk. A page is built from one URL in the bundle and never navigates again.
  const policy = /func webView\(\n\s*_ webView: WKWebView, decidePolicyFor navigationAction[\s\S]*?\n  \}/u
    .exec(bridge)?.[0] ?? '';
  assert.ok(policy, 'the navigation policy is gone');
  assert.doesNotMatch(code(policy), /url\?\.isFileURL == true$/mu,
    'any file URL is not a policy');
  assert.match(code(policy), /allowedDocument/u,
    'the allowed document is the one this view was registered with');
  // Registered when the view is built, beside the compartment it shares a
  // lifetime with.
  assert.match(bridge, /func register\(_ webView: WKWebView, as page: String, document: URL\?/u);
});

// -------------------------------------------------- 2 and 3: when it may start

test('the watcher does not open a folder during the setup flow', () => {
  // The two consent dialogs arrived over screens 1-3, with no context, while
  // screen 2 is explaining a DIFFERENT grant. The owner has not been asked for
  // the export yet at that point, so the prompt is for an errand they have not
  // heard of.
  const launch = code(mainSwift);
  assert.match(launch,
    /guard Bridge\.onboarded else \{ return \}\n\s*ExportWatch\.shared\.begin\(bridge: self\.bridge\)/u,
    'at launch it may only start for an owner who has already finished the flow');
  assert.equal((launch.match(/ExportWatch\.shared\.begin/gu) ?? []).length, 1,
    'a second launch-time start would walk straight past that guard');
});

test('screen 4 is what starts it for a first-run owner', () => {
  // "later" means later, not never: it is the answer that most needs a watcher.
  // The prompt then lands on the one screen that has just explained the file.
  assert.match(onboardingJs, /hzPost\('watchForExport'\)/u);
  const skip = /document\.getElementById\('linkedInSkip'\)\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\}\);/u
    .exec(onboardingJs)?.[1] ?? '';
  assert.match(code(skip), /armExportWatch\(\)/u, '"later" is the answer that most needs it');
  const request = /linkedInRequest\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\}\);/u
    .exec(onboardingJs)?.[1] ?? '';
  assert.match(code(request), /armExportWatch\(\)/u, 'and so is asking LinkedIn for the file');
  assert.match(onboardingJs, /const armExportWatch = \(\) => \{ hzPost\('watchForExport'\)/u);
  // "i have it" must NOT arm it: that path ends with an export installed, and
  // ExportWatch refuses to start for one anyway.
  const pick = /linkedInPick\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\}\);/u
    .exec(onboardingJs)?.[1] ?? '';
  assert.doesNotMatch(code(pick), /armExportWatch/u);
  const caps = /"onboarding": \[([\s\S]*?)\],\n/u.exec(bridge)?.[1] ?? '';
  assert.ok(caps.includes('"watchForExport"'));
});

test('a registry with linkedin off gets no watcher and no prompt', () => {
  // The same flag that hides the tile entirely. An owner whose install does not
  // run the linkedin connector must not be asked for their Downloads folder on
  // its behalf, and must never be offered an import for it.
  const begin = swiftFunc(watch, 'begin\\(bridge: Bridge\\)');
  assert.match(code(begin), /Features\.connector\("linkedin"\) != \.off/u);
});

test('a denial is not permanent for the process', () => {
  // `started` was set before anything was opened and never reset, so a denial
  // at launch meant granting the folder later in System Settings did nothing
  // until relaunch -- while screen 4 goes on promising "leave it in your
  // downloads and i'll offer to take it".
  const begin = swiftFunc(watch, 'begin\\(bridge: Bridge\\)');
  assert.doesNotMatch(code(begin), /started = true\n\s*\n?\s*(?:let center|for directory)/u,
    'nothing may be marked started before a folder has actually opened');
  assert.match(code(watch), /let opened = self\.sources\.isEmpty == false/u,
    'started has to mean "a folder is open", so a later attempt can try again');
  assert.match(code(watch), /self\.watching = opened/u);
  // The two permanent refusals are a different flag, so a denial cannot be
  // mistaken for one of them.
  assert.match(code(watch), /guard !finished, !watching else \{ return \}/u);
  assert.match(code(watch), /finished = true/u);
});

// -------------------------------------------------- 4, 11, 12: what it offers

test('a file still being written does not spend the one offer', () => {
  // Writing bytes into an existing file does not touch the DIRECTORY vnode, so
  // the 3s settle measured from the last directory event fires while a download
  // is still running: the scan sees a partial archive with size > 0, offers it,
  // the import answers "i couldn't open that zip", and the path is in `offered`
  // for the rest of the run.
  const scan = code(swiftFunc(watch, 'scan\\(\\)'));
  // Measured against the LAST LOOK, not against the clock: a file whose size has
  // not moved since the previous scan has stopped being written.
  assert.match(scan, /let previous = seen\[found\.url\.path\]/u);
  assert.match(scan, /guard let previous, previous\.size == size else \{ settleAgain\(\); continue \}/u,
    'a file that grew between two looks must not be offered');
  assert.match(code(watch), /private func settleAgain\(\)/u,
    'and the scan has to re-look on its own, because no directory event is coming');
  // Neither the zero-byte case nor the growing case marks the file offered, so
  // a partial download cannot spend the one offer it gets.
  const offeredAt = scan.indexOf('Self.offeredKeys = already.union');
  assert.ok(offeredAt > scan.indexOf('previous.size == size'),
    'nothing may be recorded as offered before it has been found to be still');
});

test('what was offered is remembered by what it was, not only where', () => {
  // A failed import must not burn the path forever -- the same file finishing
  // its download is a different file. Keyed on size and mtime as well, which is
  // also what stops the same unchanged file being offered twice.
  assert.match(code(watch), /func offerKey\(/u);
  assert.match(code(watch), /\\\(size\)\|\\\(/u, 'the key carries the size and the date');
});

test('an offer survives a relaunch, so "no" stays no', () => {
  // `offered` was per-process: an owner who ignored the banner, or who keeps an
  // unrelated Connections.csv on their Desktop, met it again at every launch.
  assert.match(watch, /UserDefaults/u);
  assert.match(code(watch), /offeredDefaultsKey/u);
});

test('an old archive is offered with its date on it', () => {
  // The `newer` refusal in acceptLinkedInFiles only compares against an
  // INSTALLED export, and a fresh Mac has none -- so a year-old zip left in
  // Downloads imports on one press and the connector ingests a year-old graph
  // as current. It cannot be refused outright (an owner restoring a Mac may
  // mean it), so the banner says how old it is and the press is informed.
  const offer = swiftFunc(watch, 'offer\\(_ url: URL, vintage: Date\\?\\)');
  assert.match(code(offer), /DateFormatter|formatted\(/u,
    'the offer has to be able to say when the file is from');
});

// -------------------------------------------------- 10: one import at a time

test('the three ways in cannot run the import at the same time', () => {
  // The picker, the notification press and the panel drop all stage through the
  // same Connections.csv.importing and .previous paths, and the staging step
  // removes an existing .importing unconditionally -- so an overlapping call
  // can delete another's staged copy between its stage and its swap. The
  // function's own docstring describes this hazard and defends only within one
  // call.
  assert.match(code(bridge), /private static let importLock = NSLock\(\)/u);
  const accept = /private func acceptLinkedInFiles\(_ urls: \[URL\]\) -> \[String: Any\] \{([\s\S]*?)\n  \}/u
    .exec(bridge)?.[1] ?? '';
  assert.match(code(accept), /Bridge\.importLock\.lock\(\)/u);
  assert.match(code(accept), /defer \{ Bridge\.importLock\.unlock\(\) \}/u,
    'every return in that function is an early return; only a defer covers them all');
});

// -------------------------------------------------- 20: the gear

test('one glow, two errands, and neither hides the other', () => {
  // checkLinkedInReady only ever turned the nudge ON, so the glow outlived the
  // errand -- and it shared the hover with the onboarding handoff, so whichever
  // spoke last owned the sentence and the other errand went invisible.
  assert.match(widgetJs, /const gearErrands = new Set\(\)/u);
  // Each errand is named, so turning one off cannot take the other's glow.
  assert.match(widgetJs, /gearBtn\.classList\.toggle\('nudge', gearErrands\.size > 0\)/u);
  assert.match(widgetJs, /window\.__hzGearNudge = \(on\) => setGearErrand\('handoff', on === true\)/u,
    'the onboarding handoff is one errand among them, not the owner of the class');
  const check = code(/function checkLinkedInReady\(\) \{([\s\S]*?)\n\}/u.exec(widgetJs)?.[1] ?? '');
  // A null answer is an answer: it takes the errand back. Returning early there
  // is what let the glow outlive the thing it was about.
  assert.match(check, /setGearErrand\('linkedin', Number\.isFinite\(Number\(out\?\.readyTs\)\)\)/u);
  // ...but a reply that never came is not. A reader still starting up has no
  // opinion about the owner's inbox and must not clear a glow on its silence.
  assert.match(check, /if \(out\?\.state !== 'ok'\) return;/u);
  // Most specific sentence wins, in a fixed order -- "whichever spoke last" is
  // the bug being fixed, and "Settings" is not a sentence.
  assert.match(widgetJs, /\['linkedin', 'your export is ready — open the email'\],\n\s*\['handoff', 'Settings'\],/u);
});
