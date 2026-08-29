import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openDb, insertRows } from '../server/hermes.mjs';
import {
  answerGeneralPeopleSearch,
  GENERAL_PEOPLE_PLAN_SCHEMA,
  looksLikeGeneralPeopleQuestion,
  planGeneralPeopleQuestion,
  prepareGeneralPeopleEvidence,
  validateGeneralPeoplePlan,
} from '../server/people/generalSearch.mjs';

const NOW = new Date(2027, 0, 1, 12).getTime();
const DAY = 86_400_000;

function spineDb(pairs) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE contact_ids (identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, updated_ts INTEGER, person_ref TEXT)');
  const insert = db.prepare('INSERT INTO contact_ids VALUES (?,?,?,?,?)');
  for (const [id, name, personRef = null] of pairs) {
    insert.run(id, name, id.includes('@') ? 'email' : 'phone', NOW, personRef);
  }
  return db;
}

function owner() {
  return {
    addresses: new Set(['owner@example.test']), names: ['Example Owner'], keys: new Set(),
    roles: new Map(), rolesByYear: new Map(), schools: [], highSchools: [],
  };
}

function plan(overrides = {}) {
  const value = {
    kind: 'people_search',
    interpretation: 'people with a durable interest in hiking',
    terms: ['hiking', 'hike', 'trail', 'backpacking'],
    scope: ['messages'], attribution: 'person', from: null, to: null,
    minimumEvidence: 2, preferRepeated: true, requireReachable: true, ranking: 'relevance',
    ...overrides,
  };
  value.facets ??= [{ label: value.interpretation, terms: value.terms, required: true }];
  value.terms = [...new Set(value.facets.flatMap((facet) => facet.terms))];
  return value;
}

function decisions(matches, overrides = {}) {
  return {
    judgments: matches,
    verifications: matches.map((match) => ({
      person_id: match.person_id,
      supported: true,
      confidence: overrides[match.person_id] ?? match.confidence,
      evidence_ids: match.evidence_ids,
    })),
  };
}

test('general people detection is broad, while the local planner may reject world trivia', async () => {
  assert.equal(looksLikeGeneralPeopleQuestion('Who likes hiking?'), true);
  assert.equal(looksLikeGeneralPeopleQuestion('Which friends are into cooking?'), true);
  assert.equal(looksLikeGeneralPeopleQuestion('Find the investors I met in LA about five years ago.'), true);
  assert.equal(looksLikeGeneralPeopleQuestion('Does anyone from my high school work in tech?'), true);
  assert.equal(looksLikeGeneralPeopleQuestion('Who would be down for Italy?'), true);
  assert.equal(looksLikeGeneralPeopleQuestion('Show me friends who love skiing.'), true);
  assert.equal(looksLikeGeneralPeopleQuestion('List everyone I know in healthcare.'), true);
  assert.equal(looksLikeGeneralPeopleQuestion('What is my sleep average?'), false);
  assert.equal(looksLikeGeneralPeopleQuestion('Who did I text most this month?'), false);

  let request;
  const fetchFn = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        kind: 'not_people_search', interpretation: '', facets: [], scope: [],
        attribution: 'participant', from: '', to: '', minimum_evidence: 1,
        prefer_repeated: false, require_reachable: false, ranking: 'relevance',
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const out = await planGeneralPeopleQuestion('Who is the president of France?', {
    now: NOW,
    owner: { schools: ['Lincoln High School'], highSchools: ['Lincoln High School'] },
    llama: { baseUrl: 'http://127.0.0.1:51780', apiKey: () => 'a'.repeat(64) },
    fetchFn,
  });
  assert.deepEqual(out, { kind: 'not_people_search' });
  assert.deepEqual(request.response_format, { type: 'json_schema', json_schema: GENERAL_PEOPLE_PLAN_SCHEMA });
  assert.match(request.messages[1].content, /president of France/u);
  assert.match(request.messages[1].content, /Lincoln High School/u);
  assert.doesNotMatch(request.messages[1].content, /PERSON p1|EVIDENCE/u, 'planning sees the question, not corpus rows');
});

