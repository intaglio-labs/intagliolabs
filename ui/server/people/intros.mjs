// Warm-intro paths: for a person the owner barely knows, who in the owner's
// network has already shared a ROOM with them — and is warm enough to ask?
//
// A "room" is a moment the owner was also in: one email's participant set
// (from + to + cc), or one calendar event's attendees. Two non-owner people in
// the same room have crossed paths THROUGH the owner, which is exactly the
// evidence a warm intro needs — "you and Barry were both on a thread with Dana
// in March, ask Barry."
//
// THE HONEST BOUND, in the code because it must not be forgotten: this only
// sees crossings that touched the owner. A friend who knows the target from a
// dinner the owner was not at is invisible — that connection is simply not in
// the data. So this finds REAL bridges and misses the ones that happened
// entirely without the owner. It is "who have I seen standing next to this
// person", never "who secretly knows them".
//
// All code, no model. Reads context; writes nothing.

import { warmthScore } from './firms.mjs';

function localDate(ms) {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Every room the owner was in, as { ts, kind, ids:Set<identifier> }. Only rooms
// with 2+ non-owner people matter (a room of one is not a crossing).
export function buildRooms(contextDb, owner) {
  const isOwner = (a) => owner.addresses.has(String(a).toLowerCase());
  const rooms = [];

  for (const row of contextDb
    .prepare("SELECT ts, source, meta FROM context WHERE source IN ('mail','calendar')")
    .all()) {
    let meta = {};
    try {
      meta = JSON.parse(row.meta ?? '{}') ?? {};
    } catch {
      continue;
    }
    const ids = new Set();
    if (row.source === 'mail') {
      for (const a of [...(meta.from ?? []), ...(meta.to ?? []), ...(meta.cc ?? [])]) {
        if (typeof a === 'string' && !isOwner(a)) ids.add(a.toLowerCase());
      }
    } else {
      for (const a of meta.attendees ?? []) {
        if (a?.email && !isOwner(a.email)) ids.add(a.email.toLowerCase());
      }
    }
    if (ids.size >= 2) rooms.push({ ts: Number(row.ts), kind: row.source, ids });
  }
  return rooms;
}

// identifier -> the graph person who owns it, so a room's raw addresses map to
// resolved people (Character VC's four addresses collapse to their people).
function identifierIndex(graph) {
  const map = new Map();
  for (const p of graph) for (const id of p.identifiers ?? []) map.set(id, p);
  return map;
}

// Resolve a target query (a name, or an email/identifier) to graph people.
// A firm name or partial name can match several — all are searched.
export function resolveTargets(graph, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  // Normalized form for firm-name matching: "character vc" and "character.vc"
  // both become "charactervc", so a firm name matches its email domain.
  const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/gu, '');
  const qn = squash(q);

  const exact = graph.filter((p) => (p.identifiers ?? []).some((id) => String(id).toLowerCase() === q));
  if (exact.length) return exact;

  const hits = graph.filter((p) => {
    if (p.name.toLowerCase().includes(q)) return true;
    if (p.linkedin?.company && squash(p.linkedin.company).includes(qn)) return true;
    return (p.identifiers ?? []).some((id) => {
      const s = String(id).toLowerCase();
      if (s.includes(q)) return true;
      // Match the firm against the email DOMAIN: "charactervc" ⊂ "charactervc"
      // from jake@character.vc. Guarded to domains of length >=4 so a short
      // query does not match half the corpus.
      const at = s.indexOf('@');
      const domain = at === -1 ? '' : squash(s.slice(at + 1));
      return qn.length >= 4 && domain.includes(qn);
    });
  });
  return hits;
}

