import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR_HERMES_SOURCE,
  CONNECTOR_NAMES,
  DEFAULT_DISABLED_CONNECTORS,
  RETENTION_SOURCES,
  validateConfig,
} from '../daemon.mjs';
import { msUntilIdleWindow } from '../retain.mjs';
import { parseArgs, purgeHermesSources } from '../run.mjs';

test('an empty config is valid — every section is optional until its source lands', () => {
  assert.deepEqual(validateConfig({}), {});
});

test('retired LinkedIn config remains valid across an upgrade', () => {
  const legacy = { linkedin: {}, intervals: { linkedin: 900 } };
  assert.deepEqual(validateConfig(legacy), legacy);
  assert.throws(() => validateConfig({ linkedin: { cookie: 'secret' } }), /unknown key "cookie"/u);
});

test('a full config validates', () => {
  const config = {
    selfName: 'Example Owner',
    ownerEmails: ['owner@example.test'],
    ownerPersonKeys: ['id:owner@example.test'],
    highSchools: ['Lincoln High School'],
    personRoles: { 'name:casey example': 'friend' },
    personRolesByYear: {
      2024: { 'name:casey example': 'business' },
      2025: { 'name:casey example': 'friend' },
    },
    intervals: { imessage: 120, oura: 3600 },
    mail: {
      host: 'imap.gmail.com',
      port: 993,
      user: 'owner@example.test',
      folders: ['INBOX', '[Gmail]/Sent Mail'],
      backfillDays: 90,
      maxBodyBytes: 16384,
    },
    imessage: { backfillDays: 365 },
    calendar: {},
    granola: { includeTranscripts: false },
    oura: { backfillDays: 30 },
    retention: { imessage: 365, health: 730, maintainHour: '03:30' },
  };
  assert.deepEqual(validateConfig(config), config);
});

test('unknown keys are refused loudly at every level, naming the key', () => {
  assert.throws(() => validateConfig({ hae: {} }), /unknown key "hae"/); // the removed listener must not linger as config
  assert.throws(() => validateConfig({ mail: { hostname: 'x' } }), /unknown key "hostname"/);
  assert.throws(() => validateConfig({ calendar: { window: 7 } }), /unknown key "window"/);
  assert.throws(() => validateConfig({ intervals: { health: 300 } }), /unknown key "health"/); // the connector is named oura
  assert.throws(() => validateConfig({ retention: { seed: 30 } }), /unknown key "seed"/);
});

test('value shapes are enforced: intervals floor, port range, maintainHour format', () => {
  assert.throws(() => validateConfig({ intervals: { oura: 30 } }), /between 60 and/);
  assert.throws(() => validateConfig({ mail: { port: 70000 } }), /mail\.port/);
  assert.throws(() => validateConfig({ granola: { includeTranscripts: 'yes' } }), /boolean/);
  assert.throws(() => validateConfig({ oura: { backfillDays: 0 } }), /oura\.backfillDays/);
  assert.throws(() => validateConfig({ retention: { maintainHour: '25:00' } }), /HH:MM/);
  assert.throws(() => validateConfig({ retention: { health: 1.5 } }), /retention\.health/);
  assert.throws(() => validateConfig({ ownerEmails: 'owner@example.test' }), /ownerEmails/);
  assert.throws(() => validateConfig({ ownerPersonKeys: [''] }), /ownerPersonKeys/);
  assert.throws(() => validateConfig({ highSchools: 'Lincoln High School' }), /highSchools/);
  assert.throws(() => validateConfig({ highSchools: [''] }), /highSchools/);
  assert.throws(() => validateConfig({ personRoles: [] }), /personRoles/u);
  assert.throws(() => validateConfig({ personRoles: { 'name:casey example': 'coworker' } }), /personRoles/u);
  assert.throws(() => validateConfig({ personRolesByYear: { recent: {} } }), /keys must be years/u);
  assert.throws(() => validateConfig({ personRolesByYear: { 2025: [] } }), /personRolesByYear\.2025/u);
  assert.throws(
    () => validateConfig({ personRolesByYear: { 2025: { 'name:casey example': 'coworker' } } }),
    /personRolesByYear\.2025/u
  );
});

test('the connector roster and its hermes-source mapping stay in lockstep', () => {
  assert.deepEqual(Object.keys(CONNECTOR_HERMES_SOURCE).sort(), [...CONNECTOR_NAMES].sort());
  // oura is the health connector; contacts never writes corpus at all.
  assert.equal(CONNECTOR_HERMES_SOURCE.oura, 'health');
  assert.equal(CONNECTOR_HERMES_SOURCE.contacts, null);
  assert.deepEqual(CONNECTOR_HERMES_SOURCE.matrix, [
    'messenger', 'instagram', 'twitter', 'telegram', 'discord', 'slack', 'linkedin',
  ]);
  // Every mapped hermes source is one retention can name.
  for (const source of Object.values(CONNECTOR_HERMES_SOURCE).flatMap((value) => value ?? [])) {
    if (source !== null) assert.ok(RETENTION_SOURCES.includes(source), source);
  }
});

test('hidden Settings integrations are inert in the daemon by default', () => {
  assert.deepEqual(DEFAULT_DISABLED_CONNECTORS, ['oura', 'photos', 'files', 'notion', 'notes']);
  for (const name of DEFAULT_DISABLED_CONNECTORS) assert.ok(CONNECTOR_NAMES.includes(name));
});

test('a Matrix purge covers every bridged Hermes source and totals the response', async () => {
  const calls = [];
  const result = await purgeHermesSources(CONNECTOR_HERMES_SOURCE.matrix, { token: 'unused' }, {
    purge: async ({ source }) => {
      calls.push(source);
      return { deleted: source === 'messenger' ? 2 : 1, maintained: source === 'linkedin' };
    },
  });
  assert.deepEqual(calls, CONNECTOR_HERMES_SOURCE.matrix);
  assert.deepEqual(result, { deleted: 8, maintained: true });
});

test('msUntilIdleWindow lands on the next local occurrence, always in the future', () => {
  const now = new Date(2026, 7, 19, 10, 0, 0).getTime(); // 10:00 local
  assert.equal(msUntilIdleWindow('11:30', now), 90 * 60_000); // later today
  assert.equal(msUntilIdleWindow('03:30', now), (24 - 10 + 3.5) * 3_600_000); // tomorrow
  // Landing exactly on the minute schedules tomorrow, never a zero-delay refire.
  const onTheMinute = new Date(2026, 7, 19, 3, 30, 0).getTime();
  assert.equal(msUntilIdleWindow('03:30', onTheMinute), 86_400_000);
  assert.throws(() => msUntilIdleWindow('3:30'), /HH:MM/);
});

test('run.mjs argument parsing is a closed set: sources, flags, exclusivity', () => {
  assert.deepEqual(parseArgs(['oura']), { name: 'oura', flag: null });
  assert.deepEqual(parseArgs(['mail', '--backfill']), { name: 'mail', flag: '--backfill' });
  assert.throws(() => parseArgs(['health']), /usage/); // the connector is named oura
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['mail', '--force']), /unknown flag/);
  assert.throws(() => parseArgs(['mail', '--purge', '--backfill']), /mutually exclusive/);
});
