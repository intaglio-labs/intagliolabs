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
// This file has two halves. Above is the PURE half (no DB, no clock beyond
// what a caller passes in): buildLookupQuery, parseLookupStream,
// groundLookup, the evidence-strength helpers (evidenceKindFor, sameFirm,
// companiesNamed, contradictsAnchorFirm), and the constants both halves
// share. Below is the DB half: anchorsFor, lookupTierFor, lookupScope,
// lookupGate, storeLookup, storeLookupEvidence, lookupPerson, runLookupPass,
// lookupStatus, lookupLogFor, lookupEvidenceFor, newestWebChange --
// mirroring the gather/ground vs. store split sweep.mjs and pages.mjs already
// use: a client (groundLookup, the pure half above) is not a boundary, so
// storeLookup re-checks every rule again against what it actually writes.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalHash, canonicalize } from '../contentHash.mjs';
import { isAnonymousContact } from '../people/map.mjs';
import { eligiblePool } from './producer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;

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

// The hard ceiling on how much third-party article text ONE lookup may store
// in lookup_evidence, and on how much of it the evidence route will hand
// back. The column's own comment used to call it "verbatim" with no bound at
// all: the only limit was the engine's 5MB stdout buffer (engines.mjs), which
// truncates mid-line -- so a pathological result set could put multiple
// megabytes of somebody else's web page into the database per lookup and
// then serve all of it over HTTP in one response. VERBATIM NOW MEANS
// VERBATIM UP TO THIS CAP: past it the text is cut and
// lookup_evidence.truncated is set to 1, so a reader can tell a complete
// article from a clipped one instead of trusting the word "verbatim".
export const LOOKUP_RESULT_TEXT_CAP = 200_000;

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
  // `new URL('https://[::1]/x').hostname` is the SIX characters "[::1]" --
  // the brackets are part of it, so the `=== '::1'` test above never fires
  // on a real URL and every bracketed literal has to be named here too.
  if (h === '[::1]' || h === '[::]' || h === '0.0.0.0') return true;
  // Link-local: 169.254.169.254 is how a cloud instance reaches its own
  // metadata endpoint, and fe80::/10 is IPv6's own link-local block.
  if (h.startsWith('169.254.') || h.startsWith('[fe80:')) return true;
  // IPv6 unique-local, fc00::/7.
  if (h.startsWith('[fc') || h.startsWith('[fd')) return true;
  // RFC1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/u.test(h)) return true;
  const rfc1918_172 = h.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u);
  if (rfc1918_172 && Number(rfc1918_172[1]) >= 16 && Number(rfc1918_172[1]) <= 31) return true;
  return false;
}

// The shape a REGISTRABLE PUBLIC DOMAIN has, and the rule that turns the
// range list above into a statement of intent rather than the whole
// defence. Enumerating private address space one CIDR at a time loses to
// encodings: 2130706433, 0x7f000001 and 0177.0.0.1 are all 127.0.0.1,
// ::ffff:127.0.0.1 is too, and there is no end to that list. Requiring the
// shape instead closes every encoding at once -- at least one dot, labels of
// letters/digits/hyphens, and a final label of two or more letters. Every IP
// literal in every encoding fails it, as does a bare label with no TLD
// ("intranet"). A punycode IDN passes, since URL has already normalized it
// to xn--. The cost is that a numeric-host citation is refused, which is
// correct: a search result about a person is served from a domain, and a
// bare-IP citation is not evidence about anybody.
const PUBLIC_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u;

// Everything groundLookup checks about a single citation URL, beyond
// "returned by this search" (observed.urls.has(url), checked by the caller):
// https only, never a loopback/private/internal host, never the two named
// hosts above, never linkedin.com's own messaging path (a DM, not a public
// profile), and never a query string carrying a token/key/sig parameter --
// a signed or authenticated link is not a public citation.
function isLookupUrlDenied(u) {
  const host = u.hostname.toLowerCase();
  if (isLoopbackOrPrivateHost(host)) return true;
  if (!PUBLIC_DOMAIN_RE.test(host)) return true;
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

// isPublicHandle(raw): the handle test, run on the RAW value BEFORE
// SAFE_CHARS_RE strips anything, and that ordering is the whole point.
// SAFE_CHARS_RE does not keep '+', so a phone number "+15551234567" became
// "15551234567" -- eleven characters of [0-9], which HANDLE_SHAPE_RE accepts
// -- and went out in a real search query as though it were a public social
// handle, while also SATISFYING THE TWO-ANCHOR RULE and so authorizing a
// lookup that would otherwise have been refused. ops/EGRESS.json's own
// decision for this path says "no email or phone number".
//
// Two rules, then: the shape must hold before stripping (so '+' disqualifies
// rather than vanishing), and an all-digit value is never a handle -- a bare
// numeric id is a phone number or a Telegram user id, not something you
// search the public web for.
function isPublicHandle(raw) {
  if (typeof raw !== 'string') return false;
  const v = raw.trim();
  if (!HANDLE_SHAPE_RE.test(v)) return false;
  return !/^\d+$/u.test(v.replace(/^@/u, ''));
}

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
  // The pre-strip value per field, kept because two checks below MUST see
  // what the caller actually passed rather than what SAFE_CHARS_RE left of
  // it -- see isPublicHandle for the phone-number-becomes-handle case, and
  // the email check for why a stripped value cannot be trusted either.
  const raws = {};
  for (const field of LOOKUP_ANCHOR_FIELDS) {
    const raw = descriptors[field] ? descriptors[field].value : undefined;
    if (raw === undefined || raw === null) {
      clean[field] = null;
      raws[field] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      throw lookupQueryError(field);
    }
    const trimmed = raw.trim().slice(0, ANCHOR_CAPS[field]);
    raws[field] = trimmed;
    let v = trimmed.replace(SAFE_CHARS_RE, '');
    if (v.length === 0) {
      clean[field] = null;
      continue;
    }
    // Checked on the RAW value as well as the stripped one: SAFE_CHARS_RE
    // keeps '@' and '.', so this fires either way today, but a future
    // widening of the strip set must not be able to launder an address
    // through it.
    if (EMAIL_SHAPE_RE.test(v) || EMAIL_SHAPE_RE.test(trimmed)) {
      throw lookupQueryError(field);
    }
    clean[field] = v;
  }

  // Format checks that narrow rather than throw: a handle that does not
  // look like a handle, or a profile URL that is not an https linkedin.com
  // link, simply stops counting as an anchor -- the two-anchor rule below
  // is what decides whether the lookup can run at all.
  if (clean.handle !== null && !isPublicHandle(raws.handle)) {
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
//   links         the same Links entries as {title, url} pairs, deduplicated
//                 by url, first title seen winning -- see the evidence-kind
//                 section below for why a TITLE is tracked separately from
//                 the prose around it.
//   resultText    every WebSearch tool_result's own text, concatenated,
//                 VERBATIM -- what lookup_evidence stores so a false positive
//                 can be audited after the fact.
//   snippetText   resultText with the parts that are NOT the search engine's
//                 synthesized prose removed: the `Web search results for
//                 query: "..."` header (which echoes OUR OWN anchors back --
//                 a model quoting that would be "grounding" a claim in the
//                 query we sent), the `Links: [...]` JSON blob, and the
//                 trailing `REMINDER:` tail the provider appends. This, not
//                 resultText, is the corpus a `quote` counts as a SNIPPET
//                 against.
//   searches      a REAL count: assistant `tool_use` blocks named WebSearch,
//                 counted by code, never taken from anything the model says
//                 about itself.
//   costUsd       the terminal result line's total_cost_usd, or null.
//   linksParseFailed  true when a `Links:` block WAS present in some
//                 tool_result and could not be read as an array. Recorded on
//                 lookup_evidence (links_parse_failed) rather than merely
//                 degrading to zero URLs, because "the provider's format
//                 drifted" and "the search returned no links" must not be
//                 the same observation -- see findLinksBlock.
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
// The three shapes a provider wraps around its own synthesized prose in a
// WebSearch tool_result (see ui/test/fixtures/lookup-stream.txt for the real
// captured article). None is evidence about a person:
//   - the header echoes the query WE sent (name + firm + profile URL), so a
//     quote of it is a claim grounded in its own premise;
//   - the Links array is an index of titles and URLs, and a search-result
//     title is a stale snapshot of a page's <title>, not a statement anybody
//     published about a person's CURRENT role (this is exactly how lookup_log
//     4520 turned "Nikzad Khani - Software Engineer - Verily" into a
//     present-tense "now at Verily, not Klaviyo");
//   - the REMINDER tail is an instruction to the model, not content.
const SEARCH_HEADER_RE = /^Web search results for query:[^\n]*\n+/u;
const SEARCH_LINKS_LABEL_RE = /Links:\s*\[/u;
const SEARCH_REMINDER_RE = /\n+REMINDER:[\s\S]*$/u;

// findLinksBlock(text): the `Links:` label and the BALANCED JSON array after
// it, located by scanning brackets rather than by matching a terminator.
//
// The old reader was `/Links:\s*(\[[\s\S]*?\])\n\n/` -- lazy up to the first
// `]` FOLLOWED BY A BLANK LINE. Two silent failures lived in that: an entry
// whose own title contains `]` ended the array early (the JSON.parse then
// failed and the whole tool_result contributed zero URLs), and a provider
// that stops emitting exactly two newlines after the array -- one newline, a
// CRLF, or the array at the very end of the text -- matched nothing at all,
// which left the entire `Links:` blob INSIDE snippetText. That second case
// is the dangerous one: every title then reads as the provider's synthesized
// prose, so evidenceKindFor answers 'snippet' for a title, and the whole
// title-only machinery (the present-tense drop, the 'ambiguous' downgrade)
// reverts with nothing logged to say it did. Both are closed by scanning:
// depth counting with string/escape awareness finds the real end of the
// array wherever it is, and the label's own position is what snippetOnly
// cuts from, so no trailing-newline convention is load-bearing any more.
//
// Returns {labelStart, start, end, json} or null. `parsed` is left to the
// caller: a block that is found but does not parse is a DIFFERENT fact from
// a block that is not there (see linksParseFailed in parseLookupStream).
function findLinksBlock(text, fromIndex = 0) {
  const s = String(text ?? '');
  const rest = s.slice(fromIndex);
  const label = rest.search(SEARCH_LINKS_LABEL_RE);
  if (label === -1) return null;
  const labelStart = fromIndex + label;
  const open = s.indexOf('[', labelStart);
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return { labelStart, start: open, end: i + 1, json: s.slice(open, i + 1) };
    }
  }
  // Unterminated: the array really does run off the end of this text (a
  // truncated tool_result). Report the label so snippetOnly still cuts it.
  return { labelStart, start: open, end: s.length, json: s.slice(open) };
}

// parseLinksBlock(json): JSON.parse, with an incremental end search as the
// fallback for a block whose balance was right but whose text still will not
// parse (a truncated array, a trailing comma). Bounded: at most the first 64
// `]` positions are tried, newest-shortest first, so a pathological blob
// cannot turn one tool_result into a scan of the whole article.
function parseLinksBlock(json) {
  const s = String(json ?? '');
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v;
  } catch {
    // fall through to the incremental search
  }
  let tried = 0;
  for (let i = s.length - 1; i >= 0 && tried < 64; i--) {
    if (s[i] !== ']') continue;
    tried += 1;
    try {
      const v = JSON.parse(s.slice(0, i + 1));
      if (Array.isArray(v)) return v;
    } catch {
      // keep walking backward
    }
  }
  return null;
}

function snippetOnly(text) {
  let s = String(text ?? '').replace(SEARCH_HEADER_RE, '');
  // Every Links block, not just the first: one tool_result can carry more
  // than one search's results, and a block left behind is a title that
  // grounding would read as prose.
  for (let guard = 0; guard < 8; guard++) {
    const block = findLinksBlock(s);
    if (!block) break;
    s = s.slice(0, block.labelStart) + s.slice(block.end);
  }
  return s.replace(SEARCH_REMINDER_RE, '').trim();
}

export function parseLookupStream(stdoutText) {
  const urls = new Set();
  const linkByUrl = new Map();
  let resultText = '';
  let snippetText = '';
  let searches = 0;
  let costUsd = null;
  let envelopeText = null;
  let error = null;
  // A `Links:` block was PRESENT and could not be read as an array of
  // entries. Distinct from "no Links block at all": the second is a
  // tool_result shape we understand contributing nothing, the first is the
  // provider's format having drifted out from under this reader, and it must
  // never be indistinguishable from "the search returned no links" -- see
  // findLinksBlock's own note on the silent reversion that hid here.
  let linksParseFailed = false;

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
          const snippet = snippetOnly(text);
          if (snippet.length > 0) snippetText += (snippetText.length > 0 ? '\n' : '') + snippet;
          // Every Links block in this tool_result, located by the bracket
          // scanner rather than by a trailing-newline convention.
          let from = 0;
          for (let guard = 0; guard < 8; guard++) {
            const block = findLinksBlock(text, from);
            if (!block) break;
            from = block.end;
            const links = parseLinksBlock(block.json);
            if (links === null) {
              // Present but unreadable -- fail closed (zero URLs, so every
              // change fails grounding) AND record that it happened.
              linksParseFailed = true;
              continue;
            }
            for (const link of links) {
              if (typeof link?.url !== 'string' || link.url.length === 0) continue;
              urls.add(link.url);
              if (!linkByUrl.has(link.url)) {
                linkByUrl.set(link.url, {
                  title: typeof link.title === 'string' ? link.title : '',
                  url: link.url,
                });
              }
            }
          }
        }
      }
    } else if (obj.type === 'result') {
      if (typeof obj.total_cost_usd === 'number') costUsd = obj.total_cost_usd;
      if (obj.is_error) error = typeof obj.subtype === 'string' ? obj.subtype : 'error';
      if (typeof obj.result === 'string') envelopeText = obj.result;
    }
  }

  return {
    envelopeText, urls, links: [...linkByUrl.values()], resultText, snippetText, searches, costUsd,
    linksParseFailed,
    ...(error ? { error } : {}),
  };
}

