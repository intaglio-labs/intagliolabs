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
    dismiss({ personKey, kind, reason = null, note = null, ruleVersion, snapshotId = null, now = Date.now() }) {
      db.exec('BEGIN');
      try {
        this.recordEvent({ personKey, kind, event: 'dismissed', reason, note, ruleVersion, snapshotId, now });
        if (reason === 'never-this-person') this.suppress(personKey, now);
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
  };
}
