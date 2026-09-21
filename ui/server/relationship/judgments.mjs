// THE JUDGMENT PASS: what the card asks Jev about a person, in one call, and
// what the answers become. Runs BESIDE the producers, never inside them --
// produceBatch and produceDailyBatch are synchronous and the card route calls
// them inline, so a network await there would rewrite five call sites and
// park hermes' single thread. This module writes a cache (rm_judgment) and
// the serve reads it; a miss is today's heuristic, unchanged.
//
// THE QUESTIONS (owner decisions 2026-09-20, measured on 54 judged cards):
//   quote_L1..Ln   a Score per candidate line: how much it gives the owner to
//                  reply about, months later. Replaces the 12-char/3-word
//                  floor, which let "Happy birthday Rishab !" onto the first
//                  live card (23 chars, 3 words, not an ACK word).
//   ended          Choice warm/neutral/bad over the last 12 lines.
//   professional_axis, closeness   two Scores. ~~A four-way Choice
//                  business/friend/family/romantic~~ said "friend" for 41 of
//                  54 people the regex label called business, at 0.79
//                  confidence, and said "business" for 47 of 54 with the words
//                  removed: both are true of a friend the owner also works
//                  with, so the label is DERIVED in code from the two axes and
//                  two flags below, and the axes are kept for the card and
//                  the rank.
//   relatives, romantic   two Nouls, the flags.
//   worth          Noul, the owner's accept pattern spelled out (AUC 0.72).
// Order inside every question is a frozen literal, and each question's sha
// rides the cached row (see jev.mjs).
//
// KIND SHIPS FROM JEV and GATES ELIGIBILITY (owner, 2026-09-20: "kind should
// ship from jev"; then "1 yes" to the derived kind driving the romantic/family
// exclusion). The derived label becomes people.role through the projection
// (graph.mjs reads judgedRoles below between the owner's override and the
// regex guess), so the seven consumers of the label keep their enum and their
// queries untouched.
import { choiceQuestion, scoreQuestion, noulQuestion, recordJudgment, judgmentFor, recordUsage, usageToday } from './jev.mjs';
import { buildPersonState, quoteCandidates, lastExchange, stateHash, ENDED_LINES } from './personState.mjs';

export const JUDGMENT_VERSION = 'rm-judge-v1';

const QUOTE_LEVELS = Object.freeze([
  'Nothing to reply to: an acknowledgement, a greeting, a birthday or holiday wish, an emoji, a link with no words, or an automated notice.',
  'A pleasantry with a little content, but nothing the owner could act on or ask about.',
  'Names a real thing (a topic, a place, a person, a piece of work) but says nothing the owner could pick up.',
  'Says something specific the owner could reply to: a plan, an opinion, news, a question.',
  'An open thread: an unanswered question, a promise, an invitation, or an ask left hanging.',
]);
const QUOTE_INSTRUCTIONS = 'This line was written by the other person to the owner. How much does it give the owner something specific to reply about, months later, out of the blue?';
export const QUOTE_MIN_SCORE = 3.0;

export const ENDED = choiceQuestion(
  'Looking only at `last_exchange`, how did this conversation leave things between the two people?',
  Object.freeze([
    ['warm', 'ended on good terms: thanks, agreement, plans made, a friendly sign-off'],
    ['neutral', 'it just stopped: logistics done, a short acknowledgement, nothing in particular'],
    ['bad', 'visible conflict or coldness, a complaint, a refusal, or a pointed question from them the owner never answered'],
  ])
);
export const ENDED_MIN_CONFIDENCE = 0.6;
export const ENDED_MIN_PROBABILITY = 0.5;

export const PROFESSIONAL_AXIS = scoreQuestion(
  'Weigh `professional` and `relationship_shape` first, then the words. Where does this relationship sit between purely personal and purely professional?',
  Object.freeze(['purely personal', 'mostly personal with some work overlap', 'evenly mixed', 'mostly professional with some personal warmth', 'purely professional'])
);
export const CLOSENESS = scoreQuestion(
  'How close are these two people, judging from `relationship_shape` and the words?',
  Object.freeze(['strangers or one-off contact', 'acquaintances', 'a real but casual relationship', 'close', "very close, part of each other's lives"])
);
export const RELATIVES = noulQuestion('Do the words, names or contact labels indicate these two are relatives?');
export const ROMANTIC = noulQuestion('Do the words or contact labels indicate a romantic or dating relationship, current or past?');
export const WORTH = noulQuestion(
  'The owner accepts a reminder when the relationship was real (many messages or meetings over years), went quiet within roughly the last year, and a message now would be welcome; the owner dismisses reminders about people who have been gone for years or were never close. Given `relationship_shape`, `recency`, `professional` and the words, would the owner accept a reminder to reach out to this person now?'
);
export const FLAG_THRESHOLD = 0.5;
export const BUSINESS_AXIS = 2.5;

