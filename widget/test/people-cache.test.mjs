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

test('timeline reopen preserves painted year and summary caches', () => {
  assert.ok(refresh, 'the native reopen hook exists');
  assert.doesNotMatch(refresh, /cache\.clear\(\)/u);
  assert.doesNotMatch(refresh, /summaries\.clear\(\)/u);
  assert.match(refresh, /render\(\);[\s\S]*refreshYear\(year\)/u,
    'cached content paints before its background freshness check');
});

test('a cached stale year refreshes without entering the cold loading path', () => {
  const cachedBranch = /if \(cache\.has\(year\)\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? '';
  assert.match(cachedBranch, /render\(\)/u);
  assert.match(cachedBranch, /refreshYear\(year\)/u);
  assert.doesNotMatch(cachedBranch, /pm-loading/u);
});
