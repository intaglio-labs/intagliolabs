// The extraction layer over the people graph: WHEN a relationship lived, not
// just its lifetime totals. graph.mjs buckets every signal by calendar month
// (person.timeline); this module turns those buckets into the facts a
// resurfacing answer needs -- the PEAK ERA (the months you were actually
// close), the CADENCE (active / fading / dormant), the OPEN LOOP (they wrote
// last and never got an answer), and "was this person active with me in
// 2020-2022" as a filter any need can apply (rank.mjs `activeWindow`).
//
// WHY THIS EXISTS: for a contact from years ago, "last heard ~4.2y ago" jogs
// no memory -- the aggregate view flattens exactly the thing that made the
// relationship real. "Peak 2018-2019, 340 messages, went quiet Mar 2020" IS
// the memory. Same shape, different axis: the graph answers "how much",
// this answers "when".
//
// Pure functions, no I/O, no model -- the rank.mjs rule holds here too: what
// surfaces about a person must be legible code the owner can audit, and every
// number must trace to counted rows. Nothing here is estimated or embellished.

const DAY = 86_400_000;

// 'YYYY-MM' <-> a flat month index, so window arithmetic is integer math.
export function monthIndex(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return y * 12 + (m - 1);
}

export function ymFromIndex(i) {
  const y = Math.floor(i / 12);
  const m = (i % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Same two questions as highlights.mjs isActive, same explicit answer -- and it
// matters more here, because this feeds a HARD GATE in the ranker rather than a
// headline. `withRoom: false` is correspondence (peak era, "when we actually
// talked"); `withRoom: true` is presence (was this person around at all).
//
// This summed sent+received back when that WAS everything. Since rooms became
// their own number it silently became direct-only for every caller.
function msgs(b, { withRoom = false } = {}) {
  const direct = (b.sent ?? 0) + (b.received ?? 0);
  return withRoom ? direct + (b.room ?? 0) : direct;
}

function ymOfTs(ts) {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// The peak era: the densest `windowMonths` run of MESSAGES, trimmed to the
// months inside it that actually had any. Messages, not meetings, on purpose:
// the era being reconstructed is "when we actually talked", and a standing
// calendar series with no conversation is not that. Returns
//   { fromYm, toYm, messages, share }   (share = fraction of lifetime messages
// that fall inside the window -- 0.9 reads "this WAS the relationship"), or
// null for a person with no messages at all (calendar-only tie).
export function peakEra(timeline, { windowMonths = 6 } = {}) {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  const total = timeline.reduce((n, b) => n + msgs(b), 0);
  if (total === 0) return null;
  const lo = monthIndex(timeline[0].ym);
  const hi = monthIndex(timeline[timeline.length - 1].ym);
  const byIdx = new Map(timeline.map((b) => [monthIndex(b.ym), b]));
  let best = { start: lo, sum: -1 };
  for (let s = lo; s <= Math.max(lo, hi - windowMonths + 1); s++) {
    let sum = 0;
    for (let i = s; i < s + windowMonths; i++) {
      const b = byIdx.get(i);
      if (b) sum += msgs(b);
    }
    if (sum > best.sum) best = { start: s, sum };
  }
  // Trim to the active months inside the winning window, so the era named is
  // "Mar-Aug 2019", not a six-month frame with empty edges.
  let from = null;
  let to = null;
  for (let i = best.start; i < best.start + windowMonths; i++) {
    const b = byIdx.get(i);
    if (b && msgs(b) > 0) {
      if (from === null) from = i;
      to = i;
    }
  }
  return {
    fromYm: ymFromIndex(from),
    toYm: ymFromIndex(to),
    messages: best.sum,
    share: Math.round((100 * best.sum) / total) / 100,
  };
}

// Activity inside an explicit month window (both ends inclusive). The engine
// under rank.mjs's `activeWindow` gate: "investors from 2020-2022" keeps only
// people with real contact inside those months.
export function activityInWindow(timeline, fromYm, toYm) {
  const lo = monthIndex(fromYm);
  const hi = monthIndex(toYm);
  let messages = 0;
  let met = 0;
  let months = 0;
  for (const b of timeline ?? []) {
    const i = monthIndex(b.ym);
    if (i < lo || i > hi) continue;
    messages += msgs(b);
    met += b.met ?? 0;
    if (msgs(b) + (b.met ?? 0) > 0) months += 1;
  }
  return { messages, met, months };
}

// active / fading / dormant, from the last six calendar months measured
// against the peak six-month run. Thresholds declared here, once, so tuning
// is a visible diff:
//   dormant  zero messages in the last 6 months
//   fading   some, but under a quarter of the peak run
//   active   otherwise
export function cadence(p, { now = Date.now() } = {}) {
  const timeline = p.timeline ?? [];
  const peak = peakEra(timeline);
  if (peak === null) return { state: 'dormant', recentMessages: 0, peakMessages: 0 };
  const d = new Date(now);
  const nowIdx = d.getFullYear() * 12 + d.getMonth();
  const recent = activityInWindow(timeline, ymFromIndex(nowIdx - 5), ymFromIndex(nowIdx));
  const state =
    recent.messages === 0 ? 'dormant' : recent.messages < peak.messages / 4 ? 'fading' : 'active';
  return { state, recentMessages: recent.messages, peakMessages: peak.messages };
}

// They wrote last and the owner never answered -- the built-in reason to
// reach back out. Message-channel clocks only (graph.mjs lastFromThem /
// lastFromOwner), so a calendar invite neither opens nor closes a loop.
// `minDays` keeps "they texted this morning" from reading as a debt.
// Returns { waitingDays } or null.
export function openLoop(p, { now = Date.now(), minDays = 7 } = {}) {
  if (p.lastFromThem == null) return null;
  if (p.lastFromOwner != null && p.lastFromOwner >= p.lastFromThem) return null;
  const waitingDays = Math.floor((now - p.lastFromThem) / DAY);
  return waitingDays >= minDays ? { waitingDays } : null;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ymLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function eraSpanLabel(fromYm, toYm) {
  const fy = fromYm.slice(0, 4);
  const ty = toYm.slice(0, 4);
  return fy === ty ? fy : `${fy}–${ty}`;
}

// The memory-jog line, deterministic: "peak 2018–2019 (340 messages) — went
// quiet Mar 2020 — they wrote last, unanswered". Built ONLY from counted rows
// -- the same no-fabrication rule as every evidence line. Returns null for a
// person with no message history (nothing honest to say).
export function eraLine(p, { now = Date.now() } = {}) {
  const peak = peakEra(p.timeline ?? []);
  if (peak === null) return null;
  const bits = [`peak ${eraSpanLabel(peak.fromYm, peak.toYm)} (${peak.messages} messages)`];
  const c = cadence(p, { now });
  // "Went quiet" is the last MESSAGE either way, not lastSeen -- a calendar
  // hold months later is not the conversation continuing.
  const lastMsg = Math.max(p.lastFromThem ?? 0, p.lastFromOwner ?? 0) || null;
  if (c.state === 'dormant' && lastMsg !== null) bits.push(`went quiet ${ymLabel(ymOfTs(lastMsg))}`);
  else if (c.state === 'fading') bits.push('fading');
  const loop = openLoop(p, { now });
  if (loop !== null) bits.push('they wrote last, unanswered');
  return bits.join(' — ');
}
