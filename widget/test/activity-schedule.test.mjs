import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const connectors = readFileSync(join(WIDGET, 'src', 'Connectors.swift'), 'utf8');
const connections = readFileSync(join(WIDGET, 'ui', 'connections.js'), 'utf8');
const palette = readFileSync(join(WIDGET, 'ui', 'palette.css'), 'utf8');

test('a scheduled connector is explicitly a next check, not an active task', () => {
  assert.match(connectors, /private func scheduledDelayLabel/u);
  assert.ok(connectors.includes('next check: \\(label) · \\(scheduledDelayLabel(task.nextTs, now: now))'));
  assert.ok(connectors.includes('deltaMs < -90_000'), 'an overdue schedule must be visible');
});

test('a queue-only activity view does not add an internal-jargon preamble', () => {
  assert.doesNotMatch(connections, /catch-up/u);
  assert.doesNotMatch(connections, /scheduled checks only/u);
});

test('future queue rows never receive the pulsing live-work treatment', () => {
  assert.match(connections, /item\.kind === 'queue'.*activity-queue/u);
  assert.match(palette, /\.activity-item\.activity-queue \.activity-dot \{[\s\S]*?animation: none/u);
});
