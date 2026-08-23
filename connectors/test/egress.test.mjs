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
//
// AND THE ONE THAT BIT: a scan that read NOTHING used to pass. walk() swallows a
// missing directory and returns [], no assertion counted the files, and two of
// the eight ROOTS ('courier', 'site') had left the repo when it was extracted for
// open source -- so a quarter of the declared coverage contributed zero and
// nothing said so. Pointing ROOTS at one nonexistent directory produced three
// passing tests and a green suite. A tripwire that has never fired and a tripwire
// that is unplugged look identical from outside; only a floor tells them apart,
// which is what 'the scan actually reached the source' below is for. Verified
// 2026-08-23 by emptying the roots and watching it go red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Where product code lives. exp_*/ and rig/ are the other two tracks, on other
// hardware with their own posture, and results/ is data.
//
// Every entry here MUST exist -- see the floor test. A root that quietly stops
// existing is coverage lost in silence, which is the failure this file had.
const ROOTS = ['connectors', 'connect', 'ui', 'widget', 'bridges', 'ops'];

// Roots that belong to the system but are NOT in this repository, recorded so
// their absence is a decision rather than a typo. If one ever lands here it must
// move up into ROOTS in the same commit -- the floor test fails when it appears,
// precisely so it cannot arrive unscanned.
const ROOTS_ELSEWHERE = Object.freeze({
  courier: 'the iMessage send lane; not extracted for open source',
  site: 'the marketing site, a separate artifact with its own egress hosts',
});

// Floors, set below today's measured numbers so ordinary deletion does not turn
// the suite red, but far enough above zero that a collapsed walk cannot pass. A
// smoke alarm, not a budget: if a legitimate change drops the repo under one,
// lower it deliberately and say why in the same commit.
//
// PER ROOT, NOT JUST IN TOTAL, and the distinction is the whole point. An
// aggregate floor of 100 against 148 files lets an entire root go dark without
// failing, because the others carry the total: `bridges` contributes exactly ONE
// scanned file, so a traversal or read failure there leaves ~147 files and every
// host still found, and the suite stays green having lost all bridge coverage.
// That is precisely the unplugged-tripwire condition this test exists to catch,
// one level down -- caught in review of the commit that added the aggregate floor,
// which is a fair illustration that a floor is only as good as the thing it is a
// floor ON.
//
// Measured 2026-08-23: connectors 45, connect 12, ui 26, widget 48, bridges 1,
// ops 16 = 148 files, 24 hosts. Each floor below sits under its measurement with
// room for ordinary deletion; bridges is 1 because it IS 1, and a root whose real
// content is a single compose file has no headroom to give.
const MIN_FILES_PER_ROOT = Object.freeze({
  connectors: 30,
  connect: 8,
  ui: 15,
  widget: 30,
  bridges: 1,
  ops: 10,
});
const MIN_FILES_SCANNED = 100;
const MIN_HOSTS_FOUND = 10;

// Build output and vendored dependencies. Skipped wherever they appear, because
// these nest legitimately (a node_modules inside a node_modules, a dist inside a
// package).
const SKIP_DIR = new Set([
  'node_modules', 'dist', 'public', 'build', '.expo', 'models', 'vendor', '_expo', 'dl',
]);

// Suite directories, skipped ONLY as a root's own child: connectors/test,
// ui/test, connect/test, widget/test. They are excluded because suites
// legitimately name evil.example.com and 192.168.1.20 to prove they are REFUSED
// -- a fixture proving a host is rejected must not be read as a declaration that
// it is allowed.
//
// 'test' used to sit in SKIP_DIR, which matches a basename at ANY depth, so
// product code under a path like connectors/lib/test/ was skipped as readily as
// a suite. Scoping it to depth 1 keeps the exemption the fixtures need and
// nothing deeper.
const SKIP_AT_ROOT = new Set(['test']);
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

