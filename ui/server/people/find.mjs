// Finding a person on the timeline. PURE ranking over data the caller supplies,
// so it can be tested on fixtures and reasoned about without a corpus.
//
// WHAT IT REPLACES. The timeline filtered client-side with
// `p.name.toLowerCase().includes(term)` over the 250 people already loaded for
// the open year. Three things that cannot do:
//
//   * find somebody outside the top 250 -- the list is capped and the rest are
//     summarised as "+N more", so a real person is simply unreachable;
//   * find somebody in a different YEAR than the tab you are looking at, which
//     is most of them once history lands;
//   * match anything but a display name. Not the handle you know them by, not
//     the address, not what you talked about.
//
// WHY NOT FTS5 OVER MESSAGES, at least not here. The corpus index is the right
// tool for "when did we talk about the lease", and a different surface should
// use it. This surface answers "which PERSON", and a person is a small, already
// summarised object: 250 of them per year with names, handles and chips is a
// few thousand short strings. Ranking those in memory is instant and, more
// importantly, EXPLAINABLE -- a bm25 score over message bodies would surface
// people by a word they said once, which is not what a name box is asking.
//
// NO MODEL. A search that hallucinates a person is worse than one that finds
// nothing, and the ranking here is arithmetic anybody can read.

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '') // strip accents: "José" matches "jose"
    .trim();

// Match quality, highest first. The order is the point: an exact name beats a
// prefix, a prefix beats a word start, and matching a TOPIC is weaker than
// matching the person themselves -- you can be reminded of a chip, but you
// typed a name box.
export const MATCH = Object.freeze({
  exactName: 100,
  namePrefix: 80,
  nameWord: 60,
  nameAnywhere: 40,
  identifier: 30,
  topic: 15,
});

// Where in a person a query hit, and how well. Returns null for no match at all
// so the caller can drop them without a score of zero pretending to be a result.
export function scoreMatch(person, query) {
  const q = norm(query);
  if (q.length === 0) return null;
  const name = norm(person?.name);

  let best = 0;
  let field = null;

  if (name === q) {
    best = MATCH.exactName;
    field = 'name';
  } else if (name.startsWith(q)) {
    best = MATCH.namePrefix;
    field = 'name';
  } else if (name.split(/\s+/u).some((w) => w.startsWith(q))) {
    // A surname finds the person who has it, which is how people actually
    // search. A bare includes() would also match any name that merely contains
    // those letters mid-word -- word starts are the difference between a search
    // and a substring.
    best = MATCH.nameWord;
    field = 'name';
  } else if (name.includes(q)) {
    best = MATCH.nameAnywhere;
    field = 'name';
  }

  // The handle is often the only thing the owner remembers: a number they know
  // by sight, or the address a colleague mails from.
  if (best < MATCH.identifier) {
    for (const id of person?.identifiers ?? []) {
      if (norm(id).includes(q)) {
        best = MATCH.identifier;
        field = 'identifier';
        break;
      }
    }
  }

  // Topics last, and deliberately weak. "fundraising" should surface the people
  // it belongs to, but never above somebody whose actual name you typed.
  if (best < MATCH.topic) {
    for (const t of person?.topics ?? []) {
      const label = norm(typeof t === 'string' ? t : t?.label);
      if (label.includes(q)) {
        best = MATCH.topic;
        field = 'topic';
        break;
      }
    }
  }

  return best === 0 ? null : { score: best, field };
}

// Rank one year's people against a query.
//
// Relationship weight breaks ties, and only ties: two people whose names match
// equally well are ordered by how much you actually talk to them, which is the
// difference between finding a friend and finding somebody who texted once in
// 2019. It can never promote a weaker match above a stronger one -- the bonus
// is bounded below the gap between adjacent MATCH tiers.
export function rankPeople(people, query, { limit = 50 } = {}) {
  const out = [];
  for (const p of Array.isArray(people) ? people : []) {
    const hit = scoreMatch(p, query);
    if (hit === null) continue;
    const messages = Number(p?.messages) || 0;
    // log10 so a 10,000-message friendship outranks a 100-message one without
    // a 10,000-message stranger outranking a name that actually matched.
    const weight = Math.min(10, Math.log10(messages + 1) * 2.5);
    out.push({ ...p, matchField: hit.field, score: hit.score + weight });
  }
  out.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
  return out.slice(0, limit);
}

// The same query across every year, so the answer does not depend on which tab
// happens to be open.
//
// A person is returned ONCE, at their best year -- the year they matched
// strongest, which for a name match is the year you talked most. Returning them
// once per year would fill the list with the same face.
export function rankAcrossYears(byYear, query, { limit = 50 } = {}) {
  const best = new Map();
  for (const [year, people] of Object.entries(byYear ?? {})) {
    for (const hit of rankPeople(people, query, { limit: Infinity })) {
      const prior = best.get(hit.key);
      if (prior === undefined || hit.score > prior.score) {
        best.set(hit.key, { ...hit, year: Number(year) });
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit);
}
