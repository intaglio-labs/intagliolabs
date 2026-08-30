// A consumer is never shown a shell command, and never asked for a password the
// app cannot deliver.
//
// Both failures were reported from the running app on 2026-08-29. The owner
// pressed Instagram, completed a real Meta login, and was then told: "the social
// bridge engine is not running — open Docker, then: bash ops/setup-bridges.sh".
// That sentence was wrong three ways at once — it named a repo path a downloaded
// install does not have, it told them to run a script the app already runs
// itself (Provision.ensureBridgeRuntime), and it omitted the only fact that
// resolves it. Worse, it arrived AFTER the credential had been typed and
// harvested, because GET /api/bridge answers 200 whether or not a stack exists.
//
// A source scan, like connect-affordances.test.mjs: this drifts silently, and
// the two UI files are deliberate duplicates that must change together.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI = ['ui/connections.js', 'ui/connector-tile.js'];
const src = Object.fromEntries(UI.map((f) => [f, readFileSync(join(WIDGET, f), 'utf8')]));
const swift = readFileSync(join(WIDGET, 'src/Bridge.swift'), 'utf8');

// The notice the owner actually reads, not the comment above it explaining what
// it used to say.
const noticeLine = (text) => {
  const line = text.split('\n').find((l) => /^\s*nobridge:/u.test(l));
  assert.ok(line, 'every notice table must still carry a nobridge entry');
  return line;
};

for (const file of UI) {
  test(`${file} tells a consumer to start an app, not to run a shell`, () => {
    const line = noticeLine(src[file]);
    assert.doesNotMatch(line, /bash |\.sh\b|ops\//u, `a shell instruction survives: ${line.trim()}`);
    // ~~/Docker/~~ was right when Docker was the only runtime. Since e9567ea the
    // native path is the default and Docker is the fallback, so naming the
    // vendor in the notice sent a native install somewhere it does not need to
    // go. Assert that the notice names the thing that is missing — the engine —
    // rather than one implementation of it. The Docker BUTTON is still pinned by
    // the next test, because the fallback must stay reachable.
    assert.match(line, /engine|Docker/u, 'it should still name what is actually needed');
    assert.doesNotMatch(line, /Docker Desktop/u,
      'the notice must not name a runtime the install may not be using');
  });

  test(`${file} offers Docker as a button rather than an instruction`, () => {
    // Quoting varies between these files, so match the call, not a literal.
    assert.match(
      src[file],
      /hzPost\(\s*['"`]openApp['"`]\s*,\s*\{\s*bundleId:\s*['"`]com\.docker\.docker['"`]/u,
      'the notice must be able to launch Docker itself'
    );
    // ↗ is the repo's marker for "this leaves the app" (connect-affordances).
    assert.match(src[file], /open Docker \\u2197|open Docker ↗/u, 'the button must say it leaves the app');
  });
}

test('the two duplicated notice tables agree, as their comments require', () => {
  const [a, b] = UI.map((f) => noticeLine(src[f]).trim());
  assert.equal(a, b, 'connections.js and connector-tile.js drifted');
});

test('Docker is launchable, so the button is not inert', () => {
  const line = swift.split('\n').find((l) => l.includes('allowedApps'));
  assert.ok(line, 'allowedApps must exist');
  assert.match(line, /com\.docker\.docker/u, 'openApp refuses any bundle id not in this set');
});

// THE ONE THAT MATTERS. Without this the app opens a real Meta login page on a
// machine with no homeserver, harvests a real session, and drops it.
test('no login window is presented when the engine is known to be down', () => {
  assert.match(
    swift,
    /begin\["engine"\]\s+as\?\s+String\s+==\s+"down"/u,
    'Bridge.swift must consult the engine field before presenting a login'
  );
  const gate = swift.indexOf('begin["engine"] as? String == "down"');
  const present = swift.indexOf('BridgeLogin.present');
  assert.ok(gate > 0 && present > 0, 'both the gate and the presentation must exist');
  assert.ok(gate < present, 'the engine check must come BEFORE the login window is presented');
});
