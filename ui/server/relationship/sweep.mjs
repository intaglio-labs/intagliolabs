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

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpisodes, isQuotable } from '../memory/episodes.mjs';
import { SUB_ROLES } from '../people/subRoles.mjs';
import { isAnonymousContact } from '../people/map.mjs';
import { markPersonSubRoles } from '../people/owner.mjs';
import { PERSON_SOURCE_POLICY } from '../people/graph.mjs';
import { SECTION_KIND, alreadyStored } from './pages.mjs';

// The sources a person could actually have WRITTEN a message in, past tense
// -- what the candidate gate (sweepScope's max-id query) and newRowsFor must
// agree on, or a row that counts for one and never shows for the other loops
// a person forever (audit, 2026-09: a 'linkedin' context row -- an imported
// connection record, linked authored=1 room=0 -- sat past a person's cursor
// while buildEpisodes (memory/episodes.mjs) never yields a quotable episode
// for it at all, so the person was a candidate every pass, the model was
// never shown anything, and the cursor could never reach past it).
//
// Derived from PERSON_SOURCE_POLICY (people/graph.mjs), whose 'participant'
// sources may mint or strengthen a person -- but 'calendar' and 'linkedin'
// are participant sources for IDENTITY purposes only (an attendee row, an
// imported connection) and never carry a message a person authored to the
// owner: a calendar row has no is_from_me flag for isQuotable to key off of,
// and a LinkedIn import row is not a message at all. buildEpisodes drops any
// episode with zero quotable rows, so neither ever reaches newRowsFor's
// excerpts regardless of this constant -- SWEEP_SOURCES exists so the
// candidate gate reaches the same conclusion BEFORE a model would ever be
// asked, not after.
export const SWEEP_SOURCES = Object.freeze(
  Object.entries(PERSON_SOURCE_POLICY)
    .filter(([source, policy]) => policy === 'participant' && source !== 'calendar' && source !== 'linkedin')
    .map(([source]) => source)
);

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

// A LOCAL rolling call cap over the sweep's own run log (conflict #4: PCC
// does not exist in this repo, so there is no quota API to ask -- this is
// what "PCC quota approaching" becomes in practice). Overridable via
// config.relationshipMemory.sweepDailyCallCap.
export const SWEEP_DAILY_CALL_CAP_DEFAULT = 200;

// Matches hermes.mjs's own PAGE_BUILD_PAUSE_MS -- the same "do not hammer
// the one local model" pause between people, applied here to sweeping
// instead of page-building. Not imported (PAGE_BUILD_PAUSE_MS is private to
// hermes.mjs); duplicated as a constant instead.
const SWEEP_PAUSE_MS = 1000;
const DAY = 86_400_000;

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
}

