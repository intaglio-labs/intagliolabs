#!/usr/bin/env node
// Fetch the native bridge binaries that replace seven of the eight containers.
//
//   node ops/fetch-bridges.mjs              # fetch what is missing, verify all
//   node ops/fetch-bridges.mjs --check      # verify only; download nothing
//   node ops/fetch-bridges.mjs --force      # re-download even if present
//   node ops/fetch-bridges.mjs --only meta  # one bridge
//
// WHAT THIS IS PART OF. Docker Desktop on macOS is a Linux virtual machine, and
// it is in this product for one reason: the social bridges were believed to need
// it. They do not. Every mautrix bridge here is Go and publishes a prebuilt
// darwin-arm64 binary. This fetches them; ops/setup-bridges.sh still owns the
// configuration, and Synapse is a separate leg (it has a macOS arm64 wheel, so
// it is a venv rather than a container -- but that is not this file).
//
// FETCHED, NOT BUNDLED, and that is deliberate. It is the same posture
// `docker pull` already has: upstream artifacts land on the owner's machine from
// upstream, and this repo conveys none of them. The bridges are AGPL-3.0; a DMG
// that carried them would owe every recipient the Corresponding Source, and
// upstream's own LICENSE.exceptions -- which names Beeper and Element -- is good
// evidence they read embedding as needing permission. Bundling may still be the
// right call one day for an offline first run. It is a licence conversation
// first, and nothing here forecloses it.
//
// EVERY BYTE IS CHECKED. The manifest pins a sha256 per asset, taken from
// upstream's own sha256sums.txt. A download that does not match is deleted, not
// quarantined and not warned about: a bridge binary holds live session cookies
// for someone's Facebook account, and "probably fine" is not a posture that
// survives contact with that.
//
// LOG POLICY (connectors/AGENTS.md): paths, names and counts. No cookie, no
// token, no account. Nothing here ever sees one.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, '..', 'bridges', 'native.json');

export function loadManifest(path = MANIFEST) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.bridges) || raw.bridges.length === 0) {
    throw new Error('native.json declares no bridges');
  }
  for (const b of raw.bridges) {
    // A manifest entry whose hash is missing or malformed is worse than no
    // manifest: it reads as "pinned" everywhere else in this file.
    if (!/^[0-9a-f]{64}$/u.test(String(b.sha256 ?? ''))) {
      throw new Error(`bridge "${b.id}" has no valid sha256`);
    }
    if (!b.id || !b.repo || !b.release || !b.asset) {
      throw new Error(`bridge "${b.id ?? '?'}" is missing a required field`);
    }
  }
  return raw;
}

export function assetUrl(manifest, bridge) {
  return `${manifest.base}/${bridge.repo}/releases/download/${bridge.release}/${bridge.asset}`;
}

export function binDir(home = homedir()) {
  return join(home, '.hazlie', 'bridges', 'bin');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Which dylibs a Mach-O needs, and which of those cannot be resolved.
//
// Every one of these binaries links @rpath/libolm.3.dylib and upstream does NOT
// publish that dylib as a release asset -- its macOS CI builds it and keeps it
// as a CI artifact. An unresolved @rpath dependency is not a warning at run
// time, it is a dyld abort before main(), so this is checked here where it can
// be reported as a sentence rather than discovered as a crash loop.
//
// The rpath lists @executable_path first, so the fix is to put the dylib beside
// the binary. Providing it is a separate leg; this reports the gap truthfully
// instead of pretending the fetch is complete.
export function missingLibraries(path) {
  let out;
  try {
    out = execFileSync('otool', ['-L', path], { encoding: 'utf8' });
  } catch {
    return { checked: false, missing: [] };
  }
  const rpaths = [];
  try {
    const load = execFileSync('otool', ['-l', path], { encoding: 'utf8' });
    const lines = load.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes('LC_RPATH')) continue;
      const hit = lines.slice(i, i + 4).find((l) => /^\s*path\s/u.test(l));
      if (hit) rpaths.push(hit.trim().split(/\s+/u)[1]);
    }
  } catch { /* rpaths stay empty; every @rpath dep then reads as unresolved */ }

  const missing = [];
  for (const line of out.split('\n').slice(1)) {
    const dep = line.trim().split(/\s+/u)[0];
    if (!dep || !dep.startsWith('@rpath/')) continue; // system paths are the OS's problem
    const leaf = dep.slice('@rpath/'.length);
    const found = rpaths.some((r) => {
      const base = r === '@executable_path' ? dirname(path) : r;
      if (base.startsWith('@')) return false; // @loader_path etc: not resolvable from here
      return existsSync(join(base, leaf));
    });
    if (!found) missing.push(leaf);
  }
  return { checked: true, missing };
}

