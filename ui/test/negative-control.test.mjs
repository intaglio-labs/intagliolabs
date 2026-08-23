// NEGATIVE CONTROLS. What does this system do when the answer is not there?
//
// Every other suite in this directory asks whether a right answer comes back.
// These ask the opposite, because a retrieval layer that always returns
// something cannot tell you it has nothing, and the failure is invisible: the
// owner sees a confident answer and no sign that it rested on nothing.
//
// WHY THIS FILE EXISTS, from the sibling project's bill. The rig's linker
// scored every one of 7,347 claims against a planted decoy goal and linked all
// 7,347 -- a link rate of 1.00 -- because a ranking cannot say "no match", it
// can only say "least bad". The two fixes that followed were worse: both set
// the score floor ABOVE the maximum signal ever observed, so the linker
// admitted nothing at all while reporting a perfect decoy rate. Three numbers,
// all of which read as success, none of which were. The only thing that ever
// caught it was planting something that SHOULD NOT match and measuring how
// often it did.
//
// prompts/answer_from_claims.md makes the strongest claim in this system --
// "if the notes do not answer the question, say so plainly and stop". These
// tests measure the layer underneath that sentence. They are deliberately
// hermetic: no model, no network. What a model does with a window of claims is
// a separate question; what this layer HANDS it is this one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertRows, applyMemoryBatch, ftsQuery } from '../server/hermes.mjs';
import { recallClaims, DEFAULT_RECALL_LIMIT } from '../server/memory/retrieve.mjs';
import { candidatePairs } from '../server/people/resolve.mjs';

const NOW = 1_800_000_000_000;
const RUN = { model: 'm', prompt_path: 'p', prompt_sha: 's', params: {} };

// A small accepted store shaped like the real one: the owner's own durable
// claims, each accepted one at a time. Nothing here concerns films, cars,
// mortgages, shoes or birthdays -- that is the point.
const CORPUS = [
  ['n:1', 'im allergic to penicillin', 'fact', 'Austin is allergic to penicillin.', 'allergic to penicillin'],
  ['n:2', "can't do thursday mornings, physio", 'constraint', 'Austin cannot do Thursday mornings; he has weekly physio.', "can't do thursday mornings"],
  ['n:3', 'i take the 7am train on weekdays', 'fact', 'Austin takes the 7am train on weekdays.', 'take the 7am train'],
  ['n:4', "we're moving to denver in march, signed the lease", 'plan', 'Austin is moving to Denver in March.', 'moving to denver in march'],
  ['n:5', 'i went vegetarian in january', 'fact', 'Austin went vegetarian in January.', 'went vegetarian'],
  ['n:6', 'id rather do mornings than evenings', 'preference', 'Austin prefers mornings to evenings.', 'rather do mornings'],
  ['n:7', 'i cant drive', 'constraint', 'Austin cannot drive.', 'cant drive'],
];

// Questions whose answers are genuinely absent from CORPUS. Ordinary things an
// owner would ask, none of them covered -- this is the decoy set.
const ABSENT = [
  "what's my favourite film?",
  'what shoe size am i?',
  'when is my sisters birthday?',
  'what rate is my mortgage on?',
  'what car do i drive?',
  'who is my dentist?',
  'what did i weigh last year?',
  'what is my blood type?',
];

// Questions CORPUS does answer, as the positive half of the same measurement.
// A control that only tests absence cannot tell "correctly silent" from
// "silent about everything".
const PRESENT = [
  'am i allergic to anything?',
  'can i book you thursday morning?',
  'how do you get to work?',
  'are we still moving to denver?',
  'do you eat meat?',
];

