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
  // A NAME YOU NEARLY TYPED. Below every exact reading of the name and above
  // the handle, because "austn" is still someone reaching for a name.
  nameFuzzy: 35,
  identifier: 30,
  // WHO YOU ACTUALLY TALKED TO ABOUT THIS. Below every name tier on purpose:
  // typing a name must never be outranked by somebody who merely said that word.
  // Above `topic` because a chip is a summary of this same evidence, and the
  // evidence is the better answer when both exist.
  content: 20,
  topic: 15,
});

// Edit distance, capped, counting a TRANSPOSITION as one edit rather than two.
//
// That last part is the whole reason this is not plain Levenshtein: swapped
// adjacent letters are the most common typing mistake there is, and "rowna" for
// "rowan" scores 2 under Levenshtein (a delete plus an insert) which puts the
// commonest typo outside a one-edit budget. This is the optimal-string-alignment
// Damerau variant, which is enough for a name box.
//
// Capped so it stops as soon as no cell in a row can still come in under the
// budget. Bounding it is what keeps fuzzy matching from being a second, sloppier
// substring search, and what keeps it cheap enough to run per candidate.
export function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let twoBack = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (twoBack !== null && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, twoBack[j - 2] + 1); // the two letters are simply swapped
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1; // no cell in this row can still win
    twoBack = prev;
    prev = cur;
  }
  return prev[b.length];
}

// How wrong a query may be and still count as the name.
//
// Nothing under four characters is allowed to be fuzzy: at three characters a
// single edit reaches most short names, and "row" matching "rob", "ron" and
// "rod" is not a search, it is a shrug. One edit up to six characters, two
// beyond -- long names are where real typos accumulate.
function fuzzyBudget(q) {
  if (q.length < 4) return 0;
  return q.length <= 6 ? 1 : 2;
}

// Where in a person a query hit, and how well. Returns null for no match at all
// so the caller can drop them without a score of zero pretending to be a result.
export function scoreMatch(person, query, content = null) {
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

  // A NAME WITH A TYPO IN IT. Only consulted when no exact reading of the name
  // matched, and only word by word: measuring the whole display name against the
  // query would let "sam" fail on "Sam Lee" for being nine characters shorter.
  if (best === 0) {
    const budget = fuzzyBudget(q);
    if (budget > 0) {
      for (const word of name.split(/\s+/u)) {
        if (word.length < 3) continue;
        // Compare against the same length the query is, so a long surname is
        // not penalised for the letters the query never reached.
        const head = word.slice(0, Math.max(q.length, 3));
        if (editDistance(q, head, budget) <= budget) {
          best = MATCH.nameFuzzy;
          field = 'fuzzy';
          break;
        }
      }
    }
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

  // WHAT YOU ACTUALLY TALKED ABOUT, supplied by the caller from the corpus
  // (people/content.mjs). Counts, never text.
  if (best < MATCH.content && content && content.messages > 0) {
    best = MATCH.content;
    field = 'content';
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
export function rankPeople(people, query, { limit = 50, content = null, year = null } = {}) {
  const out = [];
  for (const p of Array.isArray(people) ? people : []) {
    const stat = content && year !== null ? content.get(`${p?.key}|${year}`) ?? null : null;
    const hit = scoreMatch(p, query, stat);
    if (hit === null) continue;
    const messages = Number(p?.messages) || 0;
    // log10 so a 10,000-message friendship outranks a 100-message one without
    // a 10,000-message stranger outranking a name that actually matched.
    const weight = Math.min(10, Math.log10(messages + 1) * 2.5);
    // A CONTENT MATCH IS RANKED BY CONVERSATIONS, not by messages and not by a
    // relevance score. One thread where the word appears forty times is one
    // conversation; four separate threads are four, and four is the one that
    // means you and this person have a subject. Same reasoning topics.mjs
    // settled for chips, where message-counting let a single 243-message thread
    // outweigh a whole year.
    // Conversations carry the weight; messages break ties inside an equal number
    // of them, so three mentions in one thread still beat one. The message term
    // is bounded well under a single conversation's worth so it can never
    // reorder the primary signal.
    const spread = stat
      ? Math.min(9, Math.log10(stat.conversations + 1) * 6) +
        Math.min(0.9, Math.log10(stat.messages + 1) * 0.4)
      : 0;
    out.push({
      ...p,
      matchField: hit.field,
      // Why this person is in the list, for the row to say out loud. Counts
      // only -- no text ever comes out of the content tier.
      evidence: stat ? { messages: stat.messages, conversations: stat.conversations } : null,
      score: hit.score + (hit.field === 'content' ? spread : weight),
    });
  }
  out.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
  return out.slice(0, limit);
}

// The same query across every year, so the answer does not depend on which tab
// happens to be open.
//
// A person is returned ONCE, at their best year -- the year they matched
// strongest. For a name that is the year you talked most; for a subject it is
// the year you actually discussed it, which is the more useful answer and falls
// out of the same comparison because the content score is per-year.
export function rankAcrossYears(byYear, query, { limit = 50, content = null } = {}) {
  const best = new Map();
  for (const [year, people] of Object.entries(byYear ?? {})) {
    const y = Number(year);
    for (const hit of rankPeople(people, query, { limit: Infinity, content, year: y })) {
      const prior = best.get(hit.key);
      if (prior === undefined || hit.score > prior.score) {
        best.set(hit.key, { ...hit, year: y });
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit);
}
