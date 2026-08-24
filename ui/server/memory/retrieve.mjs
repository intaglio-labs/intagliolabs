// Retrieval over ACCEPTED claims. Deliberately boring.
//
// No embeddings, no graph, no importance score, no access-frequency
// reinforcement, no multiplicative ranking formula. FTS5 plus recency, because
// the accepted-claim set is small enough that a boring method is measurable and
// debuggable, and a clever one would be neither. When the set outgrows this,
// replace it on evidence — not because ranking is fun to write.
//
// TWO PROPERTIES THIS MODULE HAS THAT MATTER MORE THAN RELEVANCE:
//
//   1. IT NEVER RETURNS A QUOTE. The row a claim came from is the owner's
//      verbatim words, and the caller downstream is a Messages reply that
//      transits Apple's servers to every device on the Apple ID. The quote is
//      not omitted by the caller's good manners; it is not in the SELECT. To
//      see a receipt you open the review page, which is local.
//   2. IT ABSTAINS. A question with no accepted support returns nothing and
//      says so. An answer composed from zero claims is a guess wearing the
//      costume of a memory, and it is worse than silence — the whole point of
//      the accept step is that Hazlie only says what the owner confirmed.
//
// `match` is an FTS5 expression that the CALLER has already sanitised with
// hermes' ftsQuery(). It is not sanitised here, and this module does not import
// hermes to do it, because hermes imports this one. Pass raw user text in and
// you have handed an FTS5 injection to the query planner.

// A claim older than this is not evidence about the present. It is not deleted
// and not hidden from the review page — it simply stops being offered as an
// answer to "what do I do about X now". Two years is generous on purpose: the
// facts this system is for (allergies, a train, not drinking) do not expire.
import { tokens } from './group.mjs';

export const RECENCY_HORIZON_MS = 730 * 86_400_000;

export const DEFAULT_RECALL_LIMIT = 8;
export const MAX_RECALL_LIMIT = 25;

// Field by field, never `SELECT *` and never `c.*`. A widened table must not be
// able to silently widen what reaches Messages — which is exactly how a quote
// would arrive here one day without anybody deciding it should.
const FIELDS =
  'c.id, c.kind, c.text, c.observed_at, c.created_at, s.source, x.ts AS source_ts';

function recentRows(db, limit) {
  return db
    .prepare(
      `SELECT ${FIELDS} FROM v_claim_accepted c ` +
        'JOIN claim_source s ON s.claim_id = c.id ' +
        'LEFT JOIN context x ON x.id = s.context_id ' +
        'ORDER BY COALESCE(c.observed_at, c.created_at) DESC, c.id DESC LIMIT ?'
    )
    .all(limit);
}