function promptSha(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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

  // Joined against context and filtered to SWEEP_SOURCES so this agrees with
  // newRowsFor about which rows count: a person whose only authored row past
  // the cursor is a non-message source (a LinkedIn import, a calendar
  // attendee row) must not look like fresh, unswept history here, because
  // newRowsFor's episode builder can never show that row (see SWEEP_SOURCES
  // above).
  const sourcePlaceholders = SWEEP_SOURCES.map(() => '?').join(',');
  const maxIdStmt = db.prepare(
    `SELECT MAX(pel.context_id) AS maxId FROM person_event_links pel
     JOIN context c ON c.id = pel.context_id
     WHERE pel.person_key = ? AND pel.authored = 1 AND pel.room = 0
       AND c.source IN (${sourcePlaceholders})`
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
    const maxRow = maxIdStmt.get(row.personKey, ...SWEEP_SOURCES);
    // No longer purely defensive: the EXISTS gate above counts ANY authored
    // row (any source), but this now filters to SWEEP_SOURCES -- so a person
    // whose only direct row ever was a non-message source (e.g. every
    // authored row is 'linkedin') legitimately has no message-like history
    // and is skipped here rather than becoming a permanent zero-call
    // candidate.
    if (maxRow?.maxId === null || maxRow?.maxId === undefined) continue;
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
// The 8 most recent qualifying episodes, budgeted to maxChars, filled
// NEWEST-ROW-FIRST across all of them (not most-recent-episode-first): every
// candidate row from the chosen episodes is pooled and sorted by context id
// (monotonic on insert) before the budget is applied, so a person whose new
// history overflows the budget always has their newest authored rows
// admitted rather than starved by an old, long-running thread that happens
// to sort first. The backlog of a heavy person is bounded by the budget BY
// DESIGN -- it is never the whole history; older rows beyond the budget are
// skipped, not replayed. Because maxContextId (below) is computed over shown
// rows only, and newest-first admission means the shown rows' max is now
// also the person's newest authored row among the chosen episodes, the
// cursor lands on it and a second pass finds nothing new to sweep. Admitted
// rows are re-sorted chronologically afterward for display, same as
// gatherPersonContext.
export function newRowsFor(db, personKey, cursor, { maxEpisodes = SWEEP_MAX_EPISODES, maxChars = SWEEP_MAX_CHARS } = {}) {
  // Joined against context and filtered to SWEEP_SOURCES, same as
  // sweepScope's max-id query above -- a row the builder would never show
  // (a non-message source) is excluded from the candidate pool here too,
  // rather than being pooled and then silently dropped by buildEpisodes'
  // own zero-quotable-episode rule downstream.
  const sourcePlaceholders = SWEEP_SOURCES.map(() => '?').join(',');
  const linked = db
    .prepare(
      `SELECT DISTINCT pel.context_id AS context_id
       FROM person_event_links pel
       JOIN context c ON c.id = pel.context_id
       WHERE pel.person_key = ? AND pel.room = 0 AND c.source IN (${sourcePlaceholders})`
    )
    .all(personKey, ...SWEEP_SOURCES);
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

  // Pool every candidate row from the chosen episodes, then sort newest-first
  // by context id (monotonic on insert) so budget admission below always
  // reaches a heavy person's newest rows first, regardless of which episode
  // they landed in.
  const candidates = [];
  for (const ep of chosen) {
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
      candidates.push({ contextId: Number(row.id), speaker, text, ts: Number(row.ts) });
    }
  }
  candidates.sort((a, b) => b.contextId - a.contextId);

  const excerpts = [];
  let charBudget = maxChars;
  let maxContextId = cursorId;
  for (const c of candidates) {
    if (c.text.length > charBudget) {
      // Guarantee at least one excerpt even if the single newest row alone
      // overflows the whole budget, same guard the previous per-episode
      // loop had.
      if (excerpts.length === 0) {
        excerpts.push({ contextId: c.contextId, speaker: c.speaker, text: c.text.slice(0, charBudget), ts: c.ts });
        maxContextId = Math.max(maxContextId, c.contextId);
      }
      break;
    }
    charBudget -= c.text.length;
    excerpts.push({ contextId: c.contextId, speaker: c.speaker, text: c.text, ts: c.ts });
    maxContextId = Math.max(maxContextId, c.contextId);
  }
  // Oldest-first for display, same reasoning as gatherPersonContext: a
  // reader sees each conversation in the order it happened even though the
  // admission order above (newest-first) is what decided which rows made it
  // into the budget.
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

function renderSweepPrompt(candidate, gathered) {
  const subRoles = Array.isArray(candidate.subRoles) ? candidate.subRoles : [];
  const roleLine = candidate.role ? ` (${candidate.role}${subRoles.length ? `, ${subRoles.join('/')}` : ''})` : '';
  const lines = gathered.excerpts.map((e, i) => `${i + 1}   ${e.speaker}: ${e.text}`);
  const meetings = gathered.meetingTitles.length
    ? `\nMeetings attended together:\n${gathered.meetingTitles.map((t) => `- ${t}`).join('\n')}\n`
    : '';
  return (
    `Person: ${candidate.name}${roleLine}\n` +
    `BEGIN EXCERPTS\n${lines.join('\n')}\nEND EXCERPTS\n` +
    meetings
  );
}

function parseSweepJson(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'no content' };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'no JSON object in output' };
  try {
    return { ok: true, proposal: JSON.parse(body.slice(start, end + 1)) };
  } catch {
    return { ok: false, reason: 'output is not valid JSON' };
  }
}

function isEmptyProposal(proposal) {
  const tags = Array.isArray(proposal?.tags) ? proposal.tags : [];
  const pageLines = Array.isArray(proposal?.page_lines) ? proposal.page_lines : [];
  const firm = proposal?.firm;
  return tags.length === 0 && pageLines.length === 0 && (firm === null || firm === undefined);
}

