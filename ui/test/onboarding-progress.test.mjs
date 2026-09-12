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

import { start, SOURCE_CONNECTORS } from '../server/hermes.mjs';
import { validateConfig, CONNECTOR_HERMES_SOURCE } from '../../connectors/daemon.mjs';

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
// AND THE FEATURE REGISTRY IS PINNED TO THE SHIPPED ONE. The progress table
// now asks the registry which connectors are switched on, so a developer's own
// ~/.hazlie/features.json would decide which rows these assertions see. HOME is
// already a tmpdir, which handles that; HAZLIE_FEATURES_OVERRIDE='none' handles
// the other half — an override path exported in the shell the test runs from.
// See connectors/lib/features.mjs defaultOverridePath.
async function withHome(fn, serverOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'onboarding-home-'));
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true });
  const previous = process.env.HOME;
  const previousFeatures = process.env.HAZLIE_FEATURES_OVERRIDE;
  process.env.HOME = home;
  process.env.HAZLIE_FEATURES_OVERRIDE = 'none';
  try {
    await fn(home, serverOpts);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    if (previousFeatures === undefined) delete process.env.HAZLIE_FEATURES_OVERRIDE;
    else process.env.HAZLIE_FEATURES_OVERRIDE = previousFeatures;
  }
}

// The owner override, for the one question the shipped registry cannot answer
// twice: what this table does when a switch is the OTHER way. Same file and
// same loader the owner's own escape hatch uses.
async function withFeatureOverride(home, features, fn) {
  const path = join(home, '.hazlie', 'features-test.json');
  writeFileSync(path, JSON.stringify(features));
  const previous = process.env.HAZLIE_FEATURES_OVERRIDE;
  process.env.HAZLIE_FEATURES_OVERRIDE = path;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HAZLIE_FEATURES_OVERRIDE;
    else process.env.HAZLIE_FEATURES_OVERRIDE = previous;
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
//   calendar  rows whose only links are role='attendee'/'organizer'/'declined',
//             authored = 0 on every one of them — that is what graph.mjs mints
//             from an invite. Under the authored count it is permanently 0
//             against 12 rows, which is the amber this screen exists to catch
//             being painted over a calendar that works. Must be 5 (four
//             attendees and the organizer, never the person who declined) and
//             green.
//   contacts  no context rows whatsoever; counted from state.db.
//   photos    rows, and no links ever — PERSON_SOURCE_POLICY calls it
//             'non-person' and the projection will not write a link for it, so
//             an amber row against it is a failure report about a source doing
//             its job. Must not be in the table at all.
//   instagram rows AND authored links, from a bridge the registry has since
//             switched off (`bridges: false`). Legacy rows, read by nothing.
//             Must not be in the table either — and it is the case that
//             separates "this source can mint people" from "this install is
//             reading it", because on the arithmetic alone it is green.

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
  const instagram = seedRows(db, 'instagram', 30);
  seedRows(db, 'photos', 40);

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

  // calendar: four attendees, the organizer EventKit did not repeat in the
  // attendee list, and one person who declined. None of them authored
  // anything, because nobody authors an invitation.
  for (let i = 0; i < 4; i += 1) {
    const key = `calendar:attendee${i}`;
    seedPerson(db, key, `Attendee ${i}`);
    seedLink(db, { key, contextId: calendar[i], source: 'calendar', role: 'attendee', authored: 0, room: 0 });
  }
  seedPerson(db, 'calendar:host', 'Host');
  seedLink(db, { key: 'calendar:host', contextId: calendar[0], source: 'calendar', role: 'organizer', authored: 0, room: 0 });
  seedPerson(db, 'calendar:regrets', 'Regrets');
  seedLink(db, { key: 'calendar:regrets', contextId: calendar[4], source: 'calendar', role: 'declined', authored: 0, room: 0 });

  // instagram: a bridge that used to run. Rows, and people who wrote to you
  // directly — green on the arithmetic, and switched off in the registry.
  for (let i = 0; i < 3; i += 1) {
    const key = `instagram:ghost${i}`;
    seedPerson(db, key, `Ghost ${i}`);
    seedLink(db, { key, contextId: instagram[i], source: 'instagram', role: 'counterparty', authored: 1, room: 0 });
  }
  // photos: rows, no links, no person it could ever mint.
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
      assert.equal(rows.calendar.people, 5,
        'four attendees and the organizer; the invitation itself has no author');
      assert.equal(rows.calendar.peopleKind, 'met',
        'so the page can head that cell "people you met" rather than claiming they wrote');
      assert.equal(rows.calendar.status, 'ok',
        'a calendar full of invites is the other false amber, and the one the owner hit');

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

// ---------------------------------------------- who belongs in the table

test('a source only gets a row if it can mint people AND this install reads it', async () => {
  await withHome(async (home) => {
    await withServer(home, async ({ call, db }) => {
      seedFixture(db);
      // Mail that WORKED, so the two halves of the rule are visible at once:
      // the authored count is still the right question for a message source,
      // and it is not the question for calendar.
      seedPerson(db, 'mail:realsender', 'Real Sender');
      seedLink(db, {
        key: 'mail:realsender',
        contextId: db.prepare("SELECT MIN(id) AS id FROM context WHERE source = 'mail'").get().id,
        source: 'mail', role: 'sender', authored: 1, room: 0,
      });
      markProjection(db, { projected: 9, source: 9 });

      const body = await (await call('GET', '/admin/onboarding/progress')).json();
      const rows = byName(body);

      assert.equal(rows.mail.people, 1, 'a resolved sender is still counted on authorship');
      assert.equal(rows.mail.peopleKind, 'authors');
      assert.equal(rows.mail.status, 'ok');

      assert.equal(rows.calendar.people, 5);
      assert.equal(rows.calendar.peopleKind, 'met');
      assert.equal(rows.calendar.status, 'ok');

      // 40 photo rows are not a source that failed to find anybody; they are a
      // source that was never going to.
      assert.equal(rows.photos, undefined, 'a non-person source has no row to be amber in');
      // And 30 instagram rows with three resolved authors are green on the
      // arithmetic and unread by this install. The registry decides, not the
      // count.
      assert.equal(rows.instagram, undefined, 'a switched-off bridge has no row either');

      // ONE GREY LINE, NOT SEVEN AMBER ROWS.
      assert.deepEqual(body.dormant, { sources: ['instagram', 'photos'], rows: 70 });
    });
  });
});

test('switching bridges back on puts instagram in the table and takes it out of dormant', async () => {
  await withHome(async (home) => {
    await withServer(home, async ({ call, db }) => {
      seedFixture(db);
      markProjection(db, { projected: 9, source: 9 });
      await withFeatureOverride(home, { bridges: true }, async () => {
        const body = await (await call('GET', '/admin/onboarding/progress')).json();
        const rows = byName(body);
        // The same rows, the same links, the same arithmetic — one flag apart.
        // A hardcoded list of "bridge sources" would pass the test above and
        // fail this one.
        assert.equal(rows.instagram.rows, 30);
        assert.equal(rows.instagram.people, 3);
        assert.equal(rows.instagram.status, 'ok');
        assert.deepEqual(body.dormant, { sources: ['photos'], rows: 40 });
      });
      // And back, because the registry is read per request rather than cached.
      const after = await (await call('GET', '/admin/onboarding/progress')).json();
      assert.deepEqual(after.dormant.sources, ['instagram', 'photos']);
    });
  });
});

// ------------------------------------------ the owner is not somebody you met

// "PEOPLE YOU MET" COUNTS DISTINCT PERSON KEYS, AND THE OWNER HAS ONE.
//
// graph.mjs now drops owner ADDRESSES before a calendar participant is minted,
// which closes the common case. It does not close this one: an identity the
// owner marked as themselves (config ownerPersonKeys) is dropped only from the
// finished graph, and links already written into the projection outlive the
// rebuild that would drop them. So the count has to exclude those keys itself.
//
// Without it a calendar of solo events — a focus block, a dentist appointment,
// a flight, each with the owner as its only attendee and organizer — reports at
// least one person met and paints GREEN, which is the same lie this count was
// added to remove, pointing the other way.

function seedSoloCalendar(db, ownerKey) {
  db.exec('SELECT 1');
  const calendar = seedRows(db, 'calendar', 9);
  seedPerson(db, ownerKey, 'Owner Name');
  // Every event: the owner on the guest list, and the owner as its organizer.
  for (let i = 0; i < 9; i += 1) {
    seedLink(db, {
      key: ownerKey, contextId: calendar[i], source: 'calendar',
      role: i % 3 === 0 ? 'organizer' : 'attendee', authored: 0, room: 0,
    });
  }
  return calendar;
}

function writeOwnerKeys(home, keys) {
  writeFileSync(configPath(home), JSON.stringify({ selfName: 'Owner', ownerPersonKeys: keys }, null, 2));
}

test('a calendar of solo events reports nobody met, and is amber', async () => {
  await withHome(async (home) => {
    writeOwnerKeys(home, ['calendar:owner-alias']);
    await withServer(home, async ({ call, db }) => {
      seedSoloCalendar(db, 'calendar:owner-alias');
      markProjection(db, { projected: 9, source: 9 });
      const body = await (await call('GET', '/admin/onboarding/progress')).json();
      const rows = byName(body);
      assert.equal(rows.calendar.rows, 9, 'the rows are real and were read');
      assert.equal(rows.calendar.people, 0, 'the owner is not somebody the owner met');
      assert.equal(rows.calendar.status, 'empty',
        'rows in, nobody found, projection current: amber, not the green a self-link buys');
    });
  });
});

test('and the same calendar with one real guest is green again', async () => {
  // THE DISCRIMINATING HALF. "Exclude the owner" and "return zero" are the same
  // number on the fixture above; they are not the same number here, and a
  // filter that dropped every calendar person would leave this screen amber on
  // a calendar that works — the exact failure the `met` count exists to stop.
  await withHome(async (home) => {
    writeOwnerKeys(home, ['calendar:owner-alias']);
    await withServer(home, async ({ call, db }) => {
      const calendar = seedSoloCalendar(db, 'calendar:owner-alias');
      seedPerson(db, 'calendar:dana', 'Dana Reed');
      seedLink(db, {
        key: 'calendar:dana', contextId: calendar[1], source: 'calendar',
        role: 'attendee', authored: 0, room: 0,
      });
      markProjection(db, { projected: 9, source: 9 });
      const body = await (await call('GET', '/admin/onboarding/progress')).json();
      const rows = byName(body);
      assert.equal(rows.calendar.people, 1, 'one guest, counted once, owner excluded');
      assert.equal(rows.calendar.status, 'ok');
    });
  });
});

test('with no owner key marked, nothing is excluded', async () => {
  // The config is the only source of this list. An empty one must not turn
  // into an empty IN () clause or a query that quietly filters by accident.
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    await withServer(home, async ({ call, db }) => {
      seedSoloCalendar(db, 'calendar:someone');
      markProjection(db, { projected: 9, source: 9 });
      const rows = byName(await (await call('GET', '/admin/onboarding/progress')).json());
      assert.equal(rows.calendar.people, 1, 'an unmarked key is an ordinary person');
      assert.equal(rows.calendar.status, 'ok');
    });
  });
});

