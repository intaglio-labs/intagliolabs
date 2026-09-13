// "REQUEST NOW, IMPORT LATER" — the card half.
//
// The sub-role modes are a LinkedIn question. `people.sub_roles`, which the
// eligibility producer filters an investor or founder pool on, is derived from
// what a profile says somebody does, and on a household Mac the data export is
// the only thing that says it. So for the days between the owner picking
// "investors" on onboarding's first screen and their archive arriving, the
// investor pool is empty for a structural reason — not "nobody has gone quiet"
// but "nothing here knows who is an investor yet" — and the screen said the
// first of those about a house full of people.
//
// The pick is therefore HELD, not overwritten: cards come from 'any' and the
// reply says why. What is pinned here is that the hold is real, that it is
// announced, that it ends the moment LinkedIn contributes somebody (no
// restart), and that it never touches what the owner is ON.
//
// Fixtures write people/person_event_links directly, same discipline as
// relationship-routes.test.mjs. Every one of them synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start } from '../server/hermes.mjs';

const TOKEN = 'e'.repeat(64);
const CAP = { max: 5, windowMs: 86_400_000 };
const DAY = 86_400_000;

// THE HOLD IS PART OF THE MODE SURFACE, so every test in this file runs with
// the registry's `timeline` flag ON (2026-09-13). The picker is retired by
// default now: with the flag off there is no pick to hold -- every card comes
// from 'any' because that is the only mode, not because an export is late --
// and linkedinPendingFallback answers null outright. That is its own test, at
// the foot of this file; everything above it is the contract for an install
// where the modes are live, unchanged.
//
// HAZLIE_FEATURES_OVERRIDE is features.mjs' own test knob, and pointing it at a
// file of this file's own making is also what keeps these tests off whatever
// ~/.hazlie/features.json the developer happens to carry.
function featureOverridePath(features) {
  if (features === undefined) return 'none';
  const dir = mkdtempSync(join(tmpdir(), 'rel-linkedin-features-'));
  const path = join(dir, 'features.json');
  writeFileSync(path, JSON.stringify(features));
  return path;
}

async function withServer(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-linkedin-pending-'));
  const { features = { timeline: true }, ...startOpts } = opts;
  const previousFeatures = process.env.HAZLIE_FEATURES_OVERRIDE;
  process.env.HAZLIE_FEATURES_OVERRIDE = featureOverridePath(features);
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'eligibility', mode: 'any' },
    peopleProjectionAutoRebuild: false,
    // The mode route writes this file, and the readers read it: without the
    // seam every mode post below would edit the developer's own config.
    ownerConfigPath: join(dir, 'config.json'),
    ...startOpts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await fn({ call, db: server.db, configPath: join(dir, 'config.json') });
  } finally {
    await server.close();
    if (previousFeatures === undefined) delete process.env.HAZLIE_FEATURES_OVERRIDE;
    else process.env.HAZLIE_FEATURES_OVERRIDE = previousFeatures;
  }
}

function insertPersonRow(db, { key, name, subRoles = [], sent = 20, received = 20 }, now) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, now - 400 * DAY, now - 10 * DAY, now - 10 * DAY, now - 10 * DAY,
    sent, received, 0, 0, sent + received, 0, 'friend', '{}', null, now, JSON.stringify(subRoles));
}

function insertMessage(db, key, ts) {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', 'hi', '{}')"
  ).run(ts).lastInsertRowid);
  db.prepare(
    'INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, '
    + "confidence, conversation_key) VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, 'conv')"
  ).run(key, ctxId);
}

// Reconnect-eligible under producer.mjs's own gates: two-way history, authored,
// quiet for 200 days.
function seedCandidate(db, key, name, now, subRoles = []) {
  insertPersonRow(db, { key, name, subRoles }, now);
  insertMessage(db, key, now - 200 * DAY);
  db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)')
    .run(key, new Date(now - 200 * DAY).toISOString().slice(0, 10));
}

// WHAT "LINKEDIN HAS CONTRIBUTED SOMEBODY" IS, on disk: a person_event_link
// whose source is the export and whose role is 'profile'. A Connections.csv row
// is entirely role='profile' — nobody authors a connection — which is exactly
// the shape that made an authored-count test of this question answer "no"
// forever. messages.csv from the same export writes ordinary counterparty
// links, which carry nothing about who anybody is.
function insertLinkedinPerson(db, key, now, role = 'profile') {
  const ctxId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'linkedin', 'hi', '{}')"
  ).run(now - 5 * DAY).lastInsertRowid);
  db.prepare(
    'INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, '
    + "confidence, conversation_key) VALUES (?, ?, 'linkedin', ?, 0, 0, 0, 1, 'linkedin')"
  ).run(key, ctxId, role);
}

