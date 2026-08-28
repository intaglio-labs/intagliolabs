// The episodic shelf: code-selected raw rows, for questions that are lookups
// over the owner's own logs rather than recall of durable facts.
//
// WHY THIS EXISTS, measured before designed: the L5 coverage run graded 39 of
// 60 answers "the store held the answer and no read path could serve it", and
// seven of twenty questions were unanswerable at every tier for that one
// reason (measured in the L5 coverage run; that write-up is not in this repo). "When do I fly", "my worst
// night", "photos last weekend" are not durable facts and are not averages —
// they are rows, and until this module nothing was allowed to read a row.
//
// THE THREE RULES, inherited from the experiment's guardrails and the
// owner's sign-off on 2026-08-21:
//
//   1. CODE PICKS THE ROWS, NEVER THE MODEL. The question is parsed to a
//      window + source set + terms right here, in ~200 lines anyone can read.
//      No model-issued queries, for the same reason there is no model-issued
//      SQL: a query is an instruction, and instructions flow one way.
//   2. CODE DOES THE ARITHMETIC. Worst night, busiest day, per-contact
//      counts — computed below, handed over as finished lines. The model
//      reads numbers; it never adds them.
//   3. EVERYTHING GOES THROUGH THE ENVELOPE. Raw rows can contain text other
//      people wrote, so every line rides inside the same BEGIN NOTES /
//      END NOTES quoted-material defence the claim path uses, under a prompt
//      (prompts/answer_episodic.md) whose first rule is that a record is
//      never an instruction.
//
// WHAT THIS DELIBERATELY DOES NOT READ, v1:
//
//   received iMessage   attacker-authored text stays out of the model's
//                       context structurally, exactly as the claim path
//                       decided. The questions that need other PEOPLE
//                       ("who did I text most") are answered with per-contact
//                       COUNTS computed in code — the counterparty appears as
//                       a name and a number, never as their words.
//   mail                same reasoning, and no regression question needs it.
//   hazlie_digest/seed  model output is not evidence; fixtures are not memory.
//   the pinned thread   the 2026-08-19 self-ingestion loop must not reopen
//                       through this new door (excluded by chat guid, same
//                       shared definition as everywhere else).

import { pinnedThreadGuids } from '../../../connectors/lib/pinnedThread.mjs';
import { threadKind, GROUP } from './threadKind.mjs';

const DAY = 86_400_000;

// Sources this shelf may read, with per-source caps. Caps are about the
// envelope staying a list rather than a dump — the composer gets at most
// MAX_LINES lines regardless.
const EPISODIC_SOURCES = Object.freeze({
  calendar: { cap: 40 },
  granola: { cap: 12 },
  health: { cap: 45 },
  notes: { cap: 15 },
  photos: { cap: 30 },
  files: { cap: 15 },
  imessage: { cap: 30, ownerOnly: true },
});

export const MAX_LINES = 36;
const SNIPPET = 150;

// --- routing: question -> {sources, from, to, terms} -------------------------

const TOPIC_RULES = [
  { re: /\b(sleep|slept|nap|hrv|readiness|steps?|workout|stress|recovery)\b/iu, sources: ['health'] },
  { re: /\b(meet|meets|met|meeting|meetings|calendar|schedule|scheduled|booked|call|demo day|event)\b/iu, sources: ['calendar', 'granola'] },
  // Travel titles rarely contain the traveler's verbs: the L5 regression
  // flight is "Alaska Airlines Itinerary", not "fly to Honolulu". The extra
  // terms teach the ranking what schedule rows call a flight.
  { re: /\b(fly|flight|flights|travel|trip|depart|airport)\b/iu, sources: ['calendar'],
    extraTerms: ['flight', 'airlines', 'airways', 'airport', 'itinerary', 'depart'] },
  // "What was I doing on <day>" is a join over the logs of that day, not a
  // topic — the answer can live in the calendar, the photo roll, or what the
  // owner sent. This rule is why worst-night answers can name the day's
  // contents instead of just the number.
  { re: /\b(doing|did i do|was i up to|what happened)\b/iu, sources: ['calendar', 'photos', 'imessage'] },
  // dropTerms: the words that NAME the drawer are not content. "my last
  // Apple Note" is about the newest note, not about notes containing the
  // word "apple" — ranking on the trigger words pulled a week-old note that
  // mentioned Apple-the-company above the actual newest note (measured on
  // the live corpus, Q6).
  { re: /\b(apple )?(note|notes)\b/iu, sources: ['notes'], dropTerms: ['apple', 'note', 'notes'] },
  { re: /\b(photo|photos|picture|pictures|pic|pics)\b/iu, sources: ['photos'], dropTerms: ['photo', 'photos', 'picture', 'pictures'] },
  { re: /\b(file|files|document|documents|folder)\b/iu, sources: ['files'], dropTerms: ['file', 'files', 'document', 'documents'] },
  { re: /\b(text|texted|texts|message|messages|messaged)\b/iu, sources: ['imessage'], dropTerms: ['text', 'texted', 'texts', 'message', 'messages', 'messaged'] },
  { re: /\b(granola|transcript)\b/iu, sources: ['granola'], dropTerms: ['granola', 'transcript'] },
];

