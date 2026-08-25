// Tests for the per-year topic chips (people/topics.mjs) and the year rows in
// the map payload (people/map.mjs yearRows + buildMap). Labels and counts
// only — the assertions also pin what must NEVER become a chip: stopwords,
// names, URLs, one-off words.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import { topicTallies, topTopics, topTerms, nameTokenSet, isAutomatedRow, TOPIC_SIGNALS } from '../server/people/topics.mjs';
import { yearRows, buildMap, buildYear } from '../server/people/map.mjs';

const NOW = new Date(2027, 0, 1).getTime();
const DAY = 86_400_000;

function spineDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER)');
  const ins = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?)');
  for (const [id, name, kind] of pairs) ins.run(id, name, kind ?? 'phone', NOW);
  return db;
}

const HANDLE = '+18085550100';
function msg(ts, text, fromMe = false) {
  return { ts, source: 'imessage', entity_id: `i:${ts}:${Math.floor(ts % 97)}:${text.length}`, text, meta: { chat_handle: HANDLE, is_from_me: fromMe } };
}

test('taxonomy tallies key on (person, year): one row = one hit, years stay separate', () => {
  const ctx = openDb(':memory:');
  const y2020 = new Date(2020, 5, 1).getTime();
  const y2021 = new Date(2021, 5, 1).getTime();
  insertRows(ctx, [
    { ...msg(y2020, 'want to grab coffee coffee coffee?'), entity_id: 'a1' },
    { ...msg(y2020 + DAY, 'dinner at that restaurant friday?'), entity_id: 'a2' },
    { ...msg(y2021, 'our seed round and the term sheet are done'), entity_id: 'a3' },
  ]);
  const idToKey = new Map([[HANDLE, 'name:sam lee']]);
  const { docs } = topicTallies(ctx, idToKey);
  assert.equal(docs.get('name:sam lee|2020').taxonomy['food & drinks'], 2, 'two rows, not four mentions');
  assert.equal(docs.get('name:sam lee|2020').taxonomy.fundraising, undefined);
  assert.equal(docs.get('name:sam lee|2021').taxonomy.fundraising, 1);
});

test('stopwords, names, urls and one-off words never become chips', () => {
  const ctx = openDb(':memory:');
  const y = new Date(2021, 2, 1).getTime();
  // "pottery" clears the floor; "sam" is a name; "yeah" is a stopword; the
  // URL token appears 3 times but is stripped before tokenizing; "kiln"
  // appears once (under the floor).
  insertRows(ctx, [
    { ...msg(y, 'yeah the pottery class was great sam, check https://pottery-studio.example/x'), entity_id: 'b1' },
    { ...msg(y + DAY, 'pottery again this weekend? https://pottery-studio.example/x'), entity_id: 'b2' },
    { ...msg(y + 2 * DAY, 'my kiln broke but pottery is still on https://pottery-studio.example/x'), entity_id: 'b3' },
  ]);
  const idToKey = new Map([[HANDLE, 'k']]);
  const nameTokens = nameTokenSet(['Sam Lee']);
  const { docs, docFreq, totalDocs } = topicTallies(ctx, idToKey, { nameTokens });
  const top = topTopics(docs.get('k|2021'), docFreq, totalDocs);
  assert.deepEqual(top.map((t) => t.label), ['pottery']);
  const terms = docs.get('k|2021').terms;
  assert.equal(terms.has('sam'), false, 'their own name is never their topic');
  assert.equal(terms.has('yeah'), false);
  assert.equal([...terms.keys()].some((t) => t.includes('http') || t.includes('example')), false, 'urls are stripped');
});

