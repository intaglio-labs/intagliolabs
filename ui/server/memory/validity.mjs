// When a claim stops being about the future. PURE: no database, no model.
//
// THE MEASURED PROBLEM. 95 of 156 claims on the live store are plans or
// commitments, and 92 of those describe intentions more than 30 days old. The
// store had no way to say a plan had passed: observed_at records when it was
// SAID, and a reader has to infer everything else. So "the owner flies to
// Denver on the 2nd" and "the owner is vegetarian" aged identically, which is
// wrong in both directions -- the flight is over, the diet is not.
//
// WHY A REGEX AND NOT THE MODEL. `valid_to` is a fact about the calendar, not a
// judgement, and judgements about a claim's standing belong to the owner. The
// date is lifted from text the owner will read and decide on; it is never
// evidence, it never accepts or rejects anything, and a claim with no
// recognisable date simply has no end -- which is the safe direction, because
// an unexpired claim stays in the queue and an expired one only sorts lower.
//
// This works BECAUSE the distiller now resolves relative time into real dates
// (see rowDateLine in distill.mjs): "tomorrow" used to be unparseable by
// anything, and 21% of plans carried exactly that.

// ISO first, because that is what the prompt now asks for. The month-name forms
// are for claims written before that change and for a model that ignores it.
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/u;
const MONTHS = 'january february march april may june july august september october november december';
const DAYS = 'sunday monday tuesday wednesday thursday friday saturday'.split(' ');
const WEEKDAY = new RegExp(`\\b(${DAYS.join('|')})\\b`, 'iu');
const MONTH_DAY = new RegExp(
  `\\b(${MONTHS.split(' ').join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  'iu'
);

// Kinds that can EXPIRE. A fact, a preference and a constraint are about how
// the world is, and a date inside one is usually part of the fact rather than
// its expiry -- "the owner has been vegetarian since 2026-01-04" must not
// expire on the 4th of January. Only an intention has an end.
export const EXPIRING_KINDS = Object.freeze(['plan', 'commitment']);

export function endOfDayUtc(y, m, d) {
  const ms = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  const back = new Date(ms);
  // Reject a date the calendar does not have -- 2026-02-31 parses as March 3
  // in every Date implementation, and a claim about a day that never existed
  // should have no expiry rather than a silently moved one.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

// The date a claim is about, or null. End of that day: a plan for the 14th is
// live all through the 14th.
export function validToFor(claim, { observedAt = null } = {}) {
  if (!claim || typeof claim !== 'object') return null;
  if (!EXPIRING_KINDS.includes(claim.kind)) return null;
  const text = typeof claim.text === 'string' ? claim.text : '';

  const iso = text.match(ISO);
  if (iso) return endOfDayUtc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const md = text.match(MONTH_DAY);
  if (md) {
    const month = MONTHS.split(' ').indexOf(md[1].toLowerCase()) + 1;
    const day = Number(md[2]);
    if (md[3]) return endOfDayUtc(Number(md[3]), month, day);
    // No year written. Resolve against when it was SAID, not against now: a
    // claim distilled a year late must not silently become next year's plan.
    // A month already past at that point means the following year.
    if (observedAt === null) return null;
    const said = new Date(Number(observedAt));
    if (Number.isNaN(said.getTime())) return null;
    const year = month < said.getUTCMonth() + 1 ? said.getUTCFullYear() + 1 : said.getUTCFullYear();
    return endOfDayUtc(year, month, day);
  }
  // A BARE WEEKDAY, resolved against when it was said.
  //
  // Measured on the re-distilled corpus: of 89 plan claims, 51 name no time at
  // all, and of the 38 that do, 17 say only "on Tuesday". The model is told to
  // resolve relative time into a date and largely does not -- an 8B following
  // that instruction 1 time in 38 is a fact about the model, not the pipeline --
  // so the largest recoverable group is the one it expresses most naturally.
  //
  // "Tuesday" in a message written on a Friday means the NEXT Tuesday, which is
  // the ordinary English reading and the same shape as the month rule above.
  // Same day-of-week as the message means a week ahead, not that morning: a plan
  // is written before the thing it plans.
  //
  // A guess in the sense that any calendar reading is, and safe because valid_to
  // is advisory -- it sorts a claim, never retires one, and the claim's own text
  // still says "Tuesday" for the owner to read.
  const wd = text.match(WEEKDAY);
  if (wd && observedAt !== null) {
    const said = new Date(Number(observedAt));
    if (Number.isNaN(said.getTime())) return null;
    const want = DAYS.indexOf(wd[1].toLowerCase());
    if (want < 0) return null;
    let ahead = (want - said.getUTCDay() + 7) % 7;
    if (ahead === 0) ahead = 7;
    const target = new Date(said.getTime() + ahead * 86_400_000);
    return endOfDayUtc(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate());
  }
  return null;
}

// Advisory only. An expired claim is not deleted, not rejected and not hidden:
// it sorts below live ones and the review queue can say so. Only the owner
// retires a claim, through claim_decision.
export function isExpired(claim, { now = Date.now() } = {}) {
  const to = claim?.valid_to ?? null;
  return to !== null && Number(to) < now;
}
