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

## Existing system: wrap, do not fork

This experiment extends the memory and people primitives already in the repo.
It must not introduce a second review inbox, a second trust lifecycle, or a
fresh reconnect ranker beside the existing ones.

The seams to preserve are:

- `ui/server/people/resolve.mjs` already proposes conservative identity pairs,
  persists the owner's same/different decisions, excludes decided pairs from
  future proposals, and applies confirmed merges through a view-time alias map.
  Candidates remain questions; there is no automatic merge or row rewrite.
- `ui/server/people/profile.mjs` already defines an open loop as "they wrote
  last and the owner did not answer," uses message clocks only, and applies a
  seven-day minimum.
- `ui/server/people/rank.mjs` already provides deterministic reconnect scoring,
  per-candidate audit reasons, reachability checks, and filters for short codes,
  business senders, role addresses, and newsletter platforms. L5 wraps this
  ranker and may narrow its inputs; it does not replace it.
- `claim`, `claim_source`, `claim_decision`, and `distill_run` already provide
  immutable assertions, source snapshots and quotes, append-only owner/system
  decisions, and derivation metadata including `prompt_sha`.
- `ui/server/memory/validity.mjs` already computes advisory expiry for plans and
  commitments.
- `/admin/purge` and `/admin/delete-entities` already remove claims derived from
  deleted context, rebuild the FTS index, and physically clean deleted pages.
  Relationship claims must join this cascade rather than invent another one.

The schema decision is to extend the existing claim machinery for relationship
assertions. Broaden the owner-only `claim.subject` constraint to admit a
relationship subject and add a claim-to-person join for canonical person keys.
Keep `claim_source`, `distill_run`, and the append-only `claim_decision` as the
only trust lifecycle for both owner and relationship claims. The inbox is one
projection over that lifecycle. It must not persist a separate mutable
`trust_state`; the latest decision derives the state, as it does today.

Identity resolution remains the specialized graph constraint it already is,
not a model claim. It appears in the same inbox through an adapter over
`person_resolution`, while that table remains the authoritative store for
same/different decisions and view-time aliases. The adapter must not copy a
merge decision into relationship memory or create a second way to merge people.

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
  freshness_state
  validity_state
  standing_state
  summary
  evidence_refs[]
  observed_at
  valid_from?
  valid_until?
  recorded_at
  derivation_run_id
  producer_version
  proactive_policy
  muted_until?
  supersedes?

RelationshipMemoryDecision
  id
  item_id
  action
  decided_at
  decided_by
  reason?
```

`recorded_at` is immutable transaction time: when the system first persisted
the assertion. Each state transition is an append-only decision carrying
`decided_at` and `decided_by`. The current code's `claim.created_at`,
`claim_decision.created_at`, and `claim_decision.actor` already have these
semantics; the Relationship Memory API should name them explicitly rather than
adding duplicate columns. Together they must answer, "What did Intaglio believe
at the moment it showed this card?"

`derivation_run_id` points to the extractor or deterministic builder run.
`producer_version` identifies the code revision or ruleset that produced it.
For model-derived claims the existing `distill_run` supplies model, prompt path,
prompt hash, parameters, and run timestamps. Deterministic builders must record
an equivalent ruleset/code version so a result remains reproducible after an
upgrade.

Initial `kind` values:

- `owner_relationship_label`
- `explicit_commitment`
- `open_loop`
- `shared_context`
- `contradiction`

Identity merge review appears in the same inbox through the existing resolver
adapter, but it is not a relationship claim kind and never enters the claim
lifecycle.

The only decision actions are the existing append-only actions:

- `accept`
- `reject`
- `retract`

The API derives `trust_state` rather than storing it:

- `proposed`
- `accepted`
- `rejected`
- `retracted`

Initial `standing_state` values:

- `active`
- `superseded`
- `contradicted`

Initial `freshness_state` values:

- `current`
- `stale`
- `source_missing`

Initial `validity_state` values:

- `live`
- `expired`

Initial `proactive_policy` values:

- `never`
- `review_only`
- `eligible`

The summary is display text, not evidence. Evidence references are the authority.
Each evidence reference carries the existing pointer-plus-snapshot shape:
context id, source, entity id, exact quote, and content hash.
The initial implementation treats the flat `evidence_refs[]` as one
justification set and deliberately over-invalidates: deletion of any member
invalidates the item. This matches the existing privacy-first claim cascade.
Independent evidence should land as a separate item rather than be folded into
one belief. A future truth-maintenance layer may support alternative
justification groups, but privacy deletion must not wait for it.

## L5 handoff

The handoff from memory to proactive behavior is explicit:

```text
evidence
  -> proposed relationship memory
  -> owner acceptance
  -> eligible for assistance
  -> L5 candidate
  -> evidence and freshness recheck
  -> suppression, quiet-hours, frequency, cooldown, and dedupe gates
  -> immutable candidate snapshot
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

