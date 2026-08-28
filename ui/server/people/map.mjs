// The people-map as a CONSTELLATION: every person as a star, grouped into
// named clusters (companies / investor firms), positioned by closeness, lit by
// recency. This module is the DATA layer — it returns each person with their
// cluster, a normalized strength, and a recency warmth; the widget does all the
// geometry (angles, radii, pan/zoom, search) client-side so the sky stays
// responsive without a round-trip per frame.
//
// Same rules as the rest of ui/server/people: CODE clusters and scores, no
// model. The owner can audit every grouping — a star's cluster is its work
// domain or LinkedIn company, nothing inferred.

import { buildGraph, namelike } from './graph.mjs';
import { depthScore, isNonPerson } from './rank.mjs';
import { topicTallies, topTopics, nameTokenSet } from './topics.mjs';
import { buildYearAwards } from './highlights.mjs';

const DAY = 86_400_000;

// The year view's engagement formula, declared once so tuning is a visible
// diff: a meeting is worth more than a message, and three felt right against
// the seed ("met monthly" should outrank "texted weekly, never met").
const MEETING_WEIGHT = 3;

// Collapse a person's month-bucketed timeline (graph.mjs) into year rows:
// [{ year, engagement, messages, met }], oldest first. The year view's raw
// material; topics are attached by buildMap, which owns the corpus scan.
export function yearRows(timeline) {
  const byYear = new Map();
  for (const b of timeline ?? []) {
    const year = Number(b.ym.slice(0, 4));
    let row = byYear.get(year);
    if (row === undefined) {
      row = { year, messages: 0, met: 0 };
      byYear.set(year, row);
    }
    row.messages += (b.sent ?? 0) + (b.received ?? 0);
    row.met += b.met ?? 0;
  }
  return [...byYear.values()]
    .map((r) => ({ ...r, engagement: r.messages + MEETING_WEIGHT * r.met }))
    .filter((r) => r.engagement > 0)
    .sort((a, b) => a.year - b.year);
}

// LinkedIn "company" values that name no real company — placeholders everyone
// between jobs uses. As a cluster label they'd fuse hundreds of unrelated
// people into a fake "Stealth Startup" constellation, so they fall through to
// the work-domain / personal grouping instead.
const JUNK_COMPANY = new Set([
  'stealth', 'stealth startup', 'stealth mode', 'self-employed', 'self employed',
  'freelance', 'freelancer', 'independent', 'unemployed', 'n/a', 'na', '-', '—',
  'various', 'private', 'confidential', 'none',
]);

// Personal-mail and phone providers carry NO group signal — everyone's gmail is
// their own, so these must not become a "gmail.com" mega-cluster. People here
// fall into the diffuse "personal" field near the owner instead.
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com',
  'mac.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'fastmail.com', 'hey.com',
]);

// Messaging identifiers wear an "@suffix" that is NOT an email domain:
// WhatsApp's privacy LID (12345@lid), group/contact ids (@g.us, @c.us) and
// the raw jid (@s.whatsapp.net). Treating these as work domains fused 241
// phone-hidden WhatsApp contacts into a fake "Lid" company — they are personal
// contacts, and belong in the personal field.
const NON_EMAIL_DOMAINS = new Set(['lid', 'g.us', 'c.us', 's.whatsapp.net', 'whatsapp.net', 'broadcast']);

// domain -> a human label. character.vc -> "Character", acme-labs.com -> "Acme Labs".
function prettyDomain(domain) {
  const label = domain.replace(/\.[a-z.]+$/u, '').replace(/[.-]/gu, ' ');
  return label.replace(/\b\w/gu, (c) => c.toUpperCase());
}

// The cluster a person belongs to: LinkedIn company first (nicest name), then
// any WORK email domain (not just investor firms — colleagues at one company
// should sit together), else the shared "personal" field. Returns
// { key, label, personal? }.
export function clusterOf(p) {
  const co = p.linkedin?.company;
  if (typeof co === 'string' && co.trim() && !JUNK_COMPANY.has(co.trim().toLowerCase())) {
    return { key: `co:${co.trim().toLowerCase()}`, label: co.trim() };
  }
  for (const id of p.identifiers ?? []) {
    const at = String(id).indexOf('@');
    if (at === -1) continue;
    const domain = String(id).slice(at + 1).toLowerCase();
    // A real work domain: has a dot (a TLD), isn't freemail, isn't a messaging
    // suffix. "12345@lid" and personal gmail fall through to the personal field.
    if (!domain || !domain.includes('.') || FREEMAIL.has(domain) || NON_EMAIL_DOMAINS.has(domain)) continue;
    return { key: `dom:${domain}`, label: prettyDomain(domain) };
  }
  return { key: 'personal', label: 'personal', personal: true };
}