// gather -> prompt -> engine -> parse -> ground -> store, one person. Status
// is one of person_sweep_cursor.last_status's five values:
//   'proposed'     -- at least one item survived grounding and was stored.
//   'empty'        -- the model was asked and, correctly, found nothing (the
//                     literal {"tags":[],"firm":null,"page_lines":[]} answer
//                     prompts/sweep.md calls "a normal, expected answer").
//   'ungrounded'    -- the model proposed something, but every item failed
//                     grounding (a hallucinated quote, a tag outside the
//                     closed set). Distinct from 'empty' because it names a
//                     different failure mode even though both advance the
//                     cursor the same way (see runSweepPass).
//   'engine-error'  -- the model call itself threw.
//   'parse-error'   -- the model's output was not the expected JSON shape.
// Belt (see SWEEP_SOURCES above, and the caller below): the person's max
// authored context id over EVERY source, not just SWEEP_SOURCES -- used only
// once newRowsFor has already come back with nothing to show, so the cursor
// can jump past a row that yields no excerpt for ANY reason (a source
// SWEEP_SOURCES does not yet exclude, a future connector, anything else that
// makes buildEpisodes drop the episode) rather than re-offering that same
// row as a candidate on every future pass.
function maxAuthoredContextIdAnySource(db, personKey) {
  const row = db
    .prepare(
      `SELECT MAX(context_id) AS maxId FROM person_event_links
       WHERE person_key = ? AND authored = 1 AND room = 0`
    )
    .get(personKey);
  return row?.maxId === null || row?.maxId === undefined ? null : Number(row.maxId);
}

export async function sweepPerson(db, engine, candidate, { sweepRunId, distillRunId, now = Date.now() } = {}) {
  const gathered = newRowsFor(db, candidate.personKey, candidate.cursor, {
    maxEpisodes: SWEEP_MAX_EPISODES, maxChars: SWEEP_MAX_CHARS,
  });
  if (gathered.excerpts.filter((e) => e.speaker === 'THEM').length === 0) {
    // A row that yields no excerpt has still been evaluated and found
    // unshowable -- advance past ALL of this person's authored rows (every
    // source, not just what newRowsFor could show) so a mismatch between the
    // candidate gate and the episode builder can never strand this person as
    // a permanent zero-call candidate, even one SWEEP_SOURCES does not
    // anticipate. No engine call: there is nothing to show it.
    const anySourceMax = maxAuthoredContextIdAnySource(db, candidate.personKey);
    const maxContextId = Math.max(gathered.maxContextId, anySourceMax ?? gathered.maxContextId);
    return {
      personKey: candidate.personKey, calls: 0, proposed: 0, dropped: 0, tokensEst: 0,
      status: 'empty', maxContextId,
    };
  }

  const system = readFileSync(SWEEP_PROMPT_PATH, 'utf8');
  const user = renderSweepPrompt(candidate, gathered);
  const tokensEst = tokensEstFor(system) + tokensEstFor(user);

  let raw;
  try {
    raw = await engine.complete({ system, user, maxTokens: 512 });
  } catch {
    return {
      personKey: candidate.personKey, calls: 1, proposed: 0, dropped: 0, tokensEst,
      status: 'engine-error', maxContextId: gathered.maxContextId,
    };
  }

  const parsed = parseSweepJson(raw);
  if (!parsed.ok) {
    return {
      personKey: candidate.personKey, calls: 1, proposed: 0, dropped: 0, tokensEst,
      status: 'parse-error', maxContextId: gathered.maxContextId,
    };
  }

  const { kept, dropped } = groundSweep(parsed.proposal, gathered);
  if (kept.length === 0) {
    const status = isEmptyProposal(parsed.proposal) ? 'empty' : 'ungrounded';
    return {
      personKey: candidate.personKey, calls: 1, proposed: 0, dropped: dropped.length, tokensEst,
      status, maxContextId: gathered.maxContextId,
    };
  }

  const result = storeSweep(db, {
    personKey: candidate.personKey, engineName: engine.name, model: engine.model,
    kept, sweepRunId, distillRunId, now,
  });
  return {
    personKey: candidate.personKey, calls: 1, proposed: result.stored, dropped: dropped.length,
    tokensEst, status: 'proposed', maxContextId: gathered.maxContextId,
  };
}

