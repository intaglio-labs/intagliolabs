// THE TWO THINGS THE OWNER DID ON SCREENS 3 AND 4, AND THE SCREEN THAT DID NOT
// MENTION THEM.
//
// On the second clean-machine onboarding run (2026-09-12) the connectors daemon
// started at app launch — before the Google sign-in and before the LinkedIn
// export. Both sources answered "not ready", and:
//
//   * nothing told the daemon the wait was over, so the reader would not have
//     looked again for a quarter of an hour (widget's half of that is the
//     nudge below; the daemon's half is connectors/test/notReadyReprobe);
//   * screen 6's table is built from rows and run history, so the two sources
//     the owner had just connected were the two it did not draw — and when they
//     ARE drawn, "connected, nobody found yet" would be a verdict on a search
//     that has not happened;
//   * and the card peek's wire word reached them verbatim: "no card yet —
//     pool-exhausted".
//
// Source scan, like the other widget tests — no toolchain, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const js = readFileSync(join(ROOT, 'widget', 'ui', 'onboarding.js'), 'utf8');
const connectors = readFileSync(join(ROOT, 'widget', 'src', 'Connectors.swift'), 'utf8');
const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');

/// Code only: the comments in these files describe the very defects being
/// pinned, so a naive `includes` finds the bug's own description.
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\/\/)/u.test(line))
  .join('\n');

function bodyOf(source, name) {
  const re = new RegExp(`\\nfunction ${name}\\(([^)]*)\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`, 'u');
  const m = re.exec(source);
  assert.ok(m, `${name}() not found`);
  return code(m[2]);
}

/// A Swift method body, matched on the `  }` at its own indentation.
function swiftBody(source, signature) {
  const re = new RegExp(`\\n  (?:private )?func ${signature} \\{\\n([\\s\\S]*?)\\n  \\}\\n`, 'u');
  const m = re.exec(source);
  assert.ok(m, `${signature} not found`);
  return code(m[1]);
}

// ------------------------------------------------------- the table's new word

test('a connected source nobody has read yet is neutral, not amber', () => {
  const copy = /const STATUS_COPY = \{\n([\s\S]*?)\n\};/u.exec(js);
  assert.ok(copy, 'STATUS_COPY not found');
  const body = code(copy[1]);
  assert.match(body, /waiting: 'reading soon'/u,
    'the route can answer `waiting`, and the page must have a sentence for it');
  // Without the entry the cell falls through to 'reading', which claims the
  // reader has reached a source it has not started.
  assert.doesNotMatch(body, /waiting: 'connected, nobody found yet'/u);

  const cell = bodyOf(js, 'statusCell');
  const colours = /const cls = \{([^}]*)\}/u.exec(cell);
  assert.ok(colours, 'statusCell no longer maps a status to a colour');
  assert.doesNotMatch(colours[1], /waiting/u,
    'waiting takes the grey default; amber is for a source that WAS read and found nobody');
});

// ----------------------------------------------------------- the peek's words

test('the card peek never shows the owner a wire word', () => {
  const peek = bodyOf(js, 'peekCard');
  assert.doesNotMatch(peek, /no card yet — \$\{out\.reason\}/u,
    'the raw reason reached the owner as "no card yet — pool-exhausted"');
  assert.match(peek, /out\.reason === 'pool-exhausted'/u,
    'the one reason a fresh install actually hits needs its own sentence');
  assert.match(peek, /nobody qualifies yet/u);
  assert.match(peek, /retryAfterMs/u, 'the route says when it will look again; say so');
  assert.match(peek, /checking again in \$\{minutes\} min/u);
});

// ------------------------------------------------------------------ the nudge

test('the app tells the reader to look again instead of restarting it', () => {
  const nudge = swiftBody(connectors, 'nudge\\(\\)');
  assert.match(nudge, /SIGUSR2/u, 'SIGUSR1 is reserved by node for its own debugger');
  assert.match(nudge, /p\.isRunning/u, 'signalling a dead pid is signalling somebody else');
  // SIGUSR2's default action is terminate, and the daemon installs its handler
  // a moment after exec. A process that young is also one whose own startup
  // probe is about to ask the same question.
  assert.match(nudge, /nudgeGrace/u, 'a just-spawned daemon must not be signalled');
  assert.doesNotMatch(nudge, /terminate\(\)/u,
    'a missing token file is not a reason to throw away a pass in flight');
});

test('completing a connect screen nudges the reader that is already running', () => {
  const start = swiftBody(bridge, 'startReadingSources\\(\\) -> Bool');
  const startsIt = start.indexOf('Connectors.shared.start()');
  const nudges = start.indexOf('Connectors.shared.nudge()');
  assert.notEqual(startsIt, -1, 'startReadingSources must still start the daemon');
  assert.notEqual(nudges, -1,
    'start() is silent when the daemon is up, and those are the calls that matter');
  assert.ok(startsIt < nudges, 'nudge a daemon that exists: start first, then ask it to look');
});
