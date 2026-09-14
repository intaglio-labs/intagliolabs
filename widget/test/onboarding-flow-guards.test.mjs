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
// The round after that found the other half of three of them, which is why the
// same four subjects are still here:
//
//   the cap stopped being CHECKED on the owner's path but went on being SPENT
//   there, so alt-tabbing 40 times still killed the interval; not peeking on a
//   re-show restarted the interval from zero, so a panel revealed often enough
//   never peeked at all; and the bounded wait for native turned into a
//   deadline, so a resume that arrived at 2 s was dropped and the owner redid
//   screens 2 to 4. Each fix answered its finding and created its opposite.
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

/// The sign-in button's click handler, comments stripped, matched on the `});`
/// in column zero that closes the addEventListener call.
function clickHandler() {
  const m = /googleStart\.addEventListener\('click', \(\) => \{\n([\s\S]*?)\n\}\);/u.exec(js);
  assert.ok(m, 'the sign-in button has no click handler in onboarding.js');
  return code(m[1]);
}

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
  // ~~"sources this install does not read people from"~~ — "rows" and "sources"
  // both went with the load table's console vocabulary (2026-09-13). The
  // sentence still has to say the SAME thing: these are places people do not
  // come from, not sources somebody turned off.
  assert.match(line, /places i do not look for people in/u);

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
  // AND THE COUNTER IS THE TIMER'S TOO. Leaving the increment here was the
  // same defect wearing a hat: pressing "connect" and alt-tabbing 40 times
  // while signing in filled the counter, the interval killed itself on its
  // next tick, and the screen's polling was dead for the rest of the visit
  // with nothing on screen saying so. The cap's stated purpose is that a page
  // cannot spend the budget by doing NOTHING; a spend driven by the owner
  // doing something is not what it is counting.
  assert.doesNotMatch(code(probe.body), /googleProbes/u,
    'the owner-driven paths may not spend the timer\'s budget');

  const start = code(bodyOf('startGooglePolling').body);
  assert.match(start, /GOOGLE_PROBE_CAP/u, 'the cap has to be checked somewhere');
  const capAt = start.indexOf('GOOGLE_PROBE_CAP');
  const intervalAt = start.indexOf('setInterval');
  assert.ok(intervalAt > -1 && capAt > intervalAt,
    'the cap is the timer callback\'s, so it cannot reach the two owner-driven paths');
  const spendAt = start.indexOf('googleProbes += 1');
  assert.ok(spendAt > intervalAt, 'and so is the spend — it is counting unattended probes');
  assert.ok(spendAt > capAt, 'counted after the check, or the last tick is refused its own slot');

  // ONE PROBE NOW. The button starts this poll; without a leading probe the
  // first feedback after pressing it is GOOGLE_POLL_MS away — 15s, where the
  // 3s poll this replaced answered in 3.
  assert.ok(start.indexOf('probeGoogle()') > -1 && start.indexOf('probeGoogle()') < intervalAt,
    'startGooglePolling probes once immediately');

  // The two paths the comment above GOOGLE_POLL_MS promises are unconditional.
  // ~~A single-line match on the whole handler.~~ It grew a body when the
  // waiting state landed: coming back from the browser now also ends the wait,
  // which is what lets the failure copy be reached at all. Read as a block, so
  // the pin is on what the handler does rather than on how long it is.
  const focus = code(
    /window\.addEventListener\('focus', \(\) => \{\n([\s\S]*?)\n\}\);/u.exec(source)?.[1] ?? '');
  assert.ok(focus, 'the return-from-browser probe is gone');
  assert.match(focus, /currentScreen !== '3'/u, 'still only on the google screen');
  assert.match(focus, /probeGoogle\(\)/u, 'and it still probes at once, cap or no cap');
  assert.doesNotMatch(focus, /GOOGLE_PROBE_CAP|googleProbes/u,
    'the owner coming back is not an unattended probe');
  // ~~A character-distance match from the click handler to startGooglePolling.~~
  // The button now reads the reply before it decides — a sign-in that never
  // opened a browser gets no ten-minute poll — and the handler grew past
  // whatever number this was pinned at. Reading the handler as a block says
  // the thing the number was standing in for.
  const click = clickHandler();
  assert.match(click, /startGooglePolling\(\)/u, 'the button still starts the poll');
  // AND ONLY WHEN SOMETHING STARTED. Forty live Gmail reads is the price of
  // waiting on a consent screen; a consent screen nothing opened is not worth
  // one. See onboarding-screens.test.mjs for what the owner is told instead.
  const refusedAt = click.indexOf('googleRefusal = why;');
  assert.ok(refusedAt > -1, 'the refusal branch is gone');
  assert.ok(refusedAt < click.indexOf('startGooglePolling()'),
    'the refusal returns before the poll is reached');
});

