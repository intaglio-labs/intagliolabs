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
  // The per-topic count is clamped ONCE and then used twice — it is the
  // cluster's activity and the member's own weight inside it, and two
  // clamps is two chances for the bubble's distance and its faces to be
  // reading different numbers.
  assert.match(page, /const n = Math\.max\(0, Number\(t\.n\) \|\| 0\);/u);
  assert.match(page, /c\.members\.push\(\{ person: p, n \}\);/u);
  assert.match(page, /c\.activity \+= n;/u);
  assert.match(page, /b\.activity - a\.activity \|\| b\.members\.length - a\.members\.length/u);
});

test('a face is sized by its share of THIS topic, not by global engagement', () => {
  // The bug this closes is silent and reads as correct: p.engagement is a real
  // number and sizing on it produces a plausible picture. It is just a picture
  // of a different question than the circle is labelled with.
  assert.match(page, /function faceSize\(n, maxN, fs\)/u);
  assert.doesNotMatch(page, /faceSize\([^)]*engagement/u);
  // Members are ordered by that same per-topic count, so the seats a full
  // bubble gives out go to whoever carries the topic.
  assert.match(page, /c\.members\.sort\(\(a, b\) => b\.n - a\.n \|\| a\.at - b\.at\)/u);
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

// A DECAYING ROSTER, which is the shape every real topic has: a couple of
// people carry it and a long tail barely appears. Sizes are the page's own
// arithmetic (faceSize in people-months.js) against the band the layout owns,
// so these are the diameters that actually get packed.
function roster(d, n, decay) {
  const fs = sky.faceScaleFor(d);
  return Array.from({ length: n }, (_, i) =>
    Math.round(fs.min + (fs.max - fs.min) * decay ** i));
}

test('a bubble packs its faces without one touching another or the ring', () => {
  // ~~facesFor(d, faceMax): two flex-wrapped rows, five discs and a "+N".~~
  // Replaced 2026-08-26 when the bubbles started carrying their whole cast.
  // The guarantee it existed for is the one asserted here, and it is now
  // asserted on the ARRANGEMENT rather than on a seat count: no face overlaps
  // another, and none reaches outside its own dashed ring.
  let seatedTotal = 0;
  for (const d of [sky.D_SMALL, 96, 114, 134, 150, sky.D_CEIL, 174]) {
    for (const decay of [0.99, 0.9, 0.75, 0.5]) {
      const sizes = roster(d, 60, decay);
      const packed = sky.packFaces(d, sizes);
      assert.deepEqual(
        sky.faceFaults(d, packed.spots), [],
        `d=${d} decay=${decay} packed ${packed.seated} faces with a fault`,
      );
      assert.ok(packed.seated >= 1, 'every bubble seats at least the busiest person');
      seatedTotal += packed.seated;
    }
  }
  assert.ok(seatedTotal > 0);
});

test('a large bubble seats the crowd the design draws in it', () => {
  // The face diameters read off the design's own largest artboard bubble —
  // 174px, twenty-three people and a "+N" — so this is a comparison against
  // the drawing rather than against whatever the packer happens to do today.
  // ~~A row of five, then strict concentric rings.~~ Five and eight
  // respectively, on these exact sizes.
  const drawn = [45, 40, 38, 35, 33, 30, 30, 28, 28, 25, 25, 24,
                 23, 23, 21, 20, 20, 19, 19, 18, 16, 16, 16, 16];
  const packed = sky.packFaces(174, drawn);
  assert.deepEqual(sky.faceFaults(174, packed.spots), []);
  assert.ok(packed.seated >= 20,
    `the design seats ${drawn.length}; this packing seats ${packed.seated}`);
});

test('a face is never seated it cannot legibly hold', () => {
  // The floor is where two initials stop being letters. A bubble too small for
  // even one face at the floor seats nobody rather than seating a dot.
  const tiny = sky.packFaces(sky.FACE_FLOOR, [sky.FACE_FLOOR]);
  assert.equal(tiny.seated, 0, 'a bubble with no room inside its inset seats nothing');
  for (const d of [sky.D_SMALL, 120, 174]) {
    const fs = sky.faceScaleFor(d);
    assert.ok(fs.min >= sky.FACE_FLOOR, `face floor held at d=${d}`);
    assert.ok(fs.max >= fs.min, 'and the band never inverts');
  }
});

test('the packing is stable — the same roster packs the same way twice', () => {
  // The page repacks on every render of the globe, and a face that jumps to a
  // different side of its bubble on a redraw reads as data changing.
  const sizes = roster(150, 40, 0.88);
  assert.deepEqual(sky.packFaces(150, sizes).spots, sky.packFaces(150, sizes).spots);
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

// The orbits went the same way and for a sharper reason: they were three fixed
// pixel radii on a surface whose distances are a log of a message count, so a
// bubble sitting between two of them looked measured against them. What draws
// the radial order now is a spoke per topic, and it carries the distance
// encoding rather than a decoration.
test('the constellation draws spokes, not orbit rings', () => {
  assert.doesNotMatch(page, /pm-orbit/u);
  assert.doesNotMatch(css, /pm-orbit/u);
  assert.match(page, /function spokesEl\(/u);
  assert.match(css, /\.pm-spokes \{/u);
});

test('a spoke carries the same activity its bubble’s distance does', () => {
  // One source for both, so the line and the gap can never disagree. `heat` is
  // the normalised activity; the busiest topic is 1 and the quietest 0.
  const out = sky.place(520, 700, [
    { members: 40, activity: 9000, labelWidth: 90 },
    { members: 40, activity: 900, labelWidth: 90 },
    { members: 40, activity: 90, labelWidth: 90 },
  ]);
  const heats = out.spots.map((s) => s.heat);
  assert.equal(heats[0], 1);
  assert.equal(heats[heats.length - 1], 0);
  for (let i = 1; i < heats.length; i += 1) assert.ok(heats[i] < heats[i - 1]);
  // A single topic has no range to normalise over and must not divide by it.
  assert.equal(sky.place(520, 700, [{ members: 4, activity: 7, labelWidth: 40 }]).spots[0].heat, 1);
});

test('the topic label is a pill on the hem, and the ring makes room for it', () => {
  assert.match(css, /\.pm-cluster-label \{[\s\S]*?bottom: -8px;/u);
  assert.match(css, /\.pm-cluster-label \{[\s\S]*?z-index: 2;/u,
    'a packed face must never cover the topic name');
  // The 8px it hangs below the circle is reserved off the ring's vertical
  // radius, or the lowest bubble on the stage loses its label to the panel
  // edge. Same stage, same bubble: the vertical ring is 8px shorter than the
  // horizontal one is for the same margin.
  const ring = sky.ringFor(600, 600, 100);
  assert.equal(ring.rx - ring.ry, 8);
});

test('the constellation core wears the same mood as the home orb', () => {
  const tod = readFileSync(join(WIDGET, 'ui', 'orb-tod.js'), 'utf8');
  // ONE driver, not a second copy of the five bands. The whole failure this
  // closes is two stylesheets holding the same colours and drifting apart:
  // .pm-core had power hour written out longhand, so it matched the orb for
  // five hours a day and contradicted it for the other nineteen.
  assert.match(html, /<script src="orb-tod\.js"><\/script>/u);
  assert.doesNotMatch(css, /--tod-grad:/u, 'the timeline must not redefine a band');
  assert.match(css, /background: var\(--tod-grad,/u);
  assert.match(css, /box-shadow: 0 0 34px var\(--tod-glow,/u);
  // The opt-in, and the driver that honours it.
  assert.match(page, /core\.className = 'pm-core tod-orb';/u);
  assert.match(tod, /querySelectorAll\('\.orb, \.tod-orb'\)/u);
  // The core is built on every render of the globe, long after orb-tod.js ran
  // and possibly 59 seconds before its next tick, so it has to be able to ask.
  assert.match(tod, /window\.__hzTodApply = apply;/u);
  assert.match(page, /globalThis\.__hzTodApply\(\)/u);
});

test('each highlight card takes its colour from an orb time-of-day band', () => {
  const palette = readFileSync(join(WIDGET, 'ui', 'palette.css'), 'utf8');
  // The kind rides to the DOM so the stylesheet can key on it; a switch in the
  // page would put the colour in two files.
  assert.match(page, /data-kind="\$\{esc\(h\.kind\)\}"/u);
  assert.match(page, /data-kind="\$\{esc\(a\.kind\)\}"/u);
  for (const kind of ['person-of-the-year', 'back-from-your-past', 'rising-star', 'drifting', 'streak']) {
    assert.match(css, new RegExp(`\\.pm-card\\[data-kind="${kind}"\\] \\.pm-card-eyebrow`, 'u'),
      `${kind} has no card colour`);
    assert.match(css, new RegExp(`\\.pl-award\\[data-kind="${kind}"\\]`, 'u'),
      `${kind}'s row glyph does not match its card`);
  }
  // Every literal the block uses is a stop the orb actually paints, so the two
  // surfaces cannot drift into being nearly-the-same colours.
  const block = /A COLOUR PER CARD[\s\S]*?drifting"\] \{[^}]*\}/u.exec(css)[0];
  for (const hex of new Set(block.match(/#[0-9a-f]{6}/gu))) {
    if (hex === '#191918') continue; // the card background, quoted in the note
    assert.ok(palette.includes(hex), `${hex} is not a colour the orb uses`);
  }
});

test('the globe is a floating icon, not a tab', () => {
  assert.match(html, /class="pm-globe"/u);
  assert.doesNotMatch(html, /pm-tab-globe/u);
  assert.doesNotMatch(css, /pm-tab-globe/u);
  // Both shapes still answer the one delegated click handler.
  assert.match(page, /closest\('\.pm-tab, \.pm-globe'\)/u);
  // And its ink lands on the years' BASELINE, not on the tab's box edge —
  // 7px of lift, measured, with the arithmetic in the rule above it.
  assert.match(css, /\.pm-globe \{[\s\S]*?margin: 0 0 7px 8px;[\s\S]*?padding: 0 2px;/u);
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

// The row marks are the cards' own glyphs, joined to the rows by key from the
// year payload — never a second icon set, and never a label the page keeps its
// own copy of.
test('the list marks a row with the card icon of every category it is top five in', () => {
  assert.match(page, /function awardIndex\(data\)/u);
  assert.match(page, /data\.awards/u);
  assert.match(page, /CARD_ICON\[a\.kind\] \|\| FALLBACK_ICON/u,
    'the mark reuses the card glyph rather than introducing another');
  assert.match(page, /data-tip="\$\{esc\(a\.label\)\}"/u,
    'the label comes from the payload, not from a copy in the page');
  // In front of the name, after the face.
  assert.match(page, /pl-face[\s\S]{0,200}awardsHtml\(p\) \+\n\s*`<span class="pl-name">/u);
  // And the index is rebuilt per paint, so a year change cannot leave marks behind.
  assert.match(page, /awardsByKey = awardIndex\(data\);/u);
  assert.match(page, /awardsByKey = new Map\(\);/u, 'a search carries no marks');
});