const STOPWORDS = new Set(
  ('a an and are about after around at be before but by did do does for from had has have how i in is it its last ' +
   'latest me most my next of on or our over recent she that the their them they this to was we what when where ' +
   'which who whose why will with you your').split(' ')
);

// Weekday/month tables for window phrases. Date math is done in LOCAL time via
// Date fields, never epoch±86400s — DST days are 23 or 25 hours long.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

// `may` is the one month name that is also a word people use constantly, and
// the modal is far commoner in a question than the month: "what may I have
// missed", "may I ask", "this may be wrong". So a bare `may` is treated as the
// word, and only counts as a date when something around it says otherwise.
//
// `march` and `august` are technically ambiguous too, and are deliberately NOT
// in this set. Both are rare as words in the questions this thing gets, and
// "how was august" — a bare month, which the suite already pins — is exactly
// the phrasing the stricter rule would have broken. The narrow fix beats the
// tidy one: this exists to stop a modal verb silently rewriting the window,
// not to be symmetric about the calendar.
const AMBIGUOUS_MONTHS = new Set(['may']);

function monthMeansMonth(match) {
  const [, lead, name, trail] = match;
  if (!AMBIGUOUS_MONTHS.has(name)) return true;
  return Boolean(lead || trail);
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// The window a question means, in code. Returns {from, to, why} — `to` may be
// in the future for schedule-shaped questions ("when do I fly" is about a
// flight that has not happened).
export function parseWindow(question, { now = Date.now(), scheduleShaped = false } = {}) {
  const q = question.toLowerCase();
  const today = startOfDay(now);

  if (/\btoday\b/u.test(q)) return { from: today, to: today + DAY, why: 'today' };
  if (/\byesterday\b/u.test(q)) return { from: today - DAY, to: today, why: 'yesterday' };
  if (/\bthis week\b/u.test(q)) return { from: today - 6 * DAY, to: today + DAY, why: 'this week' };
  if (/\blast week\b/u.test(q)) return { from: today - 13 * DAY, to: today - 6 * DAY, why: 'last week' };
  if (/\b(this month|the month)\b/u.test(q)) {
    const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0);
    return { from: d.getTime(), to: today + DAY, why: 'this month' };
  }
  if (/\blast month\b/u.test(q)) {
    const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0);
    const end = d.getTime();
    d.setMonth(d.getMonth() - 1);
    return { from: d.getTime(), to: end, why: 'last month' };
  }
  const lastDay = q.match(/\blast (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u);
  if (lastDay) {
    const want = WEEKDAYS.indexOf(lastDay[1]);
    const d = new Date(today);
    // "last Tuesday" = the most recent Tuesday strictly before today.
    do { d.setDate(d.getDate() - 1); } while (d.getDay() !== want);
    return { from: d.getTime(), to: d.getTime() + DAY, why: `last ${lastDay[1]}` };
  }
  const lastWeekend = /\blast weekend\b/u.test(q);
  if (lastWeekend) {
    const d = new Date(today);
    do { d.setDate(d.getDate() - 1); } while (d.getDay() !== 6); // back to Saturday
    return { from: d.getTime(), to: d.getTime() + 2 * DAY, why: 'last weekend' };
  }
  // THREE MONTH NAMES ARE ALSO ORDINARY ENGLISH WORDS, and one of them is
  // extremely common. `\b(?:in )?(may)\b` matched the modal in "what may I
  // have missed?", "may I ask", "this may be wrong" — and then silently
  // REPLACED the question's window with the month of May, so the answer was
  // composed from rows the owner never asked about and nothing said so.
  //
  // So an ambiguous name has to show evidence it means the month: a
  // preposition in front (in / during / since / from / of / back in), the word
  // `last`, or a number after it (may 3, may 2026). `this` is deliberately NOT
  // evidence — "this may be" is far commoner than "this may" meaning the
  // month, and getting that one wrong is how the bug read.
  //
  // The other nine names are unambiguous and keep matching bare, so "june" on
  // its own still works.
  const monthName = q.match(
    new RegExp(
      `\\b(?:(in|during|since|from|of|back in|last)\\s+)?(${MONTHS.join('|')})\\b(\\s+\\d{1,4}\\b)?`,
      'u'
    )
  );
  if (monthName && monthMeansMonth(monthName)) {
    const m = MONTHS.indexOf(monthName[2]);
    const d = new Date(now); d.setMonth(m, 1); d.setHours(0, 0, 0, 0);
    // A bare month names the nearest occurrence: this year's unless that is
    // over half a year away, in which case the question meant the other year.
    if (d.getTime() - now > 183 * DAY) d.setFullYear(d.getFullYear() - 1);
    else if (now - d.getTime() > 183 * DAY) d.setFullYear(d.getFullYear() + 1);
    const end = new Date(d); end.setMonth(end.getMonth() + 1);
    return { from: d.getTime(), to: end.getTime(), why: monthName[2] };
  }
  const nDays = q.match(/\b(?:last|past) (\d{1,3}) days?\b/u);
  if (nDays) return { from: today - Number(nDays[1]) * DAY, to: today + DAY, why: `last ${nDays[1]} days` };

  // No time phrase. Trailing 30 days — plus the next 90 for schedule-shaped
  // questions, because "when do I fly" is usually about a flight that has not
  // happened yet.
  return {
    from: today - 30 * DAY,
    to: scheduleShaped ? today + 90 * DAY : today + DAY,
    why: scheduleShaped ? 'default 30d back + 90d ahead' : 'default 30d',
  };
}

