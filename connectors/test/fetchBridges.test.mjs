// The native bridge manifest, and the fetcher that trusts nothing in it.
//
// This is leg one of removing Docker. Seven of the eight containers are mautrix
// bridges, every one is Go, and every one publishes a prebuilt darwin-arm64
// binary -- so they do not need a Linux VM to run on a Mac. What they DO need is
// for nobody to relax the checks while moving them out of a registry that was
// doing some of the checking for us.
//
// Every fixture synthetic; the repo is public. No test here reaches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadManifest, assetUrl, binDir, sha256File, signatureState, missingLibraries, fetchBridges,
  isMainModule,
} from '../../ops/fetch-bridges.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = join(REPO, 'bridges', 'native.json');

test('the bundled CLI runs from an application path containing spaces', () => {
  const path = '/Applications/Intaglio Labs.app/Contents/Resources/backend/ops/fetch-bridges.mjs';
  assert.equal(isMainModule(new URL(`file://${path.replaceAll(' ', '%20')}`).href, path), true);
});

// ---- the manifest itself ----

test('every bridge is pinned by a real sha256', () => {
  const m = loadManifest(MANIFEST);
  assert.ok(m.bridges.length >= 7, `expected the full roster, got ${m.bridges.length}`);
  for (const b of m.bridges) {
    assert.match(b.sha256, /^[0-9a-f]{64}$/u, `${b.id} is not pinned`);
    assert.match(b.asset, /darwin-arm64$/u, `${b.id} names a non-macOS asset`);
  }
});

test('the roster covers every platform the container stack ran', () => {
  const ids = new Set(loadManifest(MANIFEST).bridges.map((b) => b.id));
  // Instagram and Messenger are two binaries out of one repo, which is the same
  // split docker-compose.yml made with two services off one image.
  for (const id of ['meta', 'instagram', 'twitter', 'telegram', 'discord', 'linkedin', 'slack']) {
    assert.ok(ids.has(id), `no native replacement declared for ${id}`);
  }
});

test('a manifest with an unpinned entry is refused, not tolerated', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bad = join(dir, 'native.json');
  writeFileSync(bad, JSON.stringify({
    base: 'https://example.invalid', bridges: [{ id: 'x', repo: 'x', release: 'v1', asset: 'a' }],
  }));
  assert.throws(() => loadManifest(bad), /no valid sha256/u);
  // ...and a plausible-looking but wrong-length hash is still refused.
  writeFileSync(bad, JSON.stringify({
    base: 'https://example.invalid',
    bridges: [{ id: 'x', repo: 'x', release: 'v1', asset: 'a', sha256: 'abc123' }],
  }));
  assert.throws(() => loadManifest(bad), /no valid sha256/u);
});

test('the download URL is built from the pin, not from a tag that can move', () => {
  const m = loadManifest(MANIFEST);
  const meta = m.bridges.find((b) => b.id === 'meta');
  assert.equal(
    assetUrl(m, meta),
    `https://github.com/mautrix/meta/releases/download/${meta.release}/mautrix-meta-darwin-arm64`
  );
});

// ---- what the fetcher refuses ----

test('a file that does not match its pin is deleted, never used', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fb-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const m = loadManifest(MANIFEST);
  const bridge = m.bridges[0];
  const dir = binDir(home);
  mkdirSync(dir, { recursive: true });
  const planted = join(dir, bridge.asset);
  writeFileSync(planted, 'not the bridge you are looking for');

  // checkOnly, so nothing is downloaded and the test stays offline.
  const out = await fetchBridges({ home, manifestPath: MANIFEST, only: bridge.id, checkOnly: true });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].state, 'corrupt');
  assert.equal(out.results[0].ok, false);
  assert.equal(existsSync(planted), false, 'a mismatched binary must not survive the check');
});

test('a missing binary reports absent rather than passing quietly', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fb-empty-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const out = await fetchBridges({ home, manifestPath: MANIFEST, checkOnly: true });
  assert.equal(out.results.length, 7);
  assert.ok(out.results.every((r) => r.state === 'absent' && r.ok === false));
});