// Recency as a 0..1 warmth: 1 = spoke this month (bright, warm), 0 = long gone
// (dim, cool). Driven by the dormancy clock (days since THEY last reached out),
// falling back to days since last seen at all when there is no inbound. A null
// clock (on record, no inbound) reads as neutral, not cold.
function warmthOf(recencyDays) {
  if (recencyDays == null) return 0.4;
  if (recencyDays < 30) return 1;
  if (recencyDays < 90) return 0.8;
  if (recencyDays < 365) return 0.55;
  if (recencyDays < 730) return 0.35;
  if (recencyDays < 1825) return 0.2;
  return 0.12;
}

// Build the constellation payload:
//   { counts:{people,active,dormant,clusters}, clusters:[{key,label,size,personal}],
//     people:[{ key,name,cluster,clusterLabel, strength(0..1),recencyDays,warm(0..1),
//               channels,messages,sent,received,reciprocity,metInPerson,
//               firstSeen,lastSeen,dormancyDays,company,title,identifiers }] }
//
// `aliases` (the owner's confirmed merges) fold in exactly as they do for the
// review queue, so a star the owner merged is one star here too.
// A star is someone the owner has a RELATIONSHIP with, not everyone who ever
// hit their inbox. Regex denylists can't keep up with real-world list noise
// ("Lid", "Unsubscribe", a thousand marketing domains), so the real filter is
// interaction: a person the owner MET, MESSAGED, had a TWO-WAY exchange with, or
// who reaches them on a personal channel (iMessage/WhatsApp rarely carry
// marketing). A mail-only, inbound-only, never-answered, never-met contact is a
// newsletter or a cold pitch — not a person on the map. This is a visual floor,
// not a claim they don't exist; the review/search paths still see everyone.
// A RELATIONSHIP NEEDS SOME SUBSTANCE, not just a channel.
//
// The old rule admitted anyone carrying an imessage or whatsapp channel, full
// stop — and on a private corpus dominated by iMessage, that clause passed
// everyone who survived isNonPerson. It removed nobody, and most displayed
// people had only a handful of direct messages. That produced the owner's
// "showing too many people im definitely not connected to this many".
//
// Each clause below is a different way of being real, and any one is enough:
//
//   named        the contacts app knows them. Whatever the volume, the owner
//                deliberately wrote them down. Never filtered.
//   met          you were in a room together. One meeting outweighs any number
//                of messages for saying you know somebody.
//   two-way      they wrote and you wrote back, or the reverse. A single
//                exchange is a conversation; a lone message is a notification.
//   volume       enough direct messages that it cannot be a one-off.
//   room regular not just present in a group chat but a repeated voice in one.
//
// What this removes is the long tail of one-message handles: delivery codes that
// isNonPerson's shape rules missed, a business that texted once, a wrong number.
// What it keeps is everyone the contacts app knows, everyone met in person, and
// every two-way thread — so the risk of dropping somebody real is bounded by the
// fact that being real leaves one of those marks.
const MIN_DIRECT_MESSAGES = 3;
const MIN_ROOM_MESSAGES = 5;

function hasRelationship(p) {
  if (namelike(p.name)) return true;                       // the contacts app knows them
  if ((p.metInPerson ?? 0) > 0) return true;               // in a room together
  if ((p.reciprocity ?? 0) > 0) return true;               // it went both ways
  if ((p.directMessages ?? 0) >= MIN_DIRECT_MESSAGES) return true;
  if ((p.roomMessages ?? 0) >= MIN_ROOM_MESSAGES) return true;
  return false;
}