// The label the seven consumers of people.role read. Pure, so the rule is
// testable without a database: flags first (a relative who is also a
// colleague is family to the eligibility gate), then the axis.
export function deriveKind({ relatives = null, romantic = null, professionalAxis = null } = {}) {
  if (relatives !== null && relatives > FLAG_THRESHOLD) return 'family';
  if (romantic !== null && romantic > FLAG_THRESHOLD) return 'romantic';
  if (professionalAxis === null) return null;
  return professionalAxis >= BUSINESS_AXIS ? 'business' : 'friend';
}

function quoteQuestionFor(index) {
  return scoreQuestion(`${QUOTE_INSTRUCTIONS} Judge only the line in \`quote_candidates\` with id L${index + 1}.`, QUOTE_LEVELS);
}

// Build the one call for a person. Returns null when there is nothing to
// judge (no people row).
export function buildJudgmentCall(db, personKey, { now = Date.now(), judgments = {} } = {}) {
  const state = buildPersonState(db, personKey, { now });
  if (!state) return null;
  const candidates = judgments.quote === false ? [] : quoteCandidates(db, personKey);
  const ended = judgments.ending === false ? [] : lastExchange(db, personKey, { limit: ENDED_LINES });
  const questions = {};
  const quoteShas = [];
  candidates.forEach((_, i) => {
    const q = quoteQuestionFor(i);
    questions[`quote_L${i + 1}`] = q;
    quoteShas.push(q.sha);
  });
  if (ended.length > 0) questions.ended = ENDED;
  if (judgments.kind !== false) {
    questions.professional_axis = PROFESSIONAL_AXIS;
    questions.closeness = CLOSENESS;
    questions.relatives = RELATIVES;
    questions.romantic = ROMANTIC;
  }
  questions.worth = WORTH;
  const body = {
    ...state,
    ...(candidates.length ? { quote_candidates: candidates.map((c, i) => ({ id: `L${i + 1}`, text: c.text })) } : {}),
    ...(ended.length ? { last_exchange: ended } : {}),
  };
  // THE CACHE KEY COVERS THE QUESTIONS ASKED, not just the state (review
  // finding 1): a pass narrowed by judgments.kind:false must not satisfy a
  // later full pass on the same person forever.
  return { state: body, questions, candidates, quoteShas, hash: stateHash({ body, asked: Object.keys(questions) }) };
}

