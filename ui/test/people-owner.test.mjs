import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOwner, markOwnerPerson, markPersonRole, ownerConfigPath } from '../server/people/owner.mjs';

test('markOwnerPerson persists a stable self key and only email-shaped aliases', () => {
  const home = mkdtempSync(join(tmpdir(), 'hazlie-owner-'));
  try {
    const configPath = ownerConfigPath(home);
    const marked = markOwnerPerson({
      key: 'id:owner@example.test',
      identifiers: ['mail:owner@example.test', 'twitter:sample_owner', 'Example Owner'],
      configPath,
    });
    assert.deepEqual(marked, { key: 'id:owner@example.test', emails: ['owner@example.test'] });
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      ownerPersonKeys: ['id:owner@example.test'],
      ownerEmails: ['owner@example.test'],
    });
    assert.equal(statSync(configPath).mode & 0o777, 0o600);

    const owner = loadOwner({ configPath });
    assert.equal(owner.keys.has('id:owner@example.test'), true);
    assert.equal(owner.addresses.has('owner@example.test'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('markPersonRole persists a local override that loadOwner exposes', () => {
  const home = mkdtempSync(join(tmpdir(), 'hazlie-role-'));
  try {
    const configPath = ownerConfigPath(home);
    assert.deepEqual(markPersonRole({ key: 'name:alex example', role: 'family', configPath }), {
      key: 'name:alex example', role: 'family',
    });
    assert.deepEqual(loadOwner({ configPath }).roles.get('name:alex example'), 'family');
    assert.throws(
      () => markPersonRole({ key: 'name:alex example', role: 'coworker', configPath }),
      /role must be/u
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('markPersonRole stores independent corrections for each year', () => {
  const home = mkdtempSync(join(tmpdir(), 'hazlie-role-year-'));
  try {
    const configPath = ownerConfigPath(home);
    assert.deepEqual(markPersonRole({
      key: 'name:casey example', role: 'romantic', year: 2021, configPath,
    }), { key: 'name:casey example', role: 'romantic', year: 2021 });
    assert.deepEqual(markPersonRole({
      key: 'name:casey example', role: 'friend', year: 2023, configPath,
    }), { key: 'name:casey example', role: 'friend', year: 2023 });

    const owner = loadOwner({ configPath });
    assert.equal(owner.rolesByYear.get('2021').get('name:casey example'), 'romantic');
    assert.equal(owner.rolesByYear.get('2023').get('name:casey example'), 'friend');
    assert.equal(owner.roles.has('name:casey example'), false, 'year edits do not overwrite all-time role');
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).personRolesByYear, {
      2021: { 'name:casey example': 'romantic' },
      2023: { 'name:casey example': 'friend' },
    });
    assert.throws(
      () => markPersonRole({ key: 'name:casey example', role: 'friend', year: 23, configPath }),
      /role year must be/u
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
