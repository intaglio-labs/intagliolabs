# The feature registry

`ops/features.json` is the one place that says which of this app's surfaces are
alive. Stage 1 of the "Reconnect, Only" repackaging turns everything the
reconnection card does not need **off**, without deleting anything: the code
stays in the repository, the feature is behind a flag that defaults off, its
provisioning step is skipped, and its launch agent is not installed. Stage 2
adds the last one: its weight stays out of the bundle, so a dormant feature
costs nothing to download either.

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
the same relative path resolves in a checkout and in the app. Since stage 2 it
also **reads** it, to decide what to copy at all — and a malformed registry
fails the build there rather than resolving to `allOff`. The two rules point
opposite ways for the same reason: an unreadable registry at runtime means a
broken bundle, and a broken bundle must not provision a homeserver; an
unreadable one at build time means a typo in the checkout, and a build must not
silently ship an app with a feature missing.

- **Swift** — `widget/src/Features.swift`. Static default `allOff`.
- **node** — `connectors/lib/features.mjs`, one shared lib. `ui/server` and
  `connect/` already import from `connectors/lib/`; this follows that.

## The owner override

`~/.hazlie/features.json`, same shape, **partial allowed**, merged over the
shipped file. A developer turns a feature on locally without a rebuild.

`HAZLIE_FEATURES_OVERRIDE` points the loader somewhere else: another file, or
`none` for no override at all. **An empty value means `none`, not "read
`$HOME`"** — `HAZLIE_FEATURES_OVERRIDE=$MAYBE node --test …` with `MAYBE` unset
is how a wrapper silently handed the hermetic tests the developer's own file.

The read answers `overrideState` beside `registryState`: `none` (nothing to
apply — the owner file is usually absent, and that is silent), `ok`, `missing`
(a path somebody *named* is not there — a mis-pointed escape hatch, which used
to be indistinguishable from a clean read) and `invalid` (there and refused).
Neither of the last two changes `registryState`; see the two failure rules
below.

**A flip needs restarts, and the three readers disagree about when.**
`Features.current` caches for the app's whole process lifetime and `daemon.mjs`
caches at module load, so changing the override takes an **app restart and a
daemon restart**; hermes re-reads the registry on a 30 s TTL, which means
`/stats.features` can report the new set — within thirty seconds of the edit —
while the app and the daemon are still acting on the old one. `/stats.features`
carries `readAt`, the moment hermes last read the file, so the age of that
answer is legible rather than assumed. Read `/stats.features` as "what the file
said, as of `readAt`", not "what this install believes".

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
### LinkedIn is two flows behind two flags

`linkedin` is both a bridge platform and the connector that reads the data
export, sharing one hermes source name. The bridge tile follows `bridges`; the
export tile follows `connectors.linkedin`, which stays **true** with bridges
off — `connectors/sources/linkedin.mjs` is scheduled and polling
`~/.hazlie/imports/linkedin` either way. So **both tiles are drawn when both
flows are live**, named "LinkedIn (bridge)" and "LinkedIn (export)"; with
bridges off there is one tile and it keeps the plain name. Never a scheduled
connector with no surface, in either direction.

The rule lives in `visibleStatusRows` (`connect/lib/status.mjs`) for the connect
page and is mirrored by `isHiddenSource`/`visibleSources` in
`widget/ui/connections.js` — the shelf is a classic `<script>` in a WKWebView
and cannot import a node module. Both are pinned against the same cases
(`connect/test/linkedinTiles.test.mjs`,
`widget/test/connector-visibility.test.mjs`).

