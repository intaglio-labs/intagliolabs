// Durable completion of one People year.
//
// Connector history is already newest-first. This coordinator turns the gap
// after each connector barrier into useful product state: build that year's
// deterministic People profiles, then queue every summary-eligible person and
// retain only aggregate receipts. A restart reopens the private receipt store,
// requeues only unfinished people, and never retains summary prose in memory.

import { createHash } from 'node:crypto';
import { estimateChunks, MIN_ROWS, openSummariesDb, SUMMARY_SOURCES } from './summary.mjs';
import { resolutionFingerprint } from './resolve.mjs';

const sourceSql = SUMMARY_SOURCES.map((source) => `'${source}'`).join(',');
const terminalSkip = (result) => typeof result?.reason === 'string'
  && /^only \d+ substantive messages in \d{4}$/u.test(result.reason);
// Measured on the owner's machine over a multi-hour summary run. A work unit
// is one bounded message chunk or one final person-year synthesis. It is an
// estimate, explicitly rendered with "~", and is refined to the summarizer's
// exact chunk count as each person starts.
export const ESTIMATED_SUMMARY_UNIT_MS = 90_000;
const COMPLETION_REVISION = 2;

export function yearCompletionStamp(contextDb, stateDb, aliases, year) {
  const fromTs = new Date(year, 0, 1).getTime();
  const toTs = new Date(year + 1, 0, 1).getTime();
  const context = contextDb.prepare(
    'SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS max_row, ' +
      'COALESCE(MAX(store_changed_at), 0) AS changed ' +
      `FROM context WHERE ts >= ? AND ts < ? AND source IN (${sourceSql})`
  ).get(fromTs, toTs);
  let contacts = { n: 0, changed: 0 };
  try {
    contacts = stateDb?.prepare(
      'SELECT COUNT(*) AS n, COALESCE(MAX(updated_ts), 0) AS changed FROM contact_ids'
    ).get() ?? contacts;
  } catch {}
  return createHash('sha256').update(JSON.stringify({
    completionRevision: COMPLETION_REVISION,
    year,
    context: [Number(context.n), Number(context.max_row), Number(context.changed)],
    contacts: [Number(contacts.n), Number(contacts.changed)],
    aliases: resolutionFingerprint(aliases),
  })).digest('hex');
}

export class PeopleYearCompletion {
  constructor({ path, queue, now = Date.now } = {}) {
    if (!path) throw new Error('PeopleYearCompletion requires a summary database path');
    if (!queue) throw new Error('PeopleYearCompletion requires a summary queue');
    this.path = path;
    this.queue = queue;
    this.now = now;
  }

  withDb(fn) {
    const db = openSummariesDb(this.path);
    try { return fn(db); } finally { db.close(); }
  }

  existing(year, corpusStamp) {
    return this.withDb((db) => {
      const run = db.prepare(
        'SELECT corpus_stamp, state, profiles, summary_total, completed, skipped, started_ms ' +
          'FROM summary_year_runs WHERE year = ?'
      ).get(year);
      if (!run || run.corpus_stamp !== corpusStamp) return null;
      return this.snapshot(db, year, run);
    });
  }

