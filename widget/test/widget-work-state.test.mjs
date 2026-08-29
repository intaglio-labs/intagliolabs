// The ambient widget must show real work continuously across the connector
// queue's bounded pauses. Its hover surface carries the current task and total
// horizon in the same state transition as the face.

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
  assert.match(script, /orbBtn\.title = workLabel \? workDetailText\(\)\.replace\('\\n', ' — '\)/u);
  assert.match(script, /return `current: \$\{workLabel\}\\n\$\{workEstimate \|\| 'estimating time left…'\}`/u);
  assert.match(script, /setInterval\(refreshWorkState, 1500\)/u);
});

test('processing shows a crisp spinning flywheel with outward sparks without borrowing the voice state', () => {
  assert.equal((html.match(/class="think-spark spark-/gu) || []).length, 3);
  assert.match(html, /class="orb-thinker"/u);
  assert.match(html, /class="think-wheel"/u);
  assert.match(script, /const processing = voiceOrbState === 'idle' && !!workLabel;/u);
  assert.match(script, /classList\.toggle\('processing', processing\)/u);
  assert.match(palette, /\.orb\.processing \.orb-thinker \{ display: block; \}/u);
  assert.match(palette, /@keyframes thinker-spin/u);
  assert.match(palette, /@keyframes thinker-spark/u);
  assert.match(palette, /\.orb-thinker \{[\s\S]*?z-index: 3;/u,
    'the icon remains visible above the orb and the transparent window');
  assert.match(palette, /animation: thinker-spin 1\.35s/u);
  assert.match(palette, /animation: thinker-spark 1\.35s/u);
  assert.match(palette, /stroke-linejoin: round;/u, 'the spinner and sparks have soft corners');
  assert.match(palette, /drop-shadow\(0 1px 1px rgba\(0, 0, 0, 0\.82\)\)/u,
    'a tight dark edge separates the cream icon from arbitrary wallpaper');
  assert.match(palette, /top: -15px;[\s\S]*?right: -13px;/u,
    'the complete thinking mark stays at the head’s upper-right');
  assert.match(palette, /prefers-reduced-motion:[\s\S]*\.orb\.processing \.think-wheel \{ transform: rotate\(28deg\); \}/u);
});

test('hover holds current work details and click pins the task plus total hours', () => {
  assert.match(script, /orbBtn\.addEventListener\('pointerenter'/u);
  assert.match(script, /if \(workLabel && !dazed && !jackpotOn\) showWorkDetails\(\)/u);
  assert.match(script, /if \(dreamKind === 'work' && !teaseTimer\) hideTease\(\)/u);
  assert.match(script, /if \(workLabel\) \{[\s\S]*?showWorkDetails\(WORK_DETAILS_MS\);[\s\S]*?return;/u,
    'a processing click reveals status instead of the unrelated voice teaser');
  assert.match(script, /workEstimate = workLabel && typeof status\.estimate === 'string'/u);
  assert.match(script, /showTease\(workDetailText\(\), dwellMs, 'work'\)/u);
});

test('native work status stays processing across bounded connector-queue pauses', () => {
  assert.match(bridge, /case "workStatus":/u);
  assert.match(bridge, /writing a relationship summary/u);
  assert.match(bridge, /beginOnce\(workKey, label: "writing a relationship summary"\)/u);
  assert.match(bridge, /data\["pending"\] as\? Bool != true \{ Bridge\.activeWork\.finish\(workKey\) \}/u,
    'summary polling holds one continuous native work state until the background job is complete');
  assert.match(bridge, /thinking about your question/u);
  assert.match(bridge, /status\["estimate"\] = estimate/u,
    'the hover card receives the same total-hours horizon as Settings');
  assert.match(connectors, /var activeWorkLabel: String\?/u);
  assert.match(connectors, /var queuedWorkLabel: String\?/u);
  assert.match(connectors, /return "working through connector queue"/u);
  assert.match(bridge, /Connectors\.shared\.queuedWorkLabel/u,
    'the orb cannot sleep while Settings still has a total-hours queue');
  assert.match(connectors, /raw\["phase"\] as\? String == "syncing"/u);
  assert.match(connectors, /raw\["phase"\] as\? String == "waiting"/u);
  assert.match(connectors, /raw\["backfill"\] as\? \[String\]/u);
  assert.ok(connectors.includes('?? "backfilling \\(platform)"'));
  assert.ok(connectors.includes('?? "backfilling \\(labelFor(connector))"'));
  assert.ok(connectors.includes('"fetching \\($0) \\(platform)"'));
  assert.match(daemon, /return \{[\s\S]*?estimate:[\s\S]*?backfill,/u,
    'the daemon snapshot must distinguish unfinished history from a routine queue');
});

test('the total processing estimate uses the plain approximate-hours label', () => {
  assert.match(daemon, /const completionTimes = scheduledQueue\(\)\.map\(\(task\) => task\.nextTs\)/u,
    'the total reaches the final task in the live scheduler queue');
  assert.match(daemon, /estimate: `~ \$\{\(tenthsOfAnHour \/ 10\)\.toFixed\(1\)\} hrs left`/u);
  assert.match(connectors, /estimate\.hasPrefix\("≥ "\) \|\| estimate\.hasPrefix\("≈ "\)/u,
    'a persisted snapshot is normalized before the daemon republishes it');
  assert.ok(connectors.includes('var activityEstimate: String?'));
  assert.match(bridge, /activity\["estimate"\] = estimate/u);
  assert.match(connections, /activity-estimate/u);
  assert.match(connections, /estimate\.hidden = !total/u,
    'the total is pinned in the header and hidden only when no queue exists');
  assert.ok(connectors.includes('"fetching \\($0) \\(subject)"'),
    'yearly backfill rows name the exact value-producing year and connector');
  assert.match(connectors, /connector == "matrix" \? matrixPlatformLabels\(raw\)/u,
    'Matrix history is split into the connected platform labels');
  assert.doesNotMatch(connectors, /matrix": "social messages"/u,
    'the transport name never replaces a user-facing platform name');
});

test('only live work says current; scheduled connectors show only future order', () => {
  assert.ok(connectors.includes('"label": "current: syncing \\(label)"'));
  assert.ok(connectors.includes('next: \\(task.label ?? labelFor(task.connector))'));
  assert.doesNotMatch(connectors, /remainingFor/u,
    'a scheduled start countdown is not time remaining on current work');
  assert.ok(!connectors.includes('"current: \\(task'),
    'the first future poll must never masquerade as the current task');
});
