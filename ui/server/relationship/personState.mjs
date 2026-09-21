// THE STATE A JUDGMENT IS MADE FROM. One code-built bundle per person, built
// from the facts the store already holds, with every number turned into words
// before it reaches the model.
//
// WHY WORDS. Jev reads digits and dates as text and cannot compare them
// (docs.typesafe.ai/model-jaggedness/jev-1.13), so "quiet 935 days" and "quiet
// 365 days" are two strings to it, not two quantities. Bucketed in code they
// are "about two years ago" and "about a year ago", which it reads correctly.
// The thresholds below stay in JS and are the only place they exist.
//
// WHY THIS SHAPE (measured 2026-09-20 on 54 owner-judged cards, numbers only,
// scratchpad eval v2/v3): twelve raw lines gave AUC 0.58 on "would the owner
// accept this reminder"; this bundle gave 0.72 with monotone calibration.
// Ablations: dropping the professional block cost 0.04; dropping the words
// cost 0.06 AND flipped the relationship read from friend to business for 40
// of 54 people -- the words are what say these are friends the owner also
// works with; the LinkedIn block is what says they also work together. Both
// stay. Everything under about 0.07 was noise at that n.
//
// NOTHING HERE IS LOGGED, and nothing here is stored: the bundle exists for
// the duration of one ask. `stateHash` is what the cache keys on, so a person
// whose facts and lines have not changed costs nothing on the second night.
import { createHash } from 'node:crypto';
import { isAutomatedRow } from '../people/topics.mjs';

const DAY = 86_400_000;
export const LINE_CHARS = 160;
export const EXCHANGE_LINES = 8;
export const ENDED_LINES = 12;
export const QUOTE_CANDIDATES = 12;
export const YEAR_SAMPLES = 6;

export function clip(text, max = LINE_CHARS) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

export function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return 'never';
  const d = (now - ms) / DAY;
  if (d < 14) return 'within two weeks';
  if (d < 45) return 'about a month ago';
  if (d < 120) return 'a few months ago';
  if (d < 300) return 'about half a year ago';
  if (d < 550) return 'about a year ago';
  if (d < 1000) return 'about two years ago';
  if (d < 1500) return 'about three years ago';
  return 'four or more years ago';
}

export function span(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return 'unknown';
  const d = (toMs - fromMs) / DAY;
  if (d < 30) return 'under a month';
  if (d < 365) return 'under a year';
  if (d < 730) return 'one to two years';
  if (d < 1460) return 'two to four years';
  return 'four or more years';
}

export function count(n) {
  const v = Number(n) || 0;
  if (v === 0) return 'none';
  if (v < 5) return 'a handful';
  if (v < 30) return 'a couple dozen';
  if (v < 200) return 'well over a hundred';
  if (v < 1000) return 'hundreds';
  if (v < 5000) return 'thousands';
  return 'many thousands';
}

export function balance(sent, received) {
  const s = Number(sent) || 0;
  const r = Number(received) || 0;
  if (s + r === 0) return 'no direct messages';
  const f = s / (s + r);
  if (f > 0.62) return 'the owner writes much more than they do';
  if (f < 0.38) return 'they write much more than the owner does';
  return 'roughly even both ways';
}

export function trend(byYear, now = Date.now()) {
  if (!byYear || byYear.length === 0) return 'no message history';
  const peak = byYear.reduce((m, y) => (y.total > m.total ? y : m));
  const last = byYear[byYear.length - 1];
  const thisYear = String(new Date(now).getFullYear());
  const tail = last.year === thisYear ? 'still some messages this year' : `last messages in ${last.year}`;
  return `most active in ${peak.year} (${count(peak.total)} messages that year); ${tail}`;
}

// The twelve newest lines THEY wrote directly to the owner, minus robots.
// isAutomatedRow runs here, in code, because Jev would rank a shipping notice
// highly: it is specific, it names things, and it is nothing to reply to.
export function quoteCandidates(db, personKey, { limit = QUOTE_CANDIDATES } = {}) {
  const rows = db.prepare(
    `SELECT c.id AS id, c.text AS text, c.content_hash AS hash, c.ts AS ts
     FROM person_event_links pel JOIN context c ON c.id = pel.context_id
     WHERE pel.person_key = ? AND pel.authored = 1 AND pel.room = 0
     ORDER BY c.ts DESC LIMIT ?`
  ).all(personKey, limit);
  return rows
    .filter((r) => typeof r.text === 'string' && r.text.trim().length > 0 && !isAutomatedRow(r.text))
    .map((r) => ({ id: Number(r.id), hash: r.hash ?? null, ts: Number(r.ts), text: clip(r.text) }));
}

// The last direct lines both ways, oldest first, speaker-tagged.
export function lastExchange(db, personKey, { limit = EXCHANGE_LINES } = {}) {
  const rows = db.prepare(
    `SELECT c.text AS text, pel.authored AS theirs
     FROM person_event_links pel JOIN context c ON c.id = pel.context_id
     WHERE pel.person_key = ? AND pel.room = 0 AND (pel.authored = 1 OR pel.owner_authored = 1)
     ORDER BY c.ts DESC LIMIT ?`
  ).all(personKey, limit);
  return rows.reverse().map((r) => ({ who: r.theirs ? 'them' : 'owner', text: clip(r.text) }));
}