// --- THE HOLD ---------------------------------------------------------------

test('investors picked, no LinkedIn yet: the card comes from anyone, and the reply says why', async () => {
  await withServer(async ({ call, db, configPath }) => {
    const now = Date.now();
    // Two people worth reconnecting with, neither of them sortable into a
    // sub-role: this is every fresh Mac before the export lands.
    seedCandidate(db, 'name:quiet one', 'Quiet One', now);
    seedCandidate(db, 'name:quiet two', 'Quiet Two', now);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.ok(out.card, 'a house full of people must not read as an empty one');
    assert.equal(out.mode, 'investor', 'the pick is what the owner is ON, and it has not moved');
    assert.equal(out.servedMode, 'any', 'the card in hand was produced under anyone');
    assert.equal(out.modeFallback, 'linkedin-pending', 'and the reply explains the disagreement');
    assert.equal(out.oneOff, undefined, 'nobody asked for a one-off look; this is the standing pick held');

    // THE HOLD IS NOT A NEW PICK. The config is what the next process reads,
    // and an owner who chose investors must still be on investors after a
    // restart — the fallback lives entirely inside one request.
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).relationshipMemory.mode, 'investor');
  });
});

test('the same hold rides the empty answer, and pool-exhausted-mode is never it', async () => {
  await withServer(async ({ call }) => {
    // Nobody anywhere. The panel must still be told the pick is being held,
    // and must NOT be offered "widen to anyone" — it is already being served
    // anyone, so the offer would ask the owner to choose what they have.
    await call('POST', '/admin/relationship/mode', { mode: 'founder' });
    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.card, null);
    assert.equal(out.mode, 'founder');
    assert.equal(out.modeFallback, 'linkedin-pending');
    assert.notEqual(out.reason, 'pool-exhausted-mode', 'the fallback IS the answer to that question');
    assert.equal(out.reason, 'pool-exhausted');
    assert.equal(out.counts, undefined, 'no offer to widen, because the widening already happened');
  });
});

test('a peek carries the hold too, so the orb and the panel agree about the card', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    seedCandidate(db, 'name:quiet one', 'Quiet One', now);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    const peek = await (await call('GET', '/admin/relationship/card?peek=1')).json();
    assert.equal(peek.peek, true);
    assert.equal(peek.mode, 'investor');
    assert.equal(peek.servedMode, 'any');
    assert.equal(peek.modeFallback, 'linkedin-pending',
      'the panel opens off this reply; a peek that hid the hold would filter its own card out');
  });
});

// --- THE END OF THE HOLD ----------------------------------------------------

test('the moment LinkedIn contributes somebody the pick takes over, with no restart', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    // One investor and one person who is nobody in particular. While the hold
    // is on, either may be served; once it lifts, only the investor may.
    seedCandidate(db, 'name:investor one', 'Investor One', now, ['investor']);
    seedCandidate(db, 'name:quiet one', 'Quiet One', now);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    const held = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(held.modeFallback, 'linkedin-pending');
    assert.equal(held.servedMode, 'any');

    // The export lands and the projection picks it up. No restart, no refresh
    // call, no config write — the next request is checked afresh.
    insertLinkedinPerson(db, 'name:investor one', now);

    const after = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(after.modeFallback, undefined, 'the hold is over and the reply stops claiming it');
    assert.equal(after.mode, 'investor');
    if (after.card !== null) {
      assert.equal(after.servedMode, 'investor', 'cards are the owner\'s own pick again');
      assert.equal(after.card.personKey, 'name:investor one',
        'and a person with no sub-role is not one of them');
    }
  });
});

test('LinkedIn already in the house: the pick is served from the start, unflagged', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    seedCandidate(db, 'name:investor one', 'Investor One', now, ['investor']);
    insertLinkedinPerson(db, 'name:investor one', now);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.mode, 'investor');
    assert.equal(out.modeFallback, undefined, 'nothing is being held: LinkedIn has already spoken');
    if (out.card !== null) assert.equal(out.servedMode, 'investor');
  });
});

test('anyone is never held, because there is nothing to hold it from', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    seedCandidate(db, 'name:quiet one', 'Quiet One', now);
    await call('POST', '/admin/relationship/mode', { mode: 'any' });

    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.mode, 'any');
    assert.equal(out.modeFallback, undefined);
    assert.equal(out.servedMode ?? 'any', 'any');
  });
});

