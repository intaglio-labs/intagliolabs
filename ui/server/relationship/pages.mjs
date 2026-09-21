// Person pages (L5 step 4): one maintained page per eligible person, built by
// a model from what THAT PERSON wrote to the owner, every line with a
// verbatim receipt. Same trust lifecycle as every other claim in this system
// — subject='person', stored PENDING, the owner decides — this file only
// adds the model call and the grounding step that earns a claim its
// claim_source row.
//
// THE POLARITY IS THE OPPOSITE OF distill.mjs. There, a claim may only rest
// on the OWNER's own words (quotable = fromMe). Here, a claim may only rest
// on the PERSON's own words: gatherPersonContext hands the model THEM/ME
// lines, and grounding checks a quote against a THEM line specifically, never
// an ME line. Getting this backwards would let the owner's own words become
// "evidence" about somebody else.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpisodes, isQuotable } from '../memory/episodes.mjs';
import { pageJudgments } from './judgments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PROMPT_PATH = join(here, '..', '..', '..', 'prompts', 'person_page.md');

const MAX_ASKS = 3;
const MAX_NOTABLE = 3;
const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_MAX_MEETINGS = 20;

// section -> claim.kind, exactly as specified: who/how_left/notable read as
// stable facts, an ask is a plan (something the PERSON wants, not the
// owner's), an objection is a constraint on the relationship or the ask.
// Exported for relationship/sweep.mjs: a page_line proposal reuses this exact
// section -> kind map (a sub_role or firm proposal never touches it -- see
// the person_sweep_proposal comment in hermes.mjs's SCHEMA), so the sweep and
// the page builder can never quietly disagree about what an "ask" or a
// "how_left" claim's kind is.
export const SECTION_KIND = Object.freeze({
  who: 'fact',
  ask: 'plan',
  objection: 'constraint',
  how_left: 'fact',
  notable: 'fact',
});

function promptSha(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hasColumn(db, table, column) {
  try {
    return db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column) !== undefined;
  } catch {
    return false;
  }
}

function parseMeta(meta) {
  if (meta === null || meta === undefined) return null;
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(meta);
  } catch {
    return null;
  }
}