export function recallClaims(db, { match = null, limit = DEFAULT_RECALL_LIMIT, now = Date.now() } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_RECALL_LIMIT, MAX_RECALL_LIMIT));

  // No search terms is not an error and not "everything". It is the most recent
  // accepted claims, which is what `hz memory` style questions want.
  const rows =
    match === null
      ? recentRows(db, capped)
      : db
          .prepare(
            // RELEVANCE PICKS THE SET, RECENCY ORDERS IT. Two different jobs
            // that were one ORDER BY until 2026-08-21, and collapsing them
            // silently broke retrieval at scale.
            //
            // The recency rule is still here and still load-bearing: when two
            // accepted claims disagree — "I'm vegetarian" and, later, "I eat
            // fish now" — the newer one is the answer, and v1 resolves that by
            // ordering rather than by asking a model to reconcile them. That
            // is what the OUTER order by does.
            //
            // What it must not also decide is WHICH claims are in the window.
            // ftsQuery ORs every word of the question, stopwords included, so
            // a question matches a large fraction of the store; sorting those
            // hits by date and taking the first N is then almost independent of
            // the question. Measured on the L5 coverage run (675 claims):
            // "When do I fly to Honolulu?" matched 331 claims, the single claim
            // mentioning Honolulu ranked 209th by date, and it could never
            // enter a top-25 window. The system abstained on data it held.
            //
            // bm25 fixes the stopword problem for free: a term appearing in
            // most documents carries almost no weight, so a claim matching only
            // "do" and "to" ranks below one matching "Honolulu".
            //
            // The header of this file says to replace this on evidence rather
            // than because ranking is fun to write. This is that evidence.
            `SELECT id, kind, text, observed_at, created_at, source, source_ts FROM (` +
              `SELECT ${FIELDS}, bm25(claim_fts) AS rank FROM claim_fts f ` +
              'JOIN v_claim_accepted c ON c.id = f.rowid ' +
              'JOIN claim_source s ON s.claim_id = c.id ' +
              'LEFT JOIN context x ON x.id = s.context_id ' +
              'WHERE claim_fts MATCH ? ' +
              // bm25 returns a NEGATIVE score, more negative = better match,
              // so ASC is best-first.
              'ORDER BY rank ASC LIMIT ?' +
              ') ORDER BY COALESCE(observed_at, created_at) DESC, id DESC'
          )
          .all(match, capped);

  // TOP-UP, and it is the difference between a memory system that works and
  // one that is technically correct.
  //
  // Lexical search misses constantly on real questions. Two measured cases from
  // the Days 7-9 gate, and note they fail differently:
  //
  //   "any allergies?"       matched NOTHING against a claim reading "allergic
  //                          to penicillin" -- those words do not share a stem,
  //                          and porter does not fix it.
  //   "how do you get to work?"  matched the WRONG TWO claims and never
  //                          surfaced "the owner takes the 7am train on weekdays".
  //
  // A fallback that only fires on zero results fixes the first and not the
  // second, which is why this tops up unconditionally: take the search hits,
  // then fill the remaining slots with the most recent accepted claims that are
  // not already there. The composer decides relevance -- it can read, and a
  // keyword cannot.
  //
  // This is affordable precisely because the set is small and human-curated:
  // every row in it was read and accepted by the owner one at a time. It would
  // be reckless over thousands of claims. Revisit it then, with a measurement
  // rather than a hunch.
  //
  // Abstention survives, and means something stronger than before: not "no
  // keyword matched" but "there is nothing accepted here at all". A question
  // the notes genuinely do not cover is refused by the composer, which is the
  // layer that can actually read them -- verified in the gate, where "what's my
  // favourite film?" abstained with all seven claims in front of it.
  const matched = rows.length;
  if (match !== null && rows.length < capped) {
    const seen = new Set(rows.map((r) => Number(r.id)));
    for (const extra of recentRows(db, capped)) {
      if (seen.has(Number(extra.id))) continue;
      rows.push(extra);
      if (rows.length >= capped) break;
    }
  }

  const horizon = now - RECENCY_HORIZON_MS;
  const claims = rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    text: r.text,
    // The two dates a Messages answer is allowed to carry: when the thing was
    // observed, and which kind of source it came from. Never the row.
    observed_at: r.observed_at === null ? null : Number(r.observed_at),
    source: r.source,
    stale: Number(r.observed_at ?? r.created_at) < horizon,
  }));

  return { claims, abstain: claims.length === 0, matched };
}