const LOOKUP_CHANGE_KINDS = Object.freeze(['role', 'company', 'raise', 'launch', 'move', 'other']);
const LOOKUP_CHANGE_CAP = 3;
// The two kinds prompts/public_lookup.md marks `date` REQUIRED for: a change
// of EMPLOYER. Both groundLookup and storeLookup refuse an undated one -- see
// groundLookup's own note (review finding 8) for the one exemption.
const DATED_LOOKUP_KINDS = new Set(['move', 'company']);

// --- Evidence strength, and the anchor a lookup contradicts ---------------
//
// WHY ANY OF THIS EXISTS: lookup_log 4520 (person `name:nikzad khani`) sent
// name + firm "Klaviyo" (straight off the LinkedIn export) + profile URL,
// came back identity_confidence "match", and stored claim 5031 -- kind
// 'move', text "Nikzad Khani is now a Software Engineer at Verily, not
// Klaviyo as previously recorded.", quote "Nikzad Khani - Software Engineer
// - Verily". The owner is at Klaviyo; the claim was rejected.
//
// Grounding HELD: the quote really was a verbatim span of the tool_result
// text, and the URL really was one the search returned. The failure was
// EVIDENTIARY, not a grounding hole -- the quote was a `Links:` entry's
// TITLE (a search index's stale snapshot of a LinkedIn page title, or a past
// position rendered as one), and a title was turned into a present-tense
// assertion that contradicted the very anchor we supplied. Two rules follow,
// and both are code, not prompt text:
//
//   1. EVIDENCE KIND. A quote found in the provider's synthesized prose
//      ('snippet') is stronger than one that only matches a returned title
//      ('title'). Recorded per change on person_lookup_change.evidence_kind.
//   2. THE ANCHOR IS EVIDENCE TOO. The firm we sent came from the owner's
//      own LinkedIn export. A change naming a DIFFERENT company is not a
//      discovery, it is a disagreement with our own input -- and when the
//      only thing backing it is a title, a stale index and a namesake are at
//      least as likely as a real move. Such a change is stored (the owner
//      should get to see and judge the disagreement) but marked
//      contradicts_anchor=1, filed as kind 'company', withheld from the card
//      while it is pending (newestWebChange), and -- when title-only -- the
//      whole log's verdict is downgraded to 'ambiguous', because "we cannot
//      tell whether this is your person" is the honest reading.

// Tokens that are corporate boilerplate rather than identity: "Klaviyo" and
// "Klaviyo, Inc." are the same employer, and a rule that treats them as
// different companies would flag every lookup as contradicting its anchor.
const FIRM_NOISE_TOKENS = new Set([
  'inc', 'llc', 'llp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'gmbh', 'ag', 'sa', 'bv', 'nv', 'pbc', 'the',
]);

// POSSESSIVES ARE NORMALISED BEFORE ANYTHING ELSE, and the order matters:
// stripping the apostrophe first turned "Klaviyo's" into the token
// "klaviyos", which is not "klaviyo", so every sentence phrased "Klaviyo's
// engineering team" read as naming a company we had never heard of -- a
// false contradiction of the anchor, on the owner's own firm. The `'s` goes
// first, THEN the remaining apostrophes.
function firmTokens(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ']s\b/gu, '')
    .replace(/[‘’ʼ']/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !FIRM_NOISE_TOKENS.has(t));
}

// Same employer, for the purpose of "does this change disagree with the firm
// we sent". Deliberately generous in the direction of SAME: one token list
// being a contiguous run inside the other counts ("Google" vs "Google
// Cloud", "Klaviyo" vs "Klaviyo Inc"). Being wrong in this direction under-
// flags a real move, which the owner can still see on the claim itself;
// being wrong the other way flags every ordinary lookup.
export function sameFirm(a, b) {
  const x = firmTokens(a);
  const y = firmTokens(b);
  if (x.length === 0 || y.length === 0) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((t, j) => t === long[i + j])) return true;
  }
  return false;
}

// A capitalized run of up to four words -- the shape a company name takes
// inside an English sentence or a LinkedIn page title. Not an NER model and
// not trying to be: every pattern below anchors on a word that says
// "employer follows", so the capture only has to stop in a sensible place.
const CAP_WORD = "[A-Z][\\p{L}\\p{N}&.'\\u2019-]*";
const CAP_PHRASE = `${CAP_WORD}(?:[ ](?:of |and |the |for |de )?${CAP_WORD}){0,3}`;

// DEPARTURE phrasings. These are read on a change of ANY kind, and they are
// the ONE family whose captured name is useful even when nothing corroborates
// it -- because what matters about a departure is whether the company being
// left is the anchor we sent. "left Klaviyo" with anchor Klaviyo is a
// contradiction of the anchor whether or not a second company is named
// anywhere (review finding 9: such a change used to be stored as an ordinary
// 'move' and served on the card while pending). A departure naming some other
// company is simply ignored, which is why a sloppy capture here cannot
// produce a false positive.
const DEPARTURE_PATTERNS = [
  `\\bnot\\s+(${CAP_PHRASE})`,
  `\\bno longer\\s+(?:at|with|works at|working at|employed by)\\s+(${CAP_PHRASE})`,
  `\\b(?:left|departed|has left|is leaving|departing)\\s+(${CAP_PHRASE})`,
].map((p) => new RegExp(p, 'gu'));

// EMPLOYER-NAMING shapes, deliberately narrowed to the two that search
// results actually carry -- `Role at Company` and `Name - Role - Company` --
// after review finding 2 caught the wider set inventing employers:
//
//   - `moved/relocated to X` matched "moved to San Francisco", so a CITY
//     became a company that disagreed with the anchor. Removed outright: a
//     lookup change of kind 'move' is about a change of employer in this
//     schema, and "moved to" in English is more often about a place.
//   - `joins/joined/hired by X` stated employment honestly enough, but named
//     companies that nothing in the returned results corroborated. Dropped
//     with the same reasoning as the corroboration rule below: a company
//     that exists only inside the model's own sentence is not an observation.
//   - `now at/with X` is covered by the bare `at X` reading below.
//
// A bare "at X" only names an employer when the change itself claims to be
// about a role, a company or a move -- otherwise "spoke at Web Summit" would
// read as an employer. Same reasoning for the LinkedIn-title shape.
const AT_PATTERN = new RegExp(`\\bat\\s+(${CAP_PHRASE})`, 'gu');
const FIRM_BEARING_KINDS = new Set(['role', 'company', 'move']);

// The venues whose titles we are reading, trimmed off a title's tail so
// "Name - Role - Company | LinkedIn" yields Company rather than LinkedIn.
const TITLE_VENUES = new Set([
  'linkedin', 'twitter', 'x', 'facebook', 'github', 'crunchbase', 'medium',
  'substack', 'bloomberg', 'wellfound', 'angellist',
]);

// Corporate-form tokens that mark a segment as an ORGANISATION even though
// it carries a comma ("Klaviyo, Inc."), so the location rule below cannot
// eat a company whose own name is comma-shaped.
const CORPORATE_FORM_RE = /\b(?:inc|llc|llp|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|bv|nv|pbc)\b/iu;
// A LinkedIn page title's own tail is a PLACE: "Nikzad Khani - Klaviyo -
// Boston, Massachusetts | LinkedIn". Read as a company (which it was before
// review finding 2), the owner's own firm anchor "disagreed" with a city and
// every LinkedIn-titled lookup flagged itself.
const LOCATION_HINT_RE = /\b(?:area|region|metro|metropolitan|greater)\b/iu;
const US_STATE_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico',
  'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia', 'united states', 'united kingdom', 'england', 'canada', 'ireland',
]);

function looksLikeLocation(segment) {
  const s = String(segment ?? '').trim();
  if (s.length === 0) return false;
  if (CORPORATE_FORM_RE.test(s)) return false;
  if (s.includes(',')) return true;
  if (LOCATION_HINT_RE.test(s)) return true;
  return US_STATE_NAMES.has(s.toLowerCase());
}

// "Nikzad Khani - Software Engineer - Verily | LinkedIn" -> "Verily";
// "Nikzad Khani - Klaviyo - Boston, Massachusetts | LinkedIn" -> "Klaviyo",
// never the city. Needs at least three segments once the venue tail is
// trimmed -- a two-segment title ("Jane Doe | LinkedIn") names no company at
// all -- but only two once a LOCATION tail has been trimmed as well, because
// that is the `Name - Company - Place` shape LinkedIn actually emits.
function companyFromTitleShape(text) {
  const segments = String(text ?? '').split(/\s+[-–—|]\s+/u).map((s) => s.trim()).filter(Boolean);
  while (segments.length > 0 && TITLE_VENUES.has(segments[segments.length - 1].toLowerCase())) {
    segments.pop();
  }
  let droppedLocation = false;
  while (segments.length > 0 && looksLikeLocation(segments[segments.length - 1])) {
    segments.pop();
    droppedLocation = true;
  }
  const minimum = droppedLocation ? 2 : 3;
  return segments.length >= minimum ? segments[segments.length - 1] : null;
}

function collect(re, text, into) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = String(m[1] ?? '').replace(/[\s.,;:'’-]+$/u, '').trim();
    if (v.length > 0) into.add(v);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
}

// companiesNamed(text, kind): every company name this change's own words
// point at, via the two employer-naming shapes above -- bare "at X" and the
// LinkedIn-title shape -- and only for the three kinds that claim to be
// about employment. A change of any other kind names no employer here, which
// is why "spoke at Web Summit" on a 'launch' is not read as a job.
export function companiesNamed(text, kind) {
  const s = String(text ?? '');
  const out = new Set();
  if (FIRM_BEARING_KINDS.has(kind)) {
    collect(AT_PATTERN, s, out);
    const titled = companyFromTitleShape(s);
    if (titled) out.add(titled);
  }
  return [...out];
}

// departuresNamed(text): the companies this text says the person has LEFT.
// Read on every kind -- a departure is a statement about employment whatever
// the model filed the change as.
export function departuresNamed(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const re of DEPARTURE_PATTERNS) collect(re, s, out);
  return [...out];
}

// titleCompanies(observed): the companies extractable from the titles this
// lookup's own search RETURNED. This is the corroboration set -- see
// contradictsAnchorFirm.
export function titleCompanies(observed) {
  const links = Array.isArray(observed?.links) ? observed.links : [];
  const out = new Set();
  for (const link of links) {
    const company = companyFromTitleShape(link?.title);
    if (company) out.add(company);
  }
  return [...out];
}

// contradictsAnchorFirm(change, firm, {titles}): does this change disagree
// with the firm anchor we sent?
//
// TWO WAYS, and only two:
//
//  1. DEPARTURE FROM THE ANCHOR. The change says the person left, or is no
//     longer at, or is "not", the very firm we sent. No second company is
//     needed and none is looked for: "left Klaviyo" with anchor Klaviyo is a
//     competing claim about where this person works, and review finding 9
//     caught it being stored as an ordinary 'move' and shown on the card.
//
//  2. A CORROBORATED OTHER COMPANY. The change names a company that is not
//     the anchor AND that company also appears as the company position of a
//     title the search actually returned. The corroboration requirement is
//     the fix for review finding 2: without it, any capitalized phrase the
//     model happened to put after "at" -- a conference, a city, a product --
//     rewrote the change's kind to 'company', withheld it from the card and
//     downgraded the whole log to 'ambiguous'. With it, the disagreement has
//     to be visible in what came back, not only in what the model wrote.
//
// `titles` defaults to empty, which leaves rule 1 in force and rule 2 unable
// to fire -- the conservative direction for a caller with no stream in hand
// (storeLookup called without `observed`).
//
// lookup_log 4520 still trips BOTH rules: its text "at Verily, not Klaviyo
// as previously recorded" is a departure from the anchor Klaviyo, and its
// quote is the returned title whose own company position is Verily.
export function contradictsAnchorFirm({ kind, text, quote }, firm, { titles = [] } = {}) {
  if (typeof firm !== 'string' || firmTokens(firm).length === 0) return false;
  for (const left of [...departuresNamed(text), ...departuresNamed(quote)]) {
    if (sameFirm(left, firm)) return true;
  }
  const corroborated = Array.isArray(titles) ? titles : [];
  if (corroborated.length === 0) return false;
  const named = [...companiesNamed(text, kind), ...companiesNamed(quote, kind)];
  return named.some((c) => !sameFirm(c, firm) && corroborated.some((t) => sameFirm(c, t)));
}

// Words that assert a state holds RIGHT NOW. A title cannot support one:
// prompts/public_lookup.md v2 forbids them outright without a stated date,
// and this is the code that does not take the prompt's word for it.
const PRESENT_TENSE_RE = /\b(?:now|currently|presently|no longer|these days|as of today)\b/iu;

