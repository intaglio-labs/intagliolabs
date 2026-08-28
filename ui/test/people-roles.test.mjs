import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  RELATIONSHIP_ROLES,
  guessRelationshipRole,
  inferRelationshipRoleIndex,
  scoreRoleName,
  scoreRoleText,
} from '../server/people/roles.mjs';

test('relationship roles are inferred from direct-message language conservatively', () => {
  assert.equal(guessRelationshipRole(scoreRoleText("You're my girlfriend")), 'romantic');
  assert.equal(guessRelationshipRole(scoreRoleText('Love you')), 'friend');
  assert.equal(guessRelationshipRole(scoreRoleText('Miss you')), 'friend');
  assert.equal(guessRelationshipRole(scoreRoleText('Babe can you send that photo?')), 'friend');
  const romantic = scoreRoleText('Love you babe');
  scoreRoleText('Goodnight baby', romantic);
  scoreRoleText('Miss you so much, my love', romantic);
  assert.equal(guessRelationshipRole(romantic), 'friend', 'three affectionate messages are not enough');
  scoreRoleText('Date night tomorrow', romantic);
  assert.equal(guessRelationshipRole(romantic), 'romantic', 'repeated coupled romantic evidence may decide');
  assert.equal(guessRelationshipRole(scoreRoleText('Dinner with mom and grandma on Sunday')), 'friend');
  assert.equal(guessRelationshipRole(scoreRoleText('My sister is visiting next week')), 'friend');
  const addressedFamily = scoreRoleText('Love you mom');
  scoreRoleText('Goodnight mom', addressedFamily);
  assert.equal(guessRelationshipRole(addressedFamily), 'family');
  assert.equal(guessRelationshipRole(scoreRoleText("You're my sister")), 'family');
  assert.equal(guessRelationshipRole(scoreRoleName('Big Bro Example')), 'family');
  assert.equal(guessRelationshipRole(scoreRoleName('Mother 👱‍♀️')), 'family');
  assert.equal(guessRelationshipRole(scoreRoleName('Casey Example')), 'friend');
  const business = scoreRoleText('Can we review the deck before the investor meeting?');
  scoreRoleText('The roadmap and launch plan need a client review.', business);
  scoreRoleText('I sent the contract and invoice to the customer.', business);
  assert.equal(guessRelationshipRole(business), 'business');
  assert.equal(guessRelationshipRole(scoreRoleText('Want to grab coffee this weekend?')), 'friend');
});

test('loaded relationship labels stay inside the four-role vocabulary', () => {
  assert.equal(guessRelationshipRole({ business: 100, family: 3, romantic: 0 }), 'business');
  assert.equal(guessRelationshipRole({ business: 100, family: 10, romantic: 0 }), 'family');
  assert.equal(guessRelationshipRole({ business: 100, family: 0, romantic: 4 }), 'romantic');
  assert.equal(guessRelationshipRole({ business: 1, family: 0, romantic: 0 }), 'friend');
});

test('overlapping evidence produces one most-likely relationship role', () => {
  assert.equal(
    guessRelationshipRole({ business: 500, family: 10, romantic: 0 }),
    'family',
    'generic work volume cannot overrule direct family evidence'
  );
  assert.equal(
    guessRelationshipRole({ business: 100, family: 10, romantic: 100 }),
    'romantic',
    'explicit romantic identity beats weaker family-style address'
  );
  assert.equal(
    guessRelationshipRole({ business: 100, family: 100, romantic: 100 }),
    'family',
    'a family identity in the saved contact name is the strongest evidence'
  );
  assert.ok(
    RELATIONSHIP_ROLES.includes(guessRelationshipRole({ business: 20, family: 20, romantic: 20 }))
  );
});

test('relationship roles are inferred independently for each year', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE context (ts INTEGER, source TEXT, text TEXT, meta TEXT)');
  const insert = db.prepare('INSERT INTO context VALUES (?, ?, ?, ?)');
  const meta = JSON.stringify({ chat_handle: '+15551230000', is_group: false });
  for (const text of ['love you babe', 'goodnight baby', 'miss you, my love', 'date night tomorrow']) {
    insert.run(new Date(2020, 5, 1).getTime(), 'whatsapp', text, meta);
  }
  for (const text of ['investor meeting and deck', 'client roadmap launch', 'contract and invoice']) {
    insert.run(new Date(2023, 5, 1).getTime(), 'whatsapp', text, meta);
  }
  insert.run(new Date(2024, 5, 1).getTime(), 'whatsapp', 'want to grab coffee?', meta);

  const index = inferRelationshipRoleIndex(
    db,
    new Map([['+15551230000', 'name:casey example']]),
    new Map([['name:casey example', 'Casey Example']])
  );
  assert.equal(index.rolesByYear.get('name:casey example').get(2020), 'romantic');
  assert.equal(index.rolesByYear.get('name:casey example').get(2023), 'business');
  assert.equal(index.rolesByYear.get('name:casey example').get(2024), 'friend');
  db.close();
});

test('owner-sent mail and LinkedIn exports contribute role evidence', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE context (ts INTEGER, source TEXT, text TEXT, meta TEXT)');
  const insert = db.prepare('INSERT INTO context VALUES (?, ?, ?, ?)');
  const when = new Date(2025, 5, 1).getTime();
  for (const text of ['investor meeting and deck', 'client roadmap launch', 'contract and invoice']) {
    insert.run(when, 'mail', text, JSON.stringify({
      from: ['owner@example.test'], to: ['casey@company.test'], cc: [],
    }));
  }
  insert.run(when, 'linkedin', "You're my girlfriend", JSON.stringify({
    kind: 'message', from: 'Taylor Example',
  }));

  const index = inferRelationshipRoleIndex(
    db,
    new Map([
      ['casey@company.test', 'name:casey example'],
      ['liname:taylor example', 'name:taylor example'],
    ]),
    new Map([
      ['name:casey example', 'Casey Example'],
      ['name:taylor example', 'Taylor Example'],
    ])
  );
  assert.equal(index.roles.get('name:casey example'), 'business');
  assert.equal(index.roles.get('name:taylor example'), 'romantic');
  db.close();
});
