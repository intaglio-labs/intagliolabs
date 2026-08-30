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
