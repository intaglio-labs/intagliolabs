// The "looking for" strip on the card panel (plan step 2, 2026-09-21): the
// page posts exactly the five ask verbs, the bridge admits exactly those for
// this page and relays each to one hermes ask route, the markup carries the
// strip and the fits-because row, and every displayed block has its [hidden]
// answer. Source scans, hermetic, like the rest of widget/test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(ROOT, 'ui', 'reconnect.js'), 'utf8');
const html = readFileSync(join(ROOT, 'ui', 'reconnect.html'), 'utf8');
const css = readFileSync(join(ROOT, 'ui', 'reconnect.css'), 'utf8');
const bridge = readFileSync(join(ROOT, 'src', 'Bridge.swift'), 'utf8');

const VERBS = ['askList', 'askCreate', 'askActive', 'askDelete', 'askMatches'];

test('the page posts the five ask verbs and the bridge admits them for the reconnect page only', () => {
  for (const v of VERBS) assert.match(js, new RegExp(`hzPost\\('${v}'`, 'u'), `${v} is posted by the page`);
  const reconnectList = /"reconnect": \[([\s\S]*?)\]/u.exec(bridge)?.[1] ?? '';
  for (const v of VERBS) assert.ok(reconnectList.includes(`"${v}"`), `${v} is in the reconnect capability list`);
  const peopleList = /"people": \[([\s\S]*?)\]/u.exec(bridge)?.[1] ?? '';
  for (const v of VERBS) assert.ok(!peopleList.includes(`"${v}"`), `${v} is not handed to the people page`);
});

test('each verb relays to exactly one hermes ask route and forwards only its named fields', () => {
  assert.match(bridge, /case "askList":[\s\S]*?relHermes\("GET", "admin\/relationship\/ask", json: nil\)/u);
  assert.match(bridge, /case "askCreate":[\s\S]*?prefix\(400\)[\s\S]*?relHermes\("POST", "admin\/relationship\/ask", json: \["text": askText\]\)/u);
  assert.match(bridge, /case "askActive":[\s\S]*?relHermes\("POST", "admin\/relationship\/ask\/active", json: \["id": askId, "active": active\]\)/u);
  assert.match(bridge, /case "askDelete":[\s\S]*?relHermes\("POST", "admin\/relationship\/ask\/delete", json: \["id": askId\]\)/u);
  assert.match(bridge, /case "askMatches":[\s\S]*?relHermes\("GET", "admin\/relationship\/ask\/matches\?id=\\\(askId\)&limit=20", json: nil\)/u);
});

test('the markup carries the strip and the fits-because row, and hidden blocks stay hidden', () => {
  for (const id of ['rcAsk', 'rcAskForm', 'rcAskInput', 'rcAskGo', 'rcAskChips', 'rcAskList', 'rcFitsRow', 'rcFits']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is in the markup`);
  }
  assert.match(html, /<input class="rc-ask-input" id="rcAskInput" type="text" maxlength="400"/u, 'the input is bounded in the markup too');
  assert.match(css, /\.rc-ask-list\[hidden\] \{ display: none; \}/u);
  assert.match(css, /\.rc-ask-form\[hidden\] \{ display: none; \}/u);
  assert.match(js, /el\('rcFitsRow'\)/u, 'the card renders the fits-because row');
  assert.match(js, /isAsk \? 'looking for\?'/u, 'an ask card is titled looking for?');
});

test('nothing on the strip spends a serve: no relCard call is reachable from the ask code', () => {
  const strip = js.slice(js.indexOf('LOOKING FOR (plan step 2'));
  assert.ok(strip.length > 200, 'the strip section exists');
  assert.ok(!/hzPost\('relCard'/u.test(strip), 'browsing asks never fetches a card');
  assert.ok(!/hzPost\('relEvent'/u.test(strip), 'and never records a verdict');
});
