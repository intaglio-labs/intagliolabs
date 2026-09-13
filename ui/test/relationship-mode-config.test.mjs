// THE TWO THINGS ONBOARDING'S FIRST SCREEN SAYS, AND WHETHER THEY SURVIVE A
// RESTART.
//
// Screen 1 makes two promises above one button. "one person a day" / "one card
// a day" in the copy, and "your choice is kept by the reader" under the mode
// row. On the clean-machine retest neither held:
//
//   - the config file a fresh install writes is `{}`, so relationshipCap read
//     no capPerDay and the card route answered 'no-cap-configured' forever.
//     That route is right to fail closed -- a threshold is the owner's, not
//     one the server invents -- so the fix is an OWNER action that records it,
//     which is what pressing hello on a screen that says one a day is.
//   - POST /admin/relationship/mode set rel.mode on the running process and
//     nothing else, so an owner who picked founders was back on 'any' after
//     the next hermes restart, silently.
//
// Real server, real files, a real config on disk that is then round-tripped
// through the connectors daemon's own validator -- an unknown key there does
// not warn, it stops every connector from starting. Style follows
// onboarding-progress.test.mjs, which covers the engine switch next door.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_CAP_PER_DAY,
  RELATIONSHIP_MODES,
  RELATIONSHIP_PRODUCERS,
  ensureRelationshipDefaults,
  setRelationshipMode,
} from '../server/people/owner.mjs';
import { start } from '../server/hermes.mjs';
import { validateConfig } from '../../connectors/daemon.mjs';

const TOKEN = 'e'.repeat(64);

// ------------------------------------------------------------ owner.mjs unit

