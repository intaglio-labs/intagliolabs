import { approximateConversationKey } from '../memory/episodes.mjs';
import { threadKind, isRoom, counterpartyFromThread, GROUP } from '../memory/threadKind.mjs';

// WHO DID I TALK TO ABOUT THIS? — the corpus half of person search.
//
// WHY THIS EXISTS. Search used to match a person's name, their handle, and the
// topic chips on their row. A few chips are a very small window onto a mature
// corpus, and private testing showed common relationship topics returning
// nobody. A person you had several conversations about something with was invisible
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
// COUNTS, PLUS ONE LINE. This returns how many messages and how many
// conversations per person per year, and an excerpt of the single most recent
// message that matched.
//
// The excerpt is a WIDENING, made deliberately (owner, 2026-08-25) of the
// "labels and counts only" rule topics.mjs still keeps for chips. The reason to
// widen here and not there: a chip is a summary that stands on its own, while a
// search result naming somebody you would never have guessed is unreadable
// without the line that put them in the list. The reason it is safe to widen
// here is that it is bounded in every direction that matters, and those bounds
// are the contract:
//
//   * ONE excerpt per person per year, never a transcript;
//   * only from a row that MATCHED the query, never surrounding conversation;
//   * capped in tokens by FTS and again in characters here;
//   * whitespace collapsed, so a message cannot smuggle layout;
//   * it goes to the owner's own screen and nowhere else. It is never logged --
//     the log rule did not widen -- and it never reaches a model.
//
// Excerpts still do not belong in chips, in logs, or in anything committed.

// How much of a matching message may be shown. Tokens bound it inside FTS;
// characters bound it again here, because a token can be arbitrarily long and
// the first cap alone is not a promise about length.
const SNIPPET_TOKENS = 12;
const SNIPPET_CHARS = 140;

// One line of prose, and only one line.
//
// Newlines and runs of whitespace collapse to single spaces: a message is
// free-form text and without this it could carry its own layout into a row that
// is supposed to be one line.
//
// A URL is replaced by "(link)" rather than shown. An excerpt that is a bare
// link tells the reader nothing -- the first live run had a person's whole
// excerpt be a forty-character event URL -- and a link is not what anyone means
// by "what did we say about this". Email addresses come out entirely: they are
// somebody's contact details, never the sentence.
//
// Returning null for a line with nothing left to read is what makes the caller
// keep looking, so a person whose most recent match was a bare link still gets
// the most recent one that was actually a sentence.
export function trimExcerpt(raw) {
  const prose = String(raw ?? '')
    .replace(/https?:\/\/\S+|\bwww\.\S+/giu, '(link)')
    .replace(/\S+@\S+\.\S+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  // Two real words, or there is no sentence here to show.
  const words = prose.replace(/\(link\)/gu, ' ').match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  if (words.length < 2) return null;
  if (prose.length <= SNIPPET_CHARS) return prose;
  return `${prose.slice(0, SNIPPET_CHARS - 1).trimEnd()}…`;
}

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
  // Export-backed LinkedIn rows have their own schema. Matrix-backed LinkedIn
  // rows carry no kind and use the same chat_handle/is_group contract as every
  // other social bridge.
  if (row.source === 'linkedin' && typeof meta.kind === 'string') return null;
  const fromMe = meta.is_from_me === true || meta.is_from_me === 1;
  // ROOMS ARE KEPT HERE, and that is the opposite call from chips -- on purpose.
  //
  // Search is about FINDING somebody. "Who was in that pickleball thread" is a
  // real question, and answering it from a room is useful in a way that
  // CHARACTERISING a relationship from a room is not. So the row still credits
  // whoever spoke; what changes is that the excerpt stops implying the two of you
  // said it to each other (see the excerpt's `room` flag below).
  if (threadKind(row, meta) === GROUP) {
    return fromMe ? null : (meta.sender_handle ?? meta.handle ?? null);
  }
  // Same thread fallback as the graph: an outbound row Apple left unaddressed
  // is still a row in a conversation with somebody; private testing confirmed
  // this is common.
  return meta.chat_handle ?? meta.handle ?? counterpartyFromThread(row, meta);
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
        // No alias on context_fts: snippet() resolves the table by name and
        // fails on an alias. SNIPPET_TOKENS bounds it inside FTS, before any
        // text is materialised.
        'SELECT c.id, c.ts, c.source, c.meta, m.episode_id, ' +
          `snippet(context_fts, 0, '', '', '…', ${SNIPPET_TOKENS}) AS snip ` +
          'FROM context_fts ' +
          'JOIN context c ON c.id = context_fts.rowid ' +
          'LEFT JOIN episode_member m ON m.context_id = c.id ' +
          "WHERE context_fts MATCH ? AND c.source IN ('imessage','whatsapp','messenger'," +
          "'instagram','twitter','telegram','discord','slack','linkedin','mail') " +
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

    const stat = out.get(bucket) ?? { messages: 0, conversations: 0, excerpt: null };
    stat.messages += 1;
    // The FIRST row to reach a bucket wins the excerpt, and the query is
    // ordered newest-first, so it is the most recent thing said on the subject
    // -- which is what somebody searching for it is usually chasing. One per
    // bucket, so no amount of matching rows turns this into a transcript.
    if (stat.excerpt === null) {
      const text = trimExcerpt(row.snip);
      if (text) {
        stat.excerpt = {
          text,
          ts,
          fromMe: meta.is_from_me === true || meta.is_from_me === 1,
          // WHERE it was said. Without this the row reads "you and X talked about
          // weddings" over a line X said to a room of nine people -- true that
          // they said it, false about who they said it to.
          room: isRoom(row, meta),
        };
      }
    }
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
