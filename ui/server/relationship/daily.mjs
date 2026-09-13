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

// EXCEPT ON THE LOAD WHERE THE POOL IS STILL FILLING.
//
// The fifteen minutes protect a STEADY-STATE machine: a pool that was empty a
// minute ago is almost certainly still empty, and re-running the producer on
// every poll buys an empty batch and nothing else. Neither half holds on a
// first load. The daemon walks last year hard for the first half hour, so
// people cross the 180-day quiet gate while the owner watches; the owner IS
// watching, on the setup screen, with nothing else to look at; and the
// producer is one SQL statement, so asking again costs nothing worth saving.
//
// Measured on run 3 (fresh Mac, twenty minutes in): the investor pool had gone
// from nobody to somebody and the route was still answering "come back in
// 13.5 minutes", because the throttle was armed against an empty pool before
// the sprint delivered anyone.
export const FIRST_LOAD_REFILL_RETRY_MS = 60_000;

// WHICH OF THE TWO THIS INSTALL IS ON. First load means exactly "no reconnect
// card has ever been shown here" -- not an elapsed time since install, which
// would need a clock this process does not keep and would expire while the
// owner was still waiting. The first card served ends it, and rm_card_event is
// append-only, so the answer only ever moves one way.
//
// `reconnect` because that is the pool the sprint fills and the one the
// finding is about. It gates the policy-wide retry, so an install that has
// shown Owe cards but never a reconnect one keeps the short window for both --
// which is true of a machine still in its first load by the only definition
// that matters here, and Owe's producer is the same single statement.
//
// A database that cannot answer keeps the long window: this is an optimisation
// for a known state, and "could not tell" is not that state.
export function refillRetryMsFor(db) {
  try {
    const shown = db.prepare(
      "SELECT 1 AS seen FROM rm_card_event WHERE event = 'shown' AND kind = 'reconnect' LIMIT 1"
    ).get();
    return shown === undefined ? FIRST_LOAD_REFILL_RETRY_MS : REFILL_RETRY_MS;
  } catch {
    return REFILL_RETRY_MS;
  }
}

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
// turn to the other producer.
//
// ~~spends a cap slot~~ EXCEPT WHEN IT IS A PULL (2026-09-13). A card served
// past a spent cap because the owner rejected one and asked for another
// records `pulled` on its 'shown' row, and controls.mjs' underGlobalCap does
// not count it -- the cap counts interruptions, and that serve was the owner's
// own doing. The other three still happen, and should: a pulled card really
// was offered to this person (the cooldown) and really was a card of its kind
// (the turn). Only the interruption budget treats it differently. A peek answers only "is there a card, and what
// would it tease", recording nothing. The widget's 10-minute background poll
// peeks; only the card panel's own pull serves. Before this split the poll
// served, so cap slots and cooldowns were spent on cards no human ever saw
// and the producers alternated behind the owner's back. A peek MAY still
// refill (production is one SQL statement and writing a snapshot is not an
// interruption -- producer.mjs's cooldown comment says as much), and it does
// apply the cap and the servability gate, so the orb never lights for a card
// that cannot be shown.
//
// ---------------------------------------------------------------------------
// WHAT "LIVE" MEANS -- ONE DEFINITION, FOUR CALL SITES (2026-09-09,
// contrarian review F findings 4, 8 and 13). The CONSUMED model above was
// only half of it, and the missing half let the same snapshot be live for
// one reader and dead for another. Four places ask "is this card still in
// the queue" and they used to answer differently:
//
//   hydrateCards (hermes.mjs)   restored the newest batch per (kind, mode)
//                               with NO age bound
//   hasLiveOfKind (below)       unconsumed + caller's servable(), no age
//                               bound, and nothing ever pruned rel.cards
//   liveQueuePersonKeys (below) newest batch per mode + a 7-day age bound,
//                               but no mode filter and no servability at all
//   the card route's serve loop  unconsumed + servable, no age bound
//
// So an 8-day-old unshown reconnect card held reconnect's turn forever (the
// turn check saw it; the exclusion set's window did not) and the same person
// was offered an Owe card as well -- the double offer the cross-kind
// exclusion exists to prevent. And an investor-mode card while rel.mode is
// 'any', or a card whose quote row was deleted, blocked Owe for a full seven
// days while never being servable to anyone.
//
// A snapshot is LIVE when all five hold. Each is a fact about the world, all
// five are re-derived on every request, and none of them is stored:
//
//   1. QUEUED    -- it belongs to the newest batch for its (kind, mode). The
//                   DB's own view of the queue, which is what survives a
//                   restart. Set-wise only: liveQueuePersonKeys' MAX(batch_id)
//                   GROUP BY mode, and hydrateCards' per-mode restore.
//   2. FRESH     -- created_at is within LIVE_WINDOW_MS. A batch nothing has
//                   re-produced past (a producer_version bump, a pool that
//                   went empty) must not wedge a person out of the OTHER kind
//                   forever, and must not hold its own kind's turn either.
//                   isSnapshotFresh, and produceDailyBatch PRUNES rel.cards
//                   by it, so a stale batch leaves the in-process queue and
//                   the next request refills instead of serving nothing.
//   3. UNCONSUMED -- the CONSUMED model above.
//   4. IN MODE   -- reconnect only, and only where a mode is in play: modes
//                   are queues, so a card in a mode the owner is not on is
//                   not servable now. Applied by the turn check (modeFor),
//                   the exclusion set (`mode`) and the route's filter alike.
//   5. SERVABLE  -- the UNSERVABLE list above: person suppressed or muted,
//                   quote's context row gone, commitment claim gone or since
//                   rejected.
//
// TWO IMPLEMENTATIONS OF (5), DELIBERATELY, AND WHERE THEY DIFFER. The route
// asks per card, in JS, through hermes' cardBlockReason (which reaches
// rel.service.controls and therefore folds alias keys through the
// resolutions store). The exclusion set asks set-wise, in SQL, because it is
// answering about a whole batch inside a producer's pool build. The SQL is
// the same five clauses over EXACT person keys, and callers that hold a
// service may pass `servable` to get the canonicalising version instead --
// which hermes' card route does. The residual difference is alias folding:
// SQL alone will not know that a suppressed alias key is this person. That
// makes the SQL-only default EXCLUDE FEWER people than the JS gate, never
// more, so it can only ever offer a card the route then refuses -- the
// failure it cannot produce is the wedged queue this finding is about.
//
// WHAT A PEEK PROMISES, AND WHO KEEPS THE PROMISE (finding 13). A peek that
// teases one card and a serve that hands over a different one is a lie the
// owner can see. The fix is NOT a frozen order: page-first is deliberately
// LIVE, re-derived per request, because a page finishing its background
// build is exactly the event that should promote its candidate -- preferring
// what is ready now is the whole point of page-first, and pinning the
// decision at first sight silently retires it. What the order owes is
// TOTALITY WITHIN A REQUEST: page-first, then the producers' own rank
// (rel.cards order), then snapshot_id, monotonic within a batch -- so no
// step of it depends on where an array spread happened to leave the queue.
//
// Consistency ACROSS requests is one explicit contract instead: a peek
// RETURNS the snapshot_id it would serve right now, and the panel hands it
// back as ?expect=<id>. A serve with `expect` serves exactly that snapshot
// while it is still live and servable; when it is not -- judged, muted,
// expired -- the serve hands over the current head and SAYS so
// (reason:'expect-superseded' beside a non-null card) rather than failing or
// pretending nothing moved. `expect` is not a capability: it can only name a
// card the queue already holds and this request would already be allowed to
// serve.
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
function hasLiveOfKind(db, cards, kind, currentVersions, modeFilter, servable, { now, windowMs }) {
  const requiredVersion = currentVersions?.[kind];
  return (cards ?? []).some((card) => card.kind === kind
    && (requiredVersion === undefined || card.producer_version === requiredVersion)
    && (modeFilter === undefined || card.evidence?.mode === modeFilter)
    && isSnapshotLive(db, card.snapshot_id, { now, windowMs })
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

// How long a snapshot stays in the queue at all -- the FRESH half of the
// LIVE model above, and the same seven days producer.mjs's
// RECENTLY_OFFERED_DAYS uses. One constant, because the turn check, the
// exclusion set, the rel.cards prune and hydrateCards must all cut at the
// same place: any two of them disagreeing is finding 4.
export const LIVE_WINDOW_MS = 7 * 86_400_000;

// The name owe.mjs and producer.mjs already import for the cross-kind
// exclusion's own bound. It was always meant to be this same window; it is
// now literally it, rather than a second copy that could drift.
export const CROSS_KIND_WINDOW_MS = LIVE_WINDOW_MS;

// FRESH: created within the window. An unknown snapshot id (a stub card in a
// unit test) or a snapshot row that is somehow not there is NOT called stale
// -- nothing about the world says it is, and inventing staleness would drop
// a card the owner can still be shown. Same posture as isSnapshotConsumed's
// own non-integer return.
export function isSnapshotFresh(db, snapshotId, { now = Date.now(), windowMs = LIVE_WINDOW_MS } = {}) {
  if (!Number.isInteger(snapshotId)) return true;
  const row = db.prepare('SELECT created_at AS createdAt FROM rm_candidate_snapshot WHERE id = ?').get(snapshotId);
  if (row === undefined || row.createdAt === null || row.createdAt === undefined) return true;
  return Number(row.createdAt) > now - windowMs;
}

// The two halves this module can answer on its own: unconsumed AND fresh.
// Servability is the caller's (`policy.servable` / liveQueuePersonKeys'
// SQL); mode is the caller's too. See the LIVE model above.
export function isSnapshotLive(db, snapshotId, { now = Date.now(), windowMs = LIVE_WINDOW_MS } = {}) {
  return !isSnapshotConsumed(db, snapshotId) && isSnapshotFresh(db, snapshotId, { now, windowMs });
}

// CROSS-KIND EXCLUSION (review finding 11): the person keys one kind is
// currently holding in its live queue, so the OTHER producer can leave them
// alone. Without this a person eligible for both shows up as two cards --
// offered twice, and dismissing one kind gates neither.
//
// "Live queue" here is the DB's own view of it, not the process's, and it is
// the SET-WISE form of the LIVE model above -- all five clauses, so that
// this and the turn check and the route cannot disagree (finding 8: it used
// to apply neither the mode filter nor servability, so an investor-mode card
// while rel.mode='any', or a card whose quote row was deleted, blocked the
// other kind for a full week while never serving to anyone):
//
//   QUEUED     the newest batch per (kind, mode), the same MAX(batch_id)
//              notion hydrateCards restores from
//   FRESH      `windowMs`, defaulting to the one LIVE_WINDOW_MS
//   UNCONSUMED the four consuming events
//   IN MODE    `mode`, when the caller has one (reconnect does; owe's
//              evidence.mode is always null, so passing a mode for 'owe'
//              would correctly match nothing -- don't)
//   SERVABLE   suppression, mute, the quote's context row, the commitment
//              claim and its latest decision -- in SQL, over exact person
//              keys. A caller holding a service may pass `servable` for the
//              alias-folding version as well; see the LIVE model on why the
//              SQL-only default can only under-exclude.
//
// `producerVersion` (optional) is the promise-versioning check. It is NOT
// defaulted from the producers' own constants: importing each producer's
// version into the other would make owe.mjs and producer.mjs mutually
// circular, so the caller that knows both (hermes.mjs's card route) supplies
// it, and a caller that does not gets the old self-healing behaviour -- a
// stale batch's cards do not count as live for their own kind, so that kind
// produces immediately and MAX(batch_id) moves past them.
export function liveQueuePersonKeys(db, kind, {
  now = Date.now(), windowMs = LIVE_WINDOW_MS,
  mode = undefined, producerVersion = undefined, servable = undefined,
} = {}) {
  try {
    const rows = db.prepare(
      `SELECT s.id AS id, s.person_key AS personKey, s.kind AS kind, s.evidence AS evidence
         FROM rm_candidate_snapshot s
        WHERE s.kind = ?
          AND s.created_at > ?
          AND (? IS NULL OR json_extract(s.evidence, '$.mode') = ?)
          AND (? IS NULL OR s.producer_version = ?)
          AND s.batch_id IN (
            SELECT MAX(batch_id) FROM rm_candidate_snapshot
             WHERE kind = ? GROUP BY json_extract(evidence, '$.mode')
          )
          AND NOT EXISTS (
            SELECT 1 FROM rm_card_event e
             WHERE e.snapshot_id = s.id
               AND e.event IN ('accepted','dismissed','muted','suppressed')
          )
          AND NOT EXISTS (
            SELECT 1 FROM rm_suppression sup WHERE sup.person_key = s.person_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM rm_mute m
             WHERE m.until_at > ?
               AND (m.person_key IS NULL OR m.person_key = s.person_key)
               AND (m.kind IS NULL OR m.kind = s.kind)
          )
          AND (
            json_extract(s.evidence, '$.quote_context_id') IS NULL
            OR EXISTS (SELECT 1 FROM context c WHERE c.id = json_extract(s.evidence, '$.quote_context_id'))
          )
          AND (
            json_extract(s.evidence, '$.commitment_claim_id') IS NULL
            OR (
              EXISTS (SELECT 1 FROM claim cl WHERE cl.id = json_extract(s.evidence, '$.commitment_claim_id'))
              AND COALESCE((
                SELECT d.action FROM claim_decision d
                 WHERE d.claim_id = json_extract(s.evidence, '$.commitment_claim_id')
                 ORDER BY d.created_at DESC, d.id DESC LIMIT 1
              ), 'pending') <> 'reject'
            )
          )`
    ).all(
      kind, now - windowMs,
      mode ?? null, mode ?? null,
      producerVersion ?? null, producerVersion ?? null,
      kind, now
    );
    const keys = new Set();
    for (const row of rows) {
      if (servable !== undefined) {
        // The caller's own gate wants a card, not a row: the same four
        // fields hermes' cardBlockReason reads, decoded from the snapshot
        // exactly as hydrateCards decodes them.
        let evidence = {};
        try { evidence = JSON.parse(row.evidence) ?? {}; } catch { evidence = {}; }
        const asCard = {
          snapshot_id: Number(row.id), personKey: row.personKey, kind: row.kind,
          quoteContextId: evidence.quote_context_id ?? null, evidence,
        };
        if (servable(asCard) !== true) continue;
      }
      keys.add(row.personKey);
    }
    return keys;
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
  const windowMs = policy.liveWindowMs ?? LIVE_WINDOW_MS;
  rel.refill ??= { owe: { at: null, empty: false }, reconnect: { at: null, empty: false } };
  rel.cards ??= [];
  rel.batch ??= { owe: null, reconnect: null };

  // A STALE BATCH LEAVES THE QUEUE (finding 4). Nothing used to prune
  // rel.cards, and hydrateCards restored the newest batch per (kind, mode)
  // with no age bound at all -- so an 8-day-old unshown card held its kind's
  // turn indefinitely while the exclusion set's own window had already let
  // that person go, which is the double offer from two directions at once.
  // Dropping it here, in the one place both the turn check and the route's
  // serving queue read from, means the next request refills instead.
  rel.cards = rel.cards.filter((card) => isSnapshotFresh(db, card.snapshot_id, { now, windowMs }));

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
  const age = { now, windowMs };
  if (hasLiveOfKind(db, rel.cards, P, policy.currentVersions, modeFor(P), servable, age)) return { servingKind: P };
  const producedP = tryProduce(P);
  if (producedP.produced > 0) return { servingKind: P };

  if (hasLiveOfKind(db, rel.cards, Q, policy.currentVersions, modeFor(Q), servable, age)) return { servingKind: Q };
  const producedQ = tryProduce(Q);
  if (producedQ.produced > 0) return { servingKind: Q };

  return { servingKind: null, reason: 'pool-exhausted' };
}
