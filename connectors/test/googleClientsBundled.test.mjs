// A FIRST RUN HAS NO CREDENTIALS, AND THAT USED TO BE THE END OF IT.
//
// Every shape googleClients.mjs knew about lived in ~/.hazlie/secrets, which on
// a machine that has never run this before is an empty directory. So
// onboarding's "sign in to google" button spawned a helper that exited before
// printing, connect answered 502, and the owner was asked to register a Google
// Cloud project in order to press a button (clean-machine retest, 2026-09-12).
//
// widget/build.sh now stages the build machine's clients into the bundle and
// this module reads them. The three properties that matter are all here:
//
//   IT FINDS THEM      — a bundled client is usable with nothing in secrets.
//   SECRETS WIN        — the bundle is the build machine's default; ~/.hazlie
//                        is what THIS install chose, and an owner who drops in
//                        a re-issued credential is not overruled by a copy
//                        inside the .app.
//   NO GUESSING        — with two clients and no marker, defaultGoogleClient
//                        answers null rather than pairing half the accounts
//                        with a credential whose refresh Google declines.
//
// And one that is easy to lose: bundled files are read WITHOUT the 0600/0700
// permission gauntlet, because a file inside a signed app bundle is
// world-readable by design and would fail it every time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CLIENT,
  bundledClientsDir,
  defaultGoogleClient,
  listGoogleClients,
  readGoogleClient,
} from '../lib/googleClients.mjs';

