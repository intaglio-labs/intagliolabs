// Durable newest-to-oldest history coordination.
//
// A connector owns the mechanics of paging its source, but the daemon owns the
// order in which value appears. Every available historical source must finish
// 2026 before any of them starts 2025. That barrier is what keeps a fresh
// install useful: the current year becomes complete across platforms instead
// of one fast connector racing ten years ahead while another is still empty.
//
// Cursor values contain years, connector names and booleans only. No corpus
// rows or remote pagination tokens live here; those remain in each source's
// own cursor namespace.

const PREFIX = 'yearly-backfill';
const YEAR_KEY = `${PREFIX}:year`;
const COMPLETE_KEY = `${PREFIX}:complete`;
const connectorKey = (connector) => `${PREFIX}:connector:${connector}`;
const doneKey = (year, connector) => `${connectorKey(connector)}:done:${year}`;
const exhaustedKey = (connector) => `${connectorKey(connector)}:exhausted`;

export function localYearBounds(year) {
  if (!Number.isInteger(year) || year < 1900 || year > 3000) {
    throw new Error('history year must be an integer from 1900 through 3000');
  }
  return {
    year,
    fromTs: new Date(year, 0, 1).getTime(),
    toTs: new Date(year + 1, 0, 1).getTime(),
  };
}

function savedYear(state, now) {
  const parsed = Number(state.getCursor(YEAR_KEY));
  const current = new Date(now()).getFullYear();
  return Number.isInteger(parsed) && parsed >= 1900 && parsed <= current ? parsed : current;
}

export function createYearlyBackfill({ state, connectors, now = Date.now } = {}) {
  const roster = [...new Set((connectors ?? []).filter((name) => typeof name === 'string' && name))];
  const classified = new Set();
  const active = new Set();

  const year = () => savedYear(state, now);
  const exhausted = (connector) => state.getCursor(exhaustedKey(connector)) === '1';
  const done = (connector, value = year()) =>
    exhausted(connector) || state.getCursor(doneKey(value, connector)) === '1';

  function classify(connector, available) {
    if (!roster.includes(connector)) return;
    const wasInactive = classified.has(connector) && !active.has(connector);
    const currentYear = new Date(now()).getFullYear();
    const hasCurrentCheckpoint = state.getCursor(doneKey(currentYear, connector)) === '1';
    const completedBeforeAuthorization =
      state.getCursor(COMPLETE_KEY) === '1'
      && !hasCurrentCheckpoint;
    const joinedMidBackfill = year() < currentYear && !hasCurrentCheckpoint;
    classified.add(connector);
    if (available) {
      active.add(connector);
      // A connector can become available while the app is open (OAuth/login).
      // Re-open its exhaustion mark and the global completion gate. Existing
      // per-year completion marks for other sources make this an inexpensive
      // catch-up rather than a full re-read.
      // The second condition matters after an app restart: `classified` is
      // process-local, while COMPLETE is durable. A connector authorized
      // between launches still has to reopen the current-year barrier.
      if (wasInactive || completedBeforeAuthorization || joinedMidBackfill) {
        state.deleteCursor(exhaustedKey(connector));
        state.deleteCursor(COMPLETE_KEY);
        state.setCursor(YEAR_KEY, String(currentYear));
      }
    } else {
      active.delete(connector);
    }
  }

  function task(connector) {
    if (!roster.includes(connector) || !active.has(connector)) return null;
    if (state.getCursor(COMPLETE_KEY) === '1' || done(connector)) return null;
    return localYearBounds(year());
  }

  function reopen(connector) {
    if (!roster.includes(connector)) return false;
    // A source can gain a new stream while remaining "available" throughout:
    // connecting Instagram after Messenger is the common case because both use
    // the one Matrix source. Clear only this connector's year checkpoints, not
    // anybody else's, and restart it at the current year.
    state.deleteCursors(connectorKey(connector));
    state.deleteCursor(COMPLETE_KEY);
    state.setCursor(YEAR_KEY, String(new Date(now()).getFullYear()));
    return true;
  }

  function record(connector, result = {}) {
    const value = year();
    if (result.historyHasOlder === true) state.deleteCursor(exhaustedKey(connector));
    if (result.historyDone !== true) return false;
    state.setCursor(doneKey(value, connector), '1');
    // Calendar is context, but it must not manufacture older year tabs by
    // itself. Its stopping point is the oldest year any other source reaches.
    if (connector !== 'calendar' && result.historyHasOlder === false) {
      state.setCursor(exhaustedKey(connector), '1');
    }
    return true;
  }

  function advance() {
    // Wait for every source to have had its prerequisite check this process.
    // Otherwise the first fast source could advance before later staggered
    // sources have even been classified.
    if (classified.size < roster.length || active.size === 0) return false;
    const value = year();
    if (![...active].every((connector) => done(connector, value))) return false;

    const timelines = [...active].filter((connector) => connector !== 'calendar');
    if (timelines.length === 0 || timelines.every(exhausted) || value <= 1900) {
      state.setCursor(COMPLETE_KEY, '1');
      return true;
    }
    state.setCursor(YEAR_KEY, String(value - 1));
    return true;
  }

  function snapshot() {
    const value = year();
    return {
      year: value,
      complete: state.getCursor(COMPLETE_KEY) === '1',
      classified: classified.size === roster.length,
      active: [...active],
      pending: [...active].filter((connector) => !done(connector, value)),
    };
  }

  return { classify, reopen, task, record, advance, snapshot };
}
