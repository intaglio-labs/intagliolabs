// The Relationship Memory service: ONE front door over primitives that already
// exist elsewhere in this tree. Step 1 of the implementation order in
// L5-RELATIONSHIP-MEMORY-EXPERIMENT.md — "wrap, do not fork".
//
// This file deliberately contains almost no logic. Identity lives in
// people/graph.mjs and people/resolve.mjs, the open-loop rule in
// people/profile.mjs, ranking in people/rank.mjs, claim validity in
// memory/validity.mjs, source freshness in status/watchdog.mjs, and deletion
// stays where it has always been: hermes, the corpus's sole writer and sole
// deleter. A second implementation of any of those here would be a second
// trust lifecycle, which the plan forbids. If you are about to add a
// computation to this file, first ask which existing module it belongs to.
//
// The three seams below (sources, identity, rank) are shaped by the Phase 0
// ablation run on 2026-08-28 (rules l5-phase0-v2; results stay local in
// ~/.hazlie/experiments/, never in this repo — CLAUDE.md rule 6):
//
//  - `sources` is a REGISTRY OF PEERS, not a pipeline. The calendar-only arm
//    surfaced useful people the message arms could not see at all; treating
//    messages as the signal and calendar as a join would have hidden them.
//    Candidate adapters land in step 6; the registry exists now because
//    suppression, the global cap, and snapshots (steps 4 and 7) attach to one
//    door, and that door has to exist before anything walks through it.
//  - `identity` exposes merge confirmation FIRST. Every defect Phase 0
//    surfaced was an identity defect, and a person split across two keys was
//    graded inconsistently by the owner — identity errors corrupt measurement,
//    not just presentation.
//  - `rank` is a strategy registry with the fixed-interval baseline built in,
//    because the cadence-ratio ranking underperformed it in Phase 0. The
//    baseline is the permanent control every cleverer strategy must beat;
//    do not remove it when a better strategy lands.

import { buildGraph } from '../people/graph.mjs';
import { openLoop } from '../people/profile.mjs';
import {
  ensureResolutionsSchema, resolutionState, candidatePairs, recordDecision,
} from '../people/resolve.mjs';
import { isNonPerson } from '../people/rank.mjs';
import { validToFor, isExpired } from '../memory/validity.mjs';
import { collectLastSeen, evaluate, STALE_AFTER_MS } from '../status/watchdog.mjs';

const DAY = 86_400_000;

// The Phase 0 control: depth plus a flat silence window, ranked by volume.
// Registered under a name so a caller can never get a ranking without saying
// which one, and so the control stays runnable next to whatever replaces it.
function fixedIntervalBaseline(people, { now = Date.now(), intervalDays = 180, minMessages = 8 } = {}) {
  return people
    .filter((p) => !isNonPerson(p))
    .filter((p) => p.messages >= minMessages)
    .filter((p) => p.dormancyDays !== null && p.dormancyDays >= intervalDays)
    .sort((a, b) => b.messages - a.messages || (a.key < b.key ? -1 : 1));
}

export function createRelationshipMemory({ contextDb, stateDb, resolutionsDb = null, owner = null } = {}) {
  if (!contextDb) throw new Error('relationship memory needs the context db handle');
  if (resolutionsDb) ensureResolutionsSchema(resolutionsDb);

  const rankStrategies = new Map([['fixed-interval', fixedIntervalBaseline]]);
  const sourceAdapters = new Map();

  const service = {
    // ---- the canonical people view --------------------------------------
    // buildGraph with the owner's aliases folded in via the resolutions db,
    // so every consumer of this service sees the SAME humans. Calling this
    // anywhere else with different arguments is how two screens end up
    // disagreeing about who exists.
    people({ now = Date.now() } = {}) {
      const aliases = resolutionsDb ? resolutionState(resolutionsDb).aliases : null;
      return buildGraph(contextDb, stateDb, {
        now,
        ...(owner ? { owner } : {}),
        ...(aliases ? { aliases } : {}),
      });
    },

    // ---- identity: merge confirmation, the first inbox category ----------
    identity: {
      // The "not sure" pile, minus everything the owner already ruled on.
      // Proposes questions, never silent merges (resolve.mjs's contract).
      pending({ now = Date.now(), limit = 60 } = {}) {
        const decided = resolutionsDb ? resolutionState(resolutionsDb).decided : new Set();
        return candidatePairs(service.people({ now }), { decided, limit });
      },
      // The owner's answer, recorded in the same store the rest of the app
      // reads — not a parallel ledger.
      decide(keyA, keyB, verdict, now = Date.now()) {
        if (!resolutionsDb) throw new Error('no resolutions db: identity decisions have nowhere durable to go');
        return recordDecision(resolutionsDb, keyA, keyB, verdict, now);
      },
    },

    // ---- open loops: they wrote last, unanswered -------------------------
    openLoopFor(person, opts = {}) {
      return openLoop(person, opts);
    },

    // ---- coverage: may a dormancy claim be made at all? ------------------
    // Phase 0's gate, generalized: a source that has stopped ingesting makes
    // "you have not talked in N days" a statement about the pipeline, not the
    // relationship. `spansDormancy` is the question candidate adapters must
    // ask before claiming silence.
    coverage({ now = Date.now(), sources, previous = {}, staleAfter = STALE_AFTER_MS } = {}) {
      const lastSeen = collectLastSeen({ contextDb, stateDb, ...(sources ? { sources } : {}) });
      const { state, newlyStale, recovered } = evaluate({ lastSeen, now, previous, staleAfter });
      return {
        lastSeen, state, newlyStale, recovered,
        spansDormancy(source, dormancyDays) {
          if (state[source] !== 'fresh') return false;
          const seen = lastSeen[source];
          return seen !== null && (now - seen) < dormancyDays * DAY;
        },
      };
    },

    // ---- claim validity: hermes' lifecycle, re-exposed -------------------
    // Claims are written, decided, and deleted by hermes alone. The service
    // only answers "is this claim still alive?" with the same arithmetic
    // hermes uses, so no consumer reimplements expiry.
    validity: { validToFor, isExpired },

    // ---- rank: pluggable, control included -------------------------------
    rank(name, people, opts = {}) {
      const strategy = rankStrategies.get(name);
      if (!strategy) throw new Error(`unknown rank strategy '${name}' (have: ${[...rankStrategies.keys()].join(', ')})`);
      return strategy(people, opts);
    },
    registerRankStrategy(name, fn) {
      if (typeof name !== 'string' || name.length === 0 || typeof fn !== 'function') {
        throw new Error('a rank strategy is a non-empty name and a function');
      }
      if (rankStrategies.has(name)) throw new Error(`rank strategy '${name}' already registered`);
      rankStrategies.set(name, fn);
    },
    rankStrategies: () => [...rankStrategies.keys()],

    // ---- sources: the one door candidates will come through --------------
    // Empty on purpose in step 1. The contract is registered here so step 6's
    // adapters, step 4's suppression, and step 7's snapshots all meet at the
    // same interface instead of each inventing one.
    registerSource(adapter) {
      if (typeof adapter?.name !== 'string' || adapter.name.length === 0 || typeof adapter?.candidates !== 'function') {
        throw new Error('a source adapter is { name, candidates(service, opts) }');
      }
      if (sourceAdapters.has(adapter.name)) throw new Error(`source '${adapter.name}' already registered`);
      sourceAdapters.set(adapter.name, adapter);
    },
    sources: () => [...sourceAdapters.keys()],
  };

  return service;
}