// The map hermes uses to answer "whose connector is this source?" is the
// inverse of the daemon's own. Two hand-maintained lists in two files that have
// to agree is exactly the shape ops/FEATURES.md set out to kill, so this is the
// thing that checks they do — a new bridge platform, or a renamed connector,
// fails here rather than quietly dropping a source out of the owner's table.
test('the source-to-connector map inverts the daemon\'s own', () => {
  const expected = new Map();
  for (const [connector, source] of Object.entries(CONNECTOR_HERMES_SOURCE)) {
    if (source === null) continue; // contacts: a connector with no corpus at all
    for (const name of Array.isArray(source) ? source : [source]) {
      expected.set(name, [...(expected.get(name) ?? []), connector].sort());
    }
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(SOURCE_CONNECTORS).map(([s, c]) => [s, [...c].sort()])),
    Object.fromEntries([...expected.entries()])
  );
});

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
        ['daemonLastRunTs', 'dormant', 'projection', 'runs', 'sources', 'state']
      );
      for (const source of body.sources) {
        assert.deepEqual(
          Object.keys(source).sort(),
          ['people', 'peopleKind', 'rows', 'source', 'status']
        );
      }
      // COLLAPSED, deliberately: names and one total. A per-source breakdown
      // here would be the same table again, and the page would draw it.
      assert.deepEqual(Object.keys(body.dormant).sort(), ['rows', 'sources']);
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

