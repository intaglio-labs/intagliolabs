import test from 'node:test';
import assert from 'node:assert/strict';

import { SummaryQueue } from '../server/people/summaryQueue.mjs';

const turn = () => new Promise((resolve) => setImmediate(resolve));

async function until(predicate, message = 'condition') {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await turn();
  }
  assert.fail(`timed out waiting for ${message}`);
}

function controlledRunner() {
  const starts = [];
  const releases = new Map();
  const run = ({ key, signal, onProgress }) => new Promise((resolve, reject) => {
    starts.push(key);
    onProgress({ stage: 'reading', completed: 0, total: 2 });
    const abort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    releases.set(key, (result = { text: key }) => {
      signal.removeEventListener('abort', abort);
      resolve(result);
    });
  });
  return { run, starts, release: (key, value) => releases.get(key)?.(value) };
}

test('background summaries run in exact top-to-bottom order', async () => {
  const runner = controlledRunner();
  const queue = new SummaryQueue({ run: runner.run });
  queue.enqueue(['first', 'second', 'third'].map((key) => ({ key, year: 2026 })));
  await until(() => runner.starts.length === 1, 'first summary');
  assert.deepEqual(runner.starts, ['first']);
  runner.release('first');
  await until(() => runner.starts.length === 2, 'second summary');
  runner.release('second');
  await until(() => runner.starts.length === 3, 'third summary');
  runner.release('third');
  await until(() => queue.active === null && queue.pending.length === 0, 'empty queue');
  assert.deepEqual(runner.starts, ['first', 'second', 'third']);
});

test('a sized queue runs two summaries together without starting a third', async () => {
  const runner = controlledRunner();
  const queue = new SummaryQueue({ run: runner.run, concurrency: 2 });
  queue.enqueue(['first', 'second', 'third'].map((key) => ({ key, year: 2026 })));
  await until(() => runner.starts.length === 2, 'two concurrent summaries');
  assert.deepEqual(runner.starts, ['first', 'second']);
  runner.release('first');
  await until(() => runner.starts.length === 3, 'third summary after a slot opens');
  runner.release('second');
  runner.release('third');
  await until(() => queue.active === null && queue.pending.length === 0, 'empty queue');
});

test('a live concurrency provider can switch between saver and god mode', async () => {
  const runner = controlledRunner();
  let limit = 1;
  const queue = new SummaryQueue({
    run: runner.run,
    concurrency: 2,
    concurrencyProvider: () => limit,
  });
  queue.enqueue(['first', 'second', 'third'].map((key) => ({ key, year: 2026 })));
  await until(() => runner.starts.length === 1, 'Battery Saver slot');
  assert.deepEqual(runner.starts, ['first']);
  limit = 2;
  runner.release('first');
  await until(() => runner.starts.length === 3, 'God Mode slots');
  assert.deepEqual(runner.starts, ['first', 'second', 'third']);
  runner.release('second');
  runner.release('third');
  await until(() => queue.active === null && queue.pending.length === 0, 'empty queue');
});

test('a clicked person preempts background work, which then resumes in rank order', async () => {
  const runner = controlledRunner();
  const queue = new SummaryQueue({ run: runner.run });
  queue.enqueue(['first', 'second', 'third'].map((key) => ({ key, year: 2026 })));
  await until(() => runner.starts.length === 1, 'first summary');
  queue.request('third', 2026);
  await until(() => runner.starts.length === 2, 'promoted third summary');
  assert.deepEqual(runner.starts, ['first', 'third']);
  runner.release('third');
  await until(() => runner.starts.length === 3, 'resumed first summary');
  assert.deepEqual(runner.starts, ['first', 'third', 'first']);
  runner.release('first');
  await until(() => runner.starts.length === 4, 'second summary');
  runner.release('second');
  await until(() => queue.active === null && queue.pending.length === 0, 'empty queue');
  assert.deepEqual(runner.starts, ['first', 'third', 'first', 'second']);
  assert.equal(queue.view('third', 2026)?.state, 'done', 'clicked result waits for polling consumption');
  queue.consume(queue.view('third', 2026));
  assert.equal(queue.view('third', 2026), null);
});

