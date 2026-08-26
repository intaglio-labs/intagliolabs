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
const css = readFileSync(join(WIDGET, 'ui', 'people-months.css'), 'utf8');
// The geometry is a plain script for the page and a module here — same file,
// so these assertions are about the arrangement that actually ships, not a
// second copy of the math written to agree with the first.
const sky = (await import(join(WIDGET, 'ui', 'people-sky-layout.js'))).default;

// Deterministic corpora: a seeded LCG, so a failure is reproducible and a
// green run means the same thing tomorrow.
function corpora(count) {
  let seed = 20260826;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const n = 1 + Math.floor(rnd() * 12);
    out.push({
      stage: { w: 380 + Math.floor(rnd() * 420), h: 360 + Math.floor(rnd() * 700) },
      clusters: Array.from({ length: n }, () => ({
        members: 2 + Math.floor(rnd() * 400),
        activity: Math.floor(rnd() ** 3 * 40000),
        labelWidth: 70 + Math.floor(rnd() * 130),
      })).sort((a, b) => b.activity - a.activity),
    });
  }
  return out;
}

test('topic clusters accumulate activity and rank it ahead of member count', () => {
  assert.match(page, /activity: 0/u);
  assert.match(page, /c\.activity \+= Math\.max\(0, Number\(t\.n\) \|\| 0\)/u);
  assert.match(page, /b\.activity - a\.activity \|\| b\.members\.length - a\.members\.length/u);
});

test('topic distance uses activity while circle diameter uses member count', () => {
  // More people is a bigger circle, at equal activity.
  const bigger = sky.place(520, 800, [
    { members: 400, activity: 5000 }, { members: 8, activity: 5000 },
  ]).spots;
  assert.ok(bigger[0].d > bigger[1].d + 20,
    `400 people should draw well wider than 8, got ${bigger[0].d} and ${bigger[1].d}`);

  // More conversation is a shorter radius, at equal membership.
  const nearer = sky.place(520, 800, [
    { members: 40, activity: 40000 }, { members: 40, activity: 20 },
  ]).spots;
  assert.ok(nearer[0].radial < nearer[1].radial,
    'the busier topic sits nearer the core');
  assert.equal(nearer[0].d, nearer[1].d, 'equal membership draws equal circles');

  // And the two stay independent: a broad, quiet topic must not read as close.
  const mixed = sky.place(520, 800, [
    { members: 30, activity: 30000 }, { members: 300, activity: 30 },
  ]).spots;
  assert.ok(mixed[1].d > mixed[0].d, 'the broader topic is the larger circle');
  assert.ok(mixed[1].radial > mixed[0].radial, 'and still the further one');
});

test('no two topic bubbles overlap, on any stage this panel can be', () => {
  const cases = corpora(600);
  const failures = [];
  for (const { stage, clusters } of cases) {
    const hits = sky.overlaps(sky.place(stage.w, stage.h, clusters).spots);
    if (hits.length) {
      failures.push(`${stage.w}x${stage.h} n=${clusters.length}: ` +
        `${hits.length} pair(s), worst ${Math.round(hits[0].by)}px`);
    }
  }
  assert.deepEqual(failures, [], 'bubbles intersect');
});

test('bubbles stay on the stage and clear of the core', () => {
  for (const { stage, clusters } of corpora(600)) {
    for (const s of sky.place(stage.w, stage.h, clusters).spots) {
      assert.ok(Math.abs(s.x) + s.d / 2 <= stage.w / 2 + 0.5,
        `bubble ran off the ${stage.w}px stage`);
      assert.ok(Math.abs(s.y) + s.d / 2 <= stage.h / 2 + 0.5,
        `bubble ran off the ${stage.h}px stage`);
      assert.ok(Math.hypot(s.x, s.y) >= 27 + s.d / 2,
        'a bubble reached the owner at the centre');
    }
  }
});

