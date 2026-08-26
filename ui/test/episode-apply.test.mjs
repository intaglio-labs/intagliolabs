// The server side of the episode boundary.
//
// The distiller checks that a claim cites a line the owner wrote. These tests
// are about hermes checking it AGAIN, because the distiller is a client and a
// client is not a boundary. An episode deliberately shows the model text the
// owner did not write; `quotable` is what separates "may inform" from "may be
// cited", and the row a claim finally points at is the server's decision.
import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertRows, applyMemoryBatch } from '../server/hermes.mjs';
import { rebuildEpisodes } from '../server/memory/episodeStore.mjs';

const T0 = Date.UTC(2026, 2, 4, 12, 0, 0);

// A two-line thread: they ask, the owner answers. Synthetic; the repo is public.
function seed() {
  const db = openDb(':memory:');
  insertRows(db, [
    {
      ts: T0,
      source: 'imessage',
      speaker: 'Sam',
      text: 'want chick-fil-a tonight?',
      meta: { is_from_me: 0, chat_guid: 'CHAT1' },
      entity_id: 'imessage:1',
    },
    {
      ts: T0 + 60_000,
      source: 'imessage',
      speaker: 'Owner',
      text: 'cant, im vegetarian now',
      meta: { is_from_me: 1, chat_guid: 'CHAT1' },
      entity_id: 'imessage:2',
    },
  ]);
  rebuildEpisodes(db, { now: T0 + 86_400_000 });
  const ep = db.prepare('SELECT * FROM episode').get();
  return { db, ep };
}

const run = (hash) => ({
  model: 'test-model',
  prompt_path: 'prompts/distill_claims.md',
  prompt_sha: 'a'.repeat(64),
  params: { temperature: 0 },
  rows_in: 2,
  episode_hash: hash,
  episode_context: 'on',
});

const claim = (line, quote, text = 'The owner is vegetarian.') => ({
  kind: 'fact',
  text,
  p_claim: 0.9,
  source: { line, quote },
});

test('the episode index is built and its lines carry quotability', () => {
  const { db, ep } = seed();
  assert.equal(ep.row_count, 2);
  assert.equal(ep.owner_row_count, 1);
  // Mapped to plain objects: node:sqlite hands back null-prototype rows, which
  // deepEqual distinguishes from object literals.
  const members = db
    .prepare('SELECT line_no, quotable FROM episode_member ORDER BY line_no')
    .all()
    .map((m) => ({ line_no: m.line_no, quotable: m.quotable }));
  assert.deepEqual(members, [
    { line_no: 1, quotable: 0 },
    { line_no: 2, quotable: 1 },
  ]);
  db.close();
});

test('a claim on the owner line is accepted, and hermes resolves the row itself', () => {
  const { db, ep } = seed();
  const out = applyMemoryBatch(db, { run: run(ep.member_hash), claims: [claim(2, 'im vegetarian now')] });
  assert.equal(out.applied, 1, JSON.stringify(out.rejected ?? []));
  const src = db.prepare('SELECT context_id, quote FROM claim_source').get();
  const ownerRow = db
    .prepare("SELECT id FROM context WHERE json_extract(meta,'$.is_from_me') IS 1")
    .get();
  assert.equal(src.context_id, ownerRow.id, 'the receipt points at the owner’s row');
  db.close();
});

