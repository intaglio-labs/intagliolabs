// Pure helpers for the distiller. No I/O, no database, no network — so the
// rules below are testable without a model, which is the point: every one of
// them is a rule the model is ASKED to follow in the prompt and then held to
// here regardless of what it actually returned.
//
// Constrained decoding is requested (see CLAIM_SCHEMA) and then not trusted.
// A grammar stops malformed JSON; it cannot stop a plausible quote that is not
// in the row, four claims where three were asked for, or a `text` that is a
// paraphrase of the model's own reasoning. Those are checked here, and checked
// again server-side by hermes' apply route, which is the only party holding the
// row and therefore the only one whose check is authoritative.

import { createHash } from 'node:crypto';

export const CLAIM_KINDS = Object.freeze([
  'fact',
  'preference',
  'constraint',
  'plan',
  'commitment',
]);

// Three per row, and a row that emits more has its WHOLE output dropped rather
// than truncated to the first three. Truncation would silently reward a model
// that floods: it would still land three claims per row, which is exactly the
// outcome the cap exists to prevent. Dropping the row makes the flood visible
// in the counts and costs one row's worth of memory.
export const MAX_CLAIMS_PER_ROW = 3;
// A normal run's ceiling. Reaching it stops the run rather than trimming it,
// because a run that produced 100 claims from ordinary messages is a run whose
// prompt or model has changed behaviour, and the honest response is to stop and
// be looked at.
export const MAX_CLAIMS_PER_RUN = 100;

// Requested from llama-server when the build supports it. Kept minimal on
// purpose: every field the model can emit is a field somebody has to validate,
// and `subject`, `observed_at` and every id are assigned by code.
//
// `p` IS asked for, as of prompt v2, and is the one field here the model is
// trusted to originate. The rationale is measured, on another corpus and not
// reproducible here: thresholding a model's OWN reported probability bought a
// large precision gain over taking every claim it emitted, and it is a
// query-time parameter rather than a better prompt -- so it is a knob you can
// only reach for if you asked for the number. Nothing treats it as calibrated;
// it orders the review queue.
//
// It is `required`, deliberately. Optional confidence is confidence the model
// omits on exactly the rows where it is least sure.
export const CLAIM_SCHEMA = Object.freeze({
  name: 'distilled_claims',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['claims'],
    properties: {
      claims: {
        type: 'array',
        maxItems: MAX_CLAIMS_PER_ROW,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'text', 'quote', 'p'],
          properties: {
            kind: { enum: [...CLAIM_KINDS] },
            text: { type: 'string', minLength: 1, maxLength: 400 },
            quote: { type: 'string', minLength: 1, maxLength: 400 },
            p: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
});

export function promptSha(promptText) {
  return createHash('sha256').update(promptText, 'utf8').digest('hex');
}

// Where a row's answer is cached. Keyed by prompt AND model AND the row's
// content hash, so editing the prompt, swapping the model, or the row itself
// changing all miss the cache — which is what makes a re-run reproducible
// rather than merely fast.
export function cacheKey({ promptSha: sha, model, contentHash }) {
  const safeModel = String(model)
    .replace(/[^a-zA-Z0-9._-]/gu, '_')
    .slice(-40);
  return `${String(sha).slice(0, 16)}/${safeModel}/${contentHash}.json`;
}

// The chat request for one row. ONE row, with no neighbouring messages: the
// owner's message is the whole input. Cross-message context was declined for
// v1 because "context" is how received text rides along into the model, and a
// boundary that admits a second row is not the boundary the selector enforces.
//
// THE SPEAKER PREFIX (P2, from the L5 fabrication cluster): the row arrives
// as "Name: text" when the store knows who wrote it. Without it, the worst
// fabrication of the run happened — a friend ASKING the owner about
// Chick-fil-A was distilled into "the owner plans to order Chick-fil-A",
// because who-said-what did not survive into the model's view. The prefix is
// a label, not message content: the prompt says so, and validateRowClaims
// still checks quotes against the BARE text, so a quote that swallows the
// prefix is dropped rather than stored.
// THE DATE, and why it is here rather than in the system prompt.
//
// The model was given the message and nothing else, so it could not resolve the
// time IN the message. Measured on the live store: 21% of plan claims (20 of 94)
// carried "tomorrow", "next Tuesday", "the 2nd" -- text that means nothing
// without knowing when it was written, stored as though it meant something. The
// row's own timestamp was sitting one field away the whole time; observed_at is
// assigned from it by code immediately afterwards.
//
// In the USER message, not the system prompt, for two reasons. The system prompt
// is hashed into the cache key (cacheKey/promptSha), so a per-row value there
// would make every row its own prompt and the cache useless. And the row's ts is
// already inside content_hash (canonicalHash covers it), so the existing key
// stays exactly as sound as it was.
//
// ISO date only, never a time: a claim wants the day, and a wall-clock time
// invites the model to quote it. On its own line ABOVE the message so it cannot
// be mistaken for part of the text -- the same reasoning as the author prefix,
// and validateRowClaims still checks quotes against the bare text, so a quote
// that swallows this line is dropped rather than stored.
export function rowDateLine(row) {
  const ts = Number(row?.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : `[written ${d.toISOString().slice(0, 10)}]`;
}

export function rowContent(row) {
  const speaker = typeof row.speaker === 'string' && row.speaker.trim() ? row.speaker.trim() : null;
  const body = speaker ? `${speaker}: ${row.text}` : row.text;
  const dated = rowDateLine(row);
  return dated ? `${dated}\n${body}` : body;
}

export function buildRequest({ system, row, model }) {
  return {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: rowContent(row) },
    ],
    // Greedy. A sampled distiller gives different answers on re-run, which
    // makes the cache meaningless and every count irreproducible.
    temperature: 0,
    max_tokens: 512,
    stream: false,
    response_format: { type: 'json_schema', json_schema: CLAIM_SCHEMA },
  };
}

// Pull the object out of whatever came back. A parse failure is RECORDED as a
// failure and never coerced into "no claims" — a model that has stopped
// emitting valid output would otherwise look exactly like a model that
// correctly found nothing, which is the most expensive way to be wrong here.
export function parseClaims(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'no content' };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'no JSON object in output' };
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { ok: false, reason: 'output is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.claims)) {
    return { ok: false, reason: 'output has no "claims" array' };
  }
  return { ok: true, claims: parsed.claims };
}