// `depth` is 0 when `dir` IS a root, so its immediate children are the ones
// SKIP_AT_ROOT applies to.
function walk(dir, out = [], depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name) || name.startsWith('.')) continue;
    if (depth === 0 && SKIP_AT_ROOT.has(name)) continue;
    const full = join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) walk(full, out, depth + 1);
    else if (READ_EXT.test(name) && !SKIP_FILE.has(name)) out.push(full);
  }
  return out;
}

// Every file the scan will read, across every root. Named separately from
// foundHosts() so the floor test can assert the walk reached the source at all
// rather than inferring it from however many hosts happened to be declared.
function scannedFiles() {
  return ROOTS.flatMap((root) => walk(join(REPO, root)));
}

function declaredHosts() {
  const ledger = JSON.parse(readFileSync(join(REPO, 'ops', 'EGRESS.json'), 'utf8'));
  const hosts = new Set();
  for (const entry of ledger.paths) hosts.add(entry.host);
  return { ledger, hosts };
}

function foundHosts() {
  const found = new Map(); // host -> first file that names it
  {
    for (const file of scannedFiles()) {
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

// THE FLOOR. This runs first because every assertion below it is worthless if
// the scan read nothing, and for most of this file's life nothing was checking.
//
// It asserts three things that used to be assumed: that each declared root is
// really there, that each root recorded as living elsewhere is really absent,
// and that the walk came back with a plausible amount of source. Without this a
// renamed directory, a bad extraction, or a typo in ROOTS silently reduces
// coverage while the suite stays green -- which is exactly how 'courier' and
// 'site' sat in ROOTS contributing zero files.
test('the scan actually reached the source', () => {
  const missing = ROOTS.filter((root) => !existsSync(join(REPO, root)));
  assert.deepEqual(
    missing,
    [],
    `ROOTS names ${missing.join(', ')}, which does not exist. Either the directory ` +
      `moved (fix ROOTS) or it left the repo (move it to ROOTS_ELSEWHERE with a ` +
      `reason). A root that is not there is coverage that is not happening.`
  );

  const arrived = Object.keys(ROOTS_ELSEWHERE).filter((root) => existsSync(join(REPO, root)));
  assert.deepEqual(
    arrived,
    [],
    `ROOTS_ELSEWHERE says ${arrived.join(', ')} is not in this repo, but it is. ` +
      `Move it into ROOTS in this same commit -- otherwise it is product source ` +
      `that no egress scan ever reads.`
  );

  // Per root FIRST, because the aggregate cannot see a single root going dark.
  const starved = [];
  for (const root of ROOTS) {
    const floor = MIN_FILES_PER_ROOT[root];
    assert.ok(
      floor !== undefined,
      `${root} is in ROOTS with no entry in MIN_FILES_PER_ROOT. Add one -- an ` +
        `unfloored root is a root that can silently contribute nothing.`
    );
    const count = walk(join(REPO, root)).length;
    if (count < floor) starved.push(`${root}: ${count} files, floor ${floor}`);
  }
  assert.deepEqual(
    starved,
    [],
    `a scan root came back under its floor:\n  ${starved.join('\n  ')}\n` +
      `Either that directory shrank legitimately (lower its floor and say why) or ` +
      `the walk stopped reaching it, which the aggregate floor below cannot see.`
  );

  const files = scannedFiles();
  assert.ok(
    files.length >= MIN_FILES_SCANNED,
    `the walk read ${files.length} files, below the floor of ${MIN_FILES_SCANNED}. ` +
      `Either the tree shrank a lot (lower the floor deliberately and say why) or ` +
      `the walk is broken and this whole file is asserting nothing.`
  );

  const found = foundHosts();
  assert.ok(
    found.size >= MIN_HOSTS_FOUND,
    `the scan found ${found.size} hosts, below the floor of ${MIN_HOSTS_FOUND}. ` +
      `A scan that finds no hosts passes every other test in this file.`
  );
});

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
  const corpus = scannedFiles()
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
