// Tests for the "ask, don't guess" resolution layer: the decisions store, the
// alias map that folds confirmed merges back in, and the candidate detector
// that produces the "not sure" pile. All code, no model — same discipline as
// the graph it sits over.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureResolutionsSchema, recordDecision, loadResolutions,
  aliasMap, resolutionState, candidatePairs, pairId,
} from '../server/people/resolve.mjs';

// A resolved-person stub shaped like buildGraph output.
function person(key, name, over = {}) {
  return { key, name, names: over.names ?? [name], identifiers: over.identifiers ?? [], channels: over.channels ?? ['imessage'], messages: over.messages ?? 3 };
}

function db() {
  const d = new DatabaseSync(':memory:');
  ensureResolutionsSchema(d);
  return d;
}

// ---------------- decisions store ----------------

test('a decision is stored order-independently and round-trips', () => {
  const d = db();
  recordDecision(d, 'id:b', 'name:a', 'same', 1000);
  const { same, differentPairs } = loadResolutions(d);
  assert.equal(same.length, 1);
  // Stored sorted, so (b,a) and (a,b) are one pair.
  assert.deepEqual(same[0].sort(), ['id:b', 'name:a'].sort());
  assert.equal(differentPairs.size, 0);
});

test('skip records nothing — the pair stays undecided', () => {
  const d = db();
  recordDecision(d, 'x', 'y', 'skip');
  assert.equal(loadResolutions(d).same.length, 0);
  assert.equal(loadResolutions(d).differentPairs.size, 0);
});

test('a later decision overwrites the earlier for the same pair', () => {
  const d = db();
  recordDecision(d, 'x', 'y', 'same', 1);
  recordDecision(d, 'y', 'x', 'different', 2); // reversed order, same pair
  const { same, differentPairs } = loadResolutions(d);
  assert.equal(same.length, 0);
  assert.equal(differentPairs.size, 1);
});

test('an unknown verdict throws rather than storing garbage', () => {
  const d = db();
  assert.throws(() => recordDecision(d, 'x', 'y', 'maybe'));
});

// ---------------- alias map (union-find) ----------------

test('confirmed-same edges collapse to one deterministic canonical key', () => {
  // a=b, b=c  ->  all three share a canonical, the smallest key.
  const aliases = aliasMap([['name:mike chen', 'id:+1555'], ['id:+1555', 'liname:mike']]);
  const canon = (k) => aliases.get(k) ?? k;
  const roots = new Set([canon('name:mike chen'), canon('id:+1555'), canon('liname:mike')]);
  assert.equal(roots.size, 1);
  // Canonical is the lexicographically smallest key, so it is stable run to run.
  const smallest = ['name:mike chen', 'id:+1555', 'liname:mike'].sort()[0];
  assert.equal(canon('id:+1555'), smallest);
  assert.equal(aliases.has(smallest), false); // the root is not aliased
});

test('resolutionState marks both same and different pairs as decided', () => {
  const d = db();
  recordDecision(d, 'a', 'b', 'same');
  recordDecision(d, 'c', 'd', 'different');
  const { aliases, decided } = resolutionState(d);
  assert.ok(aliases.size >= 1);           // a/b merged
  assert.ok(decided.has(pairId('a', 'b')));
  assert.ok(decided.has(pairId('c', 'd')));
});

// ---------------- candidate detection ----------------

test('same surname + nickname first name is proposed as a candidate', () => {
  const people = [
    person('name:mike chen', 'Mike Chen'),
    person('name:michael chen', 'Michael Chen'),
  ];
  const { pairs } = candidatePairs(people);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].reason, /nickname/);
  assert.equal(pairs[0].score, 3);
});

test('prefix nicknames the curated list misses are still caught (Dan/Daniel)', () => {
  const people = [person('a', 'Dan Rivera'), person('b', 'Daniel Rivera')];
  assert.equal(candidatePairs(people).pairs.length, 1);
});

test('a decided pair is never proposed again', () => {
  const people = [person('name:mike chen', 'Mike Chen'), person('name:michael chen', 'Michael Chen')];
  const decided = new Set([pairId('name:mike chen', 'name:michael chen')]);
  assert.equal(candidatePairs(people, { decided }).pairs.length, 0);
});

test('different surnames are NOT proposed, however close the first names', () => {
  const people = [person('a', 'Mike Chen'), person('b', 'Michael Alvarez')];
  assert.equal(candidatePairs(people).pairs.length, 0);
});

test('same email name across two domains is proposed', () => {
  const people = [
    person('id:mike.chen@gmail.com', 'mike.chen@gmail.com', { identifiers: ['mike.chen@gmail.com'], channels: ['mail'] }),
    person('id:mike.chen@acme.co', 'mike.chen@acme.co', { identifiers: ['mike.chen@acme.co'], channels: ['mail'] }),
  ];
  const { pairs } = candidatePairs(people);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].reason, /email name/);
});

test('a short email local-part is too generic to join two people on', () => {
  // "hi@" is 2 chars — below the length floor, so it is not used as a join key,
  // and the email-shaped display names are ignored for surname bucketing too.
  const people = [
    person('id:hi@a.com', 'hi@a.com', { identifiers: ['hi@a.com'], channels: ['mail'] }),
    person('id:hi@b.com', 'hi@b.com', { identifiers: ['hi@b.com'], channels: ['mail'] }),
  ];
  assert.equal(candidatePairs(people).pairs.length, 0);
});