// Is this thing actually runnable? An unsigned Mach-O does not execute on Apple
// Silicon at all -- it is killed by the kernel, not by Gatekeeper, and the error
// gives no hint. Upstream's binaries are ad-hoc (linker-signed), which is
// enough; this verifies rather than trusts.
export function signatureState(path) {
  // codesign -dv REPORTS ON STDERR, including on success. Reading stdout gets an
  // empty string, and an empty string matches no pattern -- which is how the
  // first version of this reported upstream's ad-hoc binaries as "signed", the
  // one answer that would have made a real problem invisible. spawnSync, both
  // streams, no exceptions to get wrong.
  const r = spawnSync('codesign', ['-dv', path], { encoding: 'utf8' });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (/code object is not signed/iu.test(text)) return 'unsigned';
  // The flags line is the discriminator at -dv: upstream's bridges report
  // flags=0x20002(adhoc,linker-signed), while a properly signed binary reports
  // flags=0x0(none) and carries a real CMS blob ("Signature size="). Authority=
  // would be cleaner but only appears at -dvvv, which is how the first version
  // of this test failed on /bin/ls.
  if (/\badhoc\b/iu.test(text)) return 'adhoc';
  if (/Signature size=/u.test(text) || /Authority=/u.test(text)) return 'signed';
  return 'unknown';
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf, { mode: 0o700 });
  return buf.length;
}

export async function fetchBridges({
  home = homedir(),
  manifestPath = MANIFEST,
  only = null,
  force = false,
  checkOnly = false,
  log = () => {},
} = {}) {
  const manifest = loadManifest(manifestPath);
  const dir = binDir(home);
  if (!checkOnly) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const results = [];
  for (const bridge of manifest.bridges) {
    if (only && bridge.id !== only) continue;
    const dest = join(dir, bridge.asset);
    const present = existsSync(dest);
    let state = 'present';
    let bytes = present ? statSync(dest).size : 0;

    if (present && !force) {
      if (sha256File(dest) !== bridge.sha256) {
        // A file that does not match its pin is not a cache, it is an unknown.
        rmSync(dest, { force: true });
        state = 'corrupt';
      }
    } else if (present && force) {
      rmSync(dest, { force: true });
      state = 'refetch';
    } else {
      state = 'absent';
    }

    if (!existsSync(dest)) {
      if (checkOnly) {
        results.push({ id: bridge.id, state: state === 'corrupt' ? 'corrupt' : 'absent', ok: false });
        log(`${bridge.id}: ${state === 'corrupt' ? 'checksum mismatch, removed' : 'not fetched'}`);
        continue;
      }
      const tmp = `${dest}.part`;
      try {
        bytes = await download(assetUrl(manifest, bridge), tmp);
        const got = sha256File(tmp);
        if (got !== bridge.sha256) {
          rmSync(tmp, { force: true });
          throw new Error(`sha256 mismatch: expected ${bridge.sha256}, got ${got}`);
        }
        renameSync(tmp, dest);
        chmodSync(dest, 0o700);
        state = 'fetched';
      } catch (error) {
        rmSync(tmp, { force: true });
        results.push({ id: bridge.id, state: 'failed', ok: false, error: String(error?.message ?? error) });
        log(`${bridge.id}: FAILED — ${String(error?.message ?? error)}`);
        continue;
      }
    }

    const signature = signatureState(dest);
    const { checked, missing } = missingLibraries(dest);
    const ok = signature !== 'unsigned' && missing.length === 0;
    results.push({
      id: bridge.id, state, ok, bytes, signature,
      missingLibraries: missing, librariesChecked: checked,
    });
    log(
      `${bridge.id}: ${state}, ${(bytes / 1e6).toFixed(1)}MB, signature=${signature}` +
        (missing.length ? `, MISSING ${missing.join(', ')}` : '')
    );
  }
  return { platform: manifest.platform, results };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const out = await fetchBridges({
    only: valueOf('--only'),
    force: args.includes('--force'),
    checkOnly: args.includes('--check'),
    log: (line) => process.stdout.write(`  ${line}\n`),
  });
  const bad = out.results.filter((r) => !r.ok);
  const needLib = out.results.filter((r) => r.missingLibraries?.length);
  if (needLib.length) {
    process.stdout.write(
      `\n${needLib.length} binaries cannot start yet: ${[...new Set(needLib.flatMap((r) => r.missingLibraries))].join(', ')}` +
        ' is not beside them. The rpath looks at @executable_path first, so that dylib' +
        ' goes in the same directory. Upstream does not publish it as a release asset.\n'
    );
  }
  process.exit(bad.length === 0 ? 0 : 1);
}