// ---------------------------------------------- what the poll costs the box

test('the table is cached for five seconds, per server', async () => {
  // THE ONLY EXPENSIVE ROUTE IN THE APP THAT IS POLLED. It walks `context`
  // grouped by source and runs three COUNT(DISTINCT person_key) scans over
  // person_event_links — a table that is a multiple of the corpus — and screen
  // 6 polls it for as long as the owner leaves the setup screen open, on the
  // exact machine where the projection is being built underneath it.
  //
  // The holder is the per-server one /stats uses, passed in here so the test
  // can say which answer came from the cache and which from the database.
  const holder = {};
  await withHome(async (home) => {
    await withServer(home, async ({ call, db }) => {
      seedFixture(db);
      markProjection(db, { projected: 9, source: 9 });

      const first = await (await call('GET', '/admin/onboarding/progress')).json();
      const mailRows = first.sources.find((s) => s.source === 'mail').rows;
      assert.equal(mailRows, 80, 'the fixture, as seeded');
      assert.ok(holder.onboardingProgress, 'the body was not cached at all');

      // Change the corpus underneath it. A second poll inside the window must
      // still answer the cached body — that IS the cache.
      seedRows(db, 'mail', 25);
      const second = await (await call('GET', '/admin/onboarding/progress')).json();
      assert.equal(second.sources.find((s) => s.source === 'mail').rows, 80,
        'a poll inside the five seconds must not re-run the scans');

      // And the ONLY reason it did not see them is the cache: drop the entry
      // and the same request reads the new rows. Without this the test would
      // pass just as well against a route that ignores the insert.
      delete holder.onboardingProgress;
      const third = await (await call('GET', '/admin/onboarding/progress')).json();
      assert.equal(third.sources.find((s) => s.source === 'mail').rows, 105,
        'with the entry gone the scans run again and see the new rows');
    }, { statsCacheHolder: holder });
  });
});

