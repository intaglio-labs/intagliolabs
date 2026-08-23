// The "ask, don't guess" layer over the people graph.
//
// graph.mjs resolves identities CONSERVATIVELY: two identifiers are the same
// person only on hard evidence (the contacts spine, an exact normalized-name
// match, or a literally identical string). When it is unsure it SPLITS —
// leaving what is really one person as two — because a wrong auto-merge invents
// a relationship that is not there, which is worse than a split the owner can
// see and fix.
//
// This module is where the owner fixes it. It does three things, all in CODE
// (no model decides who is whom — identity is too consequential, the same rule
// the graph and the episodic shelf hold):
//
//   1. CANDIDATES — find the pairs the graph left split but that are plausibly
//      one person (same surname in a nickname form like Mike/Michael, or the
//      same email name across two domains). This is the "not sure" pile.
//   2. DECISIONS — record the owner's yes(same)/no(different) call, durably, so
//      it is asked once and never again.
//   3. ALIASES — turn the "same" decisions into the alias map buildGraph folds
//      back in, so a confirmed merge actually collapses the two people.
//
// Deliberately NOT here: any automatic merge on a candidate. A candidate is a
// question, never an answer. Nothing in this file merges two people the owner
// has not explicitly said are the same.

// Same normalizer the graph uses, so keys line up across modules.
function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

// A pair is stored order-independent: the two keys sorted, joined by a NUL that
// cannot appear in a key. One decision covers (a,b) and (b,a).
export function pairId(a, b) {
  return [a, b].sort().join('\u0000');
}

// ---------------------------------------------------------------------------
// Decisions store. A tiny table the owner's calls live in — verified ground
// truth, so it persists (SQLite, 0600 like every other ~/.hazlie DB). The
// caller opens the DB (so tests pass :memory:); we only own the schema.
// ---------------------------------------------------------------------------

export function ensureResolutionsSchema(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS person_resolution (' +
      'pair_id TEXT PRIMARY KEY,' +
      'key_a TEXT NOT NULL,' +
      'key_b TEXT NOT NULL,' +
      "verdict TEXT NOT NULL CHECK (verdict IN ('same','different'))," +
      'decided_at INTEGER NOT NULL' +
      ')'
  );
}

// Record one decision. 'skip' writes nothing — a skipped pair is undecided and
// may resurface next time, which is the point of skip. 'same'/'different' upsert
// so a later correction (the owner changes their mind) overwrites the earlier.
export function recordDecision(db, a, b, verdict, now = Date.now()) {
  if (verdict === 'skip') return;
  if (verdict !== 'same' && verdict !== 'different') {
    throw new Error(`unknown verdict: ${verdict}`);
  }
  const [ka, kb] = [a, b].sort();
  db.prepare(
    'INSERT INTO person_resolution (pair_id, key_a, key_b, verdict, decided_at) ' +
      'VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(pair_id) DO UPDATE SET verdict = excluded.verdict, decided_at = excluded.decided_at'
  ).run(pairId(a, b), ka, kb, verdict, now);
}

// Load every decision. Returns { same: [[a,b],...], differentPairs: Set<pairId> }.
export function loadResolutions(db) {
  const same = [];
  const differentPairs = new Set();
  for (const r of db.prepare('SELECT key_a, key_b, verdict FROM person_resolution').all()) {
    if (r.verdict === 'same') same.push([r.key_a, r.key_b]);
    else differentPairs.add(pairId(r.key_a, r.key_b));
  }
  return { same, differentPairs };
}

// ---------------------------------------------------------------------------
// Aliases: fold "same" decisions into one canonical key per merged person, via
// union-find over the confirmed-same edges. buildGraph consults the result.
// ---------------------------------------------------------------------------

// Build the alias map buildGraph wants: every non-canonical key -> its canonical
// key. Canonical is the lexicographically smallest key in the merged set, so the
// choice is stable across runs (no dependence on insertion order or Date.now).
export function aliasMap(sameEdges) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const nxt = parent.get(x); parent.set(x, root); x = nxt; }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // Point the larger key at the smaller, so the smallest key in a component
    // becomes its root and the canonical name is deterministic.
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };
  for (const [a, b] of sameEdges) union(a, b);

  const aliases = new Map();
  for (const k of parent.keys()) {
    const root = find(k);
    if (k !== root) aliases.set(k, root);
  }
  return aliases;
}

// Convenience: read the store and hand back exactly what buildGraph needs plus
// the "already decided" set the candidate detector must exclude.
export function resolutionState(db) {
  const { same, differentPairs } = loadResolutions(db);
  const aliases = aliasMap(same);
  // A pair is "decided" if the owner ruled on it OR it is already merged (both
  // keys now share a canonical) — either way it must not be asked again.
  const decided = new Set(differentPairs);
  for (const [a, b] of same) decided.add(pairId(a, b));
  return { aliases, decided, differentPairs };
}

// ---------------------------------------------------------------------------
// Candidate detection — the "not sure" pile.
// ---------------------------------------------------------------------------

