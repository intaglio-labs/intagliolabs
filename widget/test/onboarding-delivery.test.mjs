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
  assert.match(body, /guard !delivery\.answered else \{ return \}/u,
    'the booked repeat must check the acknowledgement before re-delivering, or every\n' +
    'first launch delivers the resume twice');
});

test('the list the repeat is booked on is still one-shot', () => {
  // whenPageFinishes' contract: didFinish REMOVES the list before running it,
  // so a closure that outlives its navigation cannot fire again on the next
  // one. The cancel above relies on the closure running at most once.
  assert.match(bridge, /afterLoad\.removeValue\(forKey: ObjectIdentifier\(webView\)\)/u,
    'didFinish must take the closures off the list as it runs them');
});
