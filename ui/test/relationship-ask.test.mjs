// "Looking for": the ask is stored verbatim, candidates are ORDERED (never
// excluded) by the corpus's own vocabulary, each person is judged against the
// ask with three closed questions, matches read back with a "fits because"
// that is a pick, and the routes are bearer-only. Fake engine, in-memory
// database, no socket. Fails against a tree without ask.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, start } from '../server/hermes.mjs';
import {
  createAsk, listAsks, getAsk, setAskActive, deleteAsk, askTerms, askCandidates, buildAskCall, judgeAskPerson,
  runAskPass, askJudgmentOrder, askMatches, askStatus, FIT, FIT_LEVEL, ASK_MATCH_MIN_LEVEL,
} from '../server/relationship/ask.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-21T12:00:00Z');
const TOKEN = 'e'.repeat(64);

function seed(db, key, { name, role = 'friend', linkedin = null, lines = [], sent = 300, received = 400, met = 0 }) {
  db.prepare(`INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner, sent, received,
      met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year, linkedin, sub_roles, built_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, name, NOW - 3 * 365 * DAY, NOW - 300 * DAY, NOW - 300 * DAY, NOW - 310 * DAY, sent, received, met, 0, sent + received, 0, role, '{}', linkedin ? JSON.stringify(linkedin) : null, '[]', NOW);
  db.prepare('INSERT INTO person_active_days(person_key, day) VALUES (?, ?)').run(key, '2025-06-01');
  const ins = db.prepare('INSERT INTO context(ts, source, speaker, text, meta, entity_id, content_hash) VALUES (?,?,?,?,?,?,?)');
  const link = db.prepare('INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key) VALUES (?,?,?,?,?,?,?,?,?)');
  const ids = [];
  lines.forEach((text, i) => {
    const id = Number(ins.run(NOW - (lines.length - i) * 20 * DAY, 'imessage', name, text, '{}', `e:${key}:${i}`, `h${key}${i}`).lastInsertRowid);
    link.run(key, id, 'imessage', 'counterparty', 1, 0, 0, 1, 'c');
    ids.push(id);
  });
  return ids;
}

function fakeJev(answerFor) {
  const asks = [];
  return { asks, state: 'ok', model: 'jev-fake', ask: async ({ state, questions }) => { asks.push({ state, questions }); return { answers: answerFor(state, questions), usage: { input_tokens: 400 }, model: 'jev-fake' }; } };
}

test('the store keeps the ask verbatim (trimmed), bounds it, lists, pauses and deletes', () => {
  const db = openDb(':memory:');
  const a = createAsk(db, '  a seed   investor in health tech ', { now: NOW });
  assert.equal(a.text, 'a seed investor in health tech');
  assert.throws(() => createAsk(db, 'hi'), RangeError);
  assert.throws(() => createAsk(db, 'x'.repeat(401)), RangeError);
  assert.equal(listAsks(db)[0].id, a.id);
  assert.equal(setAskActive(db, a.id, false, { now: NOW }), true);
  assert.equal(getAsk(db, a.id).active, false);
  assert.equal(deleteAsk(db, a.id), true);
  assert.equal(getAsk(db, a.id), null);
});

test('terms drop stopwords and candidates are ordered by hits, never excluded', () => {
  assert.deepEqual(askTerms("someone who's a seed investor in health tech I've met"), ['seed', 'investor', 'health', 'tech']);
  const db = openDb(':memory:');
  seed(db, 'p:vc', { name: 'Vera Capital', linkedin: { position: 'Partner', company: 'Health Seed Fund', industry: 'Venture Capital' }, lines: ['we invest at seed in health tech'], met: 2 });
  seed(db, 'p:eng', { name: 'Eli Engineer', linkedin: { position: 'Engineer', company: 'Acme' }, lines: ['pushed the fix'], sent: 5000, received: 5000 });
  seed(db, 'p:none', { name: 'Nobody Known', lines: ['hey'] });
  const c = askCandidates(db, 'a seed investor in health tech I have met in person', { now: NOW });
  assert.deepEqual(c.map((x) => x.personKey), ['p:vc', 'p:eng', 'p:none'], 'hits first, then depth; the zero-hit person is still there');
  assert.equal(c[0].hits, 3, 'seed and health in the LinkedIn fields plus met in person; "investor" and "tech" appear in no field, and the lines are not searched -- Jev reads those');
});

test('a person is judged against the ask with fit, level and an evidence pick; the cache is on state + questions', async () => {
  const db = openDb(':memory:');
  const ids = seed(db, 'p:vc', { name: 'Vera Capital', linkedin: { position: 'Partner', company: 'Health Seed Fund', industry: 'Venture Capital' }, lines: ['we invest at seed in health tech, send me the deck when ready?'], met: 2 });
  const ask = createAsk(db, 'a seed investor in health tech', { now: NOW });
  const call = buildAskCall(db, ask, 'p:vc', { now: NOW });
  assert.equal(call.state.ask, ask.text, 'the ask rides in the state under `ask`');
  assert.ok(call.facts.some((f) => f.id === 'F2' && f.text.includes('Health Seed Fund')));
  assert.ok(call.lines.length >= 1);
  assert.deepEqual(Object.keys(call.questions), ['fit', 'fit_level', 'evidence']);
  const options = Object.keys(call.questions.evidence.question.criteria);
  assert.ok(options.includes('F2') && options.includes('L1') && options.includes('none'));

  const jev = fakeJev(() => ({
    fit: { type: 'noul', noul: 0.88 },
    fit_level: { type: 'score', score: 3.6, confidence: 0.7, probabilities: {} },
    evidence: { type: 'choice', choice: 'F2', confidence: 0.8, probabilities: {} },
  }));
  const r = await judgeAskPerson(db, jev, ask, 'p:vc', { now: NOW });
  assert.equal(r.cached, false);
  assert.equal(r.fit, 0.88);
  const again = await judgeAskPerson(db, jev, ask, 'p:vc', { now: NOW });
  assert.equal(again.cached, true, 'same state, same questions: no second ask');
  assert.equal(jev.asks.length, 1);
  const m = askMatches(db, ask, { now: NOW });
  assert.equal(m.length, 1);
  assert.equal(m[0].name, 'Vera Capital');
  assert.equal(m[0].fitsBecause, 'company: Health Seed Fund', 'the evidence is the fact text, a pick not prose');
  assert.equal(m[0].company, 'Health Seed Fund');
  const row = db.prepare('SELECT evidence_kind, evidence_id FROM rm_ask_match').get();
  assert.deepEqual({ ...row }, { evidence_kind: 'fact', evidence_id: 'F2' });
  assert.equal(db.prepare('PRAGMA table_info(rm_ask_match)').all().some((c) => /text|quote/u.test(c.name)), false, 'no text column');
  // A line pick stores the row id, never the text.
  const jev2 = fakeJev(() => ({ fit: { type: 'noul', noul: 0.7 }, fit_level: { type: 'score', score: 3.1, confidence: 0.6, probabilities: {} }, evidence: { type: 'choice', choice: 'L1', confidence: 0.6, probabilities: {} } }));
  await judgeAskPerson(db, jev2, ask, 'p:vc', { now: NOW + 1, force: true });
  const row2 = db.prepare('SELECT evidence_kind, evidence_id FROM rm_ask_match').get();
  assert.equal(row2.evidence_kind, 'line');
  assert.equal(Number(row2.evidence_id), ids[0]);
  assert.match(askMatches(db, ask, { now: NOW })[0].fitsBecause, /invest at seed/u);
  assert.equal(askStatus(db, ask, { now: NOW }).judged, 1);
  assert.ok(FIT.sha && FIT_LEVEL.sha);
});

test('the pass fans out, below-threshold people are judged but not matches, and the order is unjudged then stale', async () => {
  const db = openDb(':memory:');
  seed(db, 'p:a', { name: 'A Person', lines: ['a line about seed rounds'] });
  seed(db, 'p:b', { name: 'B Person', lines: ['another line about nothing'] });
  seed(db, 'p:c', { name: 'C Person', lines: ['a third line'] });
  const ask = createAsk(db, 'seed investors', { now: NOW });
  assert.deepEqual(askJudgmentOrder(db, ask, { now: NOW }).length, 3);
  const jev = fakeJev((state) => ({
    fit: { type: 'noul', noul: /seed/u.test(JSON.stringify(state.lines)) ? 0.8 : 0.1 },
    fit_level: { type: 'score', score: /seed/u.test(JSON.stringify(state.lines)) ? 3.2 : 0.4, confidence: 0.6, probabilities: {} },
    evidence: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: {} },
  }));
  const totals = await runAskPass(db, jev, ask, ['p:a', 'p:b', 'p:c', 'p:c'], { now: NOW, concurrency: 2 });
  assert.deepEqual(totals, { asked: 3, cached: 0, declined: 0, inputTokens: 1200 });
  const m = askMatches(db, ask, { now: NOW });
  assert.deepEqual(m.map((x) => x.personKey), ['p:a'], `only p:a clears level ${ASK_MATCH_MIN_LEVEL} or fit 0.6`);
  assert.equal(m[0].fitsBecause, null, 'none picked: no because line');
  assert.equal(askMatches(db, ask, { now: NOW, all: true }).length, 3);
  assert.deepEqual(askJudgmentOrder(db, ask, { now: NOW }), [], 'everyone judged and fresh: nothing due');
  assert.equal(askJudgmentOrder(db, ask, { now: NOW + 15 * DAY }).length, 3, 'two weeks on, all three are stale');
  const paused = { ...jev, state: 'paused' };
  const stopped = await runAskPass(db, paused, ask, ['p:a'], { now: NOW });
  assert.equal(stopped.declined, 1);
});

test('the routes are bearer-only, create starts a pass, matches read back, and the sweep tick advances active asks', async () => {
  const jev = fakeJev(() => ({ fit: { type: 'noul', noul: 0.9 }, fit_level: { type: 'score', score: 3.5, confidence: 0.7, probabilities: {} }, evidence: { type: 'choice', choice: 'F2', confidence: 0.8, probabilities: {} } }));
  const server = await start({ port: 0, dbPath: ':memory:', llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN, peopleProjectionAutoRebuild: false, relationshipJev: jev });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    seed(server.db, 'p:vc', { name: 'Vera Capital', linkedin: { position: 'Partner', company: 'Health Seed Fund' }, lines: ['we invest at seed'] });
    assert.equal((await fetch(`${base}/admin/relationship/ask`)).status, 401, 'bearer-only');
    const created = await (await call('POST', '/admin/relationship/ask', { text: 'a seed investor' })).json();
    assert.equal(created.ask.text, 'a seed investor');
    assert.equal(created.started.started, true, JSON.stringify(created.started));
    await new Promise((r) => setTimeout(r, 150));
    const list = await (await call('GET', '/admin/relationship/ask')).json();
    assert.equal(list.asks.length, 1);
    assert.equal(list.asks[0].status.judged, 1);
    const matches = await (await call('GET', `/admin/relationship/ask/matches?id=${created.ask.id}`)).json();
    assert.equal(matches.matches[0].name, 'Vera Capital');
    assert.equal(matches.matches[0].fitsBecause, 'company: Health Seed Fund');
    assert.equal((await call('POST', '/admin/relationship/ask', { text: 'x', extra: 1 })).status, 400);
    assert.equal((await call('POST', '/admin/relationship/ask', { text: 'x' })).status, 400, 'too short');
    const paused = await (await call('POST', '/admin/relationship/ask/active', { id: created.ask.id, active: false })).json();
    assert.equal(paused.ask.active, false);
    assert.equal((await call('GET', '/admin/relationship/ask/matches?id=999')).status, 404);
    const del = await (await call('POST', '/admin/relationship/ask/delete', { id: created.ask.id })).json();
    assert.equal(del.deleted, true);
  } finally { await server.close(); }
});
