// "REQUEST NOW, IMPORT LATER" — the mail half.
//
// The LinkedIn export is the one source the owner has to go and fetch: ask for
// it, wait hours, then come back for a mail with a download in it. Nothing was
// watching for that mail, so the archive sat unread in an inbox while the setup
// screen went on saying the export was missing.
//
// What is pinned here is the whole chain and nothing outside it: which mail
// counts, that a real forward pass leaves the marker, what the marker is
// allowed to hold, when it must NOT be written, that importing the export
// removes it, and that connect's tile relays the timestamp.
//
// Every fixture synthetic; the repo is public.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMailSource, linkedinExportReadyNote } from '../sources/mail.mjs';
import { createLinkedinSource } from '../sources/linkedin.mjs';
import { connectionsPath, exportReadyAt, markerPath, readExportReady } from '../lib/linkedinExport.mjs';
import { LINKEDIN_EXPORT_ID, readStatus } from '../../connect/lib/status.mjs';

const TOKEN = 'ab'.repeat(32); // 64 hex chars, deliberately not a real secret
const NOW = Date.UTC(2026, 8, 13);
const READY_TS = NOW - 3_600_000;

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'hz-export-ready-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function memoryState() {
  const values = new Map();
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

async function runMail(home, messages, { log = { info() {}, warn() {} } } = {}) {
  const source = createMailSource({
    accountsForScope: () => [{ email: 'owner@example.test' }],
    makeClient: () => inbox(messages),
    sleep: async () => {},
  });
  const ingested = [];
  await source.run({
    state: memoryState(),
    config: {},
    home,
    now: () => NOW,
    ingest: async (rows) => { ingested.push(...rows); return { inserted: rows.length, updated: 0, unchanged: 0 }; },
    log,
  });
  return ingested;
}

// --- WHICH MAIL COUNTS -----------------------------------------------------
//
// The sender is the tight half and the subject is the half that cannot be:
// LinkedIn writes it several ways and has changed it before.

test('both wordings LinkedIn actually uses are recognised, and the note carries the subject only', () => {
  for (const subject of ['Your LinkedIn data is ready', 'Your download is ready']) {
    const note = linkedinExportReadyNote(parsedMail('LinkedIn <noreply@linkedin.com>', subject), READY_TS);
    assert.ok(note, `"${subject}" is LinkedIn telling the owner their archive is downloadable`);
    assert.equal(note.at, READY_TS);
    assert.equal(note.subject, subject);
    assert.deepEqual(Object.keys(note).sort(), ['at', 'subject'],
      'the note is a timestamp and a subject line: no body, no link, no sender');
  }
  // Notification traffic moves between subdomains, and all of it is LinkedIn.
  assert.ok(linkedinExportReadyNote(
    parsedMail('messages-noreply@e.linkedin.com', 'Your LinkedIn data is ready for download'), READY_TS
  ));
});

test('a domain that merely ends in the string is not LinkedIn', () => {
  // The anchored subdomain test is the whole difference between "LinkedIn said
  // so" and "anybody who can register notlinkedin.com said so".
  assert.equal(
    linkedinExportReadyNote(parsedMail('noreply@notlinkedin.com', 'Your LinkedIn data is ready'), READY_TS),
    null
  );
  assert.equal(
    linkedinExportReadyNote(parsedMail('friend@example.test', 'Your data is ready'), READY_TS),
    null
  );
});

test('LinkedIn mail that is not about the export is left alone', () => {
  for (const subject of [
    'You have 3 new messages',
    'Your download is being prepared',   // no availability word yet
    'Your profile is already up to date', // "already" is not "ready"
    'Ready for your next role?',          // no data, no download
  ]) {
    assert.equal(
      linkedinExportReadyNote(parsedMail('noreply@linkedin.com', subject), READY_TS), null,
      `"${subject}" must not badge the setup screen`
    );
  }
});

// --- A REAL PASS -----------------------------------------------------------

test('a forward pass over the mail leaves the marker, and the log says counts only', async (t) => {
  const home = tempHome(t);
  const events = [];
  await runMail(home, [
    gmailMessage('m0', NOW - 60_000, { from: 'friend@example.test', subject: 'lunch?' }),
    gmailMessage('m1', READY_TS, {
      from: 'LinkedIn <noreply@linkedin.com>', subject: 'Your LinkedIn data is ready',
    }),
  ], { log: { info: (event, fields) => events.push({ event, fields }), warn() {} } });

  const marker = readExportReady(home);
  assert.ok(marker, 'the mail connector noticed and left the note');
  assert.equal(marker.at, READY_TS, "the mail's own timestamp, which is what the screen dates it by");
  assert.equal(marker.subject, 'Your LinkedIn data is ready');

  // THE FILE HOLDS NOTHING ELSE. The body of that mail carries a download link;
  // a link copied out of a mail is a credential-shaped thing this marker has no
  // business holding, and the mail itself is in the corpus where deletion works.
  const raw = JSON.parse(readFileSync(markerPath(home), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['at', 'subject']);
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
  await runMail(home, [gmailMessage('m0', NOW - 60_000, { from: 'friend@example.test', subject: 'lunch?' })]);
  assert.equal(exportReadyAt(home), null);
  assert.equal(existsSync(markerPath(home)), false);
});

test('the nudge is not written once the export is in place', async (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, '.hazlie', 'imports', 'linkedin'), { recursive: true });
  writeFileSync(connectionsPath(home), 'First Name,Last Name\n');

  await runMail(home, [gmailMessage('m1', READY_TS, {
    from: 'noreply@linkedin.com', subject: 'Your LinkedIn data is ready',
  })]);

  assert.equal(existsSync(markerPath(home)), false,
    'the owner has already done the thing the nudge asks for');
  assert.equal(exportReadyAt(home), null);
});

test('importing the export removes a marker left behind', async (t) => {
  const home = tempHome(t);
  await runMail(home, [gmailMessage('m1', READY_TS, {
    from: 'noreply@linkedin.com', subject: 'Your LinkedIn data is ready',
  })]);
  assert.equal(exportReadyAt(home), READY_TS);

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

test("connect's LinkedIn tile carries the timestamp, and never the subject", (t) => {
  const home = tempHome(t);
  const secrets = join(home, '.hazlie', 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(secrets, 'hermes-token.txt'), `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(join(secrets, 'hermes-token.txt'), 0o600);

  const find = () => readStatus({ home }).find((row) => row.id === LINKEDIN_EXPORT_ID);
  assert.equal(find().linkedinExportReady, null, 'nothing has said the export is ready');

  mkdirSync(join(home, '.hazlie', 'imports', 'linkedin'), { recursive: true });
  writeFileSync(markerPath(home), JSON.stringify({ at: READY_TS, subject: 'Your LinkedIn data is ready' }));
  const waiting = find();
  assert.equal(waiting.linkedinExportReady, READY_TS,
    'the tile can now say "your export is ready — open the email" instead of repeating itself');
  assert.equal(waiting.connected, false, 'ready to fetch is not imported');
  assert.equal(JSON.stringify(waiting).includes('data is ready'), false,
    'the subject stays on the owner\'s own disk');

  writeFileSync(connectionsPath(home), 'First Name,Last Name\n');
  const imported = find();
  assert.equal(imported.connected, true);
  assert.equal(imported.linkedinExportReady, null,
    'a marker that outlived its answer must not badge an imported export');
});