// A config path of its own per test: these functions take one, so nothing here
// needs to move HOME.
function tempConfig(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-relmem-'));
  const path = join(dir, 'config.json');
  if (contents !== undefined) writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('the mode is written to the file, beside every other setting', () => {
  const configPath = tempConfig({
    selfName: 'Owner',
    relationshipMemory: { capPerDay: 3, engine: 'claude-cli' },
  });
  assert.deepEqual(setRelationshipMode({ mode: 'founder', configPath }), { mode: 'founder', changed: true });
  const written = read(configPath);
  assert.equal(written.relationshipMemory.mode, 'founder');
  // The engine key decides whether message excerpts leave the Mac and the cap
  // decides whether a card exists at all. A mode write that dropped either
  // would turn a queue choice into a privacy or a feature change.
  assert.equal(written.relationshipMemory.engine, 'claude-cli');
  assert.equal(written.relationshipMemory.capPerDay, 3);
  assert.equal(written.selfName, 'Owner');
  assert.doesNotThrow(() => validateConfig(written));
});

test('a mode chosen on a machine with no config at all still lands', () => {
  const configPath = tempConfig();
  assert.equal(setRelationshipMode({ mode: 'investor', configPath }).changed, true);
  assert.deepEqual(read(configPath), { relationshipMemory: { mode: 'investor' } });
});

test('re-picking the mode already stored writes nothing', () => {
  const configPath = tempConfig({ relationshipMemory: { mode: 'founder' } });
  const before = statSync(configPath).mtimeMs;
  assert.deepEqual(setRelationshipMode({ mode: 'founder', configPath }), { mode: 'founder', changed: false });
  assert.equal(statSync(configPath).mtimeMs, before, 'the file was not rewritten');
});

test('a mode outside the closed set throws and writes nothing', () => {
  const configPath = tempConfig({ selfName: 'Owner' });
  for (const mode of ['anyone', 'ANY', '', null, undefined, 'operator']) {
    assert.throws(() => setRelationshipMode({ mode, configPath }), /mode must be one of/u,
      `${JSON.stringify(mode)} must be refused`);
  }
  assert.deepEqual(read(configPath), { selfName: 'Owner' });
  // The set hermes validates against and the set this writes are the same
  // object, imported from here. Two copies is how they drift.
  assert.deepEqual([...RELATIONSHIP_MODES], ['investor', 'founder', 'any']);
});

test('the cap and the producer are written when the owner has neither', () => {
  const configPath = tempConfig({ selfName: 'Owner', relationshipMemory: { mode: 'any' } });
  assert.deepEqual(ensureRelationshipDefaults({ configPath }), {
    capPerDay: 1, producer: 'eligibility', changed: { capPerDay: true, producer: true },
  });
  const written = read(configPath);
  assert.equal(written.relationshipMemory.capPerDay, 1);
  // Absent reads as the legacy matcher path, which is the wrong path for a
  // machine with no owner history: the shipped card is the eligibility
  // producer's.
  assert.equal(written.relationshipMemory.producer, 'eligibility');
  assert.equal(written.relationshipMemory.mode, 'any', 'the mode survives');
  assert.doesNotThrow(() => validateConfig(written), 'the daemon still accepts this file');
});

test('each key is judged on its own: the absent one is written, the present one is not', () => {
  // THE DISCRIMINATION THAT MATTERS. A machine part-way through -- a cap set by
  // hand, no producer -- must gain the producer and keep the cap, and the two
  // keys must not travel as a pair.
  const configPath = tempConfig({ relationshipMemory: { capPerDay: 5 } });
  assert.deepEqual(ensureRelationshipDefaults({ configPath }), {
    capPerDay: 5, producer: 'eligibility', changed: { capPerDay: false, producer: true },
  });
  const written = read(configPath);
  assert.equal(written.relationshipMemory.capPerDay, 5, "the owner's number is untouched");
  assert.equal(written.relationshipMemory.producer, 'eligibility');

  // And the mirror image: a producer set, no cap.
  const other = tempConfig({ relationshipMemory: { producer: 'matcher' } });
  assert.deepEqual(ensureRelationshipDefaults({ configPath: other }), {
    capPerDay: 1, producer: 'matcher', changed: { capPerDay: true, producer: false },
  });
  assert.equal(read(other).relationshipMemory.producer, 'matcher',
    'an owner deliberately on the legacy producer stays there');
});

test('nothing is written when both keys are already the owner\'s', () => {
  const configPath = tempConfig({ relationshipMemory: { capPerDay: 4, producer: 'matcher' } });
  const before = statSync(configPath).mtimeMs;
  assert.deepEqual(ensureRelationshipDefaults({ configPath }), {
    capPerDay: 4, producer: 'matcher', changed: { capPerDay: false, producer: false },
  });
  assert.equal(statSync(configPath).mtimeMs, before, 'the file was not rewritten');
});

test('a zero cap is an owner choosing no cards, and stays', () => {
  // relationshipCap treats anything that is not a positive integer as "no cap
  // configured" and serves nothing. A 0 in the file is therefore the
  // fail-closed state expressed deliberately, and this must not read it as an
  // absence and turn the feature on.
  const configPath = tempConfig({ relationshipMemory: { capPerDay: 0, producer: 'eligibility' } });
  const result = ensureRelationshipDefaults({ configPath });
  assert.equal(result.capPerDay, 0);
  assert.equal(result.changed.capPerDay, false);
  assert.equal(read(configPath).relationshipMemory.capPerDay, 0);
});

test('a cap or a producer outside its set throws and writes nothing', () => {
  const configPath = tempConfig({ selfName: 'Owner' });
  for (const capPerDay of [0, -1, 1.5, MAX_CAP_PER_DAY + 1, 100, '1', null, NaN]) {
    assert.throws(() => ensureRelationshipDefaults({ capPerDay, configPath }),
      /capPerDay must be an integer/u, `${JSON.stringify(capPerDay)} must be refused`);
  }
  for (const producer of ['matcherr', 'ELIGIBILITY', '', null, 7]) {
    assert.throws(() => ensureRelationshipDefaults({ producer, configPath }),
      /producer must be one of/u, `${JSON.stringify(producer)} must be refused`);
  }
  assert.deepEqual(read(configPath), { selfName: 'Owner' });
  assert.deepEqual([...RELATIONSHIP_PRODUCERS], ['eligibility', 'matcher']);
  assert.equal(ensureRelationshipDefaults({ capPerDay: MAX_CAP_PER_DAY, configPath }).capPerDay,
    MAX_CAP_PER_DAY, 'the ceiling itself is allowed');
});

// ----------------------------------------------------------------- the routes

// A test home, so the writes under test land in a tmpdir rather than on the
// machine's own config. os.homedir() reads $HOME on POSIX, which is what
// ownerConfigPath() and relationshipCap both resolve through. Awaited inside
// the try, not returned from it: returning the promise restores $HOME before
// the assertions run.
//
// `features` NAMES THE REGISTRY THIS SERVER RUNS UNDER (2026-09-13). Sub-role
// modes are retired from the product surface and serve only while the registry's
// `timeline` flag is on, so a test whose subject is the MODE -- that it reaches
// the reply, that it comes from the seam's file rather than $HOME -- has to say
// so. Omitted means 'none', the shipped registry alone, which is both the
// default install and what keeps every other test here off the developer's own
// ~/.hazlie/features.json.
async function withHome(fn, serverOpts = {}) {
  const { features, ...startOpts } = serverOpts;
  const home = mkdtempSync(join(tmpdir(), 'relmem-home-'));
  mkdirSync(join(home, '.hazlie', 'connectors'), { recursive: true });
  const previousHome = process.env.HOME;
  const previousFeatures = process.env.HAZLIE_FEATURES_OVERRIDE;
  process.env.HOME = home;
  if (features === undefined) {
    process.env.HAZLIE_FEATURES_OVERRIDE = 'none';
  } else {
    const featuresDir = mkdtempSync(join(tmpdir(), 'relmem-features-'));
    const featuresPath = join(featuresDir, 'features.json');
    writeFileSync(featuresPath, JSON.stringify(features));
    process.env.HAZLIE_FEATURES_OVERRIDE = featuresPath;
  }
  const dir = mkdtempSync(join(tmpdir(), 'relmem-db-'));
  const dbPath = join(dir, 'context.db');
  const server = await start({
    port: 0,
    dbPath,
    llamaApiKey: 'd'.repeat(64),
    bearerToken: TOKEN,
    peopleProjectionAutoRebuild: false,
    ...startOpts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body, headers = {}) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    await fn({ home, call, base, dbPath });
  } finally {
    await server.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousFeatures === undefined) delete process.env.HAZLIE_FEATURES_OVERRIDE;
    else process.env.HAZLIE_FEATURES_OVERRIDE = previousFeatures;
  }
}

