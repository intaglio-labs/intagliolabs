# Probes — measured facts the connectors depend on

Every connector that reads an Apple or third-party local store rests on facts
about that store's schema and units. Those facts are **measured, not assumed**,
by the scripts in `ops/probes/`, and the decisions they settle are recorded
here.

> **This file was rewritten for the public repository.** The original carried
> the raw output of each probe run against the author's own machine — real
> phone numbers, per-chat message counts, calendar contents. Those are the
> measurements, not the findings, and they are not what a reader needs. What
> follows is what each probe *decided*. Re-run the probes on your own machine
> to get your own numbers.

Every probe reads Full Disk Access territory, and macOS attributes that grant
to the **responsible process** — so a probe run from a shell proves nothing
about production. Run them the way the daemon runs:

```sh
launchctl submit -l io.intaglio.probe-X -o /tmp/probe.out -e /tmp/probe.err \
  -- ~/.hazlie/bin/node /path/to/ops/probes/probe-X.mjs
# poll /tmp/probe.out for the RESULT line, then:
launchctl remove io.intaglio.probe-X
```

A probe run from a dev shell reporting "denied" is the expected result, not a
failure.

---

## Store read modes — `snapshotStore` vs `openPersistentReader`

`connectors/lib/storeReader.mjs` offers exactly two sanctioned ways to read a
live Apple SQLite store, and **never** copying the `db`/`-wal`/`-shm` triple as
files (three separate copies are not atomic and produce a torn database that
opens fine and lies).

- **`snapshotStore()`** — SQLite's Online Backup API. Coherent against a live
  writer, at the cost of writing a full copy. Right for infrequent bulk scans.
- **`openPersistentReader()`** — a read-only connection. WAL gives
  per-transaction snapshot isolation at zero copy cost. Right for a tight poll
  loop, where a snapshot per iteration would dominate the loop period.

The trade is measurable and worth measuring on your own hardware: one
`backup()` of a large `chat.db` costs seconds and writes a copy the size of the
database each time. A 2-second poll loop taking a snapshot per iteration can
spend most of its period copying, and write tens of gigabytes a day, for a loop
that usually finds nothing.

**Which mode a consumer uses is a per-store decision that should be
re-measured, not inherited.** As of writing, `imessage`, `whatsapp`, `notes`,
`calendar` and `contacts` use `snapshotStore`. `photos` uses
`openPersistentReader`: a mature Photos database can be several gigabytes, so
a snapshot per scan would cost seconds and rewrite the database every pass, while a
persistent read-only connection reads at zero copy cost with WAL snapshot
isolation **per statement, not per scan** — `photos` runs its asset, name and
face queries as three separate statements outside any wrapping transaction,
so a later statement can observe a newer WAL epoch than the one before it.
Why that drift is acceptable there (the faces and names merely reflect a
slightly newer library state for the same assets) is written in full in
`connectors/sources/photos.mjs`'s header.

---

## WhatsApp: `ZMESSAGEDATE` is Apple-epoch **seconds**

`connectors/lib/whatsappRows.mjs` converts with
`seconds * 1000 + APPLE_EPOCH_MS`, and that single choice decides the date on
every WhatsApp message.

`ops/probes/probe-whatsapp.mjs` **decides** the unit rather than asserting it:
it interprets the median timestamp four ways and reports which lands in a
plausible window for a messaging app. The wrong unit is not subtly wrong —
reading seconds as milliseconds lands in 2001, as Unix seconds in 1995. A
representative run:

```
PLAUSIBLE  apple-seconds        2026-03-14
  absurd   apple-milliseconds   2001-01-10
  absurd   unix-seconds         1995-03-14
  absurd   unix-milliseconds    1970-01-10
DECIDED: apple-seconds
```

`connectors/test/whatsappRows.test.mjs` pins the same conclusion so it is
checked on every commit rather than only when someone runs a probe.

**WhatsApp Desktop's local store prunes — it is not an archive.** Re-running
the probe weeks apart showed *more chats and a thousand fewer messages*. Two
consequences: the connector's freshness is bounded by how often the app is
opened (hence `io.intaglio.whatsapp-keepalive`), and **the connector must never
reconcile by absence** — messages that have vanished from the local store still
exist on the user's phone, and deleting rows for them would destroy real
history. It does not; keep it that way.

---

## Files: the dataless rule

The overwhelming majority of files in a cloud-mirror folder (iCloud Drive, Box,
Dropbox) are **dataless** — present as a name and a size, with no bytes on
disk. Opening one downloads it.

On the machine this was measured, that was ~96k of ~98k files and tens of
gigabytes, which a connector on a timer would have pulled down through the
user's cloud account. So `connectors/lib/fileWalk.mjs` classifies via
`isDataless(stat)` — `blocks === 0 && size > 0` — and `sources/files.mjs`
refuses to extract text from anything it flags.

The predicate errs toward **not** reading: a materialized file can report zero
blocks and be skipped, which costs one document. The opposite error costs
bandwidth measured in gigabytes.

`connectors/test/dataless.test.mjs` pins the predicate, including the boundary
that makes it mean "the bytes live elsewhere" rather than "there are no bytes":
zero blocks **and** zero size is an ordinary empty file, not a placeholder.

---

## Hermes' port

`8789`, not `8787`. The canonical port moved because an unrelated development
server commonly holds `8787` and answers `200` there — which made every
defaulted caller reach a stranger and, once, POST a row at it.

That is why liveness is not identity: `connectors/lib/checks.mjs`
`verifyHermesIdentity` requires hermes' exact `/health` body before any row is
sent, and `ui/server/hermes.mjs` treats that body as a frozen wire contract
(the shipped widget string-compares it).
