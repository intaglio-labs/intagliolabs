// The reconnect candidate adapter (L5 step 6): the first thing in this tree
// allowed to SUGGEST, and it earns that by walking through every gate built
// before it. It wraps the step-1 rank registry -- the 'fixed-interval'
// control strategy, kept deliberately dumb because the Phase 0 ablation's
// cadence-ratio ranking lost to it -- and adds the two hard gates the plan
// names for this step: the source-window gate and the watchdog coverage gate,
// both asked through service.coverage().spansDormancy().
//
// kind 'reconnect' extends the item contract's initial kind list, which names
// the category ("deterministic open-loop or reconnect opportunities") but
// enumerates only open_loop; the kind vocabulary is the service's to own (the
// schema's kind columns are unchecked for exactly this reason), and an
// unanswered message and a mutual drift are different claims needing
// different receipts.
//
// No candidate text, ever: evidence is counted facts and dates, the
// evidenceLine discipline. And no invented thresholds: the defaults live on
// the fixed-interval strategy itself -- the pre-registered Phase 0 control
// rules -- and the promotion-gates artifact overrides them when it exists.

// Channels whose rows could show the relationship is NOT dormant, intersected
// with what the watchdog can vouch fresh. Shared with the open-loop category:
// both make silence claims, and a silence claim needs a provably-live pipe.
export const VOUCHABLE_CHANNELS = Object.freeze(['imessage', 'mail', 'whatsapp']);

export const RECONNECT_RULES_VERSION = 'rm-reconnect-v1';

export function reconnectAdapter({ intervalDays, minMessages, limit = 15 } = {}) {
  return {
    name: 'reconnect-messages',
    candidates(service, { now = Date.now() } = {}) {
      const coverage = service.coverage({ now });
      const rankOpts = { now };
      if (intervalDays !== undefined) rankOpts.intervalDays = intervalDays;
      if (minMessages !== undefined) rankOpts.minMessages = minMessages;

      // Suppression and mute are checked BEFORE ranking, the plan's first
      // call site for the gate; the display surface asks allowCard() again
      // (with the cap) immediately before showing anything.
      const eligible = service.people({ now }).filter((p) =>
        !service.controls.isSuppressed(p.key) &&
        !service.controls.isMuted({ personKey: p.key, kind: 'reconnect', now }));

      const out = [];
      for (const p of service.rank('fixed-interval', eligible, rankOpts)) {
        if (out.length >= limit) break;
        // THE HARD GATES. The claim on the card is "quiet for N days", and
        // every channel that could have disproven it must be watchdog-fresh
        // AND ingested across the whole window. A person reachable only on
        // channels nothing can vouch for produces no claim at all --
        // over-invalidation is the plan's chosen failure mode, and "source
        // coverage does not span the dormancy claim shown to the owner" is a
        // hard stop.
        const channels = (p.channels ?? []).filter((ch) => VOUCHABLE_CHANNELS.includes(ch));
        if (channels.length === 0) continue;
        if (!channels.every((ch) => coverage.spansDormancy(ch, p.dormancyDays))) continue;
        out.push({
          personKey: p.key,
          kind: 'reconnect',
          summary: `${p.name} — quiet for ${p.dormancyDays} days after ${p.messages} messages`,
          evidence: {
            dormancyDays: p.dormancyDays,
            messages: p.messages,
            channels,
            relationshipDays: p.relationshipDays,
          },
          producer_version: RECONNECT_RULES_VERSION,
          rank_strategy: 'fixed-interval',
        });
      }
      return out;
    },
  };
}
