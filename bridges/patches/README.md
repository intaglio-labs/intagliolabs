# LinkedIn realtime-only bridge patch

The official LinkedIn archive supplies historical messages. The live bridge
therefore needs only recent conversations and small downtime catch-up windows.
Upstream `mautrix-linkedin` v0.2608.0 walks every conversation page during its
initial sync even when its update and create limits are small. That creates
unnecessary account traffic.

This directory contains both forms of the narrow fix:

- `linkedin-v0.2608.0-realtime-only.patch` is the corresponding source change.
- `linkedin-v0.2608.0-realtime-only.bsdiff` transforms the exact upstream
  darwin-arm64 release binary into the tested executable.

`bridges/native.json` pins all three stages: upstream input, binary delta, and
final output. `ops/fetch-bridges.mjs` refuses to install the executable if any
stage differs. The delta is not standalone account code; it applies only to the
named upstream release.

## Source and verification

- Upstream repository: `https://github.com/mautrix/linkedin`
- Tag: `v0.2608.0`
- Commit: `f813a9cef8938d08ecc0ba29caba327450c92db4`
- Toolchain used for the audited build: Go 1.26.5, macOS arm64
- Upstream licence: AGPL-3.0

The source patch adds unit tests that prove conversation sync stops after its
first recent page and individual message fetches remain bounded. Run upstream's
connector tests after applying it:

```sh
git apply linkedin-v0.2608.0-realtime-only.patch
go test ./pkg/connector
```

Before replacing this delta, verify the new binary's signature and linked
libraries, regenerate the three hashes in `bridges/native.json`, and run the
repository's full test suite. Prefer deleting the delta when upstream provides
an equivalent limit.
