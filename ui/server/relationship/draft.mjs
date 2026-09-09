// Drafted messages (L5 mode-picker follow-on, part 2): a card's own
// "suggested message", on demand rather than on every serve, cached against
// the snapshot it was drafted for. Same trust discipline as person pages
// (pages.mjs) in spirit -- a model call, held to rules before it reaches
// storage -- but there is no grounding-by-quote gate here: a draft is not a
// claim about the person, it is a message the OWNER might send, and the
// owner reads and chooses before anything goes anywhere. What IS enforced
// is that the model's own output is the only thing stored: the ME lines
// (the owner's tone sample) ride the PROMPT, never the stored text, and
// oversize/empty drafts are dropped server-side rather than trusted from the
// model's own count.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { personInfo, readPersonPage } from './pages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PROMPT_PATH = join(here, '..', '..', '..', 'prompts', 'reconnect_draft.md');

const MAX_DRAFTS = 2;
const MAX_DRAFT_CHARS = 240;
const DRAFT_CACHE_MS = 24 * 3_600_000;
const ME_LINES_LIMIT = 3;

// Gathers everything reconnect_draft.md needs for one candidate snapshot:
// the person's first name, the quiet-days/mode the snapshot was produced
// under, the card's kind, the person's built page (accepted+pending, same
// as pages.mjs's own readPersonPage -- readPersonPage already omits rejected
// items), the last quoted line the snapshot itself carries (evidence's own
// quote_context_id, resolved against the live row -- same deletion-cascade
// discipline the card route uses), and up to 3 of the OWNER's own most
// recent lines to this person as a tone sample. Returns null when the
// snapshot no longer exists -- the route 400s on that.
//
// OWE CARDS CARRY OWE EVIDENCE (review finding 13). An Owe snapshot has no
// dormancyDays and no mode -- both were passed as 'unknown' -- and the one
// thing that card is actually about, the overdue commitment or the
// unanswered ask, never reached the prompt at all. The result was a generic
// "it's been a while" draft on a card whose whole point is a specific thing
// the owner said they would do. The commitment text is resolved from the
// LIVE claim row, and a claim that is gone or whose latest decision is a
// reject contributes nothing rather than stale text -- the same serve-time
// resolution the card route does for `left`.
export function buildDraftContext(db, snapshotId) {
  const snap = db.prepare(
    'SELECT id, person_key, kind, evidence FROM rm_candidate_snapshot WHERE id = ?'
  ).get(snapshotId);
  if (!snap) return null;

  const evidence = JSON.parse(snap.evidence);
  const person = personInfo(db, snap.person_key);
  const firstName = String(person.name ?? snap.person_key).trim().split(/\s+/)[0] || snap.person_key;
  const page = readPersonPage(db, snap.person_key);

  let lastQuote = null;
  const quoteContextId = evidence.quote_context_id;
  if (Number.isInteger(quoteContextId)) {
    const row = db.prepare('SELECT text FROM context WHERE id = ?').get(quoteContextId);
    if (row !== undefined) lastQuote = String(row.text).slice(0, 200);
  }

  // The same person_event_links/context path pages.mjs's gatherPersonContext
  // reads its excerpts through, narrowed to the owner's own authored,
  // direct (room=0) lines -- a tone sample, never evidence about the OTHER
  // person, so it is fine that these never pass through any quote-grounding
  // check.
  const meLines = db.prepare(
    `SELECT c.text FROM person_event_links l
     JOIN context c ON c.id = l.context_id
     WHERE l.person_key = ? AND l.owner_authored = 1 AND l.room = 0
     ORDER BY c.ts DESC LIMIT ?`
  ).all(snap.person_key, ME_LINES_LIMIT).map((r) => String(r.text));

  let commitment = null;
  const commitmentClaimId = evidence.commitment_claim_id;
  if (Number.isInteger(commitmentClaimId)) {
    const claimRow = db.prepare('SELECT text FROM claim WHERE id = ?').get(commitmentClaimId);
    const decision = db.prepare(
      'SELECT action FROM claim_decision WHERE claim_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    ).get(commitmentClaimId);
    if (claimRow && decision?.action !== 'reject') commitment = String(claimRow.text);
  }

  return {
    snapshotId: Number(snap.id),
    personKey: snap.person_key,
    kind: snap.kind,
    firstName,
    quietDays: evidence.dormancyDays ?? null,
    mode: evidence.mode ?? null,
    oweKind: evidence.owe_kind ?? null,
    overdueDays: Number.isFinite(evidence.overdueDays) ? evidence.overdueDays : null,
    commitment,
    page,
    lastQuote,
    meLines,
  };
}

function pageLine(item) {
  return item ? { text: item.text, quote: item.quote } : null;
}

function renderPrompt(ctx) {
  const lines = [];
  lines.push(`First name: ${ctx.firstName}`);
  lines.push(`Quiet days: ${ctx.quietDays ?? 'unknown'}`);
  lines.push(`Mode: ${ctx.mode ?? 'unknown'}`);
  lines.push(`Kind: ${ctx.kind}`);
  // Owe's own facts, and only when this IS an owe card: a reconnect card
  // has no overdue thing, and printing 'none' for it would invite the model
  // to write about the absence.
  if (ctx.oweKind !== null) {
    lines.push(`Owe kind: ${ctx.oweKind}`);
    lines.push(`Days overdue: ${ctx.overdueDays ?? 'unknown'}`);
    lines.push(`What the owner said they would do: ${ctx.commitment ? JSON.stringify(ctx.commitment) : 'not recorded'}`);
  }

  const who = pageLine(ctx.page.sections.who);
  const objection = pageLine(ctx.page.sections.objection);
  const howLeft = pageLine(ctx.page.sections.how_left);
  const asks = ctx.page.sections.asks.map(pageLine);
  const notable = ctx.page.sections.notable.map(pageLine);

  lines.push('');
  lines.push('Page lines (JSON, null/[] when nothing is built yet):');
  lines.push(JSON.stringify({ who, asks, objection, how_left: howLeft, notable }));

  lines.push('');
  lines.push(`Their last quoted line: ${ctx.lastQuote ? JSON.stringify(ctx.lastQuote) : 'none'}`);

  lines.push('');
  if (ctx.meLines.length > 0) {
    lines.push('Owner tone sample (voice only -- never a fact to reference):');
    for (const line of ctx.meLines) lines.push(`ME: ${line}`);
  } else {
    lines.push('Owner tone sample: none available.');
  }

  return lines.join('\n');
}

function parseDraftsJson(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'no content' };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'no JSON object in output' };
  try {
    return { ok: true, parsed: JSON.parse(body.slice(start, end + 1)) };
  } catch {
    return { ok: false, reason: 'output is not valid JSON' };
  }
}