// ------------------------------------------- 7: the peek on every re-show

test('coming back to the panel re-arms the polls without spending a peek', () => {
  const start = bodyOf('startLoadPolling');
  assert.match(start.args, /peekNow/u, 'startLoadPolling takes no say in whether it peeks');
  const body = code(start.body);
  // A peek is not a read: it runs produceBatch/produceOweBatch, applies the cap
  // and the servability gate, and writes the producers' refill bookkeeping.
  assert.match(body, /\n\s*tick\(\);/u, 'the table still repaints immediately — it is local and cheap');
  assert.match(body, /peekNow \|\| since >= PEEK_POLL_MS/u,
    'a peek that is already due fires on the re-show; only one inside the window waits');

  const visibility = /document\.addEventListener\('visibilitychange'[\s\S]*?\n\}\);/u.exec(source)?.[0];
  assert.ok(visibility, 'the visibilitychange handler was not found');
  assert.match(visibility, /startLoadPolling\(\{ peekNow: false \}\)/u,
    'every hide/show cycle would otherwise spend one relCardPeek outside the 15s throttle');

  // AND THE THROTTLE IS A RATE, SO IT IS KEPT AS A TIME.
  //
  // `peekNow: false` plus a fresh setInterval restarted the fifteen seconds
  // from zero on every re-show, so a panel ordered out and revealed more often
  // than PEEK_POLL_MS reached the mark exactly never — screen 6's reconnect
  // card never populated, which is the one thing the flow is walking towards.
  // The previous behaviour over-spent; that one could spend nothing.
  assert.match(source, /^let lastPeekAt = 0;$/mu,
    'the last peek has to outlive any one arming of the poll');
  assert.doesNotMatch(code(bodyOf('startLoadPolling').body), /let lastPeekAt/u,
    'a per-arming variable is the bug, not the fix');
  assert.match(body, /lastPeekAt = Date\.now\(\);/u, 'and it is stamped when a peek is spent');
  // The not-yet-due path waits out the REMAINDER and then falls into the
  // interval, so re-arming can delay a peek and can never cancel one.
  assert.match(body, /setTimeout\([\s\S]{0,160}PEEK_POLL_MS - since\)/u);
  assert.match(code(bodyOf('stopLoadPolling').body), /clearTimeout\(loadPeekDelay\)/u,
    'leaving the screen has to cancel the pending peek as well as the intervals');

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
  assert.match(resume, /if \(resumeHeard\) return true;/u,
    'native sends one resume per open; a second delivery of it is a repeat, not a new word');
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

test('a resume that arrives after the bound is still honoured if nobody pressed', () => {
  // THE BOUND IS ON WAITING, NOT A DEADLINE ON NATIVE. ENTRY_WAIT_MS settles
  // the PRESS: after it, the welcome's button works. A resume arriving at 2 s
  // — a cold launch on a slow machine, which is the launch that follows
  // granting Full Disk Access and taking macOS's "Quit & Reopen" — was then
  // returned from without doing anything, and the owner redid screens 2 to 4.
  // If nobody has pressed, nothing has been decided, and the ownerMoved flag
  // was right about that much.
  const resume = /window\.__hzOnboardingResume = \(step\) => \{([\s\S]*?)\n\};/u.exec(source)?.[1];
  assert.ok(resume, '__hzOnboardingResume not found');
  assert.match(resume, /const late = entrySettled;/u,
    'settling has to be read BEFORE settleEntry() makes it true for everyone');
  assert.match(resume, /if \(late && ownerPressed\) return true;/u,
    'a late resume is dropped only when the owner has moved under their own steam');
  assert.ok(resume.indexOf('const late') < resume.indexOf('settleEntry()'));
  assert.ok(resume.indexOf('if (late && ownerPressed)') < resume.indexOf('showScreen('),
    'and the drop is decided before the flow moves');

  // ownerPressed is the press itself, not the queued advance: pendingAdvance
  // is consumed by the flush and would read false again the moment it fired.
  assert.match(source, /^let ownerPressed = false;$/mu);
  const cta = /document\.getElementById\('cta'\)\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\}\);/u
    .exec(source)?.[1];
  assert.ok(cta, "the welcome's button was not found");
  assert.match(cta, /ownerPressed = true;/u);

  // NATIVE DOES NOT RELY ON THE ABOVE. main.swift asks the page to acknowledge
  // and delivers again once there is a page to deliver to; the two defences
  // answer different halves of the same hop, and neither is the other's excuse.
  const swift = readFileSync(join(ROOT, 'widget', 'src', 'main.swift'), 'utf8');
  assert.match(swift, /private func deliverToOnboarding\(/u);
  // THE RETRY IS BOOKED FIRST AND CANCELLED BY THE ANSWER, not armed inside
  // the answer. Arming it from the evaluation's completion handler assumed
  // WebKit answers the evaluation before it reports didFinish for that
  // navigation; deferred the other way, didFinish drains an empty list and the
  // closure appended afterwards never runs -- on exactly the cold first launch
  // this defence exists for. The ordering is pinned in onboarding-delivery.
  // Ordering, not adjacency. The booking grew a condition of its own -- it is
  // made once per page and the pending delivery is REPLACED rather than
  // stacked (round-5 finding 14) -- so a character window between the two
  // calls pins the shape of the prose rather than the property. What has to
  // hold is only that the booking precedes the first attempt.
  const booked = swift.indexOf('whenPageFinishes(web) {');
  const attempted = swift.indexOf('web.evaluateJavaScript(js)');
  assert.ok(booked > 0 && attempted > booked,
    'the retry is booked before the first attempt, so it cannot be lost to the race');
  assert.match(swift, /answered as\? Bool\) == true/u,
    'and a page that answered still cancels it, rather than being delivered to twice');
  assert.doesNotMatch(swift, /web\?\.evaluateJavaScript\(\s*\n?\s*"window\.__hzOnboarding/u,
    'the unacknowledged fire-and-forget delivery is back');
  for (const verb of ['__hzOnboardingResume', '__hzOnboardingReset']) {
    const body = new RegExp(`window\\.${verb} = \\(\\w*\\) => \\{([\\s\\S]*?)\\n\\};`, 'u')
      .exec(source)?.[1];
    assert.ok(body, `${verb} not found`);
    assert.match(body, /return true;/u, `${verb} has to answer, or every delivery looks lost`);
  }
});

