# Unified people identity

Implementation status (2026-08-28): identity spine v2 and the Hermes-owned
materialized people projection are implemented. Every Hermes source has an
explicit identity policy, stable Address Book card membership joins multiple
phones and email addresses, Granola retains structured participants, and
owner-confirmed merges are applied consistently to People, ordinary person
search, and deep search.

## Resolution order

Identity is conservative and local. A model never decides whether two people
are the same.

1. An exact normalized phone or email resolves through the Contacts spine.
2. Every identifier on one Address Book card shares one opaque `person_ref`.
3. An exact name may join a connector participant to a Contact card only when
   that name belongs to exactly one card.
4. A provider identifier remains scoped by the connector that supplied it.
5. Uncertain pairs stay split until the owner confirms `same` in the People
   review flow.
6. Confirmed aliases are applied before aggregation on every search surface.

Existing unique-name graph keys remain stable so saved roles and merge decisions
survive the migration. Opaque Contact keys are used only when two distinct
cards have the same display name.

## Multiple email addresses

The Contacts connector keeps the stable membership of a card instead of
flattening it to repeated display names. Given one card with a phone and three
addresses, messages to any of the four identifiers resolve to one graph person.
Successful full-access scans atomically replace the Contacts-owned snapshot, so
an address removed from a card stops resolving to that person. Limited-access
and partial store reads only upsert visible rows because absence is not proof of
deletion in those modes.

Calendar, mail, LinkedIn, and Granola use exact email values to enter the same
spine. Addresses not present on a Contact card remain separate unless another
hard identifier connects them or the owner confirms a merge. Shared or role
addresses are never merged merely because their local parts resemble a name.

## Source policy

- Participant sources: iMessage, Calendar, Mail, Granola, LinkedIn, WhatsApp,
  Messenger, Instagram, Twitter, Telegram, Discord, and Slack.
- Content-only sources: Notes, Files, and Notion. They can contribute retrieved
  context about an already-resolved person, but prose alone cannot mint one.
- Non-person sources: Health, Photos, generated digests, and seed fixtures.

The policy is tested against Hermes' closed source registry. Adding a connector
without choosing its identity behavior fails the test instead of silently
omitting it from the people graph.

## Granola

Granola now stores a sorted `participants` array with name, email, and provider
ID when the API supplies them. Email is preferred for resolution, then provider
ID. Name-only attendees join an unambiguous Contact card; otherwise they remain
meeting-scoped so two unrelated people with the same name are not silently
merged. Meeting notes count as their own relationship evidence, not as direct
messages or fabricated in-person calendar attendance.

## Consistency and cache safety

The widget ask path loads the same owner-confirmed alias map as People pages.
Search APIs accept that map and pass it through every graph build. People cache
keys contain a SHA-256 fingerprint of the actual sorted alias map rather than
only its size, so replacing one merge with another invalidates cached results.

## Materialized people projection

Raw connector observations remain in `context`; they are still the evidence and
are never rewritten into a new source of truth. Hermes maintains these
rebuildable tables beside them:

- `people`: one current canonical row per relationship person.
- `person_identifiers`: every known phone, email, and connector identifier for
  that person, including unused identifiers from the same active Contact card.
- `identity_evidence`: the reason, source, and confidence for every connection, including
  same-card membership, exact identifiers, unambiguous exact names, and owner
  confirmation.
- `person_event_links`: structural links from a canonical person to a raw
  context row, including participant role, authorship, room/direct status,
  conversation key, and identity confidence. It references the corpus row and
  never copies message or meeting text.
- `person_activity`: monthly, per-source message, room, calendar, and Granola
  totals.
- `person_channels` and `person_active_days`: prepared provenance and streak
  inputs used by existing People views.

Context triggers advance a projection revision for participant-source inserts,
updates, and deletes and record the changed context IDs plus their previous
person membership. When identity configuration is unchanged, refresh reparses
only those rows and rebuilds only affected people and event links. A new or
unresolved identifier, changed Contacts/merge configuration, day boundary, or
forced refresh deliberately falls back to the conservative full rebuild.
Search reads the prepared graph while the revision,
Contacts fingerprint, owner settings, merge fingerprint, and local day match.
After an ingest stream goes quiet Hermes refreshes in the background; the first
reader after any other change refreshes once. Custom timeframe graphs still use
the raw builder because they are different aggregates, not filters over lifetime
totals. If projection refresh fails, the raw deterministic builder remains the
correct fallback.

Retention and purge clear the derived projection in the same transaction as a
participant-source deletion, so private identifiers or activity cannot survive
there until a later search. The next reader rebuilds from the remaining raw
evidence. Contacts has no corpus source, so its explicit connector purge calls
the bearer-only `/admin/people/clear` route before deleting local Contacts state;
names and identifiers therefore do not remain in the projection after the
source spine is removed.

## Rebuild and migration

The new `person_ref` column is nullable and added in place. Existing state is
readable before Contacts runs again. Projection tables are created idempotently
when Hermes opens its database and begin stale, so their first read safely
backfills them. The next Contacts scan fills opaque card references, and the
next Granola scan adds structured participants through normal Hermes upserts.
No corpus row is rewritten outside Hermes, and owner resolution decisions remain
durable ground truth.

## Deep people search

Deep search now reads the materialized person/event links instead of resolving
every connector row again for every question. The existing local FTS index
recalls candidate messages, and the links attribute each hit to one canonical
person. All evidence-based people-selection questions use one general local-only
path; there are no question-specific handlers for investor/place/time,
school/employment, Italy/travel, or other topics.

A constrained first pass translates the question into a closed plan: required
facets with synonym terms, message/profile/calendar scope, authorship requirements,
time bounds, repetition requirements, reachability, and ranking intent. It also
receives explicit owner-profile schools so “my high school” resolves from
configuration rather than a guess. Code validates the plan and retrieves at
most a bounded set of canonical people and linked rows. A constrained second
local pass judges only that supplied evidence and may return only supplied
person IDs with evidence IDs belonging to the same person. A third constrained
local pass independently verifies entailment and contradiction. Code rejects
unknown IDs, cross-person citations, incomplete required facets,
insufficient/repeated evidence, contradictions, and low-confidence identity
links before formatting the answer.

Authorship stays structural: recipients, CCs, owner-authored messages, and
meeting participants cannot become the other person's statement by association.
Repeated history is enforced as separate occasions rather than left to the
judge's preference. Results carry structured facts with source, timestamp, a
fixed safe reason, and confidence capped by the weakest cited identity link.
Neither raw corpus prose nor a model-generated paraphrase enters the widget
payload. If the projection cannot refresh,
search reports a temporary local-index failure instead of joining current
people to stale evidence.

All three model calls use the configured loopback llama-server with redirects
disabled. The planning call sees only the question and explicit owner-profile
context, never corpus rows. Corpus snippets reach only the local
evidence-judgment and verification calls and are never logged, persisted as a
derived claim, or returned to the widget. Warm-introduction traversal and
explicit reconnect/relationship-health ranking remain deterministic because
they are graph operations rather than topical evidence searches.
