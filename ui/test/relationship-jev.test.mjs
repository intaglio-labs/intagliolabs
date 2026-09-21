// The judgment engine's contract, driven through an injected transport so no
// test opens a socket. Every assertion here fails against a tree without
// ui/server/relationship/jev.mjs (the import throws), and the leak test is the
// one that matters most: a planted token in the fake response must reach no
// returned object, counter or cached row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createJev, choiceQuestion, scoreQuestion, noulQuestion, estimateTokens,
  JUDGMENT_SCHEMA, recordJudgment, judgmentFor, pruneJudgments, recordUsage, usageToday, jevStatus,
  USD_PER_MTOK, MAX_STATE_TOKENS, CIRCUIT_FAILURES, JEV_ENDPOINT,
} from '../server/relationship/jev.mjs';

const KEY = 'apikey_test_' + 'a'.repeat(40);

function keyFile(contents = KEY) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-key-'));
  const path = join(dir, 'typesafe-api-key.txt');
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function fakeTransport(script) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = script.shift();
    if (typeof next === 'function') return next();
    return next;
  };
  return { transport, calls };
}

const ENDED = choiceQuestion('How did it end?', Object.freeze([
  ['warm', 'good terms'], ['neutral', 'just stopped'], ['bad', 'conflict or coldness'],
]));
const WORTH = noulQuestion('Would the owner want a reminder?');
const QUOTE = scoreQuestion('How much to reply to?', Object.freeze(['nothing', 'a little', 'something', 'specific', 'open thread']));

function jevWith(transportOrScript, extra = {}) {
  const { transport, calls } = Array.isArray(transportOrScript) ? fakeTransport(transportOrScript) : transportOrScript;
  const keyPath = extra.keyPath ?? keyFile();
  const jev = createJev({ relationshipMemory: { jev: { keyPath, transport, sleep: async () => {}, env: {}, ...extra } } });
  return { jev, calls, keyPath };
}

test('question helpers pin order into a sha and refuse unordered input', () => {
  assert.equal(ENDED.sha, choiceQuestion('How did it end?', Object.freeze([
    ['warm', 'good terms'], ['neutral', 'just stopped'], ['bad', 'conflict or coldness'],
  ])).sha, 'same instructions and order, same sha');
  assert.notEqual(ENDED.sha, choiceQuestion('How did it end?', Object.freeze([
    ['bad', 'conflict or coldness'], ['neutral', 'just stopped'], ['warm', 'good terms'],
  ])).sha, 'a reorder is a different question');
  assert.throws(() => choiceQuestion('x', [['a', 'b'], ['c', 'd']]), /frozen literal/u, 'an unfrozen array is refused');
  assert.throws(() => choiceQuestion('x', new Set([['a', 'b']])), /array/u);
  assert.throws(() => scoreQuestion('x', Object.freeze(['only one'])), RangeError);
  assert.throws(() => scoreQuestion('x', Object.freeze(new Array(11).fill('l'))), RangeError);
  assert.deepEqual(ENDED.options, ['warm', 'neutral', 'bad']);
  assert.equal(QUOTE.levels, 5);
  assert.equal(WORTH.question.type, 'noul');
});

test('no key file means unconfigured: no call, a null answer, a skipped counter', async () => {
  const { jev, calls } = jevWith([], { keyPath: join(mkdtempSync(join(tmpdir(), 'jev-nokey-')), 'missing.txt') });
  assert.equal(jev.state, 'unconfigured');
  assert.equal(jev.disabled, true);
  const out = await jev.ask({ state: { a: 1 }, questions: { ended: ENDED } });
  assert.equal(out, null);
  assert.equal(calls.length, 0);
  assert.equal(jev.counters.skipped, 1);
  assert.equal(jev.lastError?.kind, 'unconfigured');
});