  begin({ year, corpusStamp, people, allowWork }) {
    const eligible = (people ?? [])
      .filter((person) => typeof person?.key === 'string' && Number(person.messages ?? 0) >= MIN_ROWS)
      .map((person) => ({
        key: person.key,
        // Every person needs a final annual synthesis in addition to their
        // bounded message chunks. The row estimate is replaced by the exact
        // char-and-row chunk total when summarizeYear begins.
        workUnits: estimateChunks(person.messages) + 1,
      }));
    this.withDb((db) => {
      const current = db.prepare(
        'SELECT corpus_stamp FROM summary_year_runs WHERE year = ?'
      ).get(year);
      if (current?.corpus_stamp === corpusStamp) return;
      const timestamp = this.now();
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM summary_year_people WHERE year = ?').run(year);
        db.prepare('DELETE FROM summary_year_runs WHERE year = ?').run(year);
        db.prepare(
          'INSERT INTO summary_year_runs ' +
            '(year, corpus_stamp, state, profiles, summary_total, completed, skipped, started_ms, updated_ms) ' +
            'VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)'
        ).run(year, corpusStamp, eligible.length === 0 ? 'complete' : 'processing',
          (people ?? []).length, eligible.length, timestamp, timestamp);
        const insert = db.prepare(
          'INSERT INTO summary_year_people(year, person_key, state, work_units, work_done) ' +
            'VALUES (?, ?, ?, ?, 0)'
        );
        for (const item of eligible) insert.run(year, item.key, 'pending', item.workUnits);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
    return this.resume(year, corpusStamp, allowWork);
  }

  resume(year, corpusStamp, allowWork) {
    const pending = this.withDb((db) => {
      const run = db.prepare('SELECT corpus_stamp FROM summary_year_runs WHERE year = ?').get(year);
      if (!run || run.corpus_stamp !== corpusStamp) return null;
      return db.prepare(
        "SELECT person_key FROM summary_year_people WHERE year = ? AND state = 'pending' ORDER BY rowid"
      ).all(year).map((row) => row.person_key);
    });
    if (pending === null) return null;
    if (allowWork && pending.length > 0) {
      this.queue.enqueue(pending.map((key) => ({ key, year })), { priority: 1 });
    }
    return this.existing(year, corpusStamp, allowWork);
  }

  record({ key, year, result }) {
    const state = typeof result?.text === 'string' && result.text.length > 0
      ? 'complete'
      : terminalSkip(result) ? 'skipped' : null;
    if (!state) return false;
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT state FROM summary_year_people WHERE year = ? AND person_key = ?"
      ).get(year, key);
      if (!row || row.state !== 'pending') return false;
      db.prepare(
        'UPDATE summary_year_people SET state = ?, work_done = work_units ' +
          'WHERE year = ? AND person_key = ?'
      ).run(state, year, key);
      const counts = db.prepare(
        "SELECT COUNT(*) AS total, " +
          "SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END) AS completed, " +
          "SUM(CASE WHEN state = 'skipped' THEN 1 ELSE 0 END) AS skipped, " +
          "SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending " +
          'FROM summary_year_people WHERE year = ?'
      ).get(year);
      db.prepare(
        'UPDATE summary_year_runs SET state = ?, completed = ?, skipped = ?, updated_ms = ? WHERE year = ?'
      ).run(Number(counts.pending) === 0 ? 'complete' : 'processing',
        Number(counts.completed), Number(counts.skipped), this.now(), year);
      return true;
    });
  }

  progress({ key, year, progress }) {
    const total = Math.floor(Number(progress?.total));
    const completed = Math.floor(Number(progress?.completed));
    if (!Number.isFinite(total) || total < 1 || !Number.isFinite(completed) || completed < 0) {
      return false;
    }
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT state FROM summary_year_people WHERE year = ? AND person_key = ?"
      ).get(year, key);
      if (!row || row.state !== 'pending') return false;
      db.prepare(
        'UPDATE summary_year_people SET ' +
          'work_units = MAX(work_units, ?), work_done = MAX(work_done, MIN(?, ?)) ' +
          'WHERE year = ? AND person_key = ?'
      ).run(total, completed, total, year, key);
      return true;
    });
  }

  snapshot(db, year, run) {
    const pending = Math.max(0,
      Number(run.summary_total) - Number(run.completed) - Number(run.skipped));
    const work = db.prepare(
      "SELECT COALESCE(SUM(work_units), 0) AS total, " +
        "COALESCE(SUM(CASE WHEN state = 'pending' THEN MIN(work_done, work_units) " +
          'ELSE work_units END), 0) AS completed ' +
        'FROM summary_year_people WHERE year = ?'
    ).get(year);
    const workUnitsTotal = Number(work.total);
    const workUnitsComplete = Math.min(workUnitsTotal, Number(work.completed));
    const workUnitsPending = Math.max(0, workUnitsTotal - workUnitsComplete);
    return {
      year,
      state: run.state === 'complete' ? 'complete' : 'processing',
      complete: run.state === 'complete',
      profiles: Number(run.profiles),
      summariesTotal: Number(run.summary_total),
      summariesComplete: Number(run.completed),
      summariesSkipped: Number(run.skipped),
      summariesPending: pending,
      workUnitsTotal,
      workUnitsComplete,
      estimatedRemainingMs: workUnitsPending * ESTIMATED_SUMMARY_UNIT_MS,
      startedMs: Number(run.started_ms),
    };
  }
}