function tableExists(db, name) {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

export function buildPersonState(db, personKey, { now = Date.now() } = {}) {
  const p = db.prepare('SELECT * FROM people WHERE person_key = ?').get(personKey);
  if (!p) return null;
  let li = null;
  try { li = p.linkedin ? JSON.parse(p.linkedin) : null; } catch { li = null; }
  let subRoles = [];
  try { subRoles = p.sub_roles ? JSON.parse(p.sub_roles) : []; } catch { subRoles = []; }
  const channels = tableExists(db, 'person_channels')
    ? db.prepare('SELECT source FROM person_channels WHERE person_key = ? ORDER BY source').all(personKey).map((r) => r.source)
    : [];
  const byYear = tableExists(db, 'person_activity')
    ? db.prepare(`SELECT substr(ym, 1, 4) AS year, SUM(sent) + SUM(received) AS total
                  FROM person_activity WHERE person_key = ? GROUP BY 1 ORDER BY 1`).all(personKey)
      .map((r) => ({ year: String(r.year), total: Number(r.total) || 0 }))
    : [];
  const activeDays = tableExists(db, 'person_active_days')
    ? Number(db.prepare('SELECT COUNT(*) AS n FROM person_active_days WHERE person_key = ?').get(personKey).n)
    : 0;
  const groups = Number(db.prepare(
    'SELECT COUNT(DISTINCT conversation_key) AS n FROM person_event_links WHERE person_key = ? AND room = 1'
  ).get(personKey).n);
  // A 40-person all-hands is not a meeting with this person; 2..8 attendees is.
  const mt = db.prepare(
    `SELECT COUNT(*) AS n, MAX(c.ts) AS last FROM person_event_links l JOIN context c ON c.id = l.context_id
     WHERE l.person_key = ? AND l.source = 'calendar' AND l.role IN ('attendee','organizer')
       AND json_array_length(json_extract(c.meta, '$.attendees')) BETWEEN 2 AND 8`
  ).get(personKey);
  const exchange = lastExchange(db, personKey);
  const lastTheirs = exchange.length ? exchange[exchange.length - 1] : null;
  // One long line from them per year, newest years first: what they sound
  // like over time, not just last week.
  const longs = db.prepare(
    `SELECT c.text AS text, strftime('%Y', c.ts / 1000, 'unixepoch') AS y
     FROM person_event_links l JOIN context c ON c.id = l.context_id
     WHERE l.person_key = ? AND l.authored = 1 AND l.room = 0 AND length(c.text) > 60
     ORDER BY c.ts DESC LIMIT 400`
  ).all(personKey);
  const sample = [];
  const seen = new Set();
  for (const r of longs) {
    if (seen.has(r.y) || sample.length >= YEAR_SAMPLES || isAutomatedRow(r.text)) continue;
    seen.add(r.y);
    sample.push({ year: String(r.y), text: clip(r.text) });
  }
  const contact = contactFacts(db, personKey);
  const state = {
    professional: {
      linkedin: li
        ? { title: li.position || null, company: li.company || null, industry: li.industry || null }
        : 'not a LinkedIn connection',
      sub_roles: Array.isArray(subRoles) ? subRoles : [],
      channels,
      ...(contact ? { contact } : {}),
    },
    relationship_shape: {
      direct_messages: count(p.direct_messages),
      balance: balance(p.sent, p.received),
      known_for: span(Number(p.first_seen), Number(p.last_seen)),
      active_days: count(activeDays),
      shared_group_chats: count(groups),
      meetings_one_on_one: count(mt?.n ?? 0),
      last_meeting: ago(Number(mt?.last) || 0, now),
      trend: trend(byYear, now),
    },
    recency: {
      they_last_wrote: ago(Number(p.last_from_them) || 0, now),
      owner_last_wrote: ago(Number(p.last_from_owner) || 0, now),
      who_wrote_last: !p.last_from_them && !p.last_from_owner
        ? 'nobody'
        : (Number(p.last_from_them) || 0) > (Number(p.last_from_owner) || 0) ? 'them' : 'owner',
      last_line_from_them_is_question: Boolean(lastTheirs && lastTheirs.who === 'them' && /\?\s*$/u.test(lastTheirs.text)),
    },
    last_exchange: exchange,
    their_words_over_the_years: sample,
  };
  return state;
}

// Ingestion round one lands the owner's own contact-card facts here when the
// spine carries them (contact_facts: relation labels, job title, department,
// nickname, groups). Absent table or row: nothing, and the state says nothing.
function contactFacts(db, personKey) {
  if (!tableExists(db, 'person_contact_facts')) return null;
  const row = db.prepare('SELECT * FROM person_contact_facts WHERE person_key = ?').get(personKey);
  if (!row) return null;
  const out = {};
  if (row.job_title) out.job_title = clip(row.job_title, 80);
  if (row.department) out.department = clip(row.department, 80);
  if (row.nickname) out.nickname = clip(row.nickname, 40);
  try { const labels = JSON.parse(row.relation_labels ?? '[]'); if (labels.length) out.relation_labels = labels.slice(0, 6); } catch { /* absent */ }
  try { const groups = JSON.parse(row.groups ?? '[]'); if (groups.length) out.groups = groups.slice(0, 8).map((g) => clip(g, 40)); } catch { /* absent */ }
  return Object.keys(out).length ? out : null;
}

// The cache key: the whole state, canonically. Any changed word (a new line,
// a bucket crossed, a new title) is a new judgment; nothing changed costs
// nothing.
export function stateHash(state) {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 24);
}
