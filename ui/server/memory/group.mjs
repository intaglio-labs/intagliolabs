// Near-duplicate grouping for the review queue. Pure: no database, no I/O, so it
// can be tested on fixtures and reasoned about without a corpus.
//
// WHY. One evening's messages about the same thing produce the same claim five
// times over — "The owner is flying to Honolulu on the 14th" from the plan, the
// confirmation, the reminder and the reply to a question about it. Asked one at a
// time that is five decisions carrying one decision's worth of information, and
// it is most of what makes the queue feel endless.
//
// Grouped, the owner reads it once and answers once, and every claim in the group
// takes the same decision. Which is only safe because the grouping is CONSERVATIVE
// — see the threshold below. A group that merges two different facts would hide
// one of them behind the other's decision, and that is worse than a long queue.

// Words carried by almost every claim. Dropped before comparison so two claims
// are not called similar on the strength of "the owner is".
const NOISE = new Set([
  'the', 'owner', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'has',
  'have', 'had', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'that',
  'this', 'it', 'they', 'their', 'them', 'with',
]);

// Letters and digits only, lowercased. Punctuation and possessives are noise for
// this comparison — "owner's" and "owners" are the same word here.
export function tokens(text) {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => w.length > 0 && !NOISE.has(w));
}

// Jaccard over the content words: shared / total distinct. Symmetric, cheap, and
// it does not care about word order, which is what "same fact, said differently"
// looks like.
export function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared);
}

// MEASURED, NOT PICKED. In a private syntheticized test run, every threshold
// from 0.5 to 0.9 produced the same grouping. The distribution is bimodal —
// repeats score near 1.0 and
// everything else falls below 0.4 — so the number barely matters and the high end
// is free.
//
// Which also says what this does and does not do. It catches REPEATS: the same
// claim distilled from four messages about one evening, which at temperature 0
// come back near-identically worded. It does not catch paraphrases — "allergic to
// penicillin" and "has an allergy to penicillin" share one content word and score
// 0.33 — and it should not, because at a threshold low enough to merge those, "the
// owner flies to Honolulu on the 14th" merges with "…to Denver on the 2nd". One
// decision would then silently answer for both. A slightly longer queue and a
// wrong answer nobody saw are not symmetric costs.
export const SIMILAR_ENOUGH = 0.8;

// Group claims that say the same thing. Returns groups in the order their first
// member arrived, so the confidence ordering the queue already applies survives.
//
// Only claims of the SAME KIND group: a `fact` and a `plan` that share words are
// still two different assertions about the world.
export function groupClaims(claims, { threshold = SIMILAR_ENOUGH } = {}) {
  const groups = [];
  for (const claim of Array.isArray(claims) ? claims : []) {
    if (claim === null || typeof claim !== 'object') continue;
    const hit = groups.find(
      (g) => g.kind === claim.kind && similarity(g.claims[0].text, claim.text) >= threshold
    );
    if (hit) {
      hit.claims.push(claim);
      continue;
    }
    groups.push({ kind: claim.kind, claims: [claim] });
  }
  // The representative is the first — the queue is already ordered by the model's
  // own confidence, so the first is the best-supported phrasing of the group.
  return groups.map((g) => ({
    kind: g.kind,
    lead: g.claims[0],
    others: g.claims.slice(1),
    ids: g.claims.map((c) => c.id),
    size: g.claims.length,
  }));
}