test('invalid open-ended plans are rejected before touching retrieval', () => {
  assert.equal(validateGeneralPeoplePlan({ kind: 'people_search', terms: ['hiking'] }), null);
  assert.equal(validateGeneralPeoplePlan({
    kind: 'people_search', interpretation: 'hikers', terms: ['hiking'], scope: ['messages'],
    attribution: 'person', from: 'not-a-date', to: '', minimum_evidence: 1,
    prefer_repeated: true, require_reachable: true, ranking: 'relevance',
  }), null);

  const durable = validateGeneralPeoplePlan({
    kind: 'people_search', interpretation: 'people likely to enjoy a trip',
    facets: [{ label: 'durable travel interest', terms: ['travel', 'trip'], required: true }],
    scope: ['messages'], attribution: 'person', from: '', to: '', minimum_evidence: 1,
    prefer_repeated: true, require_reachable: true, ranking: 'relevance',
  });
  assert.equal(durable.minimumEvidence, 2, 'durable affinity cannot degrade to one item');
});

test('planner cleanup moves time and durability out of lexical facets', async () => {
  const fetchFn = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      kind: 'people_search', interpretation: 'investors met in a place five years ago',
      facets: [
        { label: 'role', terms: ['investor'], required: true },
        { label: 'location', terms: ['LA'], required: true },
        { label: 'timeframe', terms: ['five years ago'], required: true },
        { label: 'interaction', terms: ['met'], required: true },
      ],
      scope: ['calendar', 'profiles'], attribution: 'participant', from: '', to: '',
      minimum_evidence: 1, prefer_repeated: false, require_reachable: false, ranking: 'relevance',
    }) } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const out = await planGeneralPeopleQuestion('Find investors I met in LA five years ago.', {
    now: NOW, owner: owner(),
    llama: { baseUrl: 'http://127.0.0.1:51780', apiKey: () => 'a'.repeat(64) }, fetchFn,
  });
  assert.deepEqual(out.facets.map((facet) => facet.label), ['role', 'location']);
  assert.equal(new Date(out.from).getFullYear(), 2022);
  assert.equal(new Date(out.to).getFullYear(), 2022);
});

test('required facets survive noisy partial matches and candidate caps', async () => {
  const ctx = openDb(':memory:');
  const contacts = Array.from({ length: 26 }, (_, index) => [
    `noisy${index}@example.test`, `Noisy Investor ${index}`, `contact-noisy-${index}`,
  ]);
  contacts.push(['la@example.test', 'Lane Angeles', 'contact-la']);
  const spine = spineDb(contacts);
  insertRows(ctx, [
    ...contacts.slice(0, 26).flatMap(([email], index) => Array.from({ length: 4 }, (_, hit) => ({
      ts: NOW - (index + hit + 1) * DAY, source: 'mail', entity_id: `mail:noisy:${index}:${hit}`,
      text: 'I invest in seed-stage companies and work with founders.',
      meta: { from: [email], to: ['owner@example.test'], thread_id: `noise-${index}-${hit}` },
    }))),
    {
      ts: NOW - 5 * 365 * DAY, source: 'mail', entity_id: 'mail:lane-investor',
      text: 'I invest in early-stage companies.',
      meta: { from: ['la@example.test'], to: ['owner@example.test'], thread_id: 'lane-investor' },
    },
    {
      ts: NOW - 5 * 365 * DAY, source: 'granola', entity_id: 'granola:lane-la',
      text: 'Meeting at the Los Angeles office.',
      meta: { participants: [{ email: 'la@example.test', name: 'Lane Angeles' }], title: 'LA meeting' },
    },
  ]);
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Find the investors I met in LA about five years ago.', {
    owner: owner(), now: NOW,
    plan: plan({
      interpretation: 'investors met in Los Angeles about five years ago',
      facets: [
        { label: 'investor', terms: ['investor'], required: true },
        { label: 'Los Angeles', terms: ['LA'], required: true },
      ],
      scope: ['messages', 'calendar'], attribution: 'participant',
      from: new Date(2022, 0, 1).getTime(), to: new Date(2022, 11, 31, 23, 59, 59, 999).getTime(),
      minimumEvidence: 2, preferRepeated: false,
    }),
    ...decisions([{
      person_id: 'p1', confidence: 0.95, signal: 'is an investor met in Los Angeles', evidence_ids: ['e1', 'e2'],
    }]),
  });
  assert.equal(out.count, 1);
  assert.match(out.text, /Lane Angeles/u);
  assert.doesNotMatch(out.text, /Noisy Investor/u);
});

