// One honest queue, with a machine-sized number of local-model slots.
//
// Background summary warming follows the People list's rank order. A person
// the reader clicks is promoted ahead of that work; interactive chat can pause
// the queue and preempt the current summary at a chunk boundary (completed
// reductions are already durable). Nothing here stores message content.

const idFor = (key, year) => `${year}\0${key}`;
const abortError = (signal) => signal?.aborted === true;
const FOREGROUND_RESULT_TTL_MS = 5 * 60 * 1000;

export class SummaryQueue {
  constructor({
    run,
    defer = (fn) => setImmediate(fn),
    isRetryable = () => false,
    retryDelayMs = 30_000,
    concurrency = 1,
    concurrencyProvider = null,
    onSettled = () => {},
    onProgress = () => {},
  } = {}) {
    if (typeof run !== 'function') throw new TypeError('SummaryQueue requires run');
    this.run = run;
    this.defer = defer;
    this.isRetryable = isRetryable;
    this.retryDelayMs = retryDelayMs;
    this.concurrency = Math.max(1, Math.min(4, Number.isInteger(concurrency) ? concurrency : 1));
    this.concurrencyProvider = typeof concurrencyProvider === 'function'
      ? concurrencyProvider : null;
    this.onSettled = onSettled;
    this.onProgress = onProgress;
    this.jobs = new Map();
    this.pending = [];
    this.running = new Set();
    this.pauses = 0;
    this.pumpScheduled = false;
    this.resetting = false;
    this.nextOrder = 0;
    this.retryTimer = null;
  }

  // Compatibility for status/UI callers that only need to know whether some
  // summary is active. Detailed progress remains attached to each job.
  get active() {
    return this.running.values().next().value ?? null;
  }

  get concurrencyLimit() {
    if (!this.concurrencyProvider) return this.concurrency;
    try {
      const requested = this.concurrencyProvider();
      return Math.max(1, Math.min(this.concurrency,
        Number.isInteger(requested) ? requested : this.concurrency));
    } catch {
      return this.concurrency;
    }
  }

  // A viewed year is priority 1; a clicked person is priority 2. Re-enqueuing
  // a year never reverses its top-to-bottom order.
  enqueue(items, { priority = 1 } = {}) {
    for (const item of items ?? []) {
      this.schedule(item.key, item.year, { priority, corpusStamp: item.corpusStamp });
    }
  }

  schedule(key, year, { priority = 1, corpusStamp } = {}) {
    const id = idFor(key, year);
    let job = this.jobs.get(id);
    // A new durable year receipt supersedes every older view of this person-year,
    // including a foreground promotion. Keeping one job per identity prevents
    // an older runner from overwriting the new generation's summary cache.
    if (job && typeof corpusStamp === 'string' && corpusStamp !== job.corpusStamp) {
      const previous = job;
      const carriedPriority = Math.max(priority, previous.priority);
      const carriedOrder = previous.order;
      this.supersede(previous);
      job = this.makeJob({
        id, key, year, priority: carriedPriority, corpusStamp, order: carriedOrder,
      });
      this.jobs.set(id, job);
      this.pending.push(job);
    }
    if (!job) {
      job = this.makeJob({ id, key, year, priority, corpusStamp });
      this.jobs.set(id, job);
      this.pending.push(job);
    } else if (job.state === 'queued' && priority > job.priority) {
      job.priority = priority;
    } else if (job.state === 'running' && priority > job.priority) {
      job.priority = priority;
    }

    this.sortPending();
    // A click should wait for at most the current fetch cancellation, not every
    // invisible person above it. The interrupted background job returns to the
    // queue with its completed chunk cache intact.
    if (priority >= 2 && this.running.size >= this.concurrencyLimit) {
      const victim = [...this.running]
        .filter((candidate) => candidate.id !== id && candidate.priority < priority)
        .sort((a, b) => (a.priority - b.priority) || (b.order - a.order))[0];
      if (victim) this.preempt(victim);
    }
    // A human click never waits behind the speculative retry backoff.
    if (priority >= 2 && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.kick();
    return job;
  }

  makeJob({ id, key, year, priority, corpusStamp = null, order = this.nextOrder++ }) {
    return {
      id, key, year, priority, corpusStamp, state: 'queued',
      progress: { stage: 'queued' }, result: null, error: null, abort: null,
      promise: null, preempted: false, superseded: false, order, expiry: null,
    };
  }

  supersede(job) {
    if (!job || job.superseded) return;
    job.superseded = true;
    clearTimeout(job.expiry);
    const index = this.pending.indexOf(job);
    if (index >= 0) this.pending.splice(index, 1);
    if (job.state === 'running') job.abort?.abort();
  }

  request(key, year) {
    return this.schedule(key, year, { priority: 2 });
  }

  view(key, year) {
    return this.jobs.get(idFor(key, year)) ?? null;
  }

  consume(job) {
    if (job && (job.state === 'done' || job.state === 'failed')) {
      clearTimeout(job.expiry);
      if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    }
  }

  pause() {
    this.pauses += 1;
    for (const job of this.running) this.preempt(job);
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.pauses = Math.max(0, this.pauses - 1);
      this.kick();
    };
  }