function parseSubRoles(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function personInfo(db, personKey) {
  const subRolesExpr = hasColumn(db, 'people', 'sub_roles') ? 'sub_roles' : 'NULL';
  const row = db
    .prepare(`SELECT display_name, role, ${subRolesExpr} AS sub_roles_json FROM people WHERE person_key = ?`)
    .get(personKey);
  if (!row) return { personKey, name: personKey, role: null, subRoles: [] };
  return {
    personKey,
    name: row.display_name ?? personKey,
    role: row.role ?? null,
    subRoles: parseSubRoles(row.sub_roles_json),
  };
}

// Gather what this person wrote directly to the owner (never a room), the
// owner's own lines in those same conversations (context only -- they are
// never quotable evidence about the OTHER person), and calendar titles where
// both attended. Grouped into episodes the same way distill.mjs's episode
// mode is: a 60-minute gap cuts conversations where they actually end, not a
// model's guess.
export function gatherPersonContext(db, personKey, { maxChars = DEFAULT_MAX_CHARS, maxMeetings = DEFAULT_MAX_MEETINGS } = {}) {
  const linked = db
    .prepare(
      `SELECT DISTINCT context_id FROM person_event_links WHERE person_key = ? AND room = 0`
    )
    .all(personKey);
  const ids = linked.map((r) => Number(r.context_id));

  let rows = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    rows = db
      .prepare(
        `SELECT id, ts, source, speaker, text, meta, entity_id, content_hash
         FROM context WHERE id IN (${placeholders})`
      )
      .all(...ids);
  }

  // authored=1 rows for this person are the ones THEY wrote; everything else
  // in the same thread is context (the owner's side, or a system-generated
  // line) and can never become a quote.
  const authoredIds = new Set(
    db
      .prepare(`SELECT context_id FROM person_event_links WHERE person_key = ? AND authored = 1 AND room = 0`)
      .all(personKey)
      .map((r) => Number(r.context_id))
  );

  const episodes = buildEpisodes(rows, { now: Date.now() })
    .slice()
    .sort((a, b) => b.started_at - a.started_at); // most recent conversation first

  const excerpts = [];
  let charBudget = maxChars;
  outer: for (const ep of episodes) {
    for (const member of ep.members) {
      const row = member.row;
      const speaker = authoredIds.has(Number(row.id))
        ? 'THEM'
        : isQuotable(row)
          ? 'ME'
          : null;
      // A line that is neither the person's own nor the owner's (a system
      // note, a third party swept into a "room=0" link some other way) is
      // dropped rather than mislabeled -- mislabeling in either direction is
      // exactly the polarity bug this file exists to avoid.
      if (speaker === null) continue;
      const text = String(row.text ?? '');
      if (text.length === 0) continue;
      if (text.length > charBudget) {
        if (excerpts.length === 0) {
          // Always admit at least one line, truncated, rather than an empty
          // page because the very first excerpt was long.
          excerpts.push({ contextId: Number(row.id), speaker, text: text.slice(0, charBudget), ts: Number(row.ts) });
        }
        break outer;
      }
      charBudget -= text.length;
      excerpts.push({ contextId: Number(row.id), speaker, text, ts: Number(row.ts) });
    }
  }
  // Render order is oldest-first WITHIN the most-recent-first episode
  // selection above, so a reader (model or human) sees each conversation in
  // the order it happened even though older conversations were dropped first
  // under the budget.
  excerpts.sort((a, b) => a.ts - b.ts);

  const meetingTitles = [];
  try {
    const meetings = db
      .prepare(
        `SELECT DISTINCT c.id, c.text, c.ts FROM context c
         JOIN json_each(c.meta, '$.attendees') je
         JOIN person_identifiers pi ON pi.identifier = lower(json_extract(je.value, '$.email'))
         WHERE c.source = 'calendar' AND pi.person_key = ? AND json_valid(c.meta)
         ORDER BY c.ts DESC LIMIT ?`
      )
      .all(personKey, maxMeetings);
    for (const m of meetings) meetingTitles.push(String(m.text ?? '').slice(0, 200));
  } catch {
    // person_identifiers or calendar rows may not exist on a fresh/partial
    // projection; meetings are supplementary context, not required.
  }

  // The first THEM line whose bare text contains `quote`, verbatim. Used at
  // grounding time to resolve a model-supplied quote back to a context row --
  // the same "receipt, not copied text" discipline the rest of this system
  // uses; the id is what claim_source stores, never a second copy of the text.
  function findQuoteContextId(quote) {
    if (typeof quote !== 'string' || quote.length === 0) return null;
    for (const e of excerpts) {
      if (e.speaker === 'THEM' && e.text.includes(quote)) return e.contextId;
    }
    return null;
  }

  return { excerpts, meetingTitles, findQuoteContextId };
}

function renderPrompt(person, gathered) {
  const roleLine = person.role ? ` (${person.role}${person.subRoles.length ? `, ${person.subRoles.join('/')}` : ''})` : '';
  const lines = gathered.excerpts.map((e, i) => `${i + 1}   ${e.speaker}: ${e.text}`);
  const meetings = gathered.meetingTitles.length
    ? `\nMeetings attended together:\n${gathered.meetingTitles.map((t) => `- ${t}`).join('\n')}\n`
    : '';
  return (
    `Person: ${person.name}${roleLine}\n` +
    `BEGIN EXCERPTS\n${lines.join('\n')}\nEND EXCERPTS\n` +
    meetings
  );
}

function parsePageJson(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'no content' };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'no JSON object in output' };
  try {
    return { ok: true, page: JSON.parse(body.slice(start, end + 1)) };
  } catch {
    return { ok: false, reason: 'output is not valid JSON' };
  }
}

function isReceiptItem(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && typeof v.text === 'string' && v.text.trim().length > 0
    && typeof v.quote === 'string' && v.quote.length > 0;
}

// Ground every item against a THEM excerpt and drop what fails. Returns a
// flat list of { section, text, quote, contextId }, one per item that
// survives -- the shape store() below turns into claim + claim_source +
// person_page_item rows.
export function groundPage(page, gathered) {
  const kept = [];
  const noteDrop = (section, reason) => ({ section, reason });
  const dropped = [];

  function tryKeep(section, item) {
    if (!isReceiptItem(item)) {
      dropped.push(noteDrop(section, 'missing text/quote'));
      return;
    }
    const contextId = gathered.findQuoteContextId(item.quote);
    if (contextId === null) {
      dropped.push(noteDrop(section, 'quote is not a verbatim THEM excerpt'));
      return;
    }
    kept.push({ section, text: item.text.trim(), quote: item.quote, contextId });
  }

  if (page.who !== null && page.who !== undefined) tryKeep('who', page.who);
  if (page.objection !== null && page.objection !== undefined) tryKeep('objection', page.objection);
  if (page.how_left !== null && page.how_left !== undefined) tryKeep('how_left', page.how_left);
  const asks = Array.isArray(page.asks) ? page.asks.slice(0, MAX_ASKS) : [];
  for (const a of asks) tryKeep('ask', a);
  const notable = Array.isArray(page.notable) ? page.notable.slice(0, MAX_NOTABLE) : [];
  for (const n of notable) tryKeep('notable', n);

  return { kept, dropped };
}

