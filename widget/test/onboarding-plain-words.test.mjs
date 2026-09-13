// THE SETUP FLOW IS HAND-WRITTEN, AND FOUR THINGS IN IT WERE NOT.
//
// From the surface review (2026-09-13), on the screens a new owner sees before
// anything else: a bundle identifier under the permission rows, a load table
// with database column headings, raw internal error strings in two places, and
// a screen with no way off it for ten minutes. None of them is a bug in the
// sense of a broken button, which is exactly why they survive unless something
// holds them down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WIDGET, p), 'utf8');
const js = read('ui/onboarding.js');
const html = read('ui/onboarding.html');
const bridge = read('src/Bridge.swift');
const permissions = read('src/Permissions.swift');
// Struck-through prose explaining what a line USED to say would otherwise fail
// every "must not say" assertion in this file.
const visibleHtml = html.replace(/<!--[\s\S]*?-->/gu, '');
const code = js.replace(/\/\/[^\n]*/gu, '');

test('the bundle identifier appears only when a probe found a grant elsewhere', () => {
  // It exists for a real trap — the August rename left one identifier allowed
  // in Full Disk Access and the other denied — but that is a developer's
  // problem, and it was being explained to every owner who has never had it.
  assert.match(permissions, /static func staleGrantBundle\(disk: Status\) -> String\?/u);
  const probe = /static func staleGrantBundle[\s\S]*?\n {2}\}/u.exec(permissions)?.[0] ?? '';
  assert.match(probe, /guard disk != \.granted else \{ return nil \}/u,
    'a Mac that can read has no mismatch to report, whatever else is installed');
  assert.match(probe, /DefaultsMigration\.previousBundleID/u,
    'the identifier it names is the one the rename left behind, not a literal');
  // Marks a previous install leaves, none of which needs the grant we are
  // missing: TCC.db is itself protected by the thing being probed.
  assert.match(probe, /com\.hazlie\./u);
  assert.match(probe, /Hazlie\.app/u);
  assert.doesNotMatch(probe, /TCC\.db/u, 'the one file we cannot read is not the source');
  // Which marks count, and why the sentence has to be conditional, is pinned in
  // the test below: neither side of this can be proven from outside TCC.

  assert.match(bridge, /if deepCheck,\s*\n\s*let stale = Permissions\.staleGrantBundle/u,
    'the probe runs on the deep check, never on the poll that ticks every few seconds');
  assert.match(bridge, /permReply\["staleChecked"\] = deepCheck/u,
    'and the reply says which kind it is, so a poll cannot rub out what entry drew');
  assert.match(js, /if \(res\?\.staleChecked !== true\) return;/u);
  const paint = /function paintBundleNote\(res\)([\s\S]*?)\n\}/u.exec(js)?.[1] ?? '';
  assert.match(paint, /if \(!stale \|\| !mine\) \{[\s\S]{0,80}permBundle\.textContent = '';/u,
    'no mismatch, no sentence — and the line is cleared, not left from a prior poll');
  assert.doesNotMatch(code, /granting to:/u,
    'the old unconditional line must not survive anywhere in the page');
  // AND IT HAS TO BE ABLE TO GO AWAY. The deep check ran on screen entry and
  // nowhere else, while the only thing that can change its answer — a grant —
  // happens while the screen is up. The note sat there contradicting a row that
  // had just turned green.
  assert.match(js, /function recheckBundleNote\(\)/u);
  assert.match(js, /hzPost\('permissionState', \{ diagnostic: true \}\)[\s\S]{0,500}paintBundleNote/u,
    'a permission that changed re-asks the question the note answers');
  assert.match(js, /next\.fda === 'granted'/u,
    'and a read that now works clears it without waiting for a round trip');
});

