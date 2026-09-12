# The feature registry

`ops/features.json` is the one place that says which of this app's surfaces are
alive. Stage 1 of the "Reconnect, Only" repackaging turns everything the
reconnection card does not need **off**, without deleting anything: the code
stays in the repository, the feature is behind a flag that defaults off, its
provisioning step is skipped, and its launch agent is not installed.

## The file

```json
{ "version": 1, "features": { "chat": false, …, "connectors": { "imessage": true, … } } }
```

Eight boolean surfaces — `chat`, `voice`, `bridges`, `timeline`,
`constellation`, `distiller`, `frontierHandoff`, `search` — and a `connectors`
table whose values are **three-state**:

| value | meaning |
|---|---|
| `true` | the card reads it. Scheduled by the daemon, tile shown. |
| `false` | dormant. Disabled-marker semantics (never scheduled, logged `source_hidden`), tile hidden. |
| `"optional"` | a real participant source, small today. Offered on the connections page and labelled optional, but **not auto-scheduled** until the owner connects it — its own gate (WhatsApp's `.disabled` marker, Granola's credential check in `needs()`) is what starts it. This is what WhatsApp already did; the registry writes it down. |

`health` names no connector module — Apple Health was replaced by the Oura API
in 2026-08. It is listed anyway so that re-adding it cannot arrive switched on
by inheriting a missing key. `matrix` is the reverse: a module with no registry
entry, because the Matrix bus *is* the `bridges` feature and is disabled with it.

## Who reads it

`widget/build.sh` copies it to `backend/ops/features.json` inside the bundle, so
the same relative path resolves in a checkout and in the app.

- **Swift** — `widget/src/Features.swift`. Static default `allOff`.
- **node** — `connectors/lib/features.mjs`, one shared lib. `ui/server` and
  `connect/` already import from `connectors/lib/`; this follows that.

## The owner override

`~/.hazlie/features.json`, same shape, **partial allowed**, merged over the
shipped file. A developer turns a feature on locally without a rebuild.

## Two failure rules, and they point opposite ways

1. **A missing or malformed registry is `allOff`.** "The file that says what is
   on is unreadable" must never resolve to "everything is on"; the registry
   ships inside the bundle, so unreadable means the bundle is broken, and a
   broken bundle must not provision a Matrix homeserver.
2. **A bad override is reported and discarded**, and the shipped registry still
   applies. An unknown key in `~/.hazlie/connectors/config.json` once killed the
   connector daemon outright on a single typo. A developer's local file must not
   be able to do that.

Every process logs which features are on at startup, **names only**.

## What each consumer does when a flag is off

| flag | effect |
|---|---|
| `bridges` | `Provision.prefetchBridgeRuntime` and `ensureBridgeRuntime` return early; `ops/setup-bridges-native.sh` never runs, so `io.intaglio.bridges` is never installed. An agent a previous install left behind is **retired on the next launch** — `launchctl bootout` and the plist removed, everything under `~/.hazlie/matrix` and `~/.hazlie/bridges` left on disk. The `matrix` connector is disabled with it. |
| `voice` | the voice-model clone into `~/.hazlie/models/voice` is skipped, the hidden ear webview is not built, `armVoice`/`speakAnswer` are no-ops, and the orb's tap stops teasing. (Taking the 496 MB out of the *bundle* is stage 2.) |
| `chat` | the chat panel and its webview are never built; `openChat`, `openChat(with:)` and `voiceNote` log and return. The widget hides `#wchat` and the message pill. |
| `timeline` | the people-months panel is never built. The gear row's People button routes to the **People popup** instead, because "Same person?" review is a keep and the timeline was its only door. |
| `constellation` | the sky view inside the timeline. Unreachable while `timeline` is off; see "not gated cleanly" below. |
| `distiller` | ANDed with the existing `~/.hazlie/distill.enabled` marker. Sweep, lookup and lint markers are untouched — they are the card. |
| `frontierHandoff`, `search` | declared and echoed; their surfaces live behind the chat page and the People pages, which are gated above. No separate guard yet. |

## Not gated cleanly, on purpose

- **`constellation`** has no seam of its own. The sky view was folded into the
  people-months popup in 2026-08-24; with `timeline` off it cannot be reached,
  so the flag is declared and pinned by the defaults test but has no consumer.
  Give it one the day the timeline comes back on without it.
- **`search` and `frontierHandoff`** are the same shape: `frontierSend` is a
  `chat`-page capability and general search is a People-page one, so both are
  already dark. They are in the registry so a future session cannot switch a
  page back on and silently get these too.
- **`Bridge.swift` capability allowlists are unchanged.** A page that is never
  loaded posts nothing, so no grant has to move — and the lists are asserted
  against the pages' own `hzPost` calls by
  `widget/test/bridge-capabilities.test.mjs`, which would fail on a trimmed one.
  The `chat`, `ear` and `people-months` entries therefore stay, describing pages
  that are not built.