test('interactive work pauses and preempts summaries until explicitly resumed', async () => {
  const runner = controlledRunner();
  const queue = new SummaryQueue({ run: runner.run });
  queue.enqueue([{ key: 'first', year: 2026 }, { key: 'second', year: 2026 }]);
  await until(() => runner.starts.length === 1, 'first summary');
  const resume = await queue.pauseForInteractive();
  await turn();
  assert.equal(queue.active, null);
  assert.deepEqual(runner.starts, ['first']);
  resume();
  await until(() => runner.starts.length === 2, 'resumed first summary');
  assert.deepEqual(runner.starts, ['first', 'first']);
  runner.release('first');
  await until(() => runner.starts.length === 3, 'second summary');
  runner.release('second');
  await until(() => queue.active === null && queue.pending.length === 0, 'empty queue');
});

test('synchronous runner failures become pollable failures instead of escaping', async () => {
  const queue = new SummaryQueue({ run: () => { throw new Error('boom'); } });
  const job = queue.request('person', 2026);
  await until(() => job.state === 'failed', 'failed job');
  assert.match(job.error.message, /boom/u);
});

test('a retryable background outage backs off instead of failing every queued person', async () => {
  const starts = [];
  const queue = new SummaryQueue({
    retryDelayMs: 20,
    isRetryable: (error) => error.message === 'offline',
    run: async ({ key }) => {
      starts.push(key);
      if (starts.length === 1) throw new Error('offline');
      return { text: key };
    },
  });
  queue.enqueue([{ key: 'first', year: 2026 }, { key: 'second', year: 2026 }]);
  await until(() => starts.length === 1, 'first failed attempt');
  await turn();
  assert.deepEqual(starts, ['first'], 'the next person is not hammered during the outage');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await until(() => starts.length === 3, 'retry and remaining work');
  assert.deepEqual(starts, ['first', 'first', 'second']);
  await until(() => queue.active === null && queue.pending.length === 0, 'empty queue');
});

test('a completion observer can persist a receipt without retaining the job', async () => {
  const settled = [];
  const queue = new SummaryQueue({
    run: async ({ key }) => ({ text: `summary for ${key}` }),
    onSettled: (receipt) => settled.push(receipt),
  });
  queue.enqueue([{ key: 'first', year: 2026 }]);
  await until(() => settled.length === 1, 'completion receipt');
  await until(() => queue.active === null && queue.pending.length === 0, 'empty queue');
  assert.deepEqual(settled, [{
    key: 'first', year: 2026, corpusStamp: null,
    result: { text: 'summary for first' },
  }]);
  assert.equal(queue.view('first', 2026), null, 'background prose is not retained in process memory');
});

test('a progress observer receives aggregate work without retaining it in the queue API', async () => {
  const observed = [];
  const queue = new SummaryQueue({
    run: async ({ onProgress }) => {
      onProgress({ stage: 'reading', completed: 2, total: 5 });
      return { text: 'done' };
    },
    onProgress: (receipt) => observed.push(receipt),
  });
  queue.enqueue([{ key: 'first', year: 2026 }]);
  await until(() => observed.length === 1, 'progress receipt');
  assert.deepEqual(observed, [{
    key: 'first', year: 2026, corpusStamp: null,
    progress: { stage: 'reading', completed: 2, total: 5 },
  }]);
});

test('a new corpus generation cancels the old job and settles only the new one', async () => {
  const runner = controlledRunner();
  const settled = [];
  const queue = new SummaryQueue({
    run: runner.run,
    onSettled: (receipt) => settled.push(receipt),
  });
  queue.enqueue([{
    key: 'first', year: 2026, corpusStamp: 'a'.repeat(64),
  }]);
  await until(() => runner.starts.length === 1, 'old generation');
  queue.enqueue([{
    key: 'first', year: 2026, corpusStamp: 'b'.repeat(64),
  }]);
  await until(() => runner.starts.length === 2, 'replacement generation');
  runner.release('first', { text: 'fresh summary' });
  await until(() => settled.length === 1, 'fresh completion receipt');
  assert.equal(settled[0].corpusStamp, 'b'.repeat(64));
  assert.equal(settled[0].result.text, 'fresh summary');
  await until(() => queue.active === null && queue.pending.length === 0, 'empty queue');
});

