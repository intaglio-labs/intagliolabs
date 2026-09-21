// The distiller's prefilter: below-threshold episodes are skipped, every
// doubt distills, and every failure path answers "distill all". Fake engine,
// in-memory database, no socket. Fails against a tree without prefilter.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/hermes.mjs';
import { prefilterEpisodes, episodeState, PREFILTER_THRESHOLD, EPISODES_PER_CALL } from '../server/relationship/prefilter.mjs';
import { recordUsage } from '../server/relationship/jev.mjs';

// In the episode store `quotable` marks the OWNER's lines (isQuotable is fromMe).
const lines = (pairs) => pairs.map(([who, text], i) => ({ line_no: i, quotable: who === 'me' ? 1 : 0, speaker: who, text }));
const READ = {
  1: lines([['me', 'i will send you the deck tomorrow'], ['them', 'great thanks']]),
  2: lines([['them', 'lol'], ['me', 'haha']]),
  3: lines([['them', 'can you intro me to your designer?'], ['me', 'sure']]),
  4: [],
};
const readLines = (id) => READ[id] ?? [];

function fakeJev(answer, state = 'ok') {
  const asks = [];
  return { asks, state, ask: async (body) => { asks.push(body); return answer(body); } };
}

test('episodeState tags the owner as you and the other person as them, clips and bounds', () => {
  const st = episodeState(lines([['me', 'x'.repeat(400)], ['them', 'y'], ['them', '   ']]));
  assert.equal(st.length, 2, 'a blank line is dropped');
  assert.equal(st[0].who, 'you');
  assert.equal(st[0].text.length, 160);
  assert.equal(st[1].who, 'them');
  const many = episodeState(lines(Array.from({ length: 30 }, (_, i) => ['them', `line ${i}`])));
  assert.equal(many.length, 20, 'the last twenty lines');
  assert.equal(many[0].text, 'line 10');
});

test('skips episodes under the threshold, distills the rest and any doubt, records usage', async () => {
  const db = openDb(':memory:');
  const jev = fakeJev(({ questions }) => {
    const answers = {};
    for (const id of Object.keys(questions)) {
      const ep = Number(id.split('_')[1]);
      const p = ep === 1 ? (id.startsWith('commit') ? 0.9 : 0.1) : ep === 2 ? 0.05 : ep === 3 ? (id.startsWith('ask') ? 0.6 : 0.1) : 0;
      answers[id] = { type: 'noul', noul: p };
    }
    return { answers, usage: { input_tokens: 500 } };
  });
  const out = await prefilterEpisodes(db, jev, [1, 2, 3, 4], { readLines });
  assert.equal(out.reason, 'judged');
  assert.deepEqual(out.distill.sort(), [1, 3, 4].sort(), 'commit, ask, and the empty episode (a doubt) distill');
  assert.deepEqual(out.skip, [2]);
  assert.equal(out.asked, 1);
  assert.equal(jev.asks.length, 1);
  assert.deepEqual(Object.keys(jev.asks[0].state), ['e1', 'e2', 'e3'], 'the empty episode never reaches the model');
  assert.equal(Number(db.prepare('SELECT input_tokens FROM rm_jev_usage').get().input_tokens), 500);
  assert.ok(PREFILTER_THRESHOLD < 0.5, 'the threshold is deliberately low');
});

test('every failure path fails open to distill all', async () => {
  const db = openDb(':memory:');
  const ids = [1, 2, 3];
  assert.deepEqual((await prefilterEpisodes(db, fakeJev(() => null, 'unconfigured'), ids, { readLines })).distill, ids);
  assert.deepEqual((await prefilterEpisodes(db, fakeJev(() => null, 'paused'), ids, { readLines })).reason, 'paused');
  const declining = fakeJev(() => null);
  assert.deepEqual((await prefilterEpisodes(db, declining, ids, { readLines })).distill, ids, 'a null answer distills the batch');
  const throwing = fakeJev(() => { throw new Error('boom'); });
  const thrown = await prefilterEpisodes(db, throwing, ids, { readLines });
  assert.deepEqual(thrown.distill, ids);
  assert.equal(thrown.reason, 'error');
  const lock = { active: true };
  assert.equal((await prefilterEpisodes(db, fakeJev(() => null), ids, { readLines, lock })).reason, 'busy');
  recordUsage(db, { inputTokens: 10 });
  assert.equal((await prefilterEpisodes(db, fakeJev(() => null), ids, { readLines, dailyTokenBudget: 5 })).reason, 'budget');
  const okJev = fakeJev(() => ({ answers: {}, usage: { input_tokens: 1 } }));
  const noAnswers = await prefilterEpisodes(db, okJev, ids, { readLines });
  assert.deepEqual(noAnswers.distill.sort(), ids, 'no answer for an episode is a doubt');
});

test('batches twenty episodes a call', async () => {
  const db = openDb(':memory:');
  const many = Array.from({ length: 45 }, (_, i) => i + 100);
  const read = () => lines([['them', 'a real question about the roadmap?']]);
  const jev = fakeJev(({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.9 }])), usage: { input_tokens: 10 } }));
  const out = await prefilterEpisodes(db, jev, many, { readLines: read });
  assert.equal(jev.asks.length, Math.ceil(45 / EPISODES_PER_CALL));
  assert.equal(out.distill.length, 45);
});
