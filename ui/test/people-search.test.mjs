// Tests for the live person-search surface: intent detection (narrow, does
// not swallow episodic stat questions) and the graph-backed answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { detectPersonSearch, answerPersonSearch } from '../server/people/search.mjs';

const NOW = new Date(2027, 0, 1).getTime();
const DAY = 86_400_000;

test('intent fires on need language, not on episodic stat questions', () => {
  assert.equal(detectPersonSearch('who are the investors i talked to')?.kind, 'investor');
  assert.equal(detectPersonSearch('which vcs did i pitch')?.kind, 'investor');
  assert.equal(detectPersonSearch('who should i reconnect with')?.kind, 'reconnect');
  assert.equal(detectPersonSearch('who could mentor me')?.kind, 'mentor');
  // These belong to the episodic shelf / claim path, NOT person-search.
  assert.equal(detectPersonSearch('who did i text the most this month'), null);
  assert.equal(detectPersonSearch('what did casey and i decide'), null);
  assert.equal(detectPersonSearch('when do i fly to honolulu'), null);
});

test("the fundrais stem matches its real continuations (it was dead behind a word boundary)", () => {
  // 'fundrais' inside \b(...)\b could never match: every real word continues
  // it with a word character ('fundraise', 'fundraising', 'fundraiser'), so
  // the trailing boundary always failed and fundraising questions fell
  // through to the claim path. The stem is open ('fundrais\w*') now.
  assert.equal(detectPersonSearch('who helped with fundraising last year?')?.kind, 'investor');
  assert.equal(detectPersonSearch('who should i talk to about my fundraise')?.kind, 'investor');
  assert.equal(detectPersonSearch('any fundraiser contacts i know?')?.kind, 'investor');
});

test('answerPersonSearch returns a ranked list or null on a non-match', () => {
  const ctx = openDb(':memory:');
  const spine = new DatabaseSync(':memory:');
  spine.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  spine.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)').run('+18085550100', 'Vic Capital', 'phone', NOW);
  insertRows(ctx, [
    ...Array.from({ length: 30 }, (_, i) => ({
      ts: NOW - (400 + i) * DAY,
      source: 'imessage',
      entity_id: `i:${i}`,
      text: i % 2 ? 'lets talk term sheet and check size for the seed round' : 'sounds good',
      meta: { chat_handle: '+18085550100', is_from_me: i % 3 === 0 },
    })),
    { ts: NOW - 380 * DAY, source: 'linkedin', entity_id: 'linkedin:conn:vic', text: 'Vic — Partner', meta: { kind: 'connection', name: 'Vic Capital', position: 'Partner', company: 'Seed Fund' } },
  ]);
  const owner = { addresses: new Set(), names: [] };
  const out = answerPersonSearch(ctx, spine, 'who are investors i talked to', { owner, now: NOW });
  assert.ok(out, 'a person-search returns an answer');
  assert.match(out.text, /Vic Capital/u);
  assert.ok(out.count >= 1);

  assert.equal(answerPersonSearch(ctx, spine, 'what is my sleep average', { owner, now: NOW }), null);
});
