// Notice when a source goes quiet, and say so once — as Intaglio Labs, in the same
// thread as everything else.
//
// THE UX DECISIONS, because they are the hard part rather than the code:
//
// 1. THE MINI SENDS IT, NOT THE FAILING MACHINE. Only the Mini has Intaglio Labs'
//    Apple account, so only it can speak as Intaglio Labs. That is also the more
//    robust design: the personal Mac's link failing is exactly the case where
//    that Mac cannot report anything — asleep, off, off-network — so a
//    self-report would go missing precisely when it mattered.
//
// 2. IT DETECTS SILENCE, NOT ERRORS. The Mini cannot see the MacBook's
//    exceptions; it can only see that rows stopped arriving. That turns out
//    to be the better signal anyway — it catches the whole path (laptop
//    asleep, link down, ssh key expired, connector crashed, hermes
//    rejecting) rather than one component's opinion of itself.
//
// 3. IT DOES NOT NAG. One message when a source goes stale, one when it comes
//    back, nothing in between. An alert that repeats every 15 minutes is an
//    alert that gets muted, and a muted alert is worse than none.
//
// 4. IT SPEAKS LIKE HAZLIE. Same lowercase register as the welcome, no stack
//    traces, no severity labels. The owner is being told a thing they care
//    about ("i can't see your calendar"), not shown a monitoring dashboard.
//
// 5. RECOVERY IS WORTH A MESSAGE. Being told it is fixed is what closes the
//    loop; without it the owner has to go and check, which is the chore the
//    alert was supposed to remove.

// How long a source may be silent before that is news. Tuned per source to
// its real cadence, because "no rows" means different things: a calendar can
// legitimately be unchanged for a day, whereas an owner averaging ~70
// messages a day going silent for one is a broken link, not a quiet Tuesday.
export const STALE_AFTER_MS = Object.freeze({
  imessage: 24 * 3600 * 1000,
  calendar: 36 * 3600 * 1000,
  granola: 7 * 24 * 3600 * 1000, // meetings genuinely stop at weekends
  health: 36 * 3600 * 1000,
  mail: 36 * 3600 * 1000,
  // whatsapp only syncs to the Mac while WhatsApp Desktop is OPEN; a closed app
  // freezes the local store while the connector keeps "succeeding" against it.
  // 10 days tolerates a quiet week or two of no chats, and still catches the
  // months-long freeze that a closed app produces (measured: 66 days silent
  // while the connector reported ok every run).
  whatsapp: 10 * 24 * 3600 * 1000,
  // linkedin is EXPORT-fed: it refreshes only when a new export file is dropped
  // in, never from live DMs. So "stale" here means "the snapshot is old", not
  // "something broke" — a long threshold and an honest remedy, not a link-down
  // alarm. Fires once when the snapshot ages out, quiet until a fresh export.
  linkedin: 45 * 24 * 3600 * 1000,
});

// What the owner should DO, in the words they would use. A source that is
// stale for a reason they cannot act on gets no instruction rather than a
// made-up one.
export const REMEDY = Object.freeze({
  imessage: 'the link to your macbook might be down',
  calendar: 'google might need re-authorizing',
  granola: null,
  health: 'oura might need re-authorizing',
  mail: null,
  whatsapp: 'open whatsapp on your mac so it can sync',
  linkedin: 'linkedin only refreshes from an export — drop a new one in',
});

export const LABEL = Object.freeze({
  imessage: 'your messages',
  calendar: 'your calendar',
  granola: 'your meeting notes',
  health: 'your ring data',
  mail: 'your mail',
  whatsapp: 'your whatsapp',
  linkedin: 'your linkedin messages',
});

// TWO DIFFERENT SIGNALS, and using the wrong one silently disables the check.
//
// For a connector THIS machine runs, freshness is the last successful run in
// state.db's run_log — when the connector last worked, which is the question.
//
// Row recency cannot answer it, and calendar proves why: its rows are FUTURE
// meetings, so `max(ts)` sits weeks ahead and the source reads as fresh
// forever even if the connector died months ago. Measured here: -1313 hours,
// i.e. the newest row is 55 days in the future. A staleness check that can
// never fire is worse than none, because it looks like coverage.
//
// For a source arriving from ANOTHER machine — imessage, shipped from the
// personal Mac — there is no local run_log, and row recency is both the only
// available signal and the right one: it covers the whole path (laptop
// asleep, link down, key expired, connector crashed) rather than any single
// component's opinion of itself.
export const SIGNAL = Object.freeze({
  imessage: 'rows',
  calendar: 'run',
  granola: 'run',
  health: 'run',
  mail: 'run',
  // whatsapp MUST be judged by rows, not runs. Its connector reads a local
  // store that only WhatsApp Desktop refreshes; when the app is closed the
  // connector still runs and still succeeds (ok=1) against a frozen file. The
  // run_log says "fine" while no message has arrived in months — so the run
  // signal is not just weaker here, it is actively wrong. Row recency is the
  // only signal that sees the freeze.
  whatsapp: 'rows',
  // linkedin likewise: the connector re-reads the same export file every run
  // and reports ok, so run recency is always "now". Only the newest message in
  // the snapshot tells you how old the snapshot is.
  linkedin: 'rows',
});

// connector name → hermes source, where they differ. oura writes `health`
// rows; the run_log is keyed by connector, the context table by source.
export const CONNECTOR_FOR = Object.freeze({ health: 'oura' });

// The one freshness computation, shared by the proactive watchdog (watch.mjs)
// and the on-demand "am i up to date?" answer (ui/server/status). Returns
// source → epoch-ms of its freshness signal, or null when never ingested.
// Kept here, next to SIGNAL, so the two surfaces can never disagree about what
// "fresh" means or read the wrong signal for a source.
export function collectLastSeen({ contextDb, stateDb, sources = Object.keys(STALE_AFTER_MS) }) {
  const lastSeen = {};
  for (const source of sources) {
    if (SIGNAL[source] === 'run' && stateDb) {
      // Only a SUCCESSFUL run counts — a connector failing every 15 minutes is
      // exactly the incident this exists to catch, so ok=1 is the filter.
      const row = stateDb
        .prepare('SELECT max(finished_ts) AS t FROM run_log WHERE connector = ? AND ok = 1')
        .get(CONNECTOR_FOR[source] ?? source);
      lastSeen[source] = row?.t == null ? null : Number(row.t);
      continue;
    }
    const row = contextDb.prepare('SELECT max(ts) AS t FROM context WHERE source = ?').get(source);
    lastSeen[source] = row?.t == null ? null : Number(row.t);
  }
  return lastSeen;
}

// `lastSeen` maps source → epoch ms of its freshness signal, or null when
// there is none. Never-ingested is deliberately NOT an alert: it is the state
// of a source the owner has not set up, and telling them daily that mail is
// missing when they chose not to connect it is nagging.
export function evaluate({ lastSeen, now, previous = {}, staleAfter = STALE_AFTER_MS }) {
  const state = {};
  const newlyStale = [];
  const recovered = [];

  for (const [source, threshold] of Object.entries(staleAfter)) {
    const seen = lastSeen[source];
    if (seen === null || seen === undefined) {
      state[source] = 'absent';
      continue;
    }
    const age = now - seen;
    const isStale = age > threshold;
    state[source] = isStale ? 'stale' : 'fresh';
    const was = previous[source];
    if (isStale && was !== 'stale') newlyStale.push({ source, age });
    if (!isStale && was === 'stale') recovered.push({ source });
  }
  return { state, newlyStale, recovered };
}