// First names that are the same person in a form no prefix rule catches. Small
// and one-directional pairs, expanded both ways at load. Curated, not learned:
// a wrong entry here only ever proposes a QUESTION, never a silent merge.
const NICKNAMES = [
  ['mike', 'michael'], ['chris', 'christopher'], ['chris', 'christina'], ['chris', 'christine'],
  ['dan', 'daniel'], ['danny', 'daniel'], ['dave', 'david'], ['jim', 'james'], ['jimmy', 'james'],
  ['bob', 'robert'], ['rob', 'robert'], ['bobby', 'robert'], ['bill', 'william'], ['will', 'william'],
  ['billy', 'william'], ['tom', 'thomas'], ['tommy', 'thomas'], ['tony', 'anthony'], ['nick', 'nicholas'],
  ['matt', 'matthew'], ['ben', 'benjamin'], ['sam', 'samuel'], ['sam', 'samantha'], ['alex', 'alexander'],
  ['alex', 'alexandra'], ['andy', 'andrew'], ['drew', 'andrew'], ['ed', 'edward'], ['eddie', 'edward'],
  ['joe', 'joseph'], ['joey', 'joseph'], ['jack', 'john'], ['johnny', 'john'], ['ken', 'kenneth'],
  ['steve', 'steven'], ['steve', 'stephen'], ['ted', 'edward'], ['ted', 'theodore'], ['dick', 'richard'],
  ['rich', 'richard'], ['rick', 'richard'], ['ricky', 'richard'], ['greg', 'gregory'], ['jeff', 'jeffrey'],
  ['pat', 'patrick'], ['patty', 'patricia'], ['peggy', 'margaret'], ['maggie', 'margaret'],
  ['meg', 'margaret'], ['liz', 'elizabeth'], ['beth', 'elizabeth'], ['betsy', 'elizabeth'],
  ['kate', 'katherine'], ['katie', 'katherine'], ['kathy', 'katherine'], ['cathy', 'catherine'],
  ['sue', 'susan'], ['suzy', 'susan'], ['deb', 'deborah'], ['debbie', 'deborah'], ['becky', 'rebecca'],
  ['jen', 'jennifer'], ['jenny', 'jennifer'], ['abby', 'abigail'], ['gabe', 'gabriel'],
  ['nate', 'nathaniel'], ['nate', 'nathan'], ['zack', 'zachary'], ['josh', 'joshua'], ['tim', 'timothy'],
  ['ron', 'ronald'], ['don', 'donald'], ['fred', 'frederick'], ['charlie', 'charles'], ['chuck', 'charles'],
];

const NICK_MAP = (() => {
  const m = new Map();
  const link = (a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [a, b] of NICKNAMES) { link(a, b); link(b, a); }
  return m;
})();

