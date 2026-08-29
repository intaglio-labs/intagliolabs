import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCoverageReport,
  formatCoverageReport,
  sanitizeActivity,
} from '../coverage.mjs';

test('activity keeps only allowlisted connector labels and numeric estimates', () => {
  assert.deepEqual(sanitizeActivity({
    phase: 'syncing',
    connector: 'matrix',
    platform: 'discord',
    estimate: '~ 4.2 hrs left',
    backfill: ['matrix', 'notes', 'private-account@example.com'],
    backfillYear: 2024,
    queue: [
      { connector: 'matrix', platform: 'telegram', label: 'private display label' },
      { connector: 'imessage' },
      { connector: 'private-account@example.com' },
    ],
  }), {
    phase: 'syncing',
    current: 'discord',
    queue: ['telegram', 'imessage'],
    backfill: ['matrix'],
    backfillYear: 2024,
    estimate: '~ 4.2 hrs left',
  });
});

test('a waiting task stays queued and is never reported as current work', () => {
  assert.deepEqual(sanitizeActivity({
    phase: 'waiting',
    connector: 'matrix',
    platform: 'telegram',
    queue: [{ connector: 'matrix', platform: 'telegram' }],
  }), {
    phase: 'waiting',
    current: null,
    queue: ['telegram'],
    backfill: [],
    backfillYear: null,
    estimate: null,
  });
});

test('coverage report joins social platforms to the Matrix year barrier', () => {
  const activity = sanitizeActivity({
    phase: 'syncing', connector: 'matrix', platform: 'discord',
    backfill: ['matrix'], backfillYear: 2025,
    queue: [{ connector: 'matrix', platform: 'discord' }],
  });
  const report = buildCoverageReport({
    hermes: {
      sources: [{
        source: 'discord', rows: 42, conversations: 3,
        oldest_ts: 1704067200000, newest_ts: 1735689599000,
        years: [{ year: 2024, rows: 42 }],
      }],
    },
    yearly: {
      year: 2025,
      complete: false,
      connectors: [{
        connector: 'matrix', completedYears: [2026], exhausted: false, pending: true,
      }],
    },
    activity,
    contacts: 12,
    pendingPortalInvites: 7,
  });
  const discord = report.sources.find((row) => row.source === 'discord');
  assert.equal(discord.rows, 42);
  assert.deepEqual(discord.completedYears, [2026]);
  assert.equal(discord.historyPending, true);
  const text = formatCoverageReport(report);
  assert.match(text, /Discord\s+42\s+3/);
  assert.match(text, /current: Discord/);
  assert.match(text, /Contacts\s+12/);
  assert.match(text, /Matrix portal invites pending: 7/);
  assert.equal(text.includes('private'), false);
});
