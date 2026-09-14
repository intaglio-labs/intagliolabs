// THE RESUME THAT DEPENDS ON WEBKIT ANSWERING IN THE ORDER WE HOPED.
//
// deliverToOnboarding evaluates JavaScript against a panel built moments
// earlier. On a cold first launch that document has not parsed onboarding.js
// yet, so the page cannot answer, and the delivery has to be made again once
// the page exists -- Bridge.whenPageFinishes is the list didFinish drains.
//
// Registering the repeat from INSIDE the evaluation's completion handler
// assumes WebKit answers the evaluation before it reports didFinish for that
// navigation. If it defers the evaluation past didFinish instead, didFinish
// drains an empty list and the closure appended afterwards never runs -- and
// the cost is the owner redoing screens 2 to 4 on the cold launch that follows
// granting Full Disk Access, the one launch where this matters most. Nothing
// in WebKit's contract settles that ordering, so the code must not depend on
// it: the repeat is booked FIRST and cancelled by a page that answered.
//
// Source scan, like the other widget tests -- no Swift toolchain here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(WIDGET, 'src', 'main.swift'), 'utf8');
const bridge = readFileSync(join(WIDGET, 'src', 'Bridge.swift'), 'utf8');

/// Comments out: the prose above deliverToOnboarding names both calls being
/// ordered, so a naive index search would find them in the paragraph.
const code = (text) => text
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\/\/)/u.test(line))
  .join('\n');

function deliverBody() {
  const signature = 'private func deliverToOnboarding(_ web: WKWebView?, _ js: String) {';
  const start = main.indexOf(signature);
  assert.ok(start > 0, 'deliverToOnboarding must still exist under that name');
  const end = main.indexOf('\n  }', start);
  assert.ok(end > start, 'the body of deliverToOnboarding must be findable');
  return code(main.slice(start, end));
}

test('the repeat is booked before the first attempt is made', () => {
  const body = deliverBody();
  const book = body.indexOf('whenPageFinishes');
  const evaluate = body.indexOf('web.evaluateJavaScript');
  assert.ok(book > 0, 'the delivery must still be repeatable once the page finishes loading');
  assert.ok(evaluate > 0, 'the first attempt must still be made immediately');
  assert.ok(book < evaluate,
    'whenPageFinishes must be registered BEFORE the evaluation. Registered from inside\n' +
    "its completion handler, a WebKit that runs the evaluation after that navigation's\n" +
    'didFinish appends the repeat to a list that has already been drained, and the\n' +
    'resume is lost on exactly the cold launch it exists for');
});

test('a page that answered cancels the repeat rather than never booking it', () => {
  const body = deliverBody();
  assert.match(body, /answered as\? Bool\) == true/u,
    'the page acknowledges by returning true, and that answer is what cancels');
  assert.match(body, /!pending\.answered else \{ return \}/u,
    'the booked repeat must check the acknowledgement before re-delivering, or every\n' +
    'first launch delivers the resume twice');
});

// ONE BOOKING PER PAGE, AND IT CARRIES THE LATEST WORD (round-5 finding 14).
//
// whenPageFinishes APPENDS and didFinish drains. From the second showing
// onward the page has long since finished, so each openOnboarding added a
// closure that would never run -- until the webview reloads (WebKit
// content-process recovery, or a re-issued loadFileURL), at which point the
// whole pile fires at once and every unacknowledged one delivers its own old
// `__hzOnboardingResume(step)`, jumping the owner to a screen from a showing
// they had already left.
//
// So the pending delivery is a property a later showing REPLACES, the booked
// closure reads that property when it runs rather than capturing a delivery of
// its own, and the booking is made only when this page does not already hold
// one.
test('a second showing replaces the pending delivery instead of stacking another', () => {
  const body = deliverBody();
  assert.match(body, /pendingOnboardingDelivery = delivery/u,
    'each showing must install ITS delivery as the pending one, which is what cancels the\n' +
    'previous showing: a stale resume step must never be replayable');
  assert.match(body, /self\.pendingOnboardingDelivery, !pending\.answered/u,
    'and the booked closure must read the pending delivery when it runs rather than\n' +
    'capturing one, or replacing the property changes nothing about what fires');

  assert.match(body, /if onboardingRepeatBookedFor != page \{/u,
    'the booking must be conditional on this page not already holding one; an\n' +
    'unconditional whenPageFinishes call is one never-drained closure per showing');
  assert.match(body, /self\.onboardingRepeatBookedFor = nil/u,
    'a booking that has fired must be forgotten, or the next showing relies on a closure\n' +
    'didFinish has already taken off the list');
});

test('the delivery carries the word it is to deliver', () => {
  // The booked closure no longer captures `js`, so the pending delivery has to
  // hold it -- otherwise a repeat would have nothing to say.
  assert.match(code(main), /final class OnboardingDelivery \{\n\s*let js: String/u,
    'OnboardingDelivery must carry the script: that is what makes replacing the pending\n' +
    'delivery replace the word a reload would repeat');
});

test('the list the repeat is booked on is still one-shot', () => {
  // whenPageFinishes' contract: didFinish REMOVES the list before running it,
  // so a closure that outlives its navigation cannot fire again on the next
  // one. The cancel above relies on the closure running at most once.
  assert.match(bridge, /afterLoad\.removeValue\(forKey: ObjectIdentifier\(webView\)\)/u,
    'didFinish must take the closures off the list as it runs them');
});