test('the idf weight makes the distinctive word beat the common one', () => {
  // "tahoe" appears in ONE person-year, "tuesday"-ish filler ("coffee" is
  // taxonomy, so use a non-taxonomy common word) in all three.
  const docs = new Map();
  const mk = (terms) => ({ taxonomy: {}, terms: new Map(terms) });
  docs.set('a|2021', mk([['tahoe', 4], ['office', 5]]));
  docs.set('b|2021', mk([['office', 9]]));
  docs.set('c|2021', mk([['office', 7]]));
  const docFreq = new Map([['tahoe', 1], ['office', 3]]);
  const top = topTopics(docs.get('a|2021'), docFreq, 3, { limit: 1 });
  assert.deepEqual(top.map((t) => t.label), ['tahoe'], 'idf outweighs raw count');
});

test('topTopics: taxonomy first by count, distinctive terms backfill to 3', () => {
  const doc = {
    taxonomy: { fundraising: 5, travel: 3, 'food & drinks': 1 }, // food is under minTaxonomy
    terms: new Map([['tahoe', 6]]),
  };
  const top = topTopics(doc, new Map([['tahoe', 1]]), 10);
  assert.deepEqual(top.map((t) => t.label), ['fundraising', 'travel', 'tahoe']);
  assert.deepEqual(topTopics(undefined, new Map(), 0), [], 'no doc, no chips — never fabricated');
});

test('yearRows collapses the month timeline with the declared meeting weight', () => {
  const timeline = [
    { ym: '2020-03', sent: 5, received: 5, met: 0 },
    { ym: '2020-11', sent: 0, received: 2, met: 2 },
    { ym: '2022-01', sent: 0, received: 0, met: 1 },
    { ym: '2023-01', sent: 0, received: 0, met: 0 }, // empty year: dropped
  ];
  assert.deepEqual(yearRows(timeline), [
    { year: 2020, messages: 12, met: 2, engagement: 18 },
    { year: 2022, messages: 0, met: 1, engagement: 3 },
  ]);
});

test('buildMap carries per-year rows with that YEAR\'s topics on each person', () => {
  const ctx = openDb(':memory:');
  const y2019 = new Date(2019, 4, 1).getTime();
  const y2021 = new Date(2021, 4, 1).getTime();
  insertRows(ctx, [
    // 2019: school talk. 2021: fundraising talk. The chips must not blur.
    { ...msg(y2019, 'that exam and the professor were brutal'), entity_id: 'c1' },
    { ...msg(y2019 + DAY, 'homework for the semester is piling up'), entity_id: 'c2' },
    { ...msg(y2019 + 2 * DAY, 'ok', true), entity_id: 'c3' },
    { ...msg(y2021, 'the seed round closed, term sheet signed'), entity_id: 'c4' },
    { ...msg(y2021 + DAY, 'investors want the pitch deck tomorrow'), entity_id: 'c5' },
    { ...msg(y2021 + 2 * DAY, 'nice', true), entity_id: 'c6' },
  ]);
  const spine = spineDb([[HANDLE, 'Sam Lee', 'phone']]);
  const owner = { addresses: new Set(), names: [] };
  const map = buildMap(ctx, spine, { now: NOW, owner });
  const sam = map.people.find((p) => p.name === 'Sam Lee');
  assert.ok(sam);
  assert.deepEqual(sam.years.map((y) => y.year), [2019, 2021]);
  assert.deepEqual(sam.years[0].topics.map((t) => t.label), ['school']);
  assert.deepEqual(sam.years[1].topics.map((t) => t.label), ['fundraising']);
  assert.equal(sam.years[0].engagement, 3);
});

test('every taxonomy topic regex compiles against plain prose without throwing', () => {
  for (const [name, re] of Object.entries(TOPIC_SIGNALS)) {
    assert.doesNotThrow(() => re.test('an ordinary sentence with nothing in it'), name);
  }
});

