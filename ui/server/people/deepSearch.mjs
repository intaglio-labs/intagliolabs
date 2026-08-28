// Compound, evidence-backed people search for questions whose answer depends
// on several facts at once. The existing search.mjs answers one declared need
// (investor, mentor, reconnect); this module handles intersections such as
// role + meeting + place + time and affiliation + current industry.
//
// Selection is code. Corpus text is inspected locally for a small set of
// high-precision evidence patterns, but no text is returned and no model picks
// a person. The answer contains names, dates, and derived reasons only.

import { buildGraph, CONTENT_SIGNALS, normIdentifier } from './graph.mjs';
import { depthScore, investorIdentity, isNonPerson, reachable } from './rank.mjs';
import { rowPersonId } from './content.mjs';

const DAY = 86_400_000;

const PLACE_ALIASES = Object.freeze({
  'los angeles': Object.freeze({ label: 'Los Angeles', evidence: /\b(?:los angeles|la,?\s+ca(?:lifornia)?)\b/iu }),
  italy: Object.freeze({ label: 'Italy', evidence: /\bital(?:y|ia|ian)\b/iu }),
});
const NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
});

function norm(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function parseMeta(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const value = JSON.parse(raw ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function yearWindow(yearsAgo, now) {
  const target = new Date(now);
  target.setFullYear(target.getFullYear() - yearsAgo);
  // "About" is deliberately fuzzy but bounded: nine months on either side of
  // the anniversary. It catches an imperfect human date without swallowing a
  // three-year era.
  const spread = Math.round(365.25 * 0.75 * DAY);
  return { from: target.getTime() - spread, to: target.getTime() + spread };
}

export function detectDeepPeopleQuery(question, { now = Date.now() } = {}) {
  const q = String(question ?? '').trim();
  const lower = q.toLowerCase();
  const investor = /\b(investors?|\bvcs?\b|angels?)\b/iu.test(lower);
  const meeting = /\b(met|meet|meeting|saw|connected with)\b/iu.test(lower);
  const losAngeles = /\b(?:los angeles|la(?:,?\s+ca(?:lifornia)?)?)\b/iu.test(lower);
  if (investor && meeting && losAngeles) {
    const ago = lower.match(/\b(?:about|around|roughly|approximately)?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+years?\s+ago\b/iu);
    const yearsAgo = ago ? (NUMBER_WORDS[ago[1]] ?? Number(ago[1])) : null;
    return {
      kind: 'investor_place_time',
      place: 'los angeles',
      ...(yearsAgo !== null ? { yearsAgo, window: yearWindow(yearsAgo, now) } : {}),
    };
  }
  if (/\b(?:my|our)\s+high school\b/iu.test(lower) && /\b(?:work|works|working|job|career|employed)\b/iu.test(lower)
      && /\btech(?:nology)?\b/iu.test(lower)) {
    return { kind: 'school_tech' };
  }
  if (PLACE_ALIASES.italy.evidence.test(lower)
      && /\b(?:down for|up for|interested in|want(?:s|ed)? to|would|might|travel|trip)\b/iu.test(lower)
      && /\b(?:who|anyone|people|friends?|contacts?)\b/iu.test(lower)) {
    return { kind: 'travel_interest', place: 'italy' };
  }
  return null;
}

function personIndex(graph) {
  const exact = new Map();
  const loose = new Map();
  const byName = new Map();
  for (const person of graph) {
    byName.set(norm(person.name), person.key);
    for (const id of person.identifiers ?? []) {
      exact.set(String(id).toLowerCase(), person.key);
      const normalized = normIdentifier(id);
      if (normalized) loose.set(normalized, person.key);
    }
  }
  return {
    keyFor(id) {
      if (typeof id !== 'string' || id.length === 0) return null;
      return exact.get(id.toLowerCase()) ?? loose.get(normIdentifier(id)) ?? null;
    },
    keyForName(name) {
      return byName.get(norm(name)) ?? null;
    },
  };
}

function rowPersonKeys(row, meta, index, owner) {
  const out = new Set();
  const add = (id, name = null) => {
    const key = index.keyFor(id) ?? index.keyForName(name);
    if (key) out.add(key);
  };
  if (row.source === 'calendar') {
    for (const attendee of meta.attendees ?? []) add(attendee?.email, attendee?.name);
    const organizer = meta.organizer;
    add(typeof organizer === 'string' ? organizer : organizer?.email,
      typeof organizer === 'string' ? null : organizer?.name);
    return out;
  }
  if (row.source === 'linkedin' && meta.kind === 'connection') {
    add(`linkedin:${String(row.entity_id ?? '').split(':').pop()}`, meta.name);
    if (meta.email) add(meta.email, meta.name);
    return out;
  }
  if (row.source === 'mail') {
    for (const id of [...(meta.from ?? []), ...(meta.to ?? []), ...(meta.cc ?? [])]) {
      if (!owner?.addresses?.has?.(String(id).toLowerCase())) add(String(id).toLowerCase());
    }
    return out;
  }
  const id = rowPersonId(row, meta);
  add(id, row.speaker);
  return out;
}

function incomingPersonKey(row, meta, index, owner) {
  if (row.source === 'mail') {
    const from = Array.isArray(meta.from) ? meta.from[0] : null;
    if (!from || owner?.addresses?.has?.(String(from).toLowerCase())) return null;
    return index.keyFor(String(from).toLowerCase());
  }
  if (row.source === 'linkedin' && meta.kind === 'message') {
    const from = meta.from;
    if (!from || (owner?.names ?? []).some((name) => norm(name) === norm(from))) return null;
    return index.keyForName(from) ?? index.keyFor(`liname:${norm(from)}`);
  }
  if (row.source === 'calendar' || (row.source === 'linkedin' && meta.kind === 'connection')) return null;
  if (meta.is_from_me === true || meta.is_from_me === 1) return null;
  return index.keyFor(rowPersonId(row, meta)) ?? index.keyForName(row.speaker);
}

function corpusRows(contextDb) {
  return contextDb.prepare(
    "SELECT id, ts, source, speaker, text, meta, entity_id FROM context " +
      "WHERE source IN ('imessage','whatsapp','messenger','instagram','twitter'," +
      "'telegram','discord','slack','mail','calendar','linkedin')"
  ).all();
}

function locationText(meta, row) {
  const structured = meta.structured_location ?? meta.structuredLocation ?? {};
  return [
    meta.location,
    meta.location_name,
    structured.formattedAddress,
    structured.title,
    structured.address,
    // Older calendar rows may only carry a location in their canonical text.
    row.text,
  ].filter((value) => typeof value === 'string').join(' ');
}

function isPhysicalMeeting(meta, row) {
  if (meta.is_virtual === true || meta.virtual === true || meta.conference) return false;
  const hay = `${meta.location ?? ''} ${row.text ?? ''}`;
  return !/\b(?:zoom|google meet|hangouts?|teams meeting|webex|facetime)\b|https?:\/\//iu.test(hay);
}

function formatMonth(ts) {
  return new Date(Number(ts)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function warmth(person) {
  return depthScore(person) + Math.min(3, (person.channelCount ?? 0) * 0.5);
}

function investorPlaceTime(rows, graph, index, query, { limit }) {
  const place = PLACE_ALIASES[query.place];
  const meetings = new Map();
  for (const row of rows) {
    if (row.source !== 'calendar') continue;
    const ts = Number(row.ts);
    if (!Number.isFinite(ts)) continue;
    if (query.window && (ts < query.window.from || ts > query.window.to)) continue;
    const meta = parseMeta(row.meta);
    if (!isPhysicalMeeting(meta, row) || !place.evidence.test(locationText(meta, row))) continue;
    for (const key of rowPersonKeys(row, meta, index, {})) {
      const prior = meetings.get(key);
      if (!prior || Math.abs(ts - (query.window?.from + query.window?.to) / 2) < prior.distance) {
        meetings.set(key, {
          ts,
          source: row.source,
          distance: query.window ? Math.abs(ts - (query.window.from + query.window.to) / 2) : 0,
        });
      }
    }
  }
  const matches = graph
    .filter((person) => !isNonPerson(person) && meetings.has(person.key))
    .filter((person) => investorIdentity(person) > 0 || (person.content?.investor ?? 0) > 0)
    .map((person) => ({ person, meeting: meetings.get(person.key), score: investorIdentity(person) * 10 + warmth(person) }))
    .sort((a, b) => b.score - a.score || String(a.person.name).localeCompare(String(b.person.name)))
    .slice(0, limit);
  const timeNote = query.yearsAgo === undefined ? '' : ` about ${query.yearsAgo} years ago`;
  if (matches.length === 0) {
    return { text: `I couldn't find an investor you met in ${place.label}${timeNote} in your data.`, sources: [], count: 0 };
  }
  const lines = matches.map(({ person, meeting }, i) => {
    const title = person.linkedin?.position
      ? ` — ${person.linkedin.position}${person.linkedin.company ? ` at ${person.linkedin.company}` : ''}`
      : '';
    return `${i + 1}. ${person.name}${title} — met in ${place.label} in ${formatMonth(meeting.ts)}`;
  });
  return {
    text: `investors you met in ${place.label}${timeNote}:\n${lines.join('\n')}`,
    sources: ['calendar', ...new Set(matches.flatMap(({ person }) => person.channels))].sort(),
    count: matches.length,
  };
}

function educationValues(meta) {
  const out = [];
  for (const value of [meta.high_school, meta.highSchool, meta.school]) {
    if (typeof value === 'string') out.push(value);
  }
  for (const value of [...(Array.isArray(meta.schools) ? meta.schools : []), ...(Array.isArray(meta.education) ? meta.education : [])]) {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') {
      for (const field of [value.school, value.name, value.institution]) if (typeof field === 'string') out.push(field);
    }
  }
  return out;
}

function sameSchoolEvidence(rows, index, schools, owner) {
  const found = new Map();
  const schoolNorms = schools.map((school) => ({ label: school, key: norm(school) })).filter((school) => school.key);
  for (const row of rows) {
    const meta = parseMeta(row.meta);
    const keys = rowPersonKeys(row, meta, index, owner);
    if (keys.size === 0) continue;
    for (const school of schoolNorms) {
      const structured = educationValues(meta).some((value) => norm(value) === school.key);
      // Prose is accepted only when an affiliation phrase and the exact school
      // occur together. A bare mention of a school is not attendance evidence.
      const text = norm(row.text);
      const prose = text.includes(school.key)
        && /\b(?:went to|attended|graduated from|class of|alum(?:ni|nus|na)? of|we were at|from)\b/iu.test(row.text ?? '');
      if (!structured && !prose) continue;
      for (const key of keys) {
        const prior = found.get(key);
        const confidence = structured ? 1 : 0.8;
        if (!prior || confidence > prior.confidence) found.set(key, { school: school.label, confidence, source: row.source });
      }
    }
  }
  return found;
}

function techEmployment(person) {
  const linkedin = person.linkedin ?? {};
  const role = `${linkedin.position ?? ''} ${linkedin.industry ?? ''}`;
  const company = String(linkedin.company ?? '');
  const roleMatch = /\b(?:software|engineer(?:ing)?|developer|product manager|data scientist|machine learning|artificial intelligence|\bai\b|cybersecurity|devops|cloud|information technology|\bit\b|cto|chief technology|technical)\b/iu.test(role);
  const companyMatch = /\b(?:software|technolog(?:y|ies)|systems|digital|cloud|\bai\b|labs)\b/iu.test(company)
    || /\b(?:software|technology|internet|computer|semiconductor|information technology)\b/iu.test(linkedin.industry ?? '');
  return roleMatch || companyMatch;
}

function schoolTech(rows, graph, index, owner, { limit }) {
  const schools = [...new Set([...(owner?.highSchools ?? []), ...(owner?.schools ?? [])].filter((s) => typeof s === 'string' && s.trim()))];
  if (schools.length === 0) {
    return { text: `I don't know which high school is yours yet. Add it to your local owner profile, then ask again.`, sources: [], count: 0 };
  }
  const schoolByPerson = sameSchoolEvidence(rows, index, schools, owner);
  const matches = graph
    .filter((person) => !isNonPerson(person) && schoolByPerson.has(person.key) && techEmployment(person))
    .map((person) => ({ person, school: schoolByPerson.get(person.key), score: schoolByPerson.get(person.key).confidence * 10 + warmth(person) }))
    .sort((a, b) => b.score - a.score || String(a.person.name).localeCompare(String(b.person.name)))
    .slice(0, limit);
  if (matches.length === 0) {
    return { text: `I couldn't find anyone from ${schools[0]} with a current tech role in your data.`, sources: [], count: 0 };
  }
  const lines = matches.map(({ person, school }, i) =>
    `${i + 1}. ${person.name} — ${person.linkedin.position}${person.linkedin.company ? ` at ${person.linkedin.company}` : ''}; ${school.school}`
  );
  return {
    text: `people from your high school who work in tech:\n${lines.join('\n')}`,
    sources: [...new Set(matches.flatMap(({ person, school }) => [school.source, ...person.channels]))].sort(),
    count: matches.length,
  };
}

const ITALY_POSITIVE = /\b(?:i(?:'d| would)?\s+(?:love|like|want)\s+to\s+(?:go|travel|visit)|i(?:'m| am)\s+(?:down|up)\s+for|count me in(?:\s+for)?|let'?s\s+(?:go|do)|sounds?\s+(?:amazing|great|fun)|would be (?:amazing|great|fun)|definitely\s+(?:go|interested)|interested in (?:going|traveling|a trip))\b[^.!?\n]{0,80}\bital(?:y|ia)\b|\bital(?:y|ia)\b[^.!?\n]{0,80}\b(?:count me in|i(?:'m| am)\s+(?:down|interested)|sounds?\s+(?:amazing|great|fun)|let'?s do it)\b/iu;
const ITALY_NEGATIVE = /\b(?:can(?:not|'t)|won't|wouldn't|not interested|no way|hate|avoid|skip)\b[^.!?\n]{0,80}\bital(?:y|ia)\b|\bital(?:y|ia)\b[^.!?\n]{0,80}\b(?:can(?:not|'t)|won't|not interested|no way|is out)\b/iu;

function travelInterest(rows, graph, index, owner, query, { now, limit }) {
  const evidence = new Map();
  for (const row of rows) {
    if (!PLACE_ALIASES[query.place].evidence.test(row.text ?? '')) continue;
    const meta = parseMeta(row.meta);
    const key = incomingPersonKey(row, meta, index, owner);
    if (!key) continue;
    const positive = ITALY_POSITIVE.test(row.text ?? '');
    const negative = ITALY_NEGATIVE.test(row.text ?? '');
    if (!positive && !negative) continue;
    const item = evidence.get(key) ?? { positive: null, negative: null, source: row.source };
    const ts = Number(row.ts);
    if (positive && (!item.positive || ts > item.positive)) item.positive = ts;
    if (negative && (!item.negative || ts > item.negative)) item.negative = ts;
    item.source = row.source;
    evidence.set(key, item);
  }
  const matches = graph
    .filter((person) => !isNonPerson(person) && reachable(person))
    .filter((person) => {
      const item = evidence.get(person.key);
      return item?.positive && (!item.negative || item.positive > item.negative);
    })
    .map((person) => {
      const item = evidence.get(person.key);
      const ageDays = Math.max(0, (now - item.positive) / DAY);
      return { person, item, score: warmth(person) + Math.max(0, 8 - Math.log2(ageDays + 1)) };
    })
    .sort((a, b) => b.score - a.score || String(a.person.name).localeCompare(String(b.person.name)))
    .slice(0, limit);
  if (matches.length === 0) {
    return { text: `I couldn't find anyone who explicitly sounded interested in Italy in your data.`, sources: [], count: 0 };
  }
  const lines = matches.map(({ person, item }, i) =>
    `${i + 1}. ${person.name} — likely interested; expressed enthusiasm in ${formatMonth(item.positive)}`
  );
  return {
    text: `people who may be down for Italy — based on what they said, not a commitment:\n${lines.join('\n')}`,
    sources: [...new Set(matches.map(({ item }) => item.source))].sort(),
    count: matches.length,
  };
}

export function answerDeepPeopleSearch(
  contextDb,
  stateDb,
  question,
  { owner = { addresses: new Set(), names: [], keys: new Set(), schools: [], highSchools: [] }, now = Date.now(), limit = 10 } = {}
) {
  const query = detectDeepPeopleQuery(question, { now });
  if (query === null) return null;
  const graph = buildGraph(contextDb, stateDb, { now, owner, contentSignals: CONTENT_SIGNALS });
  const index = personIndex(graph);
  const rows = corpusRows(contextDb);
  if (query.kind === 'investor_place_time') return investorPlaceTime(rows, graph, index, query, { limit });
  if (query.kind === 'school_tech') return schoolTech(rows, graph, index, owner, { limit });
  if (query.kind === 'travel_interest') return travelInterest(rows, graph, index, owner, query, { now, limit });
  return null;
}
