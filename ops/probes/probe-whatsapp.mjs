// Probe: what shape is WhatsApp Desktop's local store, and what units are its
// timestamps in?
//
// WHY THIS EXISTS AS A FILE. ops/PROBES.md has carried a "probe-whatsapp
// (2026-08-21, via launchd)" section since the WhatsApp connector was written,
// reporting real measurements — 3,563 messages across 203 chats, and the fact
// that ZMESSAGEDATE is Apple-epoch SECONDS. That last fact is load-bearing:
// connectors/lib/whatsappRows.mjs converts with `n * 1000 + APPLE_EPOCH_MS`
// and cites PROBES.md as its authority. But the script that produced those
// numbers was never committed, so the CONCLUSION survived and the EVIDENCE did
// not. Nobody could re-derive it; if the dates ever looked wrong the only way
// to check was to redo the whole investigation.
//
// Written 2026-08-22 to close that. It re-derives the schema facts the
// connector depends on, and specifically decides the epoch unit from the data
// rather than asserting it.
//
// HOW THE UNIT IS DECIDED, since that is the whole point: interpret the median
// ZMESSAGEDATE three ways — Apple-epoch seconds, Apple-epoch milliseconds, and
// Unix seconds — and report which lands inside a plausible window for a
// messaging app. The wrong unit is not subtly wrong; it is off by decades or
// millennia, so this is a decisive test rather than a judgement call.
//
// PRINTS COUNTS, COLUMN NAMES AND DATES ONLY — never ZTEXT, never a JID, never
// a contact name. The corpus boundary is hermes' database and this probe is not
// allowed to re-create any of it on stdout (connectors/AGENTS.md log policy,
// which binds probes too).
//
// The store is Full Disk Access territory and FDA attributes per responsible
// binary, so run via launchd:
//
//   launchctl submit -l com.hazlie.probe-whatsapp -o <out> -e <err> \
//     -- ~/.hazlie/bin/node /path/to/ops/probes/probe-whatsapp.mjs
//   (poll <out> for the RESULT line, then: launchctl remove com.hazlie.probe-whatsapp)
//
// Exit: 0 PASS · 2 BLOCKED (no FDA in this launch context, or no store) · 1 FAIL.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLE_EPOCH_MS = 978_307_200_000;
const STORE = join(
  homedir(),
  'Library',
  'Group Containers',
  'group.net.whatsapp.WhatsApp.shared',
  'ChatStorage.sqlite'
);

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'n/a');

// A messaging store's messages fall between WhatsApp existing and now. Anything
// outside this is the wrong unit, not an odd message.
const PLAUSIBLE_FROM = Date.parse('2009-01-01T00:00:00Z');
const plausible = (ms) => Number.isFinite(ms) && ms > PLAUSIBLE_FROM && ms < Date.now() + 86_400_000;

let db;
try {
  db = new DatabaseSync(`file:${STORE}?mode=ro`, { readOnly: true });
} catch (error) {
  const code = error?.code ?? error?.message ?? String(error);
  console.log(`  store unreadable: ${code}`);
  console.log('  (denied from a dev shell is EXPECTED — FDA attributes to the responsible');
  console.log('   process, so only a launchd-spawned run proves anything.)');
  console.log('RESULT probe-whatsapp: BLOCKED');
  process.exit(2);
}

try {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  console.log(`  tables: ${tables.length}`);

  const messages = db.prepare('SELECT COUNT(*) AS n FROM ZWAMESSAGE').get().n;
  const chats = db.prepare('SELECT COUNT(*) AS n FROM ZWACHATSESSION').get().n;
  console.log(`  ZWAMESSAGE rows: ${messages}`);
  console.log(`  ZWACHATSESSION rows: ${chats}`);

  // The columns the connector reads. Named, not sampled — a missing column is
  // the failure that would silently empty every row.
  const cols = new Set(
    db.prepare("SELECT name FROM pragma_table_info('ZWAMESSAGE')").all().map((c) => c.name)
  );
  const needed = ['ZTEXT', 'ZISFROMME', 'ZMESSAGEDATE', 'ZFROMJID', 'ZCHATSESSION', 'ZSTANZAID'];
  const missing = needed.filter((c) => !cols.has(c));
  console.log(`  ZWAMESSAGE columns present: ${needed.length - missing.length}/${needed.length}`);
  if (missing.length > 0) console.log(`  MISSING: ${missing.join(', ')}`);

  // --- the epoch question ---------------------------------------------------
  const median = db
    .prepare(
      'SELECT ZMESSAGEDATE AS v FROM ZWAMESSAGE WHERE ZMESSAGEDATE IS NOT NULL ' +
        'ORDER BY ZMESSAGEDATE LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM ZWAMESSAGE ' +
        'WHERE ZMESSAGEDATE IS NOT NULL)'
    )
    .get()?.v;

  const readings = {
    'apple-seconds': Number(median) * 1000 + APPLE_EPOCH_MS,
    'apple-milliseconds': Number(median) + APPLE_EPOCH_MS,
    'unix-seconds': Number(median) * 1000,
    'unix-milliseconds': Number(median),
  };
  console.log('  ZMESSAGEDATE interpreted four ways (median row):');
  const fits = [];
  for (const [unit, ms] of Object.entries(readings)) {
    const ok = plausible(ms);
    if (ok) fits.push(unit);
    console.log(`    ${ok ? 'PLAUSIBLE' : '  absurd '}  ${unit.padEnd(20)} ${iso(ms)}`);
  }

  const span = db
    .prepare('SELECT MIN(ZMESSAGEDATE) AS lo, MAX(ZMESSAGEDATE) AS hi FROM ZWAMESSAGE')
    .get();
  console.log(
    `  span under apple-seconds: ${iso(Number(span.lo) * 1000 + APPLE_EPOCH_MS)} → ` +
      `${iso(Number(span.hi) * 1000 + APPLE_EPOCH_MS)}`
  );

  const decided = fits.length === 1 ? fits[0] : null;
  console.log(`  DECIDED: ${decided ?? `ambiguous (${fits.length} readings plausible)`}`);

  const status =
    missing.length === 0 && decided === 'apple-seconds' ? 'PASS' : decided ? 'FAIL' : 'FAIL';
  if (decided && decided !== 'apple-seconds') {
    console.log(`  !! whatsappRows.mjs converts as apple-seconds; this store reads as ${decided}`);
  }
  console.log(`RESULT probe-whatsapp: ${status}`);
  process.exit(status === 'PASS' ? 0 : 1);
} finally {
  db.close();
}
