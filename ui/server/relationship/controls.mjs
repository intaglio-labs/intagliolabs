// The owner's "leave me alone" controls (L5 step 4): permanent person
// suppression, scoped mute, structured dismissal, and the global frequency
// cap. Built and tested BEFORE any candidate generator exists, per the plan's
// ordering -- there must never be a moment where the system can nag and the
// owner cannot stop it. Tables live in hermes' SCHEMA; this module is the
// operations over them, reached through the relationship service.

export const DISMISS_REASONS = Object.freeze([
  'wrong-person', 'wrong-time', 'never-this-person', 'not-this-kind', 'not-useful',
]);
export const MUTE_SCOPES = Object.freeze(['person', 'kind', 'person-and-kind']);

const DAY = 86_400_000;
// How long a 'not-this-kind' dismissal mutes THIS PERSON for THIS KIND --
// long enough to outlast the 8-week read the plan's rollout section names,
// short enough that a kind whose relevance changes (a new commitment made,
// a new open loop opened) is not muted forever off one tap.
export const NOT_THIS_KIND_MUTE_DAYS = 90;

// HOW MANY EXTRA CARDS A REJECTION CAN BUY, IN ONE DAY.
//
// The cap counts INTERRUPTIONS -- the times this app lit up on its own and
// asked for the owner's attention -- and a card the owner rejected is an
// interruption that turned out to be worth nothing. "Show me another one" is
// then the owner asking, not the app interrupting, so it must not be paid for
// out of the same budget: the old behaviour counted every 'shown' row, so a
// dismissal spent the day's only card and the honest answer to "another?" was
// "come back tomorrow".
//
// A BUDGET RATHER THAN NO LIMIT, because a pull still costs a person out of
// the pool (the 7-day recently-offered cooldown) and an unbounded "next" turns
// a considered daily card into a feed. Three is the number the owner named.
export const PULLS_PER_DAY = 3;

// THE PULL BUDGET IS A CALENDAR DAY, NOT A ROLLING WINDOW, and it is the
// machine's own clock zone -- the same local-time discipline timeBand keeps
// above, and the same one cardStats' daysServed already counts in. "Come back
// tomorrow" is a sentence about the owner's day; a rolling 24h window would
// have it come due mid-afternoon.
//
// The frequency cap keeps its own rolling window (it is configured as one, in
// the owner's config), so the two really are different clocks. That is
// deliberate and is the smaller surprise: the cap is a rate limit, the pull
// budget is a daily allowance.
export function startOfLocalDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// How long until the budget resets, for the route's retryAfterMs. setHours(24)
// on a local Date lands on the next local midnight through a DST change, which
// adding 86_400_000 does not.
export function msUntilLocalMidnight(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return Math.max(0, d.getTime() - now);
}

