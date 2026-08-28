# L5 Relationship Memory experiment

Status: plan only; nothing in this document is shipped.

This branch is an explicit exception to the repository's normal rule against
checking in experiment plans. It exists so the L5 memory experiment can be
reviewed publicly without mixing the experiment into a shipping branch.

## Outcome

Give Intaglio a safe way to help the owner maintain relationships without
building dossiers about other people or turning uncertain model output into
proactive advice.

The experiment has two separate layers:

1. **Relationship Memory** is the trust and control plane. It shows what
   Intaglio noticed, the evidence behind it, whether the owner accepted it,
   and whether it is still current.
2. **L5** is the delivery and decision plane. It decides whether an accepted
   memory or deterministic observation is useful enough to surface now.

Relationship Memory decides what may be trusted. L5 decides when to speak.

## Product principles

- Frame every item as something about the owner's relationship or interaction,
  never as a profile of another person.
- Preserve receipts. Every learned item must point to its source and date.
- Prefer deterministic observations over generated claims.
- Let the owner name relationship roles; the system must not infer intimacy,
  motives, personality, health, politics, sexuality, or other sensitive traits.
- Pending, stale, rejected, or contradictory memory must never produce advice.
- Deleting a source must delete or invalidate memory derived from that source.
- The system may suggest an action, but must not send a message, create an
  event, or otherwise act as the owner.
- Keep all processing and state local, consistent with the product's existing
  privacy boundary.

## What belongs in Relationship Memory

An item belongs only when all of the following are true:

1. It resolves to one or more canonical people.
2. It describes the owner's relationship, interaction, commitment, or shared
   context with those people.
3. It helps the owner find, understand, maintain, or reconnect with the
   relationship.
4. It has exact supporting evidence or a reproducible deterministic derivation.
5. It has an explicit trust state and freshness state.
6. The owner can correct, dismiss, mute, or delete it.

Examples that qualify:

- The owner explicitly said they would send a person a document.
- A direct-message thread has an unanswered incoming message.
- Two source identities may refer to the same person and need merge review.
- The owner explicitly labels someone as a friend, relative, or colleague.
- An accepted commitment now conflicts with newer evidence.

Examples that do not qualify:

- A generated personality assessment.
- An inferred relationship role or closeness score.
- A sensitive trait inferred from messages, photos, or activity.
- A claim about a person's intentions or emotional state.
- Group activity treated as evidence about one participant.
- A relationship summary with no inspectable receipt.

## Memory inbox

The user-facing name is **Relationship Memory**. Its inbox is organized around
decisions the owner can make rather than around a generic database lifecycle.

### Needs your confirmation

Identity merges, owner-assigned relationship labels, ambiguous commitments,
and other proposed memories. Each item offers accept, correct, dismiss, and
mute controls.

### Newly noticed

Evidence-backed observations that have not yet required a decision. This is
where the owner can see what the system recently learned before it becomes
eligible for proactive use.

### Changed or conflicting

New evidence that contradicts an accepted memory, identity, role, or
commitment. Conflicted items are blocked from proactive use until resolved.

### Ready to help

Accepted, current memories and safe deterministic observations that may inform
retrieval or an L5 suggestion. Being in this section is necessary but not
sufficient for a notification.

### Retired or invalidated

Rejected, superseded, stale, source-deleted, and manually retired memories.
These remain visible only as much as needed to explain system behavior and
must not retain source content after its deletion.

### People coverage

Shows which sources and date ranges were read. Coverage is an ingestion fact,
not a relationship-quality score: sparse correspondence must never be presented
as evidence of a weak relationship.

## Item contract

Every Relationship Memory item must carry enough state to be reviewed and
reproduced:

```text
RelationshipMemoryItem
  id
  person_keys[]
  kind
  trust_state
  freshness_state
  summary
  evidence_refs[]
  observed_at
  valid_from?
  valid_until?
  source_fingerprint
  proactive_policy
  muted_until?
  supersedes?
```

Initial `kind` values:

- `identity_merge`
- `owner_relationship_label`
- `explicit_commitment`
- `open_loop`
- `shared_context`
- `contradiction`

Initial `trust_state` values:

- `proposed`
- `accepted`
- `rejected`
- `superseded`
- `contradicted`

Initial `freshness_state` values:

- `current`
- `stale`
- `source_missing`

Initial `proactive_policy` values:

- `never`
- `review_only`
- `eligible`

The summary is display text, not evidence. Evidence references are the authority.