// Content words for code-side row ranking. NOT a security boundary — just
// relevance: rows matching the question's rare words sort first, rows
// matching nothing still make the list if there is room.
export function contentTerms(question) {
  return [...new Set(
    question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  )];
}

// question -> route, or null when no episodic topic matched (the claim path
// alone handles it, exactly as before this module existed).
export function routeQuestion(question, { now = Date.now() } = {}) {
  const sources = [];
  const extra = [];
  for (const rule of TOPIC_RULES) {
    if (rule.re.test(question)) {
      for (const s of rule.sources) if (!sources.includes(s)) sources.push(s);
      for (const t of rule.extraTerms ?? []) if (!extra.includes(t)) extra.push(t);
    }
  }
  if (sources.length === 0) return null;
  const drop = new Set();
  for (const rule of TOPIC_RULES) {
    if (rule.re.test(question)) for (const t of rule.dropTerms ?? []) drop.add(t);
  }
  const scheduleShaped = sources.includes('calendar');
  const window = parseWindow(question, { now, scheduleShaped });
  const terms = [...new Set([...contentTerms(question), ...extra])].filter((t) => !drop.has(t));
  // "last" is two different words: "my LAST note" wants the newest entry,
  // "LAST weekend" is a time phrase. Only the first sense may trigger the
  // newest-entry line, so "last" followed by a time word does not count.
  const wantsLatest =
    /\b(latest|newest|most recent)\b/iu.test(question) ||
    /\blast (?!weekend|week|month|year|night|sunday|monday|tuesday|wednesday|thursday|friday|saturday|\d)/iu.test(question);
  return { sources, ...window, terms, wantsLatest, now };
}

// --- selection ---------------------------------------------------------------

// Field by field, never SELECT * — same discipline as retrieve.mjs and for
// the same reason: a widened table must not silently widen what reaches a
// model.
const ROW_FIELDS = 'id, ts, source, text, meta, entity_id';