test('the held press says so, and Escape takes it back', () => {
  // The CTA plays its sound and then swallows the move while the gate is
  // closed, which reads as a dead button. Disabling it is the affordance and
  // it also stops a second press replaying the sound.
  const cta = /document\.getElementById\('cta'\)\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\}\);/u
    .exec(source)?.[1];
  assert.ok(cta, "the welcome's button was not found");
  assert.match(cta, /if \(!entrySettled\) setCtaHeld\(true\);/u);
  assert.match(code(bodyOf('setCtaHeld').body), /\.disabled = on/u);
  assert.match(readFileSync(join(ROOT, 'widget', 'ui', 'palette.css'), 'utf8'),
    /\.ob-cta\[disabled\]/u, 'the disabled state has to be visible, not just semantic');
  // Released whenever the wait ends, by either route.
  assert.match(code(bodyOf('settleEntry').body), /setCtaHeld\(false\)/u);

  // And a press held by the gate is cancelled with the flow. The page survives
  // the close, so otherwise the fallback fires showScreen() behind a panel
  // nobody can see and the next open has to undo it.
  const escape = /if \(e\.key === 'Escape'\) \{([\s\S]*?)\n {2}\}/u.exec(source)?.[1];
  assert.ok(escape, 'the Escape branch was not found');
  assert.match(escape, /pendingAdvance = false;/u);
  assert.match(escape, /setCtaHeld\(false\);/u);
});
