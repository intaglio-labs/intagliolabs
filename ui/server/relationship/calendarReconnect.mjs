// The calendar reconnect adapter: the Phase 0 winner, finally a source. The
// 2026-08-28 ablation's calendar-only arm out-graded every message arm and
// every one of its useful candidates was invisible to message signals --
// people the owner sits in rooms with are not the people the owner texts.
// The plan's sources-are-peers seam (service.registerSource) exists for
// exactly this adapter.
//
// Deterministic, no model. Thresholds default to the pre-registered Phase 0
// v2 rules (l5-phase0-v2: >= 3 meetings, >= 120 days since the last, small
// gatherings only -- an 8+ attendee event is a broadcast, not a
// relationship). The promotion-gates artifact overrides them when it exists.
//
// The join: calendar rows carry attendee emails (sorted, owner and resource
// rooms already stripped at ingest); the contacts spine maps an email to the
// owner-chosen display name, and normName folds that to the same canonical
// person key the episode index uses -- so suppression, mute, and dismissal
// state all apply to the same human across both adapters.
//
// Its coverage gate differs from the message adapters' by nature: a FUTURE
// event on the calendar is the proof of forward coverage (the pipe that
// would show a scheduled meeting is demonstrably delivering), and a future
// event WITH the candidate vetoes the card -- do not suggest reconnecting
// with someone the owner sees on Tuesday. That veto out-performed every
// scoring tweak in the Phase 0 join arm.

export const CAL_RECONNECT_RULES_VERSION = 'rm-cal-reconnect-v1';

// Phase 0 arm-3 gates, one copy for adapter and matcher alike.
export const CAL_GATES = Object.freeze({ minMeetings: 3, dormancyDays: 120, maxAttendees: 8 });
const DAY = 86_400_000;

function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function calendarReconnectAdapter({ minMeetings = CAL_GATES.minMeetings, dormancyDays = CAL_GATES.dormancyDays, maxAttendees = CAL_GATES.maxAttendees, limit = 15 } = {}) {
  return {
    name: 'reconnect-calendar',
    candidates(service, { now = Date.now() } = {}) {
      const contextDb = service.db();
      const stateDb = service.stateDbHandle();
      if (!stateDb) return [];

      // email -> canonical person key, through the spine. Email-shaped
      // display names stay eligible (the owner graded several useful in
      // Phase 0) but keep their email as the honest display.
      const byEmail = new Map();
      const namedKeys = new Set(); // normName keys the owner actually named
      for (const r of stateDb.prepare('SELECT identifier, display_name FROM contact_ids').all()) {
        const id = String(r.identifier).toLowerCase();
        const emailShaped = String(r.display_name).includes('@');
        if (!emailShaped) namedKeys.add(normName(r.display_name));
        if (!id.includes('@')) continue;
        byEmail.set(id, { key: `name:${normName(r.display_name)}`, name: r.display_name, emailShaped });
      }

      // Forward coverage: the calendar pipe must be demonstrably delivering
      // ahead of now, or "nothing scheduled" is a claim about a dead sync.
      const maxTs = Number(contextDb.prepare(
        "SELECT MAX(ts) AS m FROM context WHERE source = 'calendar'").get()?.m ?? 0);
      if (maxTs <= now) return [];

      const people = new Map(); // key -> { name, met, lastMet, future }
      for (const row of contextDb.prepare(
        `SELECT ts, meta FROM context WHERE source = 'calendar' AND meta LIKE '%"attendees"%'`).all()) {
        let atts;
        try { atts = JSON.parse(row.meta)?.attendees; } catch { continue; }
        if (!Array.isArray(atts) || atts.length === 0 || atts.length > maxAttendees) continue;
        for (const a of atts) {
          if (a?.response === 'declined') continue;
          let hit = byEmail.get(String(a?.email ?? '').toLowerCase());
          if (!hit) continue;
          // The Phase 0 fold, kept: when the stored display name IS the email
          // (a calendar-sourced contact nobody named) and the invite carries a
          // display name matching a contact the owner DID name, fold to that
          // person -- the ablation shipped one human as two cards, graded
          // oppositely, without this. An invite-supplied name may only point
          // AT an owner-named person, never mint one.
          if (hit.emailShaped && typeof a?.name === 'string') {
            const nk = normName(a.name);
            if (namedKeys.has(nk)) hit = { key: `name:${nk}`, name: a.name, emailShaped: false };
          }
          let p = people.get(hit.key);
          if (!p) { p = { name: hit.name, met: 0, lastMet: -Infinity, future: 0 }; people.set(hit.key, p); }
          if (row.ts <= now) { p.met += 1; if (row.ts > p.lastMet) p.lastMet = row.ts; }
          else p.future += 1;
        }
      }

      const out = [];
      for (const [key, p] of [...people.entries()].sort((a, b) => b[1].met - a[1].met)) {
        if (out.length >= limit) break;
        if (p.future > 0) continue;                       // the veto
        if (p.met < minMeetings) continue;
        const quiet = Math.floor((now - p.lastMet) / DAY);
        if (quiet < dormancyDays) continue;
        if (service.controls.isSuppressed(key)) continue;  // before ranking, as always
        if (service.controls.isMuted({ personKey: key, kind: 'reconnect', now })) continue;
        out.push({
          personKey: key,
          kind: 'reconnect',
          summary: `${p.name} — met ${p.met}×, none since, nothing scheduled`,
          evidence: { meetings: p.met, lastMeetingDaysAgo: quiet, futureMeetings: 0 },
          producer_version: CAL_RECONNECT_RULES_VERSION,
          rank_strategy: 'meetings-desc',
        });
      }
      return out;
    },
  };
}