test('two servers in one process do not share the cached table', async () => {
  // The test suite runs more than one server, and a module-scope cache would
  // have one of them answering with the other's corpus.
  const first = {};
  const second = {};
  await withHome(async (home) => {
    await withServer(home, async ({ call, db }) => {
      seedRows(db, 'mail', 7);
      await call('GET', '/admin/onboarding/progress');
    }, { statsCacheHolder: first });
    await withServer(home, async ({ call, db }) => {
      seedRows(db, 'imessage', 3);
      await call('GET', '/admin/onboarding/progress');
    }, { statsCacheHolder: second });
  });
  assert.ok(first.onboardingProgress && second.onboardingProgress, 'both servers cached');
  assert.notEqual(first.onboardingProgress, second.onboardingProgress,
    'and they are not the same object');
});

test('the two counting scans have an index that covers them', () => {
  // Both are COUNT(DISTINCT person_key) and none of the existing indexes
  // carries person_key, so both fell back to a full scan of
  // person_event_links plus a temp B-tree per group — on a poll, on the screen
  // whose whole job is to be watched while the corpus is being built.
  const schema = readFileSync(
    join(import.meta.dirname, '..', 'server', 'people', 'projection.mjs'), 'utf8');
  //   WHERE authored = 1 AND room = 0 GROUP BY source
  assert.match(schema,
    /CREATE INDEX IF NOT EXISTS person_event_links_authored_room ON person_event_links\(authored, room, source, person_key\)/u);
  //   WHERE source = ? AND role IN (...)
  assert.match(schema,
    /CREATE INDEX IF NOT EXISTS person_event_links_source_role_person ON person_event_links\(source, role, person_key\)/u);
});

