// The Relationship Memory inbox (L5 step 5): the three initial experiment
// categories behind ONE review door. Everything else in the plan's boundary
// section stays out of scope, and each category keeps the lifecycle it
// already had -- the door unifies review, it does not unify trust:
//
//   identity_merge       -> the resolver adapter (people/resolve.mjs). The
//                           plan is explicit that merge review "is not a
//                           relationship claim kind and never enters the
//                           claim lifecycle".
//   explicit_commitment  -> pending person-subject commitment claims, decided
//                           through claim_decision like every claim.
//   open_loop            -> pure arithmetic (profile.mjs openLoop) computed
//                           at read time. Not persisted: an open loop is a
//                           fact about two clocks, and storing it would just
//                           create a copy that can drift from the clocks.
//
// Suppression filters EVERY category -- "a permanently suppressed person
// produces any candidate or card" is a hard stop condition, and the inbox is
// where a candidate first becomes visible. Mute, by contrast, quiets
// suggestions, not review: a muted person's commitment still needs deciding.

import { pendingClaims, decideClaim } from '../hermes.mjs';
import { openLoop } from '../people/profile.mjs';
import { VOUCHABLE_CHANNELS } from './reconnect.mjs';

// The deterministic builder's version, recorded on every item it computes --
// the item contract requires a producer version so a result stays
// reproducible after an upgrade. Bump on any change to the rules below.
export const INBOX_RULES_VERSION = 'rm-inbox-v1';

// pairId() joins its two keys with NUL, a character no person key contains.
const PAIR_SEP = '\u0000';

// An open loop claims "you have not answered" -- if any channel this person
// uses cannot be vouched fresh across the waiting window, the claim is not
// coverable and the item is dropped. Over-invalidation is the plan's chosen
// failure mode. The channel list lives with the reconnect adapter: both
// categories make silence claims, and two lists is how they drift.
const LOOP_CHANNELS = VOUCHABLE_CHANNELS;

// `limit` is PER CATEGORY, not global. The first shadow run over the real
// corpus proved why: a 40-item global budget was consumed entirely by the
// identity-merge backlog before the open-loop section ran, and loops read as
// "none" when the truth was "starved". A category's volume must never decide
// whether another category is visible.
export function buildInbox(service, { now = Date.now(), limit = 40 } = {}) {
  const items = [];
  const gate = (personKey) => !service.controls.isSuppressed(personKey);
  const catStart = () => items.length;

  // -- identity and merge confirmation ------------------------------------
  for (const pair of service.identity.pending({ now, limit }).pairs) {
    if (items.length >= limit) break;
    if (!gate(pair.a.key) || !gate(pair.b.key)) continue;
    items.push({
      id: `merge:${pair.pairId}`,
      kind: 'identity_merge',
      person_keys: [pair.a.key, pair.b.key].sort(),
      summary: `Same person? (${pair.reason})`,
      producer_version: INBOX_RULES_VERSION,
      actions: ['same', 'different'],
    });
  }

  // -- explicit owner commitments involving another person -----------------
  // claim.kind stays hermes' vocabulary ('commitment'); the INBOX kind is the
  // item contract's ('explicit_commitment'). The receipt renderer carries the
  // evidence; the inbox only decides membership.
  const claimStart = catStart();
  for (const c of pendingClaims(service.db(), { limit }).claims) {
    if (items.length - claimStart >= limit) break;
    if (c.subject !== 'person' || c.kind !== 'commitment') continue;
    if (!gate(c.subject_person_key)) continue;
    items.push({
      id: `claim:${c.id}`,
      kind: 'explicit_commitment',
      person_keys: [c.subject_person_key],
      summary: c.text,
      receipt: service.receiptFor(c.id, { now }),
      producer_version: c.producer_version,
      actions: ['accept', 'reject'],
    });
  }

  // -- deterministic open loops --------------------------------------------
  // Suggestion-shaped, so mute applies here as well as suppression, and the
  // coverage gate must span the dormancy claim before the claim is made.
  const coverage = service.coverage({ now });
  const loopStart = catStart();
  for (const p of service.people({ now })) {
    if (items.length - loopStart >= limit) break;
    const loop = openLoop(p, { now });
    if (loop === null) continue;
    if (!gate(p.key)) continue;
    if (service.controls.isMuted({ personKey: p.key, kind: 'open_loop', now })) continue;
    const channels = (p.channels ?? []).filter((ch) => LOOP_CHANNELS.includes(ch));
    if (channels.length === 0) continue; // no coverable channel: nothing honest to claim
    if (!channels.every((ch) => coverage.spansDormancy(ch, loop.waitingDays))) continue;
    items.push({
      id: `loop:${p.key}`,
      kind: 'open_loop',
      person_keys: [p.key],
      // Counted facts only, the evidenceLine discipline: no message text.
      summary: `${p.name} wrote last, unanswered for ${loop.waitingDays} days`,
      evidence: { waitingDays: loop.waitingDays, channels, messages: p.messages },
      producer_version: INBOX_RULES_VERSION,
      actions: ['dismiss', 'mute'],
    });
  }

  return items;
}

// The unified review door: one entry point, three existing lifecycles, none
// invented here. The id says which lifecycle owns the item.
export function reviewItem(service, itemId, { action, reason = null, untilAt = null, now = Date.now() } = {}) {
  if (typeof itemId !== 'string') throw new Error('itemId must be a string');
  const sep = itemId.indexOf(':');
  const prefix = sep === -1 ? itemId : itemId.slice(0, sep);
  const ref = sep === -1 ? '' : itemId.slice(sep + 1);

  if (prefix === 'merge') {
    if (action !== 'same' && action !== 'different') {
      throw new Error("an identity item accepts 'same' or 'different'");
    }
    const [a, b] = ref.split(PAIR_SEP);
    if (!a || !b) throw new Error('malformed merge item id');
    return service.identity.decide(a, b, action, now);
  }

  if (prefix === 'claim') {
    if (!['accept', 'reject', 'retract'].includes(action)) {
      throw new Error("a claim item accepts 'accept', 'reject' or 'retract'");
    }
    return decideClaim(service.db(), { claim_id: Number(ref), action, ...(reason ? { reason } : {}) });
  }

  if (prefix === 'loop') {
    if (action === 'dismiss') {
      return service.controls.dismiss({ personKey: ref, kind: 'open_loop', reason,
        ruleVersion: INBOX_RULES_VERSION, now });
    }
    if (action === 'mute') {
      service.controls.mute({ personKey: ref, kind: 'open_loop', untilAt, now });
      return service.controls.recordEvent({ personKey: ref, kind: 'open_loop', event: 'muted',
        ruleVersion: INBOX_RULES_VERSION, now });
    }
    throw new Error("an open-loop item accepts 'dismiss' or 'mute'");
  }

  throw new Error(`unknown inbox item id shape: ${prefix}`);
}