test('an old foreground receipt cannot consume its replacement generation', async () => {
  const queue = new SummaryQueue({ run: async ({ corpusStamp }) => ({ text: corpusStamp ?? 'old' }) });
  const old = queue.request('first', 2026);
  await until(() => old.state === 'done', 'old foreground completion');
  queue.enqueue([{
    key: 'first', year: 2026, corpusStamp: 'c'.repeat(64),
  }]);
  const replacement = queue.view('first', 2026);
  assert.notEqual(replacement, old);
  queue.consume(old);
  assert.equal(queue.view('first', 2026), replacement);
  await until(() => replacement.state === 'done', 'replacement completion');
  queue.consume(replacement);
});

// BATTERY SAVER HAS TO DO SOMETHING ON THE MACHINE IT WAS ADDED FOR.
//
// Its only consumer was the concurrency provider, and ops/inference-profiles.json
// gives summaryConcurrency 1 to both `compact` and `balanced` — so on every Mac
// under 24 GB it resolved `battery_saver ? 1 : 1` and the setting was inert.
// Measured on an 18 GB / 12-core machine. Resting between background passes is a
// lever that works at concurrency 1, which is the whole point.

test('battery saver rests between background jobs', async () => {
  const started = [];
  const q = new SummaryQueue({
    run: ({ key }) => { started.push(key); return Promise.resolve({ text: 'x' }); },
    restProvider: () => 5,
  });
  q.enqueue([{ key: 'a', year: 2026 }, { key: 'b', year: 2026 }], { priority: 1 });
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(started.length, 1, 'the second job waits out the rest');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(started.length, 2, 'and then runs');
});

test('god mode does not rest', async () => {
  const started = [];
  const q = new SummaryQueue({
    run: ({ key }) => { started.push(key); return Promise.resolve({ text: 'x' }); },
    restProvider: () => 0,
  });
  q.enqueue([{ key: 'a', year: 2026 }, { key: 'b', year: 2026 }], { priority: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started.length, 2, 'both run without an interval');
});

test('a foreground click cuts through the rest', async () => {
  // Otherwise a background power policy becomes foreground latency, which is
  // the failure the whole seam exists to avoid.
  const started = [];
  const q = new SummaryQueue({
    run: ({ key }) => { started.push(key); return Promise.resolve({ text: 'x' }); },
    restProvider: () => 10_000,
  });
  q.enqueue([{ key: 'a', year: 2026 }, { key: 'b', year: 2026 }], { priority: 1 });
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(started.length, 1, 'resting after the first');
  q.enqueue([{ key: 'urgent', year: 2026 }], { priority: 2 });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(started.includes('urgent'),
    'the clicked person must not wait out a 10s nap');
});

test('an empty queue does not rest', async () => {
  const started = [];
  const q = new SummaryQueue({
    run: ({ key }) => { started.push(key); return Promise.resolve({ text: 'x' }); },
    restProvider: () => 10_000,
  });
  q.enqueue([{ key: 'only', year: 2026 }], { priority: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started.length, 1);
  assert.equal(q.restTimer, null, 'nothing is waiting, so there is nothing to throttle');
});

test('back-to-back foreground jobs never rest between each other', () => {
  // The rest is a BACKGROUND policy. Someone clicking through three people in a
  // row must not collect a nap between each one — that turns a battery setting
  // into latency at exactly the moment they are watching.
  const started = [];
  const q = new SummaryQueue({
    run: ({ key }) => { started.push(key); return Promise.resolve({ text: 'x' }); },
    restProvider: () => 10_000,
  });
  q.enqueue([{ key: 'one', year: 2026 }, { key: 'two', year: 2026 }], { priority: 2 });
  return new Promise((r) => setTimeout(r, 30)).then(() => {
    assert.deepEqual(started.sort(), ['one', 'two'],
      'both foreground jobs ran without waiting out a rest');
    assert.equal(q.restTimer, null);
  });
});