// Are two first-name tokens the same person in a different form? True when one
// is a known nickname of the other, or one is a prefix of the other of at least
// 3 letters (mike/michael, dan/daniel) — but NOT when they are identical (that
// is not a nickname difference; if the whole names were identical they would
// already have merged, so an identical first token means the surnames differ,
// handled by the caller as a weaker signal).
function firstNameCompatible(a, b) {
  if (!a || !b || a === b) return false;
  if (NICK_MAP.get(a)?.has(b)) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

// Role addresses that are never a person, so two domains sharing one is not a
// person match. Bare-name locals are handled by the shape rule below; this
// catches multi-part role handles a shape rule would otherwise pass.
// Compared against the local-part with its separators stripped, so "no_reply",
// "no-reply" and "noreply" all collapse to the same "noreply" entry.
const ROLE_LOCALPARTS = new Set([
  'info', 'hello', 'hi', 'hey', 'team', 'contact', 'support', 'help', 'sales',
  'admin', 'noreply', 'donotreply', 'donotreply', 'notifications', 'notification',
  'careers', 'jobs', 'press', 'billing', 'accounts', 'account', 'founders',
  'partners', 'invest', 'deals', 'apply', 'hellothere', 'newsletter', 'news',
  'mailer', 'mail', 'updates', 'update', 'reply', 'members', 'community', 'hello2',
]);

// The local-part of an email identifier IF it is distinctive enough to join two
// different domains on — else null. The live corpus proved a bare first name is
// NOT distinctive: dozens of unrelated people share "andy@" / "aaron@" across
// companies, and joining on that floods the review pile with strangers. Only a
// FULL-NAME shape (first.last, first_last, first.m.last) is worth a question —
// "mike.chen@gmail" and "mike.chen@acme" really are usually one person. Role
// handles (apply@, info@) are dropped outright. Graph identifiers for non-mail
// channels are phones/slugs and return null.
function emailLocalPart(id) {
  const s = String(id ?? '').toLowerCase();
  const at = s.indexOf('@');
  if (at <= 0 || s.indexOf('@', at + 1) !== -1) return null;
  const local = s.slice(0, at);
  // Role check with separators stripped, so no_reply / no-reply / noreply all
  // match the same "noreply" entry.
  if (ROLE_LOCALPARTS.has(local.replace(/[._-]/g, ''))) return null;
  // At least two alphabetic parts separated by . _ or - (no digits — "mike2"
  // is not a name signal). This is what makes "mike.chen" qualify and "andy",
  // "apply", "aaron" not.
  if (!/^[a-z]{2,}([._-][a-z]+)+$/.test(local)) return null;
  return local;
}

// The tokens of a person's best display name, and its surname (last token).
// Email-shaped names are ignored: when a person has no real name, the graph
// falls back to the email address as the display name, which would tokenize
// into a bogus surname ("com") and bucket every gmail user together. Those
// people join by email local-part instead (its own path, its own guard).
function nameParts(person) {
  // buildGraph exposes the chosen display name as `name`; the internal `names`
  // set is not on the returned object, so fall back to `name`. Either way, drop
  // email-shaped names so an address never tokenizes into a fake surname.
  const source = person.names ?? (person.name != null ? [person.name] : []);
  const names = [...source].filter((n) => n && !String(n).includes('@'));
  // Longest name is the most complete (same tie-break the graph uses for
  // display), so surname detection sees "Michael Chen" over "Mike".
  const best = names.sort((a, b) => normName(b).length - normName(a).length)[0];
  const toks = best ? normName(best).split(' ').filter(Boolean) : [];
  return { toks, first: toks[0] ?? null, last: toks.length > 1 ? toks[toks.length - 1] : null };
}

// Given the resolved people (buildGraph output, each carrying .key, .name,
// .identifiers, .channels) and the already-decided pair set, return the ranked
// "not sure" pile: pairs plausibly one person, strongest first, capped.
//
// `limit` keeps the pile reviewable — dozens, not thousands. If more pairs
// qualify than fit, the WEAKEST are dropped (they are the least likely to be
// real), and the caller is told how many were cut so a truncated queue never
// reads as "nothing left to review".
export function candidatePairs(people, { decided = new Set(), limit = 60 } = {}) {
  // Index by surname so we compare within a last-name bucket instead of all
  // pairs — O(sum of bucket^2) instead of O(n^2), and it targets exactly the
  // real ambiguity (same surname, different first-name form).
  const bySurname = new Map();
  const byLocalPart = new Map();
  const meta = new Map(); // key -> { parts, person }
  for (const p of people) {
    if (!p?.key) continue;
    const parts = nameParts(p);
    meta.set(p.key, { parts, person: p });
    if (parts.last) {
      if (!bySurname.has(parts.last)) bySurname.set(parts.last, []);
      bySurname.get(parts.last).push(p.key);
    }
    for (const id of p.identifiers ?? []) {
      const lp = emailLocalPart(id);
      if (!lp) continue;
      if (!byLocalPart.has(lp)) byLocalPart.set(lp, new Set());
      byLocalPart.get(lp).add(p.key);
    }
  }

  const found = new Map(); // pairId -> { a, b, score, reason }
  const consider = (ka, kb, score, reason) => {
    if (ka === kb) return;
    const pid = pairId(ka, kb);
    if (decided.has(pid)) return;
    const prev = found.get(pid);
    if (!prev || score > prev.score) found.set(pid, { a: ka, b: kb, score, reason });
  };

  // Signal 1: same surname + nickname-compatible first name.
  for (const keys of bySurname.values()) {
    if (keys.length < 2) continue;
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const A = meta.get(keys[i]).parts, B = meta.get(keys[j]).parts;
        if (firstNameCompatible(A.first, B.first)) {
          consider(keys[i], keys[j], 3, 'same last name, first name is a nickname form');
        } else if (A.first && A.first === B.first) {
          // Identical first + identical last but not already merged means the
          // display names differ elsewhere (a middle name, a suffix). Weaker,
          // but still worth one question.
          consider(keys[i], keys[j], 2, 'same first and last name');
        }
      }
    }
  }

  // Signal 2: same email local-part across different addresses (mike.chen on
  // two domains). Strong — a shared name-shaped handle is rarely a coincidence.
  for (const set of byLocalPart.values()) {
    const keys = [...set];
    if (keys.length < 2) continue;
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        consider(keys[i], keys[j], 3, 'same email name across different addresses');
      }
    }
  }

  const all = [...found.values()].sort(
    (x, y) => y.score - x.score || pairId(x.a, x.b).localeCompare(pairId(y.a, y.b))
  );
  const kept = all.slice(0, limit).map(({ a, b, score, reason }) => {
    const pa = meta.get(a).person, pb = meta.get(b).person;
    return {
      pairId: pairId(a, b),
      score,
      reason,
      a: { key: a, name: pa.name, channels: pa.channels ?? [], messages: pa.messages ?? 0 },
      b: { key: b, name: pb.name, channels: pb.channels ?? [], messages: pb.messages ?? 0 },
    };
  });
  return { pairs: kept, total: all.length, dropped: Math.max(0, all.length - kept.length) };
}
