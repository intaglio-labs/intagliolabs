// Probe: what do the Calendar and AddressBook stores look like on THIS macOS?
//
// This machine runs a macOS 27 prerelease seed, so Apple-store schemas are
// probed, never assumed (plan §Machine facts). Two decisions ride on the
// answers:
//
//   1. The calendar entity_id. The registry says
//      `calendar:<event_uid>:<recurrence_id>` — a stable event UID column plus
//      a recurrence identity from OccurrenceCache — with an occurrence-start
//      fallback ONLY if no UID column exists. This probe hunts UID-shaped
//      columns on CalendarItem (and dumps OccurrenceCache so the recurrence
//      half is chosen from evidence), reporting how populated and how distinct
//      each candidate column is. The decision lands in ops/PROBES.md.
//   2. The contacts layout: the connector plans to union
//      Sources/*/AddressBook-v22.abcddb; this probe confirms that layout and
//      the three tables the resolver needs (ZABCDRECORD, ZABCDPHONENUMBER,
//      ZABCDEMAILADDRESS).
//
// Prints table names, column names/types, file paths, and row counts ONLY —
// never an event title, a name, a number, or an address.
//
// Both stores are Full Disk Access territory; FDA attributes per responsible
// binary, so run via launchd:
//
//   launchctl submit -l com.hazlie.probe-calendar-contacts -o <out> -e <err> \
//     -- ~/.hazlie/bin/node /path/to/ops/probes/probe-calendar-contacts.mjs
//   (poll <out> for the RESULT line, then: launchctl remove com.hazlie.probe-calendar-contacts)
//
// No TTY assumed. Exit: 0 PASS · 2 BLOCKED (no FDA here) · 1 FAIL.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
let blocks = 0;
const pass = (part, evidence) => console.log(`PASS ${part}: ${evidence}`);
const fail = (part, evidence) => { failures += 1; console.log(`FAIL ${part}: ${evidence}`); };
const block = (part, evidence) => { blocks += 1; console.log(`BLOCKED ${part}: ${evidence}`); };

const home = homedir();

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

function columns(db, table) {
  // table names come from sqlite_master or our own constants, never from user
  // input, so interpolation into PRAGMA is safe here (PRAGMA takes no ? params).
  return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
}

function dumpColumns(db, table) {
  const cols = columns(db, table);
  console.log(`  ${table} (${cols.length} columns):`);
  console.log(`    ${cols.map((c) => `${c.name} ${c.type || '?'}${c.pk ? ' PK' : ''}`).join(', ')}`);
  return cols;
}