// evidenceKindFor(quote, observed): 'title' when the quote is (or is inside)
// one of the returned `Links:` titles, 'snippet' when it is a verbatim span
// of the provider's synthesized prose and no title carries it, null when it
// is neither -- which is a grounding failure, not a weak change.
//
// ~~TITLE IS CHECKED FIRST, and that ordering is review finding 13.~~
// REVERSED 2026-09 (review G finding 12), and the reasoning it replaced is
// worth keeping because half of it was right. It said: a provider routinely
// echoes a page's title inside its own summary prose, so a quote that is a
// title AND appears in prose answered 'snippet' -- the strong-evidence
// answer -- and bypassed every title-only rule (the present-tense drop, the
// 'ambiguous' downgrade) for the exact quote shape that caused lookup_log
// 4520. "A title does not become a published statement about somebody by
// being repeated" is true.
//
// What it got wrong is which text it was reasoning about. Checking title
// first made the WEAKER label win whenever both applied, so a sentence the
// provider actually wrote in its own prose -- real synthesized evidence --
// was labelled 'title' and then dropped by the present-tense rule for
// happening to be a substring of some link's title. The label now describes
// what the quote IS: found verbatim in the prose snippet, it is a snippet;
// absent from the prose, and carried only by a title, it is a title.
//
// AND THE CASE THE REORDER WAS ACTUALLY FOR IS STILL COVERED. Without a
// separate `snippetText`, the fallback is `resultText`, which still CONTAINS
// the `Links:` block -- so a title-only quote would match it and read as
// prose it never appeared in. Prose therefore only wins when the prose is
// genuinely separable; on the fallback the title is checked first, which is
// precisely the 4520 shape. Legacy callers with neither field keep reading
// as 'snippet', exactly the behaviour this file had before the split.
export function evidenceKindFor(quote, observed) {
  const q = String(quote ?? '');
  if (q.length === 0) return null;
  const links = Array.isArray(observed?.links) ? observed.links : [];
  const inTitle = links.some((link) =>
    typeof link?.title === 'string' && link.title.length > 0 && link.title.includes(q));
  const proseSeparated = typeof observed?.snippetText === 'string';
  const prose = proseSeparated ? observed.snippetText : String(observed?.resultText ?? '');
  if (proseSeparated && prose.includes(q)) return 'snippet';
  if (inTitle) return 'title';
  if (prose.includes(q)) return 'snippet';
  return null;
}

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
//
// `anchors.firm` is the third input, and it is not optional decoration: the
// firm we SENT is evidence, and a change disagreeing with it is a different
// kind of object than a change adding to it. See the evidence-strength
// section above for the incident that made that distinction load-bearing.
// Each kept change therefore carries two extra fields:
//   evidenceKind       'snippet' | 'title'
//   contradictsAnchor  true when the change names a company that is not the
//                      firm anchor -- kept, refiled as kind 'company', and
//                      withheld from the card while pending.
//
// A move/company change with no YYYY-MM date is DROPPED here, which
// prompts/public_lookup.md has asked of the model since v2 ("`date` is
// REQUIRED for kind move and company") and nothing enforced (review finding
// 8). The one exemption is an anchor contradiction: that row is a review
// item about WHICH firm this person is at, deliberately stored so the owner
// can judge the disagreement, and dropping it for want of a date would put
// us back to silently discarding exactly the 4520 shape.
//
// Every reason a change can be dropped, as a FIXED CODE. Nothing
// model-controlled is ever interpolated into one (review finding 14): these
// strings are counted, logged and read on the desk, and a drop reason that
// can carry arbitrary model text is a log-injection seam for no benefit --
// the model's own claims are already recorded, validated, in their own
// columns.
export const LOOKUP_DROP_REASONS = Object.freeze({
  noEnvelope: 'no envelope',
  notMatch: 'identity_confidence is not "match"',
  notAnObject: 'change is not an object',
  badKind: 'kind is not one of the six',
  badText: 'text is missing, empty, or over 200 characters',
  badQuote: 'quote is missing or empty',
  ungroundedQuote: 'quote is not a verbatim substring of a search result',
  missingUrl: 'url is missing',
  unparseableUrl: 'url does not parse',
  notHttps: 'url is not https',
  deniedHost: 'url host is denylisted',
  urlNotReturned: "url was never returned by this lookup's own search",
  presentTenseTitle: 'a title-only role/company/move change may not be phrased as current',
  missingDate: 'a move/company change without a YYYY-MM date is not reportable',
});

export function groundLookup(envelope, observed, { firm = null } = {}) {
  const kept = [];
  const dropped = [];
  const noteDrop = (reason) => dropped.push({ reason });

  if (envelope === null || typeof envelope !== 'object') {
    return { kept: [], dropped: [{ reason: LOOKUP_DROP_REASONS.noEnvelope }] };
  }
  if (envelope.identity_confidence !== 'match') {
    // On ambiguous/no_match, changes MUST already be empty per
    // prompts/public_lookup.md -- but this is enforced here too, not merely
    // asked of the prompt: a model that ignores its own instructions and
    // proposes changes anyway must still see them dropped.
    //
    // The reason is a FIXED CODE, never the model's own string interpolated
    // into it (review finding 14): identity_confidence is model-controlled
    // text, and a drop reason is written to logs and read on the desk. The
    // value itself is already recorded, validated against three literals, in
    // lookup_log.identity_confidence.
    const n = Array.isArray(envelope.changes) ? envelope.changes.length : 0;
    if (n > 0) noteDrop(LOOKUP_DROP_REASONS.notMatch);
    return { kept: [], dropped };
  }

  // The corroboration set for the anchor rule: companies named by titles the
  // search actually returned. Computed once for the whole batch.
  const titles = titleCompanies(observed);
  const changes = Array.isArray(envelope.changes) ? envelope.changes.slice(0, LOOKUP_CHANGE_CAP * 4) : [];
  for (const item of changes) {
    if (kept.length >= LOOKUP_CHANGE_CAP) break;
    if (item === null || typeof item !== 'object') { noteDrop(LOOKUP_DROP_REASONS.notAnObject); continue; }
    if (!LOOKUP_CHANGE_KINDS.includes(item.kind)) { noteDrop(LOOKUP_DROP_REASONS.badKind); continue; }
    if (typeof item.text !== 'string' || item.text.trim().length === 0 || item.text.length > 200) {
      noteDrop(LOOKUP_DROP_REASONS.badText);
      continue;
    }
    if (typeof item.quote !== 'string' || item.quote.length === 0) {
      noteDrop(LOOKUP_DROP_REASONS.badQuote);
      continue;
    }
    const evidenceKind = evidenceKindFor(item.quote, observed);
    if (evidenceKind === null) {
      noteDrop(LOOKUP_DROP_REASONS.ungroundedQuote);
      continue;
    }
    if (typeof item.url !== 'string' || item.url.length === 0) {
      noteDrop(LOOKUP_DROP_REASONS.missingUrl);
      continue;
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(item.url);
    } catch {
      noteDrop(LOOKUP_DROP_REASONS.unparseableUrl);
      continue;
    }
    if (parsedUrl.protocol !== 'https:') { noteDrop(LOOKUP_DROP_REASONS.notHttps); continue; }
    if (isLookupUrlDenied(parsedUrl)) { noteDrop(LOOKUP_DROP_REASONS.deniedHost); continue; }
    if (!observed.urls.has(item.url)) { noteDrop(LOOKUP_DROP_REASONS.urlNotReturned); continue; }
    const date = typeof item.date === 'string' && /^\d{4}-\d{2}$/u.test(item.date) ? item.date : null;
    const text = item.text.trim();

    // THE ANCHOR CHECK, ahead of the present-tense check on purpose: a
    // change that disagrees with the firm we sent is the one thing the owner
    // most needs to SEE (4520 was rejected in one click once he saw it), so
    // it is kept and flagged rather than dropped. Its kind is rewritten to
    // 'company' because that is what it actually is -- a competing claim
    // about which company this person is at -- whatever the model filed it
    // as ('move', for 4520).
    if (contradictsAnchorFirm({ kind: item.kind, text, quote: item.quote }, firm, { titles })) {
      kept.push({
        kind: 'company', text, url: item.url, quote: item.quote, date,
        evidenceKind, contradictsAnchor: true,
      });
      continue;
    }

    // A title is a search index's snapshot of a page's <title>, not a dated
    // statement that somebody currently holds a role. So a role/company/move
    // change resting on nothing but a title may not be phrased as current.
    // Rewriting the model's sentence for it is not an option -- that would
    // be composing a claim the search results never made -- so the change is
    // dropped, visibly, as 'ungrounded'. A `date` does NOT buy an exemption:
    // a page title states no date, so a date beside a title-only quote is
    // the model's inference, which is the thing being ruled out.
    if (evidenceKind === 'title' && FIRM_BEARING_KINDS.has(item.kind) && PRESENT_TENSE_RE.test(text)) {
      noteDrop(LOOKUP_DROP_REASONS.presentTenseTitle);
      continue;
    }

    // THE DATE REQUIREMENT, enforced rather than asked (review finding 8).
    // prompts/public_lookup.md has said since v2 that `date` is REQUIRED for
    // move and company -- "a change of employer without a date is not
    // reportable here" -- and no code checked it, so an undated change of
    // employer was stored, shown on the card and dated by the day we
    // happened to run the lookup. Kinds role/raise/launch/other are
    // deliberately unaffected: for those the prompt calls a date optional.
    if (DATED_LOOKUP_KINDS.has(item.kind) && date === null) {
      noteDrop(LOOKUP_DROP_REASONS.missingDate);
      continue;
    }

    kept.push({
      kind: item.kind, text, url: item.url, quote: item.quote, date,
      evidenceKind, contradictsAnchor: false,
    });
  }

  return { kept, dropped };
}

// --- DB half ------------------------------------------------------------

