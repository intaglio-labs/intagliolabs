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

// THE GLOBE IS A TAB ON THE SAME STRIP AND WAS NOT CACHED LIKE ONE. Years get
// three things the map had none of: a background warm so the first click is
// instant, a stale mark on reopen, and a revalidate that paints first. Without
// them the constellation showed whatever it read the first time it was ever
// opened, for as long as the webview lived — which is across every close of the
// panel — and paid a full corpus read for that first open.
test('reopen marks the all-years map stale, as it does every cached year', () => {
  assert.match(refresh, /mapStale = true/u,
    'the map is owed the same freshness check the years are owed');
});

test('the globe paints its cached field before revalidating it', () => {
  const visit = /function visitMap\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.ok(visit, 'entering the globe goes through one path');
  assert.match(visit, /if \(!mapData\) return ensureMap\(\)/u, 'a cold globe still reads');
  assert.match(visit, /if \(mapStale\) refreshMap\(\)/u, 'a stale one refreshes behind the paint');
  const skyTab = /if \(b\.dataset\.view === 'sky'\) \{([\s\S]*?)\n      return;/u.exec(source)?.[1] ?? '';
  assert.match(skyTab, /render\(\);[\s\S]*visitMap\(\)/u,
    'the tab click paints from cache, then checks');
  assert.doesNotMatch(skyTab, /pm-loading/u, 'and never through the cold loading screen');
});

test('the background warm reaches the globe, not only the year tabs', () => {
  const prefetch = /async function prefetchRest\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.ok(prefetch, 'the warming loop exists');
  assert.match(prefetch, /if \(!mapData\) await ensureMap\(\)/u,
    'the map is warmed like the years, after them');
});

test('a background year check does not repaint the constellation', () => {
  const refreshYear = /function refreshYear\(y\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(refreshYear, /scope === 'year'/u,
    'a year payload has nothing to say to the all-years surface');
});

test('opening straight into the globe still warms the year tabs', () => {
  const boot = /if \(scope === 'all'\) \{([\s\S]*?)\n      \} else loadOrFail\(year\);/u.exec(source)?.[1] ?? '';
  assert.ok(boot, 'the restore path splits on the remembered scope');
  assert.match(boot, /refreshYear\(year\)[\s\S]*prefetchRest\(\)/u,
    'the years are read behind the constellation, so the strip is not one tab wide');
});

// A COLD PAGE KNOWS ONE YEAR: today's. The rest of the strip arrives with the
// first year payload, and the constellation does not repaint when one lands —
// so opening the app straight into the globe left a strip of a single tab, and
// every other year appeared only when something else forced a paint. Reported
// from the shipped app, not theorised.
test('the year list arriving redraws the strip, whichever surface is up', () => {
  const refreshYear = /function refreshYear\(y\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(refreshYear, /years = res\.years;[\s\S]*renderTabs\(\);/u,
    'a payload that names the years redraws the tabs that show them');
  // And it stays independent of the surface repaint, which the globe does not want.
  assert.match(refreshYear, /scope === 'year'/u);
});

test('the strip homes to the newest year once it has more than one tab', () => {
  const tabs = /function renderTabs\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(tabs, /if \(!tabsHomed && ys\.length > 1\)/u,
    'homing a one-tab placeholder spends the one homing on nothing');
});
