// Alternation between the two card producers (L5 follow-on, alongside
// owe.mjs): which one gets to produce/serve on a given request, and the
// per-kind refill throttle that keeps an exhausted producer from writing an
// empty batch on every poll. No model call, no ranking decision -- this is
// purely "whose turn is it".
//
// Control-first: CARD_PRODUCERS lists 'owe' before 'reconnect' so a tie (both
// never shown, or shown at the exact same instant) resolves to Owe.
//
// Day-parity alternation (alternate by calendar day) was considered and
// rejected: it does not self-correct. If Owe's pool is exhausted for a whole
// day, day-parity still burns that day on Owe and shows the owner nothing,
// where "serve whichever was shown longer ago" naturally gives the other
// producer the turn instead.
export const CARD_PRODUCERS = Object.freeze(['owe', 'reconnect']);

// How long a per-kind refill stays throttled after producing zero candidates
// -- same value and reasoning as the single-producer constant it replaces
// (hermes.mjs's old REFILL_RETRY_MS): without it, every poll of an exhausted
// kind writes a fresh empty batch for that kind.
export const REFILL_RETRY_MS = 15 * 60_000;

// The kind whose turn it is: whichever was LEAST RECENTLY shown (a 'shown'
// rm_card_event), never-shown counting as -Infinity (goes first). A tie
// (including "neither has ever been shown") resolves to CARD_PRODUCERS[0].
export function pickProducer(db, { now = Date.now() } = {}) {
  const rows = db.prepare(
    "SELECT kind, MAX(created_at) AS lastShown FROM rm_card_event WHERE event = 'shown' GROUP BY kind"
  ).all();
  const lastShownByKind = new Map(rows.map((r) => [r.kind, Number(r.lastShown)]));
  const tsFor = (kind) => (lastShownByKind.has(kind) ? lastShownByKind.get(kind) : -Infinity);

  let best = CARD_PRODUCERS[0];
  let bestTs = tsFor(best);
  for (let i = 1; i < CARD_PRODUCERS.length; i++) {
    const kind = CARD_PRODUCERS[i];
    const ts = tsFor(kind);
    if (ts < bestTs) { best = kind; bestTs = ts; }
  }
  return best;
}

// WHAT "CONSUMED" MEANS, AND WHAT A PEEK IS (2026-09-08, contrarian review A
// findings 1/2/4/11). One model, written down here because four separate
// places used to disagree about it and the disagreement wedged the queue
// shut for thirty days at a time.
//
// A snapshot leaves the live queue for exactly one of two reasons, and the
// two are different in kind:
//
//  1. CONSUMED -- an owner action landed on it. Terminal, forever, and
//     recorded in rm_card_event: 'accepted', 'dismissed', 'muted',
//     'suppressed'. It used to be only the first two, which is the bug: the
//     card's own "mute 30d" writes a 'muted' row and nothing else, so the
//     snapshot stayed "unjudged" while allowCard refused to serve it -- the
//     producer kept its turn, the serve loop skipped the card, and the route
//     answered {card:null} on every poll for the whole mute. A mute expiring
//     does NOT resurrect the snapshot: the person returns to the pool and
//     gets a NEW snapshot, which is the append-only story and also the
//     honest one (the card the owner muted is not a card they still owe an
//     answer to).
//
//  2. UNSERVABLE -- the card cannot be rendered right now. Its quote's
//     context row was deleted, its commitment claim is gone or was rejected,
//     the person was suppressed or muted from some other surface. This is
//     DERIVED AND RE-DERIVED on every request, never stored: nothing about
//     the owner happened, and a block that lifts must make the card servable
//     again. Supplied by the caller as `policy.servable(card)` (hermes.mjs's
//     card route owns those references; this file stays alternation-only).
//
// NO NEW EVENT KIND, deliberately. rm_card_event.event carries a CHECK over
// ('shown','opened','accepted','dismissed','muted','suppressed') and a CHECK
// cannot be ALTERed -- a 'skipped' would cost a v11-style table rebuild of an
// append-only log. It would also be a lie: 'skipped' is not something the
// owner did, and this log is "what happened to what we offered the owner".
// Unservability is a fact about the WORLD (a deleted row), so it is computed
// from the world, and the rebuild is not needed.
//
// The global frequency cap consumes NOTHING. A capped-out request is a
// refusal to interrupt, not a verdict: the card stays live and the route
// answers {card:null, reason:'cap'}.
//
// A PEEK vs A SERVE. A serve hands a card to the owner: it records 'shown'
// (once per snapshot), spends a cap slot, starts the 7-day pool cooldown for
// that person, and -- via pickProducer, which reads 'shown' -- passes the
// turn to the other producer. A peek answers only "is there a card, and what
// would it tease", recording nothing. The widget's 10-minute background poll
// peeks; only the card panel's own pull serves. Before this split the poll
// served, so cap slots and cooldowns were spent on cards no human ever saw
// and the producers alternated behind the owner's back. A peek MAY still
// refill (production is one SQL statement and writing a snapshot is not an
// interruption -- producer.mjs's cooldown comment says as much), and it does
// apply the cap and the servability gate, so the orb never lights for a card
// that cannot be shown.
//
// `currentVersions` (optional: {kind: producer_version}) is the same
// promise-versioning hermes.mjs's hydrateCards checks: a producer version is
// a promise about how a card was chosen, and when the promise changes, the
// unjudged queue the OLD version produced is void. A card whose
// producer_version does not match currentVersions[kind] is treated as
// not-in-queue here -- not counted as unjudged, so produceDailyBatch below
// falls through to producing a fresh batch for that kind instead of waiting
// behind cards chosen under rules already rejected. Kept optional (and a
// no-op when omitted, as this module's own tests do -- they stub producers
// that don't carry real producer_version values) so this file stays
// generic-alternation-only when no versioned policy is supplied.
// `modeFilter` (optional) narrows the check to cards whose evidence.mode
// matches -- modes-as-queues (L5 mode-picker follow-on): whether "this kind
// already has an unjudged card" must mean "in THIS mode" for reconnect, not
// "in any mode ever produced". Undefined (what every existing caller still
// passes) means no mode filter at all, so this file stays
// generic-alternation-only per its own header comment.
// `servable` (optional: (card) => boolean) is the caller's unservability
// gate -- see the CONSUMED model above. Omitted means "every unconsumed card
// is servable", which is what this module's own producer-stub tests want.
function hasLiveOfKind(db, cards, kind, currentVersions, modeFilter, servable) {
  const requiredVersion = currentVersions?.[kind];
  return (cards ?? []).some((card) => card.kind === kind
    && (requiredVersion === undefined || card.producer_version === requiredVersion)
    && (modeFilter === undefined || card.evidence?.mode === modeFilter)
    && !isSnapshotConsumed(db, card.snapshot_id)
    && (servable === undefined || servable(card) === true));
}