function seeded() {
  const db = openDb(':memory:');
  const rows = insertRows(db, CORPUS.map(([entity_id, text], i) => ({
    ts: NOW - i * 86_400_000, source: 'notes', entity_id, text,
  }))) && db.prepare('SELECT id, entity_id FROM context ORDER BY id').all();

  for (const [entity_id, , kind, text, quote] of CORPUS) {
    const row = rows.find((r) => r.entity_id === entity_id);
    const { run_id } = applyMemoryBatch(db, {
      run: RUN,
      claims: [{ kind, text, source: { context_id: Number(row.id), quote } }],
    });
    const id = Number(db.prepare('SELECT max(id) AS id FROM claim WHERE run_id = ?').get(run_id).id);
    db.prepare(
      'INSERT INTO claim_decision(claim_id, action, actor, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, 'accept', 'owner', NOW);
  }
  return db;
}

// ---------------------------------------------------------------- retrieval

// THE MEASUREMENT. `abstain` is documented as meaning "there is nothing
// accepted here at all", and that is exactly what it means -- it is
// `claims.length === 0`, and the unconditional top-up refills the window from
// the most recent accepted claims whenever the search under-fills it. So on any
// non-empty store abstain is false for EVERY question, answerable or not.
//
// That is a deliberate design decision with a measured reason behind it (the
// "any allergies?" case, where lexical search missed a claim the store held),
// and this test does not argue with it. It pins the consequence, which was not
// written down anywhere: abstention is delegated ENTIRELY to the composer. The
// retrieval layer hands over a full window either way, so the model prompt is
// the only thing between an unanswerable question and a confident answer.
test('every unanswerable question still receives a full window of claims', () => {
  const db = seeded();
  const results = ABSENT.map((q) => ({ q, out: recallClaims(db, { now: NOW, match: ftsQuery(q) }) }));

  for (const { q, out } of results) {
    assert.equal(out.abstain, false, `${q}: abstain is store-emptiness, not relevance`);
    assert.equal(
      out.claims.length,
      Math.min(DEFAULT_RECALL_LIMIT, CORPUS.length),
      `${q}: a full window arrives regardless`
    );
  }

  // Stated as a rate so the number is in the repo rather than in someone's head.
  const handedEvidence = results.filter(({ out }) => out.claims.length > 0).length;
  assert.equal(
    handedEvidence,
    ABSENT.length,
    `${handedEvidence}/${ABSENT.length} unanswerable questions were handed evidence. ` +
      `If this ever drops, the retrieval layer started refusing on its own and ` +
      `hermes.mjs should be gating on it.`
  );
  db.close();
});

// THE SIGNAL THAT LOOKS LIKE AN ANCHOR AND IS NOT. `matched` -- the count of
// true lexical hits before the top-up -- is already computed and returned, and
// it is the obvious candidate for "did we actually have support for this?".
// Nothing consumes it; hermes.mjs gates on `abstain` alone.
//
// It does not work, and the numbers are recorded here so nobody has to
// rediscover it. Measured against the corpus above on 2026-08-23:
//
//   ABSENT   0  0  2  3  2  2  0  2      five of eight score nonzero
//   PRESENT  3  2  4  3  1
//
// The distributions overlap, and not marginally -- "what rate is my mortgage
// on?" scores 3, the same as "are we still moving to denver?" and higher than
// "do you eat meat?" at 1. The cause is visible in ftsQuery's output: the query
// ORs every word, so "is", "do" and "i" hit claim text on their own. bm25 fixes
// the RANKING this causes, which is what the comment in retrieve.mjs is about;
// it cannot fix a raw COUNT, because a ranking function does not change how many
// rows matched.
//
// Same shape as the sibling project's vector failure and worth putting beside
// it: there, no threshold separated "gym" (+2.39) from "photosynthesis" (+2.37).
// Here the separation is not merely absent but inverted. The lesson is not
// "lexical good, vectors bad" -- it is that any scalar you did not deliberately
// build to be zero will be nonzero on garbage, and the only way to find out is
// to plant garbage and look.
//
// A usable anchor is buildable -- count hits from content words only, ignoring
// the stopwords ftsQuery ORs in -- but that changes retrieval semantics and is
// not this file's job. This test pins the defect so the fix can be measured
// against it.
test('matched is NOT a usable anchor: no threshold separates the two sets', () => {
  const db = seeded();
  const score = (q) => recallClaims(db, { now: NOW, match: ftsQuery(q) }).matched;

  const absent = ABSENT.map((q) => [q, score(q)]);
  const present = PRESENT.map((q) => [q, score(q)]);

  const maxAbsent = Math.max(...absent.map(([, n]) => n));
  const minPresent = Math.min(...present.map(([, n]) => n));

  // If a separating threshold existed, every present question would outscore
  // every absent one. It does not. Written as an assertion rather than a
  // comment so that FIXING the stopword counting turns this red and whoever
  // fixes it has to come here and say so.
  assert.ok(
    minPresent <= maxAbsent,
    `matched now separates the sets (min present ${minPresent} > max absent ` +
      `${maxAbsent}). If that is a real improvement, replace this test with the ` +
      `threshold it earned and wire hermes.mjs' gate to it -- do not just delete ` +
      `this assertion.`
  );

  // And the specific inversion, named: at least one unanswerable question
  // outscores at least one answerable one.
  const inversions = absent.filter(([, a]) => present.some(([, p]) => a > p));
  assert.ok(
    inversions.length > 0,
    'expected at least one unanswerable question to outscore an answerable one'
  );

  // The half that IS reliable: a question sharing no word at all with the store
  // really does score zero. That is the only honest use of this number today.
  assert.equal(score("what's my favourite film?"), 0);
  assert.equal(score('what shoe size am i?'), 0);
  db.close();
});

// The horizon is the other way a claim leaves the answer set, and it must not
// take the whole store with it: an old-but-accepted claim is still evidence,
// flagged stale rather than dropped.
test('a stale corpus is marked stale, not silently emptied', () => {
  const db = seeded();
  const out = recallClaims(db, { now: NOW + 900 * 86_400_000, match: ftsQuery('penicillin') });
  assert.equal(out.abstain, false, 'age must not empty the store');
  assert.ok(out.claims.every((c) => c.stale), 'every claim past the horizon reads stale');
  db.close();
});

// ------------------------------------------------------------------- people

// The identity decoy. graph.mjs splits when unsure and resolve.mjs never
// auto-merges, so the exposure is not a wrong merge -- it is a wrong QUESTION:
// a stranger proposed as "probably the same person" trains the owner to click
// yes. A candidate is supposed to mean same surname in a nickname form, or the
// same email name across two domains. Two unrelated people share neither.
test('a stranger is never proposed as the same person as someone known', () => {
  const known = { key: 'name:austin reed', name: 'Austin Reed', names: ['Austin Reed'], identifiers: ['austin@reed.example'], channels: ['imessage'], messages: 40 };
  const strangers = [
    { key: 'name:priya venkatesan', name: 'Priya Venkatesan', names: ['Priya Venkatesan'], identifiers: ['priya@elsewhere.example'], channels: ['imessage'], messages: 12 },
    { key: 'name:tomasz nowak', name: 'Tomasz Nowak', names: ['Tomasz Nowak'], identifiers: ['tnowak@other.example'], channels: ['whatsapp'], messages: 9 },
    { key: 'name:mei lin', name: 'Mei Lin', names: ['Mei Lin'], identifiers: [], channels: ['imessage'], messages: 3 },
  ];

  // candidatePairs returns {pairs, total, dropped} -- not an array.
  const { pairs } = candidatePairs([known, ...strangers]);
  const withKnown = pairs.filter((p) => p.a?.key === known.key || p.b?.key === known.key);
  assert.deepEqual(
    withKnown.map((p) => `${p.a.key} ~ ${p.b.key}`),
    [],
    'an unrelated name must not be offered as a merge candidate'
  );

  // And the positive half: a real nickname pair IS still found, so the test
  // above is not passing because the detector went blind.
  const { pairs: nick } = candidatePairs([
    { key: 'name:mike reed', name: 'Mike Reed', names: ['Mike Reed'], identifiers: [], channels: ['imessage'], messages: 5 },
    { key: 'name:michael reed', name: 'Michael Reed', names: ['Michael Reed'], identifiers: [], channels: ['imessage'], messages: 5 },
  ]);
  assert.ok(nick.length >= 1, 'the detector still finds a genuine nickname pair');
});