test('a good answer comes back sanitized: numbers and offered options only, legend dropped', async () => {
  const planted = 'PLANTED-LEAK-7f3a';
  const { jev, calls } = jevWith([response(200, {
    model: 'jev-1.13.0',
    answers: {
      ended: { type: 'choice', choice: 'warm', confidence: 0.8, probabilities: { warm: 0.8, neutral: 0.15, bad: 0.05, stranger: 0.9 }, legend: planted, echoed_state: planted },
      worth: { type: 'noul', noul: 0.62, note: planted },
      quote: { type: 'score', score: 3.4, confidence: 0.5, probabilities: { 3: 0.6, 4: 0.4 }, legend: { 0: planted } },
    },
    usage: { input_tokens: 1234, output_tokens: 9 },
  })]);
  const out = await jev.ask({ state: { lines: ['hello there'] }, questions: { ended: ENDED, worth: WORTH, quote: QUOTE } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].body.model, 'jev-latest');
  assert.deepEqual(Object.keys(calls[0].body.questions), ['ended', 'worth', 'quote']);
  assert.deepEqual(out.answers.ended, { type: 'choice', choice: 'warm', probabilities: { warm: 0.8, neutral: 0.15, bad: 0.05 }, confidence: 0.8 });
  assert.deepEqual(out.answers.worth, { type: 'noul', noul: 0.62 });
  assert.deepEqual(out.answers.quote, { type: 'score', score: 3.4, probabilities: { 3: 0.6, 4: 0.4 }, confidence: 0.5 });
  assert.equal(out.usage.input_tokens, 1234);
  assert.equal(out.model, 'jev-1.13.0');
  assert.ok(!JSON.stringify(out).includes(planted), 'nothing planted in the response survives sanitization');
  assert.ok(!JSON.stringify(jev.counters).includes(planted));
  assert.equal(jev.counters.inputTokens, 1234);
  assert.equal(jev.costUsd(), (1234 / 1e6) * USD_PER_MTOK);
  assert.equal(jev.state, 'ok');
});

test('an option we did not offer, or a score off the scale, is a missing answer, not a value', async () => {
  const { jev } = jevWith([response(200, { answers: {
    ended: { type: 'choice', choice: 'stranger', probabilities: {}, confidence: 1 },
    quote: { type: 'score', score: 7.5 },
    worth: { type: 'noul', noul: 1.7 },
  }, usage: { input_tokens: 10 } })]);
  const out = await jev.ask({ state: {}, questions: { ended: ENDED, quote: QUOTE, worth: WORTH } });
  assert.deepEqual(out.answers, {});
});

test('429 backs off and retries, then succeeds; the retry is counted', async () => {
  const { jev, calls } = jevWith([response(429, {}), response(529, {}), response(200, { answers: { worth: { type: 'noul', noul: 0.4 } }, usage: { input_tokens: 5 } })]);
  const out = await jev.ask({ state: {}, questions: { worth: WORTH } });
  assert.equal(out.answers.worth.noul, 0.4);
  assert.equal(calls.length, 3);
  assert.equal(jev.counters.retries, 2);
  assert.equal(jev.counters.errors, 0, 'a retried call that lands is not an error');
});

test('retries exhausted is a null with fallback, and five failures open the circuit', async () => {
  let t = 1_000_000;
  const script = [];
  for (let i = 0; i < 5 * 4; i += 1) script.push(response(429, {}));
  const { jev, calls } = jevWith(script, { now: () => t });
  for (let i = 0; i < CIRCUIT_FAILURES; i += 1) {
    assert.equal(await jev.ask({ state: {}, questions: { worth: WORTH } }), null);
  }
  assert.equal(calls.length, 5 * 4, 'four attempts per ask, five asks');
  assert.equal(jev.state, 'paused');
  assert.equal(await jev.ask({ state: {}, questions: { worth: WORTH } }), null);
  assert.equal(calls.length, 5 * 4, 'a paused engine makes no request');
  assert.equal(jev.lastError?.kind, 'paused');
  t += 15 * 60_000 + 1;
  assert.equal(jev.state, 'ok', 'the circuit closes after fifteen minutes');
});