// The four rm_card_event kinds that take a snapshot out of the queue for
// good -- see the CONSUMED model above for why 'muted'/'suppressed' belong
// here and why there is no fifth, stored, 'skipped'.
export const CONSUMING_EVENTS = Object.freeze(['accepted', 'dismissed', 'muted', 'suppressed']);
const CONSUMED_SQL =
  "SELECT 1 FROM rm_card_event WHERE snapshot_id = ? AND event IN ('accepted','dismissed','muted','suppressed') LIMIT 1";

export function isSnapshotConsumed(db, snapshotId) {
  if (!Number.isInteger(snapshotId)) return false;
  return db.prepare(CONSUMED_SQL).get(snapshotId) !== undefined;
}

// CROSS-KIND EXCLUSION (review finding 11): the person keys one kind is
// currently holding in its live queue, so the OTHER producer can leave them
// alone. Without this a person eligible for both shows up as two cards --
// offered twice, and dismissing one kind gates neither.
//
// "Live queue" here is the DB's own view of it, not the process's: the
// newest batch per (kind, mode) -- the same MAX(batch_id) notion
// hydrateCards restores from, grouped by evidence.mode so a reconnect mode
// the owner is not currently on still counts -- minus every consumed
// snapshot. Bounded by `windowMs` (7 days by default, matching
// producer.mjs's RECENTLY_OFFERED_DAYS) so a batch that goes permanently
// stale -- a producer_version bump nothing has re-produced past yet -- can
// never wedge a person out of the other kind forever. Version is
// deliberately NOT checked here: importing each producer's version constant
// into the other would make owe.mjs and producer.mjs mutually circular, and
// a stale batch self-heals on the next turn (its own cards do not count as
// live above, so its kind produces immediately).
export const CROSS_KIND_WINDOW_MS = 7 * 86_400_000;

