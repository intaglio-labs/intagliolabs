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

test('topic clusters rank by the number of people who share them', () => {
  assert.match(page, /members: \[\]/u);
  assert.match(page, /b\.members\.length - a\.members\.length \|\| a\.label\.localeCompare/u);
});

test('bubble size and placement follow the base constellation layout', () => {
  assert.match(page, /c\.members\.length \/ maxMembers/u);
  assert.doesNotMatch(page, /function activityRadius/u);
});

test('relationship cards retain the base icon set', () => {
  assert.match(page, /'rising-star':[\s\S]*?M12 3l1\.9 5\.1/u);
  assert.match(page, /drifting:[\s\S]*?M4 8h10/u);
});

test('the globe includes the base recency control', () => {
  assert.match(html, /id="recency"/u);
  assert.match(page, /renderRecency/u);
  assert.match(page, /presenceDays/u);
});