// The TIMELINE view's payload: one YEAR of people, sorted by that year's
// engagement, each carrying the year's topics, taxonomy counts and
// specifics (people/topics.mjs, bucketBy year). Month grouping was yeeted
// (owner, 2026-08-25) — a year at a glance beat twelve section headers.
// Same person filter as the map (isNonPerson + hasRelationship), same alias
// folding. `years` lists every year the graph has activity in, so the
// client can page without guessing.
// The expensive core under the year view — the graph and the year-bucketed
// topic tallies — is IDENTICAL for every year (both scan the whole corpus),
// so it is memoized per database handle and reused until the corpus changes.
// Clicking through year tabs costs one rebuild, not ten.
//
// Keyed by the handle (WeakMap) so two different databases can never serve
// each other's people — a stamp alone would collide across handles with equal
// row counts (every test's fresh :memory: db, for one). The stamp (row count +
// max rowid + alias count) invalidates on ingest, deletion, and owner merge
// decisions. `now` is deliberately NOT in the stamp: it only gates
// future-dated rows out of the timeline, and a cache a few minutes stale on
// that axis changes nothing a month view can show.
const yearMemo = new WeakMap();

// Exported for people/summary.mjs, which needs the same graph and pays the
// same memo.
// THE STAMP, in one place, because it was wrong in three.
//
// It was (row count, max rowid, alias count) on `context` alone, and it missed
// two of its own inputs:
//
//   * THE CONTACTS SPINE. buildGraph resolves every identifier to a person key
//     through it, so a contacts sync changes who the graph's people ARE — and
//     a large private-store sync once landed without moving the stamp at all.
//   * episode_member. topicTallies LEFT JOINs it to count a topic once per
//     conversation, so rebuilding the episode index changes the chips.
//
// And COUNT(*) with MAX(rowid) cannot see an UPDATE at all: a history backfill
// can consist entirely of updates, which move neither. Adding the store's own
// change counter fixes that -- SQLite's data_version bumps on any committed
// write by another connection.
//
// This mattered little while the memos lived for seconds. It is the prerequisite
// for caching anything longer: a stale answer is a delay, a WRONG answer served
// from cache is a bug you cannot see.
export function corpusStamp(contextDb, stateDb, extra = '') {
  const c = contextDb
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM context')
    .get();
  const dv = contextDb.prepare('PRAGMA data_version').get();
  let eps = 0;
  try {
    eps = Number(contextDb.prepare('SELECT COUNT(*) AS n FROM episode_member').get().n) || 0;
  } catch {
    eps = 0; // a corpus with no episode index is a valid state
  }
  let spine = 0;
  try {
    if (stateDb) {
      spine = Number(stateDb.prepare('SELECT COUNT(*) AS n FROM contact_ids').get().n) || 0;
    }
  } catch {
    spine = 0;
  }
  const version = dv ? Object.values(dv)[0] : 0;
  return `${c.n}|${c.m}|${version}|${eps}|${spine}|${extra}`;
}

// SERVE THE LAST GOOD ANSWER, THEN CATCH UP.
//
// A cold core is ~7.6s of SYNCHRONOUS work, and node:sqlite is synchronous in a
// single-threaded process: measured, a 20ms interval timer got ZERO ticks during
// an 8-second build. So a rebuild does not merely make one request slow, it
// stops hermes answering anything at all -- every route and the connector ingest
// with it. That is the "it says loading on mostly every screen" the owner
// reported, and it is why staleness is worth having.
//
// So: a stamp mismatch no longer blocks. The previous core is returned
// immediately, marked stale, and the rebuild is scheduled to run after the
// response has gone out. The reader gets an answer in milliseconds that is at
// most one ingest behind, instead of waiting eight seconds for one that is
// current to the millisecond.
//
// The FIRST build still blocks, because there is nothing to serve instead. That
// is the one unavoidable wait and it is what warmPeopleCore() at boot exists to
// spend before anybody asks.
//
// `staleSince` is the timestamp of the data being served, so a caller can say
// how old it is rather than implying it is live.
let coreRebuildScheduled = false;

export function peopleCoreFreshness(contextDb, stateDb, aliases = null, owner = null) {
  const hit = yearMemo.get(contextDb);
  if (!hit) return { state: 'cold', builtAt: null, stale: true };
  // This must be byte-for-byte the same dependency stamp yearCore uses.
  // Omitting the role suffix made every core report stale forever (even when
  // no overrides existed, because yearCore's stamp still ended in `|`).
  const stamp = corpusStamp(
    contextDb,
    stateDb,
    `${aliases ? aliases.size : 0}|${ownerRoleStamp(owner)}`
  );
  return {
    state: hit.stamp === stamp ? 'fresh' : 'stale',
    builtAt: hit.builtAt ?? null,
    stale: hit.stamp !== stamp,
  };
}

