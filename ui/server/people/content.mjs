import { approximateConversationKey } from '../memory/episodes.mjs';

// WHO DID I TALK TO ABOUT THIS? — the corpus half of person search.
//
// WHY THIS EXISTS. Search used to match a person's name, their handle, and the
// five topic chips on their row. Five chips is a very small window onto 119,376
// messages, and measured against the live corpus the window was the whole
// problem: "pickleball" appears in 165 messages and returned NOBODY, "flight" in
// 347 and returned nobody, "birthday" in 190, "interview" in 76, "wedding" in
// 35. A person you had four conversations about something with was invisible
// unless that something also happened to win a chip slot.
//
// WHAT CHANGED SINCE find.mjs SAID NOT TO DO THIS. Its header argued against
// bm25 over message bodies, and that argument still holds: ranking people by a
// relevance score over one message surfaces whoever said the word once, which is
// not what a name box is answering. This does not do that. It counts, and it
// ranks by CONVERSATIONS rather than by messages or by bm25 — the same reasoning
// topics.mjs already settled for chips, where a 243-message thread counted 243
// times drowned out a whole year of everything else. Spread is the signal.
//
// COUNTS ONLY. This returns how many messages and how many conversations, per
// person, per year. It never returns text, and no row or snippet leaves here.

// Turn what somebody typed into an FTS5 query, safely.
//
// Every term is quoted, so a query containing FTS operators (AND, OR, NEAR, *,
// ^, parentheses, a stray quote) is data rather than syntax -- an unquoted
// user string is a query-injection and a crash waiting to happen. A single term
// also gets a prefix wildcard so "pickle" finds "pickleball"; multiple terms are
// required together, which is what a person means by typing two words.
export function ftsQuery(raw) {
  const terms = String(raw ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && t.length <= 32);
  if (terms.length === 0) return null;
  const quoted = terms.map((t) => `"${t.replace(/"/gu, '')}"`);
  // The prefix wildcard goes OUTSIDE the quotes, which is where FTS5 wants it.
  if (quoted.length === 1) return `${quoted[0]} OR ${quoted[0]}*`;
  return quoted.join(' AND ');
}

// Which person a prose row is a conversation WITH.
//
// Mirrors the attribution the graph and the chips already use, so a content hit
// credits the same person their message count does. A one-to-one thread
// attributes BOTH directions to the counterparty -- "what we talked about"
// includes what the owner said. A group message credits whoever sent it; the
// owner's own group message has no single counterparty and is skipped.
export function rowPersonId(row, meta) {
  if (row.source === 'mail') {
    return Array.isArray(meta.from) ? (meta.from[0]?.toLowerCase() ?? null) : null;
  }
  if (row.source === 'linkedin') return null;
  const fromMe = meta.is_from_me === true || meta.is_from_me === 1;
  if (meta.is_group) return fromMe ? null : (meta.sender_handle ?? meta.handle ?? null);
  return meta.chat_handle ?? meta.handle ?? null;
}

// Per (person, year), how much of this subject is theirs.
//
// `idToKey` is the graph's own identifier -> person resolution, so a merged
// person tallies once. Returns Map<'key|year', {messages, conversations}>.
//
// The row cap is a ceiling on work, not on truth, and it is reported: a query
// like "the" would otherwise walk the whole corpus on a keystroke. Ordering by
// recency means the cap keeps the most recent evidence rather than an arbitrary
// slice, and `capped` tells the caller the count is a floor.
export function contentMatches(db, idToKey, query, { maxRows = 6000 } = {}) {
  const match = ftsQuery(query);
  const out = new Map();
  if (match === null) return { stats: out, rows: 0, capped: false };

  let rows;
  try {
    rows = db
      .prepare(
        'SELECT c.id, c.ts, c.source, c.meta, m.episode_id ' +
          'FROM context_fts f ' +
          'JOIN context c ON c.id = f.rowid ' +
          'LEFT JOIN episode_member m ON m.context_id = c.id ' +
          "WHERE f.context_fts MATCH ? AND c.source IN ('imessage','whatsapp','mail') " +
          'ORDER BY c.ts DESC LIMIT ?'
      )
      .all(match, maxRows);
  } catch {
    // A corpus with no FTS index, or a term FTS still refuses after quoting.
    // Content is one tier of a search that has three others; it degrades to
    // contributing nothing rather than taking the whole query down.
    return { stats: out, rows: 0, capped: false };
  }

  const convos = new Map(); // 'key|year' -> Set of conversation ids
  for (const row of rows) {
    let meta = {};
    try {
      meta = JSON.parse(row.meta ?? '{}') ?? {};
    } catch {
      meta = {};
    }
    const id = rowPersonId(row, meta);
    if (!id) continue;
    const key = idToKey.get(id);
    if (key === undefined) continue;
    const ts = Number(row.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const bucket = `${key}|${new Date(ts).getFullYear()}`;

    const stat = out.get(bucket) ?? { messages: 0, conversations: 0 };
    stat.messages += 1;
    out.set(bucket, stat);
    // A row the episode index has not reached yet still needs a conversation.
    let set = convos.get(bucket);
    if (set === undefined) {
      set = new Set();
      convos.set(bucket, set);
    }
    set.add(row.episode_id ?? approximateConversationKey(row, meta, ts));
  }
  for (const [bucket, set] of convos) out.get(bucket).conversations = set.size;
  return { stats: out, rows: rows.length, capped: rows.length >= maxRows };
}
