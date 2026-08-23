# Hazlie desktop widget

A native macOS desktop widget: Swift/AppKit + WKWebView, zero third-party
dependencies, compiled by one `swiftc` invocation in `build.sh`. It is the
product face that replaces the Expo web frontend (owner decision 2026-08-20).

Three views, from the owner's "Terminal Palette" mockups: the desktop-pinned
panel (`_ Chat` + connector tiles + status dots), a Connections popup, and a
Chat popup.

## Recorded override of VOICE-PLAN decision 1

VOICE-PLAN.md chose a minimal Expo shell for iOS/Android portability and said
not to port the visual UI. This app contradicts that rationale by explicit
owner request (2026-08-20): the frontend is now a native macOS widget, and the
Expo web face (port 8081) retires. Flagged here per CLAUDE.md conventions
rather than silently reconciled. Consequence for the hermes branch:
`DEFAULT_ALLOWED_ORIGINS` (localhost:8081) becomes dead config once the Expo
face is actually removed — that shrink belongs to a separate, coordinated
commit over there, not to this directory.

**Done, 2026-08-23.** `DEFAULT_ALLOWED_ORIGINS` is now empty; see
`ui/server/hermes.mjs`. The shrink mattered more than "dead config" suggests —
the entry was not merely unused, it was an unauthenticated channel that any
other process holding port 8081 would have inherited.

## Requirement on /vault/ask (MEMORY-PLAN Days 7–9, not yet built)

The chat view targets `POST /vault/ask` on hermes. Whoever builds it:

- **It must accept the bearer channel.** This widget is a native URLSession
  client: it sends NO Origin header and authenticates with
  `Authorization: Bearer` from `~/.hazlie/secrets/hermes-token.txt`. Do not
  gate the route on `channel === 'browser'`.
- **Honor client-disconnect aborts** (`req` close → AbortSignal on the llama
  call, per VOICE-PLAN §3.6): the send button becomes a working Cancel.

Until the route exists, a send renders the fixed string "vault isn't ready on
this machine yet" (404), and status/identity failures render their own fixed
strings. The widget never fabricates an answer.

## Architecture

- **One process, three windows.** `.accessory` policy (no Dock icon). The
  widget window sits at `CGWindowLevelForKey(.desktopIconWindow) + 1` with
  `[.canJoinAllSpaces, .stationary, .ignoresCycle]` — above wallpaper and
  icons, below every normal window, on every Space. Popups are borderless
  `NSPanel`s at `.normal` level that opt back in to key status (the chat
  input needs focus). Position persists via frame autosave.
- **The widget is a pure client.** It never opens Apple stores, never spawns
  services, holds no TCC grants, and must never gain a launchd plist — the
  FDA grants belong to launchd's `~/.hazlie/bin/node`, and a wrapper that
  became the responsible process would silently break them.
- **`src/Bridge.swift` is the egress choke point.** The only two reachable
  URLs are `http://127.0.0.1:51789` (hermes) and `http://127.0.0.1:51788`
  (connect; `HAZLIE_CONNECT_PORT` overrides the port only, for a dev
  instance). Redirects are refused. The webviews load `file://` resources
  only — `default-src 'none'` CSP plus a navigation delegate that cancels
  every non-file navigation — so a page cannot make a network request at
  all. Audit = read this directory; there is nothing else.
- **Identity before trust:** every chat send preflights `GET /health` on
  51789 and requires the exact body `{"ok":true}` (the port-8787 lesson:
  liveness is not identity).
- **Status** comes from connect's `GET /api/status` (bearer-only; added on
  this branch), which reuses the connect page's `readStatus()` in-process so
  the widget and the page can never disagree. Poll: 60s, on popup open, on
  wake. Unreachable/unauthorized renders as unknown (muted), never red.

## Palette

`ui/palette.css` transcribes Terminal Palette v0.2 from
`connect/lib/page.mjs:30-42`. One addition, pending owner sign-off:
`--status-ok` (the mockups' green dot/cursor; v0.2 has no green) — replace
with the exact value from the Terminal Palette `.dc.html` export when it
lands. No fonts or icons are bundled or fetched: system-mono stack,
two-character text marks in the mockups' own dashed placeholder boxes.

## Build & run

```sh
widget/build.sh          # build + install to ~/Applications/Hazlie.app
widget/build.sh --run    # ...and (re)launch
```

To start at login: System Settings → General → Login Items → add
Hazlie.app. Deliberately manual for v1 (see the launchd warning above).

Dev loop against a non-launchd connect:

```sh
node connect/server.mjs --port 8790 &
HAZLIE_CONNECT_PORT=8790 ~/Applications/Hazlie.app/Contents/MacOS/Hazlie
```

## Verified 2026-08-20 (first build)

- Window level -2147483602 (= desktopIcon+1) confirmed via CGWindowList;
  stays below normal windows, survives relaunch with position.
- `footprint`: 20 MB phys (llama-server running alongside).
- `lsof`: only 127.0.0.1:51788/51789 sockets, ever; grep audit: two loopback
  URL literals, nothing else.
- /api/status round trip against a dev connect on 8790: dots match
  readStatus() truth row-for-row (FDA rows show the documented
  shell-vs-launchd caveat).
- Known cosmetic artifact: an offscreen 500×500 window (layer 0,
  onscreen=nil) shows in CGWindowList alongside the widget window. Origin
  not yet identified; invisible in practice.

Not yet verified: popup interactions (need a human click), chat round trip
(needs /vault/ask to exist).
