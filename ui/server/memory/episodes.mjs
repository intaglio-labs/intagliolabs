// Grouping context rows into episodes. PURE: no database, no I/O, no model, so
// the rule can be tested on fixtures and argued about without a corpus.
//
// AN EPISODE IS A CONVERSATION, cut where conversations actually stop. The rule
// is one number -- a gap -- and it is arithmetic, not judgement:
//
//   adjacent messages in a thread, measured on the live store
//   p50 0.6 min · p75 12.4 min · p90 336 min · p95 1,543 min · p99 13,976 min
//
// The distribution is sharply bimodal. Half of all adjacent pairs are under 40
// seconds apart; by p90 the gap is over five hours. Anywhere between 30 and 120
// minutes cuts the same conversations, which is what makes this a boundary
// rather than a preference. 60 minutes is the middle of that plateau.
//
// WHY NOT A MODEL. A boundary decides what evidence exists, and decisions about
// evidence flow one way in this system: code decides, the model reads. A model
// choosing where a conversation ends would be choosing which of its own claims
// are supportable, which is the shape of using model output as ground truth.

import { createHash } from 'node:crypto';

export const DEFAULT_GAP_MS = 60 * 60 * 1000;

function parseMeta(meta) {
  if (meta === null || meta === undefined) return null;
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(meta);
  } catch {
    return null;
  }
}

// EACH SOURCE NAMES ITS THREAD DIFFERENTLY, and reading only one of those names
// silently turns a whole source into singletons.
//
// iMessage carries `chat_guid`; WhatsApp carries `chat_handle`
// (connectors/lib/whatsappRows.mjs writes it from the chat JID). This read
// chat_guid alone at first, and the result was measurable and quiet: 0 of 3,190
// WhatsApp rows carry chat_guid, so every one fell through to `solo:` -- 57
// single-message episodes, one per owner-sent row, with every received message
// discarded as an unquotable singleton. Episodes were doing nothing at all for
// that source while reporting a perfectly healthy 57.
//
// Listed per source rather than by trying every key, so a new connector that
// invents a third name shows up as singletons in the test that pins this rather
// than being half-handled by a fallback nobody chose.
const THREAD_FIELD = Object.freeze({
  imessage: 'chat_guid',
  whatsapp: 'chat_handle',
});

// A row with no thread of its own becomes its own episode rather than being
// dropped or piled in with unrelated singletons: 186 owner-sent iMessage rows
// on the live store carry no chat, and lumping them together by absence would
// invent a conversation that never happened.
export function threadKeyFor(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.source === 'notes') {
    return row.entity_id ? `note:${row.entity_id}` : `solo:${row.id}`;
  }
  const field = THREAD_FIELD[row.source];
  if (!field) return `solo:${row.id}`;
  const meta = parseMeta(row.meta);
  const key = typeof meta?.[field] === 'string' ? meta[field].trim() : '';
  // Namespaced by source: two connectors could mint the same opaque string and
  // a shared prefix would merge two unrelated conversations into one episode.
  return key ? `chat:${row.source}:${key}` : `solo:${row.id}`;
}

// A STAND-IN CONVERSATION KEY for a row that has no episode.
//
// Two reasons a row lacks one, and neither is rare. makeEpisode drops any run
// the owner never spoke in -- correct for distillation, where nothing quotable
// means nothing citable, and it is what bounds the context widening -- but that
// is 21,634 rows on the live store now that history has backfilled old threads
// and lurked-in group chats. Mail and LinkedIn have no thread to cut at all.
//
// Anything COUNTING conversations still has to place those rows, and the obvious
// key (the row itself) is the wrong one: it turns every unindexed message into
// its own conversation, which is precisely the message-counting the episode
// index exists to replace. This approximates with the thread plus the calendar
// day. The real rule is a 60-minute gap inside a thread and a day is coarser, so
// this UNDERCOUNTS, which is the safe direction -- the only thing lost is two
// separate chats with the same person on the same day.
//
// NOT a substitute for an episode: it never gates what a model may read, and
// nothing is distilled from it. It is for arithmetic only.
export function approximateConversationKey(row, meta, ts) {
  const m = meta ?? {};
  const thread =
    m.chat_guid ??
    m.chat_handle ??
    m.handle ??
    (Array.isArray(m.from) ? m.from[0] : null) ??
    row?.entity_id ??
    row?.source ??
    'unknown';
  const d = new Date(ts);
  return `t:${row?.source ?? '?'}:${thread}|${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// The owner wrote it, so it may be quoted. Everything else is context.
//
// Deliberately the same predicate select.mjs uses to decide what a model may
// read at all: an episode widens WHAT REACHES the model without widening WHAT
// MAY BE CITED, and the two boundaries have to agree about who the owner is or
// the widening is unbounded.
export function isQuotable(row) {
  if (!row) return false;
  const meta = parseMeta(row.meta);
  if (row.source === 'notes') return meta?.body_undecoded !== 1;
  return meta?.is_from_me === 1 || meta?.is_from_me === true;
}

// Identity of an episode's CONTENT, in line order. content_hash is the server's
// canonical hash of each row, so an edited row changes this and the episode is
// re-distilled, while a rebuild that changes nothing produces the same value.
export function memberHash(members) {
  const h = createHash('sha256');
  for (const m of members) {
    h.update(`${m.context_id}:${m.row?.content_hash ?? ''}:${m.quotable}|`);
  }
  return h.digest('hex');
}

function makeEpisode(thread_key, run, { gapMs, now }) {
  const members = run.map((row, i) => ({
    context_id: Number(row.id),
    line_no: i + 1,
    quotable: isQuotable(row) ? 1 : 0,
    row,
  }));
  const ownerCount = members.filter((m) => m.quotable === 1).length;
  // Nothing quotable means nothing citable means nothing to distil. This drop
  // is also what bounds the context widening: on the live store it withholds
  // 1,969 received rows in threads the owner never spoke in, which could not
  // have supported a claim under any prompt.
  if (ownerCount === 0) return null;

  const started_at = Number(run[0].ts);
  const ended_at = Number(run[run.length - 1].ts);
  return {
    source: run[0].source,
    thread_key,
    started_at,
    ended_at,
    row_count: members.length,
    owner_row_count: ownerCount,
    counterparty_key: null, // the builder fills this from the contacts spine
    built_by: 'gap-rule',
    gap_ms: gapMs,
    member_hash: memberHash(members),
    // Until this passes, a new message can still join and change member_hash.
    // claim is append-only, so distilling an unsettled episode would turn one
    // live conversation into a growing pile of near-duplicate claims.
    settled_at: ended_at + gapMs,
    settled: ended_at + gapMs <= now,
    built_at: now,
    members,
  };
}

// Rows -> episodes. Input may arrive in any order; output is sorted and stable.
export function buildEpisodes(rows, { gapMs = DEFAULT_GAP_MS, now = Date.now() } = {}) {
  const byThread = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const key = threadKeyFor(row);
    if (!key) continue;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(row);
  }

  const episodes = [];
  for (const [thread_key, group] of byThread) {
    group.sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.id) - Number(b.id));
    let run = [];
    const flush = () => {
      if (run.length === 0) return;
      const ep = makeEpisode(thread_key, run, { gapMs, now });
      if (ep) episodes.push(ep);
      run = [];
    };
    for (const row of group) {
      if (run.length > 0 && Number(row.ts) - Number(run[run.length - 1].ts) > gapMs) flush();
      run.push(row);
    }
    flush();
  }
  episodes.sort(
    (a, b) => a.started_at - b.started_at || (a.thread_key < b.thread_key ? -1 : 1)
  );
  return episodes;
}