export function liveQueuePersonKeys(db, kind, { now = Date.now(), windowMs = CROSS_KIND_WINDOW_MS } = {}) {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT s.person_key AS personKey
         FROM rm_candidate_snapshot s
        WHERE s.kind = ?
          AND s.created_at > ?
          AND s.batch_id IN (
            SELECT MAX(batch_id) FROM rm_candidate_snapshot
             WHERE kind = ? GROUP BY json_extract(evidence, '$.mode')
          )
          AND NOT EXISTS (
            SELECT 1 FROM rm_card_event e
             WHERE e.snapshot_id = s.id
               AND e.event IN ('accepted','dismissed','muted','suppressed')
          )`
    ).all(kind, now - windowMs, kind);
    return new Set(rows.map((r) => r.personKey));
  } catch {
    // A missing/pre-migration rm_candidate_snapshot means "no live queue",
    // not a producer failure -- same posture as hydrateCards' own wrap.
    return new Set();
  }
}

// Decide which kind should be served (and produce for it, subject to that
// kind's own refill throttle) on this request:
//
//   1. P = pickProducer, Q = the other.
//   2. If the queue already holds a LIVE P card (unconsumed AND servable --
//      see the CONSUMED model above), serve from those -- no production.
//      Liveness is PER KIND: a 5-deep reconnect batch with 4 still live
//      must not make P=owe wait behind them.
//   3. Else produce for P (subject to P's own throttle); producing >0 means
//      P is served.
//   4. Else fall through to Q: an unjudged Q card serves immediately, else
//      produce for Q.
//   5. Both exhausted: {servingKind: null, reason: 'pool-exhausted'}.
//
// `policy` is daily.mjs's own small contract, not hermes' whole policy
// object: `producers` maps a kind to its produce function
// (db, {now}) => {batchId, cards}; `onBatchProduced(kind, batchId, cards)`
// is called after a non-empty produce (the card route's startPageBuilds
// call lives there -- Owe batches get it too, same as reconnect);
// `refillRetryMs` defaults to REFILL_RETRY_MS. `servable(card)` (optional)
// is the unservability gate described in the CONSUMED model above -- a card
// whose references are gone, or whose person is suppressed/muted elsewhere,
// must not hold its kind's turn. `modeFor(kind)` (optional)
// returns the mode a kind's unjudged-check and produce should be scoped to
// (undefined for no scoping -- the plain per-kind behavior every existing
// caller still gets); `refillKey(kind)` (optional) returns the key under
// which that kind's refill-throttle state lives in rel.refill, so a
// mode-scoped kind (hermes.mjs passes `reconnect:${mode}`) gets its own
// throttle instead of sharing one throttle across every mode -- "a mode with
// an empty queue refills once and is throttled after" must not also throttle
// a DIFFERENT mode the owner switches to next.
//
// `rel` is the same per-process holder the card route already keeps:
// rel.cards (the combined queue, both kinds), rel.batch ({owe, reconnect}
// batch ids), rel.refill (keyed by refillKey(kind), defaulting to kind
// itself: {owe:{at,empty}, reconnect:{at,empty}, ...any mode-scoped keys}).
export function produceDailyBatch(db, policy, rel, { now = Date.now() } = {}) {
  const refillRetryMs = policy.refillRetryMs ?? REFILL_RETRY_MS;
  rel.refill ??= { owe: { at: null, empty: false }, reconnect: { at: null, empty: false } };
  rel.cards ??= [];
  rel.batch ??= { owe: null, reconnect: null };

  const P = pickProducer(db, { now });
  const Q = CARD_PRODUCERS.find((k) => k !== P);

  const refillKeyFor = (kind) => (policy.refillKey ? policy.refillKey(kind) : kind);
  const modeFor = (kind) => (policy.modeFor ? policy.modeFor(kind) : undefined);

  function tryProduce(kind) {
    const key = refillKeyFor(kind);
    rel.refill[key] ??= { at: null, empty: false };
    const state = rel.refill[key];
    if (state.empty && state.at != null && now - state.at < refillRetryMs) {
      return { throttled: true, produced: 0 };
    }
    const { batchId, cards } = policy.producers[kind](db, { now });
    state.at = now;
    state.empty = cards.length === 0;
    if (cards.length > 0) {
      rel.batch[kind] = batchId;
      rel.cards = [...rel.cards, ...cards];
      policy.onBatchProduced?.(kind, batchId, cards);
    }
    return { throttled: false, produced: cards.length };
  }

  const servable = policy.servable;
  if (hasLiveOfKind(db, rel.cards, P, policy.currentVersions, modeFor(P), servable)) return { servingKind: P };
  const producedP = tryProduce(P);
  if (producedP.produced > 0) return { servingKind: P };

  if (hasLiveOfKind(db, rel.cards, Q, policy.currentVersions, modeFor(Q), servable)) return { servingKind: Q };
  const producedQ = tryProduce(Q);
  if (producedQ.produced > 0) return { servingKind: Q };

  return { servingKind: null, reason: 'pool-exhausted' };
}
