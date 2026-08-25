// Tests for retrieval over accepted claims.
//
// The assertions that matter here are about what does NOT come back: unaccepted
// claims, rejected claims, and — in every single case — the quote. The quote is
// the one field whose escape has a real consequence, because the caller
// downstream is a text message.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertRows, applyMemoryBatch, ftsQuery } from '../server/hermes.mjs';
import { recallClaims, groundingLines, RECENCY_HORIZON_MS } from '../server/memory/retrieve.mjs';

const NOW = 1_800_000_000_000;

const RUN = { model: 'm', prompt_path: 'p', prompt_sha: 's', params: {} };

function seed(db, rows) {
  insertRows(db, rows);
  return db.prepare('SELECT id, ts, text, content_hash, entity_id FROM context ORDER BY id').all();
}

function propose(db, row, { kind = 'fact', text, quote }) {
  const { run_id } = applyMemoryBatch(db, {
    run: RUN,
    claims: [{ kind, text, source: { context_id: Number(row.id), quote } }],
  });
  return Number(db.prepare('SELECT max(id) AS id FROM claim WHERE run_id = ?').get(run_id).id);
}

function decide(db, claimId, action, at = NOW) {
  db.prepare(
    'INSERT INTO claim_decision(claim_id, action, actor, created_at) VALUES (?, ?, ?, ?)'
  ).run(claimId, action, 'owner', at);
}

// THE REGRESSION FROM 2026-08-21. ftsQuery ORs every word of a question,
// stopwords included, so a question matches a large share of the store; when
// those hits were then ordered by DATE and cut to the limit, the window became
// almost independent of what was asked. Measured on the L5 coverage corpus:
// "When do I fly to Honolulu?" matched 331 of 675 claims, the one claim about
// Honolulu ranked 209th, and the system abstained on data it was holding.
//
// Relevance now picks the set and recency orders it. The claim below is the
// OLDEST and would be pushed out by any number of newer near-matches.
test('a relevant old claim beats recent claims that merely share stopwords', () => {
  const db = openDb(':memory:');
  const rows = seed(db, [
    { ts: NOW - 900 * 86_400_000, source: 'notes', entity_id: 'n:hon', text: 'flying to honolulu on the 3rd' },
    ...Array.from({ length: 12 }, (_, i) => ({
      ts: NOW - i * 1000,
      source: 'imessage',
      entity_id: `i:${i}`,
      text: `do i need to bring anything to the thing on the ${i + 1}th`,
    })),
  ]);
  const hon = propose(db, rows[0], { text: 'Austin flies to Honolulu on the 3rd.', quote: 'flying to honolulu' });
  decide(db, hon, 'accept');
  for (let i = 1; i < rows.length; i += 1) {
    const id = propose(db, rows[i], {
      text: `Austin was asked to bring something to the ${i}th.`,
      quote: 'need to bring anything',
    });
    decide(db, id, 'accept');
  }

  const out = recallClaims(db, { match: ftsQuery('When do I fly to Honolulu?'), limit: 5, now: NOW });
  const texts = out.claims.map((c) => c.text);
  assert.ok(
    texts.some((t) => t.includes('Honolulu')),
    `the Honolulu claim must survive the cut; got: ${JSON.stringify(texts)}`
  );
});

// Relevance choosing the SET must not take the disagreement rule with it: the
// newer of two conflicting claims still has to come first in what the composer
// reads. Ordering is recency; only membership is relevance.
test('newer-first ordering survives the relevance ranking', () => {
  const db = openDb(':memory:');
  const [older, newer] = seed(db, [
    { ts: NOW - 400 * 86_400_000, source: 'notes', entity_id: 'n:1', text: 'i went vegetarian in january' },
    { ts: NOW - 10 * 86_400_000, source: 'notes', entity_id: 'n:2', text: 'i eat fish now, started in may' },
  ]);
  const a = propose(db, older, { text: 'Austin is vegetarian.', quote: 'i went vegetarian' });
  const b = propose(db, newer, { text: 'Austin eats fish, since May.', quote: 'i eat fish now' });
  decide(db, a, 'accept');
  decide(db, b, 'accept');

  // The query has to match BOTH claims, or the second arrives through the
  // top-up path instead — and the top-up appends without re-sorting, so it
  // would be testing the append order rather than the ranking. (That append
  // order is pre-existing behaviour and unchanged by the bm25 work: a
  // topped-up claim lands after every matched one regardless of its date.)
  const out = recallClaims(db, { match: ftsQuery('vegetarian fish'), limit: 5, now: NOW });
  assert.deepEqual(out.claims.map((c) => c.text), [
    'Austin eats fish, since May.',
    'Austin is vegetarian.',
  ]);
});

