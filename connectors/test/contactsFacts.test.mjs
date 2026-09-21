// The rest of the address-book card (ingestion round one, 2026-09-20): job
// title, department, nickname and relation labels read from a synthetic
// AddressBook store with the same table shapes, plus the framework-path
// equivalent. Fails against a tree whose readStore returns no `facts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readStore, relationLabel, factsFromContacts } from '../sources/contacts.mjs';

function store({ withFacts = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ZABCDRECORD(Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT${withFacts ? ', ZJOBTITLE TEXT, ZDEPARTMENT TEXT, ZNICKNAME TEXT' : ''});
    CREATE TABLE ZABCDPHONENUMBER(ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS(ZOWNER INTEGER, ZADDRESS TEXT);
    ${withFacts ? 'CREATE TABLE ZABCDRELATEDNAME(ZOWNER INTEGER, ZLABEL TEXT, ZNAME TEXT); CREATE TABLE ZABCDGROUP(Z_PK INTEGER PRIMARY KEY, ZNAME TEXT); CREATE TABLE Z_19PARENTGROUPS(Z_19CONTACTS INTEGER, Z_15PARENTGROUPS INTEGER);' : ''}`);
  if (withFacts) {
    db.prepare('INSERT INTO ZABCDGROUP VALUES (7, ?)').run('Founders');
    db.prepare('INSERT INTO Z_19PARENTGROUPS VALUES (1, 7)').run();
    db.prepare('INSERT INTO ZABCDRECORD VALUES (1, ?, ?, ?, ?, ?, ?)').run('Ada', 'Example', 'Studio', 'Head of Design', 'Product', 'Addy');
    db.prepare('INSERT INTO ZABCDRECORD VALUES (2, ?, ?, ?, ?, ?, ?)').run('Bo', 'Example', null, null, null, null);
    db.prepare('INSERT INTO ZABCDRELATEDNAME VALUES (2, ?, ?)').run('_$!<Mother>!$_', 'Ada Example');
    db.prepare('INSERT INTO ZABCDRELATEDNAME VALUES (2, ?, ?)').run('college roommate', 'X');
    db.prepare('INSERT INTO ZABCDRELATEDNAME VALUES (2, ?, ?)').run('a sentence that is far too long to be a label of any kind at all ok', 'Y');
    db.prepare('INSERT INTO ZABCDRELATEDNAME VALUES (9, ?, ?)').run('_$!<Spouse>!$_', 'Nobody'); // no such card
  } else {
    db.prepare('INSERT INTO ZABCDRECORD VALUES (1, ?, ?, ?)').run('Ada', 'Example', null);
  }
  db.prepare('INSERT INTO ZABCDPHONENUMBER VALUES (1, ?)').run('+1 (555) 010-0001');
  db.prepare('INSERT INTO ZABCDEMAILADDRESS VALUES (1, ?)').run('Ada@Example.test');
  if (withFacts) db.prepare('INSERT INTO ZABCDPHONENUMBER VALUES (2, ?)').run('+1 (555) 010-0002');
  return db;
}

test('relationLabel strips the stock wrapper, lowercases, and refuses non-labels', () => {
  assert.equal(relationLabel('_$!<Mother>!$_'), 'mother');
  assert.equal(relationLabel('College Roommate'), 'college roommate');
  assert.equal(relationLabel(''), null);
  assert.equal(relationLabel(42), null);
  assert.equal(relationLabel('a sentence that is far too long to be a label of any kind at all ok'), null);
  assert.equal(relationLabel('sister-in-law'), 'sister-in-law');
});

test('readStore returns the card facts beside the identifiers, keyed by the same person_ref', () => {
  const { entries, facts, reason } = readStore(store());
  assert.equal(reason, null);
  const ada = entries.find((e) => e.displayName === 'Ada Example');
  const bo = entries.find((e) => e.displayName === 'Bo Example');
  assert.ok(ada && bo);
  const adaFacts = facts.find((f) => f.personRef === ada.personRef);
  const boFacts = facts.find((f) => f.personRef === bo.personRef);
  assert.deepEqual(adaFacts, { personRef: ada.personRef, jobTitle: 'Head of Design', department: 'Product', nickname: 'Addy', relationLabels: [], groups: ['Founders'] });
  assert.deepEqual(boFacts, { personRef: bo.personRef, jobTitle: null, department: null, nickname: null, relationLabels: ['mother', 'college roommate'], groups: [] });
  assert.equal(facts.length, 2, 'the orphan label on a card that does not exist is dropped');
});

test('an older store shape reads as no facts, not a failure', () => {
  const { entries, facts, reason } = readStore(store({ withFacts: false }));
  assert.equal(reason, null);
  assert.equal(entries.length, 2);
  assert.deepEqual(facts, []);
});

test('the framework path reads the same facts from the helper shape and tolerates an older helper', () => {
  const facts = factsFromContacts([
    { contactId: 'c1', displayName: 'Ada Example', phones: ['+15550100001'], emails: [], jobTitle: ' Head of Design ', relations: [{ label: '_$!<Friend>!$_', name: 'Bo' }, { label: '' }], groups: ['Founders', ' '] },
    { contactId: 'c2', displayName: 'Bo Example', phones: ['+15550100002'], emails: [] },
    { displayName: '', phones: ['+15550100003'] },
  ]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].jobTitle, 'Head of Design');
  assert.deepEqual(facts[0].relationLabels, ['friend']);
  assert.deepEqual(facts[0].groups, ['Founders']);
  assert.equal(typeof facts[0].personRef, 'string');
});
