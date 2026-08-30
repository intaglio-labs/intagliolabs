// Person rows are independent summary jobs. Opening a second row must retain
// the first one so both visible rows can report progress while their local
// model requests are in flight.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const source = readFileSync(join(UI, 'people-months.js'), 'utf8');

test('multiple person rows stay open and request their own summaries', () => {
  assert.match(source, /const expanded = new Set\(\)/u);
  assert.match(source, /const open = expanded\.has\(rowKey\)/u);
  const click = /listEl\.addEventListener\('click', \(e\) => \{([\s\S]*?)\n  \}\);/u.exec(source)?.[1] ?? '';
  assert.match(click, /if \(expanded\.has\(rk\)\) \{[\s\S]*?expanded\.delete\(rk\);[\s\S]*?\} else \{[\s\S]*?expanded\.add\(rk\);[\s\S]*?requestSummary\(key, rowYear\);/u);
  assert.doesNotMatch(click, /expanded = /u);
});

test('exhaustive summaries poll aggregate progress and render coverage plus depth', () => {
  assert.match(source, /if \(r && r\.pending\)[\s\S]*?setTimeout\(poll, 1200\)/u);
  assert.match(source, /state: 'refreshing'[\s\S]*?text: r\.text[\s\S]*?coverage: r\.coverage/u,
    'a previous summary stays visible while fresher evidence is processed');
  assert.match(source, /all \$\{number\(coverage\.messages\)\} direct messages/u);
  assert.match(source, /coverage\.conversations/u);
  assert.match(source, /summarySectionsHtml\(sum\.sections\)/u);
  assert.match(source, /reading \$\{progress\.month\}/u);
});
