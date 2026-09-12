// THE SIX SCREENS, AND WHAT MAY AND MAY NOT BE IN THE SEQUENCE.
//
// The flow is six checks. Each one has an easier version that reads a file, a
// status or a config key and believes it, and every one of those easier
// versions has already been wrong here — so the structural facts are pinned:
// there are six screens, each one writes down where it is so a Full Disk
// Access restart resumes rather than rewinds, the two optional scenes are
// reachable only under the `chat` flag and never replace a check, and a
// remembered step that is no longer shown falls back to an earlier screen
// rather than to the welcome.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(ROOT, 'widget', 'ui', 'onboarding.html'), 'utf8');
const js = readFileSync(join(ROOT, 'widget', 'ui', 'onboarding.js'), 'utf8');
const features = JSON.parse(readFileSync(join(ROOT, 'ops', 'features.json'), 'utf8'));
const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');

const screensBlock = /const screens = \{([\s\S]*?)\n\};/u.exec(js)?.[1] ?? '';
const screenIds = [...screensBlock.matchAll(/getElementById\('([^']+)'\)/gu)].map((m) => m[1]);

test('six setup screens, plus the two optional scenes', () => {
  const keys = [...screensBlock.matchAll(/^\s{2}([A-Za-z0-9]+):/gmu)].map((m) => m[1]);
  assert.deepEqual(keys, ['1', '2', '3', '4', '5', '6', 'demo', 'home']);
  // Every id in the map is a real element in the page, and every .ob-screen in
  // the page is in the map. A screen the map does not know about can never be
  // shown; an id the page does not have makes showScreen throw on entry.
  const inHtml = [...html.matchAll(/class="ob-screen[^"]*" id="([^"]+)"/gu)].map((m) => m[1]);
  assert.deepEqual([...screenIds].sort(), [...inHtml].sort());
  assert.equal(inHtml.length, 8);
});

test('every screen records where it is, so a Full Disk Access restart resumes', () => {
  // macOS offers "Quit & Reopen" when the switch moves, and taking it used to
  // restart the flow from the welcome — the whole thing again, right after the
  // hardest step in it.
  const show = /function showScreen\(n\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.ok(show, 'showScreen() not found');
  assert.match(show, /hzPost\('onboardingStep', \{ step: key \}\)/u);
  // Fire and forget: a failed write costs a resume, never the flow.
  assert.match(show, /hzPost\('onboardingStep'[\s\S]{0,60}\.catch\(\(\) => \{\}\)/u);
});

test('the optional scenes are gated on the flag, and the flag ships off', () => {
  // With `chat` off — the shipping default — `flow` is the six checks and
  // nothing else, so the demo and the spotlight are never entered.
  assert.equal(features.features.chat, false, 'the flag ships off');
  assert.match(js, /let flow = SETUP_ORDER;/u, 'the default sequence is the checks');
  assert.match(js, /hzFeatureOn\(set, 'chat'\)[\s\S]{0,80}flow = FULL_ORDER/u);
  // Fails closed: no bridge, no answer, no optional scenes.
  assert.match(js, /hzFeatures\(\)[\s\S]{0,200}\.catch\(\(\) => \{\}\)/u);
  const setup = /const SETUP_ORDER = \[([^\]]*)\]/u.exec(js)?.[1] ?? '';
  assert.deepEqual(setup.match(/'[^']+'/gu), ["'1'", "'2'", "'3'", "'4'", "'5'", "'6'"]);
  // And with the flag ON they are INSERTED, never substituted: all six checks
  // survive in the same order.
  const full = /const FULL_ORDER = \[([^\]]*)\]/u.exec(js)?.[1] ?? '';
  const fullKeys = (full.match(/'[^']+'/gu) ?? []).map((s) => s.slice(1, -1));
  assert.deepEqual(fullKeys.filter((k) => /^\d$/u.test(k)), ['1', '2', '3', '4', '5', '6']);
  assert.ok(fullKeys.includes('demo') && fullKeys.includes('home'));
});

test('a remembered step that is no longer shown falls back to an earlier one', () => {
  // `chat` can be turned off between the write and the read. Falling back to 1
  // would replay the whole flow right after its hardest step, which is the
  // exact failure onboardingStep exists to prevent.
  const resume = /function resumeTarget\(step\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.ok(resume, 'resumeTarget() not found');
  assert.match(resume, /if \(flow\.includes\(key\)\) return key;/u);
  assert.match(resume, /for \(let i = at - 1; i >= 0; i -= 1\)/u, 'walks BACKWARDS');
  assert.match(resume, /return '1';/u, 'and only reaches the welcome as the floor');
  assert.match(js, /window\.__hzOnboardingResume = \(step\) => \{[\s\S]{0,200}resumeTarget\(step\)/u);
});

test('each screen enters its own check and stops it on the way out', () => {
  const show = /function showScreen\(n\) \{([\s\S]*?)\n\}/u.exec(js)?.[1] ?? '';
  for (const [key, hook] of [
    ['1', 'enterWelcome'], ['2', 'enterPerms'], ['3', 'enterGoogle'],
    ['5', 'enterEngine'], ['6', 'enterLoad'],
  ]) {
    assert.match(show, new RegExp(`key === '${key}'\\) ${hook}\\(\\)`, 'u'), `${key} -> ${hook}`);
  }
  // A poll left running behind a screen nobody is looking at is a request
  // every three seconds forever — and one of these starts connectors.
  const leave = /function leaveScreen\(key\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.ok(leave, 'leaveScreen() not found');
  for (const stop of ['stopPermPolling', 'stopGooglePolling', 'stopLoadPolling']) {
    assert.match(leave, new RegExp(`${stop}\\(\\)`, 'u'));
  }
  assert.match(show, /leaveScreen\(currentScreen\)/u, 'and it runs before the switch');
});

test('the flow ends on the card, not on a directory', () => {
  const finish = /function finish\(\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.ok(finish, 'finish() not found');
  assert.match(finish, /spotlightWidget[\s\S]*onboardingDone[\s\S]*close[\s\S]*openReconnect/u);
  assert.doesNotMatch(js, /openPeople/u);
});

test('no page JavaScript writes a style attribute its own CSP would throw away', () => {
  // onboarding.html ships style-src 'self' with no 'unsafe-inline', which
  // blocks style ATTRIBUTES. Assignments through element.style are not gated
  // and are what this page uses.
  assert.match(html, /style-src 'self'/u);
  assert.ok(!/style-src[^;]*'unsafe-inline'/u.test(html));
  assert.ok(!/style="/u.test(js), 'a generated style attribute would silently not apply');
});

test('the welcome asks for nothing and writes only on a click', () => {
  // A replay on a machine where the owner deliberately chose "founders" must
  // not redraw as "anyone" — that row would then be one tap from writing a
  // choice they never made back over the real one.
  const enter = /function enterWelcome\(\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.ok(enter, 'enterWelcome() not found');
  assert.match(enter, /hzPost\('relCardPeek'\)[\s\S]{0,200}paintMode\(out\.mode\)/u);
  assert.doesNotMatch(enter, /hzPost\('relMode'/u, 'entering the screen writes nothing');
  // The peek is the right read here precisely because it records nothing.
  assert.match(js, /modesEl\.addEventListener\('click'[\s\S]{0,300}hzPost\('relMode'/u);
});

test('the example card on the welcome is labelled as one', () => {
  // A drawing of a card is the only honest thing to show before anything has
  // been read; unlabelled, the first screen of the flow would be a fabricated
  // result.
  assert.match(html, /class="ob-card-tag">example</u);
  assert.match(html, /class="ob-card-demo" aria-hidden="true"/u);
});

test('the unverified-app warning is on screen before the sign-in button', () => {
  // Unconditional and pre-emptive: Google's own page will say this app is
  // unverified, and a warning the owner meets unprepared reads as a warning
  // about what this app does with the grant.
  const warning = html.indexOf('google has not finished reviewing this app');
  const button = html.indexOf('id="googleStart"');
  assert.ok(warning > -1, 'the unverified-app line is gone');
  assert.ok(button > -1);
  assert.ok(warning < button, 'it must be read before the button is pressed');
  assert.match(html, /about google&#8217;s\s*\n?\s*review\s*\n?\s*queue, not about what i do with the grant/u);
});

// ---- what the polls cost, and when they stop -----------------------------

test('leaving the flow stops every poll, not just changing screen', () => {
  // showScreen() was the ONLY caller of leaveScreen, so Escape stopped
  // nothing: currentScreen never changed, every tick's own guard therefore
  // never fired, and the panel reuses the same loaded page. From screen 3 that
  // is a live Gmail read every poll for the rest of the ten-minute window;
  // from screen 6 a relCardPeek that refills the producer's batch, forever,
  // behind a closed window.
  assert.match(js, /function leaveFlow\(\) \{\s*\n\s*leaveScreen\(currentScreen\);\s*\n\}/u,
    'leaveFlow() must stop the screen the flow is actually on');
  const escape = /if \(e\.key === 'Escape'\) \{([\s\S]*?)\n {2}\}/u.exec(js)?.[1];
  assert.ok(escape, 'the Escape handler is gone');
  assert.match(escape, /leaveFlow\(\)/u, 'escape leaves');
  assert.ok(escape.indexOf('leaveFlow()') < escape.indexOf("hzPost('close')"),
    'and it stops the polls BEFORE the window goes');
  const finish = /function finish\(\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.match(finish, /leaveFlow\(\)/u, 'finishing leaves too');
  // Native can also order the panel out on its own routes, and an ordered-out
  // webview reports itself hidden. That is the only signal the page gets.
  assert.match(js, /visibilitychange[\s\S]{0,200}document\.hidden[\s\S]{0,40}leaveFlow\(\)/u);
});

test('no poll on this flow runs at the old three-second rate', () => {
  // Each of these is a real cost somewhere: a protected read that a denied
  // machine records as a tccd denial, a Gmail call out of the connector's
  // measured budget, and a card peek that refills a producer batch.
  for (const [name, ms] of [['PERM_POLL_MS', 3000], ['GOOGLE_POLL_MS', 15000],
                            ['LOAD_POLL_MS', 5000], ['PEEK_POLL_MS', 15000]]) {
    assert.match(js, new RegExp(`const ${name} = ${ms};`, 'u'), `${name} is ${ms}`);
  }
  // And the constants are what the timers are actually given.
  assert.match(js, /\}, PERM_POLL_MS\);/u);
  assert.match(js, /\}, GOOGLE_POLL_MS\);/u);
  assert.match(js, /setInterval\(tick, LOAD_POLL_MS\)/u);
  assert.match(js, /setInterval\(peek, PEEK_POLL_MS\)/u);
  assert.doesNotMatch(js, /setInterval\([^)]*, 3000\)/u, 'nothing is left on the old rate');
  assert.doesNotMatch(js, /setInterval\([^)]*, 1500\)/u);
});

test('the google probe is capped for the whole visit, and reachable by hand', () => {
  // A page left sitting on screen 3 must not be able to spend the mail
  // connector's Gmail budget by doing nothing.
  assert.match(js, /const GOOGLE_PROBE_CAP = \d+;/u);
  const probe = /function probeGoogle\(\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.ok(probe, 'probeGoogle() not found');
  assert.match(probe, /googleProbes >= GOOGLE_PROBE_CAP/u, 'the cap is enforced in the probe');
  assert.match(probe, /googleProbes \+= 1/u, 'and every probe counts against it');
  // The two paths that matter still probe at once: coming back from the
  // browser, and pressing the button.
  assert.match(js, /window\.addEventListener\('focus'[\s\S]{0,120}probeGoogle\(\)/u);
  assert.match(js, /googleStart\.addEventListener\('click'[\s\S]{0,300}startGooglePolling\(\)/u);
  assert.match(js, /function enterGoogle\(\) \{[\s\S]{0,400}googleProbes = 0;[\s\S]{0,120}probeGoogle\(\)/u,
    'the cap is per visit, not per page load');
});

test('the permission poll asks for no diagnostic; entering the screen does', () => {
  // writeDiagnostic() evaluates every permission a second time and writes a
  // file. On the poll path that was four chat.db opens, a createDirectory and
  // a JSON write every tick, forever, for a row that the first attempt
  // already primed.
  const poll = /function startPermPolling\(\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.ok(poll, 'startPermPolling() not found');
  assert.match(poll, /hzPost\('permissionState'\)/u, 'the poll asks for the state alone');
  assert.doesNotMatch(poll, /diagnostic/u, 'and never for the diagnostic');
  assert.match(js, /function enterPerms\(\) \{[\s\S]{0,600}hzPost\('permissionState', \{ diagnostic: true \}\)/u,
    'entering the screen is when somebody is about to read the file');
});

test('the "nothing is running" banner is about the daemon, never about chat.db', () => {
  // Whether this Mac has an iMessage database says nothing about whether the
  // reader has ever run — and the fallback hid the banner AND its start button
  // on exactly the machine most likely to need them.
  assert.match(js, /const stopped = last === null \|\| \(Date\.now\(\) - last\) > 10 \* 60 \* 1000;/u);
  const paint = /function paintLoad\(out\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.ok(paint, 'paintLoad() not found');
  const bannerAt = paint.indexOf('const stopped =');
  const region = paint.slice(bannerAt, paint.indexOf('loadStart.hidden'));
  assert.doesNotMatch(region, /noMessagesOnThisMac/u,
    'the banner may not read the iMessage flag at all');
  assert.match(paint, /out\.daemonLastRunTs/u, 'the run log is the only input');
});

test('a resume that arrives after the owner has moved is ignored', () => {
  // native calls __hzOnboardingResume right after creating the panel, and on a
  // first launch the page has not loaded — WebKit runs the evaluation once the
  // document exists, which on the owner's machine was AFTER they pressed
  // "hello". The flow was yanked from the permissions screen to the remembered
  // step, so screen 2 was on screen for a few frames and never seen.
  assert.match(js, /window\.__hzOnboardingResume = \(step\) => \{\s*\n\s*if \(ownerMoved\) return;/u);
  assert.match(js, /function nextScreen\(\) \{\s*\n\s*ownerMoved = true;/u,
    'the owner moving the flow is what makes their press win');
  assert.match(js, /window\.__hzOnboardingReset = \(\) => \{[\s\S]{0,200}ownerMoved = false;/u,
    'a replay from settings starts the question over');
});

test('screen 4 is entered, and reports an export that is already here', () => {
  const show = /function showScreen\(n\) \{([\s\S]*?)\n\}/u.exec(js)?.[1] ?? '';
  assert.match(show, /key === '4'\) enterLinkedIn\(\)/u,
    'screen 4 had no enter hook at all, so it could not look');
  assert.match(js, /function enterLinkedIn\(\) \{[\s\S]{0,200}hzPost\('linkedInState'\)/u);
  const paint = /function paintLinkedInExisting\(out\) \{([\s\S]*?)\n\}/u.exec(js)?.[1];
  assert.ok(paint, 'paintLinkedInExisting() not found');
  assert.match(paint, /out\.present !== true/u, 'nothing is claimed when nothing is there');
  assert.match(paint, /connections already here/u);
  assert.match(paint, /linkedInPick\.textContent = 'replace'/u, 'the button offers the replacement');
  assert.match(paint, /linkedInNext\.hidden = false/u, 'and the flow can go on without re-picking');
});

test('the two screens that write something slowly say so', () => {
  // Neither is a code change: relMode is a fire-and-forget POST to a reader
  // that may still be starting, and the engine switch writes a config key the
  // page builder reads when it STARTS a page. A privacy switch that looks
  // instant while a build is in flight is the one kind of lie this screen
  // cannot afford, so the screen says what it does.
  const welcome = html.slice(html.indexOf('id="modes"'), html.indexOf('id="cta"'));
  assert.match(welcome, /kept by the reader/u, 'screen 1 says when the mode lands');
  const engine = html.slice(html.indexOf('id="engineToggleRow"'), html.indexOf('id="engineModel"'));
  assert.match(engine, /applies to the next page it builds/u,
    'screen 5 says the switch is not retroactive');
});

test('a step remembered under the old numbering is not resumed into', () => {
  // THE VOCABULARY CHANGED UNDER THE SAME KEY. The old flow had three scenes
  // and wrote '1', '2', '3' for welcome, typing demo and widget spotlight. The
  // six-screen flow writes those same characters for welcome, permissions and
  // google sign-in. An owner who FINISHED the old flow has a '3' on disk
  // meaning "the last screen", and resumeTarget() accepts it verbatim
  // (flow.includes('3') is true) — dropping them into google sign-in and
  // skipping the permissions screen everything downstream depends on.
  //
  // No value can tell the two apart, so the KEY carries the version.
  const key = /static let stepDefaultsKey = "([^"]+)"/u.exec(bridge)?.[1];
  assert.ok(key, 'stepDefaultsKey not found');
  assert.notEqual(key, 'HazlieOnboardingStep', 'the old key must not be read');
  assert.match(key, /-v2$/u, 'and the new one says which vocabulary it holds');
  // The old key is named exactly once, to be removed — never to be read.
  assert.match(bridge, /static let legacyStepDefaultsKey = "HazlieOnboardingStep"/u);
  const prop = /static var onboardingStep: String\? \{([\s\S]*?)\n {2}\}/u.exec(bridge)?.[1];
  assert.ok(prop, 'onboardingStep not found');
  assert.match(prop, /removeObject\(forKey: legacyStepDefaultsKey\)/u, 'the old value is cleared');
  assert.match(prop, /string\(forKey: stepDefaultsKey\)/u);
  assert.doesNotMatch(prop, /string\(forKey: legacyStepDefaultsKey\)/u,
    "a stored '3' under the old key must not reach resumeTarget at all");
  // And with nothing under the new key, native takes the reset path rather
  // than resuming: a fresh page starts on screen 1.
  assert.match(js, /window\.__hzOnboardingReset = \(\) =>/u);
});
