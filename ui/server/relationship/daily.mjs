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

function hasUnjudgedOfKind(db, cards, kind) {
  return (cards ?? []).some((card) => card.kind === kind && !db.prepare(
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
// `refillRetryMs` defaults to REFILL_RETRY_MS.
//
// `rel` is the same per-process holder the card route already keeps:
// rel.cards (the combined queue, both kinds), rel.batch ({owe, reconnect}
// batch ids), rel.refill ({owe:{at,empty}, reconnect:{at,empty}}).
export function produceDailyBatch(db, policy, rel, { now = Date.now() } = {}) {
  const refillRetryMs = policy.refillRetryMs ?? REFILL_RETRY_MS;
  rel.refill ??= { owe: { at: null, empty: false }, reconnect: { at: null, empty: false } };
  rel.cards ??= [];
  rel.batch ??= { owe: null, reconnect: null };

  const P = pickProducer(db, { now });
  const Q = CARD_PRODUCERS.find((k) => k !== P);

  function tryProduce(kind) {
    const state = rel.refill[kind];
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

  if (hasUnjudgedOfKind(db, rel.cards, P)) return { servingKind: P };
  const producedP = tryProduce(P);
  if (producedP.produced > 0) return { servingKind: P };

  if (hasUnjudgedOfKind(db, rel.cards, Q)) return { servingKind: Q };
  const producedQ = tryProduce(Q);
  if (producedQ.produced > 0) return { servingKind: Q };

  return { servingKind: null, reason: 'pool-exhausted' };
}