test('a topic is only dropped after size and distance have given ground', () => {
  // Eight topics on the panel's own smallest sky: all eight are placed, and the
  // ladder pays for it in diameter rather than by leaving one out.
  const eight = Array.from({ length: 8 }, (_, i) => ({
    members: 200 - i * 20, activity: 9000 - i * 1000,
  }));
  const tight = sky.place(518, 380, eight);
  assert.equal(tight.shown, 8, 'all eight topics are drawn on a short sky');
  assert.equal(tight.dropped, 0);
  const roomy = sky.place(518, 860, eight);
  assert.ok(roomy.spots[0].d > tight.spots[0].d,
    'and a taller sky spends the room on bigger bubbles');

  // The cap is still a cap, and it is still reported rather than swallowed.
  const many = sky.place(518, 860, Array.from({ length: 14 }, (_, i) => ({
    members: 100 - i, activity: 5000 - i * 100,
  })));
  assert.equal(many.shown, sky.HARD_CAP);
  assert.equal(many.dropped, 14 - sky.HARD_CAP);
});

test('the faces a bubble seats shrink with the bubble', () => {
  // Five plus a "+N" chip is the ceiling, and it holds all the way down to the
  // 78px floor — faces scale with the bubble, so a small one is not a crowded
  // one. Below that (a stage too short for the floor) the seats go rather than
  // the ring: measured against the rendered page, which puts no face outside
  // its own circle at any of these sizes.
  assert.equal(sky.facesFor(160, 32), 5, 'the largest bubble seats the full five');
  assert.equal(sky.facesFor(sky.D_SMALL, 16), 5, 'and so does the smallest normal one');
  assert.ok(sky.facesFor(60, 16) < 5, 'a bubble below the floor seats fewer');
  assert.ok(sky.facesFor(40, 16) >= 1, 'and never zero');
});

test('the page delegates its geometry to the layout module', () => {
  assert.match(html, /<script src="people-sky-layout\.js"><\/script>/u);
  assert.match(page, /const SKY = globalThis\.HzSkyLayout;/u);
  assert.match(page, /SKY\.place\(stage\.w, stage\.h/u);
  // The old single-ring solve and its even angles are gone, not shadowed.
  assert.doesNotMatch(page, /function fitLayout|function activityRadius|function clusterDiameter/u);
  assert.doesNotMatch(page, /-Math\.PI \* 0\.75 \+ \(i \* Math\.PI \* 2\)/u);
});

test('new and drifting relationship cards use stock-style trend icons', () => {
  assert.match(page, /'rising-star':[\s\S]*?M4 17 10 11l4 4 6-8/u);
  assert.match(page, /drifting:[\s\S]*?M4 7l6 6 4-4 6 8/u);
});

test('the globe does not include a recency-filter section', () => {
  assert.doesNotMatch(html, /id="recency"/u);
  assert.doesNotMatch(page, /renderRecency|pm-rec|RECENT_DAYS/u);
});

// Yeeted by the owner on 2026-08-26, and worth a tripwire: a starfield is the
// one thing on this surface that means nothing, and every other dot here is a
// person. If specks come back, someone is decorating a data display.
test('the constellation draws no decorative specks', () => {
  assert.doesNotMatch(page, /pm-speck|mulberry32/u);
  assert.doesNotMatch(css, /pm-speck/u);
});

test('the globe is a floating icon, not a tab', () => {
  assert.match(html, /class="pm-globe"/u);
  assert.doesNotMatch(html, /pm-tab-globe/u);
  assert.doesNotMatch(css, /pm-tab-globe/u);
  // Both shapes still answer the one delegated click handler.
  assert.match(page, /closest\('\.pm-tab, \.pm-globe'\)/u);
});

test('the strip fades only the end that is hiding tabs', () => {
  assert.match(page, /function markTabFades\(\)/u);
  assert.match(page, /classList\.toggle\('fade-l'/u);
  assert.match(page, /classList\.toggle\('fade-r'/u);
  assert.match(css, /\.pm-tabs\.fade-l \{/u);
  assert.match(css, /\.pm-tabs\.fade-r \{/u);
  // The 18px of rent that permanent fade charged is gone with it, so the
  // newest year can sit against the globe.
  assert.doesNotMatch(css, /pm-tab:last-child \{ margin-right/u);
  assert.match(css, /margin-left: auto;/u);
});
