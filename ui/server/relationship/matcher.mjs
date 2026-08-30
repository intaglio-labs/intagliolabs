// The matched-reconnect card builder (L5 step 10's engine): the pipeline the
// owner graded through thirteen shadow versions, productized at the rules
// that survived. One card per person, every source combined; the local model
// writes and judges, code verifies. History of the load-bearing decisions,
// each bought with a graded eval (results local, never here):
//
//   - needs come from what the owner actually said lately -- granola
//     meetings and notes first (where needs are said out loud), then the
//     owner's own sent messages (v6).
//   - excerpts are speaker-tagged, and the supporting quote must be THEIRS
//     or a shared meeting title -- the owner's own words prove nothing about
//     the other person (v5).
//   - the sentence must name a concrete ACTION for one of the owner's focus
//     items; "insights"-style consulting vapor is code-rejected (v7).
//   - grounding is ARITHMETIC: the sentence's specific vocabulary must
//     appear in the evidence. A model asked to judge grounding vetoed
//     everything or nothing at every calibration tried (v12/v13).
//   - nobody is excluded by relationship; the widget label (business /
//     friend / romantic / family) rides into the writer and the judge as
//     context, so the ask must fit the relationship (v11, owner decision).
//   - how the last conversation ended is scored for everyone; a bad ending
//     raises the bar and is shown, never hidden (v10, owner decision).
//
// No message text leaves the machine: the model is the loopback llama.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TOPIC_SIGNALS, isAutomatedRow } from '../people/topics.mjs';
import { VOUCHABLE_CHANNELS, VOUCH_STALE_AFTER } from './reconnect.mjs';

export const MATCH_RULES_VERSION = 'rm-match-v13';

const DAY = 86_400_000;
const MSG_SOURCES = "('imessage','whatsapp','mail','slack','instagram','messenger','discord','twitter')";
const FILLER = /reignite|meaningful|shared (history|interests?)|reconnect(ing)? (could|would|might)|suggests?|insights?|strateg(y|ies|ic)|strong foundation|quiet period/i;
const SOCIAL_ANCHOR = /dinner|drinks|coffee|lunch|party|hang(ing)? out|brunch|club/i;
const RELATION_NAME = /^\s*(mother|mom|mommy|mama|father|dad|daddy|papa|grandma|grandpa|granny|nana|aunt|auntie|uncle|sis|sister|bro|brother|cousin)\b/iu;
// Ask-verbs and generic value nouns describe the ASK, not a fact about the
// world; their absence from a quote proves nothing (v13).
const STOP = new Set(['texting', 'text', 'them', 'their', 'they', 'helps', 'help', 'with', 'about',
  'that', 'this', 'your', 'owner', 'launch', 'launching', 'building', 'developing', 'getting',
  'secure', 'securing', 'schedule', 'scheduling', 'coordinate', 'connect', 'introductions', 'advice',
  'feedback', 'testing', 'experience', 'input', 'thoughts', 'review', 'reviewing', 'refine',
  'refining', 'issues', 'prioritize', 'prioritizing']);