// The bridges to a target: warm contacts who shared a room with them.
export function findIntros(graph, rooms, target, { limit = 8 } = {}) {
  const idIndex = identifierIndex(graph);
  const targetIds = new Set(target.identifiers ?? []);

  // Every room the target was in, and who else was there — weighting each room
  // by SIZE. A 2-person thread is real evidence two people know each other; a
  // 20-person demo day is almost none, and counting them equally floated every
  // batch-mate to the top. Strength per shared room = 1/(others in the room).
  const bridges = new Map(); // person -> { strength, shared, lastTs, kinds }
  for (const room of rooms) {
    let hasTarget = false;
    for (const id of room.ids) if (targetIds.has(id)) { hasTarget = true; break; }
    if (!hasTarget) continue;
    // BIG ROOMS ARE NOT INTRO SIGNAL. A 2-4 person thread or meeting with the
    // target and a friend is a real path; a 20-person program meeting or mass
    // email is just "we were in the same batch", and counting it floated every
    // batch-mate to the top. Only genuinely small rooms count.
    if (room.ids.size > 6) continue;
    const others = room.ids.size - 1; // people besides the target
    const weight = 1 / Math.max(1, others);
    for (const id of room.ids) {
      if (targetIds.has(id)) continue;
      if (/^(no-?reply|notifications?|updates?|mailer|hello|team|support|info|admin|billing|events?)[@+]/iu.test(String(id))) continue;
      const person = idIndex.get(id);
      if (!person || person.name === target.name) continue;
      if (!bridges.has(person.name)) bridges.set(person.name, { person, strength: 0, shared: 0, lastTs: 0, kinds: new Set() });
      const b = bridges.get(person.name);
      b.strength += weight;
      b.shared += 1;
      b.kinds.add(room.kind);
      if (room.ts > b.lastTs) b.lastTs = room.ts;
    }
  }

  // A useful bridge is one the OWNER is actually warm with (they'd make the
  // intro) and who has a real tie to the target (small-room co-occurrence, not
  // just a shared big event). Both gates, so the list is people worth asking,
  // not everyone who was in a room.
  const MIN_WARMTH = 3; // lukewarm or better
  const MIN_STRENGTH = 0.15;
  const ranked = [...bridges.values()]
    .map((b) => ({
      name: b.person.name,
      warmthWithOwner: Math.round(warmthScore(b.person) * 10) / 10,
      strength: Math.round(b.strength * 100) / 100,
      sharedRooms: b.shared,
      lastShared: b.lastTs ? localDate(b.lastTs) : null,
      via: [...b.kinds].sort().join(' + '),
      score: warmthScore(b.person) * b.strength,
    }))
    .filter((b) => b.warmthWithOwner >= MIN_WARMTH && b.strength >= MIN_STRENGTH)
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, limit);
}

// One call: query -> { target, bridges } or a not-found note.
export function warmIntro(contextDb, graph, query, { owner, limit = 8 } = {}) {
  const targets = resolveTargets(graph, query);
  if (targets.length === 0) return { found: false, reason: `no one matching "${query}" in your connections` };

  // ALREADY WARM? A warm intro is for someone you do NOT know. If you already
  // have a strong direct relationship with the target, the honest answer is
  // "you know them" — not a list of bridges to a person you met 51 times.
  const warmest = targets.map((t) => ({ t, w: warmthScore(t) })).sort((a, b) => b.w - a.w)[0];
  if (warmest.w >= 6) {
    const t = warmest.t;
    return {
      found: true,
      alreadyWarm: true,
      target: t.name,
      detail: `${t.metInPerson ? `met ${t.metInPerson}× in person, ` : ''}${t.messages} messages` +
        `${t.dormancyDays !== null && t.dormancyDays < 120 ? ', active recently' : ''}`,
    };
  }
  // If several match (a firm), use the best-known one as the anchor but pool
  // every target's rooms — an intro to anyone at the firm counts.
  const rooms = buildRooms(contextDb, owner);
  const merged = { name: targets.map((t) => t.name).slice(0, 3).join(' / '), identifiers: targets.flatMap((t) => t.identifiers ?? []) };
  const bridges = findIntros(graph, rooms, merged, { limit });
  return { found: true, target: merged.name, matched: targets.length, bridges };
}