// THE SAME QUESTION, ASKED OF THE CORPUS ALONE.
//
// corpusStamp above is what the PEOPLE core depends on, spine included. The
// topic scan depends on strictly less than that: it is a pure function of the
// rows and the episode index, now that both the person key and the name filter
// happen at the fold. Giving it its own stamp lets a large contacts sync reuse
// a scan it cannot possibly have changed.
export function corpusOnlyStamp(contextDb) {
  const c = contextDb
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM context')
    .get();
  const dv = contextDb.prepare('PRAGMA data_version').get();
  let eps = 0;
  try {
    eps = Number(contextDb.prepare('SELECT COUNT(*) AS n FROM episode_member').get().n) || 0;
  } catch {
    eps = 0;
  }
  return `${c.n}|${c.m}|${dv ? Object.values(dv)[0] : 0}|${eps}`;
}

// THE DISK CACHE, OPT-IN.
//
// Null unless the server hands one over, so importing this module never touches
// the filesystem: tests and scripts get the pure function and the owner's cache
// is never written by a test run. hermes calls this once at boot with a store
// beside its own context.db -- see people/tallyStore.mjs for what is kept and
// why it is all-or-nothing, and why a stamp that lives across restarts cannot
// be this one (data_version is a per-connection session counter).
let tallyStore = null;

export function useTallyStore(store) {
  tallyStore = store ?? null;
}

function ownerRoleStamp(owner, { years = true } = {}) {
  const lifetime = [...(owner?.roles ?? new Map()).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, role]) => `${key}:${role}`);
  if (!years) return lifetime.join('|');
  const perYear = [...(owner?.rolesByYear ?? new Map()).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([year, roles]) => [...roles.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, role]) => `${year}:${key}:${role}`));
  return [...lifetime, ...perYear].join('|');
}

export function yearCore(contextDb, stateDb, { now, owner, aliases, blocking = false }) {
  const roleStamp = ownerRoleStamp(owner);
  const stamp = corpusStamp(contextDb, stateDb, `${aliases ? aliases.size : 0}|${roleStamp}`);
  const hit = yearMemo.get(contextDb);
  if (hit && hit.stamp === stamp) return hit.core;

  // Stale but usable: hand it back now and rebuild behind the response.
  if (hit && !blocking) {
    if (!coreRebuildScheduled) {
      coreRebuildScheduled = true;
      setTimeout(() => {
        coreRebuildScheduled = false;
        try {
          yearCore(contextDb, stateDb, { now: Date.now(), owner, aliases, blocking: true });
        } catch {
          // A failed rebuild leaves the previous core in place, which is stale
          // rather than wrong. The next request schedules another.
        }
      }, 0).unref?.();
    }
    return hit.core;
  }

  // A BLOCKING REBUILD THAT FAILS MUST NOT COST THE GOOD ANSWER.
  //
  // loadSpine now raises when it cannot read the contacts spine rather than
  // reporting an empty address book, so this can throw where it used to return
  // a nameless graph. Stale is the right thing to serve then -- the alternative
  // is a panel that shows everyone as a phone number, which is what this whole
  // change exists to stop.
  try {
    return buildYearCore(contextDb, stateDb, { now, owner, aliases, stamp });
  } catch (error) {
    if (hit) return hit.core;
    throw error;
  }
}

function buildYearCore(contextDb, stateDb, { now, owner, aliases, stamp }) {
  const graph = buildGraph(contextDb, stateDb, { now, owner, aliases })
    .filter((p) => !isNonPerson(p) && hasRelationship(p));
  const idToKey = new Map(graph.flatMap((p) => (p.identifiers ?? []).map((id) => [id, p.key])));
  const nameTokens = nameTokenSet([...graph.map((p) => p.name), ...(owner?.names ?? [])]);
  const topics = topicTallies(contextDb, idToKey, {
    nameTokens,
    bucketBy: 'year',
    // The scan is cached on the corpus alone; the fold re-runs on every spine
    // change, which is 28ms against a 3,494ms rescan.
    scanStamp: corpusOnlyStamp(contextDb),
    // ...and cached on disk between runs, so a restart that changed nothing
    // loads the scan instead of repeating it.
    store: tallyStore,
  });

  // idToKey rides along because people/content.mjs needs exactly this
  // resolution to credit a corpus hit to the same person their message count
  // already belongs to -- recomputing it there would be a second copy free to
  // drift from this one.
  const core = { graph, topics, idToKey };
  yearMemo.set(contextDb, { stamp, core, builtAt: Date.now() });
  return core;
}