// --- Calendar ------------------------------------------------------------------
function probeCalendar() {
  // Modern macOS keeps the truth in the group container; the pre-container
  // path is the legacy fallback. Whichever opens first wins, and the chosen
  // path is itself a finding the connector will hardcode.
  const candidates = [
    join(home, 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb'),
    join(home, 'Library', 'Calendars', 'Calendar.sqlitedb'),
  ];
  let db;
  let storePath;
  let lastError;
  for (const p of candidates) {
    try {
      db = new DatabaseSync(p, { readOnly: true });
      storePath = p;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!db) {
    block(
      'calendar schema',
      `could not open any candidate store (${candidates.join(' | ')}): ${lastError?.message}; ` +
        'run via launchd with ~/.hazlie/bin/node (see header)'
    );
    return;
  }
  try {
    console.log(`  calendar store: ${storePath}`);
    const tables = tableNames(db);
    console.log(`  tables (${tables.length}): ${tables.join(', ')}`);

    const wanted = ['Calendar', 'CalendarItem', 'OccurrenceCache'];
    const present = wanted.filter((t) => tables.includes(t));
    const missing = wanted.filter((t) => !tables.includes(t));
    const dumped = {};
    for (const t of present) dumped[t] = dumpColumns(db, t);

    // UID hunt: the entity_id needs a value that survives sync and reschedule.
    // Search every CalendarItem-adjacent table so a UID living on a relative
    // (as some seeds have done) is still found.
    const uidPattern = /unique_identifier|uuid|guid|(^|_)uid(_|$)|external_id|shared_item_id/i;
    const itemTables = tables.filter((t) => /CalendarItem|Item/i.test(t) || t === 'Calendar');
    const uidFindings = [];
    for (const t of itemTables) {
      for (const c of dumped[t] ?? columns(db, t)) {
        if (uidPattern.test(String(c.name))) uidFindings.push({ table: t, column: String(c.name) });
      }
    }
    for (const f of uidFindings.filter((f) => f.table === 'CalendarItem')) {
      // Populated AND distinct is what makes a column an identity; counts only.
      const r = db
        .prepare(
          `SELECT count(*) AS total, count("${f.column}") AS populated,
                  count(DISTINCT "${f.column}") AS distinct_values
           FROM CalendarItem`
        )
        .get();
      console.log(
        `  uid candidate CalendarItem.${f.column}: populated ${r.populated}/${r.total}, ` +
          `${r.distinct_values} distinct`
      );
    }
    const other = uidFindings.filter((f) => f.table !== 'CalendarItem');
    if (other.length > 0) {
      console.log(`  uid-shaped columns elsewhere: ${other.map((f) => `${f.table}.${f.column}`).join(', ')}`);
    }

    if (tables.includes('OccurrenceCache')) {
      const occCols = dumped.OccurrenceCache ?? columns(db, 'OccurrenceCache');
      const recurrence = occCols
        .map((c) => String(c.name))
        .filter((n) => /occurrence|day|date|start|event/i.test(n));
      const occCount = Number(db.prepare('SELECT count(*) AS n FROM OccurrenceCache').get().n);
      console.log(
        `  OccurrenceCache: ${occCount} rows; recurrence-identity candidates: ${recurrence.join(', ') || '(none matched)'}`
      );
    }

    if (missing.length > 0) {
      fail('calendar schema', `expected tables missing on this seed: ${missing.join(', ')}`);
    } else if (uidFindings.some((f) => f.table === 'CalendarItem')) {
      pass(
        'calendar schema',
        `store opened read-only; Calendar/CalendarItem/OccurrenceCache present; ` +
          `uid candidates on CalendarItem: ${uidFindings
            .filter((f) => f.table === 'CalendarItem')
            .map((f) => f.column)
            .join(', ')}`
      );
    } else {
      // Not a probe failure — the schema simply lacks a UID column, which is
      // exactly the case the occurrence-start fallback exists for.
      pass(
        'calendar schema',
        'store opened read-only; expected tables present; NO uid-shaped column on ' +
          'CalendarItem — the occurrence-start fallback applies (record in PROBES.md)'
      );
    }
  } finally {
    try { db.close(); } catch {}
  }
}

// --- AddressBook ----------------------------------------------------------------
function probeAddressBook() {
  const base = join(home, 'Library', 'Application Support', 'AddressBook');
  const stores = [];
  const top = join(base, 'AddressBook-v22.abcddb');
  if (existsSync(top)) stores.push({ label: 'top-level', path: top });
  let sourceDirs = [];
  try {
    sourceDirs = readdirSync(join(base, 'Sources'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      block(
        'addressbook layout',
        `cannot list ${join(base, 'Sources')} (${error.message}); run via launchd with ~/.hazlie/bin/node`
      );
      return;
    }
  }
  for (const dir of sourceDirs) {
    const p = join(base, 'Sources', dir, 'AddressBook-v22.abcddb');
    if (existsSync(p)) stores.push({ label: `Sources/${dir}`, path: p });
  }
  if (stores.length === 0) {
    if (sourceDirs.length === 0 && !existsSync(base)) {
      block('addressbook layout', `${base} not visible; run via launchd with ~/.hazlie/bin/node`);
    } else {
      fail('addressbook layout', `no AddressBook-v22.abcddb found (top-level or under ${sourceDirs.length} Sources/* dirs)`);
    }
    return;
  }
  const needed = ['ZABCDRECORD', 'ZABCDPHONENUMBER', 'ZABCDEMAILADDRESS'];
  let allConfirmed = true;
  for (const store of stores) {
    let db;
    try {
      db = new DatabaseSync(store.path, { readOnly: true });
    } catch (error) {
      allConfirmed = false;
      console.log(`  ${store.label}: cannot open read-only (${error.message})`);
      continue;
    }
    try {
      const tables = new Set(tableNames(db));
      const have = needed.filter((t) => tables.has(t));
      const counts = have.map(
        (t) => `${t}=${Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n)}`
      );
      const ok = have.length === needed.length;
      if (!ok) allConfirmed = false;
      console.log(
        `  ${store.label}: ${tables.size} tables; ${ok ? 'all three resolver tables present' : `missing ${needed.filter((t) => !tables.has(t)).join(', ')}`}; rows: ${counts.join(', ')}`
      );
    } finally {
      try { db.close(); } catch {}
    }
  }
  if (allConfirmed) {
    pass(
      'addressbook layout',
      `${stores.length} store(s) (${stores.map((s) => s.label).join(', ')}); ` +
        'ZABCDRECORD/ZABCDPHONENUMBER/ZABCDEMAILADDRESS confirmed in each'
    );
  } else {
    fail('addressbook layout', 'one or more stores unreadable or missing resolver tables (lines above)');
  }
}

try {
  probeCalendar();
  probeAddressBook();
} catch (error) {
  fail('probe-calendar-contacts', `unexpected error: ${error.message}`);
}
const status = failures ? 'FAIL' : blocks ? 'BLOCKED' : 'PASS';
console.log(`RESULT probe-calendar-contacts: ${status}`);
process.exit(failures ? 1 : blocks ? 2 : 0);
