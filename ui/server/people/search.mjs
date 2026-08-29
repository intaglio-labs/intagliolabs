// Person-search as a live query surface. Turns "who are investors I talked
// to" typed into the chat into the ranked shortlist the CLI experiment
// produced — same graph, same ranker, answered on demand.
//
// WHY THIS IS A SEPARATE PATH from the claim/episodic answer: those answer
// "what do I know about X". This answers "WHO fits a need" — the graph is the
// data, not a claim or a record, and the ranker is code, not a model. The
// model is not in this path at all: the evidence lines are code-computed and
// human-readable already, so the answer is instant, deterministic, and cannot
// hallucinate a person who is not in the graph. Polish-by-model can come
// later; for a person you might text tomorrow, grounded-and-instant beats
// pretty-and-slow.
//
// INTENT IS NARROW ON PURPOSE. It fires only on relationship/reconnection
// language (investor, mentor, reconnect, lost touch, introduce, who should
// I...), NOT on "who did I text most this month" — that is a recent-stat
// question the episodic shelf already answers well, and hijacking it would
// make the surface worse, not better.

import { CONTENT_SIGNALS } from './graph.mjs';
import { materializedPeopleGraph } from './projection.mjs';
import { rankForNeed, MENTOR_NEED, INVESTOR_NEED, evidenceLine } from './rank.mjs';
import { groupByFirm, warmthLabel } from './firms.mjs';
import { warmIntro } from './intros.mjs';
import { eraLine } from './profile.mjs';
import { answerDeepPeopleSearch } from './deepSearch.mjs';

// "how do i reach X", "warm intro to X", "who can introduce me to X" -> the
// target string X, or null. Separate from the who-fits-a-need searches: this
// one already has a target and wants the PATH to them.
export function detectIntro(question) {
  const q = String(question ?? '').trim();
  // Explicit intro phrasing only. Bare "reach X" / "get to X" were too greedy
  // — they matched "how do you GET TO work?" and hijacked the normal answer
  // path. An intro query names a person to be introduced TO, so the trigger
  // must be intro-shaped, not any verb that can precede a noun.
  const m = q.match(
    /\b(?:warm intro to|intro(?:duce)?(?: me)? to|reach out to|connect me (?:to|with)|get in touch with|a path to|who (?:can|could) (?:intro|introduce|connect) me (?:to|with)|how (?:do|can) i (?:reach|meet|get an intro to))\s+(.+?)[?.!]*$/iu
  );
  const target = m?.[1]?.trim();
  return target && target.length >= 2 ? target : null;
}