// Local time band, deterministic from the machine's own clock zone. These are
// product events about the OWNER's day, so local time is the honest axis; a
// UTC band would call a Honolulu evening "morning".
export function timeBand(now = Date.now()) {
  const h = new Date(now).getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

function requireKey(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

// canonicalOf folds alias keys to one person, supplied by the service from
// the resolutions store. Identity going THROUGH the canonicalizer is what
// makes the plan's merge requirement hold: a merge widens what a suppression
// covers (both old keys fold to one canonical) and can never clear it,
// because the suppression row itself is never touched by a merge.
export function createControls(db, { canonicalOf = (k) => k } = {}) {
  return {
    // ---- permanent suppression ------------------------------------------
    suppress(personKey, now = Date.now()) {
      db.prepare('INSERT OR IGNORE INTO rm_suppression(person_key, created_at) VALUES (?, ?)')
        .run(requireKey(personKey, 'personKey'), now);
    },
    // Settings-surface only, by contract. Nothing in this codebase may call
    // it from a card, a candidate path, or a merge.
    unsuppress(personKey) {
      db.prepare('DELETE FROM rm_suppression WHERE person_key = ?')
        .run(requireKey(personKey, 'personKey'));
    },
    isSuppressed(personKey) {
      const canon = canonicalOf(requireKey(personKey, 'personKey'));
      for (const r of db.prepare('SELECT person_key FROM rm_suppression').all()) {
        if (r.person_key === personKey || canonicalOf(r.person_key) === canon) return true;
      }
      return false;
    },

    // ---- scoped mute -----------------------------------------------------
    // Every mute states its scope and duration explicitly -- the card shows
    // both before commit, and this API refuses a mute that names neither a
    // person nor a kind (the schema CHECK backs it up).
    mute({ personKey = null, kind = null, untilAt, now = Date.now() }) {
      if (personKey === null && kind === null) {
        throw new Error('a mute names a person, a kind, or both; a mute of nothing is not a global pause');
      }
      if (!Number.isFinite(untilAt) || untilAt <= now) {
        throw new Error('untilAt must be a future timestamp: an explicit duration is part of the contract');
      }
      db.prepare('INSERT INTO rm_mute(person_key, kind, until_at, created_at) VALUES (?, ?, ?, ?)')
        .run(personKey, kind, untilAt, now);
    },
    isMuted({ personKey = null, kind = null, now = Date.now() }) {
      const canon = personKey === null ? null : canonicalOf(personKey);
      for (const m of db.prepare('SELECT person_key, kind FROM rm_mute WHERE until_at > ?').all(now)) {
        const personHit = m.person_key === null ||
          (canon !== null && (m.person_key === personKey || canonicalOf(m.person_key) === canon));
        const kindHit = m.kind === null || m.kind === kind;
        // A person-scoped mute (kind NULL) hits every kind for that person; a
        // kind-scoped mute (person NULL) hits that kind for everyone.
        if (personHit && kindHit && (m.person_key !== null || m.kind !== null)) return true;
      }
      return false;
    },

    // ---- events and structured dismissal --------------------------------
    // `pulled` marks a 'shown' the OWNER ASKED FOR after rejecting one, rather
    // than an interruption this app decided to make. It is what underGlobalCap
    // does not count and what the pull budget does; see PULLS_PER_DAY.
    recordEvent({ personKey, kind, event, reason = null, note = null, ruleVersion, snapshotId = null, pulled = false, now = Date.now() }) {
      if (event === 'dismissed' && reason !== null && !DISMISS_REASONS.includes(reason)) {
        throw new Error(`dismissal reason must be one of: ${DISMISS_REASONS.join(', ')}`);
      }
      if (event !== 'dismissed' && reason !== null) {
        throw new Error('only a dismissal carries a reason');
      }
      // Only a serve can be pulled. A 'dismissed' or 'accepted' row marked
      // pulled would be a verdict claiming to be an interruption, and the two
      // counts below (interruptions, pulls) read the same column.
      if (pulled && event !== 'shown') {
        throw new Error('only a shown card is pulled: a pull is how the card was served, not how it was judged');
      }
      db.prepare(
        'INSERT INTO rm_card_event(person_key, kind, event, reason, note, rule_version, snapshot_id, pulled, time_band, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(requireKey(personKey, 'personKey'), requireKey(kind, 'kind'), event, reason,
        note === null ? null : String(note).slice(0, 500),
        requireKey(ruleVersion, 'ruleVersion'), snapshotId, pulled ? 1 : 0, timeBand(now), now);
    },
    // The one-tap dismissal. 'never-this-person' IS the permanent control
    // reached from a card -- the plan lists it among the reasons precisely so
    // suppression is one tap away; the reason row and the suppression row
    // land in the same transaction so neither can exist without the other.
    // 'not-this-kind' is the analogous one-tap control for a KIND rather than
    // a person: person+kind scoped (never global -- a global 'owe' mute is a
    // settings-surface decision, not a single card's), landing in the same
    // transaction for the same reason.
    dismiss({ personKey, kind, reason = null, note = null, ruleVersion, snapshotId = null, now = Date.now() }) {
      db.exec('BEGIN');
      try {
        this.recordEvent({ personKey, kind, event: 'dismissed', reason, note, ruleVersion, snapshotId, now });
        if (reason === 'never-this-person') this.suppress(personKey, now);
        if (reason === 'not-this-kind') {
          this.mute({ personKey, kind, untilAt: now + NOT_THIS_KIND_MUTE_DAYS * DAY, now });
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    // ---- the global frequency cap ---------------------------------------
    // One cap over ALL proactive kinds together -- per-kind cooldowns let
    // kinds take turns interrupting, the plan's stated failure. The cap's
    // numbers are NOT defaulted here: thresholds come from the sealed Phase 0
    // gates artifact, and inventing a "reasonable" default is exactly the
    // fabrication rule 1 forbids. No cap configured means nothing shows.
    //
    // IT COUNTS INTERRUPTIONS, NOT CARDS HANDED OVER (2026-09-13, owner
    // decision). A 'shown' row marked `pulled` is a card the owner asked for
    // after rejecting one, and asking is not being interrupted -- counting it
    // made the day's single interruption also the day's single card, so the
    // answer to "that one's not relevant, show me another" was "come back
    // tomorrow". Rows written before the column existed read 0 and count, which
    // is right: every one of them was an interruption.
    underGlobalCap({ max, windowMs, now = Date.now() } = {}) {
      if (!Number.isInteger(max) || max < 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
        return false; // fail closed: an unconfigured cap caps at zero
      }
      const n = Number(db.prepare(
        "SELECT COUNT(*) AS n FROM rm_card_event WHERE event = 'shown' AND pulled = 0 AND created_at > ?"
      ).get(now - windowMs).n);
      return n < max;
    },

    // How many pulls today's rejections have already bought, and whether the
    // day is over. LOCAL CALENDAR DAY, see startOfLocalDay.
    pullsUsed({ now = Date.now() } = {}) {
      return Number(db.prepare(
        "SELECT COUNT(*) AS n FROM rm_card_event WHERE event = 'shown' AND pulled = 1 AND created_at >= ?"
      ).get(startOfLocalDay(now)).n);
    },
    // AN ACCEPT ENDS THE DAY, pulled or not. "Will text them" is the outcome
    // the card exists for: once it has happened there is nothing left to offer
    // today, and offering anyway would turn a day that WORKED into a feed. A
    // rejection buys another look precisely because it produced nothing.
    acceptedToday({ now = Date.now() } = {}) {
      return db.prepare(
        "SELECT 1 FROM rm_card_event WHERE event = 'accepted' AND created_at >= ? LIMIT 1"
      ).get(startOfLocalDay(now)) !== undefined;
    },

    // HOW MANY MORE TIMES "show me another" CAN BE ANSWERED TODAY. Zero once an
    // accept has ended the day, whatever is left of the budget -- so a surface
    // can stop offering the button rather than offering it and being refused.
    pullsLeft({ now = Date.now() } = {}) {
      if (this.acceptedToday({ now })) return 0;
      return Math.max(0, PULLS_PER_DAY - this.pullsUsed({ now }));
    },

    // MAY THIS REQUEST BE SERVED A CARD, AND AT WHOSE EXPENSE -- the whole of
    // the cap decision in one place, so the route does not re-derive half of it.
    //
    //   { allowed: true, pulled: false }   an interruption, inside the cap
    //   { allowed: true, pulled: true }    the cap is spent, the owner asked
    //   { allowed: false, reason: 'cap' }  the cap is spent and nobody asked
    //   { allowed: false, reason: 'pulls-exhausted', retryAfterMs }
    //
    // THE CAP IS SPENT FIRST, EVEN WHEN A PULL IS ASKED FOR. A pull is a
    // fallback, not a preference: while the owner still has an interruption
    // owing to them, that is what pays, and `pulled` stays reserved for rows
    // that really were served past the cap. An owner on the shipped one-a-day
    // never sees the difference; an owner who raised their cap keeps the cards
    // they configured before spending a rejection's allowance.
    serveAllowance({ cap, pull = false, now = Date.now() } = {}) {
      if (this.underGlobalCap({ ...cap, now })) return { allowed: true, pulled: false };
      if (!pull) return { allowed: false, reason: 'cap' };
      if (this.pullsLeft({ now }) === 0) {
        return { allowed: false, reason: 'pulls-exhausted', retryAfterMs: msUntilLocalMidnight(now) };
      }
      return { allowed: true, pulled: true };
    },

    // The single gate, checked before candidate ranking AND immediately
    // before display (both call sites, same function, so they cannot drift).
    // Order matters for the reason returned: permanent suppression outranks
    // everything, then mute, then the cap.
    allowCard({ personKey, kind, cap, now = Date.now() }) {
      if (this.isSuppressed(personKey)) return { allowed: false, reason: 'suppressed' };
      if (this.isMuted({ personKey, kind, now })) return { allowed: false, reason: 'muted' };
      if (!this.underGlobalCap({ ...cap, now })) return { allowed: false, reason: 'global-cap' };
      return { allowed: true };
    },

    // A snapshot that already carries a verdict must not carry a second one:
    // rm_card_event is append-only (no update, no delete), so a double-submit
    // -- a slow click, a retried request, a triple-click on the desk -- has
    // to be caught HERE, before the insert, or it lands as extra rows forever.
    // Returns the first accepted/dismissed row for the snapshot, or null.
    alreadyJudged({ snapshotId }) {
      if (!Number.isInteger(snapshotId)) return null;
      const row = db.prepare(
        "SELECT event, reason, created_at FROM rm_card_event WHERE snapshot_id = ? AND event IN ('accepted','dismissed') ORDER BY created_at LIMIT 1"
      ).get(snapshotId);
      return row ?? null;
    },
  };
}

// The two kinds cardStats reports on. Hardcoded rather than imported from
// daily.mjs's CARD_PRODUCERS: this file has no dependency on any producer
// today, and a stats aggregate is not the place to start one.
const CARD_STAT_KINDS = Object.freeze(['owe', 'reconnect']);

// A single kind's numbers over rm_card_event, either windowed (sinceTs is a
// timestamp) or all-time (sinceTs is null). Counted facts only, straight off
// the append-only event log -- no verdict, no threshold, nothing this
// function decides is "good": that is the sealed Phase 0 artifact's job, not
// a stats aggregate's (rule 1's fabrication ban extends to inventing a
// pass/fail line here as much as to a metric itself).
function kindStats(db, kind, sinceTs) {
  const clause = sinceTs === null ? '' : ' AND created_at >= ?';
  const args = (event) => (sinceTs === null ? [kind, event] : [kind, event, sinceTs]);
  const countEvent = (event) => Number(db.prepare(
    `SELECT COUNT(*) AS n FROM rm_card_event WHERE kind = ? AND event = ?${clause}`
  ).get(...args(event)).n);

  const shown = countEvent('shown');
  const opened = countEvent('opened');
  const accepted = countEvent('accepted');
  const dismissed = countEvent('dismissed');
  const muted = countEvent('muted');
  const suppressed = countEvent('suppressed');

  // Distinct LOCAL calendar dates a card of this kind was shown -- the
  // machine's own clock zone, same local-time discipline timeBand uses
  // above, via SQLite's own 'localtime' modifier.
  const daysServed = Number(db.prepare(
    `SELECT COUNT(DISTINCT date(created_at / 1000, 'unixepoch', 'localtime')) AS n
     FROM rm_card_event WHERE kind = ? AND event = 'shown'${clause}`
  ).get(...(sinceTs === null ? [kind] : [kind, sinceTs])).n);

  const dismissReasons = {
    'wrong-person': 0, 'wrong-time': 0, 'never-this-person': 0, 'not-this-kind': 0, 'not-useful': 0, none: 0,
  };
  const reasonRows = db.prepare(
    `SELECT reason, COUNT(*) AS n FROM rm_card_event WHERE kind = ? AND event = 'dismissed'${clause} GROUP BY reason`
  ).all(...(sinceTs === null ? [kind] : [kind, sinceTs]));
  for (const row of reasonRows) {
    const key = row.reason === null ? 'none' : row.reason;
    if (key in dismissReasons) dismissReasons[key] = Number(row.n);
  }

  return {
    shown, opened, accepted, dismissed, muted, suppressed, daysServed,
    // null (never a bare 0) when there was nothing to compute a rate over --
    // a 0% acceptance rate and "we haven't shown this kind yet" are different
    // facts, and collapsing them would misread as "shown, but never accepted".
    acceptRate: shown > 0 ? accepted / shown : null,
    openRate: shown > 0 ? opened / shown : null,
    dismissReasons,
    // Shares of DISMISSALS specifically (not of shown), null on zero
    // dismissed for the same reason acceptRate is null on zero shown.
    neverThisPersonShare: dismissed > 0 ? dismissReasons['never-this-person'] / dismissed : null,
    notUsefulShare: dismissed > 0 ? dismissReasons['not-useful'] / dismissed : null,
  };
}

// /stats.cards (L5 follow-on step 8): per-kind card outcomes, windowed and
// all-time, straight off rm_card_event -- the same append-only log the plan
// already calls "labeled input for a reviewed, versioned threshold change",
// never something this function retunes itself from. No verdict field:
// reading these numbers as a pass/fail is a human decision made elsewhere
// (the sealed Phase 0 gates artifact), not a computed field here.
export function cardStats(db, { now = Date.now(), windowDays = 56 } = {}) {
  const since = now - windowDays * DAY;
  const perKind = {};
  const allTime = {};
  for (const kind of CARD_STAT_KINDS) {
    perKind[kind] = kindStats(db, kind, since);
    allTime[kind] = kindStats(db, kind, null);
  }
  return { windowDays, since, perKind, allTime };
}
