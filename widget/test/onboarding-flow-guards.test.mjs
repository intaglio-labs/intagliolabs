// THE FOUR THINGS THIS FLOW DOES WHEN NOBODY IS LOOKING.
//
// Every screen in onboarding.js has a check behind it, and onboarding-screens
// reads those. This file reads the parts BETWEEN the screens — the polls, the
// caps and the resume — because that is where the last round of review found
// four defects, each of which is invisible in a happy-path walk-through:
//
//   the dormant line called sources "switched off" that nothing switched off;
//   the Google probe cap silently swallowed the button press as well as the
//   timer; a hide/show cycle spent a producer peek outside its own throttle;
//   and the resume was decided by a race between WebKit and the owner's hand.
//
// Source scan, like the other widget tests — no toolchain, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const js = readFileSync(join(ROOT, 'widget', 'ui', 'onboarding.js'), 'utf8');
const graph = readFileSync(join(ROOT, 'ui', 'server', 'people', 'graph.mjs'), 'utf8');

/// A top-level `function name(...) { ... }` body, matched on the closing brace
/// in column zero. Every function this file reads is declared that way.
function bodyOf(name) {
  const re = new RegExp(`\\nfunction ${name}\\(([^)]*)\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`, 'u');
  const m = re.exec(js);
  assert.ok(m, `${name}() not found in onboarding.js`);
  return { args: m[1], body: m[2] };
}

/// Code only: comments in this file explain the very bugs being pinned, so a
/// naive `includes` would find the fix in the prose describing the defect.
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//u.test(line))
  .join('\n');

const source = code(js);

// -------------------------------------------------- 3: the dormant sentence