test('short acronym facets do not substring-match unrelated words', () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([
    ['real@example.test', 'Real Match', 'real'],
    ['false@example.test', 'False Match', 'false'],
  ]);
  insertRows(ctx, [
    {
      ts: NOW - DAY, source: 'granola', entity_id: 'granola:real',
      text: 'Meeting at the Los Angeles office.',
      meta: { participants: [{ email: 'real@example.test', name: 'Real Match' }] },
    },
    {
      ts: NOW - DAY, source: 'granola', entity_id: 'granola:false',
      text: 'Quarterly planning session.',
      meta: { participants: [{ email: 'false@example.test', name: 'False Match' }] },
    },
  ]);
  const prepared = prepareGeneralPeopleEvidence(ctx, spine, plan({
    interpretation: 'people connected to LA',
    facets: [{ label: 'location', terms: ['LA'], required: true }],
    scope: ['calendar'], attribution: 'participant', minimumEvidence: 1,
    preferRepeated: false, requireReachable: false,
  }), { owner: owner(), now: NOW });
  assert.deepEqual(prepared.candidates.map((candidate) => candidate.person.name), ['Real Match']);
  spine.close();
  ctx.close();
});

test('independent verification rejects a cited contradiction', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([['+15550000991', 'Harper Contrary', 'contact-harper']]);
  insertRows(ctx, {
    ts: NOW - DAY, source: 'imessage', entity_id: 'msg:harper-hates-hiking',
    text: 'I hate hiking and avoid trails.',
    meta: { chat_handle: '+15550000991', chat_guid: 'harper-chat', is_from_me: false },
  });
  const judgment = {
    person_id: 'p1', confidence: 0.99, signal: 'loves hiking', evidence_ids: ['e1'],
  };
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Who likes hiking?', {
    owner: owner(), now: NOW,
    plan: plan({ minimumEvidence: 1, preferRepeated: false }),
    judgments: [judgment],
    verifications: [{
      person_id: 'p1', supported: false, confidence: 0.99, evidence_ids: ['e1'],
    }],
  });
  assert.equal(out.count, 0);
  assert.doesNotMatch(out.text, /Harper Contrary/u);
});

test('browser result never contains a short source message or model paraphrase', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([['+15550000992', 'Quinn Private', 'contact-quinn']]);
  insertRows(ctx, {
    ts: NOW - DAY, source: 'imessage', entity_id: 'msg:quinn-private', text: 'I love hiking.',
    meta: { chat_handle: '+15550000992', chat_guid: 'quinn-chat', is_from_me: false },
  });
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Who likes hiking?', {
    owner: owner(), now: NOW,
    plan: plan({ minimumEvidence: 1, preferRepeated: false }),
    ...decisions([{
      person_id: 'p1', confidence: 0.95, signal: 'enjoys outdoor hiking', evidence_ids: ['e1'],
    }]),
  });
  assert.equal(out.count, 1);
  assert.match(out.text, /Quinn Private/u);
  assert.doesNotMatch(JSON.stringify(out), /I love hiking|enjoys outdoor hiking/u);
  assert.match(out.text, /supported by 1 supporting item/u);
});

test('final confidence cannot exceed identity-link confidence', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([['+15550000993', 'Indigo Maybe']]);
  insertRows(ctx, {
    ts: NOW - DAY, source: 'imessage', entity_id: 'msg:indigo-hiking', text: 'Hiking is my favorite hobby.',
    meta: { chat_handle: '+15550000993', chat_guid: 'indigo-chat', is_from_me: false },
  });
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Who likes hiking?', {
    owner: owner(), now: NOW,
    plan: plan({ minimumEvidence: 1, preferRepeated: false }),
    ...decisions([{
      person_id: 'p1', confidence: 0.99, signal: 'has a hiking hobby', evidence_ids: ['e1'],
    }]),
  });
  assert.equal(out.count, 1);
  assert.equal(out.evidence[0].confidence, 0.7);
});

