// "REQUEST NOW, IMPORT LATER" — the mail half.
//
// The LinkedIn export is the one source the owner has to go and fetch: ask for
// it, wait hours, then come back for a mail with a download in it. Nothing was
// watching for that mail, so the archive sat unread in an inbox while the setup
// screen went on saying the export was missing.
//
// What is pinned here is the whole chain and nothing outside it: which mail
// counts, which LinkedIn mail deliberately does not, that a real forward pass
// leaves the marker, that the marker holds one number, when it must NOT be
// written, when it stops being worth saying, that importing the export removes
// it, and that connect's tile relays the timestamp.
//
// Every fixture synthetic; the repo is public.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMailSource, linkedinExportReadyNote } from '../sources/mail.mjs';
import { createLinkedinSource } from '../sources/linkedin.mjs';
import {
  EXPORT_READY_MAX_AGE_MS, connectionsPath, exportReadyAt, markerPath, readExportReady,
} from '../lib/linkedinExport.mjs';
import { LINKEDIN_EXPORT_ID, readStatus } from '../../connect/lib/status.mjs';

const TOKEN = 'ab'.repeat(32); // 64 hex chars, deliberately not a real secret
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 13);
const READY_TS = NOW - 3_600_000;

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'hz-export-ready-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function memoryState(seed = {}) {
  const values = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  return {
    getCursor: (key) => values.get(key) ?? null,
    setCursor: (key, value) => values.set(key, String(value)),
    deleteCursor: (key) => values.delete(key),
  };
}

const parsedMail = (from, subject) => ({
  from, subject, to: 'owner@example.test', date: new Date(READY_TS), text: 'body',
});

// One mailbox, one page, whatever messages the test names.
function inbox(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    listMessages: async ({ q }) => {
      const after = /after:(-?\d+)/u.exec(q);
      const before = /before:(-?\d+)/u.exec(q);
      const lo = after ? Number(after[1]) * 1000 : Number.NEGATIVE_INFINITY;
      const hi = before ? Number(before[1]) * 1000 : Number.POSITIVE_INFINITY;
      return {
        messages: messages
          .filter((m) => Number(m.internalDate) >= lo && Number(m.internalDate) <= hi)
          .map((m) => ({ id: m.id })),
      };
    },
    getMessage: async (id) => byId.get(id),
  };
}

const gmailMessage = (id, ts, { from, subject, body = 'a body with a https://linkedin.example/dl link in it' }) => ({
  id,
  internalDate: String(ts),
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'Message-ID', value: `<${id}@example.test>` },
      { name: 'From', value: from },
      { name: 'To', value: 'owner@example.test' },
      { name: 'Subject', value: subject },
    ],
    body: { data: Buffer.from(body).toString('base64url') },
  },
});

const ready = (id, ts) => gmailMessage(id, ts, {
  from: 'LinkedIn <noreply@linkedin.com>', subject: 'Your LinkedIn data is ready',
});
const chatter = (id, ts) => gmailMessage(id, ts, { from: 'friend@example.test', subject: 'lunch?' });

async function runMail(home, messages, { at = NOW, state = memoryState(), log = { info() {}, warn() {} } } = {}) {
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => inbox(messages),
    sleep: async () => {},
  });
  await source.run({
    state,
    config: {},
    home,
    now: () => at,
    ingest: async (rows) => ({ inserted: rows.length, updated: 0, unchanged: 0 }),
    log,
  });
  return state;
}

// --- WHICH MAIL COUNTS -----------------------------------------------------
//
// The sender is the tight half. The subject cannot be tight — LinkedIn writes
// it several ways and has changed it before — so what separates its own mail
// from its marketing is the ORDER of the words rather than the words.

test('both wordings LinkedIn actually uses are recognised, and the note is one number', () => {
  for (const subject of ['Your LinkedIn data is ready', 'Your download is ready']) {
    const note = linkedinExportReadyNote(parsedMail('LinkedIn <noreply@linkedin.com>', subject), READY_TS);
    assert.ok(note, `"${subject}" is LinkedIn telling the owner their archive is downloadable`);
    assert.equal(note.at, READY_TS);
    assert.deepEqual(Object.keys(note), ['at'],
      'a timestamp, and nothing else: no subject, no body, no link, no sender');
  }
  // Notification traffic moves between subdomains, and all of it is LinkedIn.
  assert.ok(linkedinExportReadyNote(
    parsedMail('messages-noreply@e.linkedin.com', 'Your LinkedIn data is ready for download'), READY_TS
  ));
});