test('a one-off look is the request\'s own decision, and the hold does not overrule it', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    seedCandidate(db, 'name:investor one', 'Investor One', now, ['investor']);
    await call('POST', '/admin/relationship/mode', { mode: 'any' });

    // ?mode= is the owner asking for one specific look — including the panel's
    // own widen button, which is a one-off ask for 'any'. Answering a named
    // mode with a different one would defeat the whole mechanism.
    const out = await (await call('GET', '/admin/relationship/card?mode=investor')).json();
    assert.equal(out.oneOff, true);
    assert.equal(out.mode, 'any', 'the standing pick, unchanged');
    assert.equal(out.modeFallback, undefined, 'a named mode is not a held one');
    if (out.card !== null) assert.equal(out.servedMode, 'investor');
  });
});

test('the matcher path is never held, because nothing there is produced per mode', async () => {
  await withServer(async ({ call }) => {
    // The matcher does not produce per mode and its cards carry no
    // evidence.mode, so there is no pick to hold and no pool to widen to. A
    // flag here would announce a hold that is not happening — and narrowing
    // the serve filter to 'any' on its behalf would drop every unlabelled card
    // the matcher has.
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });
    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.mode, 'investor');
    assert.equal(out.modeFallback, undefined);
  }, { relationshipProducerConfig: { producer: 'matcher', mode: 'investor' } });
});

test('a linkedin message row is not a profile row, and does not lift the hold', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    seedCandidate(db, 'name:investor one', 'Investor One', now, ['investor']);
    // The export's other file. messages.csv writes counterparty links, and
    // nothing in them says who anybody is — people.sub_roles, which is what an
    // investor pool is filtered on, comes from Connections.csv. Releasing the
    // hold here would flip the screen from "investor cards start when your
    // export lands" straight back to "nobody qualifies yet".
    insertLinkedinPerson(db, 'name:investor one', now, 'counterparty');
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    const still = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(still.modeFallback, 'linkedin-pending');

    insertLinkedinPerson(db, 'name:investor one', now, 'profile');
    const after = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(after.modeFallback, undefined, 'the connections file is what ends the wait');
  });
});

// --- HOW LONG IT HAS BEEN HELD ----------------------------------------------
//
// The surfaces say "investor cards start WHEN your linkedin export lands". For
// an owner who pressed `later` and never imports, "when" is a word that never
// comes due, and a page can only say something else after a while if something
// counted the while.

test('heldSince rides the fallback, holds still across polls, and survives a restart', async (t) => {
  // This test builds its own servers, so it turns the mode flag on for itself
  // (see withServer above) and hands the restore to the runner rather than to a
  // finally a failed assertion would skip.
  const previousFeatures = process.env.HAZLIE_FEATURES_OVERRIDE;
  process.env.HAZLIE_FEATURES_OVERRIDE = featureOverridePath({ timeline: true });
  t.after(() => {
    if (previousFeatures === undefined) delete process.env.HAZLIE_FEATURES_OVERRIDE;
    else process.env.HAZLIE_FEATURES_OVERRIDE = previousFeatures;
  });
  const dir = mkdtempSync(join(tmpdir(), 'rel-linkedin-held-'));
  const opts = {
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipCap: CAP,
    relationshipProducerConfig: { producer: 'eligibility', mode: 'investor' },
    peopleProjectionAutoRebuild: false,
    ownerConfigPath: join(dir, 'config.json'),
  };
  const get = async (server, path) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();

  const first = await start(opts);
  let since;
  try {
    const one = await get(first, '/admin/relationship/card');
    assert.equal(one.modeFallback, 'linkedin-pending');
    assert.ok(Number.isInteger(one.heldSince), 'a clock, in milliseconds');
    since = one.heldSince;
    const two = await get(first, '/admin/relationship/card');
    assert.equal(two.heldSince, since, 'a poll is not a new wait');
    const progress = await get(first, '/admin/onboarding/progress');
    assert.equal(progress.heldSince, since, 'and the setup screen is told the same number');
  } finally {
    await first.close();
  }

  // THE RESTART IS THE WHOLE POINT. A counter living in the process is reset by
  // every relaunch, which is exactly the install where "your export never
  // arrived" needs to be sayable.
  const second = await start(opts);
  try {
    const after = await get(second, '/admin/relationship/card');
    assert.equal(after.heldSince, since, 'the wait is one stretch, not one per process');
  } finally {
    await second.close();
  }
});

test('the clock is dropped the moment the hold is, so it can only describe an unbroken wait', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    seedCandidate(db, 'name:investor one', 'Investor One', now, ['investor']);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });
    assert.ok((await (await call('GET', '/admin/relationship/card')).json()).heldSince);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_mode_hold').get().n), 1);

    insertLinkedinPerson(db, 'name:investor one', now);
    const after = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(after.heldSince, undefined, 'nothing is being held, so there is nothing to date');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_mode_hold').get().n), 0,
      'and the clock is gone rather than left to be read as a live wait');
  });
});

