// Public lookup (L5 step 6): a small, capped, web search over PUBLIC
// identifiers the owner's corpus already holds for one person at a time --
// name, firm, a public handle, a public LinkedIn profile URL -- proposing
// PENDING person claims the same trust lifecycle as every other producer in
// this system: the model proposes, code grounds, the owner decides.
//
// THIS IS NOT sweep.mjs, and the two must not be confused. sweep.mjs reads
// the owner's OWN corpus (private conversation excerpts) for a person
// already fully identified by person_key. lookup.mjs reads NOTHING private:
// it is handed a name plus whichever public identifiers the corpus already
// resolved (a firm name, a public social handle, a public LinkedIn URL), and
// asks a model to search the OPEN WEB for that person -- the prompt is told
// nothing about why, nothing from a conversation, no email, no phone number,
// no calendar contents, not even the person's own person_key. See
// prompts/public_lookup.md and buildLookupQuery's input gate below for where
// that boundary actually lives in code.
//
// This file is built in two commits: this one is the PURE half (no DB, no
// clock beyond what a caller passes in) -- buildLookupQuery,
// parseLookupStream, groundLookup, and the constants both halves share. The
// DB half (anchorsFor, lookupScope, lookupGate, storeLookup, lookupPerson,
// runLookupPass, lookupStatus, lookupLogFor, newestWebChange) lands in the
// next commit, mirroring the gather/ground vs. store split sweep.mjs and
// pages.mjs already use: a client (this file's pure half) is not a boundary,
// so storeLookup re-checks every rule below against what it actually writes.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));

export const LOOKUP_VERSION = 'lookup-v1';
export const LOOKUP_PROMPT_PATH = join(here, '..', '..', '..', 'prompts', 'public_lookup.md');

// Model calls per pass, mirroring SWEEP_BUDGET's shape (sweep.mjs) -- smaller
// on both arms, because a lookup spends real web searches (up to
// LOOKUP_MAX_SEARCHES each) on top of the model call itself.
export const LOOKUP_BUDGET = Object.freeze({ full: 4, trickle: 1 });

// A LOCAL rolling call cap over the lookup's own run log, same reasoning as
// SWEEP_DAILY_CALL_CAP_DEFAULT: there is no external quota API to ask, so
// this is what "approaching a quota" becomes in practice. Rate limits, not
// dollars, are the ceiling here (a web search costs real API rate-limit
// budget the owner's whole account shares) -- 20/day is a deliberately
// conservative start; raise it only after observing real usage, per the
// design's own open point. Overridable via
// config.relationshipMemory.lookupDailyCallCap.
export const LOOKUP_DAILY_CALL_CAP_DEFAULT = 20;

// How long a person stays "not due" after a lookup, by tier -- eligible and
// tagged people (producer.mjs's eligiblePool, or a founder/investor sub-role
// tag) are refreshed roughly monthly; everyone else, quarterly. Not a promise
// that a lookup will happen exactly on schedule -- lookupGate's budget and
// daily cap still apply -- only that a person is not RE-offered sooner.
export const LOOKUP_REFRESH_DAYS = Object.freeze({ eligible: 30, tagged: 30, other: 120 });

// Enforced by CODE (lookupPerson counts real WebSearch tool_use blocks via
// parseLookupStream), not merely asked of the prompt -- see
// prompts/public_lookup.md's own budget section, which exists so the model
// need not guess why the number matters, not as the enforcement itself.
export const LOOKUP_MAX_SEARCHES = 2;

// Hosts and host patterns a lookup's own citations may never resolve to,
// regardless of what the model claims found them. Two different failure
// modes, both closed here: a host that could only ever be internal
// infrastructure (this box, a private network, a .local/.internal name) is
// never a real public source no matter what text accompanies it; and two
// named hosts (mail.google.com, calendar.google.com, linkedin.com's own
// /messaging path) are real public hosts that would nonetheless mean the
// model quoted something private if it ever cited them -- an email, an
// invite, a DM -- which the lookup's own isolation (no tool but WebSearch)
// should make impossible, but a denylist is cheaper than trusting that no
// future prompt change ever grants a second tool.
export const LOOKUP_HOST_DENYLIST = Object.freeze({
  exactHosts: Object.freeze(['mail.google.com', 'calendar.google.com']),
  suffixes: Object.freeze(['.local', '.internal']),
});

const LOOKUP_QUERY_PARAM_DENYLIST = /\b(?:token|key|sig)\b/iu;

function isLoopbackOrPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.')) return true;
  // RFC1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/u.test(h)) return true;
  const rfc1918_172 = h.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u);
  if (rfc1918_172 && Number(rfc1918_172[1]) >= 16 && Number(rfc1918_172[1]) <= 31) return true;
  return false;
}

// Everything groundLookup checks about a single citation URL, beyond
// "returned by this search" (observed.urls.has(url), checked by the caller):
// https only, never a loopback/private/internal host, never the two named
// hosts above, never linkedin.com's own messaging path (a DM, not a public
// profile), and never a query string carrying a token/key/sig parameter --
// a signed or authenticated link is not a public citation.
function isLookupUrlDenied(u) {
  const host = u.hostname.toLowerCase();
  if (isLoopbackOrPrivateHost(host)) return true;
  if (LOOKUP_HOST_DENYLIST.suffixes.some((suf) => host.endsWith(suf))) return true;
  if (LOOKUP_HOST_DENYLIST.exactHosts.includes(host)) return true;
  if ((host === 'linkedin.com' || host.endsWith('.linkedin.com')) && u.pathname.startsWith('/messaging')) {
    return true;
  }
  for (const key of u.searchParams.keys()) {
    if (LOOKUP_QUERY_PARAM_DENYLIST.test(key)) return true;
  }
  return false;
}

// The ONLY public identifiers a lookup query may ever be built from. Order
// here is not query order (buildLookupQuery fixes that); it is the
// allowlist buildLookupQuery's input gate checks every key against before
// reading a single value.
export const LOOKUP_ANCHOR_FIELDS = Object.freeze(['name', 'firm', 'handle', 'profileUrl']);