function normName(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function parseJson(raw) {
  try { return JSON.parse(String(raw).replace(/^```json?\s*|```\s*$/g, '')); } catch { return null; }
}

export async function buildMatchedCards(service, { llamaCall, now = Date.now(), limit = 15 } = {}) {
  const contextDb = service.db();
  const stateDb = service.stateDbHandle();
  if (typeof llamaCall !== 'function') throw new Error('matcher needs a llamaCall');

  // ---- what is the owner into right now ---------------------------------
  const currentCounts = new Map();
  for (const r of contextDb.prepare(
    `SELECT text FROM context WHERE ts > ? AND source IN ${MSG_SOURCES}`).all(now - 45 * DAY)) {
    const t = String(r.text);
    if (isAutomatedRow(t)) continue;
    for (const [topic, re] of Object.entries(TOPIC_SIGNALS)) {
      if (re.test(t)) currentCounts.set(topic, (currentCounts.get(topic) ?? 0) + 1);
    }
  }
  const currentTopics = [...currentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (currentTopics.length === 0) return { cards: [], focus: null, currentTopics: [] };

  const ownerLines = [];
  for (const r of contextDb.prepare(
    `SELECT source, text FROM context WHERE ts > ? AND source IN ('granola','notes') ORDER BY ts DESC LIMIT 40`)
    .all(now - 45 * DAY)) {
    const t = String(r.text);
    if (r.source === 'granola' || currentTopics.some(([topic]) => TOPIC_SIGNALS[topic].test(t))) {
      ownerLines.push(`[${r.source}] ${t.slice(0, 400)}`);
    }
  }
  for (const r of contextDb.prepare(
    `SELECT text, meta FROM context WHERE ts > ? AND source IN ${MSG_SOURCES} ORDER BY ts DESC`)
    .all(now - 45 * DAY)) {
    if (ownerLines.length >= 90) break;
    let fromMe = false;
    try { fromMe = JSON.parse(r.meta ?? '{}')?.is_from_me === true; } catch {}
    if (!fromMe) continue;
    const t = String(r.text);
    if (isAutomatedRow(t)) continue;
    if (currentTopics.some(([topic]) => TOPIC_SIGNALS[topic].test(t))) ownerLines.push(t.slice(0, 200));
  }
  const ownerFocus = (await llamaCall([
    { role: 'system', content:
      'These are messages, meeting notes and personal notes the owner wrote or attended in the last 45 days. Extract what they are concretely working on or trying to do right now, as 2-4 short specific phrases. Specific nouns from the material, not categories. Output ONLY the phrases, comma-separated.' },
    { role: 'user', content: ownerLines.join('\n') },
  ], 80, 0.2)) ?? currentTopics.map(([t]) => t).join(', ');
  const SOCIAL_FOCUS = /dinner|lunch|coffee|drinks|party|hang|birthday/i;
  const focusList = ownerFocus.split(/,\s*/).filter((f) => !SOCIAL_FOCUS.test(f))
    .map((f, i) => `${i + 1}. ${f}`).join('\n');
  const focusItems = focusList.split('\n').map((f) => f.replace(/^\d+\.\s*/, '').trim().toLowerCase());
  const focusWordsBase = new Set(focusList.toLowerCase().match(/[a-z]{4,}/g) ?? []);

  // ---- relationship labels ----------------------------------------------
  let roleLabels = new Map();
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.hazlie', 'connectors', 'config.json'), 'utf8'));
    roleLabels = new Map(Object.entries(cfg.personRoles ?? {}).map(([k, v]) => [k, String(v).toLowerCase()]));
  } catch {}
  const labelFor = (p) => roleLabels.get(p.key) ?? (RELATION_NAME.test(p.name) ? 'family' : null);

  // ---- calendar stats for everyone --------------------------------------
  const calStats = new Map();
  if (stateDb) {
    const byEmail = new Map(); const namedKeys = new Set();
    for (const r of stateDb.prepare('SELECT identifier, display_name FROM contact_ids').all()) {
      const id = String(r.identifier).toLowerCase();
      const emailShaped = String(r.display_name).includes('@');
      if (!emailShaped) namedKeys.add(normName(r.display_name));
      if (id.includes('@')) byEmail.set(id, { key: `name:${normName(r.display_name)}`, emailShaped });
    }
    for (const row of contextDb.prepare(
      `SELECT ts, text, meta FROM context WHERE source='calendar' AND meta LIKE '%"attendees"%'`).all()) {
      let atts; try { atts = JSON.parse(row.meta)?.attendees; } catch { continue; }
      if (!Array.isArray(atts) || atts.length === 0 || atts.length > 8) continue;
      for (const a of atts) {
        if (a?.response === 'declined') continue;
        const hit = byEmail.get(String(a?.email ?? '').toLowerCase());
        if (!hit) continue;
        let key = hit.key;
        if (hit.emailShaped && typeof a?.name === 'string') {
          const nk = normName(a.name);
          if (namedKeys.has(nk)) key = `name:${nk}`;
        }
        let c = calStats.get(key);
        if (!c) { c = { met: 0, lastMet: -Infinity, future: 0, titles: [] }; calStats.set(key, c); }
        if (row.ts <= now) {
          c.met += 1; if (row.ts > c.lastMet) c.lastMet = row.ts;
          if (c.titles.length < 12 && String(row.text).length > 3) {
            c.titles.push(`meeting [${new Date(row.ts).getFullYear()}]: ${String(row.text).slice(0, 120)}`);
          }
        } else c.future += 1;
      }
    }
  }

  // ---- the pool, through every gate --------------------------------------
  const coverage = service.coverage({ now, staleAfter: VOUCH_STALE_AFTER });
  const pool = service.people({ now }).filter((p) => {
    if (!p.key.startsWith('name:')) return false;
    const cal = calStats.get(p.key);
    if (cal && cal.future > 0) return false; // seeing them Tuesday: no card
    const msgEligible = p.messages >= 8 && p.dormancyDays !== null && p.dormancyDays >= 180 &&
      (p.channels ?? []).some((ch) => VOUCHABLE_CHANNELS.includes(ch)) &&
      (p.channels ?? []).filter((ch) => VOUCHABLE_CHANNELS.includes(ch))
        .every((ch) => coverage.spansDormancy(ch, p.dormancyDays));
    const calEligible = cal && cal.met >= 3 && (now - cal.lastMet) >= 120 * DAY;
    if (!msgEligible && !calEligible) return false;
    return !service.controls.isSuppressed(p.key) &&
      !service.controls.isMuted({ personKey: p.key, kind: 'reconnect', now });
  });

  // ---- topical history + combined score ----------------------------------
  const memberTexts = contextDb.prepare(
    `SELECT e.id AS eid, e.started_at, x.text, x.meta
     FROM episode e JOIN episode_member m ON m.episode_id = e.id
     JOIN context x ON x.id = m.context_id
     WHERE e.counterparty_key = ? ORDER BY e.started_at DESC LIMIT 4000`);
  const speakerOf = (meta) => {
    try { return JSON.parse(meta ?? '{}')?.is_from_me === true ? 'you' : 'them'; } catch { return 'them'; }
  };
  function topicHistory(key) {
    const perTopic = new Map();
    for (const r of memberTexts.all(key)) {
      const t = String(r.text);
      for (const [topic] of currentTopics) {
        if (!TOPIC_SIGNALS[topic].test(t)) continue;
        let h = perTopic.get(topic);
        if (!h) { h = { eps: new Set(), minY: 9999, maxY: 0 }; perTopic.set(topic, h); }
        h.eps.add(r.eid);
        const y = new Date(r.started_at).getFullYear();
        if (y < h.minY) h.minY = y;
        if (y > h.maxY) h.maxY = y;
      }
    }
    return [...perTopic.entries()].map(([topic, h]) => ({
      topic, conversations: h.eps.size,
      years: h.minY === h.maxY ? String(h.minY) : `${h.minY}–${h.maxY}`,
    })).sort((a, b) => b.conversations - a.conversations);
  }
  function excerptsFor(key) {
    const work = [], social = [];
    for (const r of memberTexts.all(key)) {
      if (work.length >= 20) break;
      const t = String(r.text);
      if (isAutomatedRow(t) || t.length < 40) continue;
      const tag = `${speakerOf(r.meta)} [${new Date(r.started_at).getFullYear()}]: ${t.slice(0, 180)}`;
      if (TOPIC_SIGNALS['product & startup'].test(t) || TOPIC_SIGNALS['fundraising'].test(t)) work.push(tag);
      else if (currentTopics.some(([topic]) => TOPIC_SIGNALS[topic].test(t))) social.push(tag);
    }
    return [...work, ...social.slice(0, Math.max(0, 20 - work.length))];
  }

  const scored = pool.map((p) => {
    const hist = topicHistory(p.key);
    const cal = calStats.get(p.key) ?? null;
    const topicScore = hist.reduce((s, h) => s + h.conversations, 0);
    const score = topicScore + 4 * Math.log(1 + (cal?.met ?? 0));
    return { p, hist, cal, score, topicScore, label: labelFor(p) };
  }).filter((c) => c.topicScore >= 3 || (c.cal?.met ?? 0) >= 3)
    .sort((a, b) => b.score - a.score).slice(0, limit);

  // ---- last-conversation ending ------------------------------------------
  const lastEpisodeLines = contextDb.prepare(
    `SELECT x.text, x.meta FROM episode e JOIN episode_member m ON m.episode_id = e.id
     JOIN context x ON x.id = m.context_id
     WHERE e.counterparty_key = ? AND e.id = (SELECT id FROM episode WHERE counterparty_key = ? ORDER BY ended_at DESC LIMIT 1)
     ORDER BY m.line_no`);
  async function leftOff(key) {
    const rows = lastEpisodeLines.all(key, key).slice(-12);
    if (rows.length === 0) return null;
    const lines = rows.map((r) => `${speakerOf(r.meta)}: ${String(r.text).slice(0, 140)}`);
    const v = parseJson(await llamaCall([
      { role: 'system', content:
        'This is the tail of the LAST conversation between the owner (you:) and this person (them:). Answer STRICT JSON: {"clause": <under 12 words, how it was left, facts only>, "tone": <"warm"|"neutral"|"bad">} where "bad" means visible conflict, coldness, or a pointed unanswered ask.' },
      { role: 'user', content: lines.join('\n') },
    ], 70, 0.2));
    if (!v || typeof v.clause !== 'string' || v.clause.length < 4) return null;
    return { clause: v.clause.slice(0, 90), tone: ['warm', 'neutral', 'bad'].includes(v.tone) ? v.tone : 'neutral' };
  }

  // ---- write, then verify ------------------------------------------------
  async function why(c) {
    const excerpts = excerptsFor(c.p.key);
    if (c.cal?.titles?.length) excerpts.push(...c.cal.titles.slice(0, 8));
    if (excerpts.length === 0) return null;
    const messages = [
      { role: 'system', content:
        'The owner has current focus items (numbered) and excerpt lines from past conversations with one person; each line is prefixed "you:" (the owner spoke), "them:" (this person spoke), or "meeting" (a shared calendar event title). Answer in STRICT JSON, nothing else: {"focus": <the ONE focus item this person genuinely helps with, copied verbatim from the numbered list>, "role": <what this person actually does / is to the owner, 3-8 words, judged ONLY from the excerpts>, "sentence": <ONE sentence: why texting them helps with that focus item>, "quote": <one "them:" or "meeting" excerpt line, COPIED VERBATIM with its prefix, showing the thing the sentence relies on>}. Rules: the quote must be THEIR words or a shared meeting, never a "you:" line. The need in the sentence must be the chosen focus item, never a topic imported from their conversation. The ask must fit what the person DOES. The sentence must propose or point at a concrete ACTION -- an intro, an invite, a demo, a specific ask. When a relationship label is given, the ask must make sense FOR that relationship. Never write: reignite, meaningful, shared history, suggests, foundation, insights, strategies. No day counts.' },
      { role: 'user', content:
        `Owner's current focus items:\n${focusList}\n\nPerson: ${c.p.name}${c.label ? ` (the owner labeled this relationship: ${c.label})` : ''}\nExcerpt lines:\n${excerpts.join('\n')}` },
    ];
    const attempt = async (temp) => {
      const obj = parseJson(await llamaCall(messages, 220, temp));
      const { focus, role, sentence, quote } = obj ?? {};
      if (typeof sentence !== 'string' || sentence.length < 20 || FILLER.test(sentence)) return null;
      if (typeof quote !== 'string') return null;
      const matched = excerpts.find((e) => e === quote || e.includes(quote.slice(0, 60)));
      if (!matched || !(matched.startsWith('them') || matched.startsWith('meeting'))) return null;
      const claimed = String(focus ?? '').trim().toLowerCase();
      if (!focusItems.some((f) => f === claimed || f.includes(claimed) || claimed.includes(f))) return null;
      return { role: String(role ?? ''), sentence, quote: quote.replace(/^them\s*/, ''), focus: String(focus), excerpts };
    };
    const verify = async (r) => {
      if (SOCIAL_ANCHOR.test(r.sentence)) return false;
      const focusWords = new Set(focusWordsBase);
      for (const t of String(c.p.name).toLowerCase().match(/[a-z]{3,}/g) ?? []) focusWords.add(t);
      const evidencePool = (r.excerpts.join(' ') + ' ' + r.quote).toLowerCase();
      const leaned = (r.sentence.toLowerCase().match(/[a-z]{5,}/g) ?? [])
        .filter((w) => !STOP.has(w) && !focusWords.has(w));
      const missing = leaned.filter((w) => !evidencePool.includes(w));
      if (leaned.length > 0 && missing.length > leaned.length / 2) return false;
      const out = parseJson(await llamaCall([
        { role: 'system', content: (c.label
          ? 'Could a person with this role and relationship realistically do or help with this action, and is it an appropriate thing to ask of that relationship? Judge the ROLE and RELATIONSHIP against the ACTION only. An unusual pairing is fine if the role fits.'
          : 'Could a person with this role realistically do or help with this action? Judge the ROLE against the ACTION only. No relationship label exists for this person; that is normal and is NOT a reason to say no.')
          + ' Answer STRICT JSON only: {"answer":"yes"} or {"answer":"no","why":<5 words>}.' },
        { role: 'user', content: JSON.stringify({ person_role: r.role, ...(c.label ? { relationship_label: c.label } : {}), proposed_action: r.sentence }) },
      ], 50, 0));
      return out?.answer === 'yes';
    };
    try {
      const r = (await attempt(0.2)) ?? (await attempt(0.6));
      if (r === null) return null;
      return (await verify(r)) ? r : null;
    } catch { return null; }
  }

  const cards = [];
  for (const c of scored) {
    const r = await why(c);
    if (r === null) continue;
    const left = await leftOff(c.p.key);
    if (left?.tone === 'bad') {
      const median = scored[Math.floor(scored.length / 2)]?.score ?? 0;
      if (c.score < median) continue;
    }
    cards.push({
      personKey: c.p.key, name: c.p.name, kind: 'reconnect',
      sentence: r.sentence, quote: r.quote, role: r.role, focus: r.focus,
      label: c.label, left: left?.clause ?? null, leftTone: left?.tone ?? null,
      evidence: {
        topics: c.hist, messages: c.p.messages, dormancyDays: c.p.dormancyDays,
        meetings: c.cal?.met ?? 0,
        lastMeetingDaysAgo: c.cal ? Math.floor((now - c.cal.lastMet) / DAY) : null,
      },
      producer_version: MATCH_RULES_VERSION,
    });
  }
  return { cards, focus: ownerFocus, currentTopics };
}