## L5 handoff

The handoff from memory to proactive behavior is explicit:

```text
evidence
  -> proposed relationship memory
  -> owner acceptance
  -> eligible for assistance
  -> L5 candidate
  -> evidence and freshness recheck
  -> quiet-hours, mute, cooldown, and dedupe gates
  -> orb indication
  -> contextual card
  -> owner action
```

There are two permitted inputs to the L5 candidate builder:

1. Accepted, current Relationship Memory with `proactive_policy = eligible`.
2. A deterministic observation that is reproducible from current source data,
   such as direct-message recency or an unanswered incoming message.

Generated summaries, proposed memories, inferred relationship roles, and
conflicted or stale items are not permitted inputs.

## First proactive moment

The first experiment is an opt-in reconnect suggestion. It joins only:

- owner-sent direct-message recency;
- whether the other person wrote last; and
- calendar free/busy availability.

It does not use raw message text, health, mail, photos, notes, files, group
messages, generated person summaries, or inferred relationship importance.

The candidate builder is deterministic. Before anything is shown it must
recheck:

- the source evidence still exists;
- the observation is fresh;
- the person or suggestion type is not muted;
- the current time is outside quiet hours;
- the candidate is not inside a cooldown window; and
- the same evidence has not already produced a dismissed or completed card.

The suggestion may open the relevant context or prepare a next step for the
owner. It must not send a message or change a calendar.

## Orb behavior

The orb is the first proactive surface. Relationship Memory is the audit and
control surface behind it, not a requirement for a new primary destination.

The orb communicates three distinct states:

- **Review:** a people-memory item needs confirmation.
- **Useful now:** a trusted, timely L5 suggestion is available.
- **Conflict:** existing relationship memory may be outdated.

Clicking the orb opens one contextual card with its reason and receipt. It does
not initially open a large inbox. The complete Relationship Memory view can be
added later as a secondary history and control center.

An L5 card must answer:

- Why am I seeing this now?
- Which person or relationship is involved?
- What evidence was used?
- Is this an observation or an accepted memory?
- How do I dismiss, mute, correct, or inspect it?

## Rollout

### Phase 0: offline evaluation

Run the deterministic candidate builder over a bounded local history. Record
only candidate metadata and rule outcomes, never source text. Manually inspect
receipts on the same machine.

### Phase 1: shadow mode

Build candidates and apply every gate, but show nothing to the owner. Measure
candidate frequency, repeat rate, source freshness, and gate rejection reasons.

### Phase 2: in-app orb cards

Expose the experiment behind an explicit opt-in. Show only when the app is open.
Every card includes dismiss, mute, and evidence controls. Do not use operating
system notifications.

### Phase 3: notification consideration

Consider generic operating system notifications only after the in-app cards
demonstrate low repeat rates and trustworthy timing. Notification text must not
contain a person's name, relationship detail, or source content on the lock
screen.

## Initial experiment boundary

The first version of Relationship Memory supports only:

1. identity and merge confirmation;
2. explicit owner commitments involving another person; and
3. deterministic open-loop or reconnect opportunities.

Everything else remains retrieval-only or out of scope. In particular, existing
generated people summaries remain excluded from memory eligibility and L5
candidate generation.

## Success and stop conditions

The experiment is worth continuing when the owner can consistently understand
why an item appeared, verify its receipt, and act on suggestions without feeling
watched or mischaracterized.

Stop or narrow the experiment if any of the following occurs:

- a suggestion relies on unaccepted or contradicted memory;
- the system characterizes a third party beyond the owner's direct evidence;
- source deletion fails to invalidate derived memory;
- repeated suggestions survive dismissal, mute, or cooldown gates;
- a notification exposes relationship information outside the app; or
- the product cannot explain a card using current local evidence.

No fabricated target metrics are attached to this plan. Baselines and thresholds
must come from shadow-mode measurements before rollout decisions are made.

## Implementation order

1. Define the Relationship Memory item schema and state transitions.
2. Implement source-linked invalidation and deterministic receipt rendering.
3. Add the three initial memory kinds and their review controls.
4. Implement the reconnect candidate builder without model generation.
5. Add freshness, quiet-hours, mute, cooldown, and dedupe gates.
6. Run offline evaluation, then shadow mode.
7. Add the three orb states and one-card interaction.
8. Review measured behavior before considering operating system notifications.

This order deliberately makes trust, correction, and deletion work before the
system is allowed to become proactive.
