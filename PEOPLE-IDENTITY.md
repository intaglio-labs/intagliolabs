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
- `person_activity`: monthly, per-source message, room, calendar, and Granola
  totals.
- `person_channels` and `person_active_days`: prepared provenance and streak
  inputs used by existing People views.

Context triggers advance a projection revision for participant-source inserts,
updates, and deletes. Search reads the prepared graph while the revision,
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
