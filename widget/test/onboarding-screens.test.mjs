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
