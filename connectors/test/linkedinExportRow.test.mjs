// THE LINKEDIN EXPORT HAS A TILE AGAIN, and the status payload says whether the
// feature registry could be read at all.
//
// Two rows, two flows, one platform: the bridge tile belongs to the `bridges`
// feature and the export tile to `connectors.linkedin`. With bridges off the
// export connector (connectors/sources/linkedin.mjs) stays scheduled and keeps
// polling ~/.hazlie/imports/linkedin, and until this row came back there was
// nothing anywhere telling the owner to put Connections.csv there.
//
// It lives under connectors/test rather than connect/test because that is the
// directory this change was allowed to add files to; the module under test is
// connect/lib/status.mjs.
//
// Every fixture synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LINKEDIN_EXPORT_ID, featureRegistryState, readStatus } from '../../connect/lib/status.mjs';
import { statusResponse } from '../../connect/lib/statusApi.mjs';

const TOKEN = 'ab'.repeat(32); // 64 hex chars, deliberately not a real secret

function fakeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'hz-linkedin-export-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(secrets, 'hermes-token.txt'), `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(join(secrets, 'hermes-token.txt'), 0o600);
  return home;
}

const find = (rows, id) => rows.find((row) => row.id === id);

test('the export row reports whether Connections.csv is in the import folder', (t) => {
  const home = fakeHome(t);
  const before = find(readStatus({ home }), LINKEDIN_EXPORT_ID);
  assert.ok(before, 'the export tile must exist even when the bridge row does');
  assert.equal(before.connected, false);
  assert.equal(before.action, 'linkedin', 'not connected means there is a flow to start');
  assert.match(before.detail, /export/u);

  const imports = join(home, '.hazlie', 'imports', 'linkedin');
  mkdirSync(imports, { recursive: true });
  writeFileSync(join(imports, 'Connections.csv'), 'First Name,Last Name\n');
  const after = find(readStatus({ home }), LINKEDIN_EXPORT_ID);
  assert.equal(after.connected, true);
  assert.equal(after.action, null);
  // COUNTS AND STATE ONLY. Nothing out of the file reaches the row.
  assert.equal(JSON.stringify(after).includes('First Name'), false);
});

test('the export row and the bridge row are separate tiles for separate flows', (t) => {
  const home = fakeHome(t);
  const rows = readStatus({ home });
  const bridge = find(rows, 'linkedin');
  assert.ok(bridge, 'the bridge row is still listed from PLATFORMS');
  assert.equal(bridge.action, 'bridge');
  assert.notEqual(bridge.id, LINKEDIN_EXPORT_ID);
});

test('the export row answers its own disable marker, not the Matrix bus one', (t) => {
  const home = fakeHome(t);
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true });
  writeFileSync(join(home, '.hazlie', 'connectors', 'linkedin.disabled'), '');
  const rows = readStatus({ home });
  assert.equal(find(rows, LINKEDIN_EXPORT_ID).disabled, true,
    'run.mjs linkedin --disable stops the export connector, so its tile must say so');
  assert.notEqual(find(rows, 'linkedin').disabled, true,
    'the bridge row follows matrix.disabled — one Matrix poller, one marker');

  writeFileSync(join(home, '.hazlie', 'connectors', 'matrix.disabled'), '');
  assert.equal(find(readStatus({ home }), 'linkedin').disabled, true);
});

test('the status payload carries why the feature registry answered what it did', (t) => {
  const home = fakeHome(t);
  const { status, body } = statusResponse({ authorization: `Bearer ${TOKEN}`, home });
  assert.equal(status, 200);
  // The shelf draws a blank grid for an unreadable registry and for a machine
  // with nothing connected. Without this field the page cannot tell them apart,
  // and the one it cannot diagnose is the total outage.
  assert.equal(body.registryState, featureRegistryState());
  assert.ok(['ok', 'missing', 'invalid'].includes(body.registryState));
  assert.equal(body.registryState, 'ok', 'this checkout ships a readable ops/features.json');
});
