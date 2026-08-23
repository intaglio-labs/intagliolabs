// "Initialize search" — the backend behind the People popup's button.
//
// Phase 1 is NOT a search for something specific ("who are my investors"); that
// is the next step and already has its own path (search.mjs). This is the step
// before it: build the people-map — everyone the owner has talked to, resolved
// across every connected source, within the chosen timeframe — and surface the
// pairs the code could not confidently merge so the OWNER can, instead of the
// code guessing.
//
// It is deliberately thin: buildGraph (graph.mjs) does the resolution, resolve.mjs
// does the candidate detection and the decisions store, and this module only
// wires them to the timeframe and opens the store. No model, no arithmetic of
// its own — the same rule the graph holds.

import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildGraph } from './graph.mjs';
import { ensureResolutionsSchema, resolutionState, candidatePairs, recordDecision } from './resolve.mjs';

const DAY = 86_400_000;

// The owner's verified merge/split decisions live here — their own ground
// truth, so a real file (not derived, not rebuildable from the corpus),
// 0600 under a 0700 dir like every other ~/.hazlie secret-adjacent store.
export function resolutionsDbPath(home = homedir()) {
  return join(home, '.hazlie', 'people', 'resolutions.db');
}

// Open (creating on first use) the decisions store, schema ensured, perms
// tightened. Tests pass an explicit path (or ':memory:' via openWith).
export function openResolutionsDb(path = resolutionsDbPath()) {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
  }
  const db = new DatabaseSync(path);
  if (path !== ':memory:') { try { chmodSync(path, 0o600); } catch {} }
  ensureResolutionsSchema(db);
  return db;
}

// days: 0 (or null) means all time; otherwise a lookback window in days.
function sinceFromDays(days, now) {
  const n = Number(days);
  return Number.isFinite(n) && n > 0 ? now - n * DAY : null;
}

// Build the map and the review pile in one pass. Returns:
//   { people, review, dropped, days, pairs }
// where `people` is how many humans the map holds, `review` is how many pairs
// still need the owner's eyes (before the cap), `dropped` is how many of those
// did not fit the returned page, and `pairs` is that page (strongest first).
//
// The owner's confirmed merges are folded in (aliases) BEFORE candidates are
// computed, so a pair decided last run is both already merged and never
// re-proposed — the pile only ever shrinks as the owner works it.
export function peopleReview(contextDb, stateDb, resDb, { days = 0, now = Date.now(), owner, limit = 40 } = {}) {
  const { aliases, decided } = resolutionState(resDb);
  const sinceTs = sinceFromDays(days, now);
  const graph = buildGraph(contextDb, stateDb, { now, owner, sinceTs, aliases });
  const { pairs, total, dropped } = candidatePairs(graph, { decided, limit });
  return { people: graph.length, review: total, dropped, days: Number(days) || 0, pairs };
}

// Record one owner decision on a pair. `verdict` is 'same' | 'different' |
// 'skip'; skip is a no-op that leaves the pair to resurface. Returns the pair's
// resulting state so the caller can confirm.
export function decide(resDb, { a, b, verdict, now = Date.now() }) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
    throw new Error('decide requires two person keys');
  }
  recordDecision(resDb, a, b, verdict, now);
  return { a, b, verdict };
}