// Person key → contact image bytes for explicitly requested people. This
// reuses the memoised graph and treats a missing legacy avatar table as no
// photo, rather than as a failed People page.
export function buildAvatars(contextDb, stateDb, { keys, now = Date.now(), owner, aliases = null } = {}) {
  const wanted = new Set(Array.isArray(keys) ? keys : []);
  if (wanted.size === 0 || !stateDb) return new Map();
  let avatarFor;
  try {
    avatarFor = stateDb.prepare('SELECT jpeg FROM contact_avatars WHERE identifier = ?');
  } catch {
    return new Map();
  }
  const { graph } = yearCore(contextDb, stateDb, { now, owner, aliases });
  const out = new Map();
  for (const person of graph) {
    if (!wanted.has(person.key)) continue;
    for (const identifier of person.identifiers ?? []) {
      const row = avatarFor.get(identifier);
      if (row?.jpeg) { out.set(person.key, row.jpeg); break; }
    }
  }
  return out;
}

export function buildYear(contextDb, stateDb, { year, now = Date.now(), owner, aliases = null, cap = 250 } = {}) {
  const { graph, topics } = yearCore(contextDb, stateDb, { now, owner, aliases });

  const yearsSet = new Set();
  const entries = [];
  const prefix = `${year}-`;
  for (const p of graph) {
    let messages = 0;
    let met = 0;
    let roomMessages = 0;
    const channels = new Set();
    for (const b of p.timeline ?? []) {
      yearsSet.add(Number(b.ym.slice(0, 4)));
      if (!b.ym.startsWith(prefix)) continue;
      // `messages` is DIRECT, because that is what the row's label claims. Room
      // volume is its own number, next to it, not folded into it.
      messages += (b.sent ?? 0) + (b.received ?? 0);
      met += b.met ?? 0;
      roomMessages += b.room ?? 0;
      for (const channel of b.channels ?? []) channels.add(channel);
    }
    const engagement = messages + MEETING_WEIGHT * met;
    // A YEAR SPENT ONLY IN ROOMS STILL HAPPENED. Ordering is by direct
    // engagement, so somebody the owner never addressed sorts below everybody
    // they did -- but they stay ON the list, because "you were in three group
    // chats with this person and never messaged them" is the answer, and a row
    // that vanishes cannot give it. Room volume deliberately does NOT enter
    // engagement: it would buy rank with other people's conversations.
    if (engagement === 0 && roomMessages === 0) continue;
    entries.push({ p, messages, met, engagement, roomMessages, channels: [...channels].sort() });
  }
  entries.sort((a, b) => b.engagement - a.engagement);

  // Computed over the FULL ranked set, deliberately before the display cap
  // below: a streak or a return is worth surfacing even when the person sits
  // past row 250, and capping first would have quietly made the highlights a
  // fact about the first page rather than about the year.
  const { cards, awards } = buildYearAwards(entries, { year, now });
  // A category can reward a quiet returner or drifter who sits below the
  // ordinary engagement cap. Keep every top-ten recipient in the payload so
  // its row can actually wear the label and the category filter can show all
  // ten; dedupe against the normal first page and preserve rank order.
  const displayEntries = entries.slice(0, cap);
  const displayedKeys = new Set(displayEntries.map((entry) => entry.p.key));
  const entryByKey = new Map(entries.map((entry) => [entry.p.key, entry]));
  for (const award of awards) {
    for (const key of award.keys ?? []) {
      if (displayedKeys.has(key)) continue;
      const entry = entryByKey.get(key);
      if (!entry) continue;
      displayEntries.push(entry);
      displayedKeys.add(key);
    }
  }

  return {
    year,
    years: [...yearsSet].sort((a, b) => a - b),
    total: entries.length,
    highlights: cards,
    // Each category's top ten. The page joins these compact key lists onto
    // the visible rows and reuses the category card's own icon and label.
    awards,
    people: displayEntries.map((e) => {
      const doc = topics.docs.get(`${e.p.key}|${year}`);
      // The row carries only what the page still shows: the company, status
      // and in-person filters were yeeted (owner, 2026-08-25) and their
      // fields left with them.
      return {
        key: e.p.key,
        name: e.p.name,
        // Year-local, not the relationship's lifetime union. These glyphs are
        // interactive filters, so their claim has to match the selected tab.
        channels: e.channels,
        messages: e.messages,
        roomMessages: e.roomMessages,
        engagement: e.engagement,
        // ONLY EVER IN ROOMS. Relationship-level, not per-year: the question
        // "do I actually know this person, or do we just share a group chat"
        // is not a question about a particular year. Some people in a private
        // development corpus had never sent the owner a direct message and
        // until now rendered
        // identically to friends.
        roomOnly: e.p.roomOnly === true,
        // A year tab gets that year's inferred/corrected role. Never fall back
        // to the lifetime role here: that is how an early romantic period used
        // to paint every later year romantic too.
        role: e.p.rolesByYear?.[year] ?? 'friend',
        // Five chips, not three (owner, 2026-08-25) — and no separate
        // taxonomy or specifics fields: the chips ARE the topic surface, and
        // the expanded row's only extra is the model-written summary.
        topics: topTopics(doc, topics.docFreq, topics.totalDocs, { limit: 5 }),
      };
    }),
  };
}