test('LinkedIn marketing is not LinkedIn saying your export is ready', () => {
  // THE FAILING INPUT THIS RULE WAS REWRITTEN FOR. Every word the first version
  // asked for is in this subject — ready, download — and it is sent from the
  // same subdomain the notifications come from. A false positive here is not a
  // badge the owner shrugs off: nothing clears the marker but importing an
  // export or waiting out a fortnight.
  assert.equal(linkedinExportReadyNote(
    parsedMail('noreply@e.linkedin.com', 'Ready to grow your network? Download the app'), READY_TS
  ), null);
  for (const subject of [
    'Your weekly data digest is ready',        // recurring mail in the right shape
    'Your insights report is ready to download',
    'Explore your data — the new download is ready',
    'Your download is being prepared',         // no availability word yet
    'Your profile is already up to date',      // "already" is not "ready"
    'You have 3 new messages',
  ]) {
    assert.equal(
      linkedinExportReadyNote(parsedMail('noreply@linkedin.com', subject), READY_TS), null,
      `"${subject}" must not badge the setup screen`
    );
  }
});

test('the sender gate is the address, exactly one of them, and the real domain', () => {
  // A domain that merely ends in the string is anybody who can register it.
  assert.equal(
    linkedinExportReadyNote(parsedMail('noreply@notlinkedin.com', 'Your LinkedIn data is ready'), READY_TS),
    null
  );
  // The display name is not the sender, and a second address does not make a
  // mail LinkedIn's: a real `From` carries one.
  assert.equal(linkedinExportReadyNote(
    parsedMail('"LinkedIn noreply@linkedin.com" <x@attacker.test>', 'Your LinkedIn data is ready'), READY_TS
  ), null);
  assert.equal(linkedinExportReadyNote(
    parsedMail('<a@attacker.test>, <b@linkedin.com>', 'Your LinkedIn data is ready'), READY_TS
  ), null);
  assert.equal(linkedinExportReadyNote(
    parsedMail('<b@linkedin.com>, <a@attacker.test>', 'Your LinkedIn data is ready'), READY_TS
  ), null, 'nor in the other order: the first address is not a vote');
  assert.equal(
    linkedinExportReadyNote(parsedMail('friend@example.test', 'Your data is ready'), READY_TS), null
  );
});

// --- A REAL PASS -----------------------------------------------------------

test('a mail that arrives while the reader is running leaves the marker, and the log says counts only', async (t) => {
  const home = tempHome(t);
  const events = [];
  const log = { info: (event, fields) => events.push({ event, fields }), warn() {} };

  // Pass one: an ordinary inbox. This is the install.
  const state = await runMail(home, [chatter('m0', NOW - DAY)], { at: NOW, log });
  assert.equal(exportReadyAt(home), null);

  // The owner asks LinkedIn for their data, and an hour later it answers.
  const arrived = NOW + 3_600_000;
  await runMail(home, [chatter('m0', NOW - DAY), ready('m1', arrived)],
    { at: arrived + 3_600_000, state, log });

  const marker = readExportReady(home, { now: () => arrived + 3_600_000 });
  assert.ok(marker, 'the mail connector noticed and left the note');
  assert.equal(marker.at, arrived, "the mail's own timestamp, which is what the screen dates it by");

  // THE FILE HOLDS ONE NUMBER. The body of that mail carries a download link
  // and the subject is a string an outsider chose; no surface reads either, so
  // neither is kept.
  const raw = JSON.parse(readFileSync(markerPath(home), 'utf8'));
  assert.deepEqual(Object.keys(raw), ['at']);
  assert.equal(JSON.stringify(raw).includes('linkedin.example'), false, 'no link, no body');
  assert.equal(statSync(markerPath(home)).mode & 0o777, 0o600, 'owner-only, like every small file here');

  const line = events.find((e) => e.event === 'mail_linkedin_export_ready');
  assert.ok(line, 'a pass that noticed says so');
  assert.equal(line.fields.seen, 1);
  assert.equal(line.fields.noted, 1);
  assert.doesNotMatch(JSON.stringify(line), /data is ready|owner@example\.test|noreply@/u,
    'counts only: a log line quoting a subject is a second corpus');
});

