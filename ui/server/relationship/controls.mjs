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
    recordEvent({ personKey, kind, event, reason = null, note = null, ruleVersion, snapshotId = null, now = Date.now() }) {
      if (event === 'dismissed' && reason !== null && !DISMISS_REASONS.includes(reason)) {
        throw new Error(`dismissal reason must be one of: ${DISMISS_REASONS.join(', ')}`);
      }
      if (event !== 'dismissed' && reason !== null) {
        throw new Error('only a dismissal carries a reason');
      }
      db.prepare(
        'INSERT INTO rm_card_event(person_key, kind, event, reason, note, rule_version, snapshot_id, time_band, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(requireKey(personKey, 'personKey'), requireKey(kind, 'kind'), event, reason,
        note === null ? null : String(note).slice(0, 500),
        requireKey(ruleVersion, 'ruleVersion'), snapshotId, timeBand(now), now);
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
    underGlobalCap({ max, windowMs, now = Date.now() } = {}) {
      if (!Number.isInteger(max) || max < 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
        return false; // fail closed: an unconfigured cap caps at zero
      }
      const n = Number(db.prepare(
        "SELECT COUNT(*) AS n FROM rm_card_event WHERE event = 'shown' AND created_at > ?"
      ).get(now - windowMs).n);
      return n < max;
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
