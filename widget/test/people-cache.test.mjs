// The timeline webview survives when its panel is hidden. Reopening used to
// clear every cached year and summary before fetching again, which guaranteed
// a blank "loading YEAR..." screen and re-prefetched all historical years.
// Guard the stale-while-revalidate contract at that native/page boundary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const source = readFileSync(join(UI, 'people-months.js'), 'utf8');
const refresh = /window\.__hzRefresh = \(\) => \{([\s\S]*?)\n  \};/u.exec(source)?.[1] ?? '';

test('timeline reopen invalidates cache and reloads the active surface', () => {
  assert.ok(refresh, 'the native reopen hook exists');
  assert.match(refresh, /cache\.clear\(\)/u);
  assert.match(refresh, /summaries\.clear\(\)/u);
  assert.match(refresh, /if \(scope === 'all'\) render\(\);[\s\S]*else loadOrFail\(year\)/u);
});

test('a cached year is rendered without another cold request', () => {
  const cachedBranch = /if \(cache\.has\(year\) && !rebuild\) ([^\n]*)/u.exec(source)?.[1] ?? '';
  assert.match(cachedBranch, /render\(\)/u);
});
