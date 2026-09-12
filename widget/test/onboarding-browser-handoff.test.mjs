// THE BROWSER OPENED BEHIND THE SCRIM.
//
// Google will not run OAuth in an embedded webview, so onboarding screen 3
// hands the authorization URL to the owner's own browser. The onboarding panel
// is a full-screen NSPanel at .floating; a browser window is an ordinary one.
// So on the clean-machine walk (2026-09-12) Dia came up UNDERNEATH the scrim,
// every click on it was swallowed, and the only route to Google was Escape --
// which closes the flow rather than completing the sign-in.
//
// This is the second window in this flow to land in that hole. The first was
// System Settings (yieldForSettings) and the one before that a TCC prompt
// (yieldForPrompt), and each was found live rather than read off the code. So
// the third one is pinned: native yields when the launch is accepted, it
// yields far enough that ordering cannot go the other way, it puts the scrim
// back when the owner returns, and a showing of the flow never starts from a
// lowered scrim.
//
// Source scan, like the other widget tests -- no toolchain, no AppKit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
const mainSwift = readFileSync(join(ROOT, 'widget', 'src', 'main.swift'), 'utf8');

/// Comments in this file's subjects describe the very bug being pinned, so a
/// naive `includes` would find the fix in the prose about the defect.
const code = (text) => text
  .split('\n')
  .filter((line) => !/^\s*\/\//u.test(line))
  .join('\n');

/// A `func name(...) { ... }` body in main.swift, matched on the closing brace
/// at the type's indentation.
function swiftFunc(name) {
  const re = new RegExp(`\\n  (?:private )?func ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n  \\}\\n`, 'u');
  const m = re.exec(mainSwift);
  assert.ok(m, `${name}() not found in main.swift`);
  return code(m[1]);
}

const googleAuth = code(/case "googleAuth":([\s\S]*?)\n    case "/u.exec(bridge)?.[1] ?? '');

test('the delegate can be told a browser has taken over', () => {
  const protocolBlock = /protocol BridgeDelegate: AnyObject \{([\s\S]*?)\n\}\n/u.exec(bridge)?.[1];
  assert.ok(protocolBlock, 'BridgeDelegate not found in Bridge.swift');
  assert.match(protocolBlock, /func yieldOnboardingToBrowser\(\)/u,
    'the handoff goes through the delegate, like yieldForPrompt and yieldForSettings');
  // No argument: unlike the other two there is nothing to restore on, because
  // consent completes in another application and never calls back.
  assert.doesNotMatch(protocolBlock, /func yieldOnboardingToBrowser\(_ /u);
});

test('a launched browser makes native yield, and a refused one does not', () => {
  assert.ok(googleAuth, 'the googleAuth case is gone from Bridge.swift');
  assert.match(googleAuth, /GoogleLogin\.present\(url: url\)/u);
  assert.match(googleAuth, /if ok \{ self\.delegate\?\.yieldOnboardingToBrowser\(\) \}/u,
    'the yield is gated on the launch macOS actually accepted');
  // `ok` is the whole gate. Yielding on a browser that never opened would drop
  // the scrim for a sign-in that is not happening, and the page would be
  // painting a refusal from behind every other window on the display.
  const yieldAt = googleAuth.indexOf('yieldOnboardingToBrowser()');
  const presentAt = googleAuth.indexOf('GoogleLogin.present(url: url)');
  assert.ok(presentAt > -1 && yieldAt > presentAt,
    'and it happens inside the launch completion, not before it');
});

test('the scrim goes behind, and stays visible while it is there', () => {
  const body = swiftFunc('yieldOnboardingToBrowser');
  assert.match(body, /guard let p = onboardingPanel, p\.isVisible else \{ return \}/u,
    'nothing happens when the flow is not on screen');
  assert.match(body, /p\.level = \.normal/u, 'off the floating level the browser cannot beat');
  // Lowering alone is a race. The panel is non-activating, so this app may be
  // inactive already, and NSWorkspace brings the browser forward
  // asynchronously -- whichever of the two moves last wins the ordering.
  assert.match(body, /p\.orderBack\(nil\)/u,
    'and behind, because ordering cannot be left to whoever moves last');
  // Visible, not hidden: the page is showing "waiting for you in the browser…"
  // and a scrim that vanished would read as the flow having ended.
  assert.doesNotMatch(body, /orderOut|isVisible = false|p\.close\(\)/u,
    'the flow keeps its place on screen');
});

test('the scrim comes back when the owner returns, by either route', () => {
  const restore = swiftFunc('restoreOnboardingFromBrowser');
  assert.match(restore, /guard onboardingYieldedToBrowser else \{ return \}/u,
    'it only lifts a scrim this handoff lowered');
  assert.match(restore, /onboardingYieldedToBrowser = false/u);
  assert.match(restore, /p\.level = \.floating/u);
  assert.match(restore, /p\.orderFrontRegardless\(\)/u);
  // Both notifications. The onboarding panel is a .nonactivatingPanel, so
  // clicking it can make it key without making this app active -- that is the
  // same return the page's own `focus` probe rides on. Watching only the
  // application notification would leave the scrim behind in that case.
  const launch = code(mainSwift);
  assert.match(launch, /NSApplication\.didBecomeActiveNotification/u);
  assert.match(launch, /NSWindow\.didBecomeKeyNotification/u);
  assert.match(launch, /restoreOnboardingFromBrowser\(\)/u,
    'and the observers are what call it');
});

// ANY OF THIS APP'S WINDOWS IS A RETURN (round-5 finding 15).
//
// The key-window observer was filtered to the onboarding panel itself, and the
// widget window is ordered out for the flow's duration -- so the
// non-activating route only ever fired for a click on the scrim. An owner who
// cancels in the browser and then clicks some other panel of ours was left
// with a full-screen `.normal` scrim reading "waiting for you in the browser…"
// underneath everything, with no way back until openOnboarding ran again.
//
// didBecomeKey is posted only for windows in this process, so the widened
// filter still means "we are being used again", and the yielded-flag guard in
// restoreOnboardingFromBrowser makes every other window's key event a no-op.
test('any window of this app becoming key is a return, not only the onboarding panel', () => {
  const launch = code(mainSwift);
  const observer = /for name in \[NSApplication\.didBecomeActiveNotification, NSWindow\.didBecomeKeyNotification\] \{([\s\S]*?)\n    \}\n/u
    .exec(launch)?.[1];
  assert.ok(observer, 'the two return observers are no longer registered together');
  assert.doesNotMatch(observer, /!== self\.onboardingPanel/u,
    'a filter to the onboarding panel leaves the scrim stranded whenever the owner comes\n' +
    'back through any other window of ours');
  assert.doesNotMatch(observer, /as\? PopupPanel/u,
    'and there is nothing left to narrow the notification to one window');
  assert.match(observer, /restoreOnboardingFromBrowser\(\)/u,
    'both notifications still call the restore');
  // The guard that makes the widening safe lives in the restore itself, which
  // the test above pins: it lifts only a scrim this handoff lowered.
  assert.match(swiftFunc('restoreOnboardingFromBrowser'),
    /guard onboardingYieldedToBrowser else \{ return \}/u);
});

test('a showing of the flow never starts from a lowered scrim', () => {
  // The restore rides on the owner coming back to this app. An owner who
  // abandons the sign-in from inside the browser never does, so the panel is
  // re-raised on every open rather than only when it is first built.
  const open = /func openOnboarding\(resume: Bool\) \{([\s\S]*?)\n  \}\n/u.exec(mainSwift)?.[1];
  assert.ok(open, 'openOnboarding not found in main.swift');
  const guardAt = open.indexOf('guard let p = onboardingPanel else { return }');
  assert.ok(guardAt > -1, 'openOnboarding no longer resolves the panel that way');
  const afterGuard = code(open.slice(guardAt));
  assert.match(afterGuard, /p\.level = \.floating/u,
    'the level is re-set on every showing, not only on the one that builds the panel');
  assert.match(afterGuard, /onboardingYieldedToBrowser = false/u,
    'and the flag with it');
});
