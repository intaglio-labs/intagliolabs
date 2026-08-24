# intaglio labs — personalized & private AI

A personal AI that runs entirely on your own Mac.

It reads the sources you connect — calendar, mail, messages, notes, photos,
files, and chat platforms — into a local store, and answers questions about
them using a model running on your machine. Nothing about your data is sent to
a cloud model.

## The claim, stated narrowly

**No corpus text is sent to a cloud model.** All reasoning and narration happen
locally, against loopback model servers.

That is deliberately narrower than "nothing leaves your Mac", which would be
false. Data does leave, on the paths enumerated in **`ops/EGRESS.json`** — the
single source of truth for what this software can reach, enforced by
`connectors/test/egress.test.mjs`, which fails the build on any host in the
source that is not declared there.

Do not restate that list in prose anywhere. It has drifted before.

## Shape

| Piece | What it does |
|---|---|
| `widget/` | The desktop app — a Swift/AppKit shell around local web views |
| `ui/server/` | `hermes`, the context store and its memory pipeline. Sole writer and sole deleter of the database |
| `connectors/` | Resident pollers that read your own sources and deliver rows to hermes over loopback |
| `connect/` | A loopback-only onboarding page for connecting sources |
| `bridges/` | Local Matrix bridges for chat platforms, in Docker |
| `ops/` | Setup, launchd agents, runbooks, probes |

Each of `connectors/` and `ui/` carries an `AGENTS.md` with rules that are
load-bearing rather than stylistic — read those before changing behaviour in
either.

## Principles that are enforced, not just stated

- **Hermes is the only writer and the only deleter.** Connectors write through
  `POST /ingest`; deletion is requested through bearer-only `/admin/*`.
- **Corpus text never rides a cloud request.** Not as a setting, not as a flag.
- **The log never carries row content.** `connectors/lib/log.mjs` refuses
  content-shaped field names outright.
- **Reconciliation cannot mass-delete.** A scan that observed nothing may
  delete nothing; see `connectors/lib/reconcile.mjs`.
- **Secrets are read at use time**, from `0600` files inside a `0700`
  directory, with the full permission check replayed on every read.

Several of these have tests whose only job is to prove the guard *fires* — not
merely that it passes on a tree that is already correct.

## Running it

`ops/README.md` is the operator's entry point. In short: `ops/setup-llm.sh`
then `ops/setup-connectors.sh`, which installs the launchd agents and runs
`connectors/doctor.mjs`.

Full Disk Access is granted per *resolved binary*, which is why setup pins a
copy of node at `~/.hazlie/bin/node` — a grant does not survive the binary
being replaced by a package manager.

## Tests

```sh
(cd connectors && npm ci && npm test)   # the no-native-module check runs in ops/setup-connectors.sh, not here
(cd connect && npm test)
(cd ui && npm test)
node --test 'widget/test/*.test.mjs'
```

The widget contract suite is hermetic by default; `HZ_CONTRACT_LIVE=1` runs it
against a live hermes instead.

## Licence

MIT. See `LICENSE`.
