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
const barrierKey = (year, barrier) => `${PREFIX}:barrier:${barrier}:done:${year}`;

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

// Durable progress only: safe to print in diagnostics because these cursor
// names contain connector names, years, and booleans — never remote tokens or
// household identifiers. Availability is intentionally absent; the live
// activity file supplies the active queue, while this receipt says exactly
// which year barriers have actually been crossed.
export function yearlyBackfillCoverage({ state, connectors, now = Date.now } = {}) {
  const roster = [...new Set((connectors ?? []).filter((name) => typeof name === 'string' && name))];
  const currentYear = new Date(now()).getFullYear();
  const activeYear = savedYear(state, now);
  const complete = state.getCursor(COMPLETE_KEY) === '1';
  return {
    year: activeYear,
    complete,
    connectors: roster.map((connector) => {
      const completedYears = [];
      for (let year = currentYear; year >= 1900; year -= 1) {
        if (state.getCursor(doneKey(year, connector)) === '1') completedYears.push(year);
      }
      return {
        connector,
        completedYears,
        exhausted: state.getCursor(exhaustedKey(connector)) === '1',
        pending: !complete
          && state.getCursor(exhaustedKey(connector)) !== '1'
          && state.getCursor(doneKey(activeYear, connector)) !== '1',
      };
    }),
  };
}