// Ask, record, derive. Returns a summary of numbers (never text) or null when
// the engine declined (unconfigured, paused, oversize, network...) -- the
// caller falls back and may retry on the next pass.
export async function judgePerson(db, jev, personKey, { now = Date.now(), judgments = {}, force = false, dailyTokenBudget = null } = {}) {
  const call = buildJudgmentCall(db, personKey, { now, judgments });
  if (!call) return null;
  // Same facts, lines and questions as the last judgment: nothing to ask.
  const prior = judgmentFor(db, { personKey, kind: 'worth' });
  if (!force && prior && prior.subject_hash === call.hash && prior.question_sha === WORTH.sha) {
    return { personKey, cached: true, hash: call.hash };
  }
  // THE DAILY BUDGET BINDS HERE TOO (review finding 6): owner decision 2 named
  // 25M tokens a day for everything, not just the distiller. Spent means this
  // person waits for tomorrow; the caller reads null as a decline.
  if (Number.isInteger(dailyTokenBudget) && dailyTokenBudget >= 0 && usageToday(db, now).inputTokens >= dailyTokenBudget) {
    return null;
  }
  const out = await jev.ask({ state: call.state, questions: call.questions });
  if (!out) return null;
  const model = out.model ?? jev.model;
  const a = out.answers;
  recordUsage(db, { inputTokens: out.usage.input_tokens, now });
  const summary = { personKey, cached: false, hash: call.hash, inputTokens: out.usage.input_tokens, quotes: 0 };

  // Quotes: one row per candidate line, keyed on the row's content hash so an
  // edited row re-judges and an unchanged one never asks twice.
  call.candidates.forEach((c, i) => {
    const ans = a[`quote_L${i + 1}`];
    if (!ans || ans.type !== 'score') return;
    recordJudgment(db, { personKey, kind: 'quote', subjectId: c.id, subjectHash: c.hash, score: ans.score, confidence: ans.confidence, model, questionSha: call.quoteShas[i], now });
    summary.quotes += 1;
  });
  // "THE QUOTES WERE JUDGED" IS ITS OWN FACT (review finding 2). A person with
  // no candidate lines, or whose lines all failed to score, still had their
  // quotes looked at -- so a marker row (subject null) says so, and the serve
  // may hide the quote rather than fall back to the floor. With
  // judgments.quote:false nothing is written and the producer's quote stands.
  if (judgments.quote !== false && summary.quotes === 0) {
    recordJudgment(db, { personKey, kind: 'quote', subjectHash: call.hash, model, questionSha: `${WORTH.sha}:none`, now });
  }
  // ONLY ANSWERS TO QUESTIONS THAT WERE ASKED. jev.mjs sanitizes to the ids it
  // sent, but this module must not depend on that: an answer for a question
  // the config switched off is not a judgment.
  const asked = (id) => Object.hasOwn(call.questions, id);
  if (asked('ended') && a.ended?.type === 'choice') {
    recordJudgment(db, { personKey, kind: 'ending', subjectHash: call.hash, answer: a.ended.choice, probability: a.ended.probabilities[a.ended.choice] ?? null, confidence: a.ended.confidence, model, questionSha: ENDED.sha, now });
    summary.ended = a.ended.choice;
  }
  let axis = null; let closeness = null; let relatives = null; let romantic = null;
  if (asked('professional_axis') && a.professional_axis?.type === 'score') {
    axis = a.professional_axis.score;
    recordJudgment(db, { personKey, kind: 'professional_axis', subjectHash: call.hash, score: axis, confidence: a.professional_axis.confidence, model, questionSha: PROFESSIONAL_AXIS.sha, now });
  }
  if (asked('closeness') && a.closeness?.type === 'score') {
    closeness = a.closeness.score;
    recordJudgment(db, { personKey, kind: 'closeness', subjectHash: call.hash, score: closeness, confidence: a.closeness.confidence, model, questionSha: CLOSENESS.sha, now });
  }
  if (asked('relatives') && a.relatives?.type === 'noul') {
    relatives = a.relatives.noul;
    recordJudgment(db, { personKey, kind: 'relatives', subjectHash: call.hash, score: relatives, model, questionSha: RELATIVES.sha, now });
  }
  if (asked('romantic') && a.romantic?.type === 'noul') {
    romantic = a.romantic.noul;
    recordJudgment(db, { personKey, kind: 'romantic', subjectHash: call.hash, score: romantic, model, questionSha: ROMANTIC.sha, now });
  }
  const kind = asked('professional_axis') ? deriveKind({ relatives, romantic, professionalAxis: axis }) : null;
  if (kind) {
    recordJudgment(db, { personKey, kind: 'kind', subjectHash: call.hash, answer: kind, score: axis, model, questionSha: `${PROFESSIONAL_AXIS.sha}:${RELATIVES.sha}:${ROMANTIC.sha}`, now });
    summary.kind = kind;
  }
  if (a.worth?.type === 'noul') {
    recordJudgment(db, { personKey, kind: 'worth', subjectHash: call.hash, score: a.worth.noul, model, questionSha: WORTH.sha, now });
    summary.worth = a.worth.noul;
  }
  return summary;
}

// What the serve reads. Every field is null when the cache has nothing above
// threshold, and the caller keeps today's value for a null.
export function cardOverrides(db, personKey) {
  const out = { quoteContextId: null, quoteScore: null, leftTone: null, leftConfidence: null, kind: null, worth: null, closeness: null };
  // Best quote among the CURRENT candidates -- a cached score for a row that
  // has since dropped out of the twelve newest does not resurrect it.
  const candidates = quoteCandidates(db, personKey);
  let best = null;
  for (const c of candidates) {
    const j = judgmentFor(db, { kind: 'quote', subjectId: c.id, subjectHash: c.hash });
    if (!j || j.score === null || j.score < QUOTE_MIN_SCORE) continue;
    // Ties go to the newest, and candidates arrive newest first.
    if (!best || j.score > best.score) best = { id: c.id, score: j.score };
  }
  if (best) { out.quoteContextId = best.id; out.quoteScore = best.score; }
  const ended = judgmentFor(db, { personKey, kind: 'ending' });
  if (ended && ended.answer && (ended.confidence ?? 0) >= ENDED_MIN_CONFIDENCE && (ended.probability ?? 0) >= ENDED_MIN_PROBABILITY) {
    out.leftTone = ended.answer;
    out.leftConfidence = ended.confidence;
  }
  const kind = judgmentFor(db, { personKey, kind: 'kind' });
  if (kind?.answer) out.kind = kind.answer;
  const worth = judgmentFor(db, { personKey, kind: 'worth' });
  if (worth && worth.score !== null) out.worth = worth.score;
  const closeness = judgmentFor(db, { personKey, kind: 'closeness' });
  if (closeness && closeness.score !== null) out.closeness = closeness.score;
  return out;
}

