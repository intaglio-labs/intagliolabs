# Widget spec: native social-bridge login (Messenger / Instagram)

**Owner ask:** linking Messenger/Instagram must happen **inside the widget**, no
browser. The backend for this is built and live; this spec is the widget half.

## What already exists (backend, done — connect server :8788)

A bearer-authenticated, Origin-refused JSON API — the **same native channel as
`/api/status`** (bearer = `~/.hazlie/secrets/hermes-token.txt`, no Origin header,
so it's unreachable from a browser). It drives the local bridge bots over Matrix
and returns the login conversation. Pasted cookies are **masked server-side** out
of every transcript, so they're never returned to any client.

```
GET  /api/bridge?p=<messenger|instagram>
     → { platform, label, connected, name, transcript: [{from:'you'|'bot', body, ts}] }

POST /api/bridge/begin      body {"p":"messenger"}
     → same shape. Claims the bot's management room, cancels any stale login,
       starts fresh; transcript ends with the bot asking for cookies.

POST /api/bridge/cookies    body {"p":"messenger","cookies":"<Copy-as-cURL or JSON>"}
     → same shape. On success `connected:true` + `name`; on a bad paste the bot
       names the missing cookies in the transcript.
```

Statuses: 200 ok · 400 no cookies / bad json · 401 bad bearer · 403 Origin
present · 404 unknown platform · 502 bridge error.

## What the widget needs (this task)

The connections popup (`widget/ui/connections.js`) already renders Messenger and
Instagram tiles from `/api/status` (they carry `action: 'bridge'`). Today a tap
shows the WHY hint. Instead, for `src.action === 'bridge'` a tap should open a
**login panel** in the same popup:

1. On open: `bridgeStatus(p)` → if `connected`, show "linked as <name>"; else show
   the transcript + a **Begin login** button and a **cookie paste box**.
2. **Begin login** → `bridgeBegin(p)`, re-render transcript (bot will ask for cookies).
3. Steps text: on `facebook.com`/`instagram.com` (logged in) → devtools ⌥⌘I →
   Network → filter `graphql` → a request → Copy as cURL → paste below.
4. Paste box + **Send** → `bridgeCookies(p, text)`, re-render; on `connected` show
   the linked state. (Server masks the paste; don't render the user's raw input.)

### Native side (`widget/src/Bridge.swift`)

Add three message handlers, each mirroring `fetchStatus` (bearer from
`bearerToken()`, `connectBase`, Origin-less, parse JSON, reply to JS):

- `bridgeStatus` payload `{p}` → `GET api/bridge?p=<p>`
- `bridgeBegin`  payload `{p}` → `POST api/bridge/begin` `{p}`
- `bridgeCookies` payload `{p, cookies}` → `POST api/bridge/cookies` `{p, cookies}`

Return the parsed JSON body straight through to the JS promise (same as status).
`begin`/`cookies` can take a few seconds (the server waits on the bot) — use a
longer timeout (~15s) than status's 5s.

### JS side (`widget/ui/connections.js`)

`hzPost('bridgeStatus', {p})` etc. Render the panel from the returned
`transcript`; the paste box is a `<textarea>`. No masking needed on the client —
the server already masks — but don't echo the textarea value back into the log.

## Notes

- Backfill is set deep (10k msgs/convo) and the bridges are hardened passive
  (double-puppet off, presence off) — nothing for the widget to configure.
- Contract details & the flow live in `connect/lib/bridge.mjs`,
  `connect/lib/bridgeApi.mjs`. The connect-page version of this exact panel is
  `connect/lib/bridgePage.mjs` — a reference for the UX, not a dependency.
