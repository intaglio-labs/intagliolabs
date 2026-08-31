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

test('scheduled connector rows share one header countdown', () => {
  assert.match(connectors, /private func scheduledDelayLabel/u);
  assert.ok(connectors.includes('"label": "next: \\(label)"'));
  assert.match(connectors, /var activityScheduleEstimate: String\?/u);
  assert.ok(connectors.includes('return "next run \\(scheduledDelayLabel(next.nextTs, now: now))"'));
  assert.ok(
    !connectors.includes('"label": "next: \\(label) · \\(scheduledDelayLabel'),
    'the countdown must not be repeated on each task row'
  );
  assert.match(
    bridge,
    /activityEstimate\s*\n\s*\?\? Connectors\.shared\.activityScheduleEstimate/u,
    'a finite backfill ETA wins; otherwise Activity receives the one schedule countdown'
  );
  assert.ok(connectors.includes('deltaMs < -90_000'), 'an overdue schedule must be visible');
});

test('portal discovery replaces the retry countdown with remaining work', () => {
  assert.doesNotMatch(connectors, /return "\\\(n\) to join"/u,
    'the header is a measured completion ETA, never the raw queue length');
  assert.match(connectors,
    /var activityScheduleEstimate: String\?[\s\S]*?portalInvitesPending[\s\S]*?return nil/u,
    'the next retry is not an estimate of when portal discovery completes');
});

test('a queue-only activity view does not add an internal-jargon preamble', () => {
  assert.doesNotMatch(connections, /catch-up/u);
  assert.doesNotMatch(connections, /scheduled checks only/u);
});

test('future queue rows never receive the pulsing live-work treatment', () => {
  assert.match(connections, /item\.kind === 'queue'.*activity-queue/u);
  assert.match(palette, /\.activity-item\.activity-queue \.activity-dot \{[\s\S]*?animation: none/u);
});
