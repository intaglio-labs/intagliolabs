# Intaglio Labs

### Unify your circles, find your people.

Intaglio is private, personalized AI for your Mac. Connect the apps that hold
your conversations, relationships, and history; Intaglio processes that context
locally so you can find the people and connections that matter to you.

[Download for Mac](https://github.com/intaglio-labs/intagliolabs/releases/latest/download/IntaglioLabs.dmg) · [intaglio.io](https://intaglio.io)

## How it works

1. **Connect your apps.** Bring together iMessage, WhatsApp, Messenger,
   Instagram, X, Telegram, Discord, Slack, LinkedIn, Gmail, Calendar, Contacts,
   and Granola.
2. **Process context locally.** Storage and compute run on your Mac, keeping
   your personal data private.
3. **Find your people.** Explore everyone in your life—from any point in
   time—in one place.

Ask questions such as:

- “Find the investors I met in LA about five years ago.”
- “Does anyone from my high school work in tech?”
- “Who would be down for Italy?”

## Privacy, precisely

Answers start locally against loopback model servers. Intaglio never attaches
raw corpus rows, quotes or hidden retrieval context to a cloud request. After a
local answer, you may choose ChatGPT or Claude, review and edit the complete
outbound prompt, and explicitly send that text through the provider's installed
client. The sent text can contain private facts from the local answer; what you
see in the review box is the privacy boundary.

That does not mean that nothing ever leaves your Mac: connected services,
software distribution, and other network access have their own explicit paths.
[`ops/EGRESS.json`](ops/EGRESS.json) is the source of truth for declared egress
and is enforced by `connectors/test/egress.test.mjs`.

## Run Intaglio

For the ready-to-use app, [download the latest Mac release](https://github.com/intaglio-labs/intagliolabs/releases/latest/download/IntaglioLabs.dmg).

For a source install, see [`ops/README.md`](ops/README.md). The short version:

```sh
bash ops/setup-llm.sh --verify
bash ops/setup-connectors.sh
```

The setup provisions the local model, context store, and connectors as
launchd-managed services. Full Disk Access is granted per resolved binary, so
the setup intentionally uses a stable Node copy at `~/.hazlie/bin/node`.

## Architecture

| Component | Role |
| --- | --- |
| `widget/` | macOS desktop app: a Swift/AppKit shell around local web views |
| `ui/server/` | `hermes`, the local context store and memory pipeline; sole database writer and deleter |
| `connectors/` | Resident source pollers that deliver rows to Hermes over loopback |
| `connect/` | Loopback-only onboarding page for connecting sources |
| `bridges/` | Local Matrix bridges for chat platforms, run natively under launchd |
| `ops/` | Setup scripts, launchd agents, runbooks, and probes |

## Guardrails

- **Hermes is the only writer and deleter.** Connectors use `POST /ingest`;
  deletion is requested through bearer-only `/admin/*` routes.
- **No automatic cloud context.** Raw rows, quotes and hidden snippets never
  ride a cloud request. A frontier handoff sends only the text the user reviews
  and explicitly approves.
- **Logs never contain row content.** `connectors/lib/log.mjs` rejects
  content-shaped field names.
- **Reconciliation cannot mass-delete.** A scan that observes nothing cannot
  delete anything; see `connectors/lib/reconcile.mjs`.
- **Secrets are read at use time** from `0600` files inside a `0700` directory.

`connectors/AGENTS.md` and `ui/AGENTS.md` contain behavior-critical guidance
for work in those directories.

## Development and tests

```sh
(cd connectors && npm ci && npm test)
(cd connect && npm test)
(cd ui && npm test)
node --test 'widget/test/*.test.mjs'
```

The widget contract suite is hermetic by default. Set `HZ_CONTRACT_LIVE=1` to
run it against a live Hermes instance.

## License

[MIT](LICENSE)
