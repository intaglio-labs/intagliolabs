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

import { buildGraph } from './graph.mjs';
import { depthScore, isNonPerson } from './rank.mjs';
import { topicTallies, topTopics, topTerms, nameTokenSet } from './topics.mjs';

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
function hasRelationship(p) {
  if ((p.metInPerson ?? 0) > 0) return true;                                    // in a room together
  if ((p.channels ?? []).some((c) => c === 'imessage' || c === 'whatsapp')) return true; // personal channel
  // On mail, a relationship means it went BOTH ways. A lone outbound (sent=1,
  // received=0) is an unsubscribe click or a cold send, not a person on the
  // map; a lone inbound is a newsletter. Reciprocity > 0 needs both directions.
  return (p.reciprocity ?? 0) > 0;
}

// The TIMELINE view's payload: one year, its months newest-first, each month's
// people sorted by that MONTH's engagement and carrying that month's top-3
// topics (people/topics.mjs, bucketBy month). Same person filter as the map
// (isNonPerson + hasRelationship), same alias folding. `years` lists every
// year the graph has activity in, so the client can page without guessing.
// The expensive core under buildMonths — the graph and the month-bucketed
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
const monthsMemo = new WeakMap();

function monthsCore(contextDb, stateDb, { now, owner, aliases }) {
  const c = contextDb.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM context').get();
  const stamp = `${c.n}|${c.m}|${aliases ? aliases.size : 0}`;
  const hit = monthsMemo.get(contextDb);
  if (hit && hit.stamp === stamp) return hit.core;

  const graph = buildGraph(contextDb, stateDb, { now, owner, aliases })
    .filter((p) => !isNonPerson(p) && hasRelationship(p));
  const idToKey = new Map(graph.flatMap((p) => (p.identifiers ?? []).map((id) => [id, p.key])));
  const nameTokens = nameTokenSet([...graph.map((p) => p.name), ...(owner?.names ?? [])]);
  const topics = topicTallies(contextDb, idToKey, { nameTokens, bucketBy: 'month' });

  const core = { graph, topics };
  monthsMemo.set(contextDb, { stamp, core });
  return core;
}

export function buildMonths(contextDb, stateDb, { year, now = Date.now(), owner, aliases = null, perMonthCap = 40 } = {}) {
  const { graph, topics } = monthsCore(contextDb, stateDb, { now, owner, aliases });

  const yearsSet = new Set();
  const byMonth = new Map(); // ym -> [{p, messages, met, engagement}]
  const prefix = `${year}-`;
  for (const p of graph) {
    for (const b of p.timeline ?? []) {
      yearsSet.add(Number(b.ym.slice(0, 4)));
      if (!b.ym.startsWith(prefix)) continue;
      const messages = (b.sent ?? 0) + (b.received ?? 0);
      const engagement = messages + MEETING_WEIGHT * (b.met ?? 0);
      if (engagement === 0) continue;
      if (!byMonth.has(b.ym)) byMonth.set(b.ym, []);
      byMonth.get(b.ym).push({ p, messages, met: b.met ?? 0, engagement });
    }
  }

  const months = [...byMonth.keys()]
    .sort()
    .reverse() // newest month first, like the year view
    .map((ym) => {
      const entries = byMonth.get(ym).sort((a, b) => b.engagement - a.engagement);
      return {
        ym,
        total: entries.length,
        // Chips only for the rows actually shown — the tail would be payload
        // for nothing.
        people: entries.slice(0, perMonthCap).map((e) => {
          // The same filter facts the sky list carries, so the timeline's
          // filter row (company / channel / status) works off one vocabulary.
          const c = clusterOf(e.p);
          const sinceSeen = Number.isFinite(e.p.lastSeen)
            ? Math.max(0, Math.floor((now - e.p.lastSeen) / DAY))
            : null;
          return {
            key: e.p.key,
            name: e.p.name,
            company: e.p.linkedin?.company ?? null,
            cluster: c.key,
            clusterLabel: c.label,
            channels: e.p.channels ?? [],
            recencyDays: e.p.dormancyDays != null ? e.p.dormancyDays : sinceSeen,
            messages: e.messages,
            met: e.met,
            engagement: e.engagement,
            topics: topTopics(topics.docs.get(`${e.p.key}|${ym}`), topics.docFreq, topics.totalDocs),
            // The expanded row's detail: taxonomy with counts, and the
            // SPECIFICS — their actual distinctive words for that month.
            taxonomy: Object.entries(topics.docs.get(`${e.p.key}|${ym}`)?.taxonomy ?? {})
              .filter(([, n]) => n >= 2)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([label, n]) => ({ label, n })),
            specifics: topTerms(topics.docs.get(`${e.p.key}|${ym}`), topics.docFreq, topics.totalDocs),
          };
        }),
      };
    });

  return { year, years: [...yearsSet].sort((a, b) => a - b), months };
}

export function buildMap(contextDb, stateDb, { now = Date.now(), owner, sinceTs = null, aliases = null } = {}) {
  // Drop automated senders/role addresses (shared filter), then keep only the
  // people the owner actually has a relationship with — see hasRelationship.
  const graph = buildGraph(contextDb, stateDb, { now, owner, sinceTs, aliases })
    .filter((p) => !isNonPerson(p) && hasRelationship(p));

  // Per-year topic chips (people/topics.mjs): one corpus scan, keyed by the
  // SAME resolution the graph just produced (identifier -> person key), so a
  // merged person tallies as one. Name tokens — everyone's, plus the
  // owner's — are excluded up front: a person's own name is never their topic.
  const idToKey = new Map(graph.flatMap((p) => (p.identifiers ?? []).map((id) => [id, p.key])));
  const nameTokens = nameTokenSet([...graph.map((p) => p.name), ...(owner?.names ?? [])]);
  const topics = topicTallies(contextDb, idToKey, { nameTokens });

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
    const recencyDays = p.dormancyDays != null ? p.dormancyDays : sinceSeen;

    return {
      key: p.key,
      name: p.name,
      cluster: c.key,
      clusterLabel: c.label,
      strength: Math.round((depth / norm) * 1000) / 1000,
      recencyDays,
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

  return {
    counts: { people: people.length, active, dormant, clusters: clusters.length },
    clusters,
    people,
  };
}