test('bucketBy month keys tallies per person-month instead of per person-year', () => {
  const ctx = openDb(':memory:');
  const mar = new Date(2026, 2, 5).getTime();
  const jun = new Date(2026, 5, 5).getTime();
  insertRows(ctx, [
    { ...msg(mar, 'gym then a workout plan for the marathon'), entity_id: 'd1' },
    { ...msg(jun, 'the seed round term sheet came in'), entity_id: 'd2' },
  ]);
  const idToKey = new Map([[HANDLE, 'k']]);
  const { docs } = topicTallies(ctx, idToKey, { bucketBy: 'month' });
  assert.equal(docs.get('k|2026-03').taxonomy.fitness, 1);
  assert.equal(docs.get('k|2026-06').taxonomy.fundraising, 1);
  assert.equal(docs.get('k|2026'), undefined, 'no year bucket in month mode');
});

test('weekdays, filler and taxonomy-duplicate terms never take a chip slot', () => {
  const doc = {
    taxonomy: { fundraising: 5 },
    // "investors" is fundraising's own vocabulary; "tahoe" is new information.
    terms: new Map([['investors', 9], ['tahoe', 4]]),
  };
  const top = topTopics(doc, new Map([['investors', 1], ['tahoe', 1]]), 5, { limit: 2 });
  assert.deepEqual(top.map((t) => t.label), ['fundraising', 'tahoe']);

  const ctx = openDb(':memory:');
  const y = new Date(2026, 1, 1).getTime();
  insertRows(ctx, [
    { ...msg(y, 'monday then friday honestly okie'), entity_id: 'e1' },
    { ...msg(y + DAY, 'friday monday okie honestly'), entity_id: 'e2' },
    { ...msg(y + 2 * DAY, 'okie monday friday honestly'), entity_id: 'e3' },
  ]);
  const { docs } = topicTallies(ctx, new Map([[HANDLE, 'k']]), { bucketBy: 'month' });
  assert.equal(docs.get('k|2026-02').terms.size, 0, 'weekdays and filler are stopped');
});

test('buildYear: one year of people by year engagement, with year topics', () => {
  const ctx = openDb(':memory:');
  const mar = new Date(2026, 2, 10).getTime();
  const jul = new Date(2026, 6, 10).getTime();
  const old_ = new Date(2019, 6, 10).getTime();
  insertRows(ctx, [
    // March: Sam quiet, Ana loud. July: only Sam.
    { ...msg(mar, 'gym then a workout before the marathon'), entity_id: 'm1' },
    // FIVE SEPARATE DAYS, not five messages in one afternoon. A taxonomy chip
    // counts conversations, so a single burst is a single hit and would not
    // clear minTaxonomy -- which is the rule working, not a bug to fixture
    // around. Spreading them is what "Ana talks about fundraising" means.
    ...Array.from({ length: 5 }, (_, i) => ({
      ts: mar + i * 86_400_000, source: 'imessage', entity_id: `m2:${i}`,
      text: 'the seed round term sheet from the investors', meta: { chat_handle: '+18085550200', is_from_me: false },
    })),
    { ...msg(jul, 'surf at sunrise?'), entity_id: 'm3' },
    { ...msg(old_, 'ancient history'), entity_id: 'm4' },
  ]);
  const spine = spineDb([[HANDLE, 'Sam Lee', 'phone'], ['+18085550200', 'Ana Chen', 'phone']]);
  const owner = { addresses: new Set(), names: [] };
  const out = buildYear(ctx, spine, { year: 2026, now: NOW, owner });
  assert.deepEqual(out.years, [2019, 2026], 'every active year listed for paging');
  assert.deepEqual(out.people.map((p) => p.name), ['Ana Chen', 'Sam Lee'], 'year engagement order');
  const ana = out.people.find((p) => p.name === 'Ana Chen');
  assert.equal(ana.topics[0].label, 'fundraising', 'taxonomy chip leads');
  assert.equal(ana.engagement, 5);
  assert.equal(ana.taxonomy, undefined, 'chips are the whole topic surface');
  assert.equal(ana.specifics, undefined, 'specifics line yeeted with it');
});

