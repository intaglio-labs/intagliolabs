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

  const kinds = /linkedInKinds: \[\(anchor: String, require: \[String\], name: String\)\] = \[([\s\S]*?)\n {2}\]/u
    .exec(bridge)?.[1];
  assert.ok(kinds, 'Bridge.linkedInKinds not found');
  for (const anchor of anchors) {
    assert.ok(kinds.includes(`"${anchor}"`), `the import does not check for ${anchor}`);
  }
  // And the canonical names the connector actually looks for.
  assert.match(kinds, /"Connections\.csv"/u);
  assert.match(kinds, /"messages\.csv"/u);
});

test('nothing is copied until EVERY picked file has been checked', () => {
  assert.ok(accept, 'acceptLinkedInFiles not found');
  const guardAt = accept.indexOf('Bridge.linkedInKind(of: head)');
  const copyAt = accept.indexOf('copyItem(at: entry.url');
  assert.ok(guardAt > -1, 'the anchor check is gone');
  assert.ok(copyAt > -1, 'the copy is gone');
  assert.ok(guardAt < copyAt, 'the anchor is checked BEFORE the copy, not after it');
  // The failure returns rather than falling through to the copy.
  assert.match(accept, /else \{[\s\S]{0,400}"reason": "columns"[\s\S]{0,200}\n\s*\}/u);
  // AND THE CHECKING LOOP IS A SEPARATE LOOP. Selecting Connections.csv and
  // Profile.csv together used to land the first, fail on the second, and
  // leave a half-applied import with nothing scheduled to read it.
  const passOne = accept.indexOf('// PASS ONE');
  const passTwo = accept.indexOf('// PASS TWO');
  assert.ok(passOne > -1 && passTwo > passOne, 'the check and the copy share one loop again');
  assert.ok(copyAt > passTwo, 'every copy belongs to the second pass');
  for (const reason of ['unreadable', 'columns', 'newer']) {
    const at = accept.indexOf(`"reason": "${reason}"`);
    assert.ok(at > passOne && at < passTwo, `${reason} must be refused before anything is written`);
  }
  // Even a disk error mid-copy leaves the previous export alone: the copies
  // are staged beside their destinations and only renamed once all of them
  // have landed.
  assert.match(accept, /\.importing/u, 'copies are staged');
  assert.ok(accept.search(/fm\.moveItem\(at: entry\.temporary/u) > copyAt, 'and swapped in after');
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

test('the header may appear anywhere in the head, not only on line one', () => {
  // LinkedIn puts a "Notes:" paragraph above the real header and csvObjects
  // handles it, so a line-one check would reject files that parse perfectly.
  // The rule is csv.mjs's: scan ROWS, compare FIELDS.
  assert.match(bridge, /readHead\(of: url, bytes: 4096\)/u);
  const kindOf = /private static func linkedInKind\(of head: String\)[\s\S]*?\n {2}\}/u.exec(bridge)?.[0];
  assert.ok(kindOf, 'linkedInKind(of:) not found');
  assert.match(kindOf, /for row in csvRows\(head\)/u, 'rows, not a line-one comparison');
  assert.match(kindOf, /fields\.contains\(kind\.anchor\)/u, 'an exact field, not a substring');
  // And the fixture with the preamble still classifies (see the fixture tests
  // below), which is what says the scan actually reaches past it.
});

test('the export lands 0600 inside a 0700 directory', () => {
  assert.match(accept, /posixPermissions: 0o700/u, 'the directory');
  assert.match(accept, /setAttributes\(\[\.posixPermissions: 0o600\], ofItemAtPath: temporary\.path\)/u,
    'the file, set on the staged copy so it is never briefly world-readable');
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

const COUNT_ROWS = /private static func countRows\(inCsvAt url: URL, anchor: String\) -> Int \{([\s\S]*?)\n {2}\}/u
  .exec(bridge)?.[1];

test('the connection count is counted, quote-aware, not guessed from newlines', () => {
  assert.ok(COUNT_ROWS, 'countRows() not found');
  // A position or company can carry a comma AND a newline inside a quoted
  // field; splitting on "\n" would report more connections than the owner has.
  // csvRows() is the RFC-4180 walk that already knows this, and is now the only
  // copy of it in the file.
  assert.match(COUNT_ROWS, /csvScan\(text\)/u);
  // Counted from after the header ROW, the same slice csvObjects takes.
  assert.match(COUNT_ROWS, /guard index > headerIndex else \{ return \}/u);
  assert.match(accept,
    /connections = Bridge\.countRows\(inCsvAt: entry\.destination, anchor: entry\.kind\.anchor\)/u);
});

// ONE HEADER RULE, NOT TWO.
//
// linkedInKind was rewritten to find the header the way csv.mjs does — the
// first row holding a FIELD whose trim() equals the anchor — because
// `head.contains(anchor)` also matches the anchor appearing in LinkedIn's
// "Notes:" preamble or in somebody's job title. countRows kept the substring
// rule, so the same file could be CLASSIFIED at the real header and COUNTED
// from a preamble line, and the "N connections already here" the second-run
// screen shows came out inflated by the preamble's offset.
test('the count finds the header by the same rule the classifier does', () => {
  assert.doesNotMatch(COUNT_ROWS, /\$0\.contains\(anchor\)/u, 'the substring rule is back');
  assert.match(COUNT_ROWS, /csvFields\(\$0\)\.contains\(anchor\)/u);
  // Shared, not copied: both call the same helper, so they cannot drift into
  // two different rules about the same header.
  const kindOf = /private static func linkedInKind\(of head: String\)[\s\S]*?\n {2}\}/u.exec(bridge)?.[0];
  assert.match(kindOf, /csvFields\(row\)/u);
  assert.match(bridge, /private static func csvFields\(_ row: \[String\]\) -> Set<String> \{/u);
});

/// The count, as the Swift is required to implement it: the first row whose
/// trimmed fields hold the anchor exactly, then every non-blank row after it.
function countFrom(text, anchor) {
  const rows = parseCsv(text);
  const at = rows.findIndex((row) => row.some((f) => f.trim().replace(/^\uFEFF/u, '') === anchor));
  if (at === -1) return 0;
  return rows.slice(at + 1).filter((row) => row.some((f) => f.trim() !== '')).length;
}

/// And the rule it replaced, for the disagreement.
function countFromSubstring(text, anchor) {
  const lines = [];
  let inQuotes = false;
  let current = '';
  for (const c of text) {
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && (c === '\n' || c === '\r')) {
      if (current !== '') lines.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current !== '') lines.push(current);
  const at = lines.findIndex((line) => line.includes(anchor));
  return at === -1 ? 0 : lines.length - at - 1;
}

test('a preamble that mentions the column no longer inflates the count', () => {
  // A REAL EXPORT SHAPE. LinkedIn opens Connections.csv with "Notes:" and a
  // quoted paragraph; this one names the First Name column inside it, which is
  // the sentence the old rule counted from.
  const text = fixture('Connections-preamble.csv');
  assert.equal(classify(text), 'Connections.csv', 'it is still the same file to the classifier');
  assert.equal(countFrom(text, 'First Name'), 3, 'three connections, counted from the header row');
  assert.equal(countFromSubstring(text, 'First Name'), 4,
    'the old rule counted from the preamble — this is the discriminating pair');
});

test('the ordinary export counts the same under both rules', () => {
  // The shipped fixture has a preamble that does NOT name the column, which is
  // why the substring rule survived this long. Both answers agree here, and
  // that is the point: the fix is not a change of answer on real input.
  const text = fixture('Connections.csv');
  assert.equal(countFrom(text, 'First Name'), 2);
  assert.equal(countFromSubstring(text, 'First Name'), 2);
});

// A PICK IS ONE ACTION: IT SUCCEEDS WHOLE OR IT CHANGES NOTHING ON DISK.
//
// The doc comment above acceptLinkedInFiles has said that for a while; the
// swap loop did not implement it. It was per-file `removeItem(destination)`
// then `moveItem`, which has a window with NEITHER file at the destination —
// a crash there destroys an export the owner had while the replacement is
// still named `.importing` — and no way to put anything back when the second
// file of a multi-select fails. Connections.csv new, messages.csv old.
test('the swap is atomic per file and undone as a whole', () => {
  const swap = accept.slice(accept.indexOf('var copied: [String] = []'));
  assert.ok(swap, 'the swap loop was not found');
  assert.match(swap, /fm\.replaceItemAt\(\s*\n?\s*entry\.destination, withItemAt: entry\.temporary/u,
    'replaceItemAt is the atomic primitive; remove-then-move is not a swap');
  assert.doesNotMatch(swap, /removeItem\(at: entry\.destination\)[\s\S]{0,120}moveItem\(at: entry\.temporary/u,
    'the remove-then-move window is back');
  // The displaced file is kept beside its destination so a failure on a LATER
  // file can put this one back.
  assert.match(swap, /backupItemName: backupName/u);
  assert.match(swap, /\.withoutDeletingBackupItem/u);
  assert.match(swap, /undoSwapped\(\)/u, 'a failure must restore what has already been swapped');
  assert.match(swap, /dropBackups\(\)/u, 'and a success must not leave .previous files lying around');
  // The undo never deletes the backup without putting it back: at that point it
  // is the owner's only copy of the export this pick displaced.
  const undo = /let undoSwapped = \{([\s\S]*?)\n {4}\}/u.exec(swap)?.[1];
  assert.ok(undo, 'undoSwapped was not found');
  assert.doesNotMatch(undo, /removeItem\(at: backup\)/u);
  assert.match(undo, /moveItem\(at: backup, to: entry\.destination\)/u,
    'the fallback path puts the backup back by hand');
});

test('the atomicity the comment claims is the atomicity the code has', () => {
  const doc = /\/\/\/ Check every picked file[\s\S]*?\n  private func acceptLinkedInFiles/u.exec(bridge)?.[0];
  assert.ok(doc, 'the acceptLinkedInFiles doc comment was not found');
  assert.match(doc, /succeeds whole or it changes nothing on disk/u);
  // The claim now names the mechanism, so the next reader can check it in one
  // step rather than believing a sentence.
  assert.match(doc, /replaceItemAt/u);
  assert.match(doc, /previous/u, 'and says what happens to the file it displaced');
  assert.doesNotMatch(doc, /renamed\s*\n?\s*\/\/\/ only once/u);
});

test('the reader is started, with its config, on the main queue', () => {
  // THREE FAILURES IN ONE LINE, and the old one had all three.
  //
  // Connectors.start() alone is a no-op when ~/.hazlie/connectors/config.json
  // is absent, and screen 2's "skip" never writes it — so on the skip path
  // this import copied a file, said "N connections" and scheduled nothing.
  // startReadingSources() is the same path startSources takes, config and all.
  //
  // And it is main-thread-assumed: no lock, mutable isRunning/lastStart/
  // process, and its own retry and termination handling re-dispatched onto
  // .main. acceptLinkedInFiles runs on a background queue, so it hops.
  assert.match(accept, /DispatchQueue\.main\.async \{ \[weak self\] in self\?\.startReadingSources\(\) \}/u);
  assert.doesNotMatch(accept, /(?<!\.)\bConnectors\.shared\.start\(\)/u,
    'the bare start() is what skipped the config write');
  const starter = /private func startReadingSources\(\) -> Bool \{([\s\S]*?)\n {2}\}/u.exec(bridge)?.[1];
  assert.ok(starter, 'startReadingSources() not found');
  assert.match(starter, /dispatchPrecondition\(condition: \.onQueue\(\.main\)\)/u);
  for (const step of ['writeConnectorsConfigIfMissing\\(\\)', 'retireConnectorsAgent\\(\\)',
                      'Connectors\\.shared\\.start\\(\\)', 'Distiller\\.shared\\.start\\(\\)']) {
    assert.match(starter, new RegExp(step, 'u'), `startSources does ${step} and so must this`);
  }
  // And the verb the page calls goes through the same function, so the two
  // cannot drift apart again.
  assert.match(bridge, /case "startSources":\s*\n\s*reply\(webView, id, \["state": startReadingSources\(\) \? "ok" : "error"\]\)/u);
});

test('a second run is told what is already on disk, as counts', () => {
  // P12: a machine that imported last month met screen 4 saying only "choose
  // the file", with next disabled — the flow asking again for something it
  // already had, and the only way forward being to hand over the same file
  // twice.
  const state = /private func linkedInState\(\) -> \[String: Any\] \{([\s\S]*?)\n {2}\}/u
    .exec(bridge)?.[1];
  assert.ok(state, 'linkedInState() not found');
  // It is the same check the import runs, so a file the parser cannot read is
  // not reported as an export that is already here.
  assert.match(state, /Bridge\.linkedInKind\(of: head\)/u);
  assert.match(state, /"present": false/u, 'and says so when there is nothing');
  assert.match(state, /"connections": Bridge\.countRows/u);
  assert.match(state, /"modifiedTs"/u, 'when it landed');
  // COUNTS ONLY. No row content crosses the bridge from this file.
  assert.doesNotMatch(state, /firstColumn|head\b.*return|"rows":/u);
});

// ONE COLUMN IS NOT A FILE IDENTITY.
//
// The LinkedIn export zip holds three files with an exact `First Name` column:
// Connections.csv, Profile.csv and Contacts.csv. A substring check for "First
// Name" anywhere in the first 4 KB passes all three — so picking Profile.csv
// (the obvious mistake: it is alphabetically adjacent and its name sounds like
// the right one) passed the check, was COPIED OVER Connections.csv, and
// ingested as connections with no `URL` and no `Connected On`: every row gets
// the export's fallback timestamp and a hashed slug instead of a real profile.
// A good export is destroyed and the screen says "imported".
//
// So the check is the parser's own rule (csv.mjs: a header FIELD whose trim()
// equals the anchor, not a substring of the file) PLUS a second column that
// only the file we want has. Connections.csv carries `Connected On` and `URL`;
// Profile.csv carries neither; Contacts.csv carries `Profile URL`, which is a
// different field and must not be mistaken for `URL`.
//
// The three fixtures below are real export headers. The rule is READ OUT OF
// Bridge.swift and applied to them through csv.mjs's own parser, so a rule that
// would accept the wrong file fails here rather than on somebody's machine.
import { parseCsv } from '../../connectors/lib/csv.mjs';

const KINDS = [...(/linkedInKinds: \[\(anchor: String, require: \[String\], name: String\)\] = \[([\s\S]*?)\n {2}\]/u
  .exec(bridge)?.[1] ?? '')
  .matchAll(/\(\s*"([^"]+)",\s*\[([^\]]*)\],\s*"([^"]+)"\s*\)/gu)]
  .map((m) => ({
    anchor: m[1],
    require: [...m[2].matchAll(/"([^"]+)"/gu)].map((r) => r[1]),
    name: m[3],
  }));

// The rule, as the Swift is required to implement it: the first row whose
// trimmed FIELDS contain the anchor exactly and at least one required column.
function classify(text) {
  for (const row of parseCsv(text)) {
    const fields = new Set(row.map((f) => f.trim().replace(/^﻿/u, '')));
    for (const kind of KINDS) {
      if (!fields.has(kind.anchor)) continue;
      if (kind.require.length === 0 || kind.require.some((c) => fields.has(c))) return kind.name;
    }
  }
  return null;
}

const fixture = (name) =>
  readFileSync(join(ROOT, 'widget', 'test', 'fixtures', 'linkedin', name), 'utf8');

test('the anchor table names a second, discriminating column', () => {
  assert.ok(KINDS.length > 0, 'linkedInKinds is not in the (anchor, require, name) shape');
  const connections = KINDS.find((k) => k.name === 'Connections.csv');
  assert.ok(connections, 'Connections.csv is not in the table');
  assert.equal(connections.anchor, 'First Name');
  assert.deepEqual(connections.require, ['Connected On', 'URL'],
    'the two columns linkedinRows.mjs actually reads: the dormancy clock and the profile slug');
});

test('Connections.csv is accepted, Profile.csv and Contacts.csv are not', () => {
  assert.equal(classify(fixture('Connections.csv')), 'Connections.csv',
    'the real export, preamble and all, must still pass');
  assert.equal(classify(fixture('Profile.csv')), null,
    'Profile.csv has an exact First Name column and would overwrite the good export');
  assert.equal(classify(fixture('Contacts.csv')), null,
    '"Profile URL" is not "URL" — an exact field match is what tells them apart');
});

test('the header is matched as a field, not as a substring of the file', () => {
  // `head.contains("First Name")` also accepts a column called
  // "First Name (Legal)", which passes the check and then throws inside
  // csvObjects. The parser compares f.trim() === anchor; so does this.
  assert.doesNotMatch(accept, /head\.contains\(\$0\.anchor\)/u,
    'a substring of the first 4 KB is not a column');
  const kindOf = /private static func linkedInKind\(of head: String\)[\s\S]*?\n {2}\}/u.exec(bridge)?.[0];
  assert.ok(kindOf, 'linkedInKind(of:) not found — the exact-field rule has to live somewhere');
  // The trim moved into csvFields(), which countRows() now shares. Follow it
  // there rather than dropping the assertion: BOM and whitespace handling is
  // what makes "the same rule" the same rule.
  assert.match(kindOf, /csvFields\(row\)/u);
  const fieldsOf = /private static func csvFields\(_ row: \[String\]\) -> Set<String> \{[\s\S]*?\n {2}\}/u
    .exec(bridge)?.[0];
  assert.ok(fieldsOf, 'csvFields() not found');
  assert.match(fieldsOf, /trimmingCharacters\(in: csvFieldTrim\)/u,
    'fields are trimmed the way csv.mjs trims them, BOM included');
  assert.match(kindOf, /require/u, 'and the second column is required');
  // A column named "First Name (Legal)" must not satisfy it.
  assert.equal(classify('First Name (Legal),Last Name,URL\nA,B,C\n'), null);
});


// THE COUNT DOES NOT COLLECT THE FILE IT COUNTS (review finding 11).
//
// Sharing the header rule with the classifier was right; sharing it by running
// csvRows over the whole file was not. csvRows' doc comment still said "the
// text handed in is a bounded head" while countRows handed it an 8-10 MB
// export — a per-Character Swift walk collecting ~400k live Strings on a
// background queue while the import button spins. The header is found on the
// same 4 KB head the CLASSIFIER uses, and the body is walked a row at a time.
test('the header comes from the head and the body is streamed, not collected', () => {
  assert.ok(COUNT_ROWS, 'countRows() not found');
  assert.match(COUNT_ROWS, /readHead\(of: url, bytes: 4096\)/u,
    'the header rule runs on the same bounded head the classifier refuses files from');
  assert.match(COUNT_ROWS, /csvRows\(head\)\.firstIndex\(where: \{ csvFields\(\$0\)\.contains\(anchor\) \}\)/u,
    'and it is still the exact-field rule, not a substring');
  assert.doesNotMatch(COUNT_ROWS, /let rows = csvRows\(text\)/u,
    'the whole export is collected into an array again');

  // The walk itself is now a stream with two consumers, and only one of them
  // keeps anything. csvRows is the collecting one and must stay off this path.
  const scan = /private static func csvScan\(_ text: String, _ onRow: \(\[String\]\) -> Void\) \{([\s\S]*?)\n {2}\}/u
    .exec(bridge)?.[1];
  assert.ok(scan, 'csvScan() not found — the walk has to exist exactly once');
  assert.match(scan, /onRow\(row\)/u, 'rows are handed over as they are parsed');
  assert.doesNotMatch(scan, /rows\.append/u, 'the walk itself may not accumulate');
  const collect = /private static func csvRows\(_ text: String\) -> \[\[String\]\] \{([\s\S]*?)\n {2}\}/u
    .exec(bridge)?.[1];
  assert.ok(collect, 'csvRows() not found');
  assert.match(collect, /csvScan\(text\)/u, 'ONE walk: csvRows is a consumer of it, not a second copy');

  // And the classifier still reads the same 4 KB, so a file whose header does
  // not fit in the head never reaches the count in the first place.
  assert.match(accept, /readHead\(of: url, bytes: 4096\)/u);
});

test('the head-scoped header lands on the same row the whole file does', () => {
  // The head is a prefix and rows are ordered, so the header's index in the
  // head is its index in the file — including past a "Notes:" preamble, which
  // is the case that makes the claim worth checking rather than assuming.
  for (const name of ['Connections.csv', 'Connections-preamble.csv']) {
    const text = fixture(name);
    const rowsOfHead = parseCsv(text.slice(0, 4096));
    const rowsOfAll = parseCsv(text);
    const rule = (row) => row.some((f) => f.trim().replace(/^\uFEFF/u, '') === 'First Name');
    const inHead = rowsOfHead.findIndex(rule);
    assert.ok(inHead > -1, `${name}: the header does not fit in the head`);
    assert.equal(inHead, rowsOfAll.findIndex(rule), `${name}: the two indexes disagree`);
    assert.equal(countFrom(text, 'First Name'),
      rowsOfAll.slice(inHead + 1).filter((r) => r.some((f) => f.trim() !== '')).length);
  }
});

// TWO PICKS OF ONE KIND ARE ONE DESTINATION (review finding 1).
//
// `Connections.csv` and `Connections (1).csv` — the export and the browser's
// second download of it — both classify as Connections.csv. Nothing deduped
// them, so both were staged to the same `.importing` path and swapped into the
// same destination: the second turn round the swap loop removed the backup the
// first had just made, its replace threw on a temporary already consumed, and
// the undo had nothing left to put back. The owner's export was gone and
// linkedin.mjs reported it missing — the exact outcome the undo path was added
// to prevent, in the exact case it was added for.
const DUP = /"reason": "duplicate"[\s\S]{0,300}?"files": \[([^\]]*)\]/u.exec(accept);

test('a second file of a kind already picked is refused, by name', () => {
  assert.ok(DUP, 'nothing refuses two picks of the same kind');
  // BOTH names: the remedy is choosing between them, and the app cannot.
  assert.match(DUP[1], /clash\.url\.lastPathComponent/u, 'the file already accepted');
  assert.match(DUP[1], /url\.lastPathComponent/u, 'and the one that clashed with it');

  // In PASS ONE, before anything is written — same rule as every other refusal.
  const passOne = accept.indexOf('// PASS ONE');
  const passTwo = accept.indexOf('// PASS TWO');
  const at = accept.indexOf('"reason": "duplicate"');
  assert.ok(at > passOne && at < passTwo, 'a duplicate must be refused before anything is staged');
  assert.match(accept, /accepted\.first\(where: \{ \$0\.kind\.name == kind\.name \}\)/u,
    'deduped by KIND, which is what shares a destination — not by file name');

  // And the screen can say it: a refusal the page renders as "i couldn't read
  // that file" would send the owner back to the columns.
  const page = readFileSync(join(ROOT, 'widget', 'ui', 'onboarding.js'), 'utf8');
  assert.match(page, /out\.reason === 'duplicate'/u);
  assert.match(page, /out\.files/u, 'and names both files, as the bridge sends them');
});

/// Whether the import dedupes by kind at all, and on which field — READ OUT OF
/// the Swift rather than assumed, so the model below refuses only what the code
/// refuses. Without this the pair of fixtures would pass against an import that
/// has no dedupe in it, which is what the pair is here to rule out.
const DEDUPE = /accepted\.first\(where: \{ \$0\.kind\.(\w+) == kind\.(\w+) \}\)/u.exec(accept);

/// PASS ONE as the Swift is required to implement it: classify every file, and
/// refuse the second of any kind rather than letting two picks share one
/// destination.
function acceptPass(files) {
  const accepted = [];
  for (const file of files) {
    const kind = classify(file.text);
    if (!kind) return { refused: 'columns', file: file.name };
    const clash = DEDUPE ? accepted.find((a) => a.kind === kind) : null;
    if (clash) return { refused: 'duplicate', file: kind, files: [clash.name, file.name] };
    accepted.push({ name: file.name, kind });
  }
  return { accepted };
}

const pick = (name, as = name) => ({ name: as, text: fixture(name) });

test('two files of the same kind are refused; N different kinds are not', () => {
  assert.ok(DEDUPE, 'the import does not dedupe picks by kind at all');
  assert.deepEqual([DEDUPE[1], DEDUPE[2]], ['name', 'name'],
    'the destination is named by kind.name, so that is what two picks collide on');
  // The real multi-select: the export and the browser's second download of it.
  // Different names, one kind, one destination.
  const both = acceptPass([pick('Connections.csv'), pick('Connections-preamble.csv', 'Connections (1).csv')]);
  assert.equal(both.refused, 'duplicate');
  assert.equal(both.file, 'Connections.csv');
  assert.deepEqual(both.files, ['Connections.csv', 'Connections (1).csv'],
    'both names, because choosing between them is the owner\'s to do');

  // The order does not decide it either: neither pick is the default.
  const swapped = acceptPass([pick('Connections-preamble.csv', 'Connections (1).csv'), pick('Connections.csv')]);
  assert.equal(swapped.refused, 'duplicate');

  // ...and the pick this whole two-pass shape exists for still goes through
  // whole: two files, two kinds, two destinations.
  const pair = acceptPass([pick('Connections.csv'), pick('messages.csv')]);
  assert.ok(!pair.refused, `a legitimate multi-select was refused: ${pair.refused}`);
  assert.deepEqual(pair.accepted.map((a) => a.kind), ['Connections.csv', 'messages.csv']);
});

// THE READER HAS TO SEE A NEW FILE (review finding 6).
//
// linkedin.mjs skips its whole scan when `newestMtime <= stored`, and both
// ways of putting a file at the destination can hand it an mtime that is not
// newer. replaceItemAt's DEFAULT is to carry the DISPLACED item's metadata
// onto the replacement — and the displaced item is the previous export, whose
// mtime is precisely the stored cursor. The import would land, the screen
// would report its count, and the connector would log `unchangedSinceMtime:
// true` forever.
test('the swapped-in export looks new to the connector that reads it', () => {
  const swap = accept.slice(accept.indexOf('var copied: [String] = []'));
  assert.match(swap, /options: \[\.withoutDeletingBackupItem, \.usingNewMetadataOnly\]/u,
    'without this the new export inherits the old one\'s modification date');
  assert.match(swap, /dates\.contentModificationDate = Date\(\)/u,
    'and a re-picked export carries its own unchanged date, which is the same skip');
  // The gate this is answering, read from the connector rather than written
  // down twice.
  const linkedin = readFileSync(join(ROOT, 'connectors', 'sources', 'linkedin.mjs'), 'utf8');
  assert.match(linkedin, /newestMtime <= stored/u,
    'if the connector stops gating on mtime this stamping needs revisiting');

  // The undo restores the backup as ITSELF. Default options there would put
  // the metadata of the file being replaced — the one this pick just stamped —
  // onto the export being put back.
  const undo = /let undoSwapped = \{([\s\S]*?)\n {4}\}/u.exec(swap)?.[1];
  assert.ok(undo, 'undoSwapped was not found');
  assert.match(undo, /options: \[\.usingNewMetadataOnly\]/u);
});

test('stamping the landing time does not make the export look newer than it is', () => {
  // The refusal in PASS ONE asks how old the INSTALLED export is, and the
  // modification date has just stopped being that answer. Replaying onboarding
  // and handing back the same file in Downloads would otherwise come out as
  // "you already have a newer Connections.csv".
  assert.match(accept, /if let existing = Bridge\.installedVintage\(of: destination\)/u,
    'the newer-check still reads the landing time');
  const vintage = /private static func installedVintage\(of url: URL\) -> Date\? \{([\s\S]*?)\n {2}\}/u
    .exec(bridge)?.[1];
  assert.ok(vintage, 'installedVintage() not found');
  assert.match(vintage, /\.contentModificationDateKey, \.creationDateKey/u);
  assert.match(vintage, /\.min\(\)/u,
    'the earlier of the two is the vintage for a stamped file AND a hand-placed one');
  // ...which requires the swap to put the export's own date somewhere.
  const swap = accept.slice(accept.indexOf('var copied: [String] = []'));
  assert.match(swap, /dates\.creationDate = vintage/u);
  assert.match(accept, /let vintage = try\? entry\.url\.resourceValues/u,
    'read from the PICKED file, which is the only thing that knows the export\'s date');
});
