// Dev fixtures for Hermes' context store, so the store has something in it
// before the real ingestion pipeline exists. Every row is marked
// source: 'seed' and the content is plainly synthetic — nothing here can be
// mistaken for ingested household audio.
//
// Nothing reads these back over HTTP any more: /search and /recent are gone
// (410), and the only oracle that a write landed is the authenticated
// GET /stats row count. They are here for the sealed reader to retrieve
// in-process once it exists, and for `sqlite3` at a prompt until then.
//
// Run it from ui/:  npm run seed:context   (node scripts/seed-context.mjs)
// Prefers POST /ingest against a running Hermes (the same seam the real
// pipeline will use); if Hermes is down it opens the DB file directly, so
// seeding does not require a second terminal. HERMES_PORT / HERMES_DB move
// the target the same way they move the server. The default DB is private
// runtime state at ~/.hazlie/context/context.db, never inside this checkout.

import {
  canonicalLoopbackBase,
  openDb,
  insertRows,
  readHermesToken,
  DEFAULT_DB_PATH,
  DEFAULT_HERMES_TOKEN_PATH,
} from '../server/hermes.mjs';

// 51789, matching hermes' own default. This said 8787 until 2026-08-22, four
// days after the canonical port moved -- so a bare `npm run seed:context` sent
// the hermes bearer token to whatever else was listening on the old port, which
// on many machines is an unrelated dev server that answers 200.
// canonicalLoopbackBase then refuses to let HERMES_URL point off-box at all,
// because the Authorization header below rides every seeding request.
const PORT = Number(process.env.HERMES_PORT ?? 51789);
const BASE = canonicalLoopbackBase(
  process.env.HERMES_URL ?? `http://127.0.0.1:${PORT}`,
  'HERMES_URL'
);
const TOKEN_FILE = process.env.HERMES_TOKEN_FILE ?? DEFAULT_HERMES_TOKEN_PATH;

const now = Date.now();
const HOUR = 60 * 60 * 1000;

// hoursAgo spreads the fixtures over the past week so ordering and recency
// have something to bite on and retrieved rows carry believable timestamps.
const row = (hoursAgo, speaker, text, meta) => ({
  ts: now - hoursAgo * HOUR,
  source: 'seed',
  speaker,
  text,
  ...(meta ? { meta } : {}),
});

// Speakers are generic role labels on purpose: `speaker` is ingest-supplied
// text attribution (see server/hermes.mjs), and fixtures must not look like
// per-person profiles of real household members.
const ROWS = [
  row(2, 'parent', 'Reminder to move the car before street cleaning on Tuesday morning.'),
  row(5, 'parent', 'The wifi password for the guest network is corgi-waffle-42.'),
  row(9, 'parent', 'Dentist appointment for the kid is Thursday at 4pm, Dr. Okafor on Fillmore.'),
  row(14, 'parent', 'We are out of coffee filters, the number four cone ones.'),
  row(20, 'parent', 'Package from REI should arrive Friday, needs a signature.'),
  row(26, 'kid', 'Soccer practice moved to 5:30 on Wednesdays for the rest of the season.'),
  row(33, 'parent', 'The thermostat schedule is 68 overnight and 72 from 6am.', { room: 'hallway' }),
  row(41, 'parent', 'Landlord said the water will be shut off Saturday 9am to noon.'),
  row(50, 'parent', 'Recipe night idea: the miso salmon from the place on Clement.'),
  row(63, 'parent', 'Flight to Denver is on the 22nd, leaves SFO at 7:40am, United.'),
  row(78, 'kid', 'Library books are due back next Monday, three of them.'),
  row(92, 'parent', 'The garage code changed to 4471 after the battery swap.', { device: 'garage' }),
  row(110, 'parent', 'Vet said to give Biscuit half a pill with dinner for ten days.'),
  row(130, 'parent', 'Farmers market runs 8 to 1 on Sundays at the parking lot on Judah.'),
  row(150, 'parent', 'Spare house key is with the neighbors in 3B, the Ferreiras.'),
];

async function overHttp() {
  // The bearer channel: no Origin header, plus the token from the 0600 file
  // (server/hermes.mjs authorize()). This is Node, so unlike the page it can
  // read that file -- and this is the write path the ingestion pipeline copies, so
  // it has to demonstrate the real one.
  const res = await fetch(`${BASE}/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${readHermesToken(TOKEN_FILE)}`,
    },
    body: JSON.stringify(ROWS),
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) {
    // A reachable Hermes that rejects the batch is a bug, not a reason to
    // write around it into the same DB twice.
    const detail = await res.text();
    throw Object.assign(new Error(`hermes rejected the seed (${res.status}): ${detail}`), {
      fatal: true,
    });
  }
  return (await res.json()).inserted;
}

function directToDb() {
  const dbPath = process.env.HERMES_DB ?? DEFAULT_DB_PATH;
  const db = openDb(dbPath);
  try {
    return { inserted: insertRows(db, ROWS), dbPath };
  } finally {
    db.close();
  }
}

let inserted;
let via;
try {
  inserted = await overHttp();
  via = `POST ${BASE}/ingest`;
} catch (e) {
  if (e.fatal) {
    console.error(e.message);
    process.exit(1);
  }
  // Why the HTTP path was unavailable, verbatim: with a token in the picture
  // "hermes not running" is no longer the only reason, and a missing or
  // unreadable token file silently reported as a down server is how a
  // permissions problem becomes an hour.
  const direct = directToDb();
  inserted = direct.inserted;
  via = `direct write (${direct.dbPath}) -- HTTP unavailable: ${e.message}`;
}

for (const r of ROWS) console.log(`  [${r.speaker}] ${r.text}`);
console.log(`seeded ${inserted} rows via ${via}`);