test('no such mail, no marker', async (t) => {
  const home = tempHome(t);
  await runMail(home, [chatter('m0', NOW - 60_000)]);
  assert.equal(exportReadyAt(home), null);
  assert.equal(existsSync(markerPath(home)), false);
});

// --- RECENCY ---------------------------------------------------------------
//
// LinkedIn's download expires in days. A sentence that sends the owner back to
// a mail has to be about a mail whose link can still be followed.

test('a first pass reads a month back and badges none of it', async (t) => {
  const home = tempHome(t);
  // The failing install: a Mac whose inbox already holds "your data is ready"
  // from before Hazlie existed. The first forward window covers 30 days, so the
  // reader does see it — and an export requested before this install is one the
  // owner already dealt with, or one whose link is dead.
  await runMail(home, [ready('m1', NOW - 28 * DAY), ready('m2', NOW - 3 * DAY)]);
  assert.equal(exportReadyAt(home), null,
    'nothing from before the first pass is news, however recent');
  assert.equal(existsSync(markerPath(home)), false);
});

test('a mail two days old is still not news when the install is one day old', async (t) => {
  const home = tempHome(t);
  // INSIDE THE AGE BOUND AND STILL NOT OURS. The fortnight is the outer bound;
  // the anchor is the real one. A "your data is ready" from the day before this
  // Mac started reading is about an export the owner requested before Hazlie
  // existed — dealt with already, or dead.
  const state = memoryState({ 'mail:first-pass-at': NOW - DAY });
  await runMail(home, [ready('m1', NOW - 2 * DAY)], { state });
  assert.equal(existsSync(markerPath(home)), false, 'nothing from before the anchor is news');
  assert.equal(exportReadyAt(home, { now: () => NOW }), null);

  // And the same mailbox one mail later, this one genuinely new.
  await runMail(home, [ready('m1', NOW - 2 * DAY), ready('m2', NOW - 3_600_000)], { state });
  assert.equal(exportReadyAt(home, { now: () => NOW }), NOW - 3_600_000);
});

test('a marker this install would not have written is retired by the next pass', async (t) => {
  const home = tempHome(t);
  // The state a build without a floor left behind, or a purge left standing:
  // a marker inside the fortnight, about a mail older than this install. The
  // reader already declines to answer once it ages out — but until then the
  // file is believed, so the writer that owns it has to take it back.
  mkdirSync(join(home, '.hazlie', 'imports', 'linkedin'), { recursive: true });
  writeFileSync(markerPath(home), JSON.stringify({ at: NOW - 7 * DAY }));
  const state = memoryState({ 'mail:first-pass-at': NOW - DAY });

  await runMail(home, [chatter('m0', NOW - 60_000)], { state });
  assert.equal(existsSync(markerPath(home)), false,
    'a pass that would not write it does not leave it standing either');
  assert.equal(exportReadyAt(home, { now: () => NOW }), null);
});

test('an unparseable marker is taken back rather than left to be believed later', async (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, '.hazlie', 'imports', 'linkedin'), { recursive: true });
  writeFileSync(markerPath(home), 'not json at all');
  await runMail(home, [chatter('m0', NOW - 60_000)], { state: memoryState() });
  assert.equal(existsSync(markerPath(home)), false);
});

test('a marker still inside both bounds is left exactly where it is', async (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, '.hazlie', 'imports', 'linkedin'), { recursive: true });
  const at = NOW - 2 * 3_600_000;
  writeFileSync(markerPath(home), JSON.stringify({ at }));
  const state = memoryState({ 'mail:first-pass-at': NOW - DAY });

  await runMail(home, [chatter('m0', NOW - 60_000)], { state });
  assert.equal(exportReadyAt(home, { now: () => NOW }), at,
    'the sweep retires what this install would not have written, and nothing else');
});