const ANCHOR_CAPS = Object.freeze({ name: 80, firm: 80, handle: 40, profileUrl: 200 });
// Deliberately conservative: letters/digits (any script -- \p{L}/\p{N}, not
// just ASCII), space, and a short list of punctuation an actual name, firm,
// handle or URL legitimately contains. Everything else is stripped before
// any of it reaches a query string a real HTTP request (inside the isolated
// `claude` client) will carry.
const SAFE_CHARS_RE = /[^\p{L}\p{N} .,'&@/:_-]/gu;
// A value shaped like an email address -- checked on every field, not just
// the ones that would ordinarily hold one, because the input gate below has
// no way to know a caller did not accidentally pass an email into `name`.
const EMAIL_SHAPE_RE = /@[^\s@]*\.[a-z]{2,}/iu;
const HANDLE_SHAPE_RE = /^@?[A-Za-z0-9_]{2,15}$/u;

function lookupQueryError(field) {
  return new Error(`buildLookupQuery: field ${JSON.stringify(field)} is not an allowlisted public identifier`);
}

// buildLookupQuery(anchors) -- PURE, and the one function in this system
// that assembles the text a lookup sends outward. Its input gate runs
// BEFORE any property of `anchors` is read, on purpose: `anchors` may be
// handed something that is not the plain {name,firm,handle,profileUrl}
// object anchorsFor (DB half) builds -- a raw database row, a class
// instance, a Proxy whose getters throw or leak -- and the gate must refuse
// all of those without ever triggering a getter to find out. That is why
// this checks Object.getPrototypeOf and Object.getOwnPropertyDescriptors
// (neither of which invokes a "get" trap) rather than reading anchors.name
// etc. directly or spreading the object.
//
// Returns {query, fieldsUsed, queryHash} or null (fewer than two anchors
// survive validation). Throws only on a structural violation of the
// allowlist itself -- not an allowlisted field's value merely failing a
// format check, which instead drops just that field (see the two-anchor
// rule at the end).
export function buildLookupQuery(anchors) {
  if (
    anchors === null ||
    typeof anchors !== 'object' ||
    Array.isArray(anchors) ||
    Object.getPrototypeOf(anchors) !== Object.prototype
  ) {
    throw new Error('buildLookupQuery: input is not a plain object');
  }

  // Every key checked against the allowlist, and every descriptor checked
  // for a plain `value` (never an accessor), BEFORE any value is read. A
  // Proxy whose own getOwnPropertyDescriptor trap reports an accessor-shaped
  // descriptor is refused here; one that reports a plain value descriptor
  // for a key outside the allowlist is refused here too -- either way,
  // nothing beyond the descriptor's own key name is ever consulted for a
  // field this function does not already expect.
  const descriptors = Object.getOwnPropertyDescriptors(anchors);
  for (const key of Object.keys(descriptors)) {
    if (!('value' in descriptors[key]) || !LOOKUP_ANCHOR_FIELDS.includes(key)) {
      throw lookupQueryError(key);
    }
  }

  const clean = {};
  for (const field of LOOKUP_ANCHOR_FIELDS) {
    const raw = descriptors[field] ? descriptors[field].value : undefined;
    if (raw === undefined || raw === null) {
      clean[field] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      throw lookupQueryError(field);
    }
    let v = raw.trim().slice(0, ANCHOR_CAPS[field]).replace(SAFE_CHARS_RE, '');
    if (v.length === 0) {
      clean[field] = null;
      continue;
    }
    if (EMAIL_SHAPE_RE.test(v)) {
      throw lookupQueryError(field);
    }
    clean[field] = v;
  }

  // Format checks that narrow rather than throw: a handle that does not
  // look like a handle, or a profile URL that is not an https linkedin.com
  // link, simply stops counting as an anchor -- the two-anchor rule below
  // is what decides whether the lookup can run at all.
  if (clean.handle !== null && !HANDLE_SHAPE_RE.test(clean.handle)) {
    clean.handle = null;
  }
  if (clean.profileUrl !== null) {
    let ok = false;
    try {
      const u = new URL(clean.profileUrl);
      ok = u.protocol === 'https:' && (u.hostname === 'linkedin.com' || u.hostname.endsWith('.linkedin.com'));
    } catch {
      ok = false;
    }
    if (!ok) clean.profileUrl = null;
  }

  // TWO-ANCHOR RULE: a bare name is not enough (too common; disambiguation
  // in prompts/public_lookup.md depends on having something to confirm
  // against), and a firm/handle/URL with no name is not a person to look up
  // at all.
  if (!clean.name || !(clean.firm || clean.handle || clean.profileUrl)) {
    return null;
  }

  const query = [
    `"${clean.name}"`,
    clean.firm ? `"${clean.firm}"` : null,
    clean.handle,
    clean.profileUrl,
  ].filter(Boolean).join(' ');
  const fieldsUsed = LOOKUP_ANCHOR_FIELDS.filter((f) => clean[f] !== null).sort();
  const queryHash = createHash('sha256').update(query, 'utf8').digest('hex');
  return { query, fieldsUsed, queryHash };
}

// parseLookupStream(stdoutText) -- PURE. Reads the stream-json JSONL the
// lookup engine's `complete` hands back (RAW stdout; see
// engines.mjs createLookupEngine) and extracts exactly what groundLookup and
// storeLookup need, without ever trusting the model's own prose about what
// it searched:
//
//   envelopeText  the model's final answer text -- what lookupPerson (DB
//                 half) JSON.parses as the envelope {identity_confidence,
//                 changes}. Taken from the terminal `type:'result'` line's
//                 own `result` field when one arrives (the authoritative
//                 final answer, same field the JSON-envelope engine already
//                 returns), else the last assistant text block seen.
//   urls          the UNION of every `Links: [...]` array parsed out of
//                 every WebSearch tool_result across the whole transcript --
//                 the observed-URL allowlist a change's `url` must appear in.
//   resultText    every WebSearch tool_result's own text, concatenated -- the
//                 corpus a change's `quote` must be a verbatim substring of.
//   searches      a REAL count: assistant `tool_use` blocks named WebSearch,
//                 counted by code, never taken from anything the model says
//                 about itself.
//   costUsd       the terminal result line's total_cost_usd, or null.
//
// FAILS CLOSED BY CONSTRUCTION: a line that is not JSON is skipped, not
// thrown on; a tool_result whose text has no parseable `Links: [...]` array
// contributes zero URLs (never throws, never guesses one). If no Links array
// anywhere in the transcript parses, `urls` stays empty -- and because
// groundLookup requires observed.urls.has(url) for every kept change, every
// change fails grounding and the lookup's own status (a later commit) is
// 'ungrounded', visible on /stats. This is the intended failure mode for an
// undocumented, provider-shaped stream format: degrade to zero, visibly,
// never guess.
export function parseLookupStream(stdoutText) {
  const urls = new Set();
  let resultText = '';
  let searches = 0;
  let costUsd = null;
  let envelopeText = null;
  let error = null;

  const lines = String(stdoutText ?? '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // not a JSON line -- skip it, do not throw
    }
    if (obj === null || typeof obj !== 'object') continue;

    if (obj.type === 'assistant') {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && block?.name === 'WebSearch') searches += 1;
          if (block?.type === 'text' && typeof block.text === 'string') envelopeText = block.text;
        }
      }
    } else if (obj.type === 'user') {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          const text = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
              : '';
          if (text.length === 0) continue;
          resultText += (resultText.length > 0 ? '\n' : '') + text;
          const m = text.match(/Links:\s*(\[[\s\S]*?\])\n\n/u);
          if (!m) continue; // no parseable Links array in this tool_result -- contributes zero URLs
          try {
            const links = JSON.parse(m[1]);
            if (Array.isArray(links)) {
              for (const link of links) {
                if (typeof link?.url === 'string' && link.url.length > 0) urls.add(link.url);
              }
            }
          } catch {
            // malformed Links array -- fail closed, contribute zero URLs
          }
        }
      }
    } else if (obj.type === 'result') {
      if (typeof obj.total_cost_usd === 'number') costUsd = obj.total_cost_usd;
      if (obj.is_error) error = typeof obj.subtype === 'string' ? obj.subtype : 'error';
      if (typeof obj.result === 'string') envelopeText = obj.result;
    }
  }

  return { envelopeText, urls, resultText, searches, costUsd, ...(error ? { error } : {}) };
}