test('an unseen hiking question aggregates repeated person-authored evidence', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([
    ['+15550001001', 'Riley Hiker'],
    ['+15550001002', 'Taylor Mention'],
    ['+15550001003', 'Casey Reply'],
  ]);
  insertRows(ctx, [
    {
      ts: NOW - 80 * DAY, source: 'imessage', entity_id: 'msg:riley-one',
      text: 'The hiking trails in Yosemite were incredible.',
      meta: { chat_handle: '+15550001001', chat_guid: 'chat-riley', is_from_me: false },
    },
    {
      ts: NOW - 20 * DAY, source: 'imessage', entity_id: 'msg:riley-two',
      text: 'I want to plan another backpacking trip.',
      meta: { chat_handle: '+15550001001', chat_guid: 'chat-riley', is_from_me: false },
    },
    {
      ts: NOW - 30 * DAY, source: 'imessage', entity_id: 'msg:taylor-one',
      text: 'I went on one hike for work.',
      meta: { chat_handle: '+15550001002', chat_guid: 'chat-taylor', is_from_me: false },
    },
    {
      ts: NOW - 10 * DAY, source: 'imessage', entity_id: 'msg:casey-owner',
      text: 'I love hiking and backpacking. Want to join?',
      meta: { chat_handle: '+15550001003', chat_guid: 'chat-casey', is_from_me: true },
    },
    {
      ts: NOW - 9 * DAY, source: 'imessage', entity_id: 'msg:casey-short', text: 'Sure.',
      meta: { chat_handle: '+15550001003', chat_guid: 'chat-casey', is_from_me: false },
    },
  ]);

  const out = await answerGeneralPeopleSearch(ctx, spine, 'Which friends genuinely enjoy hiking?', {
    owner: owner(), now: NOW, plan: plan(),
    ...decisions([
      { person_id: 'p1', confidence: 0.91, signal: 'repeatedly discusses hiking and backpacking', evidence_ids: ['e1', 'e2'] },
      { person_id: 'p2', confidence: 0.4, signal: 'mentioned one hike', evidence_ids: ['e3'] },
      { person_id: 'p999', confidence: 1, signal: 'invented person', evidence_ids: ['e1'] },
    ]),
  });
  assert.equal(out.count, 1);
  assert.match(out.text, /Riley Hiker/u);
  assert.match(out.text, /2 separate conversations/u);
  assert.doesNotMatch(out.text, /Taylor Mention|Casey Reply|Yosemite/u);
  assert.equal(JSON.stringify(out.evidence).includes('The hiking trails'), false, 'raw corpus text never enters the result');
});

test('conversation attribution may use the reader side without calling it the other person’s belief', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([['+15550002001', 'Morgan Clay']]);
  insertRows(ctx, {
    ts: NOW - 5 * DAY, source: 'imessage', entity_id: 'msg:morgan-ceramics',
    text: 'I wanted your thoughts about ceramics classes.',
    meta: { chat_handle: '+15550002001', chat_guid: 'chat-morgan', is_from_me: true },
  });
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Who have I discussed ceramics with?', {
    owner: owner(), now: NOW,
    plan: plan({
      interpretation: 'people I discussed ceramics with', terms: ['ceramics'],
      attribution: 'conversation', minimumEvidence: 1, preferRepeated: false,
    }),
    ...decisions([{
      person_id: 'p1', confidence: 0.8, signal: 'was part of a ceramics conversation', evidence_ids: ['e1'],
    }]),
  });
  assert.equal(out.count, 1);
  assert.match(out.text, /Morgan Clay/u);
  assert.doesNotMatch(out.text, /likes ceramics/u);
});