Every card attempt records an immutable candidate snapshot containing the item
and decision revisions it read, deterministic inputs, coverage/freshness
verdicts, derivation version, gate outcomes, and transaction time. This is the
audit record for what the system believed and why it acted at that moment. It
contains references and rule results, not copied source text.

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
- the item is live rather than expired;
- each required source is fresh according to the existing watchdog verdict;
- the observed source window spans the entire dormancy period named by the
  card;
- the person is not on the permanent suppress list;
- the person, suggestion kind, or person-and-kind pair is not muted;
- the current time is outside quiet hours;
- the candidate is not inside a cooldown window;
- the global card cap across all suggestion kinds has not been reached;
- and the same evidence has not already produced a dismissed or completed card.

Coverage is a hard gate, not a disclaimer. The iMessage connector begins with
a bounded backfill, WhatsApp's local store can freeze while connector runs keep
succeeding, and LinkedIn refreshes only when a new export arrives. A card may
not say "you have not messaged this person since X" unless the source window
actually reaches X and the correct row/run freshness signal is healthy. When
coverage is insufficient, the candidate is blocked; the copy must not weaken
the claim with "probably" or reinterpret missing data as dormancy.

The suggestion may open the relevant context or prepare a next step for the
owner. It must not send a message or change a calendar.

## Suppression, dismissal, and frequency

The first release includes a permanent, one-tap **never this person** control.
It is separate from temporary mute, applies across every proactive card kind,
and is checked before candidate ranking as well as immediately before display.
The owner can reverse it only from Relationship Memory settings; a new source
or identity merge must not silently clear it.

Mute has three explicit scopes: person, suggestion kind, and person-plus-kind.
Every mute action states its scope and duration on the card before it is
committed. A global card cap limits all proactive card kinds together; per-card
cooldowns alone are insufficient because multiple kinds can otherwise take
turns interrupting the owner.

A dismissal asks for an optional one-tap reason:

- wrong person;
- wrong time;
- never this person;
- do not make this kind of suggestion; or
- not useful.

From day one, log shown, opened, accepted, dismissed, muted, and suppressed
outcomes by person key, suggestion kind, local time band, and candidate rule
version. These are local product events without source text. The experiment
does not silently retune itself from them; they become labeled input for a
reviewed, versioned threshold change after evaluation.

The opt-in screen names the enabled sources, the global maximum frequency, the
available per-source suggestion toggles, and known blind spots. It must explain
that absence in connected data is not proof of distance and that Intaglio
cannot observe in-person contact or channels the owner did not connect.

## Orb behavior

The orb is the first proactive surface. Relationship Memory is the audit and
control surface behind it, not a requirement for a new primary destination.

The orb communicates three distinct states:

- **Review:** a people-memory item needs confirmation.
- **Useful now:** a trusted, timely L5 suggestion is available.
- **Conflict:** existing relationship memory may be outdated.

