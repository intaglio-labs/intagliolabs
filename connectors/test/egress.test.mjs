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
const ROOTS = ['connectors', 'connect', 'ui', 'widget', 'bridges', 'ops', 'site'];

// Roots that belong to the system but are NOT in this repository, recorded so
// their absence is a decision rather than a typo. If one ever lands here it must
// move up into ROOTS in the same commit -- the floor test fails when it appears,
// precisely so it cannot arrive unscanned.
const ROOTS_ELSEWHERE = Object.freeze({
  courier: 'the iMessage send lane; not extracted for open source',
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
  // Four pages and nothing generated. The site is hand-written HTML, so this
  // floor is the page count minus one -- a deleted page is a deliberate act,
  // a collapsed walk is not.
  site: 3,
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

// Loopback is not egress. `synapse` and the `hazlie-*` names used to be here
// as well: compose-internal DNS for the bridge network, resolvable only inside
// it. That network is gone with the container engine, and the native
// provisioner writes 127.0.0.1 everywhere, so they are no longer exempt --
// as plain hostnames they would resolve through DNS to whatever answered.
// assertLoopbackBase in connect/lib/bridge.mjs dropped `synapse` for the same
// reason and on the same day.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

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

// The ledger's own path, and the reason it needs naming: ROOTS includes 'ops',
// READ_EXT includes .json and SKIP_FILE holds only package-lock.json -- so
// ops/EGRESS.json is INSIDE the corpus the stale-entry check searches for
// evidence that a declared host is still reachable. Every host it declares was
// therefore trivially "named in source": by the declaration itself. The check
// could not report an orphan under any circumstances, and it ended in
// assert.ok(true), so nothing said so. The host-DECLARATION tests still read
// this file deliberately, through declaredHosts(); only the source corpus
// excludes it.
const LEDGER_PATH = join(REPO, 'ops', 'EGRESS.json');

// Kinds whose host NO source in this repo is supposed to name, so their
// absence from the corpus is the expected state rather than a stale claim.
// Turning the orphan check on for real surfaced exactly these three and
// nothing else, which is a fair check on the reasoning:
//   frontier-client / public-lookup -- the socket is opened by a spawned
//     provider binary. This repo holds no URL for it by design, which is also
//     why the whole feature is invisible to the host-literal tripwire and why
//     the producer-coverage test below exists.
//   login-webview -- the host lives in a Swift array of BARE host strings (a
//     fence, not a URL), which the https?:// matcher cannot see. The
//     2026-08-23 note in the ledger's own _readme records this.
const KINDS_NOT_IN_SOURCE = new Set(['frontier-client', 'public-lookup', 'login-webview']);

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
      // `image:` lines named a registry with no scheme, so the URL matcher
      // above never saw them. No compose file remains to carry one; the
      // equivalent today is bridges/native.json, whose download URLs the
      // matcher above reads directly because they are ordinary https.
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
  // should not turn the suite red -- so it asserts nothing about the orphans
  // themselves. What it DOES assert is that the check can still see one.
  const { hosts, ledger } = declaredHosts();
  const found = foundHosts();
  // Substring search, not the URL matcher: some hosts are configured as bare
  // strings rather than URLs (mail.mjs' DEFAULT_HOST = 'imap.gmail.com'), and
  // flagging those as orphaned would be exactly the kind of confidently-wrong
  // report this file exists to prevent.
  //
  // EXCLUDING THE LEDGER ITSELF, which is the whole correction: ops/ is a
  // scan root and .json is a read extension, so this corpus used to contain
  // the declarations it was checking against and every host matched itself.
  const corpusFiles = scannedFiles().filter((f) => f !== LEDGER_PATH);
  const corpus = corpusFiles
    .map((f) => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');

  // THREE ASSERTIONS THAT THE CHECK IS PLUGGED IN, because excluding the
  // ledger is otherwise a change nothing verifies -- and an inert check that
  // looks busy is the exact state this test spent its whole life in.
  //
  // (i) the ledger's own path is out of the corpus, said directly.
  assert.ok(
    !corpusFiles.includes(LEDGER_PATH),
    'ops/EGRESS.json is inside the corpus its own declarations are checked against'
  );
  // (ii) and it did not arrive under some other path (a copy, a rename, a
  // second ledger). _the_claim is a key only this file has.
  assert.ok(
    !corpus.includes('"_the_claim"'),
    'something in the scanned corpus contains the ledger\'s own text, so every ' +
      'declared host matches itself and the orphan check below is inert again'
  );
  // (iii) at least one declared host is genuinely unnamed by the corpus.
  // chatgpt.com is one today (its socket is opened by a spawned binary, so no
  // file here holds the URL). If this fails, the corpus is self-matching --
  // which is what (i) and (ii) exist to explain -- or the read collapsed.
  const canary = 'egress-canary.invalid';
  const canaryOrphans = [...new Set([...hosts, canary])].filter(
    (h) => !found.has(h) && !/\s/u.test(h) && !corpus.includes(h)
  );
  assert.ok(canaryOrphans.includes(canary), 'the orphan filter cannot see a host nothing names at all');
  assert.ok(
    canaryOrphans.length > 1,
    'EVERY declared host is named somewhere in the corpus. Either the ledger is ' +
      'being searched against itself, or the tree really did grow a literal for each ' +
      'spawned-binary host -- check which before lowering this.'
  );

  // A host whose ONLY rows are kinds this repo never writes a URL for is not
  // an orphan; it is a correctly-declared path whose socket something else
  // opens. Reporting those every run would train a reader to ignore the line,
  // which is how a real orphan gets missed.
  const kindsByHost = new Map();
  for (const entry of ledger.paths) {
    if (!kindsByHost.has(entry.host)) kindsByHost.set(entry.host, new Set());
    kindsByHost.get(entry.host).add(entry.kind);
  }
  const opensItsOwnSocket = (host) =>
    [...(kindsByHost.get(host) ?? [])].some((kind) => !KINDS_NOT_IN_SOURCE.has(kind));

  const orphans = canaryOrphans.filter((h) => h !== canary && opensItsOwnSocket(h));
  if (orphans.length > 0) {
    console.warn(`ops/EGRESS.json declares hosts no source names: ${orphans.join(', ')}`);
  }
});

// EVERY PRODUCER THAT SPAWNS THE INSTALLED CLI IS NAMED IN THE LEDGER.
//
// The host-literal tripwire above is structurally blind to this whole
// feature: api.anthropic.com appears as a URL literal in no product file,
// because the socket is opened by the spawned binary rather than by code in
// this repo. So the only thing carrying it is the ledger's prose -- and prose
// drifted exactly as it always does. `grep -c sweep ops/EGRESS.json` was 0
// while `node ui/scripts/sweep-once.mjs --power full --engine claude-cli`
// shipped private message text through a row whose decision named only the
// person-page builder.
//
// This is a coverage test, not a host test: for each module that reaches
// engines.mjs' spawn, the ledger must name that module's path in a
// `component` or `evidence` field. It is deliberately keyed on the MODULE
// rather than on a call site, so moving a producer's code inside its own file
// does not turn the suite red, while adding a new producer does.
const CLI_PRODUCERS = Object.freeze([
  'ui/server/relationship/pages.mjs',
  'ui/server/relationship/sweep.mjs',
  'ui/server/relationship/draft.mjs',
  'ui/server/relationship/lookup.mjs',
]);

// THE SECOND OUTBOUND PATH THAT CARRIES MESSAGE-DERIVED TEXT (owner decision
// 2026-09-20): the judgment model. Unlike the CLI, this repo opens the socket
// itself, so the literal-host tripwire above does see api.typesafe.ai -- but a
// new call site that builds state for jev.mjs is invisible to it, exactly as a
// new CLI producer was. Every module that calls jev.ask must be listed in the
// ledger row's `evidence`.
const JEV_PRODUCERS = Object.freeze([
  'ui/server/relationship/jev.mjs',
  // The card's judgment pass: personState.mjs builds what leaves, this asks.
  'ui/server/relationship/judgments.mjs',
  // The distiller's yes/no prefilter over episode lines.
  'ui/server/relationship/prefilter.mjs',
  // The by-hand eval that replays judged cards; numbers only, run by the owner.
  'ui/scripts/eval-jev.mjs',
  // "Looking for": the owner's ask as the instruction, each person's state judged.
  'ui/server/relationship/ask.mjs',
  'ui/scripts/eval-ask.mjs',
]);

test('every module that asks the judgment model is named in the ledger', () => {
  const { ledger } = declaredHosts();
  const rows = ledger.paths.filter((p) => p.host === 'api.typesafe.ai');
  assert.equal(rows.length, 1, 'api.typesafe.ai must be declared exactly once');
  assert.equal(rows[0].kind, 'judgment-model');
  const named = rows[0].evidence ?? [];
  const missing = JEV_PRODUCERS.filter((mod) => !named.includes(mod));
  assert.deepEqual(missing, [], `these modules drive the judgment model and the ledger row does not name them: ${missing.join(', ')}`);
  for (const mod of JEV_PRODUCERS) {
    const full = join(REPO, mod);
    assert.ok(existsSync(full), `${mod} is in JEV_PRODUCERS but does not exist`);
    const text = readFileSync(full, 'utf8');
    assert.match(text, /jev\.ask|JEV_ENDPOINT|createJev/u, `${mod} is listed as a judgment producer but names no jev seam`);
  }
  // And the reverse: any module that imports the client is listed.
  const importers = scannedFiles()
    .filter((f) => f.endsWith('.mjs') && !f.includes('/test/'))
    // `./jev.mjs` from a sibling and `relationship/jev.mjs` from anywhere else
    // (review finding 5: the sibling form is what the two real callers use).
    .filter((f) => /\/jev\.mjs['"]/u.test(readFileSync(f, 'utf8')))
    .map((f) => f.slice(REPO.length + 1))
    .filter((rel) => rel !== 'ui/server/hermes.mjs');
  const unlisted = importers.filter((rel) => !named.includes(rel));
  assert.deepEqual(unlisted, [], `these modules import the judgment client but the ledger does not name them: ${unlisted.join(', ')}`);
});

test('every producer that spawns the installed claude client is named in the ledger', () => {
  const { ledger } = declaredHosts();
  const anthropic = ledger.paths.filter((p) => p.host === 'api.anthropic.com');
  assert.ok(anthropic.length > 0, 'api.anthropic.com must be declared at all');

  // Only the fields that are meant to say WHERE the invocation lives. A
  // module named nowhere but in `purpose` prose is not a component record.
  const named = anthropic
    .flatMap((p) => [String(p.component ?? ''), String(p.evidence ?? ''), String(p.decision ?? '')])
    .join('\n');

  const missing = CLI_PRODUCERS.filter((mod) => !named.includes(mod));
  assert.deepEqual(
    missing,
    [],
    `these modules drive the installed claude client and ops/EGRESS.json's ` +
      `api.anthropic.com rows do not name them:\n  ${missing.join('\n  ')}\n` +
      `Add each to that row's \`component\`/\`evidence\` with what it actually sends. ` +
      `The literal-host tripwire cannot catch this: no product file contains the URL, ` +
      `so the ledger's own text is the only record.`
  );
});

test('every module the ledger names as a CLI producer really exists and really spawns it', () => {
  // The mirror, so the list above cannot rot into a set of paths that moved:
  // each producer must be a real file, and must reach engines.mjs.
  for (const mod of CLI_PRODUCERS) {
    const full = join(REPO, mod);
    assert.ok(existsSync(full), `${mod} is in CLI_PRODUCERS but does not exist`);
    const text = readFileSync(full, 'utf8');
    assert.match(
      text,
      /engine\.complete|engines\.mjs|createLookupEngine/u,
      `${mod} is listed as a producer that reaches the installed CLI but names no engine seam. ` +
        `If it stopped being one, drop it from CLI_PRODUCERS and say so in the ledger.`
    );
  }
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