test('general retrieval searches structured profile fields', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([['devon@example.test', 'Devon Health']]);
  insertRows(ctx, {
    ts: NOW - 30 * DAY, source: 'linkedin', entity_id: 'linkedin:devon', text: 'Devon Health',
    meta: {
      kind: 'connection', name: 'Devon Health', email: 'devon@example.test',
      position: 'Product Manager', company: 'Care Labs', industry: 'Healthcare',
    },
  });
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Who works in healthcare?', {
    owner: owner(), now: NOW,
    plan: plan({
      interpretation: 'people who work in healthcare', terms: ['healthcare', 'health tech'],
      scope: ['profiles'], attribution: 'participant', minimumEvidence: 1, preferRepeated: false,
      requireReachable: false,
    }),
    ...decisions([{
      person_id: 'p1', confidence: 0.95, signal: 'current profile lists the healthcare industry', evidence_ids: ['e1'],
    }]),
  });
  assert.equal(out.count, 1);
  assert.match(out.text, /Devon Health/u);
  assert.deepEqual(out.sources, ['linkedin']);
});

test('a model cannot cite another candidate’s evidence', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([
    ['+15550003001', 'Ari One'],
    ['+15550003002', 'Blair Two'],
  ]);
  insertRows(ctx, [
    { ts: NOW - DAY, source: 'imessage', entity_id: 'msg:ari', text: 'I love hiking.', meta: { chat_handle: '+15550003001', is_from_me: false } },
    { ts: NOW - 2 * DAY, source: 'imessage', entity_id: 'msg:blair', text: 'I love hiking.', meta: { chat_handle: '+15550003002', is_from_me: false } },
  ]);
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Who likes hiking?', {
    owner: owner(), now: NOW,
    plan: plan({ minimumEvidence: 1, preferRepeated: false }),
    ...decisions([{ person_id: 'p1', confidence: 0.99, signal: 'likes hiking', evidence_ids: ['e2'] }]),
  });
  assert.equal(out.count, 0);
  assert.doesNotMatch(out.text, /Ari One|Blair Two/u);
});

test('the full open-ended path plans, retrieves, and judges through loopback JSON calls', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([['+15550004001', 'Jamie Cook']]);
  insertRows(ctx, {
    ts: NOW - 4 * DAY, source: 'imessage', entity_id: 'msg:jamie-cook',
    text: 'I have been learning Italian cooking and making fresh pasta.',
    meta: { chat_handle: '+15550004001', chat_guid: 'chat-jamie', is_from_me: false },
  });
  const requests = [];
  const replies = [
    {
      kind: 'people_search', interpretation: 'people interested in cooking',
      facets: [{ label: 'cooking interest', terms: ['cooking', 'cook', 'pasta'], required: true }],
      scope: ['messages'], attribution: 'person',
      from: '', to: '', minimum_evidence: 1, prefer_repeated: false,
      require_reachable: true, ranking: 'relevance',
    },
    {
      matches: [{
        person_id: 'p1', confidence: 0.93, signal: 'actively learns cooking and makes pasta',
        evidence_ids: ['e1'],
      }],
    },
    {
      verdicts: [{
        person_id: 'p1', supported: true, confidence: 0.92, evidence_ids: ['e1'],
      }],
    },
  ];
  const fetchFn = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(replies.shift()) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Which friends are interested in cooking?', {
    owner: owner(), now: NOW,
    llama: { baseUrl: 'http://127.0.0.1:51780', apiKey: () => 'b'.repeat(64) },
    fetchFn,
  });
  assert.equal(out.count, 1);
  assert.match(out.text, /Jamie Cook/u);
  assert.equal(requests.length, 3);
  assert.equal(requests.every((request) => request.url.startsWith('http://127.0.0.1:')), true);
  assert.equal(requests.every((request) => request.options.redirect === 'error'), true);
  assert.deepEqual(requests[0].body.response_format.json_schema, GENERAL_PEOPLE_PLAN_SCHEMA);
  assert.match(requests[1].body.messages[1].content, /PERSON p1: Jamie Cook/u);
  assert.match(requests[1].body.messages[1].content, /person said/u);
});

