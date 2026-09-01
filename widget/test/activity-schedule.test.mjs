import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const connectors = readFileSync(join(WIDGET, 'src', 'Connectors.swift'), 'utf8');
const bridge = readFileSync(join(WIDGET, 'src', 'Bridge.swift'), 'utf8');
const connections = readFileSync(join(WIDGET, 'ui', 'connections.js'), 'utf8');
const palette = readFileSync(join(WIDGET, 'ui', 'palette.css'), 'utf8');

test('the activity header reports remaining processing time, never the next scheduled run', () => {
  assert.ok(connectors.includes('"label": "next: \\(label)"'));
  assert.doesNotMatch(connectors, /activityScheduleEstimate|scheduledDelayLabel/u,
    'a scheduled start is not an estimate of processing time left');
  assert.ok(
    !connectors.includes('"label": "next: \\(label) · \\(scheduledDelayLabel'),
    'the countdown must not be repeated on each task row'
  );
  assert.match(
    bridge,
    /if let estimate = Connectors\.shared\.activityEstimate \{/u,
    'Activity receives only a measured processing ETA'
  );
  assert.doesNotMatch(bridge, /activityEstimate\s*\n\s*\?\?/u,
    'the bridge must not replace a missing processing ETA with a schedule countdown');
});

test('portal discovery reports remaining work', () => {
  assert.doesNotMatch(connectors, /return "\\\(n\) to join"/u,
    'the header is a measured completion ETA, never the raw queue length');
});

test('People processing never borrows an unrelated connector countdown', () => {
  assert.doesNotMatch(bridge, /activityScheduleEstimate/u);
});

test('a queue-only activity view does not add an internal-jargon preamble', () => {
  assert.doesNotMatch(connections, /catch-up/u);
  assert.doesNotMatch(connections, /scheduled checks only/u);
});

test('future queue rows never receive the pulsing live-work treatment', () => {
  assert.match(connections, /item\.kind === 'queue'.*activity-queue/u);
  assert.match(palette, /\.activity-item\.activity-queue \.activity-dot \{[\s\S]*?animation: none/u);
});
