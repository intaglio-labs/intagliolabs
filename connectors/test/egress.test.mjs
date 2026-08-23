// The egress tripwire: every host literal in tracked source must appear in
// ops/EGRESS.json.
//
// WHY THIS EXISTS. The approved-host list used to live in prose, restated
// longhand in nine files. Between 2026-08-19 and 2026-08-22 the real host set
// grew by api.notion.com, six chat platforms, two container registries and a
// model host, and not one of those nine updated -- so the widget shipped a
// string asserting the OPPOSITE of the governing document. ui/AGENTS.md's own
// rule says the exemption text lands BEFORE the commit that opens a
// non-loopback socket, not after. Nothing enforced it, so it was broken at
// least four times. This test is the enforcement: a new host fails the suite
// on the commit that introduces it, which is exactly when the rule says to
// catch it.
//
// WHY IT LIVES IN connectors/test/. The rule is repo-wide but the repo has no
// root test runner, and connectors/ is where the network-posture rules are
// written (connectors/AGENTS.md). If a root runner ever appears, move it.
//
// DELIBERATELY BLUNT. It matches any `https://host` or `http://host` and any
// docker `image:` registry, INCLUDING inside comments. A host named in a
// comment is still a host someone can turn into a call with one line, and
// ops/EGRESS.json has a `user-browser-link` kind for the mention-only case.
// Fail-closed beats clever: the cost of a false positive is one honest line
// in the ledger.
//
// WHEN THIS FAILS: add the host to ops/EGRESS.json in the SAME commit as the
// code, with a real `decision`. If no owner decision exists, write UNRECORDED
// -- never-fabricate binds the ledger too. Do not add it here.
//
// WHAT IT DOES NOT COVER, so nobody reads a green suite as more than it is:
// markdown is not scanned (READ_EXT), because a host named in prose is not a
// socket -- the docs are governed by pointing at the ledger, not by this test.
// exp_*/ and rig/ are out of scope (ROOTS). A host assembled at runtime from
// parts ('https://' + host) is invisible to a literal scan. And declaring a
// host here is not approving it: read `decision` on the entry.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Where product code lives. exp_*/ and rig/ are the other two tracks, on other
// hardware with their own posture, and results/ is data.
const ROOTS = ['connectors', 'connect', 'courier', 'ui', 'widget', 'bridges', 'ops', 'site'];

// Build output, vendored dependencies, and fixture dirs. `test` is excluded
// because suites legitimately name evil.example.com and 192.168.1.20 to prove
// they are REFUSED -- a fixture proving a host is rejected must not be read as
// a declaration that it is allowed.
const SKIP_DIR = new Set([
  'node_modules', 'dist', 'public', 'build', 'test', '.expo', 'models', 'vendor', '_expo', 'dl',
]);
const READ_EXT = /\.(mjs|js|jsx|ts|tsx|swift|html|css|sh|yml|yaml|json|plist|entitlements)$/u;

// Lockfiles list every dependency's registry, homepage and funding URL. That
// is npm's metadata about third parties, not a socket this code opens, and
// including it would bury a real new host under fifty package-funding links.
const SKIP_FILE = new Set(['package-lock.json']);

// `<!DOCTYPE plist PUBLIC ... "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`
// is an XML namespace identifier, not a fetch. Every plist and entitlements
// file in the repo carries one.
const stripDoctype = (text) => text.replace(/<!DOCTYPE[^>]*>/gu, '');

// Loopback is not egress. `synapse` is the compose-internal DNS name the
// bridge connector uses inside the docker network.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0', 'synapse']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) walk(full, out);
    else if (READ_EXT.test(name) && !SKIP_FILE.has(name)) out.push(full);
  }
  return out;
}

function declaredHosts() {
  const ledger = JSON.parse(readFileSync(join(REPO, 'ops', 'EGRESS.json'), 'utf8'));
  const hosts = new Set();
  for (const entry of ledger.paths) hosts.add(entry.host);
  return { ledger, hosts };
}

function foundHosts() {
  const found = new Map(); // host -> first file that names it
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root))) {
      let text;
      try {
        text = stripDoctype(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const rel = file.slice(REPO.length + 1);
      for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\])/gu)) {
        const host = m[1];
        if (LOOPBACK.has(host) || !found.has(host)) found.set(host, rel);
      }
      // Container images: `image: ghcr.io/element-hq/synapse:v1.140.0` names a
      // registry with no scheme, so the URL matcher above never sees it.
      for (const m of text.matchAll(/^\s*image:\s*([A-Za-z0-9.-]+\.[A-Za-z]{2,})\//gmu)) {
        if (!found.has(m[1])) found.set(m[1], rel);
      }
    }
  }
  for (const host of LOOPBACK) found.delete(host);
  return found;
}

test('every host in product source is declared in ops/EGRESS.json', () => {
  const { hosts } = declaredHosts();
  const found = foundHosts();

  const undeclared = [...found.entries()]
    .filter(([host]) => !hosts.has(host))
    .map(([host, file]) => `  ${host}  (first seen in ${file})`);

  assert.deepEqual(
    undeclared,
    [],
    `Undeclared egress host(s). Add each to ops/EGRESS.json in this same commit,\n` +
      `with a real \`decision\` (or UNRECORDED if no owner decision exists):\n\n` +
      `${undeclared.join('\n')}\n`
  );
});

test('the ledger has no stale entries', () => {
  // The other direction: a declared host nobody reaches any more is a claim
  // that has outlived its code, and this file exists because claims outliving
  // their code is the failure mode. A WARN, not a FAIL -- deleting a connector
  // should not turn the suite red -- so it asserts nothing and reports.
  const { hosts } = declaredHosts();
  const found = foundHosts();
  // Substring search, not the URL matcher: some hosts are configured as bare
  // strings rather than URLs (mail.mjs' DEFAULT_HOST = 'imap.gmail.com'), and
  // flagging those as orphaned would be exactly the kind of confidently-wrong
  // report this file exists to prevent.
  const corpus = ROOTS.flatMap((root) => walk(join(REPO, root)))
    .map((f) => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  const orphans = [...hosts].filter(
    (h) => !found.has(h) && !/\s/u.test(h) && !corpus.includes(h)
  );
  if (orphans.length > 0) {
    console.warn(`ops/EGRESS.json declares hosts no source names: ${orphans.join(', ')}`);
  }
  assert.ok(true);
});

test('every declared path carries a decision and a kind', () => {
  const { ledger } = declaredHosts();
  const kinds = new Set(Object.keys(ledger._kinds));
  for (const entry of ledger.paths) {
    assert.ok(entry.decision, `${entry.host} has no \`decision\``);
    assert.ok(kinds.has(entry.kind), `${entry.host} has unknown kind "${entry.kind}"`);
    assert.ok(entry.component, `${entry.host} has no \`component\``);
  }
});
