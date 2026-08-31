// One local-model slot, one honest queue.
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
    onSettled = () => {},
  } = {}) {
    if (typeof run !== 'function') throw new TypeError('SummaryQueue requires run');
    this.run = run;
    this.defer = defer;
    this.isRetryable = isRetryable;
    this.retryDelayMs = retryDelayMs;
    this.onSettled = onSettled;
    this.jobs = new Map();
    this.pending = [];
    this.active = null;
    this.pauses = 0;
    this.pumpScheduled = false;
    this.resetting = false;
    this.nextOrder = 0;
    this.retryTimer = null;
  }

  // A viewed year is priority 1; a clicked person is priority 2. Re-enqueuing
  // a year never reverses its top-to-bottom order.
  enqueue(items, { priority = 1 } = {}) {
    for (const item of items ?? []) this.schedule(item.key, item.year, { priority });
  }

  schedule(key, year, { priority = 1 } = {}) {
    const id = idFor(key, year);
    let job = this.jobs.get(id);
    if (!job) {
      job = {
        id, key, year, priority, state: 'queued', progress: { stage: 'queued' },
        result: null, error: null, abort: null, promise: null, preempted: false,
        order: this.nextOrder++, expiry: null,
      };
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
    if (priority >= 2 && this.active && this.active.id !== id && this.active.priority < priority) {
      this.preemptActive();
    }
    // A human click never waits behind the speculative retry backoff.
    if (priority >= 2 && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.kick();
    return job;
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
      this.jobs.delete(job.id);
    }
  }

  pause() {
    this.pauses += 1;
    this.preemptActive();
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
    const running = this.active?.promise ?? null;
    if (running) await Promise.allSettled([running]);
    return resume;
  }

  async reset() {
    this.resetting = true;
    this.pauses += 1;
    const running = this.active?.promise ?? null;
    this.active?.abort?.abort();
    if (running) await Promise.allSettled([running]);
    for (const job of this.jobs.values()) clearTimeout(job.expiry);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.pending.length = 0;
    this.jobs.clear();
    this.active = null;
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
    if (!this.active || this.active.preempted) return;
    this.active.preempted = true;
    this.active.abort?.abort();
  }

  kick() {
    if (this.pumpScheduled || this.active || this.retryTimer || this.pauses > 0 || this.resetting || !this.pending.length) return;
    this.pumpScheduled = true;
    this.defer(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  pump() {
    if (this.active || this.pauses > 0 || this.resetting) return;
    const job = this.pending.shift();
    if (!job) return;
    this.active = job;
    job.state = 'running';
    job.error = null;
    job.preempted = false;
    job.abort = new AbortController();
    // Start in a promise turn so a synchronous runner failure follows the same
    // failure path as an async one instead of escaping the server callback.
    job.promise = Promise.resolve().then(() => this.run({
      key: job.key,
      year: job.year,
      signal: job.abort.signal,
      onProgress: (progress) => { job.progress = progress; },
    })).then((result) => {
      job.state = 'done';
      job.result = result;
      // Completion observers receive only the job identity and the constrained
      // summary result already returned by the runner. Their failure must not
      // turn a successfully cached summary into a failed foreground request;
      // a durable coordinator can rediscover the cache on its next poll.
      try { this.onSettled({ key: job.key, year: job.year, result }); } catch {}
    }).catch((error) => {
      if (job.preempted && abortError(job.abort.signal)) {
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
      if (this.active === job) this.active = null;
      // Background completions live in the durable summary cache, not this
      // process map. Foreground completions stay until the polling request has
      // consumed their result, with a short expiry so an abandoned row cannot
      // retain derived relationship prose in process memory indefinitely.
      if (job.priority < 2 && (job.state === 'done' || job.state === 'failed')) this.jobs.delete(job.id);
      if (job.priority >= 2 && (job.state === 'done' || job.state === 'failed')) {
        job.expiry = setTimeout(() => this.jobs.delete(job.id), FOREGROUND_RESULT_TTL_MS);
        job.expiry.unref?.();
      }
      this.kick();
    });
  }
}
