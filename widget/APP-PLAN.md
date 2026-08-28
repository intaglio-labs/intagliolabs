# APP-PLAN — the widget as a downloadable Mac app

Plan only (owner request, 2026-08-21). Nothing here is built. Companion to
`site/DEPLOY.md`, whose "download for mac button is inert" item this plan
would eventually close. (A note for readers of the public tree: `site/` — the
marketing-site artifact — and the CLAUDE.md and README passages this plan
cites stayed in the private repo; the load-bearing content of each citation
is stated where it is used.)

## What we are starting from (all true today)

- `Hazlie.app` already exists: AppKit + WKWebView, zero third-party code,
  one `swiftc` invocation, hand-assembled bundle, hardened runtime with the
  audio-input entitlement, signed with the owner's Apple Development
  identity. `build.sh` installs to `~/Applications`.
- The app is a **pure client by design** (README: never spawns services,
  holds no TCC grants beyond mic, must never gain a launchd plist). All
  substance lives outside it: hermes :51789, connect :51788, the connectors
  daemon, llama-server, listen, watchdog — six `com.hazlie.*` launchd
  agents running under `~/.hazlie/bin/node`, provisioned by
  `ops/setup-connectors.sh`, `ops/setup-llm.sh` and
  `widget/voice/setup-voice.sh` (npm + multi-GB model downloads).
- FDA attribution belongs to launchd's `~/.hazlie/bin/node`. A wrapper app
  that spawned the services itself would silently break those grants —
  this constraint shapes the whole plan.
- The private repo's CLAUDE.md standing flag: the prototype's speaker-identity and privacy
  decisions were made for one user and must be revisited "before this
  leaves the house or acquires a second user." A downloadable app IS that
  moment.

## Decision 0 — who is the download for?

Everything else scales off this. Three tiers, in order of effort:

| Tier | Audience | What it demands |
|---|---|---|
| A | Maintainers' own machines | Developer ID cert; nothing else changes |
| B | Friendly testers ("our family") | Everything in this plan |
| C | Public download from intaglio.io | Tier B + legal gate + support/update story |

**Recommendation: plan for B, structure it so C is only additive.** Tier A
is nearly free and worth doing first regardless (it fixes signing for the
second machine).

## Phase 1 — distribution identity (small, do first)

1. Apple Developer Program membership ($99/yr) on whichever entity ships
   this (Intaglio Labs, Inc. — matches the landing page).
2. Create a **Developer ID Application** certificate; `build.sh` already
   prefers it over Apple Development in its identity scan, so builds pick
   it up with zero script changes.
3. Notarization: `xcrun notarytool submit` with an App Store Connect API
   key, then `xcrun stapler staple`. Add as a `--release` path in
   `build.sh` (keep the dev path exactly as is).
4. Bundle hygiene that Gatekeeper/notarization will demand: stable bundle
   id, real `CFBundleShortVersionString`/`CFBundleVersion` discipline, an
   app icon (there is none today), and `LSMinimumSystemVersion` matching
   the `-target macos13.0` pin.
5. Decide arch: build.sh pins `$(uname -m)`. For distribution, either a
   universal binary (`-target arm64` + `-target x86_64`, `lipo`) or a
   documented arm64-only stance. Recommendation: arm64-only for tier B
   (every candidate machine is Apple silicon), universal only if C demands
   it.

## Phase 2 — the app learns to install its own backend (the hard part)

The app stays a pure client at runtime. What changes: the DMG carries the
backend payload, and a **first-run setup flow** inside the app plays the
role `ops/setup-*.sh` plays today. Explicitly rejected alternative: the app
spawning services as child processes — it would become the TCC/FDA
responsible process and break the launchd attribution model the repo warns
about.

1. **Payload in the bundle** (`Contents/Resources/backend/`): the node
   binary (the pinned v25-with-FTS5 build), hermes/connect/connectors JS,
   the six launchd plists as templates, and the uninstaller script.
   Notarization consequence: every nested executable (node above all) must
   be signed with the same Developer ID and hardened-runtime-compatible
   entitlements. Node needs `com.apple.security.cs.allow-jit`; budget a
   day for fighting exactly this.
2. **First-run bootstrapper, grafted onto the onboarding being built
   now.** The welcome flow already in flight (`ui/onboarding.html/js`,
   canvas §07–09) is three scenes: intro, a self-advancing chat demo
   with one press in it, and "your turn" — which deliberately ends on
   "let's start w connections" and the connector tile row with amber
   needs-attention dots. That last screen IS the seam: the bootstrapper
   is what happens when a tester taps those tiles. Division of labor:
   - The welcome flow stays what it is — the product introducing itself.
     Nothing technical moves into scenes 1–2.
   - Scene 3's tiles become live: first interaction triggers the backend
     bootstrap (idempotently what setup-connectors.sh does — copy node
     to `~/.hazlie/bin/node`, write secrets, render plists,
     `launchctl bootstrap gui/$UID`), then each tile walks its own
     connector's auth. Tile dots flip amber→green off the same
     `/api/status` the widget already polls, so progress needs no new UI.
   - The doctor's output renders behind a "details" disclosure, not as
     the main face of setup — testers see tiles turning green, not a
     runbook.
   - `__hzOnboardingReset` already lets the flow replay from settings;
     the bootstrap steps must therefore stay idempotent so a replay is
     safe (they already are in script form).
   Implementation language: reuse the existing shell scripts, executed
   via a small privilege-free `Process` call, rather than porting their
   logic to Swift — the scripts are the tested artifact; the app (and
   this onboarding) is their chrome.