const LOOKUP_CHANGE_KINDS = Object.freeze(['role', 'company', 'raise', 'launch', 'move', 'other']);
const LOOKUP_CHANGE_CAP = 3;

// groundLookup(envelope, observed) -- PURE, no DB. Mirrors groundSweep's
// shape (sweep.mjs) over public_lookup.md's output instead of sweep.md's:
// every change is checked against what parseLookupStream actually observed,
// never against what the envelope merely claims. storeLookup (DB half)
// re-checks every one of these rules again against the LIVE row it writes --
// a client (this function) is not a boundary, same discipline as
// groundSweep/storeSweep and groundPage/storePage.
//
// We hold a CITATION, not a page: nothing here fetches the URL or verifies
// that the live page still says what the quote says, because a lookup's own
// isolation grants no tool but WebSearch -- there is no second network call
// to make even to try. What is stored is therefore always PENDING, and its
// receipt is the (url, quote) pair itself: the owner can open the URL and
// judge for themselves, the same way every other claim's receipt in this
// system is a pointer plus a verbatim quote, never a verified fact.
export function groundLookup(envelope, observed) {
  const kept = [];
  const dropped = [];
  const noteDrop = (reason) => dropped.push({ reason });

  if (envelope === null || typeof envelope !== 'object') {
    return { kept: [], dropped: [{ reason: 'no envelope' }] };
  }
  if (envelope.identity_confidence !== 'match') {
    // On ambiguous/no_match, changes MUST already be empty per
    // prompts/public_lookup.md -- but this is enforced here too, not merely
    // asked of the prompt: a model that ignores its own instructions and
    // proposes changes anyway must still see them dropped.
    const n = Array.isArray(envelope.changes) ? envelope.changes.length : 0;
    if (n > 0) noteDrop(`identity_confidence is "${envelope.identity_confidence}", not "match"`);
    return { kept: [], dropped };
  }

  const changes = Array.isArray(envelope.changes) ? envelope.changes.slice(0, LOOKUP_CHANGE_CAP * 4) : [];
  for (const item of changes) {
    if (kept.length >= LOOKUP_CHANGE_CAP) break;
    if (item === null || typeof item !== 'object') { noteDrop('change is not an object'); continue; }
    if (!LOOKUP_CHANGE_KINDS.includes(item.kind)) { noteDrop('kind is not one of the six'); continue; }
    if (typeof item.text !== 'string' || item.text.trim().length === 0 || item.text.length > 200) {
      noteDrop('text is missing, empty, or over 200 characters');
      continue;
    }
    if (typeof item.quote !== 'string' || item.quote.length === 0) {
      noteDrop('quote is missing or empty');
      continue;
    }
    if (!observed.resultText.includes(item.quote)) {
      noteDrop('quote is not a verbatim substring of a search result');
      continue;
    }
    if (typeof item.url !== 'string' || item.url.length === 0) {
      noteDrop('url is missing');
      continue;
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(item.url);
    } catch {
      noteDrop('url does not parse');
      continue;
    }
    if (parsedUrl.protocol !== 'https:') { noteDrop('url is not https'); continue; }
    if (isLookupUrlDenied(parsedUrl)) { noteDrop('url host is denylisted'); continue; }
    if (!observed.urls.has(item.url)) { noteDrop('url was never returned by this lookup\'s own search'); continue; }
    const date = typeof item.date === 'string' && /^\d{4}-\d{2}$/u.test(item.date) ? item.date : null;
    kept.push({ kind: item.kind, text: item.text.trim(), url: item.url, quote: item.quote, date });
  }

  return { kept, dropped };
}
