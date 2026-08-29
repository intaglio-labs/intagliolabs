// The experiment-results tripwire: result-shaped files must not exist anywhere
// in the working tree, tracked or not.
//
// WHY THIS EXISTS. This repository is public and owner data has already landed
// in it once -- real phone numbers and per-contact message counts in
// ops/PROBES.md and a fixture, scrubbed by hand because they read as technical
// detail and no credential scanner flags a message count. The L5 experiment
// (L5-RELATIONSHIP-MEMORY-EXPERIMENT.md) produces exactly that shape of data
// on purpose: a sealed list of real people, per-person candidate snapshots,
// owner grades, outcome events. The design decision is that none of it ever
// has a path inside the repo -- it lives in ~/.hazlie/experiments/ -- and this
// test is the enforcement. A .gitignore is advisory: `git add -f`, a
// bulk-staging tool, or a copied fixture walks past it, and a push to a public
// repo is forever.
//
// WHY THE WORKING TREE AND NOT `git ls-files`. A file is dangerous the moment
// it exists under the repo root, because that is where the next `git add .`
// finds it. Scanning the tree catches it before the commit, not after; it also
// keeps the test free of a child-process git dependency.
//
// DELIBERATELY BLUNT, like egress.test.mjs beside it. Any directory named
// experiments/, results/, or exp_*/ fails, anywhere. Any file whose name says
// sealed, grades, candidates, or outcomes fails, as does any .db, .sqlite*,
// or .jsonl file at all -- in this tree a serialized row store IS data. The
// cost of a false positive is renaming one file; the cost of a false negative
// is a stranger's relationship data in public git history.
//
// WHAT IT DOES NOT COVER, so nobody reads a green suite as more than it is:
// it matches names, not content. Owner data pasted into a doc, a commit
// message, or an innocently named fixture is invisible to it -- rule 6 in
// CLAUDE.md still binds the humans. ops/l5-promotion-gates.json is committable
// by design: thresholds, windows, decision rules, and a sha256 of the sealed
// list -- never the list.
//
// WHEN THIS FAILS: move the file to ~/.hazlie/experiments/, or rename it if it
// genuinely is not data. Do not add an exemption here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Reserved directory names. exp_*/ is the other-track experiment convention
// egress.test.mjs already documents as out of scope THERE precisely because it
// must not exist HERE.
const RESERVED_DIR = /^(experiments|results|exp_.+)$/i;

// Result-shaped basenames. The word-based patterns come straight from the L5
// plan's own vocabulary ('eval' added 2026-08-29 when the continuous-eval
// loop started producing l5-eval-*.json files -- grades with free-text owner
// feedback, exactly the shape that must never land here); the extension-based
// ones catch a row store however it is named.
const RESERVED_FILE = /(sealed|grades|candidates|outcomes|eval)|\.(db|sqlite3?|jsonl)$/i;

// Vendored and generated trees, same shape as egress.test.mjs. .git holds
// object files this scan has no business reading.
const SKIP_DIR = new Set([
  '.git', 'node_modules', 'dist', 'public', 'build', '.expo', 'models',
  'vendor', '_expo', 'dl',
]);

// The floor: a walk that read nothing must not pass, the lesson egress paid
// for. One aggregate number is the right shape here because there is one root
// -- the repo itself. Measured 2026-08-28: 232 files walked; the floor sits
// well under it so ordinary deletion stays green and a collapsed walk cannot.
const MIN_FILES_WALKED = 100;

function walk(dir, hits, counter) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(REPO, path);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (SKIP_DIR.has(name)) continue;
      if (RESERVED_DIR.test(name)) {
        hits.push(`${rel}/ (reserved directory name)`);
        continue; // its contents are one finding, not fifty
      }
      walk(path, hits, counter);
    } else if (st.isFile()) {
      counter.files += 1;
      if (RESERVED_FILE.test(name)) hits.push(rel);
    }
  }
}

test('no experiment-result-shaped file or directory exists in the working tree', () => {
  const hits = [];
  const counter = { files: 0 };
  walk(REPO, hits, counter);
  assert.deepEqual(
    hits,
    [],
    `experiment results must live in ~/.hazlie/experiments/, never in this public repo:\n  ${hits.join('\n  ')}`,
  );
  assert.ok(
    counter.files >= MIN_FILES_WALKED,
    `the scan reached only ${counter.files} files (floor ${MIN_FILES_WALKED}); an unplugged tripwire looks identical to one that never fired`,
  );
});