const configPathIn = (home) => join(home, '.hazlie', 'connectors', 'config.json');
const readConfig = (home) => JSON.parse(readFileSync(configPathIn(home), 'utf8'));

test('picking a mode keeps it on disk as well as in the process', async () => {
  await withHome(async ({ home, call }) => {
    writeFileSync(configPathIn(home), '{}\n');
    const res = await call('POST', '/admin/relationship/mode', { mode: 'founder' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mode: 'founder', persisted: true });
    // The promise under the mode row is about the NEXT run, not this one.
    const written = readConfig(home);
    assert.equal(written.relationshipMemory.mode, 'founder');
    assert.doesNotThrow(() => validateConfig(written));
  });
});

test('a mode the closed set does not name is a 400 and writes nothing', async () => {
  await withHome(async ({ home, call }) => {
    writeFileSync(configPathIn(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    for (const mode of ['anyone', '', null, 42]) {
      const res = await call('POST', '/admin/relationship/mode', { mode });
      assert.equal(res.status, 400, `${JSON.stringify(mode)} must be refused`);
    }
    const extra = await call('POST', '/admin/relationship/mode', { mode: 'any', capPerDay: 9 });
    assert.equal(extra.status, 400, 'a closed body does not smuggle the cap through the mode route');
    assert.deepEqual(readConfig(home), { selfName: 'Owner' });
  });
});

test('onboarding records the one-a-day cap a fresh install has no config for', async () => {
  await withHome(async ({ home, call }) => {
    // A FRESH INSTALL, EXACTLY. Bridge.writeConnectorsConfigIfMissing writes
    // this file and this content, and before the route below existed nothing
    // ever added a key to it -- so the peek route answered no-cap-configured
    // for the life of the machine.
    writeFileSync(configPathIn(home), '{}\n');
    const before = await call('GET', '/admin/relationship/card?peek=1');
    assert.equal(before.status, 200);
    assert.equal((await before.json()).reason, 'no-cap-configured',
      'the fail-closed answer is what this is fixing; if it changed, this test is measuring the wrong thing');

    const res = await call('POST', '/admin/config/card', { capPerDay: 1, producer: 'eligibility' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      state: 'ok', capPerDay: 1, producer: 'eligibility',
      changed: { capPerDay: true, producer: true },
    });

    const written = readConfig(home);
    assert.equal(written.relationshipMemory.capPerDay, 1);
    // The other half of what a fresh install lacks: without this key
    // relationshipProducerConfig runs the legacy matcher path, which is not the
    // producer the shipped card comes from.
    assert.equal(written.relationshipMemory.producer, 'eligibility');
    assert.doesNotThrow(() => validateConfig(written), 'the daemon still accepts this file');

    // And the gate is open: whatever the peek now says, it is no longer "you
    // have no cap". An empty corpus has no card to offer, so the reason may
    // well be another one -- it may not be this one.
    const after = await call('GET', '/admin/relationship/card?peek=1');
    assert.notEqual((await after.json()).reason, 'no-cap-configured');
  });
});

test('the card route writes only the key the owner has not set', async () => {
  await withHome(async ({ home, call }) => {
    // A cap and a producer the owner chose, and a mode beside them: the call
    // must leave all three exactly as they are.
    writeFileSync(configPathIn(home), JSON.stringify({
      relationshipMemory: { capPerDay: 4, producer: 'matcher', mode: 'investor' },
    }, null, 2));
    const res = await call('POST', '/admin/config/card', { capPerDay: 1, producer: 'eligibility' });
    assert.deepEqual(await res.json(), {
      state: 'ok', capPerDay: 4, producer: 'matcher',
      changed: { capPerDay: false, producer: false },
    });
    const kept = readConfig(home);
    assert.equal(kept.relationshipMemory.capPerDay, 4);
    assert.equal(kept.relationshipMemory.producer, 'matcher');
    assert.equal(kept.relationshipMemory.mode, 'investor');
  });

  // And the half-configured machine: a cap by hand, no producer.
  await withHome(async ({ home, call }) => {
    writeFileSync(configPathIn(home), JSON.stringify({
      relationshipMemory: { capPerDay: 4 },
    }, null, 2));
    const res = await call('POST', '/admin/config/card', { capPerDay: 1, producer: 'eligibility' });
    assert.deepEqual(await res.json(), {
      state: 'ok', capPerDay: 4, producer: 'eligibility',
      changed: { capPerDay: false, producer: true },
    });
    const written = readConfig(home);
    assert.equal(written.relationshipMemory.capPerDay, 4);
    assert.equal(written.relationshipMemory.producer, 'eligibility');
  });
});

test('the card route refuses anything outside the two closed values', async () => {
  await withHome(async ({ home, call }) => {
    writeFileSync(configPathIn(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    for (const capPerDay of [0, -1, 1.5, 11, 500, '1', null]) {
      const res = await call('POST', '/admin/config/card', { capPerDay, producer: 'eligibility' });
      assert.equal(res.status, 400, `${JSON.stringify(capPerDay)} must be refused`);
    }
    for (const producer of ['matcherr', 'ELIGIBILITY', '', null, 7]) {
      const res = await call('POST', '/admin/config/card', { capPerDay: 1, producer });
      assert.equal(res.status, 400, `${JSON.stringify(producer)} must be refused`);
    }
    // Both are required rather than defaulted: a default supplied by the route
    // is the threshold-invented-by-the-server the fail-closed rule forbids.
    for (const body of [{ capPerDay: 1 }, { producer: 'eligibility' }, {}]) {
      assert.equal((await call('POST', '/admin/config/card', body)).status, 400,
        `${JSON.stringify(body)} must name both`);
    }
    const extra = await call('POST', '/admin/config/card',
      { capPerDay: 1, producer: 'eligibility', engine: 'claude-cli' });
    assert.equal(extra.status, 400, 'the engine cannot ride in on this route');
    // A form post is not this route's shape, and the engine route beside it
    // makes the same check.
    const wrongType = await call('POST', '/admin/config/card',
      { capPerDay: 1, producer: 'eligibility' }, { 'Content-Type': 'text/plain' });
    assert.equal(wrongType.status, 415);
    assert.deepEqual(readConfig(home), { selfName: 'Owner' }, 'nothing was written');
  });
});

// A page cannot set the cap or the mode, whether or not its origin is one the
// server has been told to talk to: an UNKNOWN origin never authenticates (401),
// an ALLOWED one authenticates as the browser channel and is refused the
// capability (403). The second case is the one a future widening of admin to
// the browser would trip.
const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';

test('both routes refuse the browser channel in either shape', async () => {
  await withHome(async ({ home, base }) => {
    writeFileSync(configPathIn(home), JSON.stringify({ selfName: 'Owner' }, null, 2));
    const ask = (path, body, origin) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, Origin: origin },
      body: JSON.stringify(body),
    });
    for (const [path, body] of [
      ['/admin/config/card', { capPerDay: 1, producer: 'eligibility' }],
      ['/admin/relationship/mode', { mode: 'founder' }],
    ]) {
      assert.equal((await ask(path, body, 'https://example.test')).status, 401, `${path}: unknown origin`);
      assert.equal((await ask(path, body, ALLOWED_ORIGIN)).status, 403, `${path}: allowed origin`);
    }
    assert.deepEqual(readConfig(home), { selfName: 'Owner' }, 'no attempt wrote anything');
  }, { allowedOrigins: ALLOWED_ORIGIN });
});

// --------------------------------------------------- reading the choice back

// THE OTHER HALF OF "YOUR CHOICE IS KEPT BY THE READER" (round-4 finding 1).
//
// Persisting the mode was only ever half of it. Onboarding's enterWelcome asks
// relCardPeek for the current mode and paints the row from the answer, on the
// stated ground that a replayed onboarding must not redraw as "anyone" and put
// the owner one tap from overwriting a choice they made. The peek answered
// `rel.mode ?? null`, and rel.mode is written by the mode route or recovered
// from a reconnect batch -- neither of which exists on the install this screen
// is actually drawn on: config written, hermes restarted, no batch yet.
//
// A FRESH PROCESS IS THE POINT. `start()` below is a new server over an empty
// database, so rel.mode is undefined and the persisted config is the only
// thing that can answer.
test('a fresh reader reports the persisted mode, with no batch to recover it from', async () => {
  await withHome(async ({ home, call }) => {
    writeFileSync(configPathIn(home), JSON.stringify({
      relationshipMemory: { mode: 'founder', capPerDay: 1, producer: 'eligibility' },
    }));

    const peek = await call('GET', '/admin/relationship/card?peek=1');
    assert.equal(peek.status, 200);
    const out = await peek.json();
    assert.equal(out.card, null, 'nothing has been produced, which is the state under test');
    assert.equal(out.mode, 'founder',
      'the peek must answer the mode on disk, not null -- null is what repaints "anyone"');
  }, { features: { timeline: true } });
});

// The same read on the branch a genuinely fresh install hits FIRST: no cap has
// been recorded yet, so the card route short-circuits before it ever looks at
// a card. That early return carried no mode at all.
test('the no-cap answer still carries the mode, because that is the fresh-install branch', async () => {
  await withHome(async ({ home, call }) => {
    writeFileSync(configPathIn(home), JSON.stringify({ relationshipMemory: { mode: 'investor' } }));

    const out = await (await call('GET', '/admin/relationship/card?peek=1')).json();
    assert.equal(out.reason, 'no-cap-configured', 'the branch under test');
    assert.equal(out.mode, 'investor');
  }, { features: { timeline: true } });
});

// THE SEAM HAS TO BE THE SAME SEAM ON BOTH SIDES (round-4 finding 6).
//
// The three config-WRITING routes went through policy.ownerConfigPath while
// relationshipCap and relationshipProducerConfig opened
// ~/.hazlie/connectors/config.json by hand. A test could therefore post a mode
// into its tmpdir and then assert the effect against a completely different
// file.
//
// This discriminates by pointing the two at DIFFERENT files: $HOME holds one
// answer, the seam holds another. Only code that honours the seam can report
// the seam's.
test('the config readers honour ownerConfigPath, not homedir', async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'relmem-seam-'));
  const seamPath = join(elsewhere, 'config.json');
  writeFileSync(seamPath, JSON.stringify({
    relationshipMemory: { mode: 'founder', capPerDay: 3, producer: 'eligibility' },
  }));

  await withHome(async ({ home, call }) => {
    // The home config disagrees on every key the seam sets.
    writeFileSync(configPathIn(home), JSON.stringify({
      relationshipMemory: { mode: 'investor', producer: 'matcher' },
    }));

    const out = await (await call('GET', '/admin/relationship/card?peek=1')).json();
    assert.equal(out.mode, 'founder', 'the mode came from the seam, not from $HOME');
    assert.notEqual(out.reason, 'no-cap-configured',
      'and so did the cap: $HOME records none, the seam records three');
  }, { ownerConfigPath: seamPath, features: { timeline: true } });
});

