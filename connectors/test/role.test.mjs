import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROLE, ROLES, sourcesForRole, validateConfig } from '../daemon.mjs';

// The default must stay `hazlie`: an unset role appearing in an existing
// single-machine install must not silently switch it to reading-only.
test('an unset or unknown role falls back to hazlie', () => {
  assert.equal(DEFAULT_ROLE, 'hazlie');
  assert.deepEqual(sourcesForRole(undefined), sourcesForRole('hazlie'));
  assert.deepEqual(sourcesForRole('nonsense'), sourcesForRole('hazlie'));
});

// Without this split, the MacBook would poll Oura and Google alongside the
// Mini — doubling every API call and racing on the same cursors.
test('each role runs only the sources it is the right machine for', () => {
  const hazlie = sourcesForRole('hazlie');
  const personal = sourcesForRole('personal');
  assert.ok(hazlie.includes('calendar') && hazlie.includes('oura') && hazlie.includes('mail'));
  assert.ok(!hazlie.includes('imessage'), 'the Mini has its own Apple ID, not the owner history');
  assert.ok(!hazlie.includes('photos'), 'nor the owner photo library');
  assert.ok(!hazlie.includes('notes'), 'nor the owner notes');
  assert.deepEqual(personal, ['imessage', 'photos', 'notes', 'whatsapp'], "the owner's Mac holds the owner's own stores");
  assert.equal(personal.some((s) => hazlie.includes(s)), false, 'no source runs on both');
});

test('config validation accepts the two roles and rejects anything else', () => {
  for (const role of ROLES) assert.doesNotThrow(() => validateConfig({ role }));
  assert.doesNotThrow(() => validateConfig({}), 'role is optional');
  assert.throws(() => validateConfig({ role: 'macbook' }), /must be one of/u);
  assert.throws(() => validateConfig({ roles: 'personal' }), /unknown key/u);
});

// The filter must be APPLIED, not merely defined. sourcesForRole was
// unit-tested and passing while the daemon loaded every source regardless —
// a green test over an uncalled function.
test('the role filter selects real source modules by name', async () => {
  const { loadSources } = await import('../daemon.mjs');
  const discovered = (await loadSources()).map((s) => s.name).sort();
  assert.ok(discovered.includes('imessage') && discovered.includes('calendar'));

  // Sorted on both sides: `discovered` comes back alphabetical, so comparing
  // against ROLE_SOURCES order would be asserting the wrong thing.
  const personal = discovered.filter((n) => sourcesForRole('personal').includes(n));
  assert.deepEqual(personal, ['imessage', 'notes', 'photos', 'whatsapp'].sort(), 'the personal Mac runs the owner-store sources');

  const hazlie = discovered.filter((n) => sourcesForRole('hazlie').includes(n));
  assert.ok(hazlie.includes('calendar') && hazlie.includes('oura'));
  assert.ok(!hazlie.includes('imessage') && !hazlie.includes('photos'));
});

// --- the 2026-08-20 architecture: brain on the Mac, voice on the Mini -------

test('full runs every connector; courier runs none', () => {
  const full = sourcesForRole('full');
  for (const s of ['imessage', 'photos', 'notes', 'calendar', 'mail', 'granola', 'oura']) {
    assert.ok(full.includes(s), `full must run ${s}`);
  }
  assert.deepEqual(sourcesForRole('courier'), [], 'the Mini holds none of the owner corpus');
});

// Adding roles must not repurpose an install whose config predates them.
test('the default role is unchanged by the new roles', () => {
  assert.equal(DEFAULT_ROLE, 'hazlie');
  assert.deepEqual(sourcesForRole(undefined), sourcesForRole('hazlie'));
});

test('config validation accepts the new roles', () => {
  for (const role of ['full', 'courier']) assert.doesNotThrow(() => validateConfig({ role }));
  assert.throws(() => validateConfig({ role: 'brain' }), /must be one of/u);
});