test('switching between sub-role picks is the same wait, because the export is what is waited on', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });
    const asInvestor = await (await call('GET', '/admin/relationship/card')).json();
    await call('POST', '/admin/relationship/mode', { mode: 'founder' });
    const asFounder = await (await call('GET', '/admin/relationship/card')).json();
    assert.ok(Number.isInteger(asInvestor.heldSince), 'both picks are held, and both are dated');
    assert.equal(asFounder.heldSince, asInvestor.heldSince,
      'changing which cards you want does not restart the archive LinkedIn is building');
  });
});

// --- THE RELAY --------------------------------------------------------------

test('the setup screen reads the clock and never starts or stops it', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    seedCandidate(db, 'name:investor one', 'Investor One', now, ['investor']);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    // ONE WRITER, AND IT IS THE CARD ROUTE. Two routes both starting and
    // stopping one row is one row with two opinions — and they derive the
    // owner's pick differently, so a mode that failed to persist would have the
    // card route holding while this route deleted the clock under it, resetting
    // the very number the seven-day sentence waits on.
    const beforeAnyCard = await (await call('GET', '/admin/onboarding/progress')).json();
    assert.equal(beforeAnyCard.modeFallback, 'linkedin-pending', 'it still reports the hold');
    assert.equal(beforeAnyCard.heldSince, undefined, 'and says nothing about a clock nobody started');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_mode_hold').get().n), 0,
      'reading the setup screen must not start the wait');

    const card = await (await call('GET', '/admin/relationship/card')).json();
    assert.ok(Number.isInteger(card.heldSince), 'the route that decides the hold is the one that dates it');
    const after = await (await call('GET', '/admin/onboarding/progress')).json();
    assert.equal(after.heldSince, card.heldSince, 'and from then on the screen reports that same number');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rm_mode_hold').get().n), 1,
      'still one row: polling the screen neither restarts nor clears it');
  });
});

test('the setup screen relays the hold rather than deciding it a second time', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    seedCandidate(db, 'name:investor one', 'Investor One', now, ['investor']);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });

    const held = await (await call('GET', '/admin/onboarding/progress')).json();
    assert.equal(held.modeFallback, 'linkedin-pending',
      'one answer, two screens: a setup page deciding this for itself is a page that can disagree');
    assert.equal(held.linkedinExportReady, null, 'nothing has said the export is ready');

    insertLinkedinPerson(db, 'name:investor one', now);
    const after = await (await call('GET', '/admin/onboarding/progress')).json();
    assert.equal(after.modeFallback, undefined,
      'and it is not held behind the five-second body cache, either');
  });
});

// --- AND WITH THE MODES RETIRED, THERE IS NOTHING TO HOLD -------------------
//
// Everything above runs with the registry's `timeline` flag on. Off -- which is
// what ops/features.json ships since 2026-09-13 -- the picker is gone: every
// card comes from 'any' because that is the only mode, not because an export is
// late. Saying 'linkedin-pending' there would explain a substitution nobody
// made, and the seven-day sentence the clock exists for would be counting a
// wait the owner is not in.

test('the pick is never held while the modes are retired, and the clock is dropped', async () => {
  await withServer(async ({ call, db }) => {
    const now = Date.now();
    // Exactly the fixture the first test in this file uses: an investor pick,
    // and LinkedIn has contributed nobody.
    seedCandidate(db, 'name:retired investor', 'Retired Investor', now, ['investor']);
    await call('POST', '/admin/relationship/mode', { mode: 'investor' });
    // A clock left running by the install that WAS held when the flag flipped.
    db.prepare('INSERT OR REPLACE INTO rm_mode_hold(id, since) VALUES (1, ?)').run(now - 3 * DAY);

    const out = await (await call('GET', '/admin/relationship/card')).json();
    assert.equal(out.modeFallback, undefined, 'nothing is being held from anybody');
    assert.equal(out.heldSince, undefined, 'and no wait is being counted');
    assert.equal(out.mode, 'any');
    assert.equal(
      db.prepare('SELECT since FROM rm_mode_hold WHERE id = 1').get(), undefined,
      'the stale clock is stopped rather than left to describe a wait that ended'
    );

    const progress = await (await call('GET', '/admin/onboarding/progress')).json();
    assert.equal(progress.modeFallback, undefined, 'the setup screen relays the same nothing');
    assert.equal(progress.heldSince, undefined);
  }, { features: { timeline: false } });
});
