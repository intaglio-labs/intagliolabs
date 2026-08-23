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
export function rowContent(row) {
  const speaker = typeof row.speaker === 'string' && row.speaker.trim() ? row.speaker.trim() : null;
  return speaker ? `${speaker}: ${row.text}` : row.text;
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