test('SQLite actually uses them, rather than scanning the table', async () => {
  // The plan, from the database, for the exact statements the route runs. An
  // index that exists and is not chosen buys nothing.
  await withHome(async (home) => {
    await withServer(home, async ({ db }) => {
      seedFixture(db);
      const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
        .map((row) => row.detail).join(' | ');
      const authored = plan(
        'SELECT source, COUNT(DISTINCT person_key) AS n FROM person_event_links '
        + 'WHERE authored = 1 AND room = 0 GROUP BY source');
      assert.match(authored, /USING (COVERING )?INDEX person_event_links_authored_room/u, authored);
      assert.doesNotMatch(authored, /SCAN person_event_links(?! USING)/u, authored);
      const role = plan(
        "SELECT COUNT(DISTINCT person_key) AS n FROM person_event_links "
        + "WHERE source = 'linkedin' AND role = 'profile'");
      assert.match(role, /USING (COVERING )?INDEX person_event_links_source_role_person/u, role);
    });
  });
});

// ---------------------------------------------------------------------------
// ...and on the machine this screen is actually drawn on, where nothing is
// marked
// ---------------------------------------------------------------------------

function seedIdentifier(db, identifier, key) {
  db.prepare('INSERT OR REPLACE INTO person_identifiers(identifier, person_key) VALUES(?, ?)')
    .run(identifier, key);
}

test('the owner is excluded by address when no key has been marked', async () => {
  // ownerPersonKeys is EMPTY until the owner deliberately marks an identity,
  // which is the state of every fresh install — so the filter that excluded
  // the owner was off in exactly the case this screen exists for. The
  // addresses are the fallback, resolved through the projection's own
  // identifier table: an exact lookup, not a guess.
  //
  // HETEROGENEOUS ON PURPOSE. The owner's alias, a genuine guest, and a third
  // address that is nobody's: "exclude everything" and "exclude nothing" both
  // fail here.
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({
      selfName: 'Owner',
      ownerEmails: ['owner@old-co.test'],
    }, null, 2));
    await withServer(home, async ({ call, db }) => {
      const calendar = seedSoloCalendar(db, 'calendar:owner-alias');
      seedIdentifier(db, 'owner@old-co.test', 'calendar:owner-alias');
      seedPerson(db, 'calendar:dana', 'Dana Reed');
      seedIdentifier(db, 'dana@example.test', 'calendar:dana');
      seedLink(db, {
        key: 'calendar:dana', contextId: calendar[1], source: 'calendar',
        role: 'attendee', authored: 0, room: 0,
      });
      markProjection(db, { projected: 9, source: 9 });
      const rows = byName(await (await call('GET', '/admin/onboarding/progress')).json());
      assert.equal(rows.calendar.people, 1,
        'Dana is somebody they met; the owner is not, however the owner was recognised');
      assert.equal(rows.calendar.status, 'ok');
    });
  });
});

test('the per-source counts and the calendar count agree about the owner', async () => {
  // The two numbers are drawn on the same screen. calendarMet excluded the
  // owner and the per-source counts excluded nobody, so a mail corpus the
  // owner had written to reported one more person under `mail` than the same
  // filter would allow anywhere else.
  await withHome(async (home) => {
    writeOwnerKeys(home, ['mail:owner']);
    await withServer(home, async ({ call, db }) => {
      db.exec('SELECT 1');
      const mail = seedRows(db, 'mail', 6);
      seedPerson(db, 'mail:owner', 'Owner Name');
      seedPerson(db, 'mail:dana', 'Dana Reed');
      // authored = 1 is what the per-source count reads: somebody who WROTE.
      // The owner authors their own sent mail, which is not somebody they know.
      for (const [index, key] of [[0, 'mail:owner'], [1, 'mail:dana']]) {
        seedLink(db, { key, contextId: mail[index], source: 'mail', authored: 1, role: 'sender', room: 0 });
      }
      markProjection(db, { projected: 6, source: 6 });
      const rows = byName(await (await call('GET', '/admin/onboarding/progress')).json());
      assert.equal(rows.mail.people, 1,
        'the owner marked themselves; that answer applies to every count on this screen');
    });
  });
});
