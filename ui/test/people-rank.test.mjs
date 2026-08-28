// Tests for the need-card ranker. The scoring is pure and the point of the
// tests is that every ranking decision is a decision code made and can defend.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  seniorityScore,
  depthScore,
  reachable,
  scoreForNeed,
  rankForNeed,
  evidenceLine,
  isNonPerson,
  MENTOR_NEED,
} from '../server/people/rank.mjs';

function person(over = {}) {
  return {
    name: 'Sam Lee',
    channels: ['imessage', 'linkedin'],
    channelCount: 2,
    messages: 400,
    sent: 180,
    received: 220,
    reciprocity: 0.82,
    metInPerson: 3,
    dormancyDays: 200,
    relationshipDays: 900,
    linkedin: { position: 'Founder', company: 'Acme' },
    ...over,
  };
}

test('seniority reads the title, most senior first', () => {
  assert.equal(seniorityScore({ position: 'Founder & CEO' }), 5);
  assert.equal(seniorityScore({ position: 'VP of Engineering' }), 3);
  assert.equal(seniorityScore({ position: 'Staff Engineer' }), 2);
  assert.equal(seniorityScore({ position: 'Barista' }), 1, 'on linkedin at all is a weak positive');
  assert.equal(seniorityScore(null), 0);
});

test('reachable requires a message channel, not just linkedin', () => {
  assert.equal(reachable({ channels: ['linkedin'] }), false);
  assert.equal(reachable({ channels: ['linkedin'], directMessages: 2 }), true, 'a LinkedIn DM is reachable');
  assert.equal(reachable({ channels: ['linkedin', 'imessage'] }), true);
  assert.equal(reachable({ channels: ['mail'] }), true);
  for (const channel of ['messenger', 'instagram', 'twitter', 'telegram', 'discord', 'slack']) {
    assert.equal(reachable({ channels: [channel] }), true, `${channel} is a message channel`);
  }
});

test('the mentor need excludes the unreachable and the too-thin', () => {
  assert.equal(scoreForNeed(person({ channels: ['linkedin'], channelCount: 1 })).score, 0, 'a connection export alone cannot be messaged');
  assert.equal(
    scoreForNeed(person({ messages: 1, reciprocity: 0, metInPerson: 0, channels: ['imessage'], channelCount: 1, relationshipDays: 0 })).score,
    0,
    'one message is not a relationship'
  );
  assert.ok(scoreForNeed(person()).score > 0);
});

test('a senior two-way bond in the reconnect window beats a junior chatty one', () => {
  const mentor = scoreForNeed(person({ linkedin: { position: 'Founder', company: 'X' }, dormancyDays: 200 }));
  const buddy = scoreForNeed(person({ linkedin: null, dormancyDays: 1, messages: 5000, reciprocity: 0.9 }));
  assert.ok(mentor.score > buddy.score, `${mentor.score} should beat ${buddy.score}`);
  assert.ok(mentor.reasons.some((r) => /senior/u.test(r)));
  assert.ok(mentor.reasons.some((r) => /reconnect window/u.test(r)));
});

test('dormancy outside the band contributes nothing', () => {
  const fresh = scoreForNeed(person({ dormancyDays: 2 })); // below the 30-day floor
  const ancient = scoreForNeed(person({ dormancyDays: 5000 })); // above the 900 ceiling
  const sweet = scoreForNeed(person({ dormancyDays: 400 }));
  assert.ok(sweet.score > fresh.score);
  assert.ok(sweet.score > ancient.score);
});

test('rankForNeed drops non-people and sorts by score', () => {
  const graph = [
    person({ name: 'Real Founder', linkedin: { position: 'CEO', company: 'Co' } }),
    person({ name: 'no-reply@stripe.com', linkedin: null }),
    person({ name: 'Guest of Austin Yoshino', metInPerson: 40 }),
    person({ name: 'Junior Pal', linkedin: null, dormancyDays: 5, messages: 30, reciprocity: 0.5, metInPerson: 0, channels: ['imessage'], channelCount: 1 }),
  ];
  const ranked = rankForNeed(graph, MENTOR_NEED, { limit: 10 });
  const names = ranked.map((p) => p.name);
  assert.ok(!names.includes('no-reply@stripe.com'));
  assert.ok(!names.includes('Guest of Austin Yoshino'));
  assert.equal(ranked[0].name, 'Real Founder');
});