// policy carries the same per-process relationship holder every other
// relationship route reads (policy.relationshipHolder.__relationship, or
// policy itself when no holder wraps it -- the same `?? policy` fallback
// hermes.mjs's own relationshipState/startPageBuilds use), so a page build
// in progress and a sweep in progress see each other through the one shared
// flag pair without this module reaching into hermes.mjs's private state.
function relFlags(policy) {
  const holder = policy?.relationshipHolder ?? policy ?? {};
  return holder.__relationship ?? holder;
}

// Skip order (each writing a person_sweep_run row status='skipped', never a
// silent return -- see runSweepPass): 'disabled' is Swift-side, before the
// node process is even spawned, and never appears here. An ABSENT power
// field is unknown, not a skip -- a terminal run with no power telemetry at
// all must still work.
export function sweepGate(db, policy, { powerMode = 'trickle', battery = null, onAc = null, thermal = null, engine } = {}) {
  void powerMode;
  if (onAc === false && typeof battery === 'number' && battery < 40) {
    return { ok: false, reason: 'battery' };
  }
  if (thermal === 'serious' || thermal === 'critical') {
    return { ok: false, reason: 'thermal' };
  }
  const rel = relFlags(policy);
  if (rel?.pagesBuildingActive || rel?.sweepActive) {
    return { ok: false, reason: 'busy-model' };
  }
  // LOCAL cap (conflict #4), llama exempt: a loopback model has no external
  // quota to approach.
  if (engine !== 'llama') {
    const cap = Number(policy?.relationshipMemory?.sweepDailyCallCap ?? SWEEP_DAILY_CALL_CAP_DEFAULT);
    const since = Date.now() - DAY;
    const used = Number(
      db.prepare('SELECT COALESCE(SUM(model_calls), 0) AS n FROM person_sweep_run WHERE started_at >= ?')
        .get(since).n
    );
    if (used >= 0.9 * cap) return { ok: false, reason: 'quota' };
  }
  const scope = sweepScope(db, { now: Date.now() });
  if (scope.length === 0) return { ok: false, reason: 'no-scope' };
  return { ok: true, reason: null };
}

function insertSkippedRun(db, { now, powerMode, engineName, budget, scopeSize, reason }) {
  const id = Number(
    db.prepare(
      `INSERT INTO person_sweep_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
         candidates, swept, model_calls, proposed, dropped, tokens_est, skip_reason, status)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, 'skipped')`
    ).run(now, now, powerMode, engineName, budget, scopeSize, reason).lastInsertRowid
  );
  return db.prepare('SELECT * FROM person_sweep_run WHERE id = ?').get(id);
}