// Keeps at most MAX_DRAFTS non-empty, in-bounds drafts from the model's
// parsed output, stripping anything after a blank line (a model that pads a
// short opener with a second paragraph, an explanation, or a sign-off) --
// the server-side gate, not the model's own restraint, is what a stored
// draft is held to.
export function groundDrafts(parsed) {
  const raw = Array.isArray(parsed?.drafts) ? parsed.drafts : [];
  const kept = [];
  for (const item of raw) {
    if (kept.length >= MAX_DRAFTS) break;
    if (item === null || typeof item !== 'object' || typeof item.text !== 'string') continue;
    const text = item.text.split('\n\n')[0].trim();
    if (text.length === 0 || text.length > MAX_DRAFT_CHARS) continue;
    kept.push(text);
  }
  return kept;
}

// Existing, non-expired drafts for this snapshot -- the 24h cache createDraft
// checks before ever calling the engine.
function cachedDrafts(db, snapshotId, now) {
  return db.prepare(
    `SELECT id, text FROM rm_card_draft WHERE snapshot_id = ? AND created_at > ? ORDER BY id`
  ).all(snapshotId, now - DRAFT_CACHE_MS).map((r) => ({ id: Number(r.id), text: r.text }));
}

// gather -> prompt -> engine -> parse -> ground -> store, cached against the
// snapshot for DRAFT_CACHE_MS: a repeated ask for the same card within 24h
// costs nothing and makes no engine call at all.
export async function createDraft(db, engine, { snapshotId, now = Date.now() } = {}) {
  const existing = cachedDrafts(db, snapshotId, now);
  if (existing.length > 0) return { drafts: existing, cached: true };

  const ctx = buildDraftContext(db, snapshotId);
  if (!ctx) return { drafts: [], cached: false, reason: 'snapshot not found' };

  const system = readFileSync(PROMPT_PATH, 'utf8');
  const user = renderPrompt(ctx);

  let raw;
  try {
    raw = await engine.complete({ system, user, maxTokens: 512 });
  } catch (err) {
    return { drafts: [], cached: false, reason: `engine error: ${err?.message ?? err}` };
  }

  const parsedResult = parseDraftsJson(raw);
  if (!parsedResult.ok) return { drafts: [], cached: false, reason: parsedResult.reason };

  const kept = groundDrafts(parsedResult.parsed);
  if (kept.length === 0) return { drafts: [], cached: false, reason: 'no usable drafts' };

  const insDraft = db.prepare(
    'INSERT INTO rm_card_draft(snapshot_id, engine, model, text, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const stored = kept.map((text) => ({
    id: Number(insDraft.run(snapshotId, engine.name, engine.model ?? null, text, now).lastInsertRowid),
    text,
  }));

  return { drafts: stored, cached: false };
}

// Existing rows for a snapshot, regardless of age -- used by the card route
// to attach whatever is already drafted (possibly stale, possibly none) so
// the widget can show a cached draft immediately without asking for one.
export function existingDrafts(db, snapshotId) {
  return db.prepare(
    'SELECT id, text FROM rm_card_draft WHERE snapshot_id = ? ORDER BY id'
  ).all(snapshotId).map((r) => ({ id: Number(r.id), text: r.text }));
}