// EVERY year's people, uncapped and carrying identifiers -- the corpus a SEARCH
// box ranks over.
//
// buildYear is not that corpus, and the two ways it differs are exactly the two
// things search exists to fix. It slices to a 250-person cap, so the person you
// cannot find on the page is the person it would also hide from the search; and
// its rows carry no identifiers, so "the number I know them by" -- often the
// only thing the owner remembers -- could never match. Widening buildYear
// instead would push both onto the page payload, which needs neither.
//
// Memoized on the same corpus stamp as yearCore, because this is called on a
// keystroke and the answer only changes when the corpus does.
const searchMemo = new WeakMap();

export function buildSearchYears(contextDb, stateDb, { now = Date.now(), owner, aliases = null } = {}) {
  const stamp = corpusStamp(
    contextDb,
    stateDb,
    `${aliases ? aliases.size : 0}|${ownerRoleStamp(owner)}`
  );
  const hit = searchMemo.get(contextDb);
  if (hit && hit.stamp === stamp) return hit.value;

  const { graph, topics, idToKey } = yearCore(contextDb, stateDb, { now, owner, aliases });
  const byYear = new Map();
  for (const p of graph) {
    const per = new Map(); // year -> tallies, from the person's own timeline
    for (const b of p.timeline ?? []) {
      const y = Number(String(b.ym).slice(0, 4));
      if (!Number.isInteger(y)) continue;
      const cur = per.get(y) ?? { messages: 0, met: 0, roomMessages: 0, channels: new Set() };
      cur.messages += (b.sent ?? 0) + (b.received ?? 0);
      cur.met += b.met ?? 0;
      cur.roomMessages += b.room ?? 0;
      for (const channel of b.channels ?? []) cur.channels.add(channel);
      per.set(y, cur);
    }
    for (const [y, v] of per) {
      const engagement = v.messages + MEETING_WEIGHT * v.met;
      // Reachable by search even in a year that was only rooms -- search is
      // about finding somebody, and they were there.
      if (engagement === 0 && v.roomMessages === 0) continue;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push({
        key: p.key,
        name: p.name,
        channels: [...v.channels].sort(),
        identifiers: p.identifiers ?? [],
        messages: v.messages,
        roomMessages: v.roomMessages,
        engagement,
        roomOnly: p.roomOnly === true,
        role: p.rolesByYear?.[y] ?? 'friend',
        // Each person-year doc is touched once across the whole loop, so this
        // is one pass over the docs rather than one per year.
        topics: topTopics(topics.docs.get(`${p.key}|${y}`), topics.docFreq, topics.totalDocs, { limit: 5 }),
      });
    }
  }
  const value = {
    byYear: Object.fromEntries(byYear),
    years: [...byYear.keys()].sort((a, b) => a - b),
    idToKey,
  };
  searchMemo.set(contextDb, { stamp, value });
  return value;
}

