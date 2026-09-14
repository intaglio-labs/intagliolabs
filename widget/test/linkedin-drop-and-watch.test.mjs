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
  assert.match(scan, /previous\.size == size, previous\.at == found\.at else \{/u,
    'a file that grew between two looks must not be offered');
  assert.match(code(watch), /private func settleAgain\(for path: String\)/u,
    'and the scan has to re-look on its own, because no directory event is coming');
  // Neither the zero-byte case nor the growing case marks the file offered, so
  // a partial download cannot spend the one offer it gets.
  const offeredAt = scan.indexOf('offering = key');
  assert.ok(offeredAt > scan.indexOf('previous.size == size'),
    'nothing may be offered before it has been found to be still');
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
  const offer = swiftFunc(watch, 'offer\\(_ url: URL, vintage: Date\\?, in directory: URL, key: String\\)');
  assert.match(code(offer), /DateFormatter/u,
    'the offer has to be able to say when the file is from');
  // ...and the panel says it too, not only the banner that may never arrive.
  assert.match(code(offer), /dated: dated/u);
});

// -------------------------------------------------- the offer has to be SEEN

// THE ONLY VISIBLE OUTCOME OF "FOUND YOUR EXPORT" WAS NOTHING.
//
// Live on the recorded run (a9d5d01): the watcher found three archives in
// ~/Downloads and wrote all three into HazlieLinkedInOffered -- so offer() ran
// three times -- and no banner ever appeared, before or after the owner allowed
// notifications, with nothing from usernotifications in the system log for the
// bundle. Whatever was wrong there is on the far side of an API this app cannot
// see into, and that is the point: a feature whose entire output is a system
// notification has no output at all on a Mac where notifications do not arrive.
//
// So the offer is made IN the app, where this code can actually put it on
// screen, and the notification is a bonus for the Macs that deliver it. The
// offers are also SPENT either way -- a recorded offer nobody saw is the bug
// being fixed, so the record has to follow the thing the owner can see.
test('an export found raises an in-app offer, not only a notification', () => {
  const offer = /private func offer\(_ url: URL, vintage: Date\?, in directory: URL, key: String\) \{([\s\S]*?)\n  \}/u
    .exec(watch)?.[1] ?? '';
  assert.ok(offer, 'offer() not found');
  assert.match(code(offer), /linkedInExportFound/u,
    'the offer has to reach a surface this app draws itself');
  assert.match(code(offer), /ModelSetup\.notify/u, 'and the banner stays, for the Macs that show it');
  // The bridge holds what is being offered, and the panel asks for it.
  assert.match(bridge, /func linkedInExportFound\(/u);
  assert.match(bridge, /case "exportOffer":/u);
  assert.match(bridge, /case "exportDecide":/u);
  const caps = /"export": \[([\s\S]*?)\],\n/u.exec(bridge)?.[1] ?? '';
  assert.ok(caps.includes('"exportOffer"') && caps.includes('"exportDecide"'),
    'the offer panel has a compartment of its own');
  // ...and it is a narrow one: this page shows one sentence and posts one
  // verdict. It must not be able to reach the picker or anything else.
  assert.ok(!caps.includes('"importLinkedIn"'),
    'the panel answers yes or no; native owns the import');
});

test('the panel says which file, and where it came from', () => {
  const html = read('widget/ui/export.html');
  const js = read('widget/ui/export.js');
  // The owner has to be able to tell whether this is the archive they were
  // expecting before they say yes to it -- it is the whole difference between
  // an offer and an import that happened at them.
  assert.match(js, /hzPost\('exportOffer'\)/u);
  // Guarded, then read: an offer that is no longer there closes the panel
  // rather than drawing a card about nothing.
  assert.match(js, /typeof out\.name !== 'string' \|\| out\.name === ''/u);
  assert.match(js, /el\('exFile'\)\.textContent = out\.name/u);
  assert.match(js, /out\.folder/u, 'Downloads or Desktop -- the owner may have meant only one');
  assert.match(js, /out\.dated/u, 'and how old it is, which the notification already said');
  // Two answers, and "not this one" is a real answer that spends the offer.
  // One verdict verb, and the button decides which answer it carries.
  assert.match(js, /hzPost\('exportDecide', take === null \? \{\} : \{ take \}\)/u);
  assert.match(js, /addEventListener\('click', \(\) => decide\(true\)\)/u);
  assert.match(js, /decide\(false\)/u);
  assert.match(html, /id="exTake"/u);
  assert.match(html, /id="exSkip"/u);
  // textContent only, like every other page that renders a name off the disk.
  assert.doesNotMatch(js, /innerHTML/u);
  // AND IT HAS TO BE ABLE TO SIZE ITSELF. A panel that posts fitContent and is
  // not named in main.swift's table gets a silent no-op and stays at its base
  // height -- the comment above that table records exactly this happening to
  // the reconnect card. This panel's height is a filename the owner has never
  // seen before, so it is the last one that can be sized by guess.
  assert.match(js, /hzPost\('fitContent'/u);
  assert.match(mainSwift, /\(exportPanel, Self\.exportBase\),/u,
    'the export panel must be in the fitContent table, not only in the window list');
});

test('the widget lights up for it too, and puts the light out again', () => {
  // A panel can be behind something. The gear is always on the desktop, and it
  // already carries named errands, so this is one more rather than a new idea.
  assert.match(widgetJs, /__hzExportFound/u);
  assert.match(widgetJs, /setGearErrand\('export'/u);
  const found = /window\.__hzExportFound = \(([\s\S]*?)\n\};/u.exec(widgetJs)?.[1] ?? '';
  assert.match(found, /setGearErrand\('export', /u);
  assert.match(widgetJs, /\['export', 'found your linkedin export — import it\?'\]/u,
    'and the hover says which errand the glow is about');
});

// -------------------------------------------------- the scan has to run again

test('a file that changed without the folder changing is looked at again', () => {
  // THE BUG, EXACTLY. Touching an archive changes its mtime, which changes its
  // offer key -- so it SHOULD be offered again. It was not, and the key was
  // never the problem: a metadata change does not modify the directory's
  // contents, so the vnode source never fires, so scan() never runs to notice.
  // Nothing was re-evaluated, so nothing could be re-offered.
  assert.match(code(watch), /NSApplication\.didBecomeActiveNotification/u,
    'coming back to the app is a reason to look again');
  assert.match(code(watch), /private static let sweepSeconds/u);
  assert.match(code(watch), /60/u, 'and a slow sweep, for the app nobody activates');
  const sweep = /private func armSweep\(\) \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '';
  assert.ok(sweep, 'armSweep() not found');
  assert.match(code(sweep), /scan\(\)/u);
});

test('the offers it remembers are the most recent ones, not an arbitrary 200', () => {
  // `Set.suffix(200)` takes 200 of an UNORDERED collection: once the list is
  // full, which of the owner's answers survive a relaunch is whatever the hash
  // seed decided that day. Kept in order, newest last, and trimmed from the
  // front.
  const keys = /private static var offeredKeys: \[String\] \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '';
  assert.ok(keys, 'offeredKeys is no longer an ordered list');
  assert.doesNotMatch(code(keys), /Set\(/u, 'a Set has no newest');
});

// -------------------------------------------------- 3: asking to notify

test('notification permission is asked for, and the banner waits for the answer', () => {
  const notify = /static func notify\(title: String, body: String,([\s\S]*?)\n  \}/u
    .exec(read('widget/src/ModelSetup.swift'))?.[1] ?? '';
  assert.match(notify, /center\.requestAuthorization/u);
  // The add is INSIDE the authorization completion, so nothing is posted before
  // the owner has answered the prompt.
  const askAt = notify.indexOf('requestAuthorization');
  const addAt = notify.indexOf('center.add(');
  assert.ok(askAt > -1 && addAt > askAt, 'the post has to happen after the grant, not beside it');
  // AND A FAILURE HAS TO LEAVE A TRACE. `withCompletionHandler: nil` swallowed
  // every reason a notification did not appear, which is precisely the state
  // this run was in: three offers recorded, no banner, and nothing anywhere
  // saying why.
  assert.doesNotMatch(code(notify), /center\.add\(req, withCompletionHandler: nil\)/u,
    'a notification that fails silently is how "nothing happened" becomes unexplainable');
  assert.match(code(notify), /NSLog/u);
});

// -------------------------------------------------- the offer's lifetime

// AN OFFER IS SPENT WHEN IT IS ANSWERED, NOT WHEN IT IS MADE.
//
// Recording the key at offer time was wrong in three directions at once, and
// the closing review found all three:
//
//   the panel draws UNDER the onboarding scrim, so an owner who pressed
//   "later" with an archive already in Downloads had it offered, recorded and
//   never seen -- and the notification is then the only surface left, which is
//   the surface this whole batch exists because it does not arrive;
//   a FAILED import spends it, and the key is (path, size, mtime), none of
//   which a failure changes, so that archive is refused for the life of the
//   install;
//   and the ✕ spends it too, while never posting a verdict at all.
//
// So the key is written by the two answers that end an offer: an import that
// worked, and "not this one". Everything else leaves it re-offerable.
test('the offer key is written when the owner answers, not when we ask', () => {
  const scan = code(swiftFunc(watch, 'scan\\(\\)'));
  assert.doesNotMatch(scan, /rememberOffer/u,
    'the scan may not spend an offer the owner has not seen yet');
  // The two answers that end it, and nothing else.
  assert.match(code(watch), /func answerOffer\(_ key: String, keep: Bool\)/u);
  const decide = code(/case "exportDecide":([\s\S]*?)\n    case "/u.exec(bridge)?.[1] ?? '');
  assert.match(decide, /answerOffer/u, 'a verdict is what spends it');
  // A FAILED IMPORT IS NOT AN ANSWER. The archive is still there and still the
  // one the owner wanted; only a success ends the offer.
  assert.match(decide, /out\["state"\] as\? String == "ok"/u);
});

test('the ✕ is "not now", and the glow goes with it', () => {
  const js = read('widget/ui/export.js');
  // ~~`exClose` posted `close` alone~~, so pendingExport stayed set, the export
  // errand was never taken back, and the gear glowed forever with a hover
  // pointing at an offer nothing could re-present.
  assert.match(js, /el\('exClose'\)\.addEventListener\('click', \(\) => decide\(null\)\)/u,
    'the close box has to post a verdict, not just close the window');
  // Three answers now, and only two of them spend the offer.
  assert.match(js, /decide\(true\)/u);
  assert.match(js, /decide\(false\)/u);
  assert.match(code(bridge), /let take = payload\["take"\] as\? Bool/u);
  const decide = code(/case "exportDecide":([\s\S]*?)\n    case "/u.exec(bridge)?.[1] ?? '');
  assert.match(decide, /guard take == true else \{/u,
    '"not now" is a third answer, not a missing one');
  assert.match(decide, /keep: take == false/u,
    'and only the explicit "not this one" spends the offer');
  // Either way the panel and the glow go.
  assert.match(decide, /linkedInExportOfferClosed\(\)/u);
});

test('nothing is offered into a scrim the owner cannot see past', () => {
  // makePanel builds at .normal and the onboarding scrim is full-screen at
  // .floating, with the widget window ordered out for the flow's duration --
  // so both surfaces of the offer are invisible while the flow is open.
  const offered = /func linkedInExportOffered\(name: String\) \{([\s\S]*?)\n  \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.ok(offered, 'linkedInExportOffered not found');
  assert.match(code(offered), /guard !exportOfferIsCovered else \{/u,
    'the deferral test moved into one named predicate when the reconnect card\n' +
    'joined the scrim in front of this offer; see exportOfferIsCovered');
  const covered = /private var exportOfferIsCovered: Bool \{\n([\s\S]*?)\n  \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.ok(covered, 'exportOfferIsCovered not found');
  assert.match(code(covered), /onboardingPanel\?\.isVisible == true/u,
    'the scrim is still one of the things that covers it');
  assert.match(code(offered), /deferredExportOffer = name/u, 'held, not dropped');
  // ...and handed over when the flow ends, by whichever route it ends.
  assert.match(code(mainSwift), /func presentDeferredExportOffer\(\)/u);
  assert.match(code(mainSwift), /presentDeferredExportOffer\(\)/u);
});

// OOBE 2026-09-14, 12:24. The offer was presented while the reconnect card was
// up, and both are 340-wide popups that chosenFrame() sends through
// placedFrame() -- right edge pinned to the widget's, bottom to the strip above
// it. So the 340x200 offer sat entirely inside the 340x430 card: the window list
// had both at the same origin and a screenshot of the region had only the card.
// The owner found the offer by closing the card with its ✕.
test('an offer and the reconnect card never share the corner', () => {
  const covered = /private var exportOfferIsCovered: Bool \{\n([\s\S]*?)\n  \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.ok(covered, 'exportOfferIsCovered not found');
  assert.match(code(covered), /reconnectPanel\?\.isVisible == true/u,
    'a card on the corner is a reason to hold the offer, exactly as the scrim is');

  // ...and the other order, which the deferral alone cannot cover: the offer is
  // drawn and the card is then opened onto it. The card is a press and wins, so
  // the offer goes BACK to deferred rather than under the card.
  const open = /func openReconnect\(\) \{\n([\s\S]*?)\n  \}\n/u.exec(mainSwift)?.[1] ?? '';
  assert.ok(open, 'openReconnect not found');
  const asideAt = code(open).indexOf('standAsideForReconnectCard()');
  const presentAt = code(open).indexOf('present(reconnectPanel!)');
  assert.ok(asideAt > 0, 'the offer on screen has to be dealt with, not covered');
  assert.ok(asideAt < presentAt,
    'it stands aside BEFORE the card is presented; afterwards the offer has\n' +
    'already spent a frame underneath it');
  const aside = /private func standAsideForReconnectCard\(\) \{\n([\s\S]*?)\n  \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.ok(aside, 'standAsideForReconnectCard not found');
  assert.match(code(aside), /deferredExportOffer = presentedExportOffer/u,
    'the name has to survive the hide, or the offer comes back empty');
  assert.match(code(aside), /orderOut\(nil\)/u);

  // ...and it comes back when the card goes, by whichever route the card goes:
  // the ✕, a verdict, or a click outside. willOrderOut is the one hook all of
  // them pass through.
  //
  // A RUN-LOOP TURN LATER. AppKit takes the window down after willOrderOut
  // returns -- makePanel's own hook hops to main and says exactly this -- so a
  // synchronous call reads isVisible on a panel that is still visible and puts
  // the offer straight back into deferral, forever.
  const hook = /reconnectPanel!\.willOrderOut = \{ \[weak self\] in\n([\s\S]*?)\n      \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.ok(hook, 'the reconnect panel has no willOrderOut chain');
  assert.match(code(hook), /DispatchQueue\.main\.async \{ self\?\.presentDeferredExportOffer\(\) \}/u,
    'the card closing is the moment a held offer can be seen');
  // The scrim's own chain, named by the `reportPanels?()` it opens with --
  // makePanel sets a `p.willOrderOut` of its own and would match otherwise.
  const onboardingHook = /\n        reportPanels\?\(\)\n([\s\S]*?)\n      \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.match(code(onboardingHook), /DispatchQueue\.main\.async \{ self\?\.presentDeferredExportOffer\(\) \}/u,
    'the scrim\'s hook needs the same hop, now that the guard it feeds can refuse');

  // AND THE HOLD IS NOT A SPEND. ExportWatch writes the offer key on the ANSWER
  // and keeps `offering` set until then, so a held offer is still THE offer and
  // scan() finds nothing new behind it.
  assert.match(code(watch), /guard offering == nil else \{ return \}/u);
  const deferred = /func presentDeferredExportOffer\(\) \{\n([\s\S]*?)\n  \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.ok(deferred, 'presentDeferredExportOffer not found');
  assert.match(code(deferred), /guard !exportOfferIsCovered else \{ return \}/u,
    'a card that closed under the scrim, or reopened in the same turn, keeps the hold');
  // The answer is what ends it, and it clears both copies of the name.
  const closed = /func linkedInExportOfferClosed\(\) \{\n([\s\S]*?)\n  \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.ok(closed, 'linkedInExportOfferClosed not found');
  assert.match(code(closed), /deferredExportOffer = nil/u);
  assert.match(code(closed), /presentedExportOffer = nil/u);
});

test('a second find does not replace the offer being read', () => {
  // "One offer at a time" held only inside one scan(). Across scans the sweep
  // found the next archive, overwrote pendingExport and repainted the open
  // panel -- so the filename changed under the cursor, and a click landing
  // between the repaint and its round-trip imported a different file.
  const scan = code(swiftFunc(watch, 'scan\\(\\)'));
  assert.match(scan, /guard offering == nil else \{ return \}/u,
    'an offer on screen is a reason to find nothing new');
  assert.match(code(watch), /offering = key/u);
  assert.match(code(watch), /offering = nil/u, 'and it is cleared when the offer ends');
});

test('a background find does not pull the app in front of the owner', () => {
  // The sweep is most likely to fire while the owner is in the browser at
  // LinkedIn, which is where "request a copy" just sent them. present()
  // activates the app; a file-arrival notice may not.
  const show = /private func showExportOffer\(_ name: String\) \{([\s\S]*?)\n  \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.ok(show, 'showExportOffer not found');
  assert.doesNotMatch(code(show), /(?<!\w)present\(exportPanel!\)/u,
    'present() calls NSApp.activate(ignoringOtherApps:)');
  assert.match(code(mainSwift), /func presentWithoutStealingFocus\(/u);
  assert.match(code(show), /presentWithoutStealingFocus\(exportPanel!\)/u);
  // ...and the non-activating one does not activate.
  const quiet = /private func presentWithoutStealingFocus\(_ panel: PopupPanel\) \{([\s\S]*?)\n  \}/u
    .exec(mainSwift)?.[1] ?? '';
  assert.doesNotMatch(code(quiet), /NSApp\.activate/u);
  assert.match(code(quiet), /orderFrontRegardless\(\)/u);
});

test('the wait ends, the way the sentence about it does', () => {
  // An owner who pressed "later" and never imports was enumerated over two
  // folders every 60s, on every launch, for the life of the install -- while
  // hermes tells that same owner "your linkedin export never arrived" after a
  // week. The two must not disagree about whether the wait ever ends.
  assert.match(code(watch), /armedDefaultsKey/u, 'it has to know when it started waiting');
  assert.match(code(watch), /private static let giveUpAfter/u);
  const begin = /func begin\(bridge: Bridge\) \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '';
  assert.match(code(begin), /giveUpAfter/u);
});

test('a file that never stops growing stops being re-scanned', () => {
  // Both settle paths re-armed a 3s scan with no cap, so a name that keeps
  // being appended to re-enumerated both folders every three seconds forever
  // and never offered anything.
  assert.match(code(watch), /private static let settleAttempts/u);
  const settle = /private func settleAgain\(for path: String\) \{([\s\S]*?)\n  \}/u
    .exec(watch)?.[1] ?? '';
  assert.ok(settle, 'settleAgain no longer knows which file it is waiting on');
  assert.match(code(settle), /settleAttempts/u, 'and it gives up on that file');
});

test('turning the connector back on does not need a relaunch', () => {
  // `watching` is deliberately retryable because a denied folder can be
  // granted later. The registry is runtime-mutable in exactly the same way --
  // the settings shelf can switch linkedin back on -- so a registry refusal
  // must not be the permanent kind. The only permanent refusal is an export
  // that is already installed, which is the one condition that cannot revert.
  const begin = code(/func begin\(bridge: Bridge\) \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '');
  assert.doesNotMatch(begin, /Features\.connector\("linkedin"\) != \.off else \{ finished = true/u,
    'a registry refusal has to be retryable');
  assert.match(begin, /Features\.connector\("linkedin"\) != \.off else \{ return \}/u);
  assert.match(begin, /linkedInExportInstalled else \{ finished = true; return \}/u,
    'and the one that cannot revert is still the one that is permanent');
  // Something has to try again. Coming back to the app is the moment a
  // registry change or a folder grant has just happened.
  assert.match(code(watch), /self\?\.rearm\(\)/u);
});

test('a drop the row cannot answer for is still answered', () => {
  // refuseLinkedInDrop is installed by linkedInRow(), so it did not exist at
  // all with linkedin off in the registry, and it returned early once an
  // export was installed. Native swallows every drop now, so those two states
  // were silent: the owner dropped a file on the panel and nothing happened.
  const js = read('widget/ui/connections.js');
  const hook = /window\.__hzLinkedInDropRefused = \(name\) => \{([\s\S]*?)\n\};/u.exec(js)?.[1] ?? '';
  assert.ok(hook, 'the drop-refusal hook is gone');
  assert.match(hook, /showNotice/u, 'with no row to speak for it, the shelf says it');
  const row = /function linkedInRow\(\) \{([\s\S]*?)\n\}/u.exec(js)?.[1] ?? '';
  const refuse = /refuseLinkedInDrop = \(name\) => \{([\s\S]*?)\n  \};/u.exec(row)?.[1] ?? '';
  assert.ok(refuse, 'refuseLinkedInDrop not found');
  assert.doesNotMatch(code(refuse), /if \(installed\) return;/u,
    'an imported export does not make a mis-drop unworthy of an answer');
});

test('arming twice while the consent dialog is up opens one set of watchers', () => {
  // `watching` was assigned from inside the queue block, which parks in
  // open(O_EVTONLY) for as long as the dialog is on screen -- so a second arm
  // in that window passed the guard and appended a second source per folder.
  const begin = code(/func begin\(bridge: Bridge\) \{([\s\S]*?)\n  \}/u.exec(watch)?.[1] ?? '');
  const claimAt = begin.indexOf('watching = true');
  const queueAt = begin.indexOf('queue.async');
  assert.ok(claimAt > -1 && claimAt < queueAt,
    'the claim has to be taken on the main thread, before the block that blocks');
  assert.match(begin, /self\.watching = opened/u, 'and given back if nothing opened');
});

test('the settle check cannot be passed by a different file of the same size', () => {
  // `seen` was keyed on path with a size and an unread date. Download
  // Connections.csv, delete it, download it again: the new file's first scan
  // finds the old entry, the sizes match, and it is offered mid-write -- with
  // a new mtime, so the offer is spent on a partial file.
  const scan = code(swiftFunc(watch, 'scan\\(\\)'));
  assert.match(scan, /previous\.size == size, previous\.at == found\.at/u,
    'the date has to be compared too, or it is a different file wearing the same size');
});

test('the wake hook is one line, and the export hook is defined once', () => {
  // A paste landed the whole of __hzExportFound INSIDE the __hzWake arrow body,
  // with the module-scope copy still there. Valid JavaScript, invisible to
  // node --check, and two copies of one function is how they come to differ.
  assert.equal((widgetJs.match(/window\.__hzExportFound = /gu) ?? []).length, 1);
  assert.match(widgetJs,
    /window\.__hzWake = \(\) => \{ hzApplyTod\(\); refreshRelCard\(\); checkLinkedInReady\(\); \};/u);
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
  assert.match(check, /setGearErrand\('linkedin', hzExportReadyAt\(out\?\.readyTs\) !== null\)/u,
    'through the shared reader: Number(null) is 0 and finite, and lit this on '
    + 'every fresh install');
  // ...but a reply that never came is not. A reader still starting up has no
  // opinion about the owner's inbox and must not clear a glow on its silence.
  assert.match(check, /if \(out\?\.state !== 'ok'\) return;/u);
  // Most specific sentence wins, in a fixed order -- "whichever spoke last" is
  // the bug being fixed, and "Settings" is not a sentence.
  assert.match(widgetJs, /\['linkedin', 'your export is ready — open the email'\],\n\s*\['handoff', 'Settings'\],/u);
});
