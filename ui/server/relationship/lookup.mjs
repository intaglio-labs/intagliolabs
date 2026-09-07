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
// groundLookup, and the constants both halves share. Below is the DB half:
// anchorsFor, lookupTierFor, lookupScope, lookupGate, storeLookup,
// lookupPerson, runLookupPass, lookupStatus, lookupLogFor, newestWebChange --
// mirroring the gather/ground vs. store split sweep.mjs and pages.mjs already
// use: a client (groundLookup, the pure half above) is not a boundary, so
// storeLookup re-checks every rule again against what it actually writes.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalHash } from '../contentHash.mjs';
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
    identifiers: db.prepare('SELECT identifier FROM person_identifiers WHERE person_key = ?'),
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

  // handle: a person_identifiers entry that both (a) looks like a handle and
  // (b) belongs to a person who actually has a twitter channel -- person_channels
  // is the evidence that THIS identifier came through that channel rather
  // than merely happening to match the shape.
  let handle = null;
  const hasTwitterChannel = s.hasTwitterChannel.get(personKey, 'twitter');
  if (hasTwitterChannel) {
    const HANDLE_SHAPE = /^@?[A-Za-z0-9_]{2,15}$/u;
    const ids = s.identifiers.all(personKey);
    const match = ids.find((r) => HANDLE_SHAPE.test(r.identifier));
    if (match) handle = match.identifier;
  }

  const profileUrl = linkedin && typeof linkedin.url === 'string' && linkedin.url.trim().length > 0
    ? linkedin.url
    : null;

  return { name, firm, handle, profileUrl };
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
    const built = buildLookupQuery(anchors);
    const state = stateStmt.get(row.personKey);
    out.push({
      personKey: row.personKey,
      name: row.name,
      tier: lookupTierFor(db, row.personKey, { now, eligibleKeys, subRolesStmt }),
      anchored: built !== null,
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
  const cap = Number(policy?.relationshipMemory?.lookupDailyCallCap ?? LOOKUP_DAILY_CALL_CAP_DEFAULT);
  const since = Date.now() - DAY;
  const used = Number(
    db.prepare('SELECT COALESCE(SUM(model_calls), 0) AS n FROM person_lookup_run WHERE started_at >= ?')
      .get(since).n
  );
  if (used >= 0.9 * cap) return { ok: false, reason: 'quota' };
  const scope = lookupScope(db, { now: Date.now() });
  if (scope.length === 0) return { ok: false, reason: 'no-scope' };
  return { ok: true, reason: null };
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

// storeLookup(db, {personKey, kept, logId, distillRunId, now}): the trusted
// apply path, mirroring storeSweep/storePage. EVERY grounding rule
// groundLookup already checked is re-checked here against what is about to
// be written, because a client (groundLookup) is not a boundary. One
// BEGIN..COMMIT for the whole batch of kept changes.
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
export function storeLookup(db, { personKey, kept, logId, distillRunId, now = Date.now() } = {}) {
  if (!Array.isArray(kept) || kept.length === 0) return { stored: 0, skipped: 0 };

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
    `INSERT INTO person_lookup_change(claim_id, log_id, kind, url, change_date, applied_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  );
  const maxChangedAt = db.prepare('SELECT MAX(store_changed_at) AS m FROM context').get();

  let stored = 0;
  let skipped = 0;
  let nextChangedAt = Math.max(now, Number(maxChangedAt?.m ?? 0) + 1);

  db.exec('BEGIN');
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
      insChange.run(claimId, logId, item.kind, item.url, item.date ?? null);
      stored += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { stored, skipped };
}

// gather (anchorsFor+buildLookupQuery) -> prompt -> engine -> parse
// (parseLookupStream) -> ground (groundLookup) -> store (storeLookup), one
// person. Status is one of lookup_log.status's seven values -- see the
// CHECK constraint in hermes.mjs's SCHEMA, and the comment above each branch
// below for what distinguishes it.
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
      status: 'no-anchors', anchorsHash: hash, logId,
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
      status: 'engine-error', anchorsHash: hash, logId,
    };
  }

  const observed = parseLookupStream(raw);
  let envelope = null;
  try {
    envelope = JSON.parse(extractJsonObject(observed.envelopeText));
  } catch {
    envelope = null;
  }

  if (envelope === null || typeof envelope !== 'object') {
    const logId = insertLookupLog(db, {
      personKey: candidate.personKey, runId, at: now, engine: engine.name,
      query: built.query, queryHash: built.queryHash, fieldsUsed: built.fieldsUsed,
      searches: observed.searches, urlsSeen: observed.urls.size, costUsd: observed.costUsd, status: 'parse-error',
    });
    return {
      personKey: candidate.personKey, calls: 1, searches: observed.searches, proposed: 0, dropped: 0,
      costUsd: observed.costUsd ?? 0, status: 'parse-error', anchorsHash: hash, logId,
    };
  }

  const { kept, dropped } = groundLookup(envelope, observed);
  // DISAMBIGUATION CHECKPOINT: an "ambiguous" verdict is its own visible
  // status regardless of whether the model correctly emptied `changes` --
  // never silently folded into "empty", because "we could not tell who this
  // was" and "we asked and found nothing new" are different facts an owner
  // reading /admin/relationship/lookups should be able to tell apart.
  const status = kept.length > 0
    ? 'proposed'
    : envelope.identity_confidence === 'ambiguous'
      ? 'ambiguous'
      : dropped.length > 0
        ? 'ungrounded'
        : 'empty';

  const identityConfidence = ['match', 'ambiguous', 'no_match'].includes(envelope.identity_confidence)
    ? envelope.identity_confidence
    : null;

  const logId = insertLookupLog(db, {
    personKey: candidate.personKey, runId, at: now, engine: engine.name,
    query: built.query, queryHash: built.queryHash, fieldsUsed: built.fieldsUsed,
    searches: observed.searches, urlsSeen: observed.urls.size, identityConfidence,
    changesProposed: kept.length, changesDropped: dropped.length, costUsd: observed.costUsd, status,
  });

  let stored = 0;
  if (kept.length > 0) {
    stored = storeLookup(db, { personKey: candidate.personKey, kept, logId, distillRunId, now }).stored;
  }

  return {
    personKey: candidate.personKey, calls: 1, searches: observed.searches, proposed: stored, dropped: dropped.length,
    costUsd: observed.costUsd ?? 0, status, anchorsHash: hash, logId,
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
// proposed/empty/ambiguous/ungrounded/no-anchors -- every one of those
// either produced a real answer or correctly asked-and-found-nothing/had-
// nothing-to-ask; hold on engine-error/parse-error, which asked and got
// nothing usable back), paused LOOKUP_PAUSE_MS between people.
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
  try {
    const promptText = readFileSync(LOOKUP_PROMPT_PATH, 'utf8');
    const sha = createHash('sha256').update(promptText, 'utf8').digest('hex');
    const distillRunId = Number(
      db.prepare(
        `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at)
         VALUES (?, ?, ?, '{}', 'off', ?, 0, 'running', ?, NULL)`
      ).run(`${engineName}:${engine?.model ?? 'unknown'}`, LOOKUP_PROMPT_PATH, sha, candidates.length, now).lastInsertRowid
    );
    const runId = Number(
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

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const result = await lookupPerson(db, engine, candidate, { runId, distillRunId, now });
      lookedUp += 1;
      modelCalls += result.calls;
      searchesTotal += result.searches;
      proposed += result.proposed;
      dropped += result.dropped;
      costUsdTotal += result.costUsd ?? 0;

      const advance = result.status === 'proposed' || result.status === 'empty'
        || result.status === 'ambiguous' || result.status === 'ungrounded' || result.status === 'no-anchors';

      db.exec('BEGIN');
      try {
        if (advance) {
          const nextDueAt = now + (LOOKUP_REFRESH_DAYS[candidate.tier] ?? LOOKUP_REFRESH_DAYS.other) * DAY;
          upsertState.run(candidate.personKey, candidate.tier, result.anchorsHash, now, nextDueAt, result.status, result.proposed);
        } else {
          // HOLD: next_due_at is whatever it already was (or `now`, for a
          // brand-new candidate with no prior state row) -- a failure to get
          // a usable answer must re-offer the same person next pass, same
          // reasoning as sweep.mjs's holdCursor.
          const heldNextDueAt = candidate.nextDueAt ?? now;
          holdState.run(candidate.personKey, candidate.tier, candidate.storedAnchorsHash ?? result.anchorsHash,
            now, heldNextDueAt, result.status);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      if (i < candidates.length - 1) await sleep(LOOKUP_PAUSE_MS);
    }

    db.prepare(
      `UPDATE person_lookup_run SET ended_at = ?, looked_up = ?, model_calls = ?, searches = ?, proposed = ?,
         dropped = ?, cost_usd = ?, status = 'complete' WHERE id = ?`
    ).run(Date.now(), lookedUp, modelCalls, searchesTotal, proposed, dropped, costUsdTotal, runId);
    db.prepare("UPDATE distill_run SET claims_out = ?, status = 'complete', ended_at = ? WHERE id = ?")
      .run(proposed, Date.now(), distillRunId);

    // unanchored_logged is reported, not stored -- person_lookup_run's own
    // columns count only the budgeted anchored candidates (see `candidates`
    // above); this lets the CLI status line show the bulk no-anchors work
    // too without adding a schema column for it.
    const runRow = db.prepare('SELECT * FROM person_lookup_run WHERE id = ?').get(runId);
    return { ...runRow, unanchored_logged: unanchoredLogged };
  } finally {
    rel.lookupActive = false;
  }
}

// For /stats' `lookup` key (hermes.mjs, a later commit) and the desk's
// status line. Cost is the REAL total_cost_usd summed from lookup_log --
// never mixed with a token estimate, unlike sweep's tokensEst (a lookup's
// engine reports real dollar cost; there is no reason to estimate it).
export function lookupStatus(db) {
  const now = Date.now();
  const scope = lookupScope(db, { now });
  const anchored = scope.filter((c) => c.anchored).length;
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

  return {
    scope: scope.length,
    anchored,
    unanchored: scope.length - anchored,
    due,
    tier,
    pending,
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
    callCap: LOOKUP_DAILY_CALL_CAP_DEFAULT,
  };
}

// The desk's "What was sent" list for one person -- every field a receipt
// needs (see lookup_log's own comment in hermes.mjs's SCHEMA), newest first.
export function lookupLogFor(db, personKey, { limit = 20 } = {}) {
  const rows = db.prepare(
    `SELECT id, person_key AS personKey, run_id AS runId, at, engine, query, query_hash AS queryHash,
            fields_used AS fieldsUsedJson, searches, urls_seen AS urlsSeen,
            identity_confidence AS identityConfidence, changes_proposed AS changesProposed,
            changes_dropped AS changesDropped, cost_usd AS costUsd, status
     FROM lookup_log WHERE person_key = ? ORDER BY at DESC LIMIT ?`
  ).all(personKey, Number.isInteger(limit) && limit > 0 ? limit : 20);

  return rows.map((row) => {
    let fieldsUsed = [];
    try { fieldsUsed = JSON.parse(row.fieldsUsedJson); } catch { fieldsUsed = []; }
    const { fieldsUsedJson, ...rest } = row;
    return { ...rest, fieldsUsed };
  });
}

// newestWebChange(db, personKey): the card's `changed` field (a later
// commit). The single newest person_lookup_change that is not rejected or
// retracted (pending or accepted both count -- an owner may not have judged
// it yet, and the card should still surface it), resolved through its LIVE
// context row: if that row is gone, this returns null rather than serving a
// quote nobody can verify any more -- the same deletion-cascade-honored-at-
// serve-time discipline the card route already applies to its own quote.
export function newestWebChange(db, personKey) {
  const row = db.prepare(
    `SELECT plc.claim_id AS claimId, plc.kind AS kind, plc.url AS url, plc.change_date AS date,
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
  };
}
