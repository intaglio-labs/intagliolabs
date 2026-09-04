// Does the claim's own evidence contain the claim?
//
// THE GAP THIS FILLS. validateRowClaims already proves the quote is REAL -- an
// exact span of the row we sent. It never proves the quote SUPPORTS the sentence
// the model wrote from it, and those are different questions. On 2026-08-31 the
// distill prompt's own worked examples turned up in the corpus as facts about the
// owner, each carrying a genuine receipt: "The owner is allergic to penicillin"
// at p_claim 0.95, quoting a real FIVE-CHARACTER span of a message that mentions
// neither penicillin nor allergy. Every existing check passed.
//
// NOT A MODEL, AND THAT IS THE POINT. Asking a model whether a model's claim is
// supported buys correlated errors and another 90 seconds per claim. This is set
// overlap: the content words of the claim against the words of the row it cites.
// It is crude, it is instant, and it is honest about what it measures.
//
// NOT A FILTER, EITHER. Measured across the whole corpus, 680 of 3,948 claims
// (17.2%) share no content word with their own source row. Some of those are
// fabrications; many are legitimate paraphrases where the model resolved a
// pronoun or normalised a date, which is exactly what the prompt asks it to do.
// Rejecting 17% of a corpus on a heuristic is not a correction, it is a second
// error. So this produces a SIGNAL for triage and for the review queue's
// ordering, and a human decides. claim_decision has always been the place where
// truth is settled, and its actor column has always distinguished 'owner' from
// 'system' for this reason.

// Words too common to carry meaning, plus the prompt's own scaffolding ("the
// owner" prefixes every claim by instruction, so it can never be evidence of
// anything). Deliberately short: an aggressive stop list would inflate the
// support score by removing the words that fail to match.
const STOP = new Set([
  'the', 'owner', 'they', 'them', 'their', 'theirs', 'have', 'has', 'had',
  'with', 'that', 'this', 'will', 'would', 'about', 'from', 'been', 'there',
  'which', 'when', 'where', 'after', 'before', 'into', 'over', 'than', 'then',
  'some', 'also', 'only', 'very', 'just', 'more', 'most', 'other', 'such',
  'both', 'each', 'same', 'being', 'does', 'said', 'says', 'going', 'still',
  'because', 'while', 'until', 'again', 'could', 'should', 'might', 'must',
]);

/**
 * Content words worth matching on. Length >= 4 keeps this from scoring on "a",
 * "to" and "on", which appear in every message and would make every claim look
 * supported.
 */
export function contentWords(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/gu, ' ')
      .split(/\s+/u)
      .map((w) => w.replace(/^['-]+|['-]+$/gu, ''))
      .filter((w) => w.length >= 4 && !STOP.has(w))
  );
}

/**
 * How much of the claim is findable in its evidence.
 *
 * `ratio` is over the claim's own content words, not the row's: a long message
 * containing one matching word does not make a claim well-supported, but a claim
 * whose every word appears in its source is well-supported however long the
 * source is.
 *
 * Both the quote and the full row are scored. The quote is the receipt the model
 * chose; the row is what it was actually shown. A claim supported by the row but
 * not the quote means the model cited the wrong span -- worth seeing, and not the
 * same failure as a claim supported by neither.
 */
export function supportOf(claimText, rowText, quote) {
  const claim = contentWords(claimText);
  if (claim.size === 0) {
    // Nothing to check. A claim of only stopwords is its own problem, and
    // reporting it as perfectly supported would be a lie in the flattering
    // direction.
    return { words: 0, inRow: 0, inQuote: 0, ratio: null, quoteRatio: null };
  }
  const row = contentWords(rowText);
  const q = contentWords(quote);
  let inRow = 0;
  let inQuote = 0;
  for (const word of claim) {
    if (row.has(word)) inRow += 1;
    if (q.has(word)) inQuote += 1;
  }
  return {
    words: claim.size,
    inRow,
    inQuote,
    ratio: inRow / claim.size,
    quoteRatio: inQuote / claim.size,
  };
}

/**
 * A label for the review queue, not a verdict.
 *
 * 'unsupported' is the interesting one and it is deliberately the narrowest: NO
 * content word of the claim appears anywhere in the message it cites. That is the
 * band all eight prompt-echo claims fell into, and it is 17.2% of the corpus --
 * large enough that calling it "wrong" would be overreach, and specific enough to
 * be worth a human's attention first.
 */
export function supportBand({ ratio }) {
  if (ratio === null) return 'unscorable';
  if (ratio === 0) return 'unsupported';
  if (ratio < 0.34) return 'weak';
  return 'supported';
}
