// THE CHECK HAPPENS BEFORE THE COPY, and that ordering is the whole feature.
//
// connectors/lib/linkedinRows.mjs parses both LinkedIn files through
// csvObjects(text, { anchor }), which SCANS for a header row containing a
// known column. With no such row it yields nothing — so a French export
// (Prénom/Nom) copies in fine, the connector records `rows: 0` and `ok: true`,
// and the first-load screen shows LinkedIn at zero with nothing anywhere
// saying the file could not be read. A quiet zero is the worst outcome
// available here, because it is indistinguishable from a small export.
//
// So the anchor is checked on the PICKED file, before anything is written, and
// a file that fails is named back with its own first column quoted. Checking
// the anchor is checking the parse: it is the same string the parser keys on,
// and this test pins that it is the same string.
//
// Source scan, like the other widget tests — no toolchain, no file picker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridge = readFileSync(join(ROOT, 'widget', 'src', 'Bridge.swift'), 'utf8');
const rows = readFileSync(join(ROOT, 'connectors', 'lib', 'linkedinRows.mjs'), 'utf8');

const accept = /private func acceptLinkedInFiles\(_ urls: \[URL\]\) -> \[String: Any\] \{([\s\S]*?)\n {2}\}/u
  .exec(bridge)?.[1];

test('the import checks the exact anchors the parser keys on', () => {
  // Read from linkedinRows.mjs rather than written down twice: if somebody
  // changes what csvObjects is asked to find, this fails rather than the
  // import quietly checking for a column nothing parses by.
  const anchors = [...rows.matchAll(/csvObjects\([^)]*\{\s*anchor:\s*'([^']+)'\s*\}\)/gu)]
    .map((m) => m[1]);
  assert.deepEqual(anchors, ['First Name', 'CONVERSATION ID'], 'the parser has two anchors');

  const kinds = /linkedInKinds: \[\(anchor: String, name: String\)\] = \[([\s\S]*?)\n {2}\]/u
    .exec(bridge)?.[1];
  assert.ok(kinds, 'Bridge.linkedInKinds not found');
  for (const anchor of anchors) {
    assert.ok(kinds.includes(`"${anchor}"`), `the import does not check for ${anchor}`);
  }
  // And the canonical names the connector actually looks for.
  assert.match(kinds, /"Connections\.csv"/u);
  assert.match(kinds, /"messages\.csv"/u);
});

test('nothing is copied until the anchor is found', () => {
  assert.ok(accept, 'acceptLinkedInFiles not found');
  const guardAt = accept.indexOf('linkedInKinds.first(where:');
  const copyAt = accept.indexOf('copyItem(at: url');
  assert.ok(guardAt > -1, 'the anchor check is gone');
  assert.ok(copyAt > -1, 'the copy is gone');
  assert.ok(guardAt < copyAt, 'the anchor is checked BEFORE the copy, not after it');
  // The failure returns rather than falling through to the copy.
  assert.match(accept, /else \{[\s\S]{0,400}"reason": "columns"[\s\S]{0,200}\n\s*\}/u);
});

test('the failure names the column back, bounded and stripped', () => {
  assert.match(accept, /"firstColumn": Bridge\.firstColumn\(of: head\)/u);
  const firstColumn = /private static func firstColumn\(of head: String\) -> String \{([\s\S]*?)\n {2}\}/u
    .exec(bridge)?.[1];
  assert.ok(firstColumn, 'firstColumn() not found');
  // This is file content on its way to a screen: bounded, and control
  // characters removed.
  assert.match(firstColumn, /prefix\(60\)/u);
  assert.match(firstColumn, /controlCharacters/u);
});

test('the anchor may appear anywhere in the head, not only on line one', () => {
  // LinkedIn puts a "Notes:" paragraph above the real header and csvObjects
  // handles it, so a line-one check would reject files that parse perfectly.
  assert.match(bridge, /readHead\(of: url, bytes: 4096\)/u);
  assert.match(accept, /head\.contains\(\$0\.anchor\)/u,
    'contains, not a line-one comparison');
});

test('the export lands 0600 inside a 0700 directory', () => {
  assert.match(accept, /posixPermissions: 0o700/u, 'the directory');
  assert.match(accept, /setAttributes\(\[\.posixPermissions: 0o600\], ofItemAtPath: destination\.path\)/u,
    'the file');
  assert.match(bridge, /\.hazlie\/imports\/linkedin/u, 'where the connector looks for it');
});

test('an older pick cannot overwrite a newer export', () => {
  // Onboarding can be replayed from the gear on a machine that already has an
  // export, and "the LinkedIn file" in Downloads may well be last year's.
  assert.match(accept, /contentModificationDateKey[\s\S]{0,400}existing > picked[\s\S]{0,200}"reason": "newer"/u);
});

test('a zip is refused with a sentence, not extracted', () => {
  // Extraction would mean a subprocess, and every check in this flow runs in
  // this process. It stays SELECTABLE in the panel so the file the owner just
  // downloaded is not greyed out with no explanation.
  assert.match(bridge, /UTType\("public\.zip-archive"\)/u, 'offered in the panel');
  assert.match(accept, /pathExtension\.lowercased\(\) == "zip"[\s\S]{0,200}"reason": "zip"/u);
  // Scoped to the import itself: Bridge.swift spawns exactly one process
  // elsewhere (moveToApplications' detached relauncher), and a file-wide
  // assertion would pin that unrelated fact instead of this one.
  const region = /\/\/ MARK: the LinkedIn export([\s\S]*?)\n {2}private func bridgeCall\(/u
    .exec(bridge)?.[1];
  assert.ok(region, 'the LinkedIn import section is gone');
  assert.doesNotMatch(region, /Process\(\)|launchPath|executableURL/u,
    'nothing in the import spawns anything to open an archive');
});

test('the connection count is counted, quote-aware, not guessed from newlines', () => {
  const count = /private static func countRows\(inCsvAt url: URL, anchor: String\) -> Int \{([\s\S]*?)\n {2}\}/u
    .exec(bridge)?.[1];
  assert.ok(count, 'countRows() not found');
  // A position or company can carry a comma AND a newline inside a quoted
  // field; splitting on "\n" would report more connections than the owner has.
  assert.match(count, /var inQuotes = false/u);
  assert.match(count, /if !inQuotes, c == "\\n" \|\| c == "\\r"/u);
  // Counted from after the header row, the same slice csvObjects takes.
  assert.match(count, /lines\.count - headerIndex - 1/u);
  assert.match(accept, /connections = Bridge\.countRows\(inCsvAt: destination, anchor: kind\.anchor\)/u);
});

test('the reader is nudged once the files are on disk', () => {
  // A connector only picks a source up when it runs, and the owner is watching
  // this screen now.
  assert.match(accept, /Connectors\.shared\.start\(\)/u);
});
