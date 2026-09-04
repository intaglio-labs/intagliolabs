// ui/devtools must never reach a user's machine.
//
// The owner's constraint, stated while it was being written: "make sure this ui
// doesn't make it to the product this is just for dev". A comment saying so is
// not a mechanism — build.sh copies ui/server and ui/scripts wholesale, and the
// difference between a shipped directory and a dev one is one line in a copy
// list that nobody reads twice.
//
// So it is asserted. These tests fail if devtools is ever added to the bundle,
// if it grows a dependency the product would have to carry, or if the product
// starts importing from it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const build = readFileSync(join(ROOT, 'widget/build.sh'), 'utf8');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test('build.sh never copies ui/devtools into the bundle', () => {
  const copyLines = build.split('\n').filter((l) => /^\s*(cp|clone_tree|rsync)\b/u.test(l));
  for (const line of copyLines) {
    assert.ok(!line.includes('devtools'),
      `build.sh copies devtools into the app: ${line.trim()}`);
  }
  // And the directories it DOES copy from ui/ are still only these two — a new
  // wholesale copy of ui/ would sweep devtools in without mentioning it by name.
  // build.sh runs FROM widget/, so a bare `ui/` in it is widget's own asset
  // directory, not the ui/ package. Only `../ui/...` reaches the package — which
  // is the path devtools would have to be copied through.
  const packageCopies = copyLines.filter((l) => /\.\.\/ui\//u.test(l));
  for (const line of packageCopies) {
    assert.ok(/\.\.\/ui\/(server|scripts)\b/u.test(line),
      `an unexpected ui/ package path is copied into the bundle: ${line.trim()}`);
  }
  assert.ok(packageCopies.length >= 2, 'the ui package copies should still be found at all');
});

test('no product code imports from devtools', () => {
  for (const dir of ['ui/server', 'ui/scripts', 'connectors', 'connect']) {
    for (const file of walk(join(ROOT, dir))) {
      if (!/\.(mjs|js)$/u.test(file)) continue;
      const src = readFileSync(file, 'utf8');
      // A PATH, not the word. connect/lib/bridge.mjs discusses Chrome's devtools
      // in prose, which is not a dependency on ui/devtools -- and a test that
      // cannot tell those apart fails for the wrong reason and gets deleted.
      assert.ok(!/(ui\/devtools|devtools\/review)/u.test(src),
        `${file.replace(ROOT, '')} imports from ui/devtools; the product must not depend on it`);
    }
  }
});

test('the dev server binds loopback and adds no product route', () => {
  const serve = readFileSync(join(ROOT, 'ui/devtools/review/serve.mjs'), 'utf8');
  assert.match(serve, /listen\(PORT, '127\.0\.0\.1'/u,
    'it serves private message content and must be unreachable off the machine');
  assert.match(serve, /readOnly: true/u,
    'hermes is the sole writer of the corpus');
  // It must work through the shipped API rather than reimplementing decisions,
  // or the thing being reviewed stops being the thing the product uses.
  assert.match(serve, /\/admin\/memory\/pending/u);
  assert.match(serve, /\/admin\/memory\/decide/u);
});