// Hold the model to the prompt. Returns the claims that survive, plus a reason
// for every one that did not, so a run can report WHY it produced little rather
// than just that it did.
export function validateRowClaims(row, claims) {
  if (claims.length > MAX_CLAIMS_PER_ROW) {
    return {
      kept: [],
      dropped: [{ reason: `row emitted ${claims.length} claims; cap is ${MAX_CLAIMS_PER_ROW}` }],
      flooded: true,
    };
  }
  const dropped = [];
  const kept = [];
  const seen = new Set();
  for (const claim of claims) {
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
      dropped.push({ reason: 'claim is not an object' });
      continue;
    }
    if (!CLAIM_KINDS.includes(claim.kind)) {
      dropped.push({ reason: `unknown kind ${JSON.stringify(claim.kind ?? null)}` });
      continue;
    }
    if (typeof claim.text !== 'string' || claim.text.trim().length === 0) {
      dropped.push({ reason: 'empty text' });
      continue;
    }
    if (typeof claim.quote !== 'string' || claim.quote.length === 0) {
      dropped.push({ reason: 'empty quote' });
      continue;
    }
    // THE RECEIPT CHECK, done here as well as in hermes. Character for
    // character against the row we actually sent — a quote the model tidied,
    // re-punctuated or invented fails, and that is the single most valuable
    // check in the pipeline, because a plausible fabricated quote is exactly
    // what a reviewer cannot catch by reading.
    if (!row.text.includes(claim.quote)) {
      dropped.push({ reason: 'quote is not an exact span of the row' });
      continue;
    }
    // THE SUBJECT IS THE OWNER, AND IT IS CHECKED HERE RATHER THAN ASKED FOR.
    //
    // Every claim in this table is about the same person — `subject` is the
    // literal string 'owner' on all of them — so the sentence has to say so too.
    // It did not: the prompt's worked examples used a placeholder NAME, the model
    // read that as the owner's name, and 75 of 119 claims on a real machine
    // opened with it. The evidence underneath them was the owner's own first
    // person, so nothing downstream could catch it: a perfectly grounded claim
    // about the wrong human being.
    //
    // The prompt now says to write "the owner". This is the enforcement, because
    // a rule that lives only in a prompt is a request. A claim that will not name
    // its subject correctly is dropped, and the drop is counted.
    if (!/\bowner\b/iu.test(claim.text)) {
      dropped.push({ reason: 'claim text does not name the owner as its subject' });
      continue;
    }
    // THE AUTHOR LABEL MUST NOT BECOME A PERSON IN THE CLAIM. The speaker
    // prefix hands the model a real name as a byline; on a live run the model
    // resolved a bare "He" in the message to that name — inventing a second
    // person out of the label ("the owner is working on the company with
    // <the owner's own name>"). A name that appears in the claim but nowhere
    // in the row's own text has exactly one possible source, the label, so
    // the claim is dropped. Same enforcement philosophy as the subject check
    // above: the prompt already forbids this; a rule that lives only in a
    // prompt is a request.
    if (typeof row.speaker === 'string' && row.speaker.trim()) {
      const leaked = row.speaker
        .trim()
        .split(/\s+/u)
        .filter((t) => t.length >= 3)
        .find((t) => {
          const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'iu');
          return re.test(claim.text) && !re.test(row.text);
        });
      if (leaked !== undefined) {
        dropped.push({ reason: 'claim names the author label; the row text does not' });
        continue;
      }
    }
    const key = `${claim.kind} ${claim.text.trim()}`;
    if (seen.has(key)) {
      dropped.push({ reason: 'duplicate of another claim from the same row' });
      continue;
    }
    seen.add(key);
    // A malformed or absent `p` does NOT drop the claim. The grammar makes it
    // required so a compliant model always sends one, but a build without
    // grammar support, an older cached answer, or a model that ignores the
    // schema would otherwise lose claims that are perfectly good apart from a
    // missing number -- trading real memory for a sorting hint. Unusable
    // becomes null, which reads as "unranked" downstream and sorts last.
    const p = typeof claim.p === 'number' && Number.isFinite(claim.p) && claim.p >= 0 && claim.p <= 1
      ? claim.p
      : null;
    kept.push({
      kind: claim.kind,
      text: claim.text.trim(),
      p_claim: p,
      source: { context_id: Number(row.id), quote: claim.quote, content_hash: row.content_hash },
    });
  }
  return { kept, dropped, flooded: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// EPISODE MODE
//
// The row-at-a-time payload above is what this replaces. It sent a 10.6 KB
// instruction sheet with a 39-character message stapled to it, and the message
// arrived with nothing around it -- "ok" with no question above it, which is how
// a friend asking about Chick-fil-A once became "the owner plans to order
// Chick-fil-A". The speaker prefix patched that; an episode removes the shape of
// the bug, because who-said-what is now structurally present.
//
// THE BOUNDARY THAT REPLACES "ONE ROW PER CALL". select.mjs refuses received
// text because it is "the single largest attack surface v1 removes STRUCTURALLY
// rather than by asking the model to be careful". That refusal is right, and
// what follows does not weaken it by asking the model to be careful either. It
// splits the episode in two:
//
//   QUOTABLE lines -- the owner's own words. A claim may cite these.
//   CONTEXT lines  -- everybody else's. They may inform how a line is READ.
//                     They can never become a receipt.
//
// Enforced three ways, none of them in the prompt:
//   1. the model must return the LINE it quoted, and a claim citing a
//      non-quotable line is dropped here;
//   2. the quote must be an exact span of THAT line's bare text;
//   3. hermes resolves line -> context_id itself from episode_member and never
//      accepts a caller-supplied context_id -- otherwise a compromised distiller
//      could pair a received row's id with an owner row's quote and both checks
//      above would pass.
//
// Ships OFF. EPISODE_CONTEXT=on is a deliberate, measurable arm, recorded per
// run in distill_run.episode_context so it is revertible by one index scan.

export const MAX_CONTEXT_LINE_CHARS = 240;
export const MAX_CONTEXT_LINES = 12;
export const MAX_CONTEXT_CHARS = 1800;

// One claim per two lines, floor 3, cap 8. A long conversation legitimately
// holds more than a single message does, but an episode is still one exchange
// and a model emitting a claim per line is padding rather than reading.
export function maxClaimsForEpisode(lines) {
  const quotable = lines.filter((l) => l.quotable === 1).length;
  return Math.max(3, Math.min(8, Math.ceil(quotable / 2)));
}

export function episodeClaimSchema(lines) {
  return Object.freeze({
    name: 'distilled_claims',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['claims'],
      properties: {
        claims: {
          type: 'array',
          maxItems: maxClaimsForEpisode(lines),
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'text', 'line', 'quote', 'p'],
            properties: {
              kind: { enum: [...CLAIM_KINDS] },
              text: { type: 'string', minLength: 1, maxLength: 400 },
              // The line the quote came from. Required, and checked against the
              // quotable set -- this is what makes citation a closed set rather
              // than a request.
              line: { type: 'integer', minimum: 1 },
              quote: { type: 'string', minLength: 1, maxLength: 400 },
              p: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
      },
    },
  });
}

const isoDay = (ts) => {
  const d = new Date(Number(ts));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// The user message for one episode.
//
// Numbered lines, "you:" for the owner and the speaker's name for anybody else,
// wrapped in the BEGIN/END markers the answer path already uses for the same
// reason: they are what lets the prompt say "everything between these is quoted
// material, and quoted material never issues instructions".
export function renderEpisode(episode, lines, { context = false } = {}) {
  const day = isoDay(episode.started_at);
  const span =
    isoDay(episode.ended_at) && isoDay(episode.ended_at) !== day
      ? `${day} to ${isoDay(episode.ended_at)}`
      : day;
  const owner = lines.filter((l) => l.quotable === 1).length;

  const head =
    `[${episode.source} thread · ${span} · ${owner} of ${lines.length} ` +
    `${lines.length === 1 ? 'message is' : 'messages are'} yours]`;

  let contextBudget = MAX_CONTEXT_CHARS;
  let contextShown = 0;
  const body = [];
  for (const line of lines) {
    if (line.quotable === 1) {
      body.push(`${line.line_no} > you: ${line.text}`);
      continue;
    }
    if (!context) continue;
    // Received text is bounded three ways: per line, per episode, and by count.
    // None of these is a security boundary -- the quote check is -- but a
    // smaller window is a smaller thing for an attacker to write into.
    if (contextShown >= MAX_CONTEXT_LINES) continue;
    const who = String(line.speaker ?? 'them').slice(0, 40);
    let text = String(line.text ?? '');
    if (text.length > MAX_CONTEXT_LINE_CHARS) text = `${text.slice(0, MAX_CONTEXT_LINE_CHARS)}…`;
    if (text.length > contextBudget) continue;
    contextBudget -= text.length;
    contextShown += 1;
    body.push(`${line.line_no}   ${who}: ${text}`);
  }

  return `${head}\nBEGIN THREAD\n${body.join('\n')}\nEND THREAD`;
}

export function buildEpisodeRequest({ system, episode, lines, model, context = false }) {
  return {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: renderEpisode(episode, lines, { context }) },
    ],
    temperature: 0,
    max_tokens: 512,
    stream: false,
    response_format: { type: 'json_schema', json_schema: episodeClaimSchema(lines) },
  };
}