test('only accepted claims are ever recalled', () => {
  const db = openDb(':memory:');
  const [a, b, c] = seed(db, [
    { ts: NOW, source: 'imessage', entity_id: 'i:1', text: 'i went vegetarian in january' },
    { ts: NOW, source: 'imessage', entity_id: 'i:2', text: 'i dont drink, never have' },
    { ts: NOW, source: 'notes', entity_id: 'n:1', text: 'i am allergic to penicillin' },
  ]);
  const accepted = propose(db, a, { text: 'Austin is vegetarian.', quote: 'i went vegetarian' });
  const rejected = propose(db, b, { text: 'Austin does not drink.', quote: 'i dont drink' });
  propose(db, c, { text: 'Austin is allergic to penicillin.', quote: 'allergic to penicillin' });

  decide(db, accepted, 'accept');
  decide(db, rejected, 'reject');
  // The third is left PROPOSED -- unreviewed means unusable.

  const out = recallClaims(db, { now: NOW });
  assert.deepEqual(out.claims.map((c2) => c2.text), ['Austin is vegetarian.']);
  assert.equal(out.abstain, false);

  // And a retraction takes it back out again.
  decide(db, accepted, 'retract', NOW + 1);
  assert.deepEqual(recallClaims(db, { now: NOW }).claims, []);
  db.close();
});

test('recall never returns a quote, whatever is asked for', () => {
  // Structural, not editorial: there is no quote in the SELECT, so a caller
  // cannot leak one by accident and a future widening has to be deliberate.
  const db = openDb(':memory:');
  const [row] = seed(db, [
    { ts: NOW, source: 'imessage', entity_id: 'i:1', text: 'i went vegetarian in january' },
  ]);
  decide(db, propose(db, row, { text: 'Austin is vegetarian.', quote: 'i went vegetarian' }), 'accept');

  for (const opts of [{ now: NOW }, { now: NOW, match: ftsQuery('vegetarian') }]) {
    const { claims } = recallClaims(db, opts);
    assert.equal(claims.length, 1);
    // Widened deliberately on 2026-08-24, which is what this pin is for.
    // valid_to is the end of the day a plan named and `passed` is whether that
    // day has gone -- both computed from the claim's own text and its row's
    // timestamp. Neither is a quote and neither is row content, which is the
    // property the rest of this test checks directly.
    assert.deepEqual(Object.keys(claims[0]).sort(), [
      'id',
      'kind',
      'observed_at',
      'passed',
      'source',
      'stale',
      'text',
      'valid_to',
    ]);
    assert.ok(!('quote' in claims[0]));
    assert.ok(!JSON.stringify(claims[0]).includes('i went vegetarian'));
  }
  db.close();
});

test('search stems, so a question in English matches a claim in English', () => {
  // The bug this pins was measured, not imagined: "any allergies?" abstained
  // against an accepted claim reading "allergic to penicillin", because FTS5's
  // default tokenizer does no stemming. An abstention with the evidence
  // sitting right there reads to the owner as "Hazlie forgot".
  const db = openDb(':memory:');
  const [row] = seed(db, [
    { ts: NOW, source: 'notes', entity_id: 'n:1', text: 'im allergic to penicillin' },
  ]);
  decide(db, propose(db, row, { text: 'Austin is allergic to penicillin.', quote: 'allergic to penicillin' }), 'accept');
  for (const q of ['allergies', 'allergic', 'ALLERGIES']) {
    assert.equal(recallClaims(db, { now: NOW, match: ftsQuery(q) }).abstain, false, q);
  }
  db.close();
});

test('nothing accepted at all means abstain, even after the fallback', () => {
  // Abstention means something stronger since the fallback landed: not "no
  // keyword matched" but "there is nothing accepted here". An empty store
  // cannot fall back to anything, so it still refuses.
  const db = openDb(':memory:');
  const out = recallClaims(db, { now: NOW, match: ftsQuery('anything at all') });
  assert.deepEqual(out.claims, []);
  assert.equal(out.abstain, true);
  db.close();
});

test('a search that matches nothing falls back to recent accepted claims', () => {
  // The measured case: "allergies" does not share a stem with "allergic", so
  // the search finds nothing and the owner would get a confident abstention
  // with the answer sitting in the store. The composer decides relevance; this
  // layer just stops hiding the evidence from it.
  const db = openDb(':memory:');
  const [row] = seed(db, [
    { ts: NOW, source: 'notes', entity_id: 'n:1', text: 'im allergic to penicillin' },
  ]);
  decide(db, propose(db, row, { text: 'Austin is allergic to penicillin.', quote: 'allergic to penicillin' }), 'accept');

  const hit = recallClaims(db, { now: NOW, match: ftsQuery('penicillin') });
  assert.equal(hit.matched, 1, 'a real match is reported as a match');

  const missed = recallClaims(db, { now: NOW, match: ftsQuery('any allergies i should know about') });
  assert.equal(missed.matched, 0, 'the search itself found nothing');
  assert.equal(missed.abstain, false, 'but the claim is surfaced anyway');
  assert.equal(missed.claims[0].text, 'Austin is allergic to penicillin.');
  db.close();
});