test('401 latches rejected for the process until the key file changes', async () => {
  const { jev, calls, keyPath } = jevWith([response(401, {}), response(200, { answers: { worth: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 3 } })]);
  assert.equal(await jev.ask({ state: {}, questions: { worth: WORTH } }), null);
  assert.equal(jev.state, 'rejected');
  assert.equal(await jev.ask({ state: {}, questions: { worth: WORTH } }), null);
  assert.equal(calls.length, 1, 'a rejected key is never retried');
  // Rotating the key (a new stamp) clears the latch.
  writeFileSync(keyPath, `${KEY}b\n`, { mode: 0o600 });
  const future = new Date(Date.now() + 5_000);
  utimesSync(keyPath, future, future);
  assert.equal(jev.state, 'ok');
  const out = await jev.ask({ state: {}, questions: { worth: WORTH } });
  assert.equal(out.answers.worth.noul, 0.5);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${KEY}b`);
});

test('a timeout and a network error fall back without retry and count toward the circuit', async () => {
  const timeout = () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  const offline = () => { throw new TypeError('fetch failed'); };
  const { jev, calls } = jevWith([timeout, offline]);
  assert.equal(await jev.ask({ state: {}, questions: { worth: WORTH } }), null);
  assert.equal(jev.lastError.kind, 'timeout');
  assert.equal(await jev.ask({ state: {}, questions: { worth: WORTH } }), null);
  assert.equal(jev.lastError.kind, 'network');
  assert.equal(calls.length, 2);
  assert.equal(jev.counters.errors, 2);
});

test('422 is our bug: counted, not retried, and it does not latch', async () => {
  const { jev, calls } = jevWith([response(422, {}), response(200, { answers: { worth: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1 } })]);
  assert.equal(await jev.ask({ state: {}, questions: { worth: WORTH } }), null);
  assert.equal(jev.lastError.kind, 'http');
  assert.equal(jev.state, 'ok');
  assert.ok((await jev.ask({ state: {}, questions: { worth: WORTH } })));
  assert.equal(calls.length, 2);
});

test('an oversize state is refused before any request', async () => {
  const { jev, calls } = jevWith([response(200, {})]);
  const big = { lines: new Array(MAX_STATE_TOKENS).fill('abcd') };
  assert.ok(estimateTokens(big) > MAX_STATE_TOKENS);
  assert.equal(await jev.ask({ state: big, questions: { worth: WORTH } }), null);
  assert.equal(calls.length, 0);
  assert.equal(jev.counters.oversize, 1);
  assert.equal(jev.lastError.kind, 'oversize');
});

test('the env override wins over the file, for tests and for a machine with no secrets dir', async () => {
  const { transport, calls } = fakeTransport([response(200, { answers: {}, usage: { input_tokens: 1 } })]);
  const jev = createJev({ relationshipMemory: { jev: { keyPath: '/nonexistent/key', transport, env: { TYPESAFE_API_KEY: 'envkey' } } } });
  assert.equal(jev.state, 'ok');
  await jev.ask({ state: {}, questions: { worth: WORTH } });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer envkey');
});

test('the cache stores closed tokens and numbers only, replaces on the same subject, prunes by age', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(JUDGMENT_SCHEMA);
  const planted = 'this is a quoted sentence';
  assert.throws(() => recordJudgment(db, { kind: 'quote', answer: planted, model: 'm', questionSha: 's' }), /closed token/u);
  assert.throws(() => recordJudgment(db, { kind: 'bogus', model: 'm', questionSha: 's' }), /unknown judgment kind/u);
  const t0 = 1_700_000_000_000;
  const a = recordJudgment(db, { personKey: 'p1', kind: 'ending', answer: 'warm', probability: 0.8, confidence: 0.7, model: 'm', questionSha: 's1', now: t0 });
  const b = recordJudgment(db, { personKey: 'p1', kind: 'ending', answer: 'bad', probability: 0.9, confidence: 0.9, model: 'm', questionSha: 's1', now: t0 + 1 });
  assert.equal(judgmentFor(db, { personKey: 'p1', kind: 'ending' }).id, b, 'newest wins');
  recordJudgment(db, { personKey: 'p1', kind: 'quote', subjectId: 42, subjectHash: 'h', score: 3.1, model: 'm', questionSha: 'q', now: t0 });
  recordJudgment(db, { personKey: 'p1', kind: 'quote', subjectId: 42, subjectHash: 'h', score: 3.9, model: 'm', questionSha: 'q', now: t0 + 2 });
  assert.equal(Number(db.prepare(`SELECT COUNT(*) n FROM rm_judgment WHERE kind='quote'`).get().n), 1, 'same subject and sha replaces');
  assert.equal(judgmentFor(db, { kind: 'quote', subjectId: 42, subjectHash: 'h', questionSha: 'q' }).score, 3.9);
  assert.equal(judgmentFor(db, { kind: 'quote', subjectId: 42, subjectHash: 'other', questionSha: 'q' }), null, 'an edited row is a different subject');
  const pruned = pruneJudgments(db, { now: t0 + 91 * 86_400_000 });
  assert.equal(pruned, 3);
  assert.equal(judgmentFor(db, { personKey: 'p1', kind: 'ending' }), null);
  assert.ok(a);
});

test('usage accumulates per local day and the status block derives cost, never stores it', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(JUDGMENT_SCHEMA);
  const now = Date.now();
  recordUsage(db, { inputTokens: 1_000_000, now });
  recordUsage(db, { inputTokens: 500_000, errors: 1, now });
  const u = usageToday(db, now);
  assert.equal(u.calls, 2);
  assert.equal(u.inputTokens, 1_500_000);
  assert.equal(u.errors, 1);
  assert.equal(u.costUsd, 1.5 * USD_PER_MTOK);
  assert.equal(db.prepare('PRAGMA table_info(rm_jev_usage)').all().some((c) => /cost/iu.test(c.name)), false, 'no cost column');
  const status = jevStatus(db, null, now);
  assert.deepEqual(status, { state: 'unconfigured', enabled: false, callsToday: 2, inputTokensToday: 1_500_000, costUsdToday: 0.063 });
});