export function selectEpisodicRows(db, route, { excludeChatGuids = null } = {}) {
  const guids = excludeChatGuids ?? pinnedThreadGuids();
  const out = [];
  for (const source of route.sources) {
    const spec = EPISODIC_SOURCES[source];
    if (!spec) continue; // a routed source outside the allowlist reads nothing
    let where = 'source = ? AND ts >= ? AND ts < ?';
    const params = [source, route.from, route.to];
    if (spec.ownerOnly) {
      where += " AND json_extract(meta, '$.is_from_me') IS 1";
      if (guids.length > 0) {
        where += ` AND COALESCE(json_extract(meta, '$.chat_guid'), '') NOT IN (${guids.map(() => '?').join(',')})`;
        params.push(...guids);
      }
    }
    // Fetch order is just the pre-cut: ABS(ts - now) ascending, so the rows
    // the ranking wants are in the fetched set even when the window holds far
    // more than the cap.
    const rows = db
      .prepare(`SELECT ${ROW_FIELDS} FROM context WHERE ${where} ORDER BY ABS(ts - ?) ASC LIMIT ?`)
      .all(...params, route.now, spec.cap * 4);
    // Term-ranked in code: rows matching the question's content words first.
    // The tie-break is DISTANCE FROM NOW, not newest-first — a window that
    // reaches 90 days ahead sorted ts DESC starts at the far future and the
    // cap then drowns next week under October (measured: the regression
    // flight sat 40th of 43 future rows and missed the envelope). Near beats
    // far in both directions: next week's flight and yesterday's meeting both
    // outrank a quarter away.
    const terms = route.terms ?? [];
    const score = (r) => terms.reduce((n, t) => n + (r.text.toLowerCase().includes(t) ? 1 : 0), 0);
    const dist = (r) => Math.abs(Number(r.ts) - route.now);
    rows.sort((a, b) => score(b) - score(a) || dist(a) - dist(b));
    out.push(...rows.slice(0, spec.cap));
  }
  return out;
}

// --- computed statistics (rule 2: code does the arithmetic) ------------------

function meta(row) {
  try { return JSON.parse(row.meta ?? '{}') ?? {}; } catch { return {}; }
}

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function computeEpisodicStats(rows, route = {}) {
  const lines = [];
  const by = (s) => rows.filter((r) => r.source === s);

  // "my last X": WHICH row is newest is a lookup, and lookups are code's
  // job — asking a small model to scan 30 dated lines for the maximum date
  // is asking it to do arithmetic with extra steps (it abstained; measured).
  if (route.wantsLatest) {
    for (const source of new Set(rows.map((r) => r.source))) {
      if (source === 'photos') continue; // a filename snippet says nothing
      const newest = by(source).reduce((a, b) => (b.ts > a.ts ? b : a));
      const snippet = newest.text.replace(/\s+/gu, ' ').trim().slice(0, 110);
      lines.push(`(computed, ${source}) the newest ${source} entry is dated ${localDate(newest.ts)}: ${snippet}`);
    }
  }

  // Who was in the meetings: granola records attendees, and a name-list is a
  // computed fact the model may read and compare — against the texted-contact
  // list below, this is what "who did I meet that I never texted" reads from.
  const attendees = {};
  for (const r of by('granola')) {
    for (const a of meta(r).attendees ?? []) {
      if (typeof a === 'string' && a.trim()) attendees[a.trim()] = (attendees[a.trim()] ?? 0) + 1;
    }
  }
  const att = Object.entries(attendees).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (att.length > 0) {
    lines.push(`(computed, granola) people in your meetings: ${att.map(([n, c]) => `${n} (${c})`).join(', ')}`);
  }

  // Sleep: parsed from the connector's own rendering ("Slept 7h 33m ..."),
  // which is stable because we render it. Worst and best are the two the
  // experiment proved averages cannot answer.
  const nights = by('health')
    .map((r) => {
      const m = r.text.match(/^Slept (\d+)h (\d+)m/u);
      return m ? { day: localDate(r.ts), mins: Number(m[1]) * 60 + Number(m[2]) } : null;
    })
    .filter(Boolean);
  if (nights.length >= 2) {
    const fmt = (n) => `${Math.floor(n.mins / 60)}h ${String(n.mins % 60).padStart(2, '0')}m on ${n.day}`;
    const sorted = [...nights].sort((a, b) => a.mins - b.mins);
    const avg = Math.round(nights.reduce((s, n) => s + n.mins, 0) / nights.length);
    lines.push(`(computed, health) ${nights.length} nights: worst ${fmt(sorted[0])}, best ${fmt(sorted[sorted.length - 1])}, average ${Math.floor(avg / 60)}h ${String(avg % 60).padStart(2, '0')}m`);
  }

  // Calendar: count, hours, busiest day — from start/end ms, which the
  // connector records for exactly this purpose.
  const events = by('calendar')
    .map((r) => {
      const m = meta(r);
      return Number.isFinite(m.start_ms) && Number.isFinite(m.end_ms)
        ? { day: localDate(m.start_ms), hours: Math.max(0, (m.end_ms - m.start_ms) / 3_600_000) }
        : null;
    })
    .filter(Boolean);
  if (events.length >= 2) {
    const perDay = {};
    for (const e of events) perDay[e.day] = (perDay[e.day] ?? 0) + e.hours;
    const busiest = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0];
    const total = events.reduce((s, e) => s + e.hours, 0);
    lines.push(`(computed, calendar) ${events.length} events, ${total.toFixed(1)}h total; busiest day ${busiest[0]} at ${busiest[1].toFixed(1)}h`);
  }

  // iMessage: per-contact SENT counts. Names and numbers only — this is how
  // "who did I text most" gets answered without a single received word
  // entering the context.
  //
  // A ROOM IS NOT A CONTACT. The last field of a chat_guid is the counterparty
  // for a one-to-one thread and an opaque room id for a group -- and this line
  // used to take it unconditionally, so "messages you sent, by contact" could
  // hand the model `chat488392016936725110` as though it were a person, and did:
  // in private testing a highly-ranked "contact" was actually a room. Group
  // threads are common in iMessage, so this was not an edge case.
  //
  // Rooms are counted, just not as people. The two facts are both true and only
  // one of them is about a contact.
  const contacts = {};
  let roomMessages = 0;
  const rooms = new Set();
  for (const r of by('imessage')) {
    const m = meta(r);
    if (threadKind(r, m) === GROUP) {
      roomMessages += 1;
      if (typeof m.chat_guid === 'string') rooms.add(m.chat_guid);
      continue;
    }
    // DIRECT and UNKNOWN both land here: a row with no chat_guid yields no name
    // below and drops out on its own, which is the same thing it did before.
    const h = m.chat_guid;
    const name = typeof h === 'string' ? h.split(';').pop() : null;
    if (name) contacts[name] = (contacts[name] ?? 0) + 1;
  }
  const top = Object.entries(contacts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length > 0) {
    lines.push(`(computed, imessage) messages you sent, by contact: ${top.map(([n, c]) => `${n} (${c})`).join(', ')}`);
  }
  if (roomMessages > 0) {
    // No room id and no name: a room has no name in 77% of cases anyway, and an
    // id is not a fact worth handing a model. The count is.
    lines.push(`(computed, imessage) you also sent ${roomMessages} message${roomMessages === 1 ? '' : 's'} across ${rooms.size} group chat${rooms.size === 1 ? '' : 's'}`);
  }

  // Photos: volume by day, nothing else — a filename is not a claim, but
  // "you took 14 photos on Saturday" is a true computed sentence.
  const photoDays = {};
  for (const r of by('photos')) photoDays[localDate(r.ts)] = (photoDays[localDate(r.ts)] ?? 0) + 1;
  const pdays = Object.entries(photoDays).sort();
  if (pdays.length > 0) {
    lines.push(`(computed, photos) ${by('photos').length} photos across ${pdays.length} days: ${pdays.map(([d, c]) => `${d} (${c})`).join(', ')}`);
  }

  return lines;
}