test('a mail older than the age bound is never recorded, even on a long-running install', async (t) => {
  const home = tempHome(t);
  // An install that has been reading for two months, so the first-pass floor is
  // long past and the age bound is the only thing left holding the line.
  const state = memoryState({ 'mail:first-pass-at': NOW - 60 * DAY });
  await runMail(home, [ready('m1', NOW - 20 * DAY)], { state });
  assert.equal(exportReadyAt(home), null, 'twenty days is past any download LinkedIn still honours');

  await runMail(home, [ready('m1', NOW - 20 * DAY), ready('m2', NOW - 2 * DAY)], { state });
  assert.equal(exportReadyAt(home, { now: () => NOW }), NOW - 2 * DAY, 'and two days is not');
});

test('the marker goes quiet on its own once the link it points at is dead', (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, '.hazlie', 'imports', 'linkedin'), { recursive: true });
  writeFileSync(markerPath(home), JSON.stringify({ at: NOW }));

  assert.equal(exportReadyAt(home, { now: () => NOW + DAY }), NOW, 'the day after, it still stands');
  assert.equal(exportReadyAt(home, { now: () => NOW + EXPORT_READY_MAX_AGE_MS + DAY }), null,
    'a fortnight later it says nothing: the read gate is what retires a marker nobody rewrites');
});

// --- THE END OF THE NUDGE --------------------------------------------------

test('the nudge is not written once the export is in place', async (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, '.hazlie', 'imports', 'linkedin'), { recursive: true });
  writeFileSync(connectionsPath(home), 'First Name,Last Name\n');

  const state = memoryState({ 'mail:first-pass-at': NOW - 60 * DAY });
  await runMail(home, [ready('m1', NOW - 3_600_000)], { state });

  assert.equal(existsSync(markerPath(home)), false,
    'the owner has already done the thing the nudge asks for');
  assert.equal(exportReadyAt(home), null);
});

test('importing the export removes a marker left behind', async (t) => {
  const home = tempHome(t);
  const state = memoryState({ 'mail:first-pass-at': NOW - 60 * DAY });
  await runMail(home, [ready('m1', NOW - 3_600_000)], { state });
  assert.equal(exportReadyAt(home, { now: () => NOW }), NOW - 3_600_000);

  // The owner opens the mail, downloads the archive, drops the file. The
  // linkedin connector's next pass is what sees it.
  writeFileSync(connectionsPath(home), 'First Name,Last Name\n');
  const linkedin = createLinkedinSource({ home });
  assert.deepEqual(linkedin.needs(), [], 'the export is in place, so the connector runs');
  await linkedin.run({ state: memoryState(), home, log: { info() {}, warn() {} }, ingest: async () => ({}) });

  assert.equal(existsSync(markerPath(home)), false, 'the note is spent and it is deleted');
  assert.equal(exportReadyAt(home), null);
});

// --- THE SURFACE -----------------------------------------------------------

test("connect's LinkedIn tile carries the timestamp, and only while it is worth saying", (t) => {
  const home = tempHome(t);
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(secrets, 'hermes-token.txt'), `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(join(secrets, 'hermes-token.txt'), 0o600);

  const find = () => readStatus({ home }).find((row) => row.id === LINKEDIN_EXPORT_ID);
  assert.equal(find().linkedinExportReady, null, 'nothing has said the export is ready');

  // The tile reads the real clock, so these markers are dated against it.
  const fresh = Date.now() - DAY;
  mkdirSync(join(home, '.hazlie', 'imports', 'linkedin'), { recursive: true });
  writeFileSync(markerPath(home), JSON.stringify({ at: fresh }));
  const waiting = find();
  assert.equal(waiting.linkedinExportReady, fresh,
    'the tile can now say "your export is ready — open the email" instead of repeating itself');
  assert.equal(waiting.connected, false, 'ready to fetch is not imported');

  writeFileSync(markerPath(home), JSON.stringify({ at: Date.now() - EXPORT_READY_MAX_AGE_MS - DAY }));
  assert.equal(find().linkedinExportReady, null,
    'and it stops pointing at a download that has expired');

  writeFileSync(markerPath(home), JSON.stringify({ at: fresh }));
  writeFileSync(connectionsPath(home), 'First Name,Last Name\n');
  const imported = find();
  assert.equal(imported.connected, true);
  assert.equal(imported.linkedinExportReady, null,
    'a marker that outlived its answer must not badge an imported export');
});