// The owner's LOCAL calendar day, same arithmetic as episodic.mjs's
// localDate. Claim lines and episodic lines merge into ONE numbered envelope
// in handleVaultAsk, and episodic dates are local — rendering these in UTC
// dated anything observed after 14:00 Honolulu time on the NEXT day, handing
// the model two dating conventions in one list.
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The shape a composer is handed. Flat, labelled, and explicitly NOT prose the
// model can mistake for its own instructions — see prompts/answer_from_claims.md
// for the envelope those go in.
export function groundingLines(claims) {
  return claims.map((c, i) => {
    const when = c.observed_at === null ? 'undated' : localDay(c.observed_at);
    return `[${i + 1}] (${c.kind}, ${c.source}, ${when}${c.stale ? ', OLD' : ''}) ${c.text}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ASK AT THE POINT OF USE.
//
// The review queue is the front door and it is a bad one: a hundred claims to
// confirm back to back is a chore nobody finishes, and a backlog nobody clears
// is a memory that never turns on. This is the other door. When a question finds
// nothing accepted but a PROPOSED claim would have answered it, that is the
// moment the decision is worth making — one claim, in context, with the question
// that needed it on screen.
//
// Same bm25 match as recallClaims and deliberately so: this returns exactly what
// the answer would have used had it been accepted, never a guess at what might
// be interesting.
//
// It reads nothing that has been decided. A rejected claim stays rejected and is
// never asked about again.
// Words a question is made of rather than about. ftsQuery ORs every term,
// stopwords included, so "what do i eat" matches any claim containing "what" —
// which on a real corpus surfaced a claim about product development. Good enough
// to RANK by (bm25 discounts common terms) and nowhere near good enough to decide
// "this would have answered your question", which is what a confirmation card
// asserts when it puts itself in front of somebody.
const ASKING = new Set([
  'what', 'whats', 'when', 'where', 'who', 'whom', 'whose', 'why', 'how',
  'do', 'does', 'did', 'doing', 'done', 'can', 'could', 'would', 'should',
  'will', 'shall', 'may', 'might', 'must', 'i', 'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'we', 'us', 'our', 's', 't', 'm', 're', 'll', 've',
  'know', 'tell', 'think', 'about', 'like', 'any', 'some', 'thing', 'things',
  'stuff', 'ever', 'again', 'now', 'today', 'please', 'anything', 'something',
]);

// Crude suffix stripping, for the overlap check ONLY.
//
// "what do i eat" against "The owner eats fish" shares no literal token, and that
// is the single most ordinary question shape there is. A real stemmer is not worth
// a dependency here: this exists to decide whether two words are plausibly the
// same word, and being slightly too generous costs a suggestion that shares a
// stem but not a meaning — which the owner then answers "no" to, once.
function stem(w) {
  // Order matters, and 'es' is deliberately absent: it turned "lives" into "liv",
  // which then failed to match "live". Plain 's' handles that case and the plural
  // one, and 'ies' is kept because "flies"/"flying" both need to reach "fly".
  // "flies" -> "fly" needs its own guard: the general "leave at least 3 letters"
  // rule would keep it whole, and "when do i fly" is exactly the question this
  // check exists to answer.
  if (w.length >= 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 's']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      return w.slice(0, -suffix.length);
    }
  }
  return w;
}

// The words that actually carry the question. Reuses the claim tokeniser (which
// already drops "the owner is"), drops the interrogative scaffolding, and stems
// what is left so word forms line up.
function asking(text) {
  return new Set(
    tokens(text)
      .filter((w) => !ASKING.has(w) && w.length > 2)
      .map(stem)
  );
}

// A suggestion has to EARN the interruption: at least one content word in common.
// Without this every abstention showed a claim, and a claim that has nothing to do
// with the question is worse than no claim — it is a wrong guess presented as a
// memory, asked at the moment the owner is least able to check it.
export function sharesContent(question, claimText) {
  const q = asking(question);
  if (q.size === 0) return false;
  for (const w of asking(claimText)) if (q.has(w)) return true;
  return false;
}

export function pendingForQuery(db, { match = null, limit = 1, question = null } = {}) {
  if (match === null) return [];
  const capped = Math.max(1, Math.min(Number(limit) || 1, 5));
  const rows = db
    .prepare(
      'SELECT c.id, c.kind, c.text, c.p_claim, s.quote, s.source, ' +
        'bm25(claim_fts) AS rank ' +
        'FROM claim_fts f ' +
        'JOIN claim c ON c.id = f.rowid ' +
        'JOIN claim_source s ON s.claim_id = c.id ' +
        'WHERE claim_fts MATCH ? ' +
        'AND NOT EXISTS (SELECT 1 FROM claim_decision d WHERE d.claim_id = c.id) ' +
        'ORDER BY rank ASC LIMIT ?'
    )
    .all(match, Math.max(capped, 8));
  // Ranked by bm25, then filtered by whether it is about the same thing at all.
  // Over-fetch first: the best-ranked hit is often the least relevant on a short
  // question, and the one worth asking about can sit a few places down.
  const useful = question === null ? rows : rows.filter((r) => sharesContent(question, r.text));
  return useful.slice(0, capped);
}