test('sha256File is the real digest', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-sha-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'x');
  writeFileSync(f, 'abc');
  // Known SHA-256 of "abc".
  assert.equal(sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// ---- the Mach-O checks ----
//
// REGRESSION TEST, and the reason this file spends effort on a system binary:
// `codesign -dv` writes its report to STDERR, including on success. The first
// version of signatureState read stdout, got an empty string, matched nothing,
// and returned "signed" for every input — which is the one answer that would
// have made a genuinely unsigned binary invisible. Upstream's bridges are ad-hoc
// signed and DO run; a silent "signed" would have hidden the opposite case.

test('signatureState reads the report codesign actually writes', () => {
  // /bin/ls carries a real Apple signature, so anything other than "signed"
  // means the reader is looking at the wrong stream again.
  assert.equal(signatureState('/bin/ls'), 'signed');
});

test('signatureState says unknown rather than guessing at a non-binary', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-sig-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'plain.txt');
  writeFileSync(f, 'hello');
  assert.ok(['unsigned', 'unknown'].includes(signatureState(f)));
});

test('missingLibraries reports nothing missing for a system binary', () => {
  const { checked, missing } = missingLibraries('/bin/ls');
  assert.equal(checked, true, 'otool must have run');
  assert.deepEqual(missing, [], '/bin/ls resolves everything through system paths');
});

// ---- the Synapse leg ----
//
// The homeserver is the eighth container and the one the previous answer
// wrongly called impossible to remove. It installs from a macOS arm64 wheel; the
// thing that actually breaks it is dependency RESOLUTION, which the container
// image was silently doing for us.

test('the Synapse dependency set is fully pinned, like the image it replaces', () => {
  const reqs = readFileSync(join(REPO, 'bridges', 'synapse-requirements.txt'), 'utf8');
  const lines = reqs.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.length >= 40, `expected a full freeze, got ${lines.length} lines`);
  for (const line of lines) {
    assert.match(line, /==/u, `unpinned requirement: ${line}`);
  }
});

// THE ONE THAT MATTERS. matrix-synapse asks for `prometheus-client >=0.6.0`, so
// an unconstrained install takes the newest, and Synapse then cannot subclass
// its Collector: the homeserver dies at import with an MRO TypeError before it
// reads a config. Reproduced on CPython 3.12 and 3.14 alike.
test('prometheus_client stays at a version Synapse can subclass', () => {
  const reqs = readFileSync(join(REPO, 'bridges', 'synapse-requirements.txt'), 'utf8');
  const line = reqs.split('\n').find((l) => /^prometheus[-_]client==/iu.test(l.trim()));
  assert.ok(line, 'prometheus_client must be pinned explicitly');
  const [, version] = line.trim().split('==');
  const [major, minor] = version.split('.').map(Number);
  assert.equal(major, 0);
  assert.ok(minor <= 21, `prometheus_client ${version} breaks Synapse's Collector subclass`);
});

test('Synapse is pinned to a version that still publishes a macOS wheel', () => {
  const reqs = readFileSync(join(REPO, 'bridges', 'synapse-requirements.txt'), 'utf8');
  const line = reqs.split('\n').find((l) => /^matrix-synapse==/iu.test(l.trim()));
  assert.ok(line, 'matrix-synapse must be pinned');
  const [, version] = line.trim().split('==');
  const [major, minor] = version.split('.').map(Number);
  // Upstream deprecated macOS wheels at 1.144.0; 1.143.0 is the last with them.
  // Past that, ops/build-synapse.sh's --only-binary must become a CI sdist
  // build, and this test is the reminder rather than a discovery at runtime.
  assert.equal(major, 1);
  assert.ok(
    minor <= 143,
    `Synapse ${version} publishes no macOS wheel; build-synapse.sh needs an sdist path first`
  );
});