// --- the lines the composer reads -------------------------------------------

// Computed lines first (exact numbers), then rows in ranking order —
// term-relevant first, then nearest-to-now. Numbered as one sequence so the
// prompt's "every statement rests on a numbered record" rule spans both
// kinds.
export function episodicLines(rows, stats) {
  const lines = [...stats];
  // Photos ride as the computed line only: their text is a filename, and 30
  // filenames would spend the whole envelope saying nothing.
  const readable = rows.filter((r) => r.source !== 'photos');
  for (const r of readable.slice(0, Math.max(0, MAX_LINES - lines.length))) {
    const snippet = r.text.replace(/\s+/gu, ' ').trim().slice(0, SNIPPET);
    lines.push(`(${r.source}, ${localDate(r.ts)}) ${snippet}`);
  }
  return lines.slice(0, MAX_LINES).map((l, i) => `[${i + 1}] ${l}`);
}

// The one call sites use.
export function episodicContext(
  db,
  question,
  { now = Date.now(), excludeChatGuids = null, allowSources = null } = {}
) {
  const route = routeQuestion(question, { now });
  if (route === null) return null;
  // allowSources: an INTERSECTION with the routed sources, never a widening —
  // the experiment uses it to give each tier only its own drawers. Production
  // passes nothing and reads everything the shelf allows.
  if (Array.isArray(allowSources)) {
    route.sources = route.sources.filter((s) => allowSources.includes(s));
    if (route.sources.length === 0) return { route, rows: [], lines: [], sources: [] };
  }
  const rows = selectEpisodicRows(db, route, { excludeChatGuids });
  if (rows.length === 0) return { route, rows: [], lines: [], sources: [] };
  const stats = computeEpisodicStats(rows, route);
  return {
    route,
    rows,
    lines: episodicLines(rows, stats),
    sources: [...new Set(rows.map((r) => r.source))].sort(),
  };
}
