// The reconciliation floor.
//
// Reconciliation is the most dangerous code in this package: it is the only
// path that DELETES the owner's rows, and deleting a row takes every claim
// derived from it — including ones the owner reviewed and accepted — because
// hermes invalidates on entity removal.
//
// It works by difference: whatever the scan did not observe is assumed gone
// from the source and is deleted. That inference is only as good as the scan,
// and a scan can come back empty while being entirely successful:
//
//   - an API returns an empty page after a token expiry that surfaced as 200
//   - a filter change excludes everything (the `selected` default, a window
//     computed in the wrong timezone)
//   - a calendar the owner unshared returns nothing rather than an error
//   - two processes hold different config and each sees the other's rows as
//     unobserved
//
// In every one of those the old code deleted the entire window and logged it
// as a successful cleanup. Nothing distinguished "the source is empty" from
// "I could not see the source", because at the point of the diff those look
// identical.
//
// So: a scan that observed NOTHING may not delete ANYTHING. It has no evidence.
// And a scan that would remove most of what it holds is refused too, because a
// poll is an incremental operation and a mass deletion is not something a poll
// should ever decide on its own. Both refusals are loud, and the deliberate
// escape hatch already exists — `run.mjs --purge`, which a human runs on
// purpose.
//
// The failure mode this ACCEPTS, stated plainly: if the owner really did clear
// a calendar, the rows linger until someone purges. That is recoverable. A
// silent mass delete of accepted claims is not.

// Below this many held entities the ratio test is meaningless — deleting 3 of
// 4 is ordinary churn in a small window, not an anomaly.
const RATIO_FLOOR_MIN_HELD = 20;
// Above this share, a single poll is claiming most of the window disappeared.
const RATIO_FLOOR_MAX_SHARE = 0.5;

/**
 * Decide what a reconciliation pass is allowed to delete.
 *
 * @param {Set<string>|string[]} observedIds  entity ids the scan actually saw
 * @param {{entity_id: string}[]} held        entities hermes holds in the window
 * @returns {{stale: string[], refuse: string|null}}
 *   `stale` is what differs; `refuse` is null when the delete may proceed, or a
 *   short reason to log when it may not. Callers MUST check `refuse` — the
 *   stale list is returned either way so it can be reported.
 */
export function planReconcile({ observedIds, held }) {
  const observed = observedIds instanceof Set ? observedIds : new Set(observedIds);
  const list = Array.isArray(held) ? held : [];
  const stale = list.filter((e) => !observed.has(e.entity_id)).map((e) => e.entity_id);

  if (stale.length === 0) return { stale, refuse: null };

  // The important one. A scan that saw nothing has not proved the source is
  // empty; it has only proved that it saw nothing.
  if (observed.size === 0) {
    return { stale, refuse: `scan observed 0 entities while hermes holds ${list.length}` };
  }

  if (list.length >= RATIO_FLOOR_MIN_HELD && stale.length / list.length > RATIO_FLOOR_MAX_SHARE) {
    return {
      stale,
      refuse: `${stale.length} of ${list.length} held entities would be deleted in one poll`,
    };
  }

  return { stale, refuse: null };
}