export function createYearlyBackfill({ state, connectors, barriers = [], now = Date.now } = {}) {
  const roster = [...new Set((connectors ?? []).filter((name) => typeof name === 'string' && name))];
  const barrierRoster = [...new Set((barriers ?? []).filter((name) => typeof name === 'string' && name))];
  const classified = new Set();
  const active = new Set();
  // A roster member that this process will never hear about again.
  //
  // The roster is built from the sources the daemon SCHEDULES, and classify()
  // is only ever called from a scheduled source's path — so a member that is
  // never scheduled is a member that is never classified, and advance() waits
  // for it forever: the year never decrements and the backfill stops at the
  // current year for every other source too. That is not hypothetical; it is
  // what `matrix` did the day the bridges feature turned off, because the
  // roster was built from every history source while the schedule was not.
  // Withdrawing one is "classified, and inactive" — the same standing an
  // unprovisioned source has, and the same standing it would have if it were
  // scheduled and found its marker.
  const withdrawn = new Set();
  // CLASSIFIED, BUT ON A GUESS.
  //
  // A needs() that THROWS is not an answer. The daemon's startup probe still has
  // to classify such a source — advance() waits on unclassified(), so withholding
  // the classification freezes the year for everybody — but the classification it
  // gives is "we could not ask", and the walk must not spend that as though it
  // were "this source has nothing here".
  //
  // Without this, a Photos library locked for twenty seconds across a restart
  // was enough: the source is classified inactive, reconcile() advances 2026 to
  // 2025 without it, the source recovers on its first tick, missedYears finds
  // 2026 undone and rewinds the whole walk back to 2026 — barriers reopened,
  // the People year re-run. The rewind is right; buying it with an eager
  // advance was not.
  //
  // Cleared by the next ordinary classify() from a real tick, whatever it says.
  const provisional = new Set();
  const unclassified = () =>
    roster.filter((connector) => !classified.has(connector) && !withdrawn.has(connector));

  const year = () => savedYear(state, now);
  const exhausted = (connector) => state.getCursor(exhaustedKey(connector)) === '1';
  const done = (connector, value = year()) =>
    exhausted(connector) || state.getCursor(doneKey(value, connector)) === '1';
  const barrierDone = (barrier, value = year()) =>
    state.getCursor(barrierKey(value, barrier)) === '1';
  const reopenBarriers = (value) => {
    for (const barrier of barrierRoster) state.deleteCursor(barrierKey(value, barrier));
  };

  // YEARS THE WALK HAS ALREADY LEFT BEHIND THIS CONNECTOR.
  //
  // The walk runs newest-first and only ever decrements, so a year ABOVE the
  // saved year that this connector has not completed is a year nothing will
  // bring back on its own: the connector has to have the walk rewound to reach
  // it. That, and only that, is what the rewind below is for.
  //
  // The saved year itself is EXCLUDED. It is in progress for everybody, and a
  // connector that went unavailable and came back inside it has missed
  // nothing -- which is the whole of round-4 finding 3. `classify(name,false)`
  // after NEEDS_FAILURE_TOLERANCE throws (a store locked by a Time Machine
  // pass, a token file mid-rewrite) followed by the recovering tick's
  // `classify(name,true)` used to read as a re-activation and drag a backfill
  // sitting at 2015 back to the current year for EVERY source. A transient
  // outage now costs the ticks it lasted and nothing else.
  //
  // A connector marked exhausted is done for every year by definition, so
  // `done()` rather than a raw cursor read.
  const missedYears = (connector) => {
    const from = year();
    const currentYear = new Date(now()).getFullYear();
    for (let value = currentYear; value > from; value -= 1) {
      if (!done(connector, value)) return true;
    }
    return false;
  };

  function classify(connector, available, { unanswered = false } = {}) {
    if (!roster.includes(connector)) return;
    // A withdrawal is not permanent: a source re-enabled while the process runs
    // classifies itself again on its next tick and rejoins the barrier.
    withdrawn.delete(connector);
    if (unanswered) provisional.add(connector);
    else provisional.delete(connector);
    const currentYear = new Date(now()).getFullYear();
    const hasCurrentCheckpoint = state.getCursor(doneKey(currentYear, connector)) === '1';
    // A walk that finished WITHOUT this connector. Kept separate from
    // missedYears because a walk can finish inside the current year (every
    // timeline exhausted at once), which leaves no year above the saved one
    // for missedYears to find while COMPLETE still locks task() shut.
    const completedBeforeAuthorization =
      state.getCursor(COMPLETE_KEY) === '1'
      && !hasCurrentCheckpoint;
    classified.add(connector);
    if (available) {
      active.add(connector);
      // A connector can become available while the app is open (OAuth/login),
      // or arrive mid-walk having never been in it. Re-open its exhaustion
      // mark and the global completion gate. Existing per-year completion
      // marks for other sources make this an inexpensive catch-up rather than
      // a full re-read.
      // completedBeforeAuthorization matters after an app restart:
      // `classified` is process-local, while COMPLETE is durable. A connector
      // authorized between launches still has to reopen the current-year
      // barrier.
      if (completedBeforeAuthorization || missedYears(connector)) {
        state.deleteCursor(exhaustedKey(connector));
        state.deleteCursor(COMPLETE_KEY);
        state.setCursor(YEAR_KEY, String(currentYear));
        reopenBarriers(currentYear);
      } else if (exhausted(connector) && year() === currentYear && !hasCurrentCheckpoint) {
        // NEW YEAR'S DAY, and the connector that did not go first.
        //
        // `exhausted` means "the walk reached the beginning of this store". It
        // is a statement about OLDER data, and on 1 January the walk is standing
        // in a year that is NEWER than anything it has seen. The first connector
        // to tick finds 2027 undone, rewinds above, and sets YEAR to 2027; every
        // connector after it then sees year() === currentYear, finds nothing
        // missed, and keeps its exhausted mark — so done() answers true for a
        // year it has never scanned, and that year is never read at all.
        //
        // Deliberately narrower than the rewind: the walk must be standing AT
        // the current year. A connector exhausted mid-walk (it joined at 2020
        // and its store began there) has year() far below the current one and
        // keeps its mark, so this cannot cost it a re-scan of a year it
        // correctly finished.
        state.deleteCursor(exhaustedKey(connector));
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

  /// This connector is out of the barrier for the rest of this process: it is
  /// not scheduled, so nothing will ever classify it. Idempotent, and a no-op
  /// for a name that is not on the roster.
  function withdraw(connector) {
    if (!roster.includes(connector)) return false;
    withdrawn.add(connector);
    active.delete(connector);
    return true;
  }

  function reopen(connector) {
    if (!roster.includes(connector)) return false;
    // A source can gain a new stream while remaining "available" throughout:
    // connecting Instagram after Messenger is the common case because both use
    // the one Matrix source. Clear only this connector's year checkpoints, not
    // anybody else's, and restart it at the current year.
    // The walk's clock travels with the call. This one only ever clears this
    // connector's own namespace -- the yearly-backfill prefix means the global
    // half does not fire -- but a clock that reaches one door into that state
    // and not the others is how the years drift apart.
    state.deleteCursors(connectorKey(connector), { now });
    state.deleteCursor(COMPLETE_KEY);
    const currentYear = new Date(now()).getFullYear();
    state.setCursor(YEAR_KEY, String(currentYear));
    reopenBarriers(currentYear);
    return true;
  }

  function recordBarrier(barrier, value = year()) {
    if (!barrierRoster.includes(barrier)) return false;
    state.setCursor(barrierKey(value, barrier), '1');
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
    if (unclassified().length > 0) return false;
    // AND WAIT FOR THE GUESSES TO BECOME ANSWERS. See `provisional`: a source
    // whose needs() threw has been classified so the barrier is not frozen, but
    // its classification is not evidence the walk may spend. The wait ends at
    // that source's first real tick, which is one stagger away rather than the
    // thirty minutes the old tolerance cost.
    if (provisional.size > 0) return false;
    // NOTHING TO WALK IS FINISHED, not forever unfinished. Every history source
    // has been classified and none of them is available: unprovisioned,
    // disabled, withdrawn, or — reachable in one step since the feature
    // registry arrived — every connector off because the registry could not be
    // read. Returning false there left COMPLETE unset forever, and the sources
    // that gate on `historyComplete` (calendar, granola) kept clipping their
    // ordinary scans to the current year, waiting on a backfill no source would
    // ever run. It is not a one-way door: classify(name, true) reopens the
    // current year for a source that arrives later, exactly as it does after a
    // walk that really finished.
    if (active.size === 0) {
      // ONLY WHERE THE WALK IS STANDING AT THE CURRENT YEAR, which is the state
      // this branch was written for: a machine on which no history source is
      // available at all, so nothing has ever walked.
      //
      // Without the guard this writes COMPLETE at WHATEVER year the walk had
      // reached, and COMPLETE is durable. An install whose walk was at 2015 and
      // which restarted at a moment when every history source was unavailable —
      // a 0755 ~/.hazlie, a momentary loss of Full Disk Access, an unreadable
      // secrets directory — was marked complete at 2015 with every year below it
      // unread. Recovery could not undo it: classify(name, true) finds the
      // current year's checkpoint present, so completedBeforeAuthorization is
      // false, and missedYears walks down to 2015 and finds every year done, so
      // that is false too. task() then answers null for everybody, forever.
      //
      // Withholding COMPLETE here costs nothing: the only two sources that gate
      // on it (calendar, granola) are themselves members of this roster, so
      // `active.size === 0` is a state in which neither of them is running.
      if (year() !== new Date(now()).getFullYear()) return false;
      state.setCursor(COMPLETE_KEY, '1');
      return true;
    }
    const value = year();
    if (![...active].every((connector) => done(connector, value))) return false;
    if (!barrierRoster.every((barrier) => barrierDone(barrier, value))) return false;

    const timelines = [...active].filter((connector) => connector !== 'calendar');
    if (timelines.length === 0 || timelines.every(exhausted) || value <= 1900) {
      state.setCursor(COMPLETE_KEY, '1');
      return true;
    }
    state.setCursor(YEAR_KEY, String(value - 1));
    return true;
  }

  // Rebuild the durable barrier after a process restart. `classified` and
  // `active` are intentionally process-local, while per-year completion is
  // durable. Once every source has been classified again, the saved year can
  // already be complete for all active sources. Waiting for another history
  // task to call advance() then deadlocks: there is no task left in that year
  // to make the call. Walk completed barriers now and stop at the first year
  // that has real pending work (or at global completion).
  // A COMPLETE THAT CANNOT BE TRUE, cleared once per process.
  //
  // The guard in advance() stops this being written again; installs carrying it
  // already need a way out, and there is exactly one state that proves the mark
  // was written vacuously. A walk that finished honestly at year V did so with
  // every active connector done at V — advance() requires that before either of
  // its completion branches — so COMPLETE standing over an ACTIVE connector that
  // is NOT done at the saved year is a mark nothing could have written honestly.
  //
  // It is not a guess and it cannot oscillate: clearing it lets advance() decide
  // again from the receipts on disk, and if the walk really is finished it is
  // re-set in the same reconcile() below.
  function repairVacuousCompletion() {
    if (state.getCursor(COMPLETE_KEY) !== '1') return false;
    if (active.size === 0) return false;
    const value = year();
    if ([...active].every((connector) => done(connector, value))) return false;
    state.deleteCursor(COMPLETE_KEY);
    return true;
  }

  function reconcile() {
    const fromYear = year();
    const repaired = repairVacuousCompletion();
    let advanced = 0;
    while (true) {
      const before = snapshot();
      if (!before.classified || before.complete) break;
      // An empty roster has to be settled HERE or nowhere: advance() is only
      // ever called from a scheduled source's path, and this install has none.
      if (before.active.length === 0) {
        if (advance()) advanced += 1;
        break;
      }
      if (before.pending.length > 0) break;
      const previousYear = before.year;
      if (!advance()) break;
      advanced += 1;
      const after = snapshot();
      if (after.complete || after.year >= previousYear) break;
    }
    return { fromYear, advanced, repaired, ...snapshot() };
  }

  function snapshot() {
    const value = year();
    const sourcePending = [...active].filter((connector) => !done(connector, value));
    // Product work begins only after connector data for the year is complete.
    // Hiding the later barrier until then makes Activity a real sequence, not
    // a pile of simultaneous claims about work that has not started.
    const barrierPending = unclassified().length === 0
      && active.size > 0
      && sourcePending.length === 0
      ? barrierRoster.filter((barrier) => !barrierDone(barrier, value))
      : [];
    return {
      year: value,
      complete: state.getCursor(COMPLETE_KEY) === '1',
      classified: unclassified().length === 0,
      active: [...active],
      // Classified on a guess rather than an answer, so the daemon can run the
      // restart reconciliation again once the last guess becomes an answer.
      provisional: [...provisional],
      pending: [...sourcePending, ...barrierPending],
    };
  }

  return { classify, withdraw, reopen, task, record, recordBarrier, advance, reconcile, snapshot };
}
