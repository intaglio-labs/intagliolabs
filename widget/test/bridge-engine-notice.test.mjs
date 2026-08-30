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
//
// Updated 2026-08-30 when Docker was deleted outright. The notice has now been
// wrong three times in three different ways -- a shell command, then a vendor
// name on an install that did not use that vendor, then a button offering to
// install a VM the build no longer wants -- so what is asserted below is the
// absence of every one of them, not the presence of the latest wording.

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
// THE STRING THE CARD ACTUALLY RENDERS, not the table entry beside it.
//
// This selected /^\s*nobridge:/ — the NOTICES entry — while its own comment
// claimed to be checking "the notice the owner actually reads". The card path
// branches to nobridgeNotice(), which sets line.textContent directly, so the
// table entry is a fallback the owner may never see. Correcting the entry
// therefore passed this test and changed nothing on screen: the card still said
// "Docker Desktop" on an install where Docker is not even the provisioner.
//
// Assert the rendered string. It is the fifth time this session a test matched
// something adjacent to the thing it meant.
const noticeLine = (text) => {
  const line = text.split('\n').find((l) => /line\.textContent = 'social connections/u.test(l));
  assert.ok(line, 'the nobridge card must set its own text');
  return line;
};

for (const file of UI) {
  test(`${file} tells a consumer what is happening, not what to run`, () => {
    const line = noticeLine(src[file]);
    assert.doesNotMatch(line, /bash |\.sh\b|ops\//u, `a shell instruction survives: ${line.trim()}`);
    // ~~/Docker/~~ ~~/engine|Docker/~~ -- both were right for the runtime of
    // their day. Docker is deleted now, so the notice must not name it at all:
    // there is no button to press, no app to open, and nothing the owner can do
    // to hurry it. What is left is a fact -- the stack is still coming up -- and
    // the machine doing the rest.
    assert.doesNotMatch(line, /Docker/u,
      'the notice must not name a runtime this build does not have');
    assert.doesNotMatch(line, /press this again|then press/u,
      'there is no owner action left to prompt for');
  });

  test(`${file} offers nothing to press`, () => {
    // The notice used to build an "open Docker ↗" button. An affordance that
    // cannot help is worse than none: it invites a click, opens a VM installer,
    // and changes nothing about why the bridges are not up yet.
    // COMMENTS STRIPPED. Both files explain at length what the notice used to
    // say, and "open Docker" appears in that explanation -- matching the raw
    // source asserts the absence of a comment, not of a button.
    const code = src[file].split('\n').filter((l) => !/^\s*\/\//u.test(l)).join('\n');
    assert.doesNotMatch(code, /com\.docker\.docker/u,
      'nothing may still try to launch Docker');
    assert.doesNotMatch(code, /open Docker/u, 'the button text must be gone too');
    const fn = src[file].match(/function hz\w*NobridgeNotice\(tip\) \{[\s\S]*?\n\}/u)?.[0];
    assert.ok(fn, 'the nobridge notice must still exist');
    assert.doesNotMatch(fn, /createElement\('button'\)/u,
      'the notice must not build a button it cannot make useful');
  });
}

test('the two duplicated notice tables agree, as their comments require', () => {
  const [a, b] = UI.map((f) => noticeLine(src[f]).trim());
  assert.equal(a, b, 'connections.js and connector-tile.js drifted');
});

test('the openApp allowlist grants nothing the UI no longer asks for', () => {
  // com.docker.docker lived here only so the nobridge button could launch it.
  // An allowlist entry with no caller is a capability granted for free.
  const line = swift.split('\n').find((l) => l.includes('allowedApps'));
  assert.ok(line, 'allowedApps must exist');
  assert.doesNotMatch(line, /com\.docker\.docker/u, 'a caller-less entry must not linger');
  assert.doesNotMatch(swift, /docker\.com/u, 'nor its download link in allowedExternal');
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