test('the evidence line carries facts and never claims a message was read', () => {
  const line = evidenceLine(person({ dormancyDays: 730 }));
  assert.match(line, /Founder at Acme/u);
  assert.match(line, /last heard from ~2\.0 years ago/u);
  assert.match(line, /400 messages/u);
  assert.ok(!/said|told|wrote|"/u.test(line), 'no message content, ever');
});

// --- investor need: the content signal ---
import { INVESTOR_NEED } from '../server/people/rank.mjs';

function investorPerson(over = {}) {
  return person({ content: { investor: 6 }, dormancyDays: 600, ...over });
}

test('the investor need requires talk of raising, not just a title', () => {
  const talked = scoreForNeed(investorPerson({ linkedin: { position: 'Founder' } }), INVESTOR_NEED);
  const silent = scoreForNeed(investorPerson({ content: {}, linkedin: { position: 'Barista' } }), INVESTOR_NEED);
  assert.ok(talked.score > 0);
  assert.equal(silent.score, 0, 'a chatty friend who never discussed a raise is not a candidate');
  assert.ok(talked.reasons.some((r) => /threads mention investor/u.test(r)));
});

test('a senior investor with no content still qualifies (title carries it)', () => {
  const partner = scoreForNeed(investorPerson({ content: {}, linkedin: { position: 'Partner', company: 'Sequoia' } }), INVESTOR_NEED);
  assert.ok(partner.score > 0, 'a Partner at a fund is a candidate even absent keyword hits');
});

test('automated senders are dropped even with heavy content hits', () => {
  const graph = [
    investorPerson({ name: 'Real Angel', identifiers: ['angel@gmail.com'], linkedin: { position: 'Angel Investor' } }),
    investorPerson({ name: 'launchhouse', identifiers: ['homescreen@mail.launchhouse.com'], content: { investor: 40 } }),
    investorPerson({ name: 'newsletter thing', identifiers: ['updates@news.vcfirm.com'], content: { investor: 50 } }),
  ];
  const names = rankForNeed(graph, INVESTOR_NEED, { limit: 10 }).map((p) => p.name);
  assert.ok(names.includes('Real Angel'));
  assert.ok(!names.includes('launchhouse'), 'mail. subdomain newsletter dropped');
  assert.ok(!names.includes('newsletter thing'), 'automated domain dropped');
});

test('content score is log-damped: fifty hits is not ten times five', () => {
  const five = scoreForNeed(investorPerson({ content: { investor: 5 } }), INVESTOR_NEED).score;
  const fifty = scoreForNeed(investorPerson({ content: { investor: 50 } }), INVESTOR_NEED).score;
  assert.ok(fifty > five);
  assert.ok(fifty < five * 2, 'damped, not linear');
});

import { investorIdentity, investorDomain } from '../server/people/rank.mjs';

test('an investor email domain IS identity, no LinkedIn needed', () => {
  assert.equal(investorDomain(['nate@newstack.vc']), true);
  assert.equal(investorDomain(['jz@character.vc']), true);
  assert.equal(investorDomain(['andrew@struckcapital.com']), true);
  assert.equal(investorDomain(['x@forerunnerventures.com']), true);
  assert.equal(investorDomain(['someone@gmail.com']), false);
  assert.equal(investorDomain(['ops@capitalone.com']), false, 'capitalone is a bank, not a VC firm');
  // A VC contact with no LinkedIn row still scores full identity.
  assert.equal(investorIdentity({ identifiers: ['danny@lux.vc'], linkedin: null }), 5);
});

test('a domain-only investor (no title) is a candidate and names its domain', () => {
  const vc = investorPerson({
    name: 'nate@newstack.vc',
    identifiers: ['nate@newstack.vc'],
    linkedin: null,
    content: {},
    channels: ['mail'],
    channelCount: 1,
  });
  const { score, reasons } = scoreForNeed(vc, INVESTOR_NEED);
  assert.ok(score > 0, 'a VC who emailed you is a candidate even with no fundraising-keyword hits');
  assert.ok(reasons.some((r) => /newstack\.vc/u.test(r)), 'the domain is named as the evidence');
});

// Apple Messages for Business: "urn:biz:<uuid>" is Apple's own statement that
// the sender is a company. Seven of these sat in the owner's people list
// (2026-08-25), one wearing order-confirmation chips.
test('a Messages-for-Business urn is a non-person, by identifier or by name', () => {
  assert.equal(isNonPerson({
    name: 'urn:biz:b15ed000-0000-0000-0000-000000000000',
    identifiers: ['urn:biz:b15ed000-0000-0000-0000-000000000000'],
  }), true);
  // The urn only ever appears at the START of a handle; a person who merely
  // mentioned the string in some identifier-shaped way stays a person.
  assert.equal(isNonPerson({ name: 'Pat Kim', identifiers: ['+18085550100'] }), false);
});

// ---- an SMS short code is not a person ----
//
// Every other non-person rule here is an email shape, and on a corpus that is
// 85% iMessage they matched nothing: 152 short codes sat in the graph as people,
// 12% of it, and their notification text became somebody's topic chips.
test('a short numeric sender is not a person, an actual phone number is', () => {
  const shortCode = (id) => person({ name: id, identifiers: [id] });
  for (const id of ['550190', '55021', '55074', '4321', '729']) {
    assert.ok(isNonPerson(shortCode(id)), `${id} is a short code`);
  }
  // The boundary that matters: seven digits and up can be a real local number,
  // and anything with a country code or a letter is left alone entirely.
  for (const id of ['+13135550002', '3135550002', '5550002', '12345678', 'sam@work.com', '99887766@lid']) {
    assert.equal(isNonPerson(shortCode(id)), false, `${id} must survive`);
  }
});

test('a short code is not rescued by looking chatty', () => {
  const p = person({ name: '550190', identifiers: ['550190'], messages: 4000, reciprocity: 1 });
  assert.ok(isNonPerson(p), 'volume is not personhood — a retailer texts a lot');
});