// Every case names both directories explicitly, so no test can accidentally
// read whatever this build machine happens to hold.
function box(t, { legacy = false, secrets = {}, bundled = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gcbundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const secretsDir = join(home, '.hazlie', 'secrets');
  const bundledDir = join(root, 'bundle', 'ops', 'google-clients');
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  mkdirSync(bundledDir, { recursive: true, mode: 0o755 });
  if (legacy) {
    writeFileSync(join(secretsDir, 'gcal-client-id.txt'), 'LEGACY-ID\n', { mode: 0o600 });
    writeFileSync(join(secretsDir, 'gcal-client-secret.txt'), 'LEGACY-SECRET\n', { mode: 0o600 });
  }
  for (const [name, body] of Object.entries(secrets)) {
    const path = join(secretsDir, `google-client-${name}.json`);
    writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  for (const [name, body] of Object.entries(bundled)) {
    const path = join(bundledDir, `google-client-${name}.json`);
    // 0644 ON PURPOSE: this is the mode a file in an installed .app has, and
    // it is exactly the mode readSecretJson refuses. A test that wrote 0600
    // here would pass against a reader that still ran the gauntlet.
    writeFileSync(path, JSON.stringify(body), { mode: 0o644 });
    chmodSync(path, 0o644);
  }
  return { home, bundledDir };
}

const PROD = { client_id: 'PROD-ID', client_secret: 'PROD-SECRET', label: 'Intaglio (prod)' };

test('a client that exists only in the bundle is readable', (t) => {
  const at = box(t, { bundled: { prod: PROD } });
  const c = readGoogleClient('prod', at);
  assert.equal(c.id, 'PROD-ID');
  assert.equal(c.secret, 'PROD-SECRET');
  assert.equal(c.label, 'Intaglio (prod)');
});

test('a world-readable bundled client is NOT held to the secrets-file gauntlet', (t) => {
  // 0644 inside the app bundle, and the whole feature dies if this reader
  // demands 0600. The mode is set by box(); this test exists to say out loud
  // that it is the point rather than an accident of the fixture.
  const at = box(t, { bundled: { prod: PROD } });
  assert.doesNotThrow(() => readGoogleClient('prod', at));
  assert.deepEqual(
    listGoogleClients(at).map((c) => c.name),
    ['prod']
  );
});

test('a secrets-dir file of the same name wins over the bundled one', (t) => {
  // The bundle is the build machine's default. ~/.hazlie is what this install
  // chose — a re-issued credential dropped in there must take effect.
  const at = box(t, {
    secrets: { prod: { client_id: 'MINE-ID', client_secret: 'MINE-SECRET', label: 'mine' } },
    bundled: { prod: PROD },
  });
  assert.equal(readGoogleClient('prod', at).id, 'MINE-ID');
  const rows = listGoogleClients(at);
  assert.deepEqual(rows.map((c) => c.name), ['prod'], 'one row, not two');
  assert.equal(rows[0].label, 'mine', 'and it is the installed one that is described');
});

test('the listing merges both directories and names each once', (t) => {
  const at = box(t, {
    secrets: { personal: { client_id: 'a', client_secret: 'b', label: 'Personal' } },
    bundled: { prod: PROD, personal: { client_id: 'x', client_secret: 'y', label: 'shipped' } },
  });
  assert.deepEqual(listGoogleClients(at).map((c) => c.name), ['personal', 'prod']);
  assert.deepEqual(listGoogleClients(at).map((c) => c.label), ['Personal', 'Intaglio (prod)']);
});

test('a malformed bundled client is skipped, not fatal', (t) => {
  const at = box(t, { bundled: { prod: PROD, broken: { client_id: 'only-half' } } });
  assert.deepEqual(listGoogleClients(at).map((c) => c.name), ['prod']);
  assert.equal(defaultGoogleClient(at).name, 'prod', 'and it does not count towards the choice');
});

test('an unknown name still throws, bundle or no bundle', (t) => {
  // Falling back would pair a grant with a credential that cannot renew it,
  // and the failure surfaces an hour later as a dead mailbox.
  const at = box(t, { bundled: { prod: PROD } });
  assert.throws(() => readGoogleClient('nope', at));
});

// ---- which client a NEW sign-in gets when nobody named one ----------------

test('no client anywhere is null, not a guess', (t) => {
  // The state a fresh install built with HAZLIE_SHIP_GOOGLE_CLIENTS=0 is in.
  // The caller has to say so; spawning a helper that exits is what this
  // replaces.
  const at = box(t);
  assert.equal(defaultGoogleClient(at), null);
});

test('the legacy pair wins, because every grant on that install came from it', (t) => {
  const at = box(t, { legacy: true, bundled: { prod: PROD } });
  const picked = defaultGoogleClient(at);
  assert.equal(picked.name, DEFAULT_CLIENT);
  assert.equal(readGoogleClient(picked.name, at).id, 'LEGACY-ID');
});

test('exactly one registered client is the answer without a marker', (t) => {
  const at = box(t, { bundled: { prod: PROD } });
  assert.equal(defaultGoogleClient(at).name, 'prod');
  const at2 = box(t, { secrets: { onlymine: { client_id: 'a', client_secret: 'b' } } });
  assert.equal(defaultGoogleClient(at2).name, 'onlymine');
});

test('two clients and no marker is null — the wrong one is worse than none', (t) => {
  // Google will not renew a refresh token against a different client than the
  // one that issued it, so a coin flip here costs a working mailbox an hour
  // after it looked fine.
  const at = box(t, {
    bundled: {
      internal: { client_id: 'a', client_secret: 'b' },
      external: { client_id: 'c', client_secret: 'd' },
    },
  });
  assert.equal(defaultGoogleClient(at), null);
});

test('"default": true breaks the tie, and picks that one rather than the first', (t) => {
  // Alphabetically `external` sorts first, so a marker that worked by accident
  // of ordering would pass this with the wrong answer.
  const at = box(t, {
    bundled: {
      external: { client_id: 'c', client_secret: 'd' },
      internal: { client_id: 'a', client_secret: 'b', default: true },
    },
  });
  assert.equal(defaultGoogleClient(at).name, 'internal');
});

test('the marker does not outrank the legacy pair', (t) => {
  const at = box(t, {
    legacy: true,
    bundled: { prod: { ...PROD, default: true }, other: { client_id: 'c', client_secret: 'd' } },
  });
  assert.equal(defaultGoogleClient(at).name, DEFAULT_CLIENT);
});

// ---- where the bundle is, in both layouts --------------------------------

test('the bundled directory is resolved against the module, not the cwd', () => {
  // connectors/lib/../../ops/google-clients is the repo root's ops/ in a
  // checkout and Contents/Resources/backend/ops in the app — the same relative
  // path in both layouts, which is the whole reason build.sh puts it there.
  // A cwd-relative path would resolve to wherever the daemon was launched.
  const dir = bundledClientsDir();
  assert.match(dir, /[/\\]ops[/\\]google-clients$/u);
  assert.ok(dir.startsWith('/'), 'absolute, so no caller can change it by chdir');
  assert.doesNotMatch(dir, /connectors/u, 'it lives beside features.json, not under connectors/');
});

// ---------------------------------------------------------------------------
// ONE RULE, THREE READERS (round-4 finding 7, corrected by round-5 finding 2).
//
// Selection enumerated ~/.hazlie/secrets with a plain read while the read path
// put the same file through readSecretJson's 0600-file/0700-parent gauntlet.
// The two disagreed, and because a secrets-dir file SHADOWS the bundled client
// of the same name, the disagreement meant adding a file made a working
// install stop working.
//
// Round 4 settled it by making a secrets file that fails the gauntlet "not a
// client at all" — which handed its NAME to the bundled file beside it. That
// is the one substitution this module exists to prevent: a grant carrying
// `client: "work"` refreshed against a bundled `work` of a different
// client_id is invalid_grant an hour later, with nothing naming the mode.
//
// The rule these tests pin: absent → the bundle; present → the file owns its
// name; unusable → an error that names the file and the fix, and a row that
// says so rather than one that quietly resolves elsewhere.

// The mode is the whole point, so it is set explicitly rather than left to the
// fixture: 0644 is what a file created under the default umask gets.
function writeLooseSecret(home, name, body) {
  const path = join(home, '.hazlie', 'secrets', `google-client-${name}.json`);
  writeFileSync(path, JSON.stringify(body), { mode: 0o644 });
  chmodSync(path, 0o644);
  return path;
}

test('a world-readable secrets file is an error, NOT a swap to the bundled client of that name', (t) => {
  const at = box(t, { bundled: { prod: PROD } });
  writeLooseSecret(at.home, 'prod', { client_id: 'LOOSE-ID', client_secret: 'LOOSE-SECRET', label: 'loose' });

  // The failing input from round-5 finding 2, in miniature: an existing grant
  // says `client: "prod"`, and the bundle holds a DIFFERENT credential under
  // that name. Answering with it is the invalid_grant an hour later.
  assert.throws(() => readGoogleClient('prod', at), (error) => {
    assert.match(error.message, /group or other users/u, 'the gauntlet names the mode');
    assert.match(error.message, /google-client-prod\.json/u, 'and the file');
    return true;
  });

  // Selection keeps the name — the owner put a file there — and does not
  // describe it with the bundled credential's label, which is what made the
  // substitution invisible.
  const rows = listGoogleClients(at);
  assert.deepEqual(rows.map((c) => c.name), ['prod']);
  assert.equal(rows[0].label, 'prod', 'not "Intaglio (prod)": that is the other credential');
  assert.match(rows[0].unusable, /group or other users/u, 'and the row says why');
  assert.equal(defaultGoogleClient(at).name, 'prod');
});

test('a world-readable secrets file with no bundle to fall back on still says why', (t) => {
  const at = box(t, {});
  writeLooseSecret(at.home, 'prod', { client_id: 'LOOSE-ID', client_secret: 'LOOSE-SECRET' });

  // Offered, and marked: a machine that holds a credential with the wrong mode
  // is not a machine that holds none, and "no client is installed" would be
  // the wrong sentence to put in front of the owner.
  const rows = listGoogleClients(at);
  assert.deepEqual(rows.map((c) => c.name), ['prod']);
  assert.match(rows[0].unusable, /group or other users/u);
  assert.equal(defaultGoogleClient(at).name, 'prod');
  // And not silent: the read throws the gauntlet's own message, naming the
  // mode, so the owner can fix the file rather than guess.
  assert.throws(() => readGoogleClient('prod', at), /group or other users/u);
});

test('a 0755 secrets DIRECTORY does not silently swap every client for the bundle', (t) => {
  // Round-5 finding 3: the gauntlet holds a secret's PARENT to 0700, so one
  // `chmod 755 ~/.hazlie/secrets` — the clean-machine state Connectors.swift
  // repairs — fails every secrets file at once. Under the round-4 rule that
  // silently replaced the whole installed client list with the bundle's.
  const at = box(t, {
    secrets: { prod: { client_id: 'MINE-ID', client_secret: 'MINE-SECRET', label: 'mine' } },
    bundled: { prod: PROD },
  });
  const dir = join(at.home, '.hazlie', 'secrets');
  chmodSync(dir, 0o755); // still owner-writable, so box()'s own cleanup copes

  assert.throws(() => readGoogleClient('prod', at), (error) => {
    assert.match(error.message, /must have mode 0700/u, 'the directory and its mode are named');
    assert.match(error.message, /secrets/u);
    return true;
  });
  const rows = listGoogleClients(at);
  assert.deepEqual(rows.map((c) => c.name), ['prod'], 'the name is still the owner’s');
  assert.notEqual(rows[0].label, 'Intaglio (prod)',
    'the bundled credential must not describe a row it is not going to serve');
  assert.match(rows[0].unusable, /must have mode 0700/u);
});

test('a malformed secrets file is not offered, and does not fall back to the bundle either', (t) => {
  // The two halves of the rule pull in different directions here on purpose.
  // There is no credential in a half-written file, so selection skips it as it
  // always has — but the name is still spoken for, and answering the read with
  // the bundle's unrelated `prod` is the same substitution a wrong mode used
  // to cause.
  const at = box(t, { bundled: { prod: PROD } });
  writeFileSync(
    join(at.home, '.hazlie', 'secrets', 'google-client-prod.json'),
    JSON.stringify({ client_id: 'ONLY-HALF' }),
    { mode: 0o600 }
  );
  assert.deepEqual(listGoogleClients(at).map((c) => c.name), ['prod']);
  assert.equal(listGoogleClients(at)[0].unusable, undefined,
    'a malformed file is skipped in selection, so the bundled row it shadows stands');
  assert.throws(() => readGoogleClient('prod', at), /missing client_id or client_secret/u);
});

test('a dangling symlink in the secrets dir is not treated as an absent file', (t) => {
  // existsSync() follows the link and answers false, which would hand the name
  // straight back to the bundle — the substitution above, reached through a
  // link sitting in plain sight in the directory listing.
  const at = box(t, { bundled: { prod: PROD } });
  symlinkSync(
    join(at.home, '.hazlie', 'secrets', 'nowhere.json'),
    join(at.home, '.hazlie', 'secrets', 'google-client-prod.json')
  );
  assert.throws(() => readGoogleClient('prod', at), /unusable/u);
  assert.match(listGoogleClients(at)[0].unusable, /regular, non-symlink file|missing/u);
});

test('an owner-only secrets file still wins, so the shadowing rule is unchanged', (t) => {
  // The counterweight to the two tests above: the rule is about the GAUNTLET,
  // not about secrets losing their precedence.
  const at = box(t, {
    secrets: { prod: { client_id: 'MINE-ID', client_secret: 'MINE-SECRET', label: 'mine' } },
    bundled: { prod: PROD },
  });
  assert.equal(readGoogleClient('prod', at).id, 'MINE-ID');
  assert.equal(listGoogleClients(at)[0].label, 'mine');
});

// A HALF-PRESENT LEGACY PAIR IS NO PAIR (round-4 finding 10).
//
// listGoogleClients and defaultGoogleClient have always required BOTH legacy
// files; readGoogleClient tested only the id file. So with `gcal-client-id.txt`
// present and the secret deleted -- a restore that dropped one, a half-finished
// tidy -- defaultGoogleClient answered `default` (the bundle's sole row),
// readGoogleClient saw the id file, skipped the bundle, and threw from
// readSecretLine on the missing half. The sign-in button 502'd on a machine
// holding a perfectly usable credential.
test('a half-present legacy pair falls through to the bundled default', (t) => {
  const at = box(t, { legacy: true, bundled: { default: { ...PROD, label: 'shipped default' } } });
  rmSync(join(at.home, '.hazlie', 'secrets', 'gcal-client-secret.txt'));

  assert.equal(defaultGoogleClient(at).name, DEFAULT_CLIENT, 'selection already said this');
  const c = readGoogleClient(DEFAULT_CLIENT, at);
  assert.equal(c.id, 'PROD-ID', 'and the read must agree with it');
  assert.equal(c.label, 'shipped default');
});

test('a complete legacy pair is still never substituted for', (t) => {
  // The guarantee the fix above must not cost: a grant carrying no `client`
  // was issued by these two files, and Google will not renew it against a
  // different credential.
  const at = box(t, { legacy: true, bundled: { default: PROD } });
  const c = readGoogleClient(DEFAULT_CLIENT, at);
  assert.equal(c.id, 'LEGACY-ID');
  assert.equal(c.secret, 'LEGACY-SECRET');
});

test('a half-present legacy pair with nothing to fall back on names the missing file', (t) => {
  const at = box(t, { legacy: true });
  rmSync(join(at.home, '.hazlie', 'secrets', 'gcal-client-secret.txt'));
  assert.throws(() => readGoogleClient(DEFAULT_CLIENT, at), /google client secret file is missing/u);
});
