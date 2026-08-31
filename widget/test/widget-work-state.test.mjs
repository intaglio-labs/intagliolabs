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
  // ~~`${workEstimate || 'estimating time left…'}`~~ was pinned here, and the
  // string it pinned is the defect. The daemon stopped publishing an estimate
  // for matrix backfill on purpose — its arithmetic was a floor rendered as a
  // forecast — so that fallback rendered a promise of a number that never
  // arrives, forever. Absence of an estimate must read as SILENCE, and the
  // count the daemon does publish is shown in its place when there is one.
  assert.match(script, /const detail = workEstimate \|\| workScope;/u,
    'a count may stand in for an estimate, but nothing may stand in for both');
  // CODE ONLY. widget.js retracts the old string by quoting it, so a raw scan
  // matches the retraction and reports the fixed defect as still present. That is
  // the fifth time this session a test has asserted against its own comment.
  const code = script.split('\n').filter((l) => !/^\s*\/\//u.test(l)).join('\n');
  assert.doesNotMatch(code, /estimating time left/u,
    'the widget must not promise a time it has not been given');
  assert.match(script, /setInterval\(refreshWorkState, 1500\)/u);
});

test('processing gives the orb an expressive thinking performance', () => {
  assert.match(html, /class="orb-thoughts"/u);
  assert.equal((html.match(/class="thought th[123]"/gu) || []).length, 3);
  assert.doesNotMatch(html, /energy-bolt|energy-star|energy-trail/u,
    'the old thunder and orbital treatment is fully removed');
  assert.match(script, /const processing = voiceOrbState === 'idle' && !!workLabel;/u);
  assert.match(script, /classList\.toggle\('processing', processing\)/u);
  assert.match(palette, /\.orb\.processing \.orb-thoughts \{ display: block; \}/u);
  assert.match(palette, /@keyframes processing-ponder/u);
  assert.match(palette, /@keyframes processing-glance/u);
  assert.match(palette, /@keyframes thought-gather/u);
  assert.match(palette, /@keyframes thought-cloud-gather/u);
  assert.doesNotMatch(palette, /\.orb\.processing \.face::(?:before|after)/u,
    'processing does not add stray half-circle marks to the face');
  assert.match(palette, /\.orb-thoughts \.th3::before,[\s\S]*?\.orb-thoughts \.th3::after/u,
    'the largest thought is an organic little cloud rather than another dot');
  assert.match(palette, /\.orb-thoughts \{[\s\S]*?top: -10px;[\s\S]*?right: -2px;/u,
    'the thought trail stays inside the window while gathering above the upper-right crown');
  assert.match(palette, /\.orb-thoughts \.th1 \{ left: 14px; bottom: 5px;/u);
  assert.match(palette, /\.orb-thoughts \.th2 \{ left: 16px; bottom: 8px;/u,
    'the trail begins at the upper-right rim instead of the middle of the face');
  assert.match(palette, /prefers-reduced-motion:[\s\S]*\.orb\.processing \.thought \{ opacity: 0\.82; transform: none; \}/u);
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
  // WAS: /const completionTimes = scheduledQueue\(\).map\(\(task\) => task.nextTs\)/,
  // "the total reaches the final task in the live scheduler queue".
  //
  // That contract shipped and the owner rejected it on sight: an idle daemon
  // read "~ 17.3 HRS LEFT" because the idle-window maintenance pass was armed
  // for 03:30 tomorrow and the horizon took the max over the whole queue
  // ("whats gonna take 17h", 2026-08-29 -- backfill empty, nothing running).
  // Routine passes are WAITS, not work: seconds of work on a fifteen-minute
  // timer, so the gap before one says nothing about how much is left to do.
  // Only resumable history spans multiple bounded passes and can honestly be
  // described in hours. Not a goalpost move -- the estimate still exists and
  // still counts real backfill, which the line below pins unchanged.
  assert.match(daemon, /const completionTimes = \[\];/u,
    'the horizon counts backfill work only, never the routine schedule');
  assert.doesNotMatch(daemon, /const completionTimes = scheduledQueue\(\)/u,
    'a routine poll must never be counted as work remaining');
  assert.match(daemon, /estimate: `~ \$\{\(tenthsOfAnHour \/ 10\)\.toFixed\(1\)\} hrs left`/u);
  assert.match(connectors, /estimate\.hasPrefix\("≥ "\) \|\| estimate\.hasPrefix\("≈ "\)/u,
    'a persisted snapshot is normalized before the daemon republishes it');
  assert.ok(connectors.includes('var activityEstimate: String?'));
  assert.match(bridge, /activity\["estimate"\] = estimate/u);
  assert.match(connections, /activity-estimate/u);
  assert.match(connections, /estimate\.hidden = !total/u,
    'the total is pinned in the header and hidden only when no queue exists');
  assert.match(connections, /estimateLine\.hidden = !total/u,
    'the explanation stays beside a real estimate and disappears with it');
  assert.ok(connections.includes('Your Mac is importing and summarizing everything privately. More chats and years mean more time.'),
    'the estimate explains the wait in two simple sentences');
  assert.ok(connections.includes("'Why is this taking so long?'"),
    'the hint icon has an accessible question');
  assert.match(palette, /\.activity-estimate-line \.setting-hint-copy \{[\s\S]*?right: 0;/u,
    'the right-edge hint grows inward instead of clipping');
  // The row answers TWO questions now, and each side of the merge asserted on
  // its own half of one string. Which year comes from the cross-connector
  // barrier; how many conversations replaced an ETA that could not move (it was
  // ceil(rooms/perPass), always 1). Assert the composed label rather than either
  // fragment, or this goes red the next time the other half moves.
  assert.ok(connectors.includes('"fetching \\($0) \\(subject)\\(scope)"'),
    'a yearly row names the year, the connector, and how much is in flight');
  assert.ok(connectors.includes('?? "backfilling \\(subject) history\\(scope)"'),
    'and the non-yearly row still says how much');
  assert.match(connectors, /raw\["backfillRooms"\] as\? Int/u,
    'the scope must come from a published count, not be composed here');
  assert.match(connectors, /connector == "matrix" \? matrixPlatformLabels\(raw\)/u,
    'Matrix history is split into the connected platform labels');
  assert.doesNotMatch(connectors, /matrix": "social messages"/u,
    'the transport name never replaces a user-facing platform name');
});

test('activity shows current plus two queued rows and keeps the full queue scrollable', () => {
  assert.match(palette, /\.activity-list \{[\s\S]*?max-height: 55px; overflow-y: scroll;/u,
    'three 15px rows and two 5px gaps fit in the activity viewport');
  assert.match(connections, /for \(const item of items\)/u,
    'the remaining queue stays in the DOM so it can be reached by scrolling');
  assert.doesNotMatch(connections, /items\.slice\(0, 3\)/u,
    'the viewport, not the data, limits what is visible');
});

test('only live work says current; scheduled connectors show only future order', () => {
  assert.ok(connectors.includes('"label": "current: syncing \\(label)"'));
  assert.ok(connectors.includes('"label": "next: \\(label)"'));
  assert.doesNotMatch(connectors, /remainingFor/u,
    'a scheduled start countdown is not time remaining on current work');
  assert.ok(!connectors.includes('"current: \\(task'),
    'the first future poll must never masquerade as the current task');
});