// THE ONE THAT MATTERS.
test('a claim citing the received line is refused by the server', () => {
  const { db, ep } = seed();
  assert.throws(
    () => applyMemoryBatch(db, { run: run(ep.member_hash), claims: [claim(1, 'want chick-fil-a')] }),
    /not a line the owner wrote/
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claim').get().n, 0, 'nothing was written');
  db.close();
});

// The attack the server-side resolution exists to stop: a compromised distiller
// pairing a received row's id with an owner row's quote. Both the quote check
// and the row check would pass, because each is individually true.
test('a caller-supplied context_id is refused outright in episode mode', () => {
  const { db, ep } = seed();
  const received = db
    .prepare("SELECT id FROM context WHERE json_extract(meta,'$.is_from_me') IS 0")
    .get();
  assert.throws(
    () =>
      applyMemoryBatch(db, {
        run: run(ep.member_hash),
        claims: [
          {
            kind: 'fact',
            text: 'The owner wants chick-fil-a.',
            p_claim: 0.9,
            source: { context_id: received.id, quote: 'want chick-fil-a' },
          },
        ],
      }),
    /context_id is not accepted in episode mode/
  );
  db.close();
});

test('a line outside the episode is refused', () => {
  const { db, ep } = seed();
  assert.throws(
    () => applyMemoryBatch(db, { run: run(ep.member_hash), claims: [claim(99, 'im vegetarian now')] }),
    /not in this episode/
  );
  db.close();
});

// Note the difference in KIND of failure, which is deliberate in this route: a
// bad SHAPE (a line that is not quotable, a supplied context_id) refuses the
// whole batch, because it means the client is broken or lying. A bad RECEIPT is
// rejected by index with the rest of the batch applied, because a model
// mis-copying one quote is ordinary and losing the other four claims to it is
// not. The boundary throws; the quote check reports.
test('the quote still has to be a real span of the resolved row', () => {
  const { db, ep } = seed();
  const out = applyMemoryBatch(db, {
    run: run(ep.member_hash),
    claims: [claim(2, 'a quote nobody wrote')],
  });
  assert.equal(out.applied, 0, 'nothing lands on an invented quote');
  assert.equal(out.rejected.length, 1);
  assert.match(JSON.stringify(out.rejected[0]), /quote/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claim').get().n, 0);
  db.close();
});

test('an unknown episode hash is refused before any claim is examined', () => {
  const { db } = seed();
  assert.throws(
    () => applyMemoryBatch(db, { run: run('b'.repeat(64)), claims: [claim(2, 'im vegetarian now')] }),
    /names no known episode/
  );
  db.close();
});

test('source.line is refused for a row-mode run, so the shapes cannot be mixed', () => {
  const { db } = seed();
  const rowRun = { ...run(undefined), episode_hash: undefined, episode_context: undefined };
  assert.throws(
    () => applyMemoryBatch(db, { run: rowRun, claims: [claim(2, 'im vegetarian now')] }),
    /only accepted for an episode run/
  );
  db.close();
});

test('the arm is recorded on the run, which is what makes it revertible', () => {
  const { db, ep } = seed();
  applyMemoryBatch(db, { run: run(ep.member_hash), claims: [claim(2, 'im vegetarian now')] });
  const r = db.prepare('SELECT episode_context, episode_hash FROM distill_run').get();
  assert.equal(r.episode_context, 'on');
  assert.equal(r.episode_hash, ep.member_hash);
  // One index scan finds every claim produced while received text was in the
  // window -- the whole reason the column exists.
  const n = db
    .prepare(
      'SELECT COUNT(*) n FROM claim c JOIN distill_run r ON r.id = c.run_id ' +
        "WHERE r.episode_context = 'on'"
    )
    .get().n;
  assert.equal(n, 1);
  db.close();
});

// Most conversations hold no durable claim. An episode the model read and found
// nothing in must still record a run, or "not yet distilled" is true forever and
// the pass never drains.
test('an episode run with no claims is recorded, so it is not re-read forever', () => {
  const { db, ep } = seed();
  const out = applyMemoryBatch(db, { run: run(ep.member_hash), claims: [] });
  assert.equal(out.applied, 0);
  const r = db.prepare('SELECT episode_hash, status FROM distill_run').get();
  assert.equal(r.episode_hash, ep.member_hash);
  assert.equal(r.status, 'complete');
  db.close();
});

// Row mode is unchanged: there the cursor moves regardless, so an empty batch
// is a caller mistake rather than a result.
test('a row-mode run still requires at least one claim', () => {
  const { db } = seed();
  const rowRun = { ...run(undefined), episode_hash: undefined, episode_context: undefined };
  assert.throws(() => applyMemoryBatch(db, { run: rowRun, claims: [] }), /array of 1 to/);
  db.close();
});

// ---- the index is updated, not rewritten ----
//
// The rebuild used to DELETE both tables and reinsert every episode, which held
// the corpus write lock for the whole job -- 94 seconds against the live server
// while the distiller held it, with hermes answering nothing throughout. These
// pin the property that replaced it: the same index, written differentially.
test('a second rebuild over an unchanged corpus writes nothing', () => {
  const db = openDb(':memory:');
  insertRows(db, [
    { ts: Date.UTC(2025, 0, 1, 9, 0), source: 'imessage', entity_id: 'r1', text: 'morning',
      meta: { chat_guid: 'any;-;+15550100', handle: '+15550100', is_from_me: true } },
    { ts: Date.UTC(2025, 0, 1, 9, 5), source: 'imessage', entity_id: 'r2', text: 'hello back',
      meta: { chat_guid: 'any;-;+15550100', handle: '+15550100', is_from_me: false } },
  ]);
  const first = rebuildEpisodes(db);
  assert.ok(first.inserted > 0);
  const ids = db.prepare('SELECT id FROM episode ORDER BY id').all().map((r) => r.id);

  const second = rebuildEpisodes(db);
  assert.equal(second.inserted, 0, 'nothing new');
  assert.equal(second.deleted, 0, 'nothing gone');
  assert.equal(second.episodes, first.episodes);
  // IDS SURVIVE, which is the correctness half: distill_run joins on
  // member_hash and topics counts one hit per episode id, and a rebuild that
  // renumbered everything invalidated both for no reason.
  assert.deepEqual(db.prepare('SELECT id FROM episode ORDER BY id').all().map((r) => r.id), ids);
  db.close();
});

test('a new conversation is added without touching the others', () => {
  const db = openDb(':memory:');
  insertRows(db, [
    { ts: Date.UTC(2025, 0, 1, 9, 0), source: 'imessage', entity_id: 'a1', text: 'first thread',
      meta: { chat_guid: 'any;-;+15550100', handle: '+15550100', is_from_me: true } },
  ]);
  rebuildEpisodes(db);
  const before = db.prepare('SELECT id, member_hash FROM episode ORDER BY id').all();

  insertRows(db, [
    { ts: Date.UTC(2025, 5, 2, 9, 0), source: 'imessage', entity_id: 'b1', text: 'a different thread',
      meta: { chat_guid: 'any;-;+15550199', handle: '+15550199', is_from_me: true } },
  ]);
  const out = rebuildEpisodes(db);
  assert.equal(out.inserted, 1, 'exactly the new one');
  assert.equal(out.deleted, 0);
  const after = db.prepare('SELECT id, member_hash FROM episode ORDER BY id').all();
  for (const row of before) {
    assert.ok(after.some((r) => r.id === row.id && r.member_hash === row.member_hash),
      'an untouched conversation keeps its id');
  }
  db.close();
});

// A message landing inside an existing episode re-cuts it: the old one is gone
// and a new one takes its place. That MUST be a delete plus an insert, or the
// index would carry two episodes claiming the same rows.
test('a message joining an existing conversation replaces that episode', () => {
  const db = openDb(':memory:');
  insertRows(db, [
    { ts: Date.UTC(2025, 0, 1, 9, 0), source: 'imessage', entity_id: 'c1', text: 'one',
      meta: { chat_guid: 'any;-;+15550100', handle: '+15550100', is_from_me: true } },
  ]);
  rebuildEpisodes(db);
  const firstHash = db.prepare('SELECT member_hash FROM episode').get().member_hash;

  insertRows(db, [
    { ts: Date.UTC(2025, 0, 1, 9, 10), source: 'imessage', entity_id: 'c2', text: 'two, same hour',
      meta: { chat_guid: 'any;-;+15550100', handle: '+15550100', is_from_me: true } },
  ]);
  const out = rebuildEpisodes(db);
  assert.equal(out.deleted, 1, 'the old cut is gone');
  assert.equal(out.inserted, 1, 'the new cut is in');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM episode').get().n, 1, 'not two claiming the same rows');
  assert.notEqual(db.prepare('SELECT member_hash FROM episode').get().member_hash, firstHash);
  // And no orphaned members left behind by the delete.
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM episode_member m LEFT JOIN episode e ON e.id=m.episode_id WHERE e.id IS NULL').get().n,
    0, 'cascade cleaned up'
  );
  db.close();
});

// ---- only the conversations that moved ----
//
// A full pass reads every episodic row (418,698 here, ~3s, ~384MB) just to
// discover which threads changed, because a thread key is computed from `meta`
// and is not a column anything can filter on. context_thread is that missing
// index. These pin the property that makes it safe to use: the narrow pass must
// land on exactly the index a full pass would.
const msg = (id, guid, ts, fromMe = true) => ({
  ts, source: 'imessage', entity_id: id, text: 'a message',
  meta: { chat_guid: `any;-;${guid}`, handle: guid, guid: id, is_from_me: fromMe },
});

// The whole index as CONTENT, ids aside — what a caller downstream depends on.
function indexShape(db) {
  return db
    .prepare('SELECT member_hash, thread_key, started_at, ended_at, row_count, owner_row_count, counterparty_key FROM episode ORDER BY member_hash')
    .all()
    .map((e) => {
      const mem = db.prepare('SELECT context_id, line_no, quotable FROM episode_member m JOIN episode e ON e.id=m.episode_id WHERE e.member_hash=? ORDER BY line_no')
        .all(e.member_hash).map((m) => `${m.context_id}:${m.line_no}:${m.quotable}`).join(',');
      return `${e.member_hash}|${e.thread_key}|${e.started_at}|${e.ended_at}|${e.row_count}|${e.owner_row_count}|${e.counterparty_key ?? ''}|${mem}`;
    })
    .join('\n');
}

const NOW = Date.UTC(2026, 0, 1);

test('the narrow pass lands on exactly the index a full pass would', () => {
  const seed = [
    msg('s1', '+15550100', Date.UTC(2025, 0, 1, 9, 0)),
    msg('s2', '+15550100', Date.UTC(2025, 0, 1, 9, 5), false),
    msg('s3', '+15550200', Date.UTC(2025, 0, 2, 9, 0)),
    msg('s4', '+15550300', Date.UTC(2025, 0, 3, 9, 0)),
  ];
  const inc = openDb(':memory:');
  const full = openDb(':memory:');
  insertRows(inc, seed); insertRows(full, seed);
  rebuildEpisodes(inc, { now: NOW });
  rebuildEpisodes(full, { now: NOW });
  assert.equal(indexShape(inc), indexShape(full), 'same starting point');

  // One message joining an existing conversation, one opening a new thread, and
  // one thread left completely alone.
  const arrivals = [
    msg('n1', '+15550100', Date.UTC(2025, 0, 1, 9, 20)),   // re-cuts s1/s2
    msg('n2', '+15550400', Date.UTC(2025, 0, 4, 9, 0)),    // a new thread
  ];
  insertRows(inc, arrivals); insertRows(full, arrivals);

  const narrow = rebuildEpisodes(inc, { now: NOW });
  assert.ok(String(narrow.scope).startsWith('threads:'), `expected a narrow pass, got ${narrow.scope}`);

  full.exec('DELETE FROM context_thread');  // force the full path
  const wide = rebuildEpisodes(full, { now: NOW });
  assert.equal(wide.scope, 'full');

  assert.equal(indexShape(inc), indexShape(full), 'narrow and full agree exactly');
  inc.close(); full.close();
});

test('a pass with nothing new touches nothing', () => {
  const db = openDb(':memory:');
  insertRows(db, [msg('q1', '+15550100', Date.UTC(2025, 0, 1, 9, 0))]);
  rebuildEpisodes(db, { now: NOW });
  const before = indexShape(db);
  const out = rebuildEpisodes(db, { now: NOW });
  assert.equal(out.scope, 'nothing-new');
  assert.equal(out.inserted, 0);
  assert.equal(out.deleted, 0);
  assert.equal(indexShape(db), before);
  db.close();
});

// A watermark cannot see a deletion, and hermes is the corpus's sole DELETER.
// The index must notice it has more rows than the corpus and start over rather
// than leave episodes standing for rows that are gone.
test('rows deleted out from under the index force a full pass', () => {
  const db = openDb(':memory:');
  insertRows(db, [
    msg('d1', '+15550100', Date.UTC(2025, 0, 1, 9, 0)),
    msg('d2', '+15550200', Date.UTC(2025, 0, 2, 9, 0)),
  ]);
  rebuildEpisodes(db, { now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM context_thread').get().n, 2);

  db.exec("DELETE FROM context WHERE entity_id = 'd2'");
  const out = rebuildEpisodes(db, { now: NOW });
  assert.equal(out.scope, 'full', 'a deletion is not something a watermark can see');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM context_thread').get().n, 1, 'index re-derived');
  // And no episode survives for the removed row.
  const orphans = db.prepare(
    'SELECT COUNT(*) n FROM episode_member m LEFT JOIN context c ON c.id = m.context_id WHERE c.id IS NULL'
  ).get().n;
  assert.equal(orphans, 0);
  db.close();
});

test('an untouched conversation is not rebuilt and keeps its id', () => {
  const db = openDb(':memory:');
  insertRows(db, [
    msg('k1', '+15550100', Date.UTC(2025, 0, 1, 9, 0)),
    msg('k2', '+15550200', Date.UTC(2025, 0, 2, 9, 0)),
  ]);
  rebuildEpisodes(db, { now: NOW });
  const quiet = db.prepare("SELECT id, member_hash FROM episode WHERE thread_key LIKE '%+15550200'").get();

  insertRows(db, [msg('k3', '+15550100', Date.UTC(2025, 0, 1, 9, 30))]);
  const out = rebuildEpisodes(db, { now: NOW });
  assert.ok(String(out.scope).startsWith('threads:'));
  const after = db.prepare("SELECT id, member_hash FROM episode WHERE thread_key LIKE '%+15550200'").get();
  assert.deepEqual(after, quiet, 'the other conversation was never touched');
  db.close();
});
