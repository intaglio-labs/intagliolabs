// Discovery sweep (L5 step 5): a small model call per person, reading only
// the NEW lines from THAT PERSON since the last time they were swept, and
// proposing three narrow kinds of claim -- a sub-role tag, a firm, or a page
// line. Same trust lifecycle as pages.mjs and every other claim in this
// system: subject='person', stored PENDING, the owner decides.
//
// THIS IS NOT pages.mjs, and the two must not be confused. pages.mjs builds
// (or rebuilds) a whole page from everything this person has ever said;
// sweep.mjs's job is narrower and cheaper -- it exists to notice NEW things
// (a person mentions a firm for the first time, describes themself as
// raising a fund) without re-reading a person's entire history every pass.
// The two share the THEM/ME evidence discipline, the grounding boundary, and
// (for page_line proposals) the same five sections -- see SECTION_KIND,
// imported rather than redefined.
//
// eligiblePool (producer.mjs) is the WRONG scope for this file to reuse: it
// gates on quiet >= 180 days and vetoes anyone with a meeting already on the
// calendar -- i.e. it deliberately EXCLUDES the people the owner is actively
// talking to, which is exactly who an ingest sweep must keep current.
// sweepScope runs its own, much narrower SQL instead (see below).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpisodes, isQuotable } from '../memory/episodes.mjs';
import { SUB_ROLES } from '../people/subRoles.mjs';
import { isAnonymousContact } from '../people/map.mjs';
import { SECTION_KIND, alreadyStored } from './pages.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const SWEEP_VERSION = 'sweep-v1';
export const SWEEP_PROMPT_PATH = join(here, '..', '..', '..', 'prompts', 'sweep.md');

// ~1.5k tokens; tokensEst below is ceil(chars/4), the same rough estimator
// used everywhere else in this file rather than a real tokenizer -- an
// estimate for the /stats dashboard and the local call-cap check, not a
// billing number.
export const SWEEP_MAX_CHARS = 6_000;
export const SWEEP_MAX_EPISODES = 8;
export const SWEEP_BUDGET = Object.freeze({ full: 12, trickle: 3 });

const SECTIONS = new Set(Object.keys(SECTION_KIND));