The orb's primary click already belongs to voice tap-to-arm (currently replaced
by a shipping tease behind one constant), so L5 must not silently take that
gesture. Proactive state uses a badge and hue without changing the orb's
silhouette: shape is the existing armed/idle signal. Clicking the accessible
badge or the associated thought-bubble affordance opens one contextual card;
clicking the orb retains its voice behavior. The complete Relationship Memory
view can be added later as a secondary history and control center.

Each proactive state has a still, non-motion equivalent. With Reduce Motion,
the badge, hue, text label, and focus state carry the meaning; animation is
never the only signal.

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

Use a sealed evaluation list and a four-arm ablation:

1. fixed interval;
2. messages only;
3. calendar only; and
4. the full messages-plus-calendar join.

Phase 0 establishes numerical baselines. Before shadow mode begins, commit a
versioned promotion-gates artifact that fixes the evaluation set, thresholds,
measurement windows, and decision rules. The full join must beat the
messages-only arm on the preselected utility measure or the calendar join is
removed rather than defended after the result.

### Phase 1: shadow mode

Build candidates and apply every gate, but show nothing to the owner. Measure
candidate frequency, repeat rate, coverage/freshness rejection, global-cap
pressure, and gate rejection reasons. Freeze the Phase 0 gates during the
measurement window; tuning creates a new version and a new window.

### Phase 2: in-app orb cards

Expose the experiment behind an explicit opt-in. Show only when the app is open.
Every card includes dismiss, mute, and evidence controls. Do not use operating
system notifications. Promotion requires the pre-registered gates to pass and
zero occurrences of the hard stop conditions below.

### Phase 3: notification consideration

Consider generic operating system notifications only after the in-app cards
demonstrate low repeat rates and trustworthy timing. Notification text must not
contain a person's name, relationship detail, or source content on the lock
screen. Track a twelve-week dismissal-decay curve before this phase so nag
fatigue is measured rather than inferred from an early novelty period.

### Promotion-gate contract

The experiment pre-registers decision rules without fabricating target numbers:

- which sealed examples and ablation arms are evaluated;
- the primary utility, dismissal, repeat, and coverage-failure measures;
- the direction and minimum improvement required from each phase;
- the maximum global frequency and cooldown policy;
- the measurement window and twelve-week dismissal-decay test; and
- the absolute safety stops that cannot be averaged away.

Phase 0 fills the numerical thresholds from a baseline. The artifact is frozen
before Phase 1 and reviewed as a code change if it moves. A phase does not
promote on anecdotal usefulness, aggregate volume, or a post-hoc metric.

## Initial experiment boundary

The first version of the unified Relationship Memory inbox supports only:

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
- a permanently suppressed person produces any candidate or card;
- source coverage does not span the dormancy claim shown to the owner;
- a notification exposes relationship information outside the app; or
- the product cannot explain a card using current local evidence.

No fabricated target metrics are attached to this plan. Baselines and thresholds
must come from the sealed Phase 0 evaluation and be frozen before shadow mode.

## Implementation order

1. Wrap the existing identity, open-loop, ranker, claim, decision, validity,
   watchdog, and deletion primitives behind one Relationship Memory service.
2. Extend the claim subject/person schema without introducing a second trust
   lifecycle; add transaction-time and producer-version names to its API.
3. Wire relationship claims into the existing source-deletion cascade and
   deterministic receipt renderer.
4. Add permanent person suppression, scoped mute, structured dismissal reasons,
   and the global frequency cap.
5. Add the three initial experiment categories and their unified review controls.
6. Build the reconnect candidate adapter around the existing ranker, with hard
   source-window and watchdog coverage gates.
7. Persist immutable candidate snapshots and local outcome events.
8. Run the sealed Phase 0 ablation and commit numerical promotion gates.
9. Run shadow mode without moving the gates.
10. Add accessible badge/hue orb states and the separate one-card affordance.
11. Review the pre-registered measurements before considering notifications.

This order deliberately makes trust, correction, and deletion work before the
system is allowed to become proactive.