3. **Permissions walkthrough, in order of pain**, attached to the tiles
   that need each grant rather than presented as a wall up front: mic
   (the entitlement + TCC prompt already work) when voice first arms;
   Full Disk Access for `~/.hazlie/bin/node` when the first FDA-needing
   connector (imessage/notes/photos) is tapped — it cannot be granted
   programmatically, so that tile deep-links to System Settings and
   *verifies* via a launchd-spawned probe, exactly the FDA runbook in
   ops/CONNECTORS.md; OAuth connectors (gcal/oura) reuse their existing
   helper scripts.
4. **Models stay a separate, explicit download** — the repo's rule is
   "the runtime never fetches," and a 4–8GB DMG is hostile anyway. The
   setup flow gets a "download voice + LLM models" step with checksums,
   resume, and a clear disk-space price tag; until it runs, chat works
   and voice fails closed with its fixed message (already the behavior).
5. **Uninstall story** (tier B requirement, not a nicety): one script in
   the bundle that unloads the six agents, deletes `~/.hazlie`, and says
   what TCC grants to revoke. Testers who can't cleanly leave don't
   install twice.

## Phase 3 — packaging and delivery

1. **DMG, not pkg.** Drag-to-Applications matches the "download for mac"
   button's promise; everything a pkg's postinstall would do is the
   first-run flow's job anyway. Build with `hdiutil` in a script (keeps
   the zero-third-party ethos; no create-dmg dependency).
2. Notarize and staple the DMG itself, not just the app.
3. Host the artifact: GitHub Releases on the private repo won't serve
   anonymous downloads — either a public releases-only repo, or (better,
   ties into the domain plan) serve it from intaglio.io alongside the
   landing page. Then wire the button (`site/DEPLOY.md` item).
4. **Updates: manual for now, and that is a feature.** The widget's egress
   choke point allows only 127.0.0.1; an auto-update check is the app's
   first phone-home and contradicts the landing page's whole pitch.
   Tier B: announce updates out-of-band, users re-download. Tier C
   revisits this deliberately (signed appcast, opt-in check, disclosed on
   the privacy page) — never Sparkle-by-default.

## Phase 4 — the gate that is not engineering

Per the private repo's CLAUDE.md, before a second user: the BIPA/CIPA review
its README priced at "two hours with a defense litigator, cheaper than the
dev kit."
Concretely for the download build: speaker enrollment/persistent identity
defaults OFF for non-owner users, retention defaults ON, and the
/privacy page (currently a blank shell) written to describe what the
thing actually does. This phase blocks tier B shipping, not tier B
development — run it in parallel with Phase 2.

## Phase 5 — proving it works on a Mac that is not this one

- A clean-VM matrix (macOS 13/14/15, arm64): Gatekeeper first launch,
  every TCC prompt, FDA verification, model download on hotel wifi,
  upgrade-in-place over an existing `~/.hazlie`, uninstall.
- The doctor (`connectors/doctor.mjs`) becomes the acceptance test: setup
  is done when the doctor is green on a machine we've never touched.

## Order of work and rough weight

| Step | Weight | Blocked on |
|---|---|---|
| 1. Developer ID + notarized build of today's app | ~1 day | Apple enrollment |
| 2. DMG script + hosting + wire the landing button | ~1 day | step 1 |
| 3. Sign/bundle node + backend payload | ~2 days | step 1 |
| 4. First-run bootstrapper + permissions flow | ~1 week | step 3 |
| 5. Model-download step | ~2 days | step 4 |
| 6. Uninstaller + clean-VM matrix | ~3 days | step 4 |
| 7. Legal/privacy gate | external | parallel from day 1 |

Steps 1–2 alone yield a real, notarized, downloadable Hazlie.app whose
chat says "vault isn't ready on this machine yet" on a bare Mac — a
shippable tier-A artifact and an honest demo, two days in. Everything
after is about making the backend arrive with it.

## Open decisions for the owners

1. Tier B target: how many testers, whose Macs? (Sets the QA matrix.)
2. Which entity enrolls in the Developer Program (Intaglio Labs?).
3. arm64-only — acceptable?
4. Where does the DMG live: intaglio.io or a public releases repo?
5. Voice/LLM in the tester build, or chat-only first? (Cuts the model
   download and the llama launchd agent from v1 if deferred.)
6. Who takes the litigator meeting, and when — it gates shipping.
