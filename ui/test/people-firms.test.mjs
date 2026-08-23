// Tests for firm grouping and warmth scoring.

import test from 'node:test';
import assert from 'node:assert/strict';
import { firmOf, warmthScore, warmthLabel, groupByFirm } from '../server/people/firms.mjs';

function p(over = {}) {
  return {
    name: 'x', identifiers: [], channels: ['mail'], channelCount: 1,
    messages: 10, reciprocity: 0.5, metInPerson: 0, dormancyDays: 200,
    relationshipDays: 300, linkedin: null, content: {}, ...over,
  };
}

test('firm comes from the investor domain, or the LinkedIn company', () => {
  assert.equal(firmOf(p({ identifiers: ['jz@character.vc'] })).key, 'character.vc');
  assert.equal(firmOf(p({ identifiers: ['a@forerunnerventures.com'] })).label, 'Forerunnerventures');
  // LinkedIn company name wins as the label when present.
  assert.equal(firmOf(p({ identifiers: ['a@x.vc'], linkedin: { company: 'Xepto Ventures' } })).label, 'Xepto Ventures');
  // No firm signal -> a solo entry keyed by name.
  assert.equal(firmOf(p({ name: 'Sam', identifiers: ['sam@gmail.com'] })).solo, true);
});

test('warmth rewards reciprocity, recency, meetings and interest', () => {
  const warm = warmthScore(p({ reciprocity: 1, dormancyDays: 30, metInPerson: 5, content: { investor: 4 } }));
  const cold = warmthScore(p({ reciprocity: 0, dormancyDays: 1500, metInPerson: 0, content: {} }));
  assert.ok(warm > cold);
  assert.equal(warmthLabel(warm), 'warm');
  assert.equal(warmthLabel(cold), 'cold');
});

test('groupByFirm clusters people and ranks firms by their warmest contact', () => {
  const firms = groupByFirm([
    p({ name: 'John', identifiers: ['john@character.vc'], reciprocity: 1, dormancyDays: 20, metInPerson: 9 }),
    p({ name: 'Jake', identifiers: ['jake@character.vc'], reciprocity: 0.3, dormancyDays: 400 }),
    p({ name: 'Danny', identifiers: ['danny@lux.vc'], reciprocity: 0, dormancyDays: 1400 }),
  ]);
  const character = firms.find((f) => f.key === 'character.vc');
  assert.equal(character.contacts.length, 2, 'two people at one firm');
  assert.equal(character.contacts[0].name, 'John', 'warmest contact first');
  assert.equal(character.metInPerson, 9);
  assert.equal(firms[0].key, 'character.vc', 'the warmer firm ranks first');
});