// THE ORDINARY PRE-PROJECTION STATE IS NOT A WARNING (round-4 finding 9).
//
// person_identifiers is created lazily by the projection, so the owner-filter
// query throws `no such table` on every fresh install -- and screen 6 polls
// this route on a timer, so the load screen wrote the line continuously. The
// sibling catch twelve lines down already exempted exactly this message.
// AN ABSENT PROJECTION TABLE IS NOT A CAVEAT (round-4 finding 9).
//
// The owner filter's catch warned on ANY failure, including `no such table`,
// while the sibling catch twelve lines below it already exempted exactly that
// message. Screen 6 polls this route on a timer, so on any install in that
// state the load screen wrote the line continuously.
//
// THE STATE HAS TO BE BUILT BY HAND, and that is worth saying: the finding's
// own route to it -- "before the first rebuild" -- is closed, because
// onboardingProgress opens with peopleProjectionStatus, which runs
// ensurePeopleProjectionSchema and creates person_identifiers before the owner
// query is reached. What remains reachable is the schema failing to apply at
// all (peopleProjectionStatus swallows that and answers null) and then every
// projection query throwing. ensurePeopleProjectionSchema memoises per
// database handle, and start() has already applied it, so dropping the table
// out from under the running server reproduces that state exactly.
test('onboarding progress does not warn about an absent projection table', async () => {
  await withHome(async ({ home, call, dbPath }) => {
    // ownerEmails is what makes this reach the query at all: the identifier
    // lookup runs only when the owner HAS addresses and no marked keys.
    writeFileSync(configPathIn(home), JSON.stringify({ ownerEmails: ['owner@example.com'] }));

    const side = new DatabaseSync(dbPath);
    try {
      side.exec('DROP TABLE IF EXISTS person_identifiers');
    } finally {
      side.close();
    }

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    let body;
    try {
      const res = await call('GET', '/admin/onboarding/progress');
      assert.equal(res.status, 200);
      body = await res.json();
    } finally {
      console.warn = realWarn;
    }
    assert.ok(body, 'the route still answers -- a number with a caveat beats a blank screen');
    assert.deepEqual(
      warnings.filter((line) => /owner filter unavailable/u.test(line)),
      [],
      'an absent projection table is the same exemption the sibling catch already makes'
    );
  });
});