// Exported for relationship/sweep.mjs's storeSweep, which runs the identical
// dedupe check for a page_line proposal rather than duplicating this query --
// a page built by pages.mjs and a page line proposed by a sweep pass share
// one dedupe rule, not two that could drift apart.
export function alreadyStored(db, personKey, section, text) {
  const row = db
    .prepare(
      `SELECT c.id FROM claim c
       JOIN person_page_item ppi ON ppi.claim_id = c.id
       WHERE c.subject = 'person' AND c.subject_person_key = ? AND ppi.section = ? AND c.text = ?
       LIMIT 1`
    )
    .get(personKey, section, text);
  return row !== undefined;
}

// Store one distill_run row plus one claim (+ claim_source, + person_page_item)
// per surviving item, in the shape hermes' own applyMemoryBatch uses
// elsewhere for a distiller's output: subject='person', p_claim NULL (this
// engine is not asked for a confidence number -- see person_page.md), the
// exact-quote check repeated here as the authoritative, server-side gate
// (the model-side grounding above is a client, and a client is not a
// boundary). Idempotent: an item identical in (person, section, text) to one
// already stored is skipped, not duplicated.
export function storePage(db, { personKey, engineName, model, kept, now = Date.now() }) {
  const promptText = readFileSync(PROMPT_PATH, 'utf8');
  const sha = promptSha(promptText);

  const insRun = db.prepare(
    `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context,
       rows_in, claims_out, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'on', ?, ?, 'complete', ?, ?)`
  );
  const insClaim = db.prepare(
    `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
     VALUES (?, 'person', ?, ?, ?, ?, NULL, NULL, ?)`
  );
  const insSource = db.prepare(
    `INSERT INTO claim_source(claim_id, context_id, source, entity_id, content_hash, quote)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insItem = db.prepare(`INSERT INTO person_page_item(claim_id, section, built_at) VALUES (?, ?, ?)`);
  const getRow = db.prepare('SELECT id, ts, source, entity_id, content_hash, text FROM context WHERE id = ?');

  let stored = 0;
  let skipped = 0;
  let rejected = 0;
  const runId = Number(
    insRun.run(`${engineName}:${model ?? 'unknown'}`, PROMPT_PATH, sha, '{}', kept.length, 0, now, now).lastInsertRowid
  );

  for (const item of kept) {
    if (alreadyStored(db, personKey, item.section, item.text)) {
      skipped += 1;
      continue;
    }
    const row = getRow.get(item.contextId);
    // Re-checked against the LIVE row, not trusted from gatherPersonContext's
    // in-memory snapshot: the row could have been edited or deleted between
    // gathering and storing. Same authoritative-server-check discipline as
    // applyMemoryBatch.
    if (row === undefined || !String(row.text).includes(item.quote)) {
      rejected += 1;
      continue;
    }
    const kind = SECTION_KIND[item.section] ?? 'fact';
    const claimId = Number(
      insClaim.run(runId, personKey, kind, item.text, row.ts ?? null, now).lastInsertRowid
    );
    insSource.run(claimId, Number(row.id), String(row.source), row.entity_id ?? null, row.content_hash ?? null, item.quote);
    insItem.run(claimId, item.section, now);
    stored += 1;
  }

  db.prepare('UPDATE distill_run SET claims_out = ? WHERE id = ?').run(stored, runId);
  return { runId, stored, skipped, rejected };
}

// gather -> prompt -> engine -> parse -> ground -> store, in one call. Drops
// the whole page (stores nothing, still records the attempt via the
// distill_run row only when at least one item survives -- an all-empty page
// is simply not written) when the model returned nothing usable.
export async function buildPersonPage(db, engine, personKey, { now = Date.now(), jev = null, judgments = {} } = {}) {
  const person = personInfo(db, personKey);
  const gathered = gatherPersonContext(db, personKey);
  if (gathered.excerpts.filter((e) => e.speaker === 'THEM').length === 0) {
    return { personKey, kept: 0, dropped: 0, skipped: 0, rejected: 0, reason: 'no THEM excerpts' };
  }

  // THE GENERATIVE PAGE, exactly as before -- and its failure is no longer the
  // end of the build (design step 6, 2026-09-21): a quote-only pass below can
  // still fill sections from the person's own lines.
  let kept = [];
  let dropped = [];
  let reason = null;
  if (engine) {
    const system = readFileSync(PROMPT_PATH, 'utf8');
    const user = renderPrompt(person, gathered);
    let raw = null;
    try {
      raw = await engine.complete({ system, user, maxTokens: 1024 });
    } catch (err) {
      reason = `engine error: ${err?.message ?? err}`;
    }
    if (raw !== null) {
      const parsed = parsePageJson(raw);
      if (!parsed.ok) reason = parsed.reason;
      else ({ kept, dropped } = groundPage(parsed.page, gathered));
    }
  } else {
    reason = 'no engine';
  }

  // QUOTE-ONLY SECTIONS: for every section the engine left empty, the
  // judgment engine picks the line that best answers it, or none. text and
  // quote are the same verbatim line, so storePage's live-row check passes by
  // construction; a quote-only page cannot be ungrounded, only empty.
  let judged = 0;
  if (jev && jev.state === 'ok' && judgments.page !== false) {
    try {
      const filled = new Set(kept.map((k) => k.section));
      const picks = (await pageJudgments(db, jev, { personKey, excerpts: gathered.excerpts, now })).kept
        .filter((p) => !filled.has(p.section));
      judged = picks.length;
      kept = [...kept, ...picks];
    } catch {
      judged = 0;
    }
  }

  if (kept.length === 0) {
    return { personKey, kept: 0, dropped: dropped.length, skipped: 0, rejected: 0, reason: reason ?? 'no grounded items' };
  }

  const result = storePage(db, { personKey, engineName: judged > 0 && kept.length === judged ? 'jev' : (engine?.name ?? 'jev'), model: engine?.model ?? jev?.model ?? 'jev', kept, now });
  return { personKey, kept: result.stored, dropped: dropped.length, skipped: result.skipped, rejected: result.rejected, judged, ...(reason ? { engineReason: reason } : {}) };
}

// Read back the built page: accepted or pending items render, rejected are
// omitted. "Latest wins" for claim_decision, same rule the rest of the review
// surface uses.
//
// ONE RECEIPT PER ITEM (review finding 16). The claim_source join used to
// fan out: a page claim that later gains a second receipt -- the same
// sentence quoted from another conversation -- returned two rows, and the
// asks/notable sections would render the same line twice (and `who`/
// `how_left` would silently keep whichever came first). claim_source has no
// surrogate key (its PK is (claim_id, context_id)), so the one kept is
// MIN(context_id): the earliest-ingested receipt, deterministic, and the
// same choice owe.mjs's B1 makes for the same reason.
export function readPersonPage(db, personKey) {
  const rows = db
    .prepare(
      `SELECT c.id AS claim_id, c.text, c.created_at, ppi.section, ppi.built_at,
              cs.quote, cs.context_id,
              (SELECT action FROM claim_decision d WHERE d.claim_id = c.id ORDER BY d.id DESC LIMIT 1) AS decision
       FROM claim c
       JOIN person_page_item ppi ON ppi.claim_id = c.id
       LEFT JOIN claim_source cs ON cs.claim_id = c.id
         AND cs.context_id = (SELECT MIN(context_id) FROM claim_source WHERE claim_id = c.id)
       WHERE c.subject = 'person' AND c.subject_person_key = ?
       ORDER BY c.created_at DESC`
    )
    .all(personKey);

  const sections = { who: null, asks: [], objection: null, how_left: null, notable: [] };
  let builtAt = null;

  for (const row of rows) {
    if (row.decision === 'reject') continue;
    const item = {
      claimId: Number(row.claim_id),
      text: row.text,
      quote: row.quote ?? null,
      contextId: row.context_id !== null && row.context_id !== undefined ? Number(row.context_id) : null,
      decision: row.decision === 'accept' ? 'accept' : 'pending',
    };
    if (builtAt === null || row.built_at > builtAt) builtAt = row.built_at;
    if (row.section === 'who' && sections.who === null) sections.who = item;
    else if (row.section === 'ask') sections.asks.push(item);
    else if (row.section === 'objection' && sections.objection === null) sections.objection = item;
    else if (row.section === 'how_left' && sections.how_left === null) sections.how_left = item;
    else if (row.section === 'notable') sections.notable.push(item);
  }
  sections.asks = sections.asks.slice(0, MAX_ASKS);
  sections.notable = sections.notable.slice(0, MAX_NOTABLE);

  return { personKey, builtAt, sections };
}
