// THE ROW PROMISES DURABILITY, SO IT HAS TO KNOW WHEN IT DID NOT GET IT.
//
// Screen 1's mode picker sits directly above the sentence "your choice is kept
// by the reader". POST /admin/relationship/mode deliberately answers 200 with
// `persisted: false` when its config write fails -- the mode IS live in the
// running hermes, so a 4xx would make the picker look broken when what broke
// is durability, and the route's own comment says so.
//
// The page threw that flag away: `hzPost('relMode', ...).catch(() => {})` with
// no `.then`. The screen went on making the promise while the next hermes
// restart silently reverted the choice to the old one, and nothing anywhere
// told the owner.
//
// Pinned here: the flag is read, a failure is retried once before anything is
// said, and what is said is said QUIETLY -- the same ob-note voice as the
// promise it corrects. An alarm colour would be the page blaming the owner for
// a file write they had no part in.
//
// Source scan, like the other widget tests -- no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(WIDGET, 'ui', 'onboarding.js'), 'utf8');
const html = readFileSync(join(WIDGET, 'ui', 'onboarding.html'), 'utf8');

/// Code only: the comments in onboarding.js explain the very defect being
/// pinned, so a naive `includes` would find the fix in the prose describing it.
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//u.test(line))
  .join('\n');

/// A top-level `function name(...) { ... }` body, matched on the closing brace
/// in column zero.
function bodyOf(name) {
  const re = new RegExp(`\\nfunction ${name}\\(([^)]*)\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`, 'u');
  const m = re.exec(js);
  assert.ok(m, `${name}() not found in onboarding.js`);
  return code(m[2]);
}

/// The mode row's click handler, matched on the `});` in column zero.
function clickHandler() {
  const m = /modesEl\.addEventListener\('click', \(e\) => \{\n([\s\S]*?)\n\}\);/u.exec(js);
  assert.ok(m, 'the mode row has no click handler in onboarding.js');
  return code(m[1]);
}

test('the click goes through the writer that reads the reply', () => {
  const handler = clickHandler();
  assert.match(handler, /writeMode\(/u,
    'the mode click must go through writeMode; a bare hzPost with only a .catch is the\n' +
    'defect -- the persisted flag has nowhere to be read');
  assert.doesNotMatch(handler, /hzPost\('relMode'/u,
    'the handler must not post directly, or the reply is discarded at the call site');
});

test('the persisted flag is read, and only a definite false is acted on', () => {
  const body = bodyOf('writeMode');
  assert.match(body, /persisted/u,
    "writeMode must read the route's persisted flag; it is the only thing that knows\n" +
    'whether the choice survives a restart');
  assert.match(body, /typeof out\.persisted !== 'boolean'/u,
    'a reply with no persisted flag never reached the route -- that is the hermes that\n' +
    'is still starting, which the note already on screen describes, and it must not be\n' +
    'reported as a failed write');
});

test('a failed write is retried once before the owner is told', () => {
  const body = bodyOf('writeMode');
  assert.match(body, /writeMode\(mode, true\)/u,
    'a persisted:false must be retried once -- the write is an atomic read-modify-write\n' +
    'of one small file, so a second attempt is a real chance');
  const retry = body.indexOf('writeMode(mode, true)');
  const tell = body.search(/modeNote\.textContent = '[^']/u);
  assert.ok(tell > 0, 'the failure must be surfaced on screen 1, not only in a console');
  assert.ok(retry < tell,
    'the retry comes first: telling the owner the choice did not stick and then quietly\n' +
    'succeeding on a retry would be worse than saying nothing');
});

test('the note is cleared again when a write does stick', () => {
  const body = bodyOf('writeMode');
  assert.match(body, /modeNote\.textContent = ''/u,
    'a later successful write must clear the note, or one transient failure leaves the\n' +
    'screen saying the choice is lost for the rest of the flow');
});

test('the note exists on screen 1 and carries no alarm colour', () => {
  const el = /<p class="([^"]*)" id="modeNote"><\/p>/u.exec(html);
  assert.ok(el, 'screen 1 must carry an empty <p id="modeNote"> for writeMode to fill');
  assert.equal(el[1], 'ob-note',
    'the note wears the same quiet class as the promise above it; nothing the owner did\n' +
    'caused this and the choice they made is in force right now');

  // The three colour classes this page uses for status. None of them may ever
  // be put on the mode note.
  const body = bodyOf('writeMode');
  assert.doesNotMatch(body, /modeNote\.classList/u,
    'writeMode must not add a colour class to the note');
  assert.doesNotMatch(js, /modeNote\.classList\.add\('(bad|warn|ok)'\)/u,
    "nothing may paint the mode note with the page's status colours");
});
