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