function parseSubRoles(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function anchorsHash(anchors) {
  return createHash('sha256').update(JSON.stringify({
    name: anchors?.name ?? null,
    firm: anchors?.firm ?? null,
    handle: anchors?.handle ?? null,
    profileUrl: anchors?.profileUrl ?? null,
  }), 'utf8').digest('hex');
}

// anchorsStmtsFor(db): the four prepared statements anchorsFor needs, built
// ONCE by a caller that invokes anchorsFor in a loop (lookupScope) so a
// multi-thousand-row scan does not re-prepare the same four statements once
// per person. anchorsFor still prepares them itself (once, not per row) when
// called standalone (lookupPerson, tests) and no bundle is passed in.
function anchorsStmtsFor(db) {
  return {
    person: db.prepare('SELECT display_name AS name, linkedin FROM people WHERE person_key = ?'),
    proposedFirm: db.prepare(
      `SELECT psp.value AS value FROM person_sweep_proposal psp JOIN claim c ON c.id = psp.claim_id
       WHERE c.subject = 'person' AND c.subject_person_key = ? AND psp.kind = 'firm'
         AND (SELECT d.action FROM claim_decision d WHERE d.claim_id = psp.claim_id ORDER BY d.id DESC LIMIT 1) = 'accept'
       ORDER BY psp.claim_id DESC LIMIT 1`
    ),
    hasTwitterChannel: db.prepare('SELECT 1 FROM person_channels WHERE person_key = ? AND source = ?'),
    // PER-IDENTIFIER source, via identity_evidence -- the fix for a claim
    // this file used to make and not keep. person_identifiers is
    // (identifier, person_key) and carries NO source column, so the old
    // `SELECT identifier FROM person_identifiers WHERE person_key = ?`
    // returned EVERY identifier this person has ever been seen under, on any
    // channel: a Slack member id (U024BE7LH), a bare-numeric Telegram id, a
    // phone number. person_channels only established that the person has *a*
    // twitter channel somewhere, which is not evidence about any particular
    // identifier -- the comment below claiming otherwise was simply false.
    // identity_evidence(person_key, identifier, source) is the table that
    // does know, so the join is against that. ORDER BY makes the pick
    // deterministic: without it the chosen handle flipped across projection
    // rebuilds, which changed anchors_hash, which re-dued the person, which
    // burned the daily cap.
    identifiers: db.prepare(
      `SELECT DISTINCT pi.identifier AS identifier
       FROM person_identifiers pi
       JOIN identity_evidence ie ON ie.person_key = pi.person_key AND ie.identifier = pi.identifier
       WHERE pi.person_key = ? AND ie.source = ?
       ORDER BY pi.identifier`
    ),
  };
}

// anchorsFor(db, personKey, stmts?): the ONLY place that reads corpus/projection
// state to build the {name,firm,handle,profileUrl} object buildLookupQuery's
// input gate accepts. Field by field, BY NAME -- never a spread of
// people.linkedin, which also carries an email address (conflict (c) in the
// design this file follows): only .company and .url are read off it.
//
// `stmts`, when given (lookupScope's own anchorsStmtsFor bundle, prepared
// once for the whole scan), is used instead of preparing these four
// statements again for this call -- the fix for a per-person re-prepare that
// used to run once per row across the whole `people` table. Omitted (the
// default), anchorsFor prepares its own bundle, same behavior as before this
// existed.
export function anchorsFor(db, personKey, stmts = null) {
  const s = stmts ?? anchorsStmtsFor(db);
  const person = s.person.get(personKey);
  if (!person) return { name: null, firm: null, handle: null, profileUrl: null };

  const name = typeof person.name === 'string' && person.name.trim().length > 0 ? person.name : null;

  let linkedin = null;
  if (typeof person.linkedin === 'string' && person.linkedin.length > 0) {
    try { linkedin = JSON.parse(person.linkedin); } catch { linkedin = null; }
  }

  // firm: the LinkedIn export's own company field, when present; else the
  // owner's most recent ACCEPTED sweep-proposed firm (sweep.mjs) -- a
  // PENDING proposal is not yet the person's word, so it is not read here.
  // "Latest decision wins", the same rule sweep.mjs's alreadyProposed uses.
  let firm = linkedin && typeof linkedin.company === 'string' && linkedin.company.trim().length > 0
    ? linkedin.company
    : null;
  if (firm === null) {
    const proposed = s.proposedFirm.get(personKey);
    if (proposed && typeof proposed.value === 'string' && proposed.value.trim().length > 0) firm = proposed.value;
  }
  // An email-shaped firm makes buildLookupQuery THROW, and that throw used
  // to travel: lookupScope calls buildLookupQuery unguarded once per person,
  // so ONE accepted sweep firm proposal of the form "foo@bar.com" -- which
  // storeSweep will happily ground, since it only requires the value to be a
  // verbatim substring of its own quote -- 500'd /admin/relationship/lookup,
  // /lookup/person and /admin/relationship/lint, and silently nulled
  // /stats.lookup and /stats.lint, permanently, with nothing logged to say
  // which row did it. Refused here instead, before it can reach the gate:
  // the person simply loses their firm anchor. Same for a display_name
  // carrying an address ("Jane Doe (jane@acme.com)"), which isAnonymousContact
  // does not catch because it only matches a whole-string address -- and
  // which is not a name worth searching the public web for anyway.
  if (firm !== null && EMAIL_SHAPE_RE.test(firm)) firm = null;
  const safeName = name !== null && !EMAIL_SHAPE_RE.test(name) ? name : null;

  // handle: an identifier that both (a) looks like a public handle (see
  // isPublicHandle -- shape tested before stripping, never all-digit) and
  // (b) has identity_evidence saying it came through the twitter channel.
  // The person_channels read stays as a belt: it establishes the person has
  // that channel at all, which is cheap and lets the join be skipped.
  let handle = null;
  const hasTwitterChannel = s.hasTwitterChannel.get(personKey, 'twitter');
  if (hasTwitterChannel) {
    const ids = s.identifiers.all(personKey, 'twitter');
    const match = ids.find((r) => isPublicHandle(r.identifier));
    if (match) handle = match.identifier;
  }

  const profileUrl = linkedin && typeof linkedin.url === 'string' && linkedin.url.trim().length > 0
    ? linkedin.url
    : null;

  return { name: safeName, firm, handle, profileUrl };
}

// lookupTierFor(db, personKey, {now, eligibleKeys?, subRolesStmt?}): 'eligible'
// (producer.mjs's own reconnect pool -- the broadest, most-likely-to-benefit-
// from-a-refresh set), else 'tagged' (a founder/investor sub-role, without
// yet meeting eligiblePool's quiet-days/history gates), else 'other'.
//
// `eligibleKeys`, when given, is a Set of every eligiblePool member's
// personKey computed ONCE by the caller (lookupScope, over its whole scan)
// -- membership is then a Set lookup instead of recomputing the entire
// eligible pool (a multi-CTE query over people + calendar + links) again for
// this one person. Omitted (the default, and every standalone caller such as
// hermes.mjs's /lookup/person route), this falls back to computing the pool
// itself, same behavior as before eligibleKeys existed. `subRolesStmt`
// likewise lets a looping caller pass one prepared statement instead of this
// function preparing its own on every call.
export function lookupTierFor(db, personKey, { now = Date.now(), eligibleKeys = null, subRolesStmt = null } = {}) {
  const inEligiblePool = eligibleKeys
    ? eligibleKeys.has(personKey)
    : eligiblePool(db, { mode: 'any', now }).some((p) => p.personKey === personKey);
  if (inEligiblePool) return 'eligible';
  const row = subRolesStmt
    ? subRolesStmt.get(personKey)
    : db.prepare('SELECT sub_roles FROM people WHERE person_key = ?').get(personKey);
  const subRoles = parseSubRoles(row?.sub_roles);
  if (subRoles.some((r) => r === 'founder' || r === 'investor')) return 'tagged';
  return 'other';
}

// lookupScope(db, {now}): every named (not isAnonymousContact), not
// rm_suppression'd person -- the BROAD population, deliberately not filtered
// by due-ness or by whether buildLookupQuery can build a query for them.
// Both of those are exposed per-candidate instead (anchored, anchorsHash,
// storedAnchorsHash, nextDueAt) so two different callers can apply two
// different narrower filters without a second query: lookupGate treats an
// EMPTY scope as 'no-scope' (nobody addressable at all), while runLookupPass
// separately filters this same scope down to who is actually DUE right now
// and treats an empty result THERE as 'no-due' (mirrors sweepScope/
// runSweepPass's own split between an empty scope and "no new rows").
// ORDER BY tier (eligible, tagged, other), then least-recently-looked-up
// first.
// `personKey`, when given, narrows the base population to that one person --
// used by the /admin/relationship/lookup/person route (a later commit) to
// build a one-candidate scope for "look this person up now" rather than
// letting the ordinary tier/recency ordering pick who runLookupPass spends
// its budget on. Omitted (the default), this is the full population every
// ordinary pass considers.
export function lookupScope(db, { now = Date.now(), personKey = null } = {}) {
  const rows = personKey
    ? db.prepare(
        `SELECT p.person_key AS personKey, p.display_name AS name
         FROM people p
         WHERE p.person_key = ? AND p.person_key NOT IN (SELECT person_key FROM rm_suppression)`
      ).all(personKey)
    : db.prepare(
        `SELECT p.person_key AS personKey, p.display_name AS name
         FROM people p
         WHERE p.person_key NOT IN (SELECT person_key FROM rm_suppression)`
      ).all();

  const stateStmt = db.prepare(
    `SELECT anchors_hash AS anchorsHash, last_looked_at AS lastLookedAt, next_due_at AS nextDueAt
     FROM person_lookup_state WHERE person_key = ?`
  );
  // Computed ONCE for the whole scan, not once per person: eligiblePool
  // itself is a multi-CTE query over people + calendar + links, and this
  // function used to call it (via lookupTierFor) for every row -- the
  // 91%-CPU-for-ten-minutes bug over 7,359 people. anchorStmts and
  // subRolesStmt are the same fix applied to anchorsFor's and
  // lookupTierFor's own per-call db.prepare()s.
  const eligibleKeys = new Set(eligiblePool(db, { mode: 'any', now }).map((p) => p.personKey));
  const anchorStmts = anchorsStmtsFor(db);
  const subRolesStmt = db.prepare('SELECT sub_roles FROM people WHERE person_key = ?');

  const out = [];
  for (const row of rows) {
    if (isAnonymousContact({ name: row.name, key: row.personKey })) continue;
    const anchors = anchorsFor(db, row.personKey, anchorStmts);
    // GUARDED, and not merely defensively: buildLookupQuery throws on a
    // structural violation of its own allowlist, and this loop runs over
    // every person in the house. One malformed anchor set used to take down
    // /admin/relationship/lookup, /lookup/person and /admin/relationship/lint
    // together and null /stats.lookup forever (see anchorsFor's own email
    // note). A person whose anchors cannot be assembled is UNANCHORED --
    // which is a state this function already models, already reports, and
    // already excludes from the budget. anchorError records that it happened
    // WITHOUT recording the value that caused it: the value is the reason
    // this is a problem, so it must not be copied anywhere new.
    let built = null;
    let anchorError = false;
    try {
      built = buildLookupQuery(anchors);
    } catch {
      built = null;
      anchorError = true;
    }
    const state = stateStmt.get(row.personKey);
    out.push({
      personKey: row.personKey,
      name: row.name,
      tier: lookupTierFor(db, row.personKey, { now, eligibleKeys, subRolesStmt }),
      anchored: built !== null,
      anchorError,
      anchorsHash: anchorsHash(anchors),
      storedAnchorsHash: state ? state.anchorsHash : null,
      lastLookedAt: state && state.lastLookedAt !== null && state.lastLookedAt !== undefined
        ? Number(state.lastLookedAt) : null,
      nextDueAt: state && state.nextDueAt !== null && state.nextDueAt !== undefined
        ? Number(state.nextDueAt) : null,
    });
  }

  const TIER_ORDER = { eligible: 0, tagged: 1, other: 2 };
  out.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || (a.lastLookedAt ?? 0) - (b.lastLookedAt ?? 0));
  return out;
}

// A candidate is DUE when it has never been looked up, its schedule has
// come around, or its anchors changed since the last lookup (a new firm, a
// LinkedIn URL that finally resolved) -- the same "something changed" signal
// next_due_at alone cannot capture.
function isLookupDue(candidate, now) {
  return candidate.nextDueAt === null
    || candidate.nextDueAt <= now
    || candidate.storedAnchorsHash !== candidate.anchorsHash;
}

// policy carries the same per-process relationship holder every other
// relationship route reads -- see sweep.mjs's identical relFlags, duplicated
// here rather than imported (it is not exported from sweep.mjs, and
// importing a private helper across files is not a boundary worth crossing
// for four lines).
function relFlags(policy) {
  const holder = policy?.relationshipHolder ?? policy ?? {};
  return holder.__relationship ?? holder;
}

// Skip order, each writing a person_lookup_run row status='skipped', never a
// silent return -- same discipline as sweepGate/runSweepPass. An ABSENT
// power field is unknown, not a skip.
export function lookupGate(db, policy, { powerMode = 'trickle', battery = null, onAc = null, thermal = null, engine } = {}) {
  void powerMode;
  if (onAc === false && typeof battery === 'number' && battery < 40) {
    return { ok: false, reason: 'battery' };
  }
  if (thermal === 'serious' || thermal === 'critical') {
    return { ok: false, reason: 'thermal' };
  }
  const rel = relFlags(policy);
  if (rel?.pagesBuildingActive || rel?.sweepActive || rel?.lookupActive) {
    return { ok: false, reason: 'busy-model' };
  }
  // NO llama fallback for lookup (see engines.mjs createLookupEngine): a
  // null engine here means neither an override nor a resolvable claude
  // binary, and there is nothing else safe to run this against.
  if (!engine) {
    return { ok: false, reason: 'no-engine' };
  }
  // LOCAL cap: rate limits, not dollars, are the ceiling (see
  // LOOKUP_DAILY_CALL_CAP_DEFAULT's own comment).
  const cap = lookupCallCap(policy);
  const since = Date.now() - DAY;
  const used = Number(
    db.prepare('SELECT COALESCE(SUM(model_calls), 0) AS n FROM person_lookup_run WHERE started_at >= ?')
      .get(since).n
  );
  if (used >= lookupCallCeiling(cap)) return { ok: false, reason: 'quota' };
  const scope = lookupScope(db, { now: Date.now() });
  if (scope.length === 0) return { ok: false, reason: 'no-scope' };
  return { ok: true, reason: null };
}

// lookupCallCap(policy) / lookupCallCeiling(cap): the daily call cap, and
// the number the gate actually compares against.
//
// A config value that is not a finite number used to make the whole gate
// FAIL OPEN: `Number("many")` is NaN, `used >= 0.9 * NaN` is false, and the
// cap silently stopped existing -- a config typo bought unlimited web
// searches. Non-finite and non-positive values fall back to the default
// instead. And the ceiling is 90% of the cap, which lookupStatus used to
// hide by reporting the bare DEFAULT constant: an owner who set the cap to
// 40 read "20" on /stats and the gate actually stopped at 36. Both numbers
// come from here now, so the reported ceiling is the enforced one.
export function lookupCallCap(policy) {
  const raw = Number(policy?.relationshipMemory?.lookupDailyCallCap);
  return Number.isFinite(raw) && raw > 0 ? raw : LOOKUP_DAILY_CALL_CAP_DEFAULT;
}

export function lookupCallCeiling(cap) {
  return 0.9 * cap;
}