export function tokensEstFor(text) {
  return Math.ceil(String(text ?? '').length / 4);
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

// The sweep's OWN scope query -- deliberately not eligiblePool
// (producer.mjs), whose quiet-days gate and future-meeting veto exclude
// exactly the people this ingest sweep exists to keep current (see the
// header note above). Gates: at least one direct (non-room) authored
// message ever, AND (a business relationship OR at least one in-person
// meeting), NOT suppressed. No quiet gate, no future-meeting veto, and
// (unlike eligiblePool) no romantic/family exclusion is needed because the
// business/met_in_person gate already narrows past them.
export function sweepScope(db, { now = Date.now() } = {}) {
  const rows = db
    .prepare(
      `SELECT p.person_key AS personKey, p.display_name AS name, p.role AS role, COALESCE(p.sub_roles, '[]') AS subRolesJson
       FROM people p
       WHERE (p.role = 'business' OR p.met_in_person > 0)
         AND EXISTS (
           SELECT 1 FROM person_event_links pel
           WHERE pel.person_key = p.person_key AND pel.authored = 1 AND pel.room = 0
         )
         AND p.person_key NOT IN (SELECT person_key FROM rm_suppression)`
    )
    .all();

  const maxIdStmt = db.prepare(
    `SELECT MAX(pel.context_id) AS maxId FROM person_event_links pel
     WHERE pel.person_key = ? AND pel.authored = 1 AND pel.room = 0`
  );
  const cursorStmt = db.prepare(
    `SELECT swept_through_context_id FROM person_sweep_cursor WHERE person_key = ?`
  );

  const out = [];
  for (const row of rows) {
    // Same anonymity test the eligibility producer uses (people/map.mjs), so
    // the two surfaces never disagree about who counts as a real,
    // by-name-addressable person.
    if (isAnonymousContact({ name: row.name, key: row.personKey })) continue;
    const maxRow = maxIdStmt.get(row.personKey);
    if (maxRow?.maxId === null || maxRow?.maxId === undefined) continue; // defensive: the EXISTS gate above should make this unreachable
    const cursorRow = cursorStmt.get(row.personKey);
    out.push({
      personKey: row.personKey,
      name: row.name,
      role: row.role,
      subRoles: parseSubRoles(row.subRolesJson),
      maxAuthoredContextId: Number(maxRow.maxId),
      cursor: cursorRow ? Number(cursorRow.swept_through_context_id) : 0,
    });
  }
  return out;
}

function isReceiptItem(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && typeof v.text === 'string' && v.text.trim().length > 0
    && typeof v.quote === 'string' && v.quote.length > 0;
}

// Gather only what changed: the same episode grouping and THEM/ME labelling
// gatherPersonContext (pages.mjs) uses, but restricted to episodes that
// contain at least one authored (THEM) row past `cursor` -- an episode
// entirely before the cursor has nothing new to sweep, even if the owner's
// own reply (never authored, never THEM) landed inside it after the cursor.
// The 8 most recent qualifying episodes, budgeted to maxChars, most-recent
// episode consumed FIRST so an old, long-running thread cannot starve a
// short new one out of the budget -- same ordering discipline as
// gatherPersonContext.
export function newRowsFor(db, personKey, cursor, { maxEpisodes = SWEEP_MAX_EPISODES, maxChars = SWEEP_MAX_CHARS } = {}) {
  const linked = db
    .prepare(`SELECT DISTINCT context_id FROM person_event_links WHERE person_key = ? AND room = 0`)
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

  const authoredIds = new Set(
    db
      .prepare(`SELECT context_id FROM person_event_links WHERE person_key = ? AND authored = 1 AND room = 0`)
      .all(personKey)
      .map((r) => Number(r.context_id))
  );

  const episodes = buildEpisodes(rows, { now: Date.now() })
    .slice()
    .sort((a, b) => b.started_at - a.started_at); // most recent conversation first

  const cursorId = Number.isFinite(cursor) ? Number(cursor) : 0;
  const newEpisodes = episodes.filter((ep) =>
    ep.members.some((m) => authoredIds.has(Number(m.row.id)) && Number(m.row.id) > cursorId)
  );
  const chosen = newEpisodes.slice(0, maxEpisodes);

  const excerpts = [];
  let charBudget = maxChars;
  let maxContextId = cursorId;
  outer: for (const ep of chosen) {
    for (const member of ep.members) {
      const row = member.row;
      const speaker = authoredIds.has(Number(row.id))
        ? 'THEM'
        : isQuotable(row)
          ? 'ME'
          : null;
      // Same polarity guard as gatherPersonContext: a line that is neither
      // this person's own nor the owner's is dropped rather than mislabeled.
      if (speaker === null) continue;
      const text = String(row.text ?? '');
      if (text.length === 0) continue;
      if (text.length > charBudget) {
        if (excerpts.length === 0) {
          excerpts.push({ contextId: Number(row.id), speaker, text: text.slice(0, charBudget), ts: Number(row.ts) });
          maxContextId = Math.max(maxContextId, Number(row.id));
        }
        break outer;
      }
      charBudget -= text.length;
      excerpts.push({ contextId: Number(row.id), speaker, text, ts: Number(row.ts) });
      maxContextId = Math.max(maxContextId, Number(row.id));
    }
  }
  // Oldest-first within the most-recent-first episode selection above, same
  // reasoning as gatherPersonContext: a reader sees each conversation in the
  // order it happened even though older conversations were dropped first.
  excerpts.sort((a, b) => a.ts - b.ts);

  const meetingTitles = [];
  try {
    const meetings = db
      .prepare(
        `SELECT DISTINCT c.id, c.text, c.ts FROM context c
         JOIN json_each(c.meta, '$.attendees') je
         JOIN person_identifiers pi ON pi.identifier = lower(json_extract(je.value, '$.email'))
         WHERE c.source = 'calendar' AND pi.person_key = ? AND json_valid(c.meta) AND c.ts > ?
         ORDER BY c.ts DESC LIMIT 20`
      )
      .all(personKey, Date.now());
    for (const m of meetings) meetingTitles.push(String(m.text ?? '').slice(0, 200));
  } catch {
    // person_identifiers or calendar rows may not exist on a fresh/partial
    // projection; meetings are supplementary context, not required.
  }

  // The first THEM line whose bare text contains `quote`, verbatim -- same
  // "receipt, not copied text" closure as gatherPersonContext's.
  function findQuoteContextId(quote) {
    if (typeof quote !== 'string' || quote.length === 0) return null;
    for (const e of excerpts) {
      if (e.speaker === 'THEM' && e.text.includes(quote)) return e.contextId;
    }
    return null;
  }

  return { excerpts, meetingTitles, findQuoteContextId, maxContextId, episodeCount: chosen.length };
}

// Pure grounding, no DB: mirrors groundPage's shape (pages.mjs) but over
// sweep.md's three-kind output instead of a five-section page. Dedupe
// against already-stored claims (rule 7 in the design) is NOT done here --
// same split as pages.mjs, where alreadyStored is checked in storePage, not
// groundPage, because it needs a live database and groundSweep does not take
// one. storeSweep re-checks every rule below against the LIVE context row,
// plus does the dedupe: a client (this function) is not a boundary.
export function groundSweep(proposal, gathered) {
  const kept = [];
  const dropped = [];
  const noteDrop = (kind, reason) => dropped.push({ kind, reason });

  const tags = Array.isArray(proposal?.tags) ? proposal.tags.slice(0, 2) : [];
  for (const item of tags) {
    if (!isReceiptItem(item) || typeof item.tag !== 'string') {
      noteDrop('sub_role', 'missing text/quote/tag');
      continue;
    }
    if (!SUB_ROLES.includes(item.tag)) {
      noteDrop('sub_role', 'tag is not in the closed sub-role set');
      continue;
    }
    const contextId = gathered.findQuoteContextId(item.quote);
    if (contextId === null) {
      noteDrop('sub_role', 'quote is not a verbatim THEM excerpt');
      continue;
    }
    kept.push({ kind: 'sub_role', value: item.tag, text: item.text.trim(), quote: item.quote, contextId });
  }

  const firm = proposal?.firm;
  if (firm !== null && firm !== undefined) {
    if (!isReceiptItem(firm) || typeof firm.name !== 'string') {
      noteDrop('firm', 'missing text/quote/name');
    } else {
      const contextId = gathered.findQuoteContextId(firm.quote);
      if (contextId === null) {
        noteDrop('firm', 'quote is not a verbatim THEM excerpt');
      } else {
        const name = firm.name.trim();
        // Stronger than a page_line's rule: the firm name must be a verbatim
        // substring of its OWN quote, not merely present somewhere in the
        // excerpts -- see prompts/sweep.md's firm section.
        if (name.length < 2 || name.length > 120 || !firm.quote.includes(name)) {
          noteDrop('firm', "firm name is not a verbatim substring of its own quote");
        } else {
          kept.push({ kind: 'firm', value: name, text: firm.text.trim(), quote: firm.quote, contextId });
        }
      }
    }
  }

  const pageLines = Array.isArray(proposal?.page_lines) ? proposal.page_lines.slice(0, 3) : [];
  for (const item of pageLines) {
    if (!isReceiptItem(item) || typeof item.section !== 'string') {
      noteDrop('page_line', 'missing text/quote/section');
      continue;
    }
    if (!SECTIONS.has(item.section)) {
      noteDrop('page_line', 'section is not one of the five');
      continue;
    }
    const contextId = gathered.findQuoteContextId(item.quote);
    if (contextId === null) {
      noteDrop('page_line', 'quote is not a verbatim THEM excerpt');
      continue;
    }
    kept.push({ kind: 'page_line', section: item.section, text: item.text.trim(), quote: item.quote, contextId });
  }

  return { kept, dropped };
}

// Rule 7 (dedupe) for a sub_role or firm proposal: skip if a
// person_sweep_proposal with the same (subject_person_key, kind, value)
// already exists and is either undecided or accepted -- a rejected or
// retracted one does NOT block a fresh proposal, so a tag the owner turned
// down once is not permanently unreachable if the person's own words support
// it again later. "Latest decision wins", same rule readPersonPage uses.
function alreadyProposed(db, personKey, kind, value) {
  const rows = db
    .prepare(
      `SELECT (SELECT d.action FROM claim_decision d WHERE d.claim_id = psp.claim_id ORDER BY d.id DESC LIMIT 1) AS decision
       FROM person_sweep_proposal psp
       JOIN claim c ON c.id = psp.claim_id
       WHERE c.subject = 'person' AND c.subject_person_key = ? AND psp.kind = ? AND psp.value = ?`
    )
    .all(personKey, kind, value);
  return rows.some((r) => r.decision === null || r.decision === undefined || r.decision === 'accept');
}

// gather -> ground happen upstream (newRowsFor + groundSweep); this is the
// trusted apply path, mirroring storePage (pages.mjs): EVERY grounding rule
// is re-checked here against the LIVE context row, not the in-memory
// gathered snapshot, because the row can change between gather and store --
// a client (groundSweep) is not a boundary. `engineName`/`model` are accepted
// for signature symmetry with storePage; unlike storePage this function does
// not create the distill_run row itself (conflict #7: the sweep writes ONE
// distill_run row per PASS, not per person -- see runSweepPass), so they are
// otherwise unused here.
export function storeSweep(db, { personKey, engineName, model, kept, sweepRunId, distillRunId, now = Date.now() }) {
  void engineName;
  void model;
  const insClaim = db.prepare(
    `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
     VALUES (?, 'person', ?, ?, ?, ?, NULL, NULL, ?)`
  );
  const insSource = db.prepare(
    `INSERT INTO claim_source(claim_id, context_id, source, entity_id, content_hash, quote)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insProposal = db.prepare(
    `INSERT INTO person_sweep_proposal(claim_id, run_id, kind, value, applied_at) VALUES (?, ?, ?, ?, NULL)`
  );
  const insItem = db.prepare(`INSERT INTO person_page_item(claim_id, section, built_at) VALUES (?, ?, ?)`);
  const getRow = db.prepare('SELECT id, ts, source, entity_id, content_hash, text FROM context WHERE id = ?');

  let stored = 0;
  let skipped = 0;
  let rejected = 0;

  for (const item of kept) {
    if (item.kind === 'page_line') {
      if (alreadyStored(db, personKey, item.section, item.text)) {
        skipped += 1;
        continue;
      }
    } else if (alreadyProposed(db, personKey, item.kind, item.value)) {
      skipped += 1;
      continue;
    }

    const row = getRow.get(item.contextId);
    // Re-checked against the LIVE row: the row could have been edited or
    // deleted between gather and store -- same authoritative-server-check
    // discipline as applyMemoryBatch and storePage. This alone also covers a
    // firm name that vanished from the live row: if the quote is gone, so is
    // whatever substring of it used to be the firm name.
    if (row === undefined || !String(row.text).includes(item.quote)) {
      rejected += 1;
      continue;
    }

    const kind = item.kind === 'page_line' ? SECTION_KIND[item.section] : 'fact';
    const claimId = Number(
      insClaim.run(distillRunId, personKey, kind, item.text, row.ts ?? null, now).lastInsertRowid
    );
    insSource.run(claimId, Number(row.id), String(row.source), row.entity_id ?? null, row.content_hash ?? null, item.quote);
    insProposal.run(claimId, sweepRunId, item.kind, item.kind === 'page_line' ? null : item.value);
    if (item.kind === 'page_line') insItem.run(claimId, item.section, now);
    stored += 1;
  }

  return { stored, skipped, rejected };
}