// "from 2020 to 2022", "between 2020 and 2022", "2020-2022", "in 2021",
// "since 2019", "3 years ago" -> a month window { fromYm, toYm }, or null.
// Parsed ONLY after a person-search intent already fired (answerPersonSearch
// below), so a bare year in an unrelated question can never hijack anything.
// Years are clamped to a sane band rather than trusted -- "in 1875" is a typo
// or a street address, not an era of the owner's life.
export function detectEraWindow(question, { now = Date.now() } = {}) {
  const q = String(question ?? '').toLowerCase();
  const d = new Date(now);
  const thisYear = d.getFullYear();
  const nowYm = `${thisYear}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const yr = (y) => Math.min(Math.max(Number(y), 1990), thisYear + 1);
  let m = q.match(/\b(?:from|between)?\s*((?:19|20)\d{2})\s*(?:-|\u2013|\u2014|to|and|until|through)\s*((?:19|20)\d{2})\b/u);
  if (m) {
    const a = yr(m[1]);
    const b = yr(m[2]);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return { fromYm: `${lo}-01`, toYm: `${hi}-12` };
  }
  m = q.match(/\bsince\s+((?:19|20)\d{2})\b/u);
  if (m) return { fromYm: `${yr(m[1])}-01`, toYm: nowYm };
  m = q.match(/\b(?:in|from|back in|during|around)\s+((?:19|20)\d{2})\b/u);
  if (m) {
    const y = yr(m[1]);
    return { fromYm: `${y}-01`, toYm: `${y}-12` };
  }
  m = q.match(/\b(\d{1,2})\s*years?\s+(?:ago|back)\b/u);
  if (m) {
    const y = thisYear - Number(m[1]);
    return { fromYm: `${y}-01`, toYm: `${y}-12` };
  }
  return null;
}

// A generic "reconnect with real people" need: depth-ranked, reachable, in a
// wide dormancy band — for "who have I lost touch with" with no role or topic.
const RECONNECT_NEED = Object.freeze({
  label: 'people worth reconnecting with',
  requireReachable: true,
  dormancyBandDays: [90, 1825],
  weights: { depth: 1.5, seniority: 0.5, dormancyBand: 2 },
  minDepth: 3,
});

// question -> { need } when this is a person-search, else null. The trigger is
// a NEED word; "who" alone is not enough (it would swallow episodic stat
// questions).
export function detectPersonSearch(question) {
  const q = String(question ?? '').toLowerCase();
  const investor = /\b(investor|investors|\bvc\b|\bvcs\b|angel|angels|fundrais\w*|raising|raise money|check size|back my|backed me)\b/u.test(q);
  const mentor = /\b(mentor|mentors|advisor|advisors|advice from|guidance)\b/u.test(q);
  const reconnect = /\b(reconnect|lost touch|fallen out of touch|reach out to|reach back|who should i|who have i dropped|dropped the ball|introduce me|intro me|who do i know)\b/u.test(q);
  // investor/mentor are ROLES — a person by definition — so they need no
  // extra "people" word ("which vcs did i pitch" is a person-search). Only
  // the generic reconnect case needs the people guard, so "reconnect the
  // wifi" does not fire.
  if (investor) return { need: INVESTOR_NEED, kind: 'investor' };
  if (mentor) return { need: MENTOR_NEED, kind: 'mentor' };
  const aboutPeople = /\b(who|people|person|someone|contacts?|folks)\b/u.test(q);
  if (reconnect && aboutPeople) return { need: RECONNECT_NEED, kind: 'reconnect' };
  return null;
}

// Format one candidate as a chat line: name, the one-line evidence, and a
// compact reason tag. Deterministic, grounded, no model.
//
// The WHEN clause is the memory jog (profile.mjs eraLine): "peak 2018–2019
// (340 messages) — went quiet Mar 2020 — they wrote last, unanswered". For a
// years-old contact, "last heard ~4.2y ago" alone jogs nothing — the peak era
// is the memory. The bare dormancy clause survives only as the fallback for a
// person with no message timeline (calendar-only tie).
function formatCandidate(p, i, now) {
  const title = p.linkedin?.position
    ? ` — ${p.linkedin.position}${p.linkedin.company ? ' @ ' + p.linkedin.company : ''}`
    : '';
  const era = eraLine(p, { now });
  const when = era
    ? ` — ${era}`
    : p.dormancyDays === null
      ? ''
      : p.dormancyDays > 365
        ? `, last heard ~${(p.dormancyDays / 365).toFixed(1)}y ago`
        : `, last heard ~${Math.round(p.dormancyDays / 30)}mo ago`;
  const topic =
    p.content?.investor > 0 ? `, ${p.content.investor} threads on raising` : '';
  return `${i + 1}. ${p.name}${title}${when}${topic}`;
}

// '2020-01'..'2022-12' -> "2020–2022"; a single year stays "2021".
function eraSpanNote(era) {
  const fy = era.fromYm.slice(0, 4);
  const ty = era.toYm.slice(0, 4);
  return fy === ty ? fy : `${fy}–${ty}`;
}

// The one call the ask route uses. Returns { text, sources, count } or null
// when the question is not a person-search (caller falls through).
export function answerPersonSearch(
  contextDb,
  stateDb,
  question,
  { owner, aliases = null, now = Date.now(), limit = 50 } = {}
) {
  const deep = answerDeepPeopleSearch(contextDb, stateDb, question, {
    owner, aliases, now, limit: Math.min(limit, 10),
  });
  if (deep !== null) return deep;

  // Warm-intro is checked first: it already names a target and wants the path
  // to them, which is a different question from "who fits a need".
  const introTarget = detectIntro(question);
  if (introTarget !== null) {
    const graph = materializedPeopleGraph(contextDb, stateDb, { now, owner, aliases, contentSignals: CONTENT_SIGNALS });
    const res = warmIntro(contextDb, graph, introTarget, { owner, limit });
    if (!res.found) return { text: res.reason, sources: [], count: 0 };
    if (res.alreadyWarm) {
      return { text: `you already know ${res.target} directly — ${res.detail}. no intro needed.`, sources: [], count: 0 };
    }
    if (res.bridges.length === 0) {
      return { text: `no warm path to ${res.target} in your data — nobody you know has shared a thread or meeting with them (that you were also on).`, sources: [], count: 0 };
    }
    const lines = res.bridges.map((b, i) => {
      const via = b.via.replace('mail', 'email');
      return `${i + 1}. ${b.name} — ${b.sharedRooms} shared ${via}, last ${b.lastShared}`;
    });
    return {
      text: `warm paths to ${res.target} — ask whichever you're closest to:\n${lines.join('\n')}`,
      sources: ['calendar', 'mail'],
      count: res.bridges.length,
      evidence: res.bridges,
    };
  }

  const intent = detectPersonSearch(question);
  if (intent === null) return null;

  // An explicit era ("investors from 2020 to 2022", "mentors back in 2019")
  // narrows any need to the people active in that window — and REPLACES the
  // need's recency shaping (dormancy band), because "who, from back then" and
  // "who, recently quiet" are different questions and the owner just asked
  // the first one.
  const era = detectEraWindow(question, { now });
  const need = era
    ? { ...intent.need, activeWindow: [era.fromYm, era.toYm], dormancyBandDays: null }
    : intent.need;
  const eraNote = era ? ` (${eraSpanNote(era)})` : '';

  const graph = materializedPeopleGraph(contextDb, stateDb, {
    now,
    owner,
    aliases,
    contentSignals: need.contentSignal ? CONTENT_SIGNALS : null,
  });
  const ranked = rankForNeed(graph, need, { limit });

  if (ranked.length === 0) {
    return { text: `nothing in your connections fits "${need.label}${eraNote}" yet.`, sources: [], count: 0 };
  }

  const sources = [...new Set(ranked.flatMap((p) => p.channels))].sort();

  // Investors are grouped by FIRM and ranked by WARMTH — "Character VC (4
  // contacts, warm, met 9×)" reads the way a raise actually thinks. Other
  // needs stay a flat person list.
  if (intent.kind === 'investor') {
    const firms = groupByFirm(ranked);
    const header = `investors you've talked to${eraNote} — ${firms.length} firms, ${ranked.length} people, warmest first:`;
    const lines = firms.map((f, i) => {
      const warm = warmthLabel(f.warmth);
      const names = f.contacts.map((c) => c.name.includes('@') ? c.name.split('@')[0] : c.name).slice(0, 5).join(', ');
      const met = f.metInPerson > 0 ? `, met ${f.metInPerson}×` : '';
      const last =
        f.minDormancy === null
          ? ''
          : f.minDormancy > 365
            ? `, last ~${(f.minDormancy / 365).toFixed(1)}y ago`
            : `, last ~${Math.round(f.minDormancy / 30)}mo ago`;
      const count = f.contacts.length > 1 ? ` (${f.contacts.length})` : '';
      return `${i + 1}. ${f.label}${count} — ${warm}${met}${last} — ${names}`;
    });
    return {
      text: `${header}\n${lines.join('\n')}`,
      sources,
      count: firms.length,
      evidence: firms.map((f) => ({ firm: f.label, warmth: Math.round(f.warmth * 10) / 10, contacts: f.contacts.map((c) => ({ name: c.name, line: evidenceLine(c) })) })),
    };
  }

  const header = `${need.label}${eraNote}, from your ${graph.length} connections:`;
  const lines = ranked.map((p, i) => formatCandidate(p, i, now));
  return {
    text: `${header}\n${lines.join('\n')}`,
    sources,
    count: ranked.length,
    evidence: ranked.map((p) => ({
      name: p.name,
      line: evidenceLine(p),
      reasons: p.reasons,
      era: eraLine(p, { now }),
    })),
  };
}