function insertLookupLog(db, {
  personKey, runId, at, engine, query, queryHash, fieldsUsed, searches, urlsSeen,
  identityConfidence, changesProposed, changesDropped, costUsd, status,
}) {
  return Number(
    db.prepare(
      `INSERT INTO lookup_log(person_key, run_id, at, engine, query, query_hash, fields_used, searches, urls_seen,
         identity_confidence, changes_proposed, changes_dropped, cost_usd, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      personKey, runId ?? null, at, engine, query, queryHash, JSON.stringify(fieldsUsed ?? []),
      searches ?? 0, urlsSeen ?? 0, identityConfidence ?? null, changesProposed ?? 0, changesDropped ?? 0,
      costUsd ?? null, status
    ).lastInsertRowid
  );
}

function extractJsonObject(text) {
  const fenced = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = (fenced ? fenced[1] : String(text ?? '')).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in output');
  return body.slice(start, end + 1);
}

// storeLookup(db, {personKey, kept, observed, firm, logId, distillRunId, now}):
// the trusted apply path, mirroring storeSweep/storePage. EVERY grounding rule
// groundLookup already checked is re-checked here against what is about to
// be written, because a client (groundLookup) is not a boundary. One
// BEGIN..COMMIT for the whole batch of kept changes.
//
// `observed` and `firm` are what make that claim TRUE rather than aspirational.
// This function used to re-check kind/text/quote-nonempty/https/denylist and
// silently skip the only two rules that carry the grounding -- "this URL is
// one the search returned" and "this quote is a verbatim span of what came
// back" -- so a caller that skipped groundLookup entirely could store a
// fabricated citation. Both are re-run below, and evidence_kind /
// contradicts_anchor are RECOMPUTED here rather than taken from the caller's
// object. Omitting `observed` re-checks everything it can and records
// evidence_kind NULL; a caller with the stream in hand should always pass it.
//
// Idempotence: the (source, entity_id) check dedupes the CONTEXT row, which
// was never enough on its own -- a monthly lookup finding the same (url,
// quote) again used to insert a second identical PENDING claim against the
// one context row, and duplicate pending claims reading as corroboration is
// the documented 2026-08-19 incident. `selDup` below is the missing
// alreadyProposed analogue: an undecided-or-accepted claim already citing
// this (personKey, url, quote) blocks a second one. A REJECTED one does not
// -- the owner said no to that claim, and a later lookup finding the same
// thing is entitled to ask again.
//
// Row mapping per kept change: a NEW context row (source='web', so it
// carries the same source-receipt and deletion story as every other row;
// entity_id derived from sha256(url + quote) so the SAME (url, quote) pair
// is idempotent across repeated lookups rather than duplicating -- checked
// via (source, entity_id) first, exactly like insertRows' own upsert
// check); a claim (subject='person', kind='fact', PENDING by construction --
// no claim_decision is ever written here); a claim_source snapshot (the
// receipt: which context row, which exact quote); and a person_lookup_change
// row recording which kind of change this is and the url it cites. No
// person_page_item row -- its `section` CHECK is closed to the five page
// sections and a lookup change is not one of them.
export function storeLookup(db, {
  personKey, kept, observed = null, firm = null, logId, distillRunId, now = Date.now(),
} = {}) {
  if (!Array.isArray(kept) || kept.length === 0) return { stored: 0, skipped: 0, duplicates: 0 };

  const logRow = db.prepare('SELECT query_hash AS queryHash FROM lookup_log WHERE id = ?').get(logId);
  const queryHash = logRow?.queryHash ?? null;

  const selCtx = db.prepare('SELECT id FROM context WHERE source = ? AND entity_id = ?');
  const insCtx = db.prepare(
    `INSERT INTO context(ts, source, speaker, text, meta, entity_id, content_hash, store_changed_at)
     VALUES (?, 'web', NULL, ?, ?, ?, ?, ?)`
  );
  const insClaim = db.prepare(
    `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
     VALUES (?, 'person', ?, 'fact', ?, ?, NULL, NULL, ?)`
  );
  const insSource = db.prepare(
    `INSERT INTO claim_source(claim_id, context_id, source, entity_id, content_hash, quote)
     VALUES (?, ?, 'web', ?, ?, ?)`
  );
  const insChange = db.prepare(
    `INSERT INTO person_lookup_change(claim_id, log_id, kind, url, change_date, applied_at,
       evidence_kind, contradicts_anchor, contradicts_anchor_unknown)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  );
  // The alreadyProposed analogue -- see this function's header. Keyed on
  // (person, url, quote) -- which is what a receipt IS here -- plus the
  // claim's own TEXT.
  //
  // ~~"and, since review finding 5, on the ANCHOR FLAG as well ... so a
  // re-lookup can supersede a stale or unknown verdict exactly once"~~
  // REVERTED 2026-09 (review G finding 4). Requiring
  // `contradicts_anchor_unknown = 0` meant an unknown row could never match
  // the dedupe at all -- and healLookupColumns' back-fill marks EVERY row
  // with no evidence_kind unknown, so every pre-columns row was permanently
  // undedupable: each monthly re-lookup returning the same page inserted
  // another pending claim beside it, forever. Nothing clears the column
  // (no UPDATE anywhere touched it), so the honest-unknown row stayed
  // withheld and dead while its duplicates accumulated. Matching on
  // `contradicts_anchor = ?` had the milder version of the same defect: a
  // stale 0 and a fresh 1 for one receipt could coexist as two claims.
  //
  // Supersession is done by HEALING the matched row's flags in place instead
  // (see the dedupe branch below), which is what "a re-lookup can supersede
  // a stale verdict" should have meant. The flag columns describe a verdict
  // about an assertion, not the assertion itself, so re-computing them is
  // not a rewrite of anything the owner may have judged -- and nothing
  // append-only is touched: no claim text, no claim_source, no
  // claim_decision.
  //
  // WHY THE TEXT IS IN THE KEY, which the finding did not ask for and
  // soundness does. Two different assertions can cite one (url, quote) --
  // "was listed as a Software Engineer" and "is now at Verily, not Klaviyo"
  // both quote the same title -- and healing flags computed for one onto the
  // other would label a claim with a verdict about a different sentence.
  // Differing text is therefore a different claim and still inserts. The
  // duplicate the finding is about is the same page saying the same thing
  // again, and that is what this now collapses.
  const selDup = db.prepare(
    `SELECT c.id AS id, plc.evidence_kind AS evidenceKind,
            COALESCE(plc.contradicts_anchor, 0) AS contradictsAnchor,
            COALESCE(plc.contradicts_anchor_unknown, 0) AS contradictsAnchorUnknown
       FROM claim c
       JOIN person_lookup_change plc ON plc.claim_id = c.id
       JOIN claim_source cs ON cs.claim_id = c.id AND cs.source = 'web'
     WHERE c.subject = 'person' AND c.subject_person_key = ? AND plc.url = ? AND cs.quote = ?
       AND c.text = ?
       AND COALESCE(
         (SELECT d.action FROM claim_decision d WHERE d.claim_id = c.id ORDER BY d.id DESC LIMIT 1),
         'pending'
       ) NOT IN ('reject', 'retract')
     LIMIT 1`
  );
  // The heal. Only the three verdict columns, and only when one of them
  // actually differs, so a re-lookup that agrees writes nothing at all.
  const healChange = db.prepare(
    `UPDATE person_lookup_change
        SET evidence_kind = ?, contradicts_anchor = ?, contradicts_anchor_unknown = ?
      WHERE claim_id = ?`
  );
  const maxChangedAt = db.prepare('SELECT MAX(store_changed_at) AS m FROM context').get();

  let stored = 0;
  let skipped = 0;
  let duplicates = 0;
  let nextChangedAt = Math.max(now, Number(maxChangedAt?.m ?? 0) + 1);

  // The corroboration set for the anchor rule, recomputed here from the same
  // stream groundLookup read (see contradictsAnchorFirm). Absent `observed`
  // this is empty, which leaves the departure rule in force and the
  // corroborated-other-company rule unable to fire -- the conservative
  // direction, and the reason the caller's own `contradictsAnchor` is
  // honoured below as a FLOOR.
  const titles = titleCompanies(observed);
  // THE ANCHOR CHECK COULD NOT BE RUN. `titles` is the corroboration set for
  // contradictsAnchorFirm's second rule, and it is empty precisely when
  // parseLookupStream could not read the `Links:` block -- at which point
  // that rule cannot fire and a `false` from the check means "not detected",
  // not "checked and clean". insChange used to write a literal 0 into
  // contradicts_anchor_unknown regardless, so a lookup that demonstrably
  // could not check the anchor recorded "checked, no contradiction" (review
  // G finding 5): linksParseFailed was persisted on lookup_evidence and
  // counted in lookupStatus while having no effect on the one flag it was
  // introduced to justify.
  //
  // A DETECTED contradiction is still KNOWN: rule 1 (departure from the
  // anchor named in the text itself) needs no titles, so a `true` here is a
  // verdict, not a guess. Only a negative is downgraded.
  //
  // `observed === null` is deliberately NOT unknown. That is the caller with
  // no stream in hand -- a test seam, and the path where the caller's own
  // contradictsAnchor is honoured as a floor -- rather than a lookup whose
  // evidence came back unreadable.
  const anchorCheckIncomplete = observed !== null && observed?.linksParseFailed === true;

  // ONE transaction for the whole batch -- unless the caller already opened
  // one, in which case this joins it rather than nesting (SQLite has no
  // nested BEGIN, and lookupPerson now needs the log row, the evidence row
  // and these claims to commit or roll back together: review finding 1's
  // three separate autocommits are what left a 'proposed' log row with zero
  // claims behind it).
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec('BEGIN');
  try {
    for (const item of kept) {
      if (
        item === null || typeof item !== 'object'
        || !LOOKUP_CHANGE_KINDS.includes(item.kind)
        || typeof item.text !== 'string' || item.text.trim().length === 0 || item.text.length > 200
        || typeof item.quote !== 'string' || item.quote.length === 0
        || typeof item.url !== 'string' || item.url.length === 0
      ) {
        skipped += 1;
        continue;
      }
      let parsedUrl;
      try {
        parsedUrl = new URL(item.url);
      } catch {
        skipped += 1;
        continue;
      }
      if (parsedUrl.protocol !== 'https:' || isLookupUrlDenied(parsedUrl)) {
        skipped += 1;
        continue;
      }
      // The two rules the header used to claim and not run.
      let evidenceKind = null;
      if (observed !== null) {
        const urlSet = observed.urls instanceof Set
          ? observed.urls
          : new Set(Array.isArray(observed.urls) ? observed.urls : []);
        if (!urlSet.has(item.url)) {
          skipped += 1;
          continue;
        }
        evidenceKind = evidenceKindFor(item.quote, observed);
        if (evidenceKind === null) {
          skipped += 1;
          continue;
        }
      }
      // Recomputed, never trusted from the caller: the flag decides whether
      // a card may consume this row, so a client cannot hand it in as false.
      // A caller's own `true` is honoured as a FLOOR, because recomputation
      // here can only be WEAKER than groundLookup's (which had the returned
      // titles in hand and this call may not) -- so the recomputation adds
      // the flag and can never clear one.
      const contradictsAnchor = contradictsAnchorFirm(
        { kind: item.kind, text: item.text.trim(), quote: item.quote }, firm, { titles }
      ) || item.contradictsAnchor === true;
      const kind = contradictsAnchor ? 'company' : item.kind;
      // The date requirement, re-checked against the row about to be written
      // (review finding 8). Judged on the kind the MODEL filed -- an anchor
      // contradiction is refiled 'company' by the line above and is exempt,
      // for the reason groundLookup's own note gives.
      const date = typeof item.date === 'string' && /^\d{4}-\d{2}$/u.test(item.date) ? item.date : null;
      if (!contradictsAnchor && DATED_LOOKUP_KINDS.has(item.kind) && date === null) {
        skipped += 1;
        continue;
      }
      const anchorUnknown = !contradictsAnchor && anchorCheckIncomplete;
      const dup = selDup.get(personKey, item.url, item.quote, item.text.trim());
      if (dup !== undefined) {
        // Same receipt, same assertion: no second claim. Heal the verdict
        // columns if this lookup knows better than the stored row did --
        // which is how a back-filled unknown gets cleared, since nothing
        // else in this file ever writes that column.
        if (
          (dup.evidenceKind ?? null) !== evidenceKind
          || Number(dup.contradictsAnchor) !== (contradictsAnchor ? 1 : 0)
          || Number(dup.contradictsAnchorUnknown) !== (anchorUnknown ? 1 : 0)
        ) {
          healChange.run(evidenceKind, contradictsAnchor ? 1 : 0, anchorUnknown ? 1 : 0, Number(dup.id));
        }
        duplicates += 1;
        continue;
      }

      const entityId = `web:${createHash('sha256').update(`${item.url}\0${item.quote}`, 'utf8').digest('hex').slice(0, 32)}`;
      const meta = { url: item.url, provider: 'claude-cli-lookup', query_hash: queryHash, fetched_at: now, person_key: personKey };
      const metaJson = JSON.stringify(meta);
      const contentHash = canonicalHash({ ts: now, speaker: null, text: item.quote, meta });

      let contextId;
      const existing = selCtx.get('web', entityId);
      if (existing !== undefined) {
        contextId = Number(existing.id);
      } else {
        contextId = Number(insCtx.run(now, item.quote, metaJson, entityId, contentHash, nextChangedAt).lastInsertRowid);
        nextChangedAt += 1;
      }

      const claimId = Number(insClaim.run(distillRunId, personKey, item.text, now, now).lastInsertRowid);
      insSource.run(claimId, contextId, entityId, contentHash, item.quote);
      insChange.run(claimId, logId, kind, item.url, date, evidenceKind,
        contradictsAnchor ? 1 : 0, anchorUnknown ? 1 : 0);
      stored += 1;
    }
    if (ownTransaction) db.exec('COMMIT');
  } catch (err) {
    // Only the transaction's OWNER rolls back: unwinding a caller's
    // transaction from inside would silently discard writes this function
    // never made. A joined transaction just rethrows and lets the owner
    // (lookupPerson) roll the whole unit back.
    if (ownTransaction) db.exec('ROLLBACK');
    throw err;
  }
  return { stored, skipped, duplicates };
}

// storeLookupEvidence(db, {logId, links, resultText, now}): the raw article
// this lookup actually saw, one row per lookup_log row, written once and
// never updated. This is what lookup_log 4520 could not be audited from --
// the counts were stored and the text was not, so "the quote was verbatim in
// the results" was unfalsifiable after the fact.
//
// Content: PUBLIC search-result text about a public person, kept on the box.
// Nothing private is in it by construction (a lookup's only tool is
// WebSearch, and buildLookupQuery's input gate decides what it may ask), and
// nothing here leaves the box -- it exists so the desk can show "what came
// back" beside "what was sent".
//
// TWO FLAGS travel with it, and both exist so a degraded lookup cannot look
// like a clean one: `truncated` when the article was longer than
// LOOKUP_RESULT_TEXT_CAP and was cut (see that constant -- "verbatim" means
// verbatim up to the cap), and `links_parse_failed` when a `Links:` block was
// present in the stream and could not be read (parseLookupStream's own
// linksParseFailed). The second is what makes review finding 3 loud rather
// than silent: with the links unreadable every change fails grounding, the
// lookup logs 'ungrounded', and this row says WHY.
export function storeLookupEvidence(db, {
  logId, links = [], resultText = '', linksParseFailed = false, now = Date.now(),
} = {}) {
  if (!Number.isInteger(Number(logId))) return { stored: 0 };
  const urls = canonicalize(
    (Array.isArray(links) ? links : [])
      .filter((l) => l !== null && typeof l === 'object' && typeof l.url === 'string')
      .map((l) => ({ title: typeof l.title === 'string' ? l.title : '', url: l.url }))
  );
  const full = String(resultText ?? '');
  const truncated = full.length > LOOKUP_RESULT_TEXT_CAP;
  const text = truncated ? full.slice(0, LOOKUP_RESULT_TEXT_CAP) : full;
  const n = db.prepare(
    `INSERT INTO lookup_evidence(log_id, urls, result_text, created_at, truncated, links_parse_failed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(log_id) DO NOTHING`
  ).run(
    Number(logId), JSON.stringify(urls), text, now,
    truncated ? 1 : 0, linksParseFailed === true ? 1 : 0
  ).changes;
  return { stored: Number(n), truncated, linksParseFailed: linksParseFailed === true };
}

// gather (anchorsFor+buildLookupQuery) -> prompt -> engine -> parse
// (parseLookupStream) -> ground (groundLookup) -> store (storeLookup), one
// person.
//
// THREE FIELDS carry the outcome, and after review findings 1, 6 and 7 they
// are deliberately not the same string:
//
//   status        what the RECEIPT says: one of lookup_log.status's seven
//                 literals (its CHECK cannot be ALTERed in SQLite, and two
//                 other tables reference lookup_log's ids -- see its schema
//                 comment in hermes.mjs). Written from what was actually
//                 STORED, never from what grounding merely kept.
//   stateStatus   what person_lookup_state.last_status records. That column
//                 is free text, so it is where an honest word lives for a
//                 case lookup_log has no literal for: 'over-budget' when the
//                 model outspent LOOKUP_MAX_SEARCHES and its answer was
//                 discarded, 'store-error' when the write failed.
//   hold          whether next_due_at may advance. Decided per case here
//                 rather than inferred from the log literal: 'ungrounded' is
//                 an ADVANCE for a lookup whose changes genuinely failed
//                 grounding, and a HOLD for one that was thrown away over
//                 budget or lost to a failed write. Reading it off the
//                 literal pushed a discarded lookup a full refresh tier into
//                 the future and re-spent the daily cap on nobody.
//
// AND IT DOES NOT THROW past the store boundary. Review finding 1: a throw
// from storeLookup or storeLookupEvidence used to escape into runLookupPass's
// unguarded `await`, which left distill_run and person_lookup_run 'running'
// forever, skipped bumpRunCalls (so the daily cap under-counted the call
// that had already been spent), never wrote person_lookup_state (so the same
// person was re-spent next pass), and -- because the log row, the evidence
// row and the claims were three separate autocommits -- left a committed
// 'proposed' log row with zero claims behind it. The log row, the evidence
// row and the claims now commit or roll back TOGETHER, and a failure is
// returned as a result (failed: true, hold: true) rather than thrown.
function lookupLogStatusFor({ stored, notStored, titleOnlyContradiction, claimedAmbiguous }) {
  // THE DOWNGRADE first: a change that disagrees with the firm we sent,
  // backed by nothing but a search-result title, is not a "match" -- a stale
  // index entry and a namesake are at least as likely as a real move, and
  // the model has just told us it is confident about a person whose one
  // confirming anchor it contradicted. That is true whether or not the row
  // deduped against one we already had.
  if (titleOnlyContradiction) return 'ambiguous';
  // 'proposed' means CLAIMS EXIST, which is why it reads `stored` and not
  // `kept.length` (review finding 6: an all-duplicate batch used to log
  // 'proposed' with N changes_proposed and zero claims to show for it).
  if (stored > 0) return 'proposed';
  // DISAMBIGUATION CHECKPOINT: an "ambiguous" verdict is its own visible
  // status regardless of whether the model correctly emptied `changes` --
  // never silently folded into "empty", because "we could not tell who this
  // was" and "we asked and found nothing new" are different facts an owner
  // reading /admin/relationship/lookups should be able to tell apart.
  if (claimedAmbiguous) return 'ambiguous';
  if (notStored > 0) return 'ungrounded';
  return 'empty';
}

export async function lookupPerson(db, engine, candidate, { runId, distillRunId, now = Date.now() } = {}) {
  const anchors = anchorsFor(db, candidate.personKey);
  const built = buildLookupQuery(anchors);
  const hash = anchorsHash(anchors);

  // No second anchor: logged WITHOUT a model call, same "ask nothing, spend
  // nothing" posture as sweepPerson's own zero-THEM-lines short circuit.
  if (built === null) {
    const logId = insertLookupLog(db, {
      personKey: candidate.personKey, runId, at: now, engine: engine?.name ?? 'none',
      query: '', queryHash: '', fieldsUsed: [], status: 'no-anchors',
    });
    return {
      personKey: candidate.personKey, calls: 0, searches: 0, proposed: 0, dropped: 0, costUsd: 0,
      status: 'no-anchors', stateStatus: 'no-anchors', hold: false, failed: false,
      anchorsHash: hash, logId,
    };
  }

  let raw;
  try {
    raw = await engine.complete({ system: readFileSync(LOOKUP_PROMPT_PATH, 'utf8'), user: built.query, maxTokens: 1024 });
  } catch {
    const logId = insertLookupLog(db, {
      personKey: candidate.personKey, runId, at: now, engine: engine?.name ?? 'unknown',
      query: built.query, queryHash: built.queryHash, fieldsUsed: built.fieldsUsed, status: 'engine-error',
    });
    return {
      personKey: candidate.personKey, calls: 1, searches: 0, proposed: 0, dropped: 0, costUsd: 0,
      status: 'engine-error', stateStatus: 'engine-error', hold: true, failed: false,
      anchorsHash: hash, logId,
    };
  }

  const observed = parseLookupStream(raw);
  let envelope = null;
  try {
    envelope = JSON.parse(extractJsonObject(observed.envelopeText));
  } catch {
    envelope = null;
  }

  // The log row and its evidence row, together. lookup_evidence.log_id
  // references lookup_log(id), so the log row is written first WITHIN the
  // transaction rather than in an autocommit ahead of it.
  const writeLogAndEvidence = (fields) => {
    db.exec('BEGIN');
    try {
      const logId = insertLookupLog(db, fields);
      storeLookupEvidence(db, {
        logId, links: observed.links, resultText: observed.resultText,
        linksParseFailed: observed.linksParseFailed, now,
      });
      db.exec('COMMIT');
      return logId;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  if (envelope === null || typeof envelope !== 'object') {
    // Evidence is stored on the UNUSABLE paths too, and especially there:
    // "the model said something we could not parse" is the case where seeing
    // what came back matters most.
    let logId = null;
    let failed = false;
    try {
      logId = writeLogAndEvidence({
        personKey: candidate.personKey, runId, at: now, engine: engine.name,
        query: built.query, queryHash: built.queryHash, fieldsUsed: built.fieldsUsed,
        searches: observed.searches, urlsSeen: observed.urls.size, costUsd: observed.costUsd,
        status: 'parse-error',
      });
    } catch {
      failed = true;
    }
    return {
      personKey: candidate.personKey, calls: 1, searches: observed.searches, proposed: 0, dropped: 0,
      costUsd: observed.costUsd ?? 0, status: 'parse-error',
      stateStatus: failed ? 'store-error' : 'parse-error', hold: true, failed,
      anchorsHash: hash, logId,
    };
  }

  // LOOKUP_MAX_SEARCHES used to be a constant whose own comment claimed code
  // enforcement it never had: nothing compared observed.searches to it, and
  // the installed CLI has no --max-turns flag to cap turns with (checked
  // 2026-09-08 against `claude --help`), so the only place the cap can live
  // is here, after the fact. A model that spent more searches than it was
  // budgeted has burned account-wide rate limit the owner shares; its
  // changes are dropped wholesale rather than stored as if the budget held.
  //
  // Logged as 'ungrounded' rather than a new 'over-budget' status literal --
  // see lookup_log's own CHECK comment in hermes.mjs for why a new literal
  // would break every deployed install. The fact is not lost: `searches`
  // carries the real count, so an over-budget lookup is exactly
  // `status='ungrounded' AND searches > LOOKUP_MAX_SEARCHES`.
  //
  // What DID change (review finding 7): this is a HOLD, not an advance. The
  // answer was discarded, so nothing was learned about this person, and
  // advancing next_due_at by a full refresh tier for a lookup we threw away
  // is not scheduling -- it is losing the person for a month. The honest
  // word goes in person_lookup_state.last_status, which has no CHECK to
  // fight, and lookupStatus reports the count.
  if (observed.searches > LOOKUP_MAX_SEARCHES) {
    const changesDropped = Array.isArray(envelope.changes) ? envelope.changes.length : 0;
    let logId = null;
    let failed = false;
    try {
      logId = writeLogAndEvidence({
        personKey: candidate.personKey, runId, at: now, engine: engine.name,
        query: built.query, queryHash: built.queryHash, fieldsUsed: built.fieldsUsed,
        searches: observed.searches, urlsSeen: observed.urls.size,
        identityConfidence: ['match', 'ambiguous', 'no_match'].includes(envelope.identity_confidence)
          ? envelope.identity_confidence : null,
        changesProposed: 0,
        changesDropped,
        costUsd: observed.costUsd, status: 'ungrounded',
      });
    } catch {
      failed = true;
    }
    return {
      personKey: candidate.personKey, calls: 1, searches: observed.searches, proposed: 0,
      dropped: changesDropped,
      costUsd: observed.costUsd ?? 0, status: 'ungrounded',
      stateStatus: failed ? 'store-error' : 'over-budget', hold: true, failed,
      anchorsHash: hash, logId,
    };
  }

  const { kept, dropped } = groundLookup(envelope, observed, { firm: anchors.firm });
  // A change that disagrees with the firm we sent, backed by nothing but a
  // search-result title. The change is still stored (flagged, and withheld
  // from the card by newestWebChange) -- downgrading the verdict is not the
  // same as hiding the disagreement.
  const titleOnlyContradiction = kept.some((k) => k.contradictsAnchor && k.evidenceKind === 'title');
  const claimed = ['match', 'ambiguous', 'no_match'].includes(envelope.identity_confidence)
    ? envelope.identity_confidence
    : null;
  const identityConfidence = titleOnlyContradiction ? 'ambiguous' : claimed;

  // ONE TRANSACTION for everything that has to agree: the log row (written
  // first, because the other two reference its id), the evidence row, the
  // claims, and finally the log row's own status and counts -- UPDATEd in
  // place once `stored` is known, so no reader ever sees the provisional
  // value and no committed log row can disagree with the claims under it.
  let logId = null;
  let store = { stored: 0, skipped: 0, duplicates: 0 };
  let status = null;
  try {
    db.exec('BEGIN');
    try {
      logId = insertLookupLog(db, {
        personKey: candidate.personKey, runId, at: now, engine: engine.name,
        query: built.query, queryHash: built.queryHash, fieldsUsed: built.fieldsUsed,
        searches: observed.searches, urlsSeen: observed.urls.size, identityConfidence,
        changesProposed: 0, changesDropped: dropped.length, costUsd: observed.costUsd,
        status: 'ungrounded',
      });
      storeLookupEvidence(db, {
        logId, links: observed.links, resultText: observed.resultText,
        linksParseFailed: observed.linksParseFailed, now,
      });
      if (kept.length > 0) {
        store = storeLookup(db, {
          personKey: candidate.personKey, kept, observed, firm: anchors.firm, logId, distillRunId, now,
        });
      }
      status = lookupLogStatusFor({
        stored: store.stored,
        notStored: dropped.length + store.skipped,
        titleOnlyContradiction,
        claimedAmbiguous: claimed === 'ambiguous',
      });
      // changes_dropped counts what was PROPOSED AND NOT STORED for a
      // reason: grounding drops plus store-time skips. A duplicate is in
      // neither column -- the change was real and is already on file, so
      // counting it as dropped would read as a grounding failure and
      // counting it as proposed is the bug finding 6 names.
      db.prepare(
        'UPDATE lookup_log SET status = ?, changes_proposed = ?, changes_dropped = ? WHERE id = ?'
      ).run(status, store.stored, dropped.length + store.skipped, logId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch {
    // The whole unit rolled back: there is no log row, no evidence row and
    // no claim. A receipt is still owed for a query that DID leave the box,
    // so one is written on its own -- and if even that fails (the disk is
    // full, a column is missing), the failure still travels back as a
    // result rather than as a throw, because the caller's job is to hold
    // this person, count the call and move on.
    let failLogId = null;
    try {
      failLogId = insertLookupLog(db, {
        personKey: candidate.personKey, runId, at: now, engine: engine.name,
        query: built.query, queryHash: built.queryHash, fieldsUsed: built.fieldsUsed,
        searches: observed.searches, urlsSeen: observed.urls.size, identityConfidence,
        changesProposed: 0, changesDropped: kept.length + dropped.length,
        costUsd: observed.costUsd, status: 'ungrounded',
      });
    } catch {
      failLogId = null;
    }
    return {
      personKey: candidate.personKey, calls: 1, searches: observed.searches, proposed: 0,
      dropped: kept.length + dropped.length, costUsd: observed.costUsd ?? 0,
      status: 'ungrounded', stateStatus: 'store-error', hold: true, failed: true,
      anchorsHash: hash, logId: failLogId,
    };
  }

  return {
    personKey: candidate.personKey, calls: 1, searches: observed.searches, proposed: store.stored,
    dropped: dropped.length + store.skipped, duplicates: store.duplicates,
    costUsd: observed.costUsd ?? 0, status, stateStatus: status, hold: false, failed: false,
    anchorsHash: hash, logId,
  };
}

function insertSkippedLookupRun(db, { now, powerMode, engineName, budget, scopeSize, reason }) {
  const id = Number(
    db.prepare(
      `INSERT INTO person_lookup_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
         candidates, looked_up, model_calls, searches, proposed, dropped, cost_usd, skip_reason, status)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, 'skipped')`
    ).run(now, now, powerMode, engineName, budget, scopeSize, reason).lastInsertRowid
  );
  return db.prepare('SELECT * FROM person_lookup_run WHERE id = ?').get(id);
}

// The lookup_log statuses that ADVANCE next_due_at: each one either produced
// a real answer or correctly asked-and-found-nothing / had-nothing-to-ask.
// engine-error and parse-error are absent (they asked and got nothing usable
// back) -- and membership here is necessary but no longer sufficient, because
// lookupPerson's own `hold` can veto an advance for a status that normally
// earns one: an over-budget or failed-store lookup logs 'ungrounded' and must
// still hold (review findings 1 and 7).
const ADVANCING_LOOKUP_STATUSES = new Set(['proposed', 'empty', 'ambiguous', 'ungrounded', 'no-anchors']);

// Matches SWEEP_PAUSE_MS's own reasoning (sweep.mjs): do not hammer the one
// model (or, here, the one installed client's own rate limit) between
// people. Not imported (sweep.mjs's is private); duplicated as a constant.
const LOOKUP_PAUSE_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
}

// One pass: gate -> scope -> (skip, or) one distill_run row for the WHOLE
// pass (same "one per pass, not per person" posture as sweep.mjs's
// runSweepPass) -> lookupPerson in sequence, one BEGIN..COMMIT
// person_lookup_state write per person (advance next_due_at on
// ADVANCING_LOOKUP_STATUSES unless lookupPerson vetoes it with `hold` --
// see that constant and lookupPerson's own header; hold on
// engine-error/parse-error, on an over-budget answer that was thrown away,
// and on a store failure, all of which asked and got nothing usable back),
// paused LOOKUP_PAUSE_MS between people. A person whose own work throws is
// counted, held and skipped rather than ending the pass.
// `onlyPersonKey`, when given, narrows lookupScope to that one person --
// the /admin/relationship/lookup/person route's "look this person up now"
// (jumps the ordinary tier/recency queue for exactly one already-known
// person, but is still gated and capped through the same lookupGate check
// and the same budget/due machinery as an ordinary pass).
export async function runLookupPass(db, engine, policy, {
  powerMode = 'trickle', battery = null, onAc = null, thermal = null, budget, now = Date.now(),
  onlyPersonKey = null,
} = {}) {
  const effectiveBudget = Number.isInteger(budget) ? budget : (LOOKUP_BUDGET[powerMode] ?? LOOKUP_BUDGET.trickle);
  const engineName = engine?.name ?? 'none';

  const gate = lookupGate(db, policy, { powerMode, battery, onAc, thermal, engine });
  const scope = lookupScope(db, { now, personKey: onlyPersonKey });
  if (!gate.ok) {
    return insertSkippedLookupRun(db, {
      now, powerMode, engineName, budget: effectiveBudget, scopeSize: scope.length, reason: gate.reason,
    });
  }

  // Due-filter applied HERE, not baked into lookupScope -- see lookupScope's
  // own comment. An empty scope (nobody addressable) already failed the
  // gate above as 'no-scope'; a non-empty scope with nobody DUE right now is
  // this file's analogue of sweep's 'no-new-rows'.
  //
  // Unanchored due people (buildLookupQuery can't build a query for them --
  // no second anchor) must never consume the model budget: with thousands of
  // them ranked in the same tier order as the handful who ARE anchored, a
  // budget spent on one no-op unanchored person the same way it is spent on
  // a real lookup starves the pass for weeks. So the due set splits here --
  // `anchoredDue` is budgeted exactly as before; `unanchoredDue` is bulk-
  // logged and advanced below with NO budget accounting at all, however many
  // thousand there are.
  const dueCandidates = scope.filter((c) => isLookupDue(c, now));
  const anchoredDue = dueCandidates.filter((c) => c.anchored);
  const unanchoredDue = dueCandidates.filter((c) => !c.anchored);
  const candidates = anchoredDue.slice(0, effectiveBudget);
  if (candidates.length === 0 && unanchoredDue.length === 0) {
    return insertSkippedLookupRun(db, {
      now, powerMode, engineName, budget: effectiveBudget, scopeSize: scope.length, reason: 'no-due',
    });
  }

  // rel.lookupActive is owned by THIS pass, set only now that lookupGate's
  // own busy-model read of the same flag has already passed -- see
  // sweep.mjs's identical reasoning for rel.sweepActive. Cleared in the
  // finally below no matter how the pass ends.
  const rel = relFlags(policy);
  rel.lookupActive = true;
  // Declared OUT here, not inside the try: the catch below stamps both rows
  // 'failed' so neither can be left 'running', and a const scoped to the try
  // block would be unreachable from exactly the handler that needs it.
  let distillRunId = null;
  let runId = null;
  try {
    const promptText = readFileSync(LOOKUP_PROMPT_PATH, 'utf8');
    const sha = createHash('sha256').update(promptText, 'utf8').digest('hex');
    distillRunId = Number(
      db.prepare(
        `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at)
         VALUES (?, ?, ?, '{}', 'off', ?, 0, 'running', ?, NULL)`
      ).run(`${engineName}:${engine?.model ?? 'unknown'}`, LOOKUP_PROMPT_PATH, sha, candidates.length, now).lastInsertRowid
    );
    runId = Number(
      db.prepare(
        `INSERT INTO person_lookup_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
           candidates, looked_up, model_calls, searches, proposed, dropped, cost_usd, skip_reason, status)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, 'running')`
      ).run(distillRunId, now, powerMode, engineName, effectiveBudget, scope.length, candidates.length).lastInsertRowid
    );

    const upsertState = db.prepare(
      `INSERT INTO person_lookup_state(person_key, tier, anchors_hash, last_looked_at, next_due_at, last_status, lookups, proposals)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(person_key) DO UPDATE SET tier = excluded.tier, anchors_hash = excluded.anchors_hash,
         last_looked_at = excluded.last_looked_at, next_due_at = excluded.next_due_at, last_status = excluded.last_status,
         lookups = person_lookup_state.lookups + 1, proposals = person_lookup_state.proposals + excluded.proposals`
    );
    const holdState = db.prepare(
      `INSERT INTO person_lookup_state(person_key, tier, anchors_hash, last_looked_at, next_due_at, last_status, lookups, proposals)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(person_key) DO UPDATE SET last_looked_at = excluded.last_looked_at, last_status = excluded.last_status,
         lookups = person_lookup_state.lookups + 1`
    );

    // Bulk no-anchors stamping for every unanchored DUE person, ahead of the
    // budgeted anchored loop below: one prepared log-row statement, reusing
    // the SAME upsertState statement the anchored 'advance' path uses below
    // (candidate.anchorsHash is already known from lookupScope's scan, so no
    // per-person anchorsFor() re-read is needed), one BEGIN/COMMIT for the
    // whole batch, no sleep between rows and no budget accounting -- this
    // runs over potentially thousands of rows, so it must stay cheap. Each
    // row's next_due_at advances by its tier's own refresh interval, so a
    // no-anchors person is recorded once per due cycle, not every pass (the
    // isLookupDue check on the NEXT pass then finds them not due yet).
    const insUnanchoredLog = db.prepare(
      `INSERT INTO lookup_log(person_key, run_id, at, engine, query, query_hash, fields_used, searches, urls_seen,
         identity_confidence, changes_proposed, changes_dropped, cost_usd, status)
       VALUES (?, ?, ?, ?, '', '', '[]', 0, 0, NULL, 0, 0, NULL, 'no-anchors')`
    );
    let unanchoredLogged = 0;
    if (unanchoredDue.length > 0) {
      db.exec('BEGIN');
      try {
        for (const candidate of unanchoredDue) {
          insUnanchoredLog.run(candidate.personKey, runId, now, engineName);
          const nextDueAt = now + (LOOKUP_REFRESH_DAYS[candidate.tier] ?? LOOKUP_REFRESH_DAYS.other) * DAY;
          upsertState.run(candidate.personKey, candidate.tier, candidate.anchorsHash, now, nextDueAt, 'no-anchors', 0);
          unanchoredLogged += 1;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }

    let lookedUp = 0;
    let modelCalls = 0;
    let searchesTotal = 0;
    let proposed = 0;
    let dropped = 0;
    let costUsdTotal = 0;

    // The cap's own accounting statement. person_lookup_run.model_calls used
    // to be written ONLY by the terminal UPDATE at the end of this function,
    // so a pass killed mid-loop (the machine sleeps, the daemon restarts,
    // the process is signalled) left model_calls = 0 -- and every call it
    // had actually spent was invisible to the next pass's lookupGate, which
    // sums exactly this column. Written after each person instead: the cap
    // can only under-count by the one call in flight.
    const bumpRunCalls = db.prepare(
      `UPDATE person_lookup_run SET looked_up = ?, model_calls = ?, searches = ?, proposed = ?,
         dropped = ?, cost_usd = ? WHERE id = ?`
    );

    // PER-PERSON FAILURE CONTAINMENT (review finding 1). lookupPerson no
    // longer throws past its own store boundary, but this loop must survive
    // a throw from anywhere else in one person's work too -- anchorsFor on a
    // row that breaks, a missing prompt file, the state write below hitting
    // a locked database. One person is not the pass: the failure is counted,
    // the call it may already have spent is charged to the cap, the person
    // is HELD (never advanced, so the next pass re-offers them), and the
    // loop moves on. A pass with any failure ends 'failed' rather than
    // 'complete', which is what makes it visible on /stats instead of
    // looking like a clean pass that found nothing.
    let failures = 0;
    const failedKeys = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      let result = null;
      try {
        result = await lookupPerson(db, engine, candidate, { runId, distillRunId, now });
      } catch {
        result = null;
      }
      if (result === null) {
        // The call is charged even though we cannot prove it was spent: the
        // daily cap must fail CLOSED, and over-counting by one costs a
        // lookup while under-counting spends the owner's shared rate limit
        // on nothing.
        result = {
          personKey: candidate.personKey, calls: 1, searches: 0, proposed: 0, dropped: 0, costUsd: 0,
          status: 'engine-error', stateStatus: 'lookup-error', hold: true, failed: true,
          anchorsHash: candidate.anchorsHash, logId: null,
        };
      }
      lookedUp += 1;
      modelCalls += result.calls;
      searchesTotal += result.searches;
      proposed += result.proposed;
      dropped += result.dropped;
      costUsdTotal += result.costUsd ?? 0;
      if (result.failed) {
        failures += 1;
        failedKeys.push(candidate.personKey);
      }
      // BEFORE the state write, and outside its transaction: a call already
      // spent has to reach person_lookup_run.model_calls even if everything
      // after it fails.
      try {
        bumpRunCalls.run(lookedUp, modelCalls, searchesTotal, proposed, dropped, costUsdTotal, runId);
      } catch {
        // The cap under-counts by this person's call rather than the pass
        // dying with a person_lookup_state row unwritten.
      }

      // `hold` is lookupPerson's own verdict on whether anything was learned
      // (see its header): an over-budget or failed-store lookup holds even
      // though its log row reads 'ungrounded'. The status whitelist stays as
      // a belt -- an unrecognised status holds rather than advancing.
      const advance = result.hold !== true && ADVANCING_LOOKUP_STATUSES.has(result.status);
      const stateStatus = result.stateStatus ?? result.status;

      try {
        db.exec('BEGIN');
        try {
          if (advance) {
            const nextDueAt = now + (LOOKUP_REFRESH_DAYS[candidate.tier] ?? LOOKUP_REFRESH_DAYS.other) * DAY;
            upsertState.run(candidate.personKey, candidate.tier, result.anchorsHash, now, nextDueAt, stateStatus, result.proposed);
          } else {
            // HOLD: next_due_at is whatever it already was (or `now`, for a
            // brand-new candidate with no prior state row) -- a failure to get
            // a usable answer must re-offer the same person next pass, same
            // reasoning as sweep.mjs's holdCursor.
            const heldNextDueAt = candidate.nextDueAt ?? now;
            holdState.run(candidate.personKey, candidate.tier, candidate.storedAnchorsHash ?? result.anchorsHash,
              now, heldNextDueAt, stateStatus);
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      } catch {
        // Even the watermark write failed. Counted, held by default (there
        // is no advanced next_due_at to undo, because nothing was written),
        // and the pass carries on to the next person.
        if (!result.failed) {
          failures += 1;
          failedKeys.push(candidate.personKey);
        }
      }
      if (i < candidates.length - 1) await sleep(LOOKUP_PAUSE_MS);
    }

    const passStatus = failures > 0 ? 'failed' : 'complete';
    db.prepare(
      `UPDATE person_lookup_run SET ended_at = ?, looked_up = ?, model_calls = ?, searches = ?, proposed = ?,
         dropped = ?, cost_usd = ?, status = ? WHERE id = ?`
    ).run(Date.now(), lookedUp, modelCalls, searchesTotal, proposed, dropped, costUsdTotal, passStatus, runId);
    db.prepare('UPDATE distill_run SET claims_out = ?, status = ?, ended_at = ? WHERE id = ?')
      .run(proposed, failures > 0 ? 'failed' : 'complete', Date.now(), distillRunId);

    // unanchored_logged is reported, not stored -- person_lookup_run's own
    // columns count only the budgeted anchored candidates (see `candidates`
    // above); this lets the CLI status line show the bulk no-anchors work
    // too without adding a schema column for it. `failures` rides along the
    // same way: the COUNT is on the run row's own status, the per-person
    // detail is in each person_lookup_state.last_status.
    const runRow = db.prepare('SELECT * FROM person_lookup_run WHERE id = ?').get(runId);
    return { ...runRow, unanchored_logged: unanchoredLogged, failures, failed_keys: failedKeys };
  } catch (err) {
    // NOTHING IS LEFT 'running'. Both rows are stamped 'failed' before the
    // throw travels on: a person_lookup_run stuck at 'running' reads as a
    // pass still in flight forever (and a distill_run stuck there is a
    // permanently open run in the distiller's own accounting), which is
    // review finding 1's most visible symptom.
    if (runId !== null) {
      try {
        db.prepare("UPDATE person_lookup_run SET ended_at = ?, status = 'failed' WHERE id = ? AND status = 'running'")
          .run(Date.now(), runId);
      } catch {}
    }
    if (distillRunId !== null) {
      try {
        db.prepare("UPDATE distill_run SET status = 'failed', ended_at = ? WHERE id = ? AND status = 'running'")
          .run(Date.now(), distillRunId);
      } catch {}
    }
    throw err;
  } finally {
    rel.lookupActive = false;
  }
}

// For /stats' `lookup` key (hermes.mjs, a later commit) and the desk's
// status line. Cost is the REAL total_cost_usd summed from lookup_log --
// never mixed with a token estimate, unlike sweep's tokensEst (a lookup's
// engine reports real dollar cost; there is no reason to estimate it).
export function lookupStatus(db, policy = null) {
  const now = Date.now();
  const scope = lookupScope(db, { now });
  const anchored = scope.filter((c) => c.anchored).length;
  const anchorErrors = scope.filter((c) => c.anchorError).length;
  const due = scope.filter((c) => isLookupDue(c, now)).length;
  const tier = { eligible: 0, tagged: 0, other: 0 };
  for (const c of scope) tier[c.tier] = (tier[c.tier] ?? 0) + 1;

  const pending = Number(
    db.prepare(
      `SELECT COUNT(*) AS n FROM person_lookup_change plc
       JOIN claim c ON c.id = plc.claim_id
       WHERE NOT EXISTS (SELECT 1 FROM claim_decision d WHERE d.claim_id = c.id)`
    ).get().n
  );

  const last = db.prepare('SELECT * FROM person_lookup_run ORDER BY id DESC LIMIT 1').get();
  const since24h = now - DAY;
  const since30d = now - 30 * DAY;
  const agg24h = db.prepare(
    'SELECT COALESCE(SUM(model_calls), 0) AS calls, COALESCE(SUM(searches), 0) AS searches ' +
      'FROM person_lookup_run WHERE started_at >= ?'
  ).get(since24h);
  const cost24h = Number(db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM lookup_log WHERE at >= ?').get(since24h).c);
  const cost30d = Number(db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM lookup_log WHERE at >= ?').get(since30d).c);

  // An over-budget lookup has no status literal of its own (see lookup_log's
  // CHECK comment in hermes.mjs); it is exactly this query, and it is
  // reported so a model that ignores its search budget is visible rather
  // than merely absorbed.
  const overBudget = Number(
    db.prepare("SELECT COUNT(*) AS n FROM lookup_log WHERE status = 'ungrounded' AND searches > ?")
      .get(LOOKUP_MAX_SEARCHES).n
  );
  // The two degraded outcomes that have no lookup_log literal of their own
  // either, reported for the same reason: absorbed silently, a store failure
  // looks exactly like a lookup that found nothing, and an unreadable
  // `Links:` block looks exactly like a search that returned no links.
  // person_lookup_state.last_status has no CHECK to fight, which is why the
  // honest word lives there (see lookupPerson's header).
  const storeErrors = Number(
    db.prepare("SELECT COUNT(*) AS n FROM person_lookup_state WHERE last_status IN ('store-error', 'lookup-error')").get().n
  );
  const linksParseFailures = Number(
    db.prepare('SELECT COUNT(*) AS n FROM lookup_evidence WHERE links_parse_failed = 1').get().n
  );
  const truncatedEvidence = Number(
    db.prepare('SELECT COUNT(*) AS n FROM lookup_evidence WHERE truncated = 1').get().n
  );
  const cap = lookupCallCap(policy);

  return {
    scope: scope.length,
    anchored,
    unanchored: scope.length - anchored,
    anchorErrors,
    due,
    tier,
    pending,
    overBudget,
    storeErrors,
    linksParseFailures,
    truncatedEvidence,
    lastPassAt: last?.started_at ?? null,
    lastPassStatus: last?.status ?? null,
    lastSkipReason: last?.skip_reason ?? null,
    budget: last?.budget ?? null,
    powerMode: last?.power_mode ?? null,
    engine: last?.engine ?? null,
    calls24h: Number(agg24h.calls),
    searches24h: Number(agg24h.searches),
    costUsd24h: cost24h,
    costUsd30d: cost30d,
    // The CONFIGURED cap and the number the gate actually compares against
    // -- reporting only the bare default while honouring an override, at 90%
    // of it, meant /stats disagreed with the gate in two directions at once.
    callCap: cap,
    callCeiling: lookupCallCeiling(cap),
  };
}

// The desk's "What was sent" list for one person -- every field a receipt
// needs (see lookup_log's own comment in hermes.mjs's SCHEMA), newest first.
// `evidence` is the other half of the receipt, and the half 4520 did not
// have: {urls, resultTextChars} per row, so the desk can show WHAT CAME BACK
// beside what was sent -- the titles and URLs inline (they are small and
// they are the thing a title-only quote came from), the article's size
// rather than the article, which lookupEvidenceFor serves on its own route.
// null for a log row written before this table existed, or one that never
// had a stream (no-anchors, engine-error).
export function lookupLogFor(db, personKey, { limit = 20 } = {}) {
  const rows = db.prepare(
    `SELECT ll.id AS id, ll.person_key AS personKey, ll.run_id AS runId, ll.at AS at, ll.engine AS engine,
            ll.query AS query, ll.query_hash AS queryHash,
            ll.fields_used AS fieldsUsedJson, ll.searches AS searches, ll.urls_seen AS urlsSeen,
            ll.identity_confidence AS identityConfidence, ll.changes_proposed AS changesProposed,
            ll.changes_dropped AS changesDropped, ll.cost_usd AS costUsd, ll.status AS status,
            le.urls AS evidenceUrlsJson, LENGTH(le.result_text) AS evidenceResultTextChars,
            le.truncated AS evidenceTruncated, le.links_parse_failed AS evidenceLinksParseFailed
     FROM lookup_log ll
     LEFT JOIN lookup_evidence le ON le.log_id = ll.id
     WHERE ll.person_key = ? ORDER BY ll.at DESC LIMIT ?`
  ).all(personKey, Number.isInteger(limit) && limit > 0 ? limit : 20);

  return rows.map((row) => {
    let fieldsUsed = [];
    try { fieldsUsed = JSON.parse(row.fieldsUsedJson); } catch { fieldsUsed = []; }
    let evidence = null;
    if (row.evidenceUrlsJson !== null && row.evidenceUrlsJson !== undefined) {
      let urls = [];
      try { urls = JSON.parse(row.evidenceUrlsJson); } catch { urls = []; }
      evidence = {
        urls: Array.isArray(urls) ? urls : [],
        resultTextChars: Number(row.evidenceResultTextChars ?? 0),
        // "verbatim up to the cap" -- see LOOKUP_RESULT_TEXT_CAP.
        truncated: Number(row.evidenceTruncated ?? 0) === 1,
        // A `Links:` block the reader could not parse. Loud on purpose: with
        // it set, every change failed grounding for a reason that has
        // nothing to do with the person (review finding 3).
        linksParseFailed: Number(row.evidenceLinksParseFailed ?? 0) === 1,
      };
    }
    const {
      fieldsUsedJson, evidenceUrlsJson, evidenceResultTextChars,
      evidenceTruncated, evidenceLinksParseFailed, ...rest
    } = row;
    return { ...rest, fieldsUsed, evidence };
  });
}

// The full observed article for ONE lookup -- its own read, because it is
// kilobytes of third-party page text and the list above is rendered on every
// desk person page. Read-only; nothing writes here but storeLookupEvidence.
//
// BOTH KEYS ARE REQUIRED, and both are matched (review finding 11). This
// used to take a bare logId and nothing else, so any integer returned any
// person's evidence: the route is admin-token gated, but "which person is
// this about" is the one question an evidence read has to answer, and a
// caller that passes the wrong person should get null rather than somebody
// else's search results. The join onto lookup_log is what makes the person
// authoritative -- lookup_evidence itself has no person_key.
//
// resultText is CAPPED at LOOKUP_RESULT_TEXT_CAP on the way out as well as
// on the way in (review finding 4): storeLookupEvidence has cut new rows
// since that cap existed, but a row written before it can still be
// megabytes, and this is the read that would put all of them in one HTTP
// response. `truncated` is true when either end cut it, and resultTextChars
// is the STORED length, so a reader can see that what they have is short.
export function lookupEvidenceFor(db, { logId, personKey } = {}) {
  const id = Number(logId);
  if (!Number.isInteger(id)) return null;
  if (typeof personKey !== 'string' || personKey.length === 0) return null;
  const row = db.prepare(
    `SELECT le.log_id AS logId, le.urls AS urlsJson, le.result_text AS resultText,
            le.created_at AS createdAt, le.truncated AS truncated,
            le.links_parse_failed AS linksParseFailed
     FROM lookup_evidence le
     JOIN lookup_log ll ON ll.id = le.log_id
     WHERE le.log_id = ? AND ll.person_key = ?`
  ).get(id, personKey);
  if (!row) return null;
  let urls = [];
  try { urls = JSON.parse(row.urlsJson); } catch { urls = []; }
  const stored = String(row.resultText ?? '');
  const clipped = stored.length > LOOKUP_RESULT_TEXT_CAP;
  return {
    logId: row.logId,
    personKey,
    urls: Array.isArray(urls) ? urls : [],
    resultText: clipped ? stored.slice(0, LOOKUP_RESULT_TEXT_CAP) : stored,
    resultTextChars: stored.length,
    truncated: clipped || Number(row.truncated ?? 0) === 1,
    linksParseFailed: Number(row.linksParseFailed ?? 0) === 1,
    createdAt: row.createdAt,
  };
}

// newestWebChange(db, personKey): the card's `changed` field (a later
// commit). The single newest person_lookup_change that is not rejected or
// retracted (pending or accepted both count -- an owner may not have judged
// it yet, and the card should still surface it), resolved through its LIVE
// context row: if that row is gone, this returns null rather than serving a
// quote nobody can verify any more -- the same deletion-cascade-honored-at-
// serve-time discipline the card route already applies to its own quote.
//
// THREE STATES, not two, since review finding 5: 0 (does not contradict the
// anchor), 1 (does), and contradicts_anchor_unknown = 1 -- a row stored
// BEFORE the anchor columns existed, which the v14 ALTER silently defaulted
// to 0 and which this query therefore kept serving on the card as though it
// had been checked. It had not been checked at all; it is from exactly the
// era of the 4520 false positive. An unknown row is treated like a
// contradiction -- withheld while pending, allowed once the owner accepts it
// -- and a NULL in either column (a hand-altered database) is refused too,
// which is what the COALESCE defaults to 1 are for.
//
// A contradicts_anchor change is EXCLUDED while it is pending, and this is
// the fix for what lookup_log 4520 actually did wrong to the owner: a claim
// that disagrees with his own LinkedIn export ("now at Verily, not Klaviyo")
// was rendered on the card as fact, with `decision: null`, before he had
// judged it. A disagreement with our own anchor is a REVIEW ITEM, not card
// content. Once he ACCEPTS one it is his word and the card may carry it; a
// pending one may not. (The card route -- hermes.mjs -- consumes this
// function and nothing else; draft.mjs reads no lookup state at all, so the
// gate lives here rather than in either caller.)
export function newestWebChange(db, personKey) {
  const row = db.prepare(
    `SELECT plc.claim_id AS claimId, plc.kind AS kind, plc.url AS url, plc.change_date AS date,
            plc.evidence_kind AS evidenceKind, plc.contradicts_anchor AS contradictsAnchor,
            plc.contradicts_anchor_unknown AS contradictsAnchorUnknown,
            ll.at AS at, c.text AS text,
            (SELECT d.action FROM claim_decision d WHERE d.claim_id = plc.claim_id ORDER BY d.id DESC LIMIT 1) AS decision
     FROM person_lookup_change plc
     JOIN claim c ON c.id = plc.claim_id
     JOIN lookup_log ll ON ll.id = plc.log_id
     WHERE c.subject = 'person' AND c.subject_person_key = ?
       AND COALESCE(
         (SELECT d.action FROM claim_decision d WHERE d.claim_id = plc.claim_id ORDER BY d.id DESC LIMIT 1),
         'pending'
       ) NOT IN ('reject', 'retract')
       AND (
         (COALESCE(plc.contradicts_anchor, 1) = 0 AND COALESCE(plc.contradicts_anchor_unknown, 1) = 0)
         OR (SELECT d.action FROM claim_decision d WHERE d.claim_id = plc.claim_id ORDER BY d.id DESC LIMIT 1) = 'accept'
       )
     ORDER BY plc.claim_id DESC LIMIT 1`
  ).get(personKey);
  if (!row) return null;

  const source = db.prepare(
    `SELECT context_id AS contextId, quote FROM claim_source WHERE claim_id = ? AND source = 'web' LIMIT 1`
  ).get(row.claimId);
  if (!source) return null;

  const ctx = db.prepare('SELECT id FROM context WHERE id = ?').get(source.contextId);
  if (!ctx) return null; // the receipt is gone, so the change is gone

  return {
    text: row.text, url: row.url, kind: row.kind, quote: source.quote,
    date: row.date ?? null, at: row.at, decision: row.decision ?? null,
    evidenceKind: row.evidenceKind ?? null,
    contradictsAnchor: Number(row.contradictsAnchor ?? 0) === 1,
    contradictsAnchorUnknown: Number(row.contradictsAnchorUnknown ?? 0) === 1,
  };
}
