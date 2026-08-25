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

// RESOLVING A TIME PHRASE, which is the half the model must not do.
//
// MEASURED, and it is the whole reason this function exists. Told to resolve
// relative time into a real date, and shown [written YYYY-MM-DD] to do it with,
// the local 8B complied ONCE IN 38 across a full corpus pass. Given a
// pattern-constrained date field it emitted a well-formed date every time and
// still wrote the day the message was SENT rather than the day "tomorrow" means.
// The format was never the problem; the arithmetic was.
//
// Asked instead to COPY the words the message uses for when -- "tomorrow",
// "tuesday", "the 14th" -- it was right 6 times out of 6 including the empty
// case, because copying an exact span is the thing this pipeline already relies
// on it for everywhere else (see the quote check).
//
// So the split is the same one the rest of this system makes: the model reads,
// code decides. Dates are arithmetic and arithmetic belongs here.
//
// Everything below resolves FORWARD from when the message was written, because
// a plan is written before the thing it plans. Anything unrecognised returns
// null, which means "no expiry" -- the safe direction.

const DAY_MS = 86_400_000;

const nextWeekday = (said, want) => {
  let ahead = (want - said.getUTCDay() + 7) % 7;
  if (ahead === 0) ahead = 7; // a plan for "friday" said on a friday means the next one
  return new Date(said.getTime() + ahead * DAY_MS);
};

const asEndOfDay = (d) => endOfDayUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());

export function resolvePhrase(phrase, observedAt) {
  if (typeof phrase !== 'string') return null;
  const p = phrase.toLowerCase().trim();
  if (p.length === 0) return null;
  // null and undefined are rejected BEFORE the Number(), because Number(null)
  // is 0 and 0 is finite: an unanchored phrase would otherwise resolve against
  // 1970 and every such claim would read as PASSED the moment it was written.
  if (observedAt === null || observedAt === undefined) return null;
  const ts = Number(observedAt);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const said = new Date(ts);
  if (Number.isNaN(said.getTime())) return null;

  // An explicit date inside the phrase wins over any relative reading.
  const iso = p.match(ISO);
  if (iso) return endOfDayUtc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const md = p.match(MONTH_DAY);
  if (md) {
    const month = MONTHS.split(' ').indexOf(md[1]) + 1;
    const year = md[3]
      ? Number(md[3])
      : month < said.getUTCMonth() + 1
        ? said.getUTCFullYear() + 1
        : said.getUTCFullYear();
    return endOfDayUtc(year, month, Number(md[2]));
  }

  // Same day. "tonight" is still today: the plan is over when the day is.
  if (/\b(today|tonight|this (morning|afternoon|evening)|later today)\b/u.test(p)) {
    return asEndOfDay(said);
  }
  if (/\bday after tomorrow\b/u.test(p)) return asEndOfDay(new Date(ts + 2 * DAY_MS));
  if (/\b(tomorrow|tmr|tmrw|tomo)\b/u.test(p)) return asEndOfDay(new Date(ts + DAY_MS));

  // A named day, with or without "next" -- both mean the next one to arrive.
  const wd = p.match(WEEKDAY);
  if (wd) return asEndOfDay(nextWeekday(said, DAYS.indexOf(wd[1])));

  // The weekend: the Saturday that starts it.
  if (/\b(this |next |the )?weekend\b/u.test(p)) return asEndOfDay(nextWeekday(said, 6));

  // Vague spans resolve to the END of the span, which is the honest reading of
  // "sometime next week" -- it is over when the week is, not on any one day.
  if (/\bnext week\b/u.test(p)) {
    const start = nextWeekday(said, 1); // the coming Monday
    return asEndOfDay(new Date(start.getTime() + 6 * DAY_MS));
  }
  if (/\bnext month\b/u.test(p)) {
    const y = said.getUTCMonth() === 11 ? said.getUTCFullYear() + 1 : said.getUTCFullYear();
    const m = ((said.getUTCMonth() + 1) % 12) + 1;
    return endOfDayUtc(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate()); // last day of it
  }

  // "the 14th" -- a day of the month with no month named. The next one to come.
  const dom = p.match(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/u);
  if (dom) {
    const day = Number(dom[1]);
    if (day >= 1 && day <= 31) {
      // STRICTLY LATER THAN THE MESSAGE'S DAY, not merely later than its
      // timestamp. Comparing end-of-day against the send time made "the 14th"
      // written ON the 14th resolve to that same night, because the day's end
      // is always after a message sent during it -- while "saturday" written on
      // a Saturday correctly went a week out. Same input, two answers. A plan
      // is written before the thing it plans, so the ordinal follows the
      // weekday: this month only if the day has not arrived yet.
      const sameDay =
        said.getUTCDate() === day;
      const thisMonth = endOfDayUtc(said.getUTCFullYear(), said.getUTCMonth() + 1, day);
      if (!sameDay && thisMonth !== null && thisMonth >= ts) return thisMonth;
      const y = said.getUTCMonth() === 11 ? said.getUTCFullYear() + 1 : said.getUTCFullYear();
      const m = ((said.getUTCMonth() + 1) % 12) + 1;
      return endOfDayUtc(y, m, day);
    }
  }
  return null;
}

// The date a claim is about, or null. End of that day: a plan for the 14th is
// live all through the 14th.
export function validToFor(claim, { observedAt = null } = {}) {
  if (!claim || typeof claim !== 'object') return null;
  if (!EXPIRING_KINDS.includes(claim.kind)) return null;

  // THE STRUCTURED PHRASE FIRST. `when_phrase` is the words the message itself
  // used, copied by the model rather than interpreted, and it is far more
  // reliable than scanning the claim's rewritten prose -- the model paraphrases
  // freely in `text` and copies exactly in a field the grammar requires.
  const fromPhrase = resolvePhrase(claim.when_phrase, observedAt);
  if (fromPhrase !== null) return fromPhrase;

  // Falling back to the prose, for claims written before the field existed and
  // for any the model left empty.
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
