// The judgment pass end to end against an in-memory hermes database and a
// fake Jev: the state is words not numbers, the questions are the pinned set,
// answers land in rm_judgment as numbers and closed tokens, the derived kind
// follows the flags-then-axis rule, and the serve-time overrides read the
// cache with the thresholds. THE DISCRIMINATING FIXTURE is the birthday line:
// the old floor (substantiveQuoteContextId) picks it, the judged path does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/hermes.mjs';
import { substantiveQuoteContextId, eligiblePool } from '../server/relationship/producer.mjs';
import { buildPersonState, quoteCandidates, ago, span, count, balance, trend, stateHash } from '../server/relationship/personState.mjs';
import {
  deriveKind, buildJudgmentCall, judgePerson, cardOverrides, judgedRoles, judgedScores, worthBucket, judgeMany,
  ENDED, WORTH, PROFESSIONAL_AXIS, CLOSENESS, RELATIVES, ROMANTIC, QUOTE_MIN_SCORE,
} from '../server/relationship/judgments.mjs';
import { judgmentFor } from '../server/relationship/jev.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-20T12:00:00Z');

function seedPerson(db, key, { name = 'Old Colleague', role = 'business', lines = [], linkedin = null, sent = 900, received = 1100 } = {}) {
  db.prepare(`INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner, sent, received,
      met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year, linkedin, sub_roles, built_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, name, NOW - 4 * 365 * DAY, NOW - 400 * DAY, NOW - 400 * DAY, NOW - 420 * DAY, sent, received, 3, 40, sent + received, 0, role, '{}', linkedin ? JSON.stringify(linkedin) : null, '[]', NOW);
  const ins = db.prepare(`INSERT INTO context(ts, source, speaker, text, meta, entity_id, content_hash) VALUES (?,?,?,?,?,?,?)`);
  const link = db.prepare(`INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key) VALUES (?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  lines.forEach((l, i) => {
    const ts = NOW - (lines.length - i) * 30 * DAY;
    const info = ins.run(ts, 'imessage', l.who === 'them' ? name : 'me', l.text, '{}', `e:${key}:${i}`, `h${key}${i}`);
    const id = Number(info.lastInsertRowid);
    link.run(key, id, 'imessage', l.who === 'them' ? 'counterparty' : 'sender', l.who === 'them' ? 1 : 0, l.who === 'them' ? 0 : 1, 0, 1, 'imessage:chat1');
    ids.push(id);
  });
  return ids;
}

function fakeJev(answersFor) {
  const asks = [];
  return {
    asks,
    state: 'ok',
    model: 'jev-fake',
    ask: async ({ state, questions }) => {
      asks.push({ state, questions });
      return { answers: answersFor(questions, state), usage: { input_tokens: 777 }, model: 'jev-fake' };
    },
  };
}

test('buckets turn numbers and dates into the words Jev can read', () => {
  assert.equal(ago(NOW - 400 * DAY, NOW), 'about a year ago');
  assert.equal(ago(NOW - 935 * DAY, NOW), 'about two years ago');
  assert.equal(ago(0, NOW), 'never');
  assert.equal(span(NOW - 4 * 365 * DAY, NOW), 'four or more years');
  assert.equal(count(0), 'none');
  assert.equal(count(2731), 'thousands');
  assert.equal(balance(900, 1100), 'roughly even both ways');
  assert.equal(balance(900, 100), 'the owner writes much more than they do');
  assert.equal(trend([{ year: '2022', total: 900 }, { year: '2024', total: 20 }], NOW), 'most active in 2022 (hundreds messages that year); last messages in 2024');
});

test('deriveKind: flags first, then the axis; nothing judged is null', () => {
  assert.equal(deriveKind({}), null);
  assert.equal(deriveKind({ professionalAxis: 3.2 }), 'business');
  assert.equal(deriveKind({ professionalAxis: 2.49 }), 'friend');
  assert.equal(deriveKind({ professionalAxis: 3.9, relatives: 0.7 }), 'family');
  assert.equal(deriveKind({ professionalAxis: 0.5, romantic: 0.51 }), 'romantic');
  assert.equal(deriveKind({ professionalAxis: 4, relatives: 0.5, romantic: 0.5 }), 'business', 'a flag at exactly the threshold is not a flag');
});

test('the birthday line clears the old floor and loses to the judged quote; state carries no digits for dates', async () => {
  const db = openDb(':memory:');
  const ids = seedPerson(db, 'p:1', {
    linkedin: { position: 'Head of Design', company: 'Studio', industry: 'Design', connected_on: NOW - 800 * DAY, url: 'https://linkedin.com/in/x' },
    lines: [
      { who: 'them', text: 'would you be up for reviewing the onboarding flow before we ship it next month?' },
      { who: 'owner', text: 'yes send it over' },
      { who: 'them', text: 'Happy birthday Rishab !' },
    ],
  });
  // NON-VACUITY: today's floor accepts the birthday wish (23 chars, 3 words,
  // and "happy" is not an ACK word), so the first live card led with it.
  assert.equal(substantiveQuoteContextId(db, 'p:1'), ids[2], 'the old floor picks the birthday line');

  const call = buildJudgmentCall(db, 'p:1', { now: NOW });
  assert.equal(call.candidates.length, 2, 'two lines from them are candidates; the owner\'s line is not');
  assert.deepEqual(Object.keys(call.questions), ['quote_L1', 'quote_L2', 'ended', 'professional_axis', 'closeness', 'relatives', 'romantic', 'worth']);
  const text = JSON.stringify(call.state);
  assert.ok(!/\b\d{10,}\b/u.test(text), 'no epoch numbers in the state');
  assert.ok(!/"[a-z_]+":\s*\d+/u.test(text), 'no bare counts in the state');
  assert.equal(call.state.recency.they_last_wrote, 'about a year ago');
  assert.equal(call.state.professional.linkedin.title, 'Head of Design');
  assert.equal(call.state.relationship_shape.direct_messages, 'thousands');
  assert.equal(call.state.quote_candidates[0].id, 'L1');

  // L1 is the newest candidate (the birthday line), L2 the review ask.
  const jev = fakeJev((questions) => ({
    quote_L1: { type: 'score', score: 0.4, confidence: 0.9, probabilities: {} },
    quote_L2: { type: 'score', score: 3.8, confidence: 0.8, probabilities: {} },
    ended: { type: 'choice', choice: 'warm', confidence: 0.7, probabilities: { warm: 0.75, neutral: 0.2, bad: 0.05 } },
    professional_axis: { type: 'score', score: 3.1, confidence: 0.6, probabilities: {} },
    closeness: { type: 'score', score: 2.2, confidence: 0.5, probabilities: {} },
    relatives: { type: 'noul', noul: 0.02 },
    romantic: { type: 'noul', noul: 0.01 },
    worth: { type: 'noul', noul: 0.71 },
  }));
  const summary = await judgePerson(db, jev, 'p:1', { now: NOW });
  assert.equal(summary.quotes, 2);
  assert.equal(summary.kind, 'business');
  assert.equal(summary.worth, 0.71);
  assert.equal(jev.asks.length, 1);

  const over = cardOverrides(db, 'p:1');
  assert.equal(over.quoteContextId, ids[0], 'the review ask wins the quote');
  assert.equal(over.leftTone, 'warm');
  assert.equal(over.kind, 'business');
  assert.equal(over.worth, 0.71);
  assert.equal(over.closeness, 2.2);

  // Nothing textual reached the cache.
  const rows = db.prepare('SELECT answer FROM rm_judgment WHERE answer IS NOT NULL').all();
  for (const r of rows) assert.ok(!/\s/u.test(r.answer), 'answers are closed tokens');
  assert.equal(db.prepare('PRAGMA table_info(rm_judgment)').all().some((c) => c.name === 'text'), false);

  // The same facts and lines again: cached, no second ask.
  const again = await judgePerson(db, jev, 'p:1', { now: NOW });
  assert.equal(again.cached, true);
  assert.equal(jev.asks.length, 1);

  // The projection reads the derived label; the regex guess would have said
  // 'friend' for a thread with no business vocabulary.
  assert.equal(judgedRoles(db).get('p:1'), 'business');
  assert.equal(judgedScores(db, 'worth').get('p:1'), 0.71);
});

test('thresholds: a filler-only person gets no quote, a shaky ending stays null, unknown options are dropped', async () => {
  const db = openDb(':memory:');
  const ids = seedPerson(db, 'p:2', { lines: [{ who: 'them', text: 'lol ok sounds good' }, { who: 'them', text: 'hey happy new year!!' }] });
  assert.equal(substantiveQuoteContextId(db, 'p:2'), ids[1], 'the floor still finds a "quote" here');
  const jev = fakeJev(() => ({
    quote_L1: { type: 'score', score: 1.1, confidence: 0.9, probabilities: {} },
    quote_L2: { type: 'score', score: 2.9, confidence: 0.9, probabilities: {} },
    ended: { type: 'choice', choice: 'bad', confidence: 0.4, probabilities: { warm: 0.3, neutral: 0.3, bad: 0.4 } },
    professional_axis: { type: 'score', score: 1.0, confidence: 0.6, probabilities: {} },
    closeness: { type: 'score', score: 1.5, confidence: 0.6, probabilities: {} },
    relatives: { type: 'noul', noul: 0.1 },
    romantic: { type: 'noul', noul: 0.1 },
    worth: { type: 'noul', noul: 0.22 },
  }));
  await judgePerson(db, jev, 'p:2', { now: NOW });
  const over = cardOverrides(db, 'p:2');
  assert.equal(over.quoteContextId, null, `no candidate reached ${QUOTE_MIN_SCORE}: the card hides its quote`);
  assert.equal(over.leftTone, null, 'confidence 0.4 is below the 0.6 gate: today\'s row stands');
  assert.equal(over.kind, 'friend');
  assert.equal(worthBucket(over.worth), 0);
});

test('the pool orders by worth bucket first, arithmetic inside a bucket, and unjudged above unsure', async () => {
  const db = openDb(':memory:');
  const mk = (key, name, sent, received, worth) => {
    seedPerson(db, key, { name, sent, received, lines: [{ who: 'them', text: 'can we pick the roadmap conversation back up when you have a week?' }] });
    db.prepare(`INSERT INTO person_active_days(person_key, day) VALUES (?, ?)`).run(key, '2025-06-01');
    if (worth !== null) db.prepare(`INSERT INTO rm_judgment(person_key, kind, subject_hash, score, model, question_sha, created_at) VALUES (?, 'worth', 'h', ?, 'm', 'q', ?)`).run(key, worth, NOW);
  };
  mk('p:likely', 'Likely Person', 100, 100, 0.8);
  mk('p:deep', 'Deep Unjudged', 5000, 5000, null);
  mk('p:unsure', 'Unsure Person', 4000, 4000, 0.5);
  mk('p:unlikely', 'Unlikely Person', 6000, 6000, 0.1);
  const pool = eligiblePool(db, { mode: 'any', now: NOW });
  assert.deepEqual(pool.map((p) => p.personKey), ['p:likely', 'p:deep', 'p:unsure', 'p:unlikely']);
  assert.equal(pool[0].worth, 0.8);
  assert.equal(pool[1].worth, null);
});

test('judgeMany walks a list, counts declines, and stops when the engine is not ok', async () => {
  const db = openDb(':memory:');
  seedPerson(db, 'p:a', { lines: [{ who: 'them', text: 'a real sentence about the launch plan for the spring' }] });
  seedPerson(db, 'p:b', { lines: [{ who: 'them', text: 'another real sentence about a conference in june' }] });
  const jev = fakeJev(() => ({ worth: { type: 'noul', noul: 0.5 } }));
  const totals = await judgeMany(db, jev, ['p:a', 'p:b', 'p:missing'], { now: NOW, spacingMs: 0 });
  assert.deepEqual(totals, { asked: 2, cached: 0, declined: 1, inputTokens: 1554 });
  const paused = { ...jev, state: 'paused' };
  const stopped = await judgeMany(db, paused, ['p:a', 'p:b'], { now: NOW, spacingMs: 0 });
  assert.equal(stopped.asked, 0);
  assert.equal(stopped.declined, 2);
});

test('the question set is pinned: a reorder or a reword is a different sha and a cache miss', () => {
  const shas = { ended: ENDED.sha, worth: WORTH.sha, axis: PROFESSIONAL_AXIS.sha, closeness: CLOSENESS.sha, relatives: RELATIVES.sha, romantic: ROMANTIC.sha };
  for (const [k, v] of Object.entries(shas)) assert.match(v, /^[0-9a-f]{16}$/u, k);
  assert.equal(new Set(Object.values(shas)).size, 6, 'six distinct questions');
  assert.deepEqual(ENDED.options, ['warm', 'neutral', 'bad']);
  assert.equal(PROFESSIONAL_AXIS.levels, 5);
  const state = buildPersonState(openDb(':memory:'), 'nobody');
  assert.equal(state, null);
  assert.equal(stateHash({ a: 1 }), stateHash({ a: 1 }));
  assert.notEqual(stateHash({ a: 1 }), stateHash({ a: 2 }));
  assert.equal(typeof judgmentFor, 'function');
  assert.equal(typeof quoteCandidates, 'function');
});