test('search matches claim text and respects the accepted filter', () => {
  const db = openDb(':memory:');
  const [a, b] = seed(db, [
    { ts: NOW, source: 'imessage', entity_id: 'i:1', text: 'i cant do thursday mornings, physio' },
    { ts: NOW, source: 'imessage', entity_id: 'i:2', text: 'i went vegetarian in january' },
  ]);
  decide(db, propose(db, a, { kind: 'constraint', text: 'Austin cannot do Thursday mornings.', quote: 'cant do thursday' }), 'accept');
  const veg = propose(db, b, { text: 'Austin is vegetarian.', quote: 'i went vegetarian' });

  assert.deepEqual(
    recallClaims(db, { now: NOW, match: ftsQuery('thursday') }).claims.map((c) => c.kind),
    ['constraint']
  );
  // An unaccepted claim is never returned, even when its text is the best
  // lexical match in the store. The search may fall back to other accepted
  // claims, but THIS one stays invisible until the owner accepts it.
  const before = recallClaims(db, { now: NOW, match: ftsQuery('vegetarian') });
  assert.ok(
    !before.claims.some((c) => c.text.includes('vegetarian')),
    'unreviewed means unusable, however well it matches'
  );
  decide(db, veg, 'accept');
  const after = recallClaims(db, { now: NOW, match: ftsQuery('vegetarian') });
  assert.ok(after.claims.some((c) => c.text.includes('vegetarian')));
  assert.ok(after.matched >= 1);
  db.close();
});

test('when two accepted claims disagree, the newer one comes first and both are kept', () => {
  // v1 does not reconcile. Both stay accepted, ordering carries the recency,
  // and the human resolves the disagreement on the review page with both in
  // front of them -- rather than a model silently picking one.
  const db = openDb(':memory:');
  const [old, recent] = seed(db, [
    { ts: NOW - 400 * 86_400_000, source: 'imessage', entity_id: 'i:1', text: 'i went vegetarian this year' },
    { ts: NOW - 10 * 86_400_000, source: 'imessage', entity_id: 'i:2', text: 'i eat fish again now' },
  ]);
  decide(db, propose(db, old, { text: 'Austin is vegetarian.', quote: 'i went vegetarian' }), 'accept');
  decide(db, propose(db, recent, { text: 'Austin eats fish again.', quote: 'i eat fish again' }), 'accept');

  const { claims } = recallClaims(db, { now: NOW });
  assert.equal(claims.length, 2, 'both survive; nothing is silently dropped');
  assert.equal(claims[0].text, 'Austin eats fish again.', 'newest observation first');
});

test('a very old claim is still returned, but flagged stale', () => {
  const db = openDb(':memory:');
  const [row] = seed(db, [
    { ts: NOW - RECENCY_HORIZON_MS - 86_400_000, source: 'notes', entity_id: 'n:1', text: 'i am allergic to penicillin' },
  ]);
  decide(db, propose(db, row, { text: 'Austin is allergic to penicillin.', quote: 'allergic to penicillin' }), 'accept');
  const { claims } = recallClaims(db, { now: NOW });
  assert.equal(claims.length, 1, 'an allergy does not expire; it is not hidden');
  assert.equal(claims[0].stale, true, 'but the composer is told it is old');
  db.close();
});

test('the limit is capped so a question cannot ask for the whole store', () => {
  const db = openDb(':memory:');
  const rows = seed(
    db,
    Array.from({ length: 30 }, (_, i) => ({
      ts: NOW - i * 1000,
      source: 'imessage',
      entity_id: `i:${i}`,
      text: `sentence number ${i} about coffee`,
    }))
  );
  for (const row of rows) decide(db, propose(db, row, { text: `Fact ${row.id}.`, quote: 'coffee' }), 'accept');
  assert.equal(recallClaims(db, { now: NOW, limit: 999 }).claims.length, 25);
  assert.equal(recallClaims(db, { now: NOW, limit: 3 }).claims.length, 3);
  db.close();
});

test('grounding lines carry kind, source and date, and no quote', (t) => {
  // Dates are the OWNER's calendar day, not UTC: claim lines merge with the
  // episodic shelf's local-day lines into one numbered envelope, and the two
  // must not disagree by a day for evening events. The zone is pinned so the
  // assertions mean the same thing on any machine.
  const prevTZ = process.env.TZ;
  t.after(() => {
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  });
  process.env.TZ = 'Pacific/Honolulu';
  const lines = groundingLines([
    { id: 1, kind: 'fact', text: 'Austin is vegetarian.', observed_at: 1_700_000_000_000, source: 'imessage', stale: false },
    { id: 2, kind: 'plan', text: 'Austin is moving in March.', observed_at: null, source: 'notes', stale: true },
    // 2023-11-15T08:00Z is 22:00 on the 14th in Honolulu — the UTC rendering
    // this test replaced dated it the 15th.
    { id: 3, kind: 'fact', text: 'Dinner went well.', observed_at: Date.UTC(2023, 10, 15, 8, 0), source: 'imessage', stale: false },
  ]);
  assert.deepEqual(lines, [
    '[1] (fact, imessage, 2023-11-14) Austin is vegetarian.',
    '[2] (plan, notes, undated, OLD) Austin is moving in March.',
    '[3] (fact, imessage, 2023-11-14) Dinner went well.',
  ]);
});