// THE CONFIG IS PARSED ONCE PER VERSION OF THE FILE, NOT ONCE PER CALL
// (round-5 finding 18).
//
// relationshipCap and relationshipProducerConfig each read and parsed
// config.json on every call, from five branches of a route the panel polls.
// Memoising them is only safe if the memo dies the instant the file changes,
// and the file changes from inside this very process: POST
// /admin/relationship/mode writes it and the next GET must serve the new mode.
//
// So the risk the cache introduces is staleness, and that is what this pins --
// including back-to-back rewrites, which is where a cache stamped with
// millisecond-grained mtime alone would hand back the previous parse.
test('a config rewritten under the running server is seen by the very next request', async () => {
  await withHome(async ({ home, call }) => {
    writeFileSync(configPathIn(home), '{}\n');
    const empty = await (await call('GET', '/admin/relationship/card?peek=1')).json();
    assert.equal(empty.reason, 'no-cap-configured', 'no cap in the file is no cap');
    assert.equal(empty.mode, 'any', 'and no mode in the file is the default mode');

    // Written the way the daemon, an editor, or a restore writes it: straight
    // over the file, with no route involved.
    for (const mode of ['founder', 'investor']) {
      writeFileSync(configPathIn(home), JSON.stringify({
        relationshipMemory: { capPerDay: 1, mode, producer: 'eligibility' },
      }));
      const out = await (await call('GET', '/admin/relationship/card?peek=1')).json();
      assert.equal(out.mode, mode, `the ${mode} write is visible to the next request`);
      assert.notEqual(out.reason, 'no-cap-configured', 'and so is the cap beside it');
    }

    // Back-to-back, no awaits between the writes: two versions of the file
    // inside the same millisecond, and the second one is the one that counts.
    writeFileSync(configPathIn(home), JSON.stringify({
      relationshipMemory: { capPerDay: 1, mode: 'any', producer: 'eligibility' },
    }));
    writeFileSync(configPathIn(home), JSON.stringify({
      relationshipMemory: { capPerDay: 1, mode: 'founder', producer: 'eligibility' },
    }));
    const last = await (await call('GET', '/admin/relationship/card?peek=1')).json();
    assert.equal(last.mode, 'founder', 'the newest version of the file is the one that answers');

    // And a file that goes away goes back to answering nothing, rather than
    // to the last thing the cache happened to hold.
    rmSync(configPathIn(home));
    const gone = await (await call('GET', '/admin/relationship/card?peek=1')).json();
    assert.equal(gone.reason, 'no-cap-configured');
    assert.equal(gone.mode, 'any');
  }, { features: { timeline: true } });
});