test('the stale-grant sentence does not promise a row it cannot see', () => {
  // The probe cannot read TCC.db — that file is protected by the very grant
  // being probed — so it reasons from what a previous install leaves behind.
  // Two rounds of review pulled it in opposite directions: a leftover defaults
  // domain outlives the app that wrote it (so it is not proof the old row is
  // still there), and a TCC row outlives the app that earned it (so a deleted
  // Hazlie.app is not proof the row is gone). Both are true, and neither is
  // knowable from here. What was actually wrong was the SENTENCE, which
  // asserted two rows in a list this process cannot read.
  const probe = /static func staleGrantBundle[\s\S]*?\n {2}\}/u.exec(permissions)?.[0] ?? '';
  assert.match(probe, /UserDefaults\(suiteName: previous\)/u,
    'every mark of a previous install counts again, because none of them is proof');
  const paint = /function paintBundleNote\(res\)([\s\S]*?)\n\}/u.exec(js)?.[1] ?? '';
  assert.match(paint, /if you see/u,
    'so the sentence is conditional on what the owner is actually looking at');
  assert.doesNotMatch(paint, /you may see two rows/u,
    'and it must not promise two rows to somebody who has one');
});

test('the load table is written for a person, not for whoever built it', () => {
  const head = /<tr><th>[\s\S]*?<\/tr>/u.exec(visibleHtml)?.[0] ?? '';
  assert.ok(head, 'the load table head was not found');
  for (const word of ['rows', 'source', 'status']) {
    assert.doesNotMatch(head, new RegExp(`>${word}<`, 'u'),
      `"${word}" is console vocabulary and must not be a column heading`);
  }
  assert.match(head, />what</u);
  // SHORT AS WELL AS PLAIN. The first pass replaced "rows" with "read so far"
  // and "status" with "where it stands" — plain English, and materially longer,
  // in four columns of a fixed-width panel whose cells carry six-figure counts.
  assert.match(head, />read</u);
  assert.match(head, />standing</u);
  const headings = [...head.matchAll(/<th[^>]*>([^<]+)<\/th>/gu)].map((m) => m[1]);
  assert.equal(headings.length, 4);
  for (const heading of headings) {
    assert.ok(heading.length <= 8, `"${heading}" is long for a column in a 312px panel`);
  }
  // The header used to carry "people who wrote to you", which was wrong for
  // three of the four rows; the per-row qualifier says it instead.
  assert.match(js, /authors: 'who wrote to you'/u,
    'the ordinary case needs a qualifier now that the heading is one word');
  assert.doesNotMatch(js, /rows are kept from sources/u,
    'the line under the table was database vocabulary too');
});

test('an internal error string never reaches the screen', () => {
  // Both of these used to be interpolated straight into a sentence on the
  // screen. They are kept — in a tooltip, where somebody debugging will look.
  const cell = /function statusCell\(row\)([\s\S]*?)\n\}/u.exec(js)?.[1] ?? '';
  assert.doesNotMatch(cell, /textContent = `[^`]*\$\{row\.lastError\}/u,
    'the raw error must not be part of the cell text');
  assert.match(cell, /cell\.title = String\(row\.lastError\)/u,
    'and must still be reachable from the cell');
  assert.doesNotMatch(code, /i could not read those rows — \$\{/u);
  assert.match(js, /loadStatus\.title = String\(projection\.lastRebuildError\)/u,
    'the rebuild error goes the same way');
});

test('the first-load screen offers a way out as soon as it has anything to show', () => {
  // "no card yet" with no exit for ten minutes was the run-5 screenshot, and
  // the only escape was an undocumented Escape key.
  const paint = /function paintLoad\(out\)([\s\S]*?)\n\}/u.exec(js)?.[1] ?? '';
  assert.match(paint, /if \(rows\.length > 0\) loadFinish\.hidden = false;/u,
    'rows in the table means the reading started and this screen is watchable, not a gate');
  // The ten-minute timer stays for a table that never fills at all.
  assert.match(js, /if \(Date\.now\(\) - loadSince > 10 \* 60 \* 1000\) loadFinish\.hidden = false;/u);
  // And the dead end that named a config file the owner cannot open.
  assert.doesNotMatch(code, /switched off in your config/u);
  assert.match(js, /one card a day is switched off/u);
});

test('screen 1 and screen 5 say what they do without internal nouns', () => {
  assert.doesNotMatch(visibleHtml, /kept by the reader/u,
    '"the reader" is a component name, on the first screen of the flow');
  assert.match(visibleHtml, /your choice is kept on this Mac/u);
  // The privacy switch's timing note: "page" there meant a person dossier, on
  // the one screen that is about sending excerpts to anthropic.
  assert.doesNotMatch(visibleHtml, /the next page it builds/u);
  assert.match(visibleHtml, /the next person it reads about/u);
});