// One pass: gate -> scope -> (skip, or) one distill_run row for the WHOLE
// pass (conflict #7 -- unlike storePage, which writes one per person) ->
// sweepPerson in sequence, one BEGIN..COMMIT cursor write per person
// (advance on proposed/empty/ungrounded, hold on engine-error/parse-error --
// see section 5 of the design and sweepPerson's status doc above), paused
// SWEEP_PAUSE_MS between people. Returns the person_sweep_run row.
export async function runSweepPass(db, engine, policy, {
  powerMode = 'trickle', battery = null, onAc = null, thermal = null, budget, now = Date.now(),
} = {}) {
  const effectiveBudget = Number.isInteger(budget) ? budget : (SWEEP_BUDGET[powerMode] ?? SWEEP_BUDGET.trickle);
  const engineName = engine?.name ?? 'unknown';

  const gate = sweepGate(db, policy, { powerMode, battery, onAc, thermal, engine: engineName });
  const scope = sweepScope(db, { now });
  if (!gate.ok) {
    return insertSkippedRun(db, {
      now, powerMode, engineName, budget: effectiveBudget, scopeSize: scope.length, reason: gate.reason,
    });
  }

  // The pre-model, arithmetic gate (section 5): a candidate whose max
  // authored context id is already at or below its cursor has nothing new,
  // and is dropped BEFORE newRowsFor and before any engine call.
  const candidates = scope.filter((c) => c.maxAuthoredContextId > c.cursor).slice(0, effectiveBudget);
  if (candidates.length === 0) {
    return insertSkippedRun(db, {
      now, powerMode, engineName, budget: effectiveBudget, scopeSize: scope.length, reason: 'no-new-rows',
    });
  }

  // rel.sweepActive is owned by THIS pass from here on, set only now that
  // sweepGate's own busy-model read of the same flag has already passed --
  // setting it any earlier (e.g. in the HTTP route, before calling this
  // function) would make sweepGate see its own pass as "already running" and
  // skip itself on every call. Cleared in the finally below no matter how
  // the pass ends, so a thrown error never wedges the flag on.
  const rel = relFlags(policy);
  rel.sweepActive = true;
  try {
    const promptText = readFileSync(SWEEP_PROMPT_PATH, 'utf8');
    const sha = promptSha(promptText);
    const distillRunId = Number(
      db.prepare(
        `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at)
         VALUES (?, ?, ?, '{}', 'on', ?, 0, 'running', ?, NULL)`
      ).run(`${engineName}:${engine?.model ?? 'unknown'}`, SWEEP_PROMPT_PATH, sha, candidates.length, now).lastInsertRowid
    );
    const sweepRunId = Number(
      db.prepare(
        `INSERT INTO person_sweep_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
           candidates, swept, model_calls, proposed, dropped, tokens_est, skip_reason, status)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL, 'running')`
      ).run(distillRunId, now, powerMode, engineName, effectiveBudget, scope.length, candidates.length).lastInsertRowid
    );

    const upsertCursor = db.prepare(
      `INSERT INTO person_sweep_cursor(person_key, swept_through_context_id, last_swept_at, last_status, proposals)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(person_key) DO UPDATE SET swept_through_context_id = excluded.swept_through_context_id,
         last_swept_at = excluded.last_swept_at, last_status = excluded.last_status,
         proposals = person_sweep_cursor.proposals + excluded.proposals`
    );
    const holdCursor = db.prepare(
      `INSERT INTO person_sweep_cursor(person_key, swept_through_context_id, last_swept_at, last_status, proposals)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(person_key) DO UPDATE SET last_swept_at = excluded.last_swept_at, last_status = excluded.last_status`
    );

    let swept = 0;
    let modelCalls = 0;
    let proposed = 0;
    let dropped = 0;
    let tokensEst = 0;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const result = await sweepPerson(db, engine, candidate, { sweepRunId, distillRunId, now });
      modelCalls += result.calls;
      proposed += result.proposed;
      dropped += result.dropped;
      tokensEst += result.tokensEst;
      swept += 1;

      // proposed/empty/ungrounded ALL advance: the model read those rows, and
      // re-asking costs the same and answers the same (section 5). Only a
      // failure to get a usable answer at all (engine-error/parse-error) holds
      // the cursor, so the same rows are offered again next pass.
      const advance = result.status === 'proposed' || result.status === 'empty' || result.status === 'ungrounded';
      db.exec('BEGIN');
      try {
        if (advance) {
          upsertCursor.run(candidate.personKey, result.maxContextId, now, result.status, result.proposed);
        } else {
          holdCursor.run(candidate.personKey, candidate.cursor, now, result.status);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      if (i < candidates.length - 1) await sleep(SWEEP_PAUSE_MS);
    }

    db.prepare(
      `UPDATE person_sweep_run SET ended_at = ?, swept = ?, model_calls = ?, proposed = ?, dropped = ?, tokens_est = ?, status = 'complete' WHERE id = ?`
    ).run(Date.now(), swept, modelCalls, proposed, dropped, tokensEst, sweepRunId);
    db.prepare("UPDATE distill_run SET claims_out = ?, status = 'complete', ended_at = ? WHERE id = ?")
      .run(proposed, Date.now(), distillRunId);

    return db.prepare('SELECT * FROM person_sweep_run WHERE id = ?').get(sweepRunId);
  } finally {
    rel.sweepActive = false;
  }
}

// Called from the ROUTE (/admin/memory/decide), NOT from inside decideClaim
// itself -- decideClaim's signature is pinned by its own tests, and
// decideClaim runs first regardless, so a projection failure here can never
// lose the owner's decision (already recorded in claim_decision by the time
// this runs).
//
// A claim_id that is not a sweep proposal at all (an ordinary distilled
// claim, a page item) is the common case and a cheap no-op: one indexed
// lookup, nothing more.
//
// reject/retract: claim_decision alone (already written) is the whole
// story -- nothing here overrides a person or a firm on a reject.
//
// accept, kind 'sub_role': unions the tag into the CURRENT people.sub_roles
// (a live read, not a re-derivation) and writes it as an owner override via
// markPersonSubRoles -- union, not replace, so accepting a sweep-proposed
// tag can never drop a tag the LinkedIn importer or an earlier owner
// correction already set. Guarded by applied_at rather than re-checking the
// union's effect: accepting the same proposal twice is a no-op, not a
// second write, whether or not a projection rebuild happened in between.
//
// accept, kind 'firm': stamps applied_at only. firmOf() (people/firms.mjs)
// derives a person's firm at READ time; a persisted override map for a
// sweep-proposed firm name is its own future step, not built here.
//
// accept, kind 'page_line': nothing extra -- the claim's own acceptance
// (already written by decideClaim) is the whole effect; it renders through
// the existing person_page_item / readPersonPage machinery unchanged.
//
// DEVIATION: the design has this function call `rebuildPeopleCore(db)`
// directly after markPersonSubRoles. rebuildPeopleCore is private to
// hermes.mjs (never exported), and importing it here would mean sweep.mjs
// importing back from the very file that imports sweep.mjs -- a circular
// import that would work today only by accident of call timing. Instead
// this function returns `rebuildNeeded: true` exactly when a sub_role
// union actually happened, and the /admin/memory/decide route (which
// already has rebuildPeopleCore in scope, the same way its /people/role and
// /people/sub-roles routes do) performs the rebuild itself when that flag
// comes back true.
export function applySweepDecision(db, policy, { claimId, action, configPath } = {}) {
  void policy;
  if (!Number.isInteger(claimId)) return { applied: false, kind: null, rebuildNeeded: false };

  const proposal = db
    .prepare(
      `SELECT psp.kind AS kind, psp.value AS value, psp.applied_at AS appliedAt, c.subject_person_key AS personKey
       FROM person_sweep_proposal psp JOIN claim c ON c.id = psp.claim_id
       WHERE psp.claim_id = ?`
    )
    .get(claimId);
  if (!proposal) return { applied: false, kind: null, rebuildNeeded: false };

  if (action !== 'accept') {
    return { applied: false, kind: proposal.kind, rebuildNeeded: false };
  }
  if (proposal.appliedAt !== null && proposal.appliedAt !== undefined) {
    return { applied: false, kind: proposal.kind, rebuildNeeded: false };
  }

  let rebuildNeeded = false;
  if (proposal.kind === 'sub_role' && SUB_ROLES.includes(proposal.value)) {
    const row = db.prepare('SELECT sub_roles FROM people WHERE person_key = ?').get(proposal.personKey);
    const current = parseSubRoles(row?.sub_roles);
    const unioned = [...new Set([...current, proposal.value])].sort();
    markPersonSubRoles({
      key: proposal.personKey, subRoles: unioned,
      ...(configPath ? { configPath } : {}),
    });
    rebuildNeeded = true;
  }

  db.prepare('UPDATE person_sweep_proposal SET applied_at = ? WHERE claim_id = ?').run(Date.now(), claimId);
  return { applied: true, kind: proposal.kind, rebuildNeeded };
}

// For /stats' `sweep` key (hermes.mjs) and the desk's one-line status. Every
// number here is a plain aggregate over person_sweep_cursor/_run and
// person_sweep_proposal -- no engine call, no scope-widening side effect.
export function sweepStatus(db) {
  const scope = sweepScope(db, { now: Date.now() }).length;
  const swept = Number(db.prepare('SELECT COUNT(*) AS n FROM person_sweep_cursor').get().n);
  const pending = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM person_sweep_proposal psp
         JOIN claim c ON c.id = psp.claim_id
         WHERE NOT EXISTS (SELECT 1 FROM claim_decision d WHERE d.claim_id = c.id)`
      )
      .get().n
  );
  const last = db.prepare('SELECT * FROM person_sweep_run ORDER BY id DESC LIMIT 1').get();
  const since = Date.now() - DAY;
  const agg = db
    .prepare(
      'SELECT COALESCE(SUM(tokens_est), 0) AS tok, COALESCE(SUM(model_calls), 0) AS calls ' +
        'FROM person_sweep_run WHERE started_at >= ?'
    )
    .get(since);

  return {
    scope,
    swept,
    pending,
    lastPassAt: last?.started_at ?? null,
    lastPassStatus: last?.status ?? null,
    lastSkipReason: last?.skip_reason ?? null,
    budget: last?.budget ?? null,
    powerMode: last?.power_mode ?? null,
    engine: last?.engine ?? null,
    tokensEst24h: Number(agg.tok),
    calls24h: Number(agg.calls),
    callCap: SWEEP_DAILY_CALL_CAP_DEFAULT,
  };
}