| `bridges` | `Provision.prefetchBridgeRuntime` and `ensureBridgeRuntime` return early; `ops/setup-bridges-native.sh` never runs, so `io.intaglio.bridges` is never installed. An agent a previous install left behind is **retired on the next launch** — `launchctl bootout` and the plist removed, everything under `~/.hazlie/matrix` and `~/.hazlie/bridges` left on disk. The `matrix` connector is disabled with it. **`tools/yq` (12 MB) also stays out of the bundle** — see below. |
| `voice` | the ~496 MB speech models are **not copied into the bundle at all** (stage 2), the clone into `~/.hazlie/models/voice` is skipped, the hidden ear webview is not built, `armVoice`/`speakAnswer` are no-ops, and the orb's tap stops teasing. |
| `chat` | the chat panel and its webview are never built; `openChat`, `openChat(with:)` and `voiceNote` log and return. The widget hides `#wchat` and the message pill. |
| `timeline` | the people-months panel is never built. The gear row's People button routes to the **People popup** instead, because "Same person?" review is a keep and the timeline was its only door. |
| `constellation` | the sky view inside the timeline. Unreachable while `timeline` is off; see "not gated cleanly" below. |
| `distiller` | ANDed with the existing `~/.hazlie/distill.enabled` marker. Sweep, lookup and lint markers are untouched — they are the card. |
| `frontierHandoff`, `search` | declared and echoed; their surfaces live behind the chat page and the People pages, which are gated above. No separate guard yet. |

## What is in the bundle, at each flag setting

Stage 2 of the repackaging makes the registry decide what **ships**, not only
what runs: `widget/build.sh` reads `ops/features.json` before it assembles the
app, and refuses to install a bundle over its budget: `BUNDLE_BUDGET_MB` (250),
or `BUNDLE_BUDGET_VOICE_MB` (800) when `voice` is on. A voice build is ~496 MB
heavier by design; that is a bigger number, not the absence of one. Measured on
2026-09-12, both flags off:

| piece | MB | shipped when | why |
|---|---:|---|---|
| `node` + libnode | 112 | always | the backend runs on it, and a downloaded app has no Homebrew and no nvm |
| `llama/` runtime | 56 | always | the local-answer fallback has to be **one click**, not a toolchain. The weights (2.5–4.7 GB) are downloaded, never bundled |
| `connectors/` | 12 | always | `node_modules` after the prune below |
| `ui/server`, `connect`, `ui/scripts`, `prompts`, `bridges`, `ops`, `agents`, `config`, `helpers` | ~7 | always | the backend's own source, plus the app binary, icon and pages |
| `tools/yq` | 12 | `bridges` on | a static Go binary whose only caller is `ops/setup-bridges-native.sh`, which the `bridges` gate already refuses to run |
| `voice-models/` | 496 | `voice` on | Moonshine tiny + Silero VAD + onnxruntime-web + Kokoro-82M. Still bundled rather than fetched when the flag is on, because producing them needs node, npm and ~1.9 GB of downloads |
| **total** | **~184** | both off | was 703 |

Two things that are **not** bundle-gated and should stay that way: the `.gguf`
weights (downloaded, and only on an owner action — see below) and everything
under `~/.hazlie`, which is data rather than product.

The `connectors/` prune, worth 12 of the 24 MB: `connectors/test` and markdown
are excluded from the `rsync`, and the cloned `node_modules` loses sourcemaps
(7.6 MB), markdown (1.1), `.d.ts` (0.8) and `test`/`example`/`doc` directories
(3.1). It is scoped to `connectors/node_modules` **on purpose** — the same
markdown sweep over the whole backend would take `prompts/*.md` with it, which
`ui/server` reads at runtime, producing a bundle that installs and launches and
answers nothing.

Nothing is deleted from the repository by any of this. Turning a flag back on
and rebuilding restores the bundle exactly; the re-enable is a flag flip plus a
build, never an edit.

## First launch downloads nothing

The other half of the stage 2 checkpoint. The only asset this app fetches is the
`.gguf`, and `ModelSetup.download` is the single entry point to that fetch. It
is now reachable from exactly two places:

- the **`modelDownload` bridge verb** — an owner action, onboarding screen 5,
  the screen that states the disk and battery cost first; and
- the **launch-time reconciliation**, which `ModelSetup.automaticTarget` now
  refuses unless a model is **already installed**. It is an upgrade path ("this
  Mac or this app changed and the weights you have are no longer the right
  ones"), never a first install.

`main.swift` does not even arm the reconciliation timer without
`ModelSetup.isInstalled`. Two locks for one promise, deliberately: one of them
lives in `Bridge.swift`, which a later stage of this repackaging owns.
`ModelSetup.recommended` is untouched — screen 5 still uses it to size the model
to the Mac. `widget/test/bundle-diet.test.mjs` pins all of it.

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
