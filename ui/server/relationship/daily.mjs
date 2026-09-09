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
function hasUnjudgedOfKind(db, cards, kind, currentVersions, modeFilter) {
  const requiredVersion = currentVersions?.[kind];
  return (cards ?? []).some((card) => card.kind === kind
    && (requiredVersion === undefined || card.producer_version === requiredVersion)
    && (modeFilter === undefined || card.evidence?.mode === modeFilter)
    && !db.prepare(
      "SELECT 1 FROM rm_card_event WHERE snapshot_id = ? AND event IN ('accepted','dismissed') LIMIT 1"
    ).get(card.snapshot_id));
}

// Decide which kind should be served (and produce for it, subject to that
// kind's own refill throttle) on this request:
//
//   1. P = pickProducer, Q = the other.
//   2. If the queue already holds an unjudged P card, serve from those --
//      no production. Unjudged-ness is PER KIND: a 5-deep reconnect batch
//      with 4 still unjudged must not make P=owe wait behind them.
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
// `refillRetryMs` defaults to REFILL_RETRY_MS. `modeFor(kind)` (optional)
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

  if (hasUnjudgedOfKind(db, rel.cards, P, policy.currentVersions, modeFor(P))) return { servingKind: P };
  const producedP = tryProduce(P);
  if (producedP.produced > 0) return { servingKind: P };

  if (hasUnjudgedOfKind(db, rel.cards, Q, policy.currentVersions, modeFor(Q))) return { servingKind: Q };
  const producedQ = tryProduce(Q);
  if (producedQ.produced > 0) return { servingKind: Q };

  return { servingKind: null, reason: 'pool-exhausted' };
}