test('a bare first-name local-part does NOT join two people (Andy != Andy)', () => {
  // A private corpus contained many bare first-name addresses across domains;
  // they are different people. Only a full-name-shaped local-part joins.
  const people = [
    person('id:andy@alpha.example', 'andy@alpha.example', { identifiers: ['andy@alpha.example'], channels: ['mail'] }),
    person('id:andy@beta.example', 'andy@beta.example', { identifiers: ['andy@beta.example'], channels: ['mail'] }),
  ];
  assert.equal(candidatePairs(people).pairs.length, 0);
});

test('role addresses never join, in any separator form (no_reply/no-reply)', () => {
  const people = [
    person('id:no_reply@am.atlassian.com', 'no_reply@am.atlassian.com', { identifiers: ['no_reply@am.atlassian.com'], channels: ['mail'] }),
    person('id:no-reply@email.heygen.com', 'no-reply@email.heygen.com', { identifiers: ['no-reply@email.heygen.com'], channels: ['mail'] }),
  ];
  assert.equal(candidatePairs(people).pairs.length, 0);
});

test('a full-name local-part still joins across domains (mike.chen)', () => {
  const people = [
    person('id:mike.chen@gmail.com', 'mike.chen@gmail.com', { identifiers: ['mike.chen@gmail.com'], channels: ['mail'] }),
    person('id:mike.chen@acme.co', 'mike.chen@acme.co', { identifiers: ['mike.chen@acme.co'], channels: ['mail'] }),
  ];
  assert.equal(candidatePairs(people).pairs.length, 1);
});

test('email-shaped display names never bucket by a fake "com" surname', () => {
  // Two unrelated gmail users: no real name, no shared local-part. They must
  // NOT be proposed just because both display names end in ".com".
  const people = [
    person('id:alice.smith@gmail.com', 'alice.smith@gmail.com', { identifiers: ['alice.smith@gmail.com'], channels: ['mail'] }),
    person('id:bob.jones@gmail.com', 'bob.jones@gmail.com', { identifiers: ['bob.jones@gmail.com'], channels: ['mail'] }),
  ];
  assert.equal(candidatePairs(people).pairs.length, 0);
});

test('the pile is capped and reports how many were dropped', () => {
  // 20 Smiths in nickname pairs -> 10 pairs; cap at 4 keeps 4, drops 6.
  const people = [];
  const firsts = [['mike', 'michael'], ['dan', 'daniel'], ['rob', 'robert'], ['jim', 'james'],
    ['tom', 'thomas'], ['sam', 'samuel'], ['ben', 'benjamin'], ['tim', 'timothy'],
    ['ron', 'ronald'], ['don', 'donald']];
  firsts.forEach(([a, b], i) => {
    people.push(person(`a${i}`, `${a} sur${i}`));
    people.push(person(`b${i}`, `${b} sur${i}`));
  });
  const { pairs, total, dropped } = candidatePairs(people, { limit: 4 });
  assert.equal(pairs.length, 4);
  assert.equal(total, 10);
  assert.equal(dropped, 6);
});

test('identical first+last but unmerged is a weaker (score 2) candidate', () => {
  const people = [
    person('name:john a smith', 'John A Smith', { names: ['John A Smith'] }),
    person('name:john smith', 'John Smith', { names: ['John Smith'] }),
  ];
  const { pairs } = candidatePairs(people);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].score, 2);
  assert.match(pairs[0].reason, /same first and last/);
});

// ---------------- signal 3: the address spells the name ----------------
// The case signals 1 and 2 both miss, straight off the owner's list: a person
// keyed by a bare email whose DOMAIN is another person's first+last. The
// email-keyed row has no real name (no surname bucket) and a bare-first-name
// local part (rightly refused by the full-name shape rule), so before this
// signal the pair was invisible.

test('a personal domain spelling the name proposes that pair', () => {
  const { pairs } = candidatePairs([
    person('name:mika tanaka', 'Mika Tanaka'),
    person('id:mika@mikatanaka.com', 'mika@mikatanaka.com',
      { names: ['mika@mikatanaka.com'], identifiers: ['mika@mikatanaka.com'] }),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].reason, 'the address spells this name');
  assert.equal(pairs[0].score, 3);
});

test('a first+last local-part on a freemail domain proposes it too', () => {
  const { pairs } = candidatePairs([
    person('name:mika tanaka', 'Mika Tanaka'),
    person('id:mikatanaka@gmail.com', 'mikatanaka@gmail.com',
      { names: ['mikatanaka@gmail.com'], identifiers: ['mikatanaka@gmail.com'] }),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].reason, 'the address spells this name');
});

test('short concatenations and unrelated domains propose nothing', () => {
  // "Bo Li" concatenates to four letters — collision territory, refused.
  const { pairs: short } = candidatePairs([
    person('name:bo li', 'Bo Li'),
    person('id:boli@gmail.com', 'boli@gmail.com',
      { names: ['boli@gmail.com'], identifiers: ['boli@gmail.com'] }),
  ]);
  assert.equal(short.length, 0);
  // A company domain that spells nobody's name stays a stranger.
  const { pairs: none } = candidatePairs([
    person('name:mika tanaka', 'Mika Tanaka'),
    person('id:orders@acmestore.com', 'orders@acmestore.com',
      { names: ['orders@acmestore.com'], identifiers: ['orders@acmestore.com'] }),
  ]);
  assert.equal(none.length, 0);
});

test('signal 3 respects prior decisions like every other signal', () => {
  const a = 'name:mika tanaka', b = 'id:mika@mikatanaka.com';
  const { pairs } = candidatePairs([
    person(a, 'Mika Tanaka'),
    person(b, 'mika@mikatanaka.com',
      { names: ['mika@mikatanaka.com'], identifiers: ['mika@mikatanaka.com'] }),
  ], { decided: new Set([pairId(a, b)]) });
  assert.equal(pairs.length, 0);
});