// Memoized like its two siblings, on the same corpus stamp. The globe is a full
// synchronous scan that can take several seconds, and it ran on
// every open, including at app start when the last-used scope was restored.
// yearCore and buildSearchYears have both paid for this lesson already.
//
// `sinceTs` joins the stamp key because it changes which rows are scanned: two
// windows are two different answers and must not share one cache entry. `now` is
// deliberately out, exactly as in yearCore -- it only gates future-dated rows,
// and a cache minutes stale on that axis changes nothing a map can show.
const mapMemo = new WeakMap();

export function buildMap(contextDb, stateDb, { now = Date.now(), owner, sinceTs = null, aliases = null } = {}) {
  // A role correction changes the star payload without touching the corpus.
  // Keep that local config state in this memo key so the constellation never
  // trails behind the People list after a right-click correction.
  const roleStamp = ownerRoleStamp(owner, { years: false });
  const stamp = corpusStamp(contextDb, stateDb, `${aliases ? aliases.size : 0}|${sinceTs ?? 'all'}|${roleStamp}`);
  const memoHit = mapMemo.get(contextDb);
  if (memoHit && memoHit.stamp === stamp) return memoHit.value;
  // Drop automated senders/role addresses (shared filter), then keep only the
  // people the owner actually has a relationship with — see hasRelationship.
  // SHARE THE CORE when there is no window. buildMap was calling buildGraph
  // directly and rebuilding an identical population into its own memo, pure
  // duplication after yearCore had already paid for it.
  //
  // Only when sinceTs is null, because a window changes WHICH ROWS the graph is
  // built from and yearCore has no notion of one. That is the globe's own case,
  // so the sharing covers the path that actually hurts.
  // SHARE THE WHOLE CORE when there is no window -- the graph AND the topic
  // tallies. buildMap was calling buildGraph and topicTallies itself, rebuilding
  // an identical population and rescanning the whole corpus for chips that
  // yearCore had already computed. topicTallies is most of a cold build, so
  // sharing it is the larger half.
  //
  // Only when sinceTs is null, because a window changes WHICH ROWS the graph is
  // built from and yearCore has no notion of one. That is the globe's own case,
  // so the sharing covers the path that actually hurts.
  const shared = sinceTs == null ? yearCore(contextDb, stateDb, { now, owner, aliases }) : null;
  const graph = (shared
    ? shared.graph
    : buildGraph(contextDb, stateDb, { now, owner, sinceTs, aliases })
  ).filter((p) => !isNonPerson(p) && hasRelationship(p));

  // Per-year topic chips (people/topics.mjs): one corpus scan, keyed by the
  // SAME resolution the graph just produced (identifier -> person key), so a
  // merged person tallies as one. Name tokens — everyone's, plus the
  // owner's — are excluded up front: a person's own name is never their topic.
  const idToKey = shared
    ? shared.idToKey
    : new Map(graph.flatMap((p) => (p.identifiers ?? []).map((id) => [id, p.key])));
  const topics = shared
    ? shared.topics
    : topicTallies(contextDb, idToKey, {
        nameTokens: nameTokenSet([...graph.map((p) => p.name), ...(owner?.names ?? [])]),
        scanStamp: corpusOnlyStamp(contextDb),
      });

  // Strength is depth (volume + reciprocity + reach), normalized to 0..1 across
  // the whole map so the client sizes stars on a stable scale.
  let maxDepth = 0;
  const scored = graph.map((p) => {
    const depth = depthScore(p);
    if (depth > maxDepth) maxDepth = depth;
    return { p, depth };
  });
  const norm = maxDepth > 0 ? maxDepth : 1;

  const clusterSizes = new Map();
  const clusterLabels = new Map();
  const clusterPersonal = new Set();

  const people = scored.map(({ p, depth }) => {
    const c = clusterOf(p);
    clusterSizes.set(c.key, (clusterSizes.get(c.key) ?? 0) + 1);
    if (!clusterLabels.has(c.key)) clusterLabels.set(c.key, c.label);
    if (c.personal) clusterPersonal.add(c.key);

    // Days since last contact of any kind, for the personal field where there
    // may be no inbound to drive dormancy.
    const sinceSeen = Number.isFinite(p.lastSeen) ? Math.max(0, Math.floor((now - p.lastSeen) / DAY)) : null;
    // A ROOM DOES NOT MAKE SOMEBODY WARM.
    //
    // dormancyDays is null for a person who has never sent a direct message,
    // which is the fix -- but falling back to lastSeen put the room straight
    // back in, because lastSeen ticks on any activity including a group post.
    // A room-only speaker who posted yesterday came out at recencyDays 1 and
    // maximum warmth, indistinguishable from a close friend, which is exactly
    // the constellation behaviour the dormancy fix was supposed to correct.
    //
    // null rather than a large number: warmthOf already has a tier for "no
    // recency to speak of" and this genuinely is that case. The lastSeen
    // fallback stays for everybody else, where it is the only signal a
    // calendar-only contact has.
    const recencyDays =
      p.dormancyDays != null ? p.dormancyDays : (p.roomOnly ? null : sinceSeen);

    // AND A SECOND CLOCK, WHICH DELIBERATELY DOES ACCEPT THE ROOM.
    //
    // Read the comment directly above before changing this: it argues at length
    // for refusing the lastSeen fallback, and this line reinstates it under a
    // different name. That is not a contradiction, it is two questions:
    //
    //   recencyDays  — "how warm is this relationship?" A room must not answer
    //                  it, because posting in a group you are both in is not
    //                  contact, and treating it as contact is what put strangers
    //                  at maximum warmth.
    //   presenceDays — "when did I last come across this person at all?" A room
    //                  absolutely answers that. Seeing somebody in a group chat
    //                  is seeing them.
    //
    // The 467 room-only people are the ENTIRE difference between the two fields
    // and that is the point of having both. It is what lets a filter offer "in
    // touch" and "gone quiet" without deleting the cohort the room work just
    // made visible -- a filter built on recencyDays would silently drop every
    // one of them, since theirs is null by design.
    //
    // NOT called effRecencyDays or anything else that reads as a better
    // recencyDays: a name like that invites the next reader to collapse the two,
    // which would undo the fix above.
    const presenceDays = p.dormancyDays != null ? p.dormancyDays : sinceSeen;

    return {
      key: p.key,
      name: p.name,
      cluster: c.key,
      clusterLabel: c.label,
      strength: Math.round((depth / norm) * 1000) / 1000,
      recencyDays,
      // Carried onto the star so the constellation can mark it, and so this is
      // measurable from the payload rather than only from the graph behind it.
      roomOnly: p.roomOnly === true,
      role: p.role,
      // The room count travels with the flag, because a consumer deciding
      // whether to draw somebody needs to tell "no contact" from "not there at
      // all" -- and `messages` alone can no longer make that distinction.
      roomMessages: p.roomMessages ?? 0,
      // Presence, not warmth. See the two-clocks comment above.
      presenceDays,
      warm: warmthOf(recencyDays),
      channels: p.channels ?? [],
      messages: p.messages ?? 0,
      sent: p.sent ?? 0,
      received: p.received ?? 0,
      reciprocity: p.reciprocity ?? 0,
      metInPerson: p.metInPerson ?? 0,
      firstSeen: p.firstSeen ?? null,
      lastSeen: p.lastSeen ?? null,
      dormancyDays: p.dormancyDays ?? null,
      company: p.linkedin?.company ?? null,
      title: p.linkedin?.position ?? null,
      // The year view: engagement per year plus that YEAR's top-3 topics —
      // "what we talked about in 2021", not a lifetime blur.
      years: yearRows(p.timeline).map((r) => ({
        ...r,
        topics: topTopics(topics.docs.get(`${p.key}|${r.year}`), topics.docFreq, topics.totalDocs),
      })),
      // A few identifiers for the card; the full set is not needed to render.
      identifiers: (p.identifiers ?? []).slice(0, 4),
    };
  });

  const clusters = [...clusterSizes.entries()]
    .map(([key, size]) => ({ key, label: clusterLabels.get(key), size, personal: clusterPersonal.has(key) }))
    .sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));

  const active = people.filter((p) => p.recencyDays != null && p.recencyDays < 90).length;
  const dormant = people.filter((p) => p.recencyDays != null && p.recencyDays >= 365).length;

  const mapValue = {
    counts: { people: people.length, active, dormant, clusters: clusters.length },
    clusters,
    people,
  };
  mapMemo.set(contextDb, { stamp, value: mapValue });
  return mapValue;
}