test('general search aggregates evidence across connectors and multiple identifiers', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([
    ['+15550005001', 'Robin Green', 'contact-robin'],
    ['robin@climate.test', 'Robin Green', 'contact-robin'],
  ]);
  insertRows(ctx, [
    {
      ts: NOW - 90 * DAY, source: 'mail', entity_id: 'mail:robin-climate',
      text: 'I have been volunteering on climate policy.',
      meta: { from: ['robin@climate.test'], to: ['owner@example.test'], thread_id: 'robin-mail' },
    },
    {
      ts: NOW - 10 * DAY, source: 'imessage', entity_id: 'msg:robin-climate',
      text: 'My climate nonprofit is launching another project.',
      meta: { chat_handle: '+15550005001', chat_guid: 'robin-chat', is_from_me: false },
    },
  ]);
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Who is deeply interested in climate work?', {
    owner: owner(), now: NOW,
    plan: plan({
      interpretation: 'people deeply interested in climate work',
      terms: ['climate', 'climate policy'], minimumEvidence: 2, preferRepeated: true,
    }),
    ...decisions([{
      person_id: 'p1', confidence: 0.94, signal: 'sustained involvement in climate work',
      evidence_ids: ['e1', 'e2'],
    }]),
  });
  assert.equal(out.count, 1);
  assert.match(out.text, /Robin Green/u);
  assert.deepEqual(out.sources, ['imessage', 'mail']);
  assert.equal(out.evidence[0].facts[0].conversations, 2);
});

test('meeting-note evidence is searchable through the calendar scope', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([['sky@example.test', 'Sky Rivera', 'contact-sky']]);
  insertRows(ctx, {
    ts: NOW - 15 * DAY, source: 'granola', entity_id: 'granola:robotics',
    text: 'We reviewed the robotics prototype and manufacturing plan.',
    meta: {
      participants: [{ name: 'Sky Rivera', email: 'sky@example.test' }],
      title: 'Prototype review',
    },
  });
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Who have I met with about robotics?', {
    owner: owner(), now: NOW,
    plan: plan({
      interpretation: 'people I met with about robotics', terms: ['robotics', 'robot'],
      scope: ['calendar'], attribution: 'participant', minimumEvidence: 1,
      preferRepeated: false, requireReachable: false,
    }),
    ...decisions([{
      person_id: 'p1', confidence: 0.9, signal: 'participated in a robotics discussion',
      evidence_ids: ['e1'],
    }]),
  });
  assert.equal(out.count, 1);
  assert.match(out.text, /Sky Rivera/u);
  assert.deepEqual(out.sources, ['granola']);
});

test('general search refuses stale evidence when projection refresh fails', async () => {
  const ctx = openDb(':memory:');
  const spine = spineDb([['+15550006001', 'Parker Trail']]);
  insertRows(ctx, {
    ts: NOW - 10 * DAY, source: 'imessage', entity_id: 'msg:parker-hike',
    text: 'I love hiking mountain trails.',
    meta: { chat_handle: '+15550006001', is_from_me: false },
  });
  const first = await answerGeneralPeopleSearch(ctx, spine, 'Who likes hiking?', {
    owner: owner(), now: NOW,
    plan: plan({ minimumEvidence: 1, preferRepeated: false }),
    ...decisions([{ person_id: 'p1', confidence: 0.9, signal: 'enjoys hiking', evidence_ids: ['e1'] }]),
  });
  assert.equal(first.count, 1);

  insertRows(ctx, {
    ts: NOW - DAY, source: 'imessage', entity_id: 'msg:parker-new',
    text: 'A newer hiking message dirties the projection.',
    meta: { chat_handle: '+15550006001', is_from_me: false },
  });
  ctx.exec(
    "CREATE TRIGGER fail_general_people_insert BEFORE INSERT ON people BEGIN " +
      "SELECT RAISE(ABORT, 'simulated projection failure'); END"
  );
  const out = await answerGeneralPeopleSearch(ctx, spine, 'Who likes hiking?', {
    owner: owner(), now: NOW,
    plan: plan({ minimumEvidence: 1, preferRepeated: false }),
    judgments: [], verifications: [],
  });
  assert.equal(out.count, 0);
  assert.equal(out.degraded, true);
  assert.match(out.text, /couldn't refresh the local people evidence index/u);
  assert.doesNotMatch(out.text, /Parker Trail/u);
});
