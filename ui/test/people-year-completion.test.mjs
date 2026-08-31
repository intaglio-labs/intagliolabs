import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PeopleYearCompletion } from '../server/people/yearCompletion.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'people-year-'));
  const enqueued = [];
  const queue = { enqueue(items) { enqueued.push(...items); } };
  const manager = new PeopleYearCompletion({
    path: join(dir, 'summaries.db'), queue, now: () => 1234,
  });
  return { dir, enqueued, manager };
}

test('one year queues every summary-eligible profile and survives restart', () => {
  const fx = fixture();
  try {
    const people = [
      { key: 'person-a', messages: 200 },
      { key: 'person-b', messages: 10 },
      { key: 'too-thin', messages: 9 },
    ];
    const first = fx.manager.begin({ year: 2026, corpusStamp: 'a'.repeat(64), people });
    assert.equal(first.profiles, 3);
    assert.equal(first.summariesTotal, 2);
    assert.equal(first.workUnitsTotal, 4);
    assert.equal(first.workUnitsComplete, 0);
    assert.equal(first.estimatedRemainingMs, 360_000);
    assert.deepEqual(fx.enqueued, [
      { key: 'person-a', year: 2026, corpusStamp: 'a'.repeat(64) },
      { key: 'person-b', year: 2026, corpusStamp: 'a'.repeat(64) },
    ]);
    fx.manager.record({
      key: 'person-a', year: 2026, corpusStamp: 'a'.repeat(64), result: { text: 'done' },
    });
    const restarted = new PeopleYearCompletion({
      path: join(fx.dir, 'summaries.db'), queue: fx.manager.queue, now: () => 5678,
    });
    const status = restarted.resume(2026, 'a'.repeat(64));
    assert.equal(status.summariesComplete, 1);
    assert.equal(status.summariesPending, 1);
    assert.equal(status.workUnitsComplete, 2);
    assert.equal(status.estimatedRemainingMs, 180_000);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('active chunk progress refines and advances the remaining-work estimate', () => {
  const fx = fixture();
  try {
    fx.manager.begin({
      year: 2026, corpusStamp: 'e'.repeat(64),
      people: [{ key: 'person-a', messages: 10 }],
    });
    assert.equal(fx.manager.progress({
      key: 'person-a', year: 2026,
      corpusStamp: 'e'.repeat(64),
      progress: { stage: 'reading', completed: 2, total: 5 },
    }), true);
    const status = fx.manager.existing(2026, 'e'.repeat(64));
    assert.equal(status.workUnitsTotal, 5, 'the exact chunk plan replaces the row-count floor');
    assert.equal(status.workUnitsComplete, 2);
    assert.equal(status.estimatedRemainingMs, 270_000);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('thin evidence is a terminal skip and completes the year', () => {
  const fx = fixture();
  try {
    fx.manager.begin({
      year: 2026, corpusStamp: 'b'.repeat(64),
      people: [{ key: 'person-a', messages: 10 }],
    });
    fx.manager.record({
      key: 'person-a', year: 2026,
      corpusStamp: 'b'.repeat(64),
      result: { text: null, reason: 'only 2 substantive messages in 2026' },
    });
    const status = fx.manager.existing(2026, 'b'.repeat(64));
    assert.equal(status.complete, true);
    assert.equal(status.summariesSkipped, 1);
    assert.equal(status.summariesPending, 0);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a changed year stamp resets only that year work receipt', () => {
  const fx = fixture();
  try {
    fx.manager.begin({
      year: 2026, corpusStamp: 'c'.repeat(64),
      people: [{ key: 'person-a', messages: 10 }],
    });
    fx.manager.record({
      key: 'person-a', year: 2026, corpusStamp: 'c'.repeat(64), result: { text: 'done' },
    });
    const reset = fx.manager.begin({
      year: 2026, corpusStamp: 'd'.repeat(64),
      people: [{ key: 'person-a', messages: 12 }, { key: 'person-b', messages: 30 }],
    });
    assert.equal(reset.complete, false);
    assert.equal(reset.summariesTotal, 2);
    assert.equal(reset.summariesComplete, 0);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a stale summary generation cannot update a replacement year receipt', () => {
  const fx = fixture();
  try {
    fx.manager.begin({
      year: 2026, corpusStamp: 'f'.repeat(64),
      people: [{ key: 'person-a', messages: 10 }],
    });
    fx.manager.begin({
      year: 2026, corpusStamp: '0'.repeat(64),
      people: [{ key: 'person-a', messages: 12 }],
    });
    assert.equal(fx.manager.progress({
      key: 'person-a', year: 2026, corpusStamp: 'f'.repeat(64),
      progress: { stage: 'writing', completed: 2, total: 2 },
    }), false);
    assert.equal(fx.manager.record({
      key: 'person-a', year: 2026, corpusStamp: 'f'.repeat(64),
      result: { text: 'stale summary' },
    }), false);
    const current = fx.manager.existing(2026, '0'.repeat(64));
    assert.equal(current.complete, false);
    assert.equal(current.summariesComplete, 0);
    assert.equal(current.summariesPending, 1);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('unobserved live corpus changes reject completion before the receipt resets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'people-year-live-'));
  let liveStamp = '2'.repeat(64);
  const manager = new PeopleYearCompletion({
    path: join(dir, 'summaries.db'), queue: { enqueue() {} },
    isCorpusStampCurrent: (_year, stamp) => stamp === liveStamp,
  });
  try {
    manager.begin({
      year: 2026, corpusStamp: liveStamp,
      people: [{ key: 'person-a', messages: 10 }],
    });
    liveStamp = '3'.repeat(64);
    assert.equal(manager.record({
      key: 'person-a', year: 2026, corpusStamp: '2'.repeat(64),
      result: { text: 'now stale' },
    }), false);
    const oldReceipt = manager.existing(2026, '2'.repeat(64));
    assert.equal(oldReceipt.complete, false);
    assert.equal(oldReceipt.summariesPending, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid local-model output is retried only a bounded number of times', () => {
  const fx = fixture();
  try {
    const corpusStamp = '1'.repeat(64);
    fx.manager.begin({
      year: 2026, corpusStamp,
      people: [{ key: 'person-a', messages: 10 }],
    });
    const invalid = { text: null, reason: 'local model returned an invalid annual summary' };
    assert.equal(fx.manager.record({
      key: 'person-a', year: 2026, corpusStamp, result: invalid,
    }), true);
    assert.equal(fx.manager.existing(2026, corpusStamp).complete, false);
    assert.equal(fx.manager.record({
      key: 'person-a', year: 2026, corpusStamp, result: invalid,
    }), true);
    assert.equal(fx.manager.existing(2026, corpusStamp).complete, false);
    assert.equal(fx.manager.record({
      key: 'person-a', year: 2026, corpusStamp, result: invalid,
    }), true);
    const finished = fx.manager.existing(2026, corpusStamp);
    assert.equal(finished.complete, true);
    assert.equal(finished.summariesSkipped, 1);
    assert.equal(finished.summariesPending, 0);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