test('topTerms returns the specifics alone — no taxonomy labels, floors intact', () => {
  const doc = {
    taxonomy: { fundraising: 9 },
    terms: new Map([['tahoe', 4], ['figma', 3], ['once', 1]]),
  };
  const out = topTerms(doc, new Map([['tahoe', 1], ['figma', 2], ['once', 1]]), 4);
  assert.deepEqual(out.map((t) => t.label), ['tahoe', 'figma'], 'idf order, one-offs floored');
  assert.equal(out.some((t) => t.label === 'fundraising'), false);
  assert.deepEqual(topTerms(undefined, new Map(), 0), []);
});

test('word pairs form within a clause, subsume their words, and stop at punctuation', () => {
  const ctx = openDb(':memory:');
  const y = new Date(2026, 3, 1).getTime();
  insertRows(ctx, [
    // "memory architecture" adjacent 3× -> a pair that absorbs both words.
    // The comma between "round" and "term" must NOT mint "round term".
    { ...msg(y, 'the memory architecture needs work'), entity_id: 'p1' },
    { ...msg(y + DAY, 'memory architecture again today'), entity_id: 'p2' },
    { ...msg(y + 2 * DAY, 'still on memory architecture, round term nonsense elsewhere'), entity_id: 'p3' },
  ]);
  const { docs, docFreq, totalDocs } = topicTallies(ctx, new Map([[HANDLE, 'k']]), { bucketBy: 'month' });
  const doc = docs.get('k|2026-04');
  assert.equal(doc.pairs.get('memory architecture'), 3);
  assert.equal(doc.pairs.get('architecture round'), undefined, 'comma breaks adjacency');
  const top = topTerms(doc, docFreq, totalDocs, { limit: 4 });
  assert.equal(top[0].label, 'memory architecture');
  const labels = top.map((t) => t.label);
  assert.ok(!labels.includes('memory') && !labels.includes('architecture'), 'pair subsumes its words');
});

test('a stopword between two words breaks the pair', () => {
  const ctx = openDb(':memory:');
  const y = new Date(2026, 4, 1).getTime();
  insertRows(ctx, [
    { ...msg(y, 'working on the app together'), entity_id: 'q1' },
    { ...msg(y + DAY, 'working on the app more'), entity_id: 'q2' },
    { ...msg(y + 2 * DAY, 'working on the app still'), entity_id: 'q3' },
  ]);
  const { docs } = topicTallies(ctx, new Map([[HANDLE, 'k']]), { bucketBy: 'month' });
  assert.equal(docs.get('k|2026-05').pairs.get('working app'), undefined);
});

// Machine-written mail is formal English, so isAutomatedRow -- aimed at SMS
// compliance text and one-time codes -- lets an order confirmation straight
// through. These are the exact PHRASES that chipped on real rows.
//
// Phrases, not words. Stopping the vocabulary instead (order, address,
// reference...) was tried and reverted: it would have silenced the friend who
// ordered dinner, which is the same reason isAutomatedRow drops rows rather
// than blacklisting terms. A lone "order" chip is the accepted cost.
test('automated-mail boilerplate never becomes a chip', () => {
  const ctx = openDb(':memory:');
  const y = new Date(2024, 3, 1).getTime();
  // Enough repetitions to clear every floor: if the register were not stopped,
  // these would be the most "distinctive" phrases this pair has.
  const lines = [
    'your order number is ready for future reference',
    'your order number is ready for future reference',
    'your order number is ready for future reference',
    'we have received either your email address or your profile',
    'we have received either your email address or your profile',
    'we have received either your email address or your profile',
    'would you mind providing the original confirmation',
    'would you mind providing the original confirmation',
    'would you mind providing the original confirmation',
  ];
  insertRows(ctx, lines.map((t, i) => ({ ...msg(y + i * DAY, t), entity_id: `b${i}` })));
  const idToKey = new Map([[HANDLE, 'name:shop bot']]);
  const { docs, docFreq, totalDocs } = topicTallies(ctx, idToKey);
  const chips = topTopics(docs.get('name:shop bot|2024'), docFreq, totalDocs, { limit: 5 })
    .map((c) => c.label);
  for (const junk of ['order number', 'future reference', 'received either', 'email address',
    'mind providing']) {
    assert.ok(!chips.includes(junk), `"${junk}" must not be a chip, got ${JSON.stringify(chips)}`);
  }
});

