import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupClaims, similarity, tokens, SIMILAR_ENOUGH } from '../server/memory/group.mjs';

const claim = (id, text, kind = 'fact') => ({ id, text, kind });

test('the words every claim shares do not make claims similar', () => {
  // Without the noise list these two are "the owner is" plus one word each, and
  // Jaccard rates them far higher than they deserve.
  assert.deepEqual(tokens('The owner is vegetarian.'), ['vegetarian']);
  assert.ok(
    similarity('The owner is vegetarian.', 'The owner is Australian.') < SIMILAR_ENOUGH,
    'two unrelated facts in the same sentence frame are not the same claim'
  );
});

// The real duplicate: one fact, four messages about it, four rows distilled at
// temperature 0 into the same sentence. On a real corpus this was six claims and
// one group of seven.
test('a claim repeated across rows lands in one group', () => {
  const groups = groupClaims([
    claim(1, 'The owner is flying to Honolulu on the 14th.'),
    claim(2, 'The owner is flying to Honolulu on the 14th.'),
    claim(3, 'The owner is flying to Honolulu on the 14th'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, 3);
  assert.deepEqual(groups[0].ids, [1, 2, 3]);
  assert.equal(groups[0].lead.id, 1, 'the first arrival leads; the queue is already ranked');
});

// The line this deliberately does NOT cross. These mean the same thing to a
// reader and share one content word, so they stay apart — the threshold that
// would merge them also merges genuinely different facts (see below).
test('a paraphrase is not treated as a repeat', () => {
  const groups = groupClaims([
    claim(1, 'The owner is allergic to penicillin.'),
    claim(2, 'The owner has an allergy to penicillin.'),
  ]);
  assert.equal(groups.length, 2, 'two decisions, because merging these costs more than it saves');
});

// THE FAILURE THAT SET THE THRESHOLD. These share their whole sentence frame and
// differ only in the two words that carry the meaning. Merging them would answer
// for both from one reading, which is the one outcome grouping must never cause.
test('same shape, different facts, two groups', () => {
  const groups = groupClaims([
    claim(1, 'The owner flies to Honolulu on the 14th.'),
    claim(2, 'The owner flies to Denver on the 2nd.'),
  ]);
  assert.equal(groups.length, 2, 'a different destination and date is a different claim');
});

test('kind separates claims that share their words', () => {
  const groups = groupClaims([
    claim(1, 'The owner runs on Tuesday mornings.', 'fact'),
    claim(2, 'The owner runs on Tuesday mornings.', 'plan'),
  ]);
  assert.equal(groups.length, 2, 'a standing fact and a one-off plan are different assertions');
});

test('grouping preserves order and loses no claim', () => {
  const input = [
    claim(1, 'The owner is allergic to penicillin.'),
    claim(2, 'The owner prefers window seats.'),
    claim(3, 'The owner has an allergy to penicillin.'),
  ];
  const groups = groupClaims(input);
  const flat = groups.flatMap((g) => g.ids).sort((a, b) => a - b);
  assert.deepEqual(flat, [1, 2, 3], 'every claim appears exactly once across the groups');
  assert.equal(groups[0].lead.id, 1, 'first in, first out');
});

test('junk in the list does not take the queue down with it', () => {
  const groups = groupClaims([null, claim(1, 'The owner cycles to work.'), 'nope', undefined]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].lead.id, 1);
  assert.deepEqual(groupClaims(null), [], 'a missing list is an empty queue, not a crash');
});

// ── the relevance bar on point-of-use suggestions ───────────────────────────
import { sharesContent } from '../server/memory/retrieve.mjs';

// A confirmation card interrupts to assert "this would have answered you". bm25
// ORs every term including stopwords, so on a real corpus "what do i eat" ranked
// a claim about product development first — the two share the word "what". Good
// enough to rank by, nowhere near good enough to interrupt on.
test('a suggestion must share a content word with the question', () => {
  assert.equal(sharesContent('what do i eat', 'The owner eats fish again.'), true);
  assert.equal(
    sharesContent('what do i eat', "The owner plans to separate what's risky from what's valuable."),
    false,
    'sharing only question scaffolding is not sharing a subject'
  );
});

// Word forms, which is most of what a question does to a claim's vocabulary.
test('ordinary word forms line up', () => {
  assert.equal(sharesContent('where do i live', 'The owner lives in Chicago.'), true);
  assert.equal(sharesContent('when do i fly', 'The owner flies to Denver on the 2nd.'), true);
  assert.equal(sharesContent('what am i doing friday', 'The owner is flying to Denver on Friday.'), true);
});

// The known gap, written down rather than hidden: this is lexical, so a question
// and a claim that share a meaning but no word stem do not match. It under-suggests
// instead of over-suggesting, which is the right direction — a wrong guess offered
// as a memory is worse than no offer.
test('a synonym is still a miss, and that is the safe direction', () => {
  assert.equal(sharesContent('any allergies', 'The owner is allergic to penicillin.'), false);
  assert.equal(sharesContent('whats my job', 'The owner prefers mornings to evenings.'), false);
});