test('the dormant line does not call a photo library "switched off"', () => {
  // `dormant` collects every source that fails EITHER gate: the bridges a flag
  // turned off AND the sources that were never going to mint a person. The
  // repo's own progress fixture proves the mix — dormant.sources comes back as
  // ['instagram', 'photos'] with only the bridges off.
  const line = /loadDormant\.textContent =\s*\n?\s*`([^`]*)`/u.exec(source)?.[1];
  assert.ok(line, 'the dormant sentence was not found');
  assert.doesNotMatch(line, /switched[- ]off/u,
    'nothing switched the photo library off; the owner would go looking for the switch');
  assert.match(line, /sources this install does not read people from/u);

  // And the claim behind the copy: at least one dormant source is dormant
  // because of what it IS, not because of a flag.
  assert.match(graph, /photos:\s*'non-person'/u,
    'if photos stopped being a non-person source this sentence would need rewriting');
});

// ------------------------------------------------- 6: the Google probe cap

test('the probe cap belongs to the timer and to nothing else', () => {
  const probe = bodyOf('probeGoogle');
  assert.doesNotMatch(code(probe.body), /GOOGLE_PROBE_CAP/u,
    'a cap checked here silently no-ops the BUTTON and the return-from-browser probe, '
    + 'and the screen sits on "opening google in your browser…" forever');
  assert.match(probe.body, /googleProbes \+= 1/u, 'the timer still needs the spend counted');

  const start = code(bodyOf('startGooglePolling').body);
  assert.match(start, /GOOGLE_PROBE_CAP/u, 'the cap has to be checked somewhere');
  const capAt = start.indexOf('GOOGLE_PROBE_CAP');
  const intervalAt = start.indexOf('setInterval');
  assert.ok(intervalAt > -1 && capAt > intervalAt,
    'the cap is the timer callback\'s, so it cannot reach the two owner-driven paths');

  // ONE PROBE NOW. The button starts this poll; without a leading probe the
  // first feedback after pressing it is GOOGLE_POLL_MS away — 15s, where the
  // 3s poll this replaced answered in 3.
  assert.ok(start.indexOf('probeGoogle()') > -1 && start.indexOf('probeGoogle()') < intervalAt,
    'startGooglePolling probes once immediately');

  // The two paths the comment above GOOGLE_POLL_MS promises are unconditional.
  assert.match(source, /window\.addEventListener\('focus', \(\) => \{ if \(currentScreen === '3'\) probeGoogle\(\); \}\)/u);
  assert.match(source, /googleStart\.addEventListener\('click',[\s\S]{0,400}startGooglePolling\(\)/u);
});

// ------------------------------------------- 7: the peek on every re-show

test('coming back to the panel re-arms the polls without spending a peek', () => {
  const start = bodyOf('startLoadPolling');
  assert.match(start.args, /peekNow/u, 'startLoadPolling takes no say in whether it peeks');
  const body = code(start.body);
  // A peek is not a read: it runs produceBatch/produceOweBatch, applies the cap
  // and the servability gate, and writes the producers' refill bookkeeping.
  assert.match(body, /\n\s*tick\(\);/u, 'the table still repaints immediately — it is local and cheap');
  assert.match(body, /if \(peekNow\) peek\(\);/u, 'the peek is the conditional one');
  assert.doesNotMatch(body, /\n\s*peek\(\);\s*\n\s*loadTimer/u, 'the leading peek is unconditional again');

  const visibility = /document\.addEventListener\('visibilitychange'[\s\S]*?\n\}\);/u.exec(source)?.[0];
  assert.ok(visibility, 'the visibilitychange handler was not found');
  assert.match(visibility, /startLoadPolling\(\{ peekNow: false \}\)/u,
    'every hide/show cycle would otherwise spend one relCardPeek outside the 15s throttle');

  // And entering the screen for real still peeks: the flow ends on a card, and
  // a screen that never asked for one would wait out the ten minutes.
  assert.match(code(bodyOf('enterLoad').body), /startLoadPolling\(\);/u);
});

// ------------------------------------------------------- 9: the resume race

test('the resume is decided by native, not by a race with the owner\'s hand', () => {
  assert.doesNotMatch(source, /ownerMoved/u,
    'the ownerMoved flag is a race with a coin in it: whoever got there first won, '
    + 'and losing it cost the owner screens 2 to 4 a second time');

  // The flow does not move until native has spoken. main.swift evaluates
  // exactly one of __hzOnboardingResume / __hzOnboardingReset on every open.
  const next = code(bodyOf('nextScreen').body);
  assert.match(next, /if \(!entrySettled\) \{ pendingAdvance = true; return; \}/u,
    'a press before native speaks has to be held, not acted on and then undone');
  assert.ok(next.indexOf('entrySettled') < next.indexOf('showScreen'),
    'the gate comes before the move');

  const resume = /window\.__hzOnboardingResume = \(step\) => \{([\s\S]*?)\n\};/u.exec(source)?.[1];
  assert.ok(resume, '__hzOnboardingResume not found');
  assert.match(resume, /if \(entrySettled\) return;/u,
    'native sends a resume only to a freshly loaded page; a settled one has been told already');
  assert.match(resume, /settleEntry\(\)/u);
  assert.match(resume, /pendingAdvance = false/u,
    'a held press was aimed at the welcome, and a resume moves them past it');
  assert.match(resume, /showScreen\(resumeTarget\(step\)\)/u);

  const reset = /window\.__hzOnboardingReset = \(\) => \{([\s\S]*?)\n\};/u.exec(source)?.[1];
  assert.ok(reset, '__hzOnboardingReset not found');
  assert.match(reset, /settleEntry\(\)/u, 'a rewind settles the page too, or the flow stays frozen');
  assert.ok(reset.indexOf("showScreen('1')") < reset.indexOf('flushPendingAdvance'),
    'the welcome is entered first, then the held press is replayed from it');

  // BOUNDED. A page opened with no native behind it must not sit there.
  assert.match(source, /const ENTRY_WAIT_MS = \d+;/u);
  const fallback = /const entryFallback = setTimeout\(\(\) => \{([\s\S]*?)\}, ENTRY_WAIT_MS\);/u
    .exec(source)?.[1];
  assert.ok(fallback, 'nothing bounds the wait');
  assert.match(fallback, /settleEntry\(\)/u);
  assert.match(fallback, /flushPendingAdvance\(\)/u);
});