  async pauseForInteractive() {
    const resume = this.pause();
    const running = [...this.running].map((job) => job.promise).filter(Boolean);
    if (running.length) await Promise.allSettled(running);
    return resume;
  }

  async reset() {
    this.resetting = true;
    this.pauses += 1;
    const running = [...this.running].map((job) => job.promise).filter(Boolean);
    for (const job of this.running) job.abort?.abort();
    if (running.length) await Promise.allSettled(running);
    for (const job of this.jobs.values()) clearTimeout(job.expiry);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.pending.length = 0;
    this.jobs.clear();
    this.running.clear();
    this.pauses = Math.max(0, this.pauses - 1);
    this.resetting = false;
  }

  sortPending() {
    // Keep the explicit rank even when a running top person is interrupted by
    // chat or a click. Array stability alone would put that person at the end
    // when it is requeued.
    this.pending.sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
  }

  preemptActive() {
    const job = this.active;
    if (job) this.preempt(job);
  }

  preempt(job) {
    if (!job || job.preempted) return;
    job.preempted = true;
    job.abort?.abort();
  }

  kick() {
    if (this.pumpScheduled || this.running.size >= this.concurrencyLimit || this.retryTimer || this.pauses > 0 || this.resetting || !this.pending.length) return;
    this.pumpScheduled = true;
    this.defer(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  pump() {
    if (this.pauses > 0 || this.resetting) return;
    const limit = this.concurrencyLimit;
    while (this.running.size < limit && this.pending.length && !this.retryTimer) {
      const job = this.pending.shift();
      if (!job) break;
      this.start(job);
    }
  }

  start(job) {
    this.running.add(job);
    job.state = 'running';
    job.error = null;
    job.preempted = false;
    job.superseded = false;
    job.abort = new AbortController();
    // Start in a promise turn so a synchronous runner failure follows the same
    // failure path as an async one instead of escaping the server callback.
    job.promise = Promise.resolve().then(() => this.run({
      key: job.key,
      year: job.year,
      corpusStamp: job.corpusStamp,
      signal: job.abort.signal,
      onProgress: (progress) => {
        job.progress = progress;
        try {
          this.onProgress({
            key: job.key, year: job.year, corpusStamp: job.corpusStamp, progress,
          });
        } catch {}
      },
    })).then((result) => {
      if (job.superseded) return;
      job.state = 'done';
      job.result = result;
      // Completion observers receive only the job identity and the constrained
      // summary result already returned by the runner. Their failure must not
      // turn a successfully cached summary into a failed foreground request;
      // a durable coordinator can rediscover the cache on its next poll.
      try {
        this.onSettled({
          key: job.key, year: job.year, corpusStamp: job.corpusStamp, result,
        });
      } catch {}
    }).catch((error) => {
      if (job.superseded && abortError(job.abort.signal)) {
        job.state = 'superseded';
      } else if (job.preempted && abortError(job.abort.signal)) {
        job.state = 'queued';
        job.progress = { stage: 'queued' };
        this.pending.push(job);
        this.sortPending();
      } else if (job.priority < 2 && this.isRetryable(error)) {
        // If llama is still starting (or temporarily busy/down), do not fire
        // the same failure through every person in the year. Keep the ranked
        // job at the front and retry after one bounded quiet period.
        job.state = 'queued';
        job.progress = { stage: 'waiting' };
        this.pending.push(job);
        this.sortPending();
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.kick();
        }, this.retryDelayMs);
        this.retryTimer.unref?.();
      } else {
        job.state = 'failed';
        job.error = error;
      }
    }).finally(() => {
      this.running.delete(job);
      // Background completions live in the durable summary cache, not this
      // process map. Foreground completions stay until the polling request has
      // consumed their result, with a short expiry so an abandoned row cannot
      // retain derived relationship prose in process memory indefinitely.
      if (
        this.jobs.get(job.id) === job
        && job.priority < 2
        && (job.state === 'done' || job.state === 'failed' || job.state === 'superseded')
      ) this.jobs.delete(job.id);
      if (job.priority >= 2 && (job.state === 'done' || job.state === 'failed')) {
        job.expiry = setTimeout(() => {
          if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
        }, FOREGROUND_RESULT_TTL_MS);
        job.expiry.unref?.();
      }
      this.kick();
    });
  }
}
