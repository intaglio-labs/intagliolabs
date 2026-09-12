import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOwner, markOwnerPerson, markPersonRole, ownerConfigPath } from '../server/people/owner.mjs';
import { googleTokensPath } from '../../connectors/lib/googleAccounts.mjs';

test('loadOwner exposes configured high schools for shared-affiliation search', () => {
  const home = mkdtempSync(join(tmpdir(), 'hazlie-school-'));
  try {
    const configPath = ownerConfigPath(home);
    markOwnerPerson({ key: 'id:owner@example.test', configPath });
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    raw.highSchools = ['Lincoln High School', 'Lincoln High School'];
    writeFileSync(configPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    assert.deepEqual(loadOwner({ configPath }).highSchools, ['Lincoln High School']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

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

// WHO "ME" IS ON AN OAUTH INSTALL.
//
// `mail.accounts[]` stopped deciding which mailboxes exist when the connector
// moved to OAuth (connect/lib/status.mjs: "an AUTHORIZED account is a
// configured one"). Nothing writes that array any more, and `ownerEmails` is
// empty until the owner marks somebody — so on an ordinary install the owner's
// own Gmail address was in NEITHER, and graph.mjs minted them as a calendar
// person off their own invitations.
//
// The fixture is heterogeneous on purpose: a grant, a legacy config account,
// a hand-listed alias, and a genuine third party. "Take everything" and "take
// nothing" both fail it.
test('every authorized Google account is an owner address', () => {
  const home = mkdtempSync(join(tmpdir(), 'hazlie-owner-grants-'));
  try {
    mkdirSync(join(home, '.hazlie', 'secrets'), { recursive: true, mode: 0o700 });
    for (const email of ['owner@example.test', 'Owner.Work@Example.Test']) {
      writeFileSync(
        googleTokensPath(email, home),
        JSON.stringify({
          account_email: email,
          access_token: 'a',
          refresh_token: 'r',
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        }),
        { mode: 0o600 }
      );
    }
    const configPath = ownerConfigPath(home);
    mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true, mode: 0o700 });
    writeFileSync(
      configPath,
      JSON.stringify({
        mail: { accounts: [{ user: 'legacy@example.test' }] },
        ownerEmails: ['owner@old-co.test'],
      }),
      { mode: 0o600 }
    );

    const owner = loadOwner({ configPath });
    assert.equal(owner.addresses.has('owner@example.test'), true, 'the grant this Mac holds');
    assert.equal(owner.addresses.has('owner.work@example.test'), true,
      'and the second one, lowercased the way every caller compares them');
    assert.equal(owner.addresses.has('legacy@example.test'), true,
      'the pre-OAuth config array still counts');
    assert.equal(owner.addresses.has('owner@old-co.test'), true,
      'and the aliases the owner listed by hand');
    assert.equal(owner.addresses.has('dana@example.test'), false,
      'a third party is not the owner because they were on an invitation');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// There is no separate calendar account list to miss: calendar reads the same
// Google grants (connectors/sources/calendar.mjs via accountsForScope), and
// the config's "calendar" section carries `backend` and nothing else
// (connectors/daemon.mjs CALENDAR_KEYS). This pins that, because the day it
// grows an account list is the day this set silently stops covering it.
test('the calendar config has no account list of its own to miss', async () => {
  const daemon = await import('../../connectors/daemon.mjs');
  const source = readFileSync(
    new URL('../../connectors/daemon.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /const CALENDAR_KEYS = Object\.freeze\(\['backend'\]\);/u,
    'a calendar account list would need adding to loadOwner');
  assert.equal(typeof daemon.DEFAULT_INTERVAL_S, 'number');
});