// True when the cache says anything about this person's QUOTES -- a scored
// line or the "looked, nothing to quote" marker -- so the serve can tell
// "judged, nothing worth quoting" (hide the quote) from "not judged yet"
// (today's floor). ~~It asked about `worth`~~, which is written whenever any
// judgment runs, so judgments.quote:false hid every card's quote (review
// finding 2).
export function quotesJudged(db, personKey) {
  return judgmentFor(db, { personKey, kind: 'quote' }) !== null;
}

// The derived label per person for the projection: newest 'kind' row each.
// Read by graph.mjs between the owner's override and the regex guess.
export function judgedRoles(db) {
  const out = new Map();
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT person_key, answer FROM rm_judgment j
       WHERE kind = 'kind' AND answer IS NOT NULL AND person_key IS NOT NULL
         AND id = (SELECT MAX(id) FROM rm_judgment k WHERE k.kind = 'kind' AND k.person_key = j.person_key)`
    ).all();
  } catch {
    return out; // a database from before the table existed
  }
  for (const r of rows) out.set(r.person_key, r.answer);
  return out;
}

// Newest score of one kind per person -- the rank reads 'worth' this way.
export function judgedScores(db, kind) {
  const out = new Map();
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT person_key, score FROM rm_judgment j
       WHERE kind = ? AND score IS NOT NULL AND person_key IS NOT NULL
         AND id = (SELECT MAX(id) FROM rm_judgment k WHERE k.kind = j.kind AND k.person_key = j.person_key)`
    ).all(kind);
  } catch {
    return out;
  }
  for (const r of rows) out.set(r.person_key, Number(r.score));
  return out;
}

// THE RANK'S USE OF THE WORTH JUDGMENT: a bucket, not a weight. Measured
// 2026-09-20 (54 judged cards): worth >= 0.6 was accepted 73% of the time,
// 0.4..0.6 45%, under 0.4 33%. So the pool is ordered by bucket first --
// likely, unjudged, unsure, unlikely -- and by the arithmetic rank (depth,
// change, quiet) inside each bucket. Unjudged sits ABOVE unsure on purpose: a
// person nobody has asked about yet must still get a turn, or the pool would
// only ever serve the people the nightly pass reached first.
export const WORTH_LIKELY = 0.6;
export const WORTH_UNLIKELY = 0.4;
export function worthBucket(worth) {
  if (worth === null || worth === undefined || !Number.isFinite(worth)) return 2;
  if (worth >= WORTH_LIKELY) return 3;
  if (worth < WORTH_UNLIKELY) return 0;
  return 1;
}

// One pass over a list of people, sequential, one at a time: hermes is single
// threaded and each ask is a network await the loop yields on, but the state
// builds between them are synchronous SQL. `spacingMs` between people is what
// keeps the people page answering while a batch is judged.
export async function judgeMany(db, jev, personKeys, { now = Date.now(), judgments = {}, dailyTokenBudget = null, spacingMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onEach = null } = {}) {
  const totals = { asked: 0, cached: 0, declined: 0, inputTokens: 0 };
  for (const personKey of personKeys) {
    if (jev.state !== 'ok') { totals.declined += personKeys.length - totals.asked - totals.cached - totals.declined; break; }
    let result = null;
    try {
      result = await judgePerson(db, jev, personKey, { now: typeof now === 'function' ? now() : now, judgments, dailyTokenBudget });
    } catch {
      result = null; // a per-person failure never stops the pass; counted only
    }
    if (result === null) totals.declined += 1;
    else if (result.cached) totals.cached += 1;
    else { totals.asked += 1; totals.inputTokens += result.inputTokens ?? 0; }
    if (onEach) { try { onEach(personKey, result); } catch { /* observer */ } }
    // The spacing is for the network call, so a cache hit does not pay it
    // (review finding 3: a tick of cached names slept for a minute).
    if (spacingMs > 0 && result && !result.cached && personKey !== personKeys[personKeys.length - 1]) await sleep(spacingMs);
  }
  return totals;
}

// WHO THE POOL PASS SHOULD LOOK AT NEXT: the eligible people with no current
// judgment first, then the stalest. ~~The top of the rank~~ -- which, once
// `worth` leads the order, is the people already judged likely, so a bounded
// slice re-read the same cached names every tick and never reached anyone new
// (review finding 3). `judgedAt` is the newest `worth` row per person.
export function poolJudgmentOrder(db, personKeys, { staleAfterMs = 7 * 86_400_000, now = Date.now() } = {}) {
  const at = new Map();
  try {
    for (const r of db.prepare(
      `SELECT person_key, MAX(created_at) AS at FROM rm_judgment WHERE kind = 'worth' AND person_key IS NOT NULL GROUP BY person_key`
    ).all()) at.set(r.person_key, Number(r.at));
  } catch { /* a database from before the table existed */ }
  return [...personKeys]
    .filter((k) => !at.has(k) || now - at.get(k) >= staleAfterMs)
    .sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0));
}
