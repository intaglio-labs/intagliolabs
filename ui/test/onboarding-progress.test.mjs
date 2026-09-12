// ONBOARDING'S LAST TWO SERVER SURFACES: the engine opt-in, and the live
// first-load table.
//
// Both are counts-only routes behind the bearer, and both exist because the
// screens above them were about to lie. The engine switch decides whether
// message excerpts leave this Mac, so the value it writes has to survive the
// connectors daemon's own config validator or the next daemon start dies on
// it. The progress table says "connected, nobody found yet" in amber, and the
// first version of that arithmetic would have said it about LinkedIn on the
// most common input there is.
//
// Real server, real SQLite, heterogeneous fixture — the style of
// relationship-routes.test.mjs. HOME is redirected to a tmpdir so the config
// write and the state.db read land inside the test rather than on the
// machine's own files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { start } from '../server/hermes.mjs';
import { validateConfig } from '../../connectors/daemon.mjs';

const TOKEN = 'f'.repeat(64);

// state.db, as connectors/lib/state.mjs creates it. Only the two tables the
// progress route reads; a fixture that mirrored the whole schema would rot
// against the real one without ever testing more.
const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS contact_ids(
  identifier   TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL,
  person_ref   TEXT,
  source       TEXT NOT NULL DEFAULT 'contacts',
  updated_ts   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_log(
  id          INTEGER PRIMARY KEY,
  connector   TEXT NOT NULL,
  started_ts  INTEGER NOT NULL,
  finished_ts INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  ingested    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  unchanged   INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
`;

// A test home, so the config write and the state.db read cannot touch the
// machine's own. os.homedir() reads $HOME on POSIX, which is what every path
// under test resolves through.
// AWAITED, not returned. The first version of this helper returned fn(home)
// from inside a try/finally, so `finally` restored $HOME the instant the
// promise was created and every path under test resolved against the real
// home while the assertions ran against the tmp one.
async function withHome(fn, serverOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'onboarding-home-'));
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    await fn(home, serverOpts);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

async function withServer(home, fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onboarding-db-'));
  const server = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: 'd'.repeat(64),
    bearerToken: TOKEN,
    // The projection rebuild is what this route REPORTS ON, so it must not
    // also be what mutates the fixture underneath it: a scheduled rebuild
    // clears person_event_links and rewrites people_projection_state, which
    // erased every seeded link between the insert and the GET. Off by default
    // here; the revision numbers are set by hand instead, which is the only
    // way to hold the projection deliberately behind.
    peopleProjectionAutoRebuild: false,
    ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await fn({ call, db: server.db, base, home });
  } finally {
    await server.close();
  }
}

const configPath = (home) => join(home, '.hazlie', 'connectors', 'config.json');
const readConfig = (home) => JSON.parse(readFileSync(configPath(home), 'utf8'));

// ---------------------------------------------------------------- the opt-in

test('turning the engine on writes a config the connectors daemon still accepts', async () => {
  await withHome(async (home) => {
    // An existing config with an unrelated key and an unrelated
    // relationshipMemory setting: the write must preserve both. A cap the
    // owner set is what gates the daily card at all, so losing it here would
    // switch the whole feature off as a side effect of opting in.
    writeFileSync(configPath(home), JSON.stringify({
      selfName: 'Owner',
      relationshipMemory: { capPerDay: 3, mode: 'any' },
    }, null, 2));

    await withServer(home, async ({ call }) => {
      const res = await call('POST', '/admin/config/engine', { engine: 'claude-cli' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { state: 'ok', engine: 'claude-cli', changed: true });
    });

    const written = readConfig(home);
    assert.equal(written.relationshipMemory.engine, 'claude-cli');
    assert.equal(written.relationshipMemory.capPerDay, 3, 'the cap survives the write');
    assert.equal(written.relationshipMemory.mode, 'any');
    assert.equal(written.selfName, 'Owner', 'an unrelated top-level key survives');

    // THE REGRESSION THIS BLOCK EXISTS FOR. An unknown config key does not
    // make the daemon complain; it makes the daemon refuse to start, and the
    // symptom is every source reading zero rows with an opaque log line.
    // relationshipMemory is in TOP_KEYS and validateConfig does not descend
    // into it — assert that rather than trusting it.
    assert.doesNotThrow(() => validateConfig(written));
  });
});

test('turning it off deletes the key rather than writing an off value', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({
      relationshipMemory: { capPerDay: 3, engine: 'claude-cli' },
    }, null, 2));
    await withServer(home, async ({ call }) => {
      const res = await call('POST', '/admin/config/engine', { engine: 'local' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).engine, 'local');
    });
    const written = readConfig(home);
    // ABSENT, not 'llama' and not 'local'. engines.mjs reads an absent key as
    // the loopback engine; any string here would be a fourth state nothing
    // consumes, and the next reader would have to guess which strings mean off.
    assert.ok(!('engine' in written.relationshipMemory), 'the key is gone');
    assert.equal(written.relationshipMemory.capPerDay, 3);
    assert.doesNotThrow(() => validateConfig(written));
  });
});

test('opting out with nothing to opt out of writes no file at all', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    const before = readFileSync(configPath(home), 'utf8');
    await withServer(home, async ({ call }) => {
      const res = await call('POST', '/admin/config/engine', { engine: 'local' });
      assert.deepEqual(await res.json(), { state: 'ok', engine: 'local', changed: false });
    });
    // An empty relationshipMemory object left behind by a "turn it off" press
    // reads, to the next person, like a setting somebody configured.
    assert.equal(readFileSync(configPath(home), 'utf8'), before);
  });
});

test('any engine name but the two is a 400 and writes nothing', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    await withServer(home, async ({ call }) => {
      for (const engine of ['gpt', 'llama', '', null]) {
        const res = await call('POST', '/admin/config/engine', { engine });
        assert.equal(res.status, 400, `"${engine}" must be refused`);
      }
      // A closed field list, like every other admin POST: a body that also
      // carries capPerDay must not smuggle it through this route.
      const extra = await call('POST', '/admin/config/engine', { engine: 'local', capPerDay: 99 });
      assert.equal(extra.status, 400);
    });
    assert.deepEqual(readConfig(home), { selfName: 'Owner' }, 'nothing was written');
  });
});

// A page cannot flip the privacy switch, whether or not its origin is one the
// server has been told to talk to. The two refusals differ on purpose and the
// distinction is worth pinning: an UNKNOWN origin never authenticates at all
// (401), while an ALLOWED one authenticates as the browser channel and is then
// refused the capability (403). A future edit that widened admin to the
// browser channel would only be caught by the second case.
const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';

test('the engine route refuses the browser channel in both of its shapes', async () => {
  await withHome(async (home, serverOpts) => {
    writeFileSync(configPath(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    await withServer(home, async ({ base }) => {
      const ask = (origin) => fetch(`${base}/admin/config/engine`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          Origin: origin,
        },
        body: JSON.stringify({ engine: 'claude-cli' }),
      });
      assert.equal((await ask('https://example.test')).status, 401,
        'an unknown origin does not authenticate, bearer header or not');
      const allowed = await ask(ALLOWED_ORIGIN);
      assert.equal(allowed.status, 403,
        'an allowed origin authenticates as a browser and is refused the capability');
    }, serverOpts);
    assert.deepEqual(readConfig(home), { selfName: 'Owner' }, 'neither attempt wrote anything');
  }, { allowedOrigins: ALLOWED_ORIGIN });
});

// ----------------------------------------------------------- the live table

// A HETEROGENEOUS FIXTURE, built so the wrong arithmetic and the right one
// disagree on four of the five sources. A naive
// `COUNT(DISTINCT person_key) GROUP BY source` over every link returns
// non-zero for linkedin, non-zero for calendar, and counts the group-thread
// person for imessage — three wrong answers, each of which paints a colour
// the owner would act on.
//
//   mail      80 rows, no authored links at all. THE GMAIL BUG: the connector
//             ingested, the sender never resolved, and the old screen said
//             "connected" about a source that had found nobody. Must be amber.
//   imessage  40 rows, 6 people who wrote to you direct, plus one person
//             whose ONLY link is a group thread (room = 1). Must be 6, and
//             must be green.
//   linkedin  500 profile rows, zero authored. The most common LinkedIn
//             input there is — a Connections.csv with no messages.csv. Must
//             be 500 and 'listed', never 0 and amber.
//   calendar  rows whose only links are role='attendee', authored = 0. An
//             invite you were on is not somebody writing to you. Must be 0
//             and amber.
//   contacts  no context rows whatsoever; counted from state.db.

function seedPerson(db, key, name) {
  db.prepare(
    'INSERT OR IGNORE INTO people(person_key, display_name, sent, received, met_in_person, ' +
    'room_messages, direct_messages, meeting_notes, role, roles_by_year, built_at) ' +
    "VALUES(?, ?, 0, 0, 0, 0, 0, 0, 'unknown', '{}', 0)"
  ).run(key, name);
}

function seedRows(db, source, count) {
  const insert = db.prepare(
    'INSERT INTO context(id, ts, source, speaker, text, meta, store_changed_at) ' +
    'VALUES(?, ?, ?, ?, ?, ?, ?)'
  );
  const ids = [];
  const base = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM context').get().n);
  for (let i = 1; i <= count; i += 1) {
    const id = base + i;
    insert.run(id, 1_700_000_000_000 + id, source, 'x', 'fixture', '{}', id);
    ids.push(id);
  }
  return ids;
}

function seedLink(db, { key, contextId, source, role, authored, room }) {
  db.prepare(
    'INSERT OR REPLACE INTO person_event_links(person_key, context_id, source, role, authored, ' +
    'owner_authored, room, confidence, conversation_key) VALUES(?, ?, ?, ?, ?, 0, ?, 1.0, ?)'
  ).run(key, contextId, source, role, authored, room, `${source}:${key}`);
}

function seedFixture(db) {
  // The projection schema is created lazily by the server; make sure it is
  // there before inserting into it.
  db.exec('SELECT 1');
  const mail = seedRows(db, 'mail', 80);
  const imessage = seedRows(db, 'imessage', 40);
  const linkedin = seedRows(db, 'linkedin', 500);
  const calendar = seedRows(db, 'calendar', 12);

  // mail: rows, and links that are NOT authored — the sender never resolved.
  seedPerson(db, 'mail:nobody', 'Nobody');
  seedLink(db, { key: 'mail:nobody', contextId: mail[0], source: 'mail', role: 'recipient', authored: 0, room: 0 });

  // imessage: six direct correspondents, plus one group-thread-only person.
  for (let i = 0; i < 6; i += 1) {
    const key = `imessage:friend${i}`;
    seedPerson(db, key, `Friend ${i}`);
    seedLink(db, { key, contextId: imessage[i], source: 'imessage', role: 'counterparty', authored: 1, room: 0 });
  }
  seedPerson(db, 'imessage:groupie', 'Groupie');
  seedLink(db, {
    key: 'imessage:groupie', contextId: imessage[10], source: 'imessage',
    role: 'counterparty', authored: 1, room: 1,
  });

  // linkedin: every row a profile, none authored.
  for (let i = 0; i < 500; i += 1) {
    const key = `linkedin:conn${i}`;
    seedPerson(db, key, `Conn ${i}`);
    seedLink(db, { key, contextId: linkedin[i], source: 'linkedin', role: 'profile', authored: 0, room: 0 });
  }

  // calendar: attendees only.
  for (let i = 0; i < 4; i += 1) {
    const key = `calendar:attendee${i}`;
    seedPerson(db, key, `Attendee ${i}`);
    seedLink(db, { key, contextId: calendar[i], source: 'calendar', role: 'attendee', authored: 0, room: 0 });
  }
}

// The projection's own triggers bump source_revision on every context insert,
// so a freshly seeded database always looks behind. Onboarding's grey
// "reading" state is exactly that, and every other assertion here needs the
// caught-up world, so tests say which one they want.
function markProjection(db, { projected, source, builtAt = Date.now() }) {
  db.prepare(
    'UPDATE people_projection_state SET projected_revision = ?, source_revision = ?, built_at = ? WHERE id = 1'
  ).run(projected, source, builtAt);
}

function stateDb(home) {
  const db = new DatabaseSync(join(home, '.hazlie', 'connectors', 'state.db'));
  db.exec(STATE_SCHEMA);
  return db;
}

const byName = (body) => Object.fromEntries(body.sources.map((s) => [s.source, s]));

test('the table counts who wrote to you, and says so differently where that is not the question', async () => {
  await withHome(async (home) => {
    const state = stateDb(home);
    state.prepare(
      "INSERT INTO contact_ids(identifier, display_name, kind, source, updated_ts) VALUES(?, ?, 'email', 'contacts', 0)"
    ).run('a@example.test', 'A');
    state.prepare(
      "INSERT INTO contact_ids(identifier, display_name, kind, source, updated_ts) VALUES(?, ?, 'phone', 'contacts', 0)"
    ).run('+15550000000', 'B');
    state.close();

    await withServer(home, async ({ call, db }) => {
      seedFixture(db);
      markProjection(db, { projected: 9, source: 9 });
      const body = await (await call('GET', '/admin/onboarding/progress')).json();
      const rows = byName(body);

      assert.equal(rows.mail.rows, 80);
      assert.equal(rows.mail.people, 0, 'the sender never resolved — that is the whole bug');
      assert.equal(rows.mail.status, 'empty', 'rows in, nobody found, projection current: amber');

      assert.equal(rows.imessage.rows, 40);
      assert.equal(rows.imessage.people, 6, 'a name on a group thread is not a correspondent');
      assert.equal(rows.imessage.status, 'ok');
      assert.equal(rows.imessage.peopleKind, 'authors');

      assert.equal(rows.linkedin.rows, 500);
      assert.equal(rows.linkedin.people, 500, 'profiles, not authors — an export has no authors');
      assert.equal(rows.linkedin.peopleKind, 'listed',
        'so the page can head that cell "people in your export"');
      assert.equal(rows.linkedin.status, 'ok',
        'the single most likely false amber in this screen');

      assert.equal(rows.calendar.rows, 12);
      assert.equal(rows.calendar.people, 0, 'an invite you were on is not somebody writing to you');
      assert.equal(rows.calendar.status, 'empty');

      assert.equal(rows.contacts.people, 2, 'counted from state.db, not from context');
      assert.equal(rows.contacts.peopleKind, 'names');
      assert.equal(rows.contacts.status, 'ok');
      assert.ok(!Object.hasOwn(rowsBySourceOf(db), 'contacts'),
        'and contacts genuinely writes no corpus rows, so the other path would say 0/0 forever');
    });
  });
});

function rowsBySourceOf(db) {
  return Object.fromEntries(
    db.prepare('SELECT source, COUNT(*) AS n FROM context GROUP BY source').all()
      .map((r) => [r.source, Number(r.n)])
  );
}

test('a projection that has not caught up is grey, even where it would be green', async () => {
  await withHome(async (home) => {
    await withServer(home, async ({ call, db }) => {
      seedFixture(db);
      markProjection(db, { projected: 3, source: 9 });
      const rows = byName(await (await call('GET', '/admin/onboarding/progress')).json());
      for (const source of ['mail', 'imessage', 'linkedin', 'calendar']) {
        assert.equal(rows[source].status, 'reading',
          `${source} must not be coloured from a projection that has not read the rows`);
      }
      // A people count from a projection built before a purge can exceed
      // anything real, which is why this outranks green rather than only amber.
      assert.equal(rows.imessage.people, 6, 'the number is still reported; it is just not trusted yet');
    });
  });
});

test('two failed runs in a row is red; one after a success is not', async () => {
  await withHome(async (home) => {
    const state = stateDb(home);
    const log = state.prepare(
      'INSERT INTO run_log(connector, started_ts, finished_ts, ok, error) VALUES(?, ?, ?, ?, ?)'
    );
    log.run('imessage', 1, 2, 1, null);
    log.run('imessage', 3, 4, 0, 'EPERM');
    log.run('imessage', 5, 6, 0, 'EPERM');
    log.run('imessage', 7, 8, 0, 'EPERM');
    log.run('mail', 1, 2, 0, 'ETIMEDOUT');
    log.run('mail', 3, 4, 1, null);
    log.run('mail', 5, 6, 0, 'ETIMEDOUT');
    state.close();

    await withServer(home, async ({ call, db }) => {
      seedFixture(db);
      markProjection(db, { projected: 9, source: 9 });
      const body = await (await call('GET', '/admin/onboarding/progress')).json();
      const rows = byName(body);
      assert.equal(rows.imessage.status, 'failing',
        'three consecutive failures outrank a people count from before they started');
      assert.equal(body.runs.imessage.failStreak, 3);
      assert.equal(body.runs.imessage.lastError, 'EPERM',
        'the fingerprint, so the row can say "messages — not reading (EPERM)"');
      assert.equal(body.runs.imessage.lastOkTs, 2);

      assert.equal(body.runs.mail.failStreak, 1);
      assert.equal(rows.mail.status, 'empty',
        'one failure after a success is a locked database, not a broken source');
      assert.equal(body.daemonLastRunTs, 8, 'the newest finish across every connector');
    });
  });
});

test('no daemon history at all is reported as such, for the banner above the table', async () => {
  await withHome(async (home) => {
    await withServer(home, async ({ call, db }) => {
      seedFixture(db);
      markProjection(db, { projected: 9, source: 9 });
      const body = await (await call('GET', '/admin/onboarding/progress')).json();
      // Null rather than 0 or absent: the page's banner ("nothing is running,
      // let me start it") must be able to tell "never ran" from "ran at epoch".
      // Per-source amber would blame a source for a daemon that is not up.
      assert.equal(body.daemonLastRunTs, null);
      assert.deepEqual(body.runs, {});
    });
  });
});

test('the progress route answers counts and state, and no content', async () => {
  await withHome(async (home) => {
    await withServer(home, async ({ call, db }) => {
      seedFixture(db);
      markProjection(db, { projected: 9, source: 9 });
      const raw = await (await call('GET', '/admin/onboarding/progress')).text();
      // The fixture's row text and person names must appear nowhere in the
      // body. This is a polled route with no owner review in front of it.
      assert.ok(!raw.includes('fixture'), 'no row text');
      assert.ok(!raw.includes('Friend'), 'no display names');
      assert.ok(!raw.includes('imessage:friend0'), 'no person keys');
      const body = JSON.parse(raw);
      assert.deepEqual(
        Object.keys(body).sort(),
        ['daemonLastRunTs', 'projection', 'runs', 'sources', 'state']
      );
      for (const source of body.sources) {
        assert.deepEqual(
          Object.keys(source).sort(),
          ['people', 'peopleKind', 'rows', 'source', 'status']
        );
      }
    });
  });
});

test('the progress route is bearer-only', async () => {
  await withHome(async (home, serverOpts) => {
    await withServer(home, async ({ base }) => {
      const res = await fetch(`${base}/admin/onboarding/progress`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ALLOWED_ORIGIN },
      });
      assert.equal(res.status, 403);
    }, serverOpts);
  }, { allowedOrigins: ALLOWED_ORIGIN });
});
