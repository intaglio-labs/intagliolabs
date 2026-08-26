// The constellation is a data visualization: proximity is conversation
// activity and bubble size is participant count. Keep those two independent
// so a broad, low-volume topic cannot masquerade as the closest relationship.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(WIDGET, 'ui', 'people-months.js'), 'utf8');
const html = readFileSync(join(WIDGET, 'ui', 'people-months.html'), 'utf8');

test('topic clusters accumulate activity and rank it ahead of member count', () => {
  assert.match(page, /activity: 0/u);
  assert.match(page, /c\.activity \+= Math\.max\(0, Number\(t\.n\) \|\| 0\)/u);
  assert.match(page, /b\.activity - a\.activity \|\| b\.members\.length - a\.members\.length/u);
});

test('topic distance uses activity while circle diameter uses member count', () => {
  assert.match(page, /function clusterDiameter\(c, maxMembers, dMax\)/u);
  assert.match(page, /c\.members\.length \/ Math\.max\(1, maxMembers\)/u);
  assert.match(page, /function activityRadius\(c, ang, range, ring, d\)/u);
  assert.match(page, /c\.activity \|\| 0/u);
  assert.match(page, /ring\.rx \* radial/u);
});

test('new and drifting relationship cards use stock-style trend icons', () => {
  assert.match(page, /'rising-star':[\s\S]*?M4 17 10 11l4 4 6-8/u);
  assert.match(page, /drifting:[\s\S]*?M4 7l6 6 4-4 6 8/u);
});

test('the globe does not include a recency-filter section', () => {
  assert.doesNotMatch(html, /id="recency"/u);
  assert.doesNotMatch(page, /renderRecency|pm-rec|RECENT_DAYS/u);
});