// The other half of the same change: stopping the register must not cost the
// distinctive terms the backfill exists for.
test('real distinctive terms still chip after the pair stoplist', () => {
  const ctx = openDb(':memory:');
  const y = new Date(2024, 3, 1).getTime();
  const lines = [
    'the tahoe cabin again in tahoe next month',
    'tahoe cabin was unreal, tahoe cabin again?',
    'booking the tahoe cabin, same tahoe cabin as before',
  ];
  insertRows(ctx, lines.map((t, i) => ({ ...msg(y + i * DAY, t), entity_id: `c${i}` })));
  const idToKey = new Map([[HANDLE, 'name:pat kim']]);
  const { docs, docFreq, totalDocs } = topicTallies(ctx, idToKey);
  const chips = topTopics(docs.get('name:pat kim|2024'), docFreq, totalDocs, { limit: 5 })
    .map((c) => c.label);
  assert.ok(chips.some((c) => c.includes('tahoe')), `expected a tahoe chip, got ${JSON.stringify(chips)}`);
});

// ---- what a robot said is nobody's topic ----
//
// Measured before this filter existed: four of the fifteen most repeated
// non-taxonomy chips on the owner's corpus were unsubscribe boilerplate.
test('compliance boilerplate is recognised, ordinary sentences are not', () => {
  for (const t of [
    'Reply STOP to unsubscribe',
    'Txt STOP to end',
    'Msg & data rates may apply',
    'Terms and conditions apply',
    'Your verification code is 448192',
    '448192 is your Acme code',
    'Reply HELP for help',
  ]) assert.ok(isAutomatedRow(t), `should be automated: ${t}`);

  for (const t of [
    'can you stop by after work?',
    'i had to apply for the visa today',
    'help me pick a restaurant',
    'the code review is done',
    'reply when you get a sec',
  ]) assert.equal(isAutomatedRow(t), false, `should NOT be automated: ${t}`);
});

// The reason this drops the ROW and not the words: "code" is in the engineering
// taxonomy, and on the live corpus 335 verification-code texts were being
// counted as engineering conversations.
test('a verification code is not an engineering conversation', () => {
  const ctx = openDb(':memory:');
  const y = new Date(2024, 3, 1).getTime();
  insertRows(ctx, [
    { ...msg(y, 'Your Acme verification code is 771043. Reply STOP to opt out.'), entity_id: 'b1' },
    { ...msg(y + DAY, '883120 is your security code'), entity_id: 'b2' },
    { ...msg(y + 2 * DAY, 'your login code: 220134'), entity_id: 'b3' },
  ]);
  const { docs } = topicTallies(ctx, new Map([[HANDLE, 'name:sam lee']]));
  const doc = docs.get('name:sam lee|2024');
  assert.equal(doc?.taxonomy?.engineering, undefined, 'a robot texting a code is not "engineering"');
});

test('a real conversation about code still counts as engineering', () => {
  const ctx = openDb(':memory:');
  const y = new Date(2024, 3, 1).getTime();
  insertRows(ctx, [
    { ...msg(y, 'pushed the code, can you review the repo?'), entity_id: 'c1' },
    { ...msg(y + DAY, 'the deploy broke, bug in the backend'), entity_id: 'c2' },
  ]);
  const { docs } = topicTallies(ctx, new Map([[HANDLE, 'name:sam lee']]));
  assert.equal(docs.get('name:sam lee|2024').taxonomy.engineering, 2, 'people who say "code" to each other are safe');
});
