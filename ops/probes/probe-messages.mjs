// Probe: which chat in chat.db is the owner's Messages self-thread?
//
// Originally written for the courier's command lane, which is retired: the
// app no longer sends or listens on iMessage, and nothing here targets
// Messages.app with AppleScript any more. The probe survives because its
// answer moved to the INGEST side. connectors/lib/pinnedThread.mjs must know
// which thread is the assistant's own conversation with the owner so it can
// EXCLUDE it from the corpus — a machine that once had a pinned thread will
// otherwise ingest the assistant's old messages as the owner's words. This
// probe is how you find that thread's identifiers on a given machine.
//
// It enumerates candidate self-threads —
// single-participant chats whose sole participant handle is one of the account
// owner's OWN handles (harvested from chat.account_login and
// message.destination_caller_id, which both name identities this Mac sends and
// receives as).
//
// Prints chat guids, identifiers, participant/message counts, and ISO
// timestamps only — NEVER message text. The identifiers of a self-thread are
// the owner's own handles; that is what the probe exists to discover.
//
// chat.db is Full Disk Access territory and FDA attributes per responsible
// binary, so run via launchd:
//
//   launchctl submit -l com.hazlie.probe-messages -o <out> -e <err> \
//     -- ~/.hazlie/bin/node /path/to/ops/probes/probe-messages.mjs
//   (poll <out> for the RESULT line, then: launchctl remove com.hazlie.probe-messages)
//
// No TTY assumed. Exit: 0 PASS · 2 BLOCKED (no FDA in this launch context)
// · 1 FAIL.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
let blocks = 0;
const pass = (part, evidence) => console.log(`PASS ${part}: ${evidence}`);
const fail = (part, evidence) => { failures += 1; console.log(`FAIL ${part}: ${evidence}`); };
const block = (part, evidence) => { blocks += 1; console.log(`BLOCKED ${part}: ${evidence}`); };

// message.date on current macOS is nanoseconds since 2001-01-01 (Apple epoch);
// rows written by ancient OS versions can still carry seconds. The magnitude
// gap between the two encodings is ~9 orders, so a threshold cannot misfile.
const APPLE_EPOCH_MS = 978307200000;
function appleDateToIso(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v === 0) return '(none)';
  const ms = v > 1e12 ? v / 1e6 + APPLE_EPOCH_MS : v * 1000 + APPLE_EPOCH_MS;
  return new Date(ms).toISOString();
}


const chatDbPath = join(homedir(), 'Library', 'Messages', 'chat.db');
let db;
try {
  db = new DatabaseSync(chatDbPath, { readOnly: true });
} catch (error) {
  block(
    'self-thread discovery',
    `cannot open ${chatDbPath} read-only (${error.message}); run via launchd with ` +
      '~/.hazlie/bin/node (see header)'
  );
  console.log('RESULT probe-messages: BLOCKED');
  process.exit(2);
}

try {
  // Owner identities: account_login carries an E:/P: service prefix; the
  // destination_caller_id scan is a full pass over message but this is a
  // one-shot probe, not a loop, and completeness beats speed here.
  const own = new Set();
  for (const r of db
    .prepare('SELECT DISTINCT account_login AS v FROM chat WHERE account_login IS NOT NULL')
    .all()) {
    const id = String(r.v).replace(/^[EP]:/, '').trim().toLowerCase();
    if (id) own.add(id);
  }
  for (const r of db
    .prepare(
      'SELECT DISTINCT destination_caller_id AS v FROM message WHERE destination_caller_id IS NOT NULL'
    )
    .all()) {
    const id = String(r.v).trim().toLowerCase();
    if (id) own.add(id);
  }
  if (own.size === 0) {
    fail('self-thread discovery', '0 owner identities found in chat.account_login or message.destination_caller_id');
  } else {
    console.log(`  owner handles discovered: ${own.size} (values withheld; a candidate's identifier below names the one that matters)`);

    const singles = db
      .prepare(
        `SELECT c.ROWID AS rowid, c.guid AS guid, c.chat_identifier AS identifier,
                lower(h.id) AS handle
         FROM chat c
         JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
         JOIN handle h ON h.ROWID = chj.handle_id
         WHERE (SELECT count(*) FROM chat_handle_join x WHERE x.chat_id = c.ROWID) = 1`
      )
      .all();
    const stats = db.prepare(
      `SELECT count(*) AS n, max(m.date) AS maxd
       FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
       WHERE cmj.chat_id = ?`
    );
    // message.date is nanoseconds since 2001 — larger than 2^53, so node:sqlite
    // refuses to return it as a lossy Number unless asked for BigInt. The
    // eventual sub-millisecond precision loss in Number() is irrelevant here.
    stats.setReadBigInts(true);
    const candidates = [];
    for (const c of singles) {
      if (!own.has(c.handle)) continue;
      const s = stats.get(c.rowid);
      candidates.push({
        guid: String(c.guid),
        identifier: String(c.identifier),
        messages: Number(s.n),
        last: appleDateToIso(s.maxd),
      });
    }
    candidates.sort((a, b) => b.messages - a.messages);
    for (const c of candidates) {
      console.log(
        `  candidate guid=${c.guid} identifier=${c.identifier} participants=1 ` +
          `messages=${c.messages} last_activity=${c.last}`
      );
    }
    if (candidates.length > 0) {
      pass('self-thread discovery', `${candidates.length} candidate self-thread(s); see candidate lines above`);
    } else {
      // Still a successful discovery: the answer is "none yet". The fix is a
      // human action, so the status says BLOCKED rather than pretending failure.
      block(
        'self-thread discovery',
        `0 self-thread candidates among ${singles.length} single-participant chats; ` +
          'create one by sending yourself a message in Messages.app, then re-run'
      );
    }
  }
} catch (error) {
  fail('self-thread discovery', `unexpected error: ${error.message}`);
} finally {
  try { db.close(); } catch {}
}

const status = failures ? 'FAIL' : blocks ? 'BLOCKED' : 'PASS';
console.log(`RESULT probe-messages: ${status}`);
process.exit(failures ? 1 : blocks ? 2 : 0);