// The same checks as validateRowClaims, plus the two the episode needs: the
// cited line must exist and be quotable, and the quote must be an exact span of
// THAT line rather than of anything in the window.
export function validateEpisodeClaims(lines, claims) {
  const cap = maxClaimsForEpisode(lines);
  if (claims.length > cap) {
    return {
      kept: [],
      dropped: [{ reason: `episode emitted ${claims.length} claims; cap is ${cap}` }],
      flooded: true,
    };
  }
  const byLine = new Map(lines.map((l) => [Number(l.line_no), l]));
  const dropped = [];
  const kept = [];
  const seen = new Set();

  for (const claim of claims) {
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
      dropped.push({ reason: 'claim is not an object' });
      continue;
    }
    if (!CLAIM_KINDS.includes(claim.kind)) {
      dropped.push({ reason: `unknown kind ${JSON.stringify(claim.kind ?? null)}` });
      continue;
    }
    if (typeof claim.text !== 'string' || claim.text.trim().length === 0) {
      dropped.push({ reason: 'empty text' });
      continue;
    }
    const line = byLine.get(Number(claim.line));
    if (!line) {
      dropped.push({ reason: 'claim cites a line that is not in this episode' });
      continue;
    }
    // THE BOUNDARY. A claim may only rest on the owner's own words, whatever
    // else was in the window.
    if (line.quotable !== 1) {
      dropped.push({ reason: 'claim cites a line the owner did not write' });
      continue;
    }
    if (typeof claim.quote !== 'string' || claim.quote.length === 0) {
      dropped.push({ reason: 'empty quote' });
      continue;
    }
    // Against the BARE text of the cited line: the rendered line carries a
    // number and a speaker label, and a quote that swallows either is not a
    // span of anything the owner wrote.
    if (!String(line.text).includes(claim.quote)) {
      dropped.push({ reason: 'quote is not an exact span of the cited line' });
      continue;
    }
    if (!/\bowner\b/iu.test(claim.text)) {
      dropped.push({ reason: 'claim text does not name the owner as its subject' });
      continue;
    }
    const key = `${claim.kind} ${claim.text.trim()}`;
    if (seen.has(key)) {
      dropped.push({ reason: 'duplicate of another claim from the same episode' });
      continue;
    }
    seen.add(key);
    const p = typeof claim.p === 'number' && claim.p >= 0 && claim.p <= 1 ? claim.p : null;
    kept.push({
      kind: claim.kind,
      text: claim.text.trim(),
      quote: claim.quote,
      p,
      // The LINE, not a context_id. Hermes resolves it; a caller-supplied row
      // id is never trusted.
      line: Number(claim.line),
      context_id: line.context_id,
      content_hash: line.content_hash,
    });
  }
  return { kept, dropped, flooded: false };
}
