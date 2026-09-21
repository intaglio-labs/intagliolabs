// Facts the spine knows and the corpus cannot prove (ingestion round one,
// 2026-09-20) reach the projection and the judgment state: the rest of the
// contact card by person_ref, and tapback counts by chat. Fails against a
// tree without writeSpineFacts (the import throws).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { insertRows, openDb } from '../server/hermes.mjs';
import { refreshPeopleProjection, writeSpineFacts } from '../server/people/projection.mjs';
import { buildPersonState } from '../server/relationship/personState.mjs';

const NOW = Date.UTC(2027, 0, 1, 12);
const owner = () => ({
  addresses: new Set(['owner@example.test']), names: ['Owner'], keys: new Set(),
  schools: [], highSchools: [], roles: new Map(), rolesByYear: new Map(),
});

function spine({ facts = true, reactions = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids(identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, person_ref TEXT, source TEXT, updated_ts INTEGER)');
  db.prepare('INSERT INTO contact_ids VALUES(?,?,?,?,?,?)').run('+15550100', 'Ada Example', 'phone', 'ref-ada', 'contacts', NOW);
  if (facts) {
    db.exec('CREATE TABLE contact_facts(person_ref TEXT PRIMARY KEY, job_title TEXT, department TEXT, nickname TEXT, relation_labels TEXT, groups TEXT, updated_ts INTEGER)');
    db.prepare('INSERT INTO contact_facts VALUES(?,?,?,?,?,?,?)').run('ref-ada', 'Head of Design', null, 'Addy', '["mother"]', '[]', NOW);
    db.prepare('INSERT INTO contact_facts VALUES(?,?,?,?,?,?,?)').run('ref-nobody', 'Ghost', null, null, '[]', '[]', NOW);
  }
  if (reactions) {
    db.exec('CREATE TABLE imessage_reactions(chat_guid TEXT, from_me INTEGER, count INTEGER, updated_ts INTEGER, PRIMARY KEY(chat_guid, from_me))');
    db.prepare('INSERT INTO imessage_reactions VALUES(?,?,?,?)').run('iMessage;-;+15550100', 0, 7, NOW);
    db.prepare('INSERT INTO imessage_reactions VALUES(?,?,?,?)').run('iMessage;-;+15550100', 1, 3, NOW);
    db.prepare('INSERT INTO imessage_reactions VALUES(?,?,?,?)').run('iMessage;+;chat999', 0, 50, NOW);
  }
  return db;
}

function corpus() {
  const db = openDb(':memory:');
  for (let i = 0; i < 3; i += 1) {
    insertRows(db, {
      ts: NOW - (i + 1) * 86_400_000, source: 'imessage', entity_id: `i:${i}`, text: `hello there number ${i}`,
      meta: { chat_handle: '+15550100', chat_guid: 'iMessage;-;+15550100', is_from_me: i === 1 },
    });
  }
  return db;
}

test('the projection copies contact facts and reaction totals per person, and the state reads them as words', () => {
  const db = corpus();
  const { graph } = refreshPeopleProjection(db, spine(), { now: NOW, owner: owner(), force: true });
  const ada = graph.find((p) => p.name === 'Ada Example');
  assert.ok(ada, 'the contact is a person');
  const facts = db.prepare('SELECT * FROM person_contact_facts').all();
  assert.equal(facts.length, 1, 'the fact row for a card that is not a person is dropped');
  assert.equal(facts[0].person_key, ada.key);
  assert.equal(facts[0].job_title, 'Head of Design');
  assert.equal(facts[0].relation_labels, '["mother"]');
  const reactions = db.prepare('SELECT * FROM person_reactions').all().map((r) => ({ ...r }));
  assert.deepEqual(reactions, [{ person_key: ada.key, from_them: 7, from_owner: 3 }], 'the room chat with no person is skipped');

  const state = buildPersonState(db, ada.key, { now: NOW });
  assert.deepEqual(state.professional.contact, { job_title: 'Head of Design', nickname: 'Addy', relation_labels: ['mother'] });
  assert.equal(state.relationship_shape.reactions_from_them, 'a couple dozen', '7 tapbacks, in the bucket words the state uses');
  assert.equal(state.relationship_shape.reactions_from_owner, 'a handful');
  assert.ok(!JSON.stringify(state).includes('"7"'), 'counts are words');
});

test('a spine from before round one has no fact tables and the projection still builds', () => {
  const db = corpus();
  const { graph } = refreshPeopleProjection(db, spine({ facts: false, reactions: false }), { now: NOW, owner: owner(), force: true });
  assert.ok(graph.length >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM person_contact_facts').get().n, 0);
  const state = buildPersonState(db, graph.find((p) => p.name === 'Ada Example').key, { now: NOW });
  assert.equal(state.professional.contact, undefined);
  assert.equal(state.relationship_shape.reactions_from_them, undefined);
  assert.deepEqual(writeSpineFacts(db, null), { facts: 0, reactions: 0 });
});
