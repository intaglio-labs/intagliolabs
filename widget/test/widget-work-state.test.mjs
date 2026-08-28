// The ambient widget must show real work without mistaking the connector queue
// for work. Its title is the only hover surface on the transparent desktop orb,
// so it carries the current task in the same state transition as the face.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(join(WIDGET, 'ui', 'widget.js'), 'utf8');
const html = readFileSync(join(WIDGET, 'ui', 'widget.html'), 'utf8');
const palette = readFileSync(join(WIDGET, 'ui', 'palette.css'), 'utf8');
const connections = readFileSync(join(WIDGET, 'ui', 'connections.js'), 'utf8');
const bridge = readFileSync(join(WIDGET, 'src', 'Bridge.swift'), 'utf8');
const connectors = readFileSync(join(WIDGET, 'src', 'Connectors.swift'), 'utf8');
const daemon = readFileSync(join(WIDGET, '..', 'connectors', 'daemon.mjs'), 'utf8');

test('the voice coming-soon thought fits in exactly two deliberate lines', () => {
  assert.match(script, /const TEASE_TEXT = 'voice coming soon\.\\nhelp us build it :\)'/u);
  assert.match(palette, /\.dream-text \{[\s\S]*?font-size: 10\.5px;[\s\S]*?white-space: pre-line;/u);
});

test('the widget gives real work the thinking pose and a current-task hover label', () => {
  assert.match(script, /hzPost\('workStatus'\)/u);
  assert.match(script, /processing \? 'listening' : 'idle'/u);
  assert.match(script, /orbBtn\.title = workLabel \? `processing: \$\{workLabel\}`/u);
  assert.match(script, /setInterval\(refreshWorkState, 1500\)/u);
});

test('processing puts a quiet electrical buzz behind the orb without borrowing the voice state', () => {
  assert.equal((html.match(/class="orb-bolt bolt-/gu) || []).length, 3);
  assert.match(script, /const processing = voiceOrbState === 'idle' && !!workLabel;/u);
  assert.match(script, /classList\.toggle\('processing', processing\)/u);
  assert.match(palette, /\.orb\.processing \.orb-charge \{ display: block; \}/u);
  assert.match(palette, /@keyframes orb-buzz/u);
  assert.match(palette, /\.orb-charge \{[\s\S]*?z-index: 0;/u);
  assert.match(palette, /\.orb-body \{[\s\S]*?z-index: 1;/u,
    'the buzz stays behind the orb without falling behind the transparent window');
  assert.match(palette, /fill: none;/u, 'the marks are thin strokes, not filled stickers');
  assert.match(palette, /animation: orb-buzz 2\.8s ease-in-out infinite;/u,
    'the buzz keeps a slow, soft cadence');
  assert.match(palette, /stroke-linejoin: round;/u, 'the sparks have cartoon-soft corners');
  assert.match(palette, /46% \{[\s\S]*?opacity: 0\.76;/u,
    'the peak remains visible over a bright desktop photo');
  assert.match(palette, /drop-shadow\(0 1px 1px rgba\(0, 0, 0, 0\.82\)\)/u,
    'a tight dark edge separates the cream bolt from arbitrary wallpaper');
  assert.match(palette, /\.bolt-1[^\n]*left: 40px; top: 0;/u);
  assert.match(palette, /\.bolt-2[^\n]*left: 48px; top: 5px;/u);
  assert.match(palette, /\.bolt-3[^\n]*left: 34px; top: 7px;/u,
    'every spark stays in the head’s upper-right quadrant');
  assert.match(palette, /prefers-reduced-motion:[\s\S]*\.orb\.processing \.orb-bolt \{ opacity: 0\.52; \}/u);
});

test('native work status includes active work and unfinished backfill, but excludes the routine future queue', () => {
  assert.match(bridge, /case "workStatus":/u);
  assert.match(bridge, /writing a relationship summary/u);
  assert.match(bridge, /thinking about your question/u);
  assert.match(connectors, /var activeWorkLabel: String\?/u);
  assert.match(connectors, /raw\["phase"\] as\? String == "syncing"/u);
  assert.match(connectors, /raw\["phase"\] as\? String == "waiting"/u);
  assert.match(connectors, /raw\["backfill"\] as\? \[String\]/u);
  assert.ok(connectors.includes('return "backfilling \\(labelFor(connector))"'));
  assert.match(daemon, /return \{[\s\S]*?estimate:[\s\S]*?backfill,/u,
    'the daemon snapshot must distinguish unfinished history from a routine queue');
});

test('the total processing estimate uses the plain approximate-hours label', () => {
  assert.match(daemon, /estimate: `~ \$\{\(tenthsOfAnHour \/ 10\)\.toFixed\(1\)\} hrs left`/u);
  assert.match(connectors, /estimate\.hasPrefix\("≥ "\) \|\| estimate\.hasPrefix\("≈ "\)/u,
    'a persisted snapshot is normalized before the daemon republishes it');
  assert.ok(connectors.includes('"label": "backfilling \\(subjects) history · \\(estimate)"'),
    'the estimate must name the historical work it belongs to');
  assert.doesNotMatch(bridge, /activity\["estimate"\]/u,
    'a detached header estimate makes the first connector look responsible for it');
  assert.doesNotMatch(connections, /activity-estimate/u);
});

test('only live work says current; scheduled connectors show only future order', () => {
  assert.ok(connectors.includes('"label": "current: syncing \\(label)"'));
  assert.ok(connectors.includes('next: \\(task.label ?? labelFor(task.connector))'));
  assert.doesNotMatch(connectors, /remainingFor/u,
    'a scheduled start countdown is not time remaining on current work');
  assert.ok(!connectors.includes('"current: \\(task'),
    'the first future poll must never masquerade as the current task');
});
