# Widget spec: Beeper-style in-app login for the social bridges

**Owner ask:** the cookie/devtools flow is too technical ("so my mom can do
it"). Instagram has **no** email/password option (cookies only — I probed it), so
the mom-friendly answer is Beeper's: open the platform's **real login page inside
the app**, let the user log in normally, and **harvest the session cookies from
that webview** — no devtools, no copy-paste. Owner is fine with a login page
appearing ("its ok if we have to open web page... lets do as much in the widget
as we can"), so this keeps the whole thing inside the widget window.

Supersedes the paste-box in `WIDGET-BRIDGE-LOGIN-SPEC.md` as the primary path.
The paste box can stay as an "advanced" fallback, but this is the default.

## The flow

1. Tap **Connect** on a bridge tile (`action:'bridge'`, ids `messenger`/`instagram`).
2. Native: `POST /api/bridge/begin {p}` → returns `{ loginUrl, cookieDomain, transcript, connected, name }`.
   - `loginUrl` — the page to load (pulled from the bot's own "Login URL:" line; e.g.
     `https://www.instagram.com/accounts/login/`, `https://www.facebook.com/login/`).
   - `cookieDomain` — `instagram.com` / `facebook.com`.
3. Native: present a **dedicated login WKWebView** (sheet/window) loaded at `loginUrl`.
4. User logs in normally — username, password, 2FA if Meta asks. All on the real site.
5. Native watches for success: the session cookie appears in the webview's cookie
   store — `sessionid` (Instagram) or `c_user` (Facebook), non-empty.
6. On success, native **harvests all cookies for `cookieDomain`** from the webview's
   `WKHTTPCookieStore`, builds a JSON object `{ name: value, … }`, and:
   `POST /api/bridge/cookies { p, cookies: <that JSON string> }`.
   (The bot takes a JSON cookie object; it picks the keys it needs and names any
   missing ones in the returned transcript.)
7. Response `connected:true` + `name` → dismiss the webview, show "linked as …".
   If the bot complains (missing keys), surface its transcript line and keep the
   webview open for a retry.

## ⚠️ The one real posture decision (flagging, don't let it slip through)

The widget today runs every page at `default-src 'none'` with a navigation
delegate that **refuses non-file URLs** — "no web content in-process" is a
deliberate property. This feature **requires an exception**: a webview that
loads live `facebook.com` / `instagram.com`. Do it as a **separate, isolated**
`WKWebView`, not the UI one:

- Its **own non-persistent `WKWebsiteDataStore`** (`.nonPersistent()`), so the
  login session is sandboxed and gone when dismissed — nothing bleeds into the
  app or persists on disk.
- Navigation delegate scoped to the **login domain only** (allow
  `*.facebook.com` / `*.instagram.com` + Meta's auth/CDN hosts it redirects
  through; cancel anything else). It is a login window, not a browser.
- Tear it down (and its data store) after harvest.
- Egress note: this webview talks to Meta directly — that's the user logging into
  their own account, the same category as the bridge's own link. The harvested
  cookies go only to the **local** connect server (`/api/bridge/cookies`, bearer,
  loopback). No cookie ever reaches a third party or leaves the Mac.

## Native handlers (Bridge.swift)

Reuse the bearer/Origin-less pattern from the existing `bridgeBegin`/`bridgeCookies`.
Add one orchestrator, e.g. `bridgeWebLogin` payload `{p}`:
- calls begin, reads `loginUrl`/`cookieDomain`
- presents the isolated login webview
- polls `WKHTTPCookieStore.getAllCookies` (~1s) for the session cookie
- on success harvests → `bridgeCookies` → replies to JS with the final
  `{connected,name,transcript}`; on user-cancel replies a cancel state.

## API (all built + live, my side — no changes needed)

```
POST /api/bridge/begin   {p}            → { loginUrl, cookieDomain, transcript, connected, name }
POST /api/bridge/cookies {p, cookies}   → { connected, name, transcript, … }   (cookies = JSON object string)
GET  /api/bridge?p=<id>                 → { connected, name, transcript, loginUrl, cookieDomain }
```

Bearer = `~/.hazlie/secrets/hermes-token.txt`, no Origin header (native only).
`begin` needs a ~22s timeout (three bot round-trips); `cookies` ~15s; GET is instant.
Cookies are masked server-side out of every returned transcript.

## Notes

- Session-cookie names to watch for success: Instagram `sessionid` (+ `ds_user_id`),
  Facebook `c_user` (+ `xs`). Harvest the full domain cookie set regardless — the
  bot selects.
- Still a fresh login, so Meta may throw a 2FA/checkpoint — that's normal and
  handled naturally inside the webview (it's the real login page).
- Bridges are hardened passive + deep backfill (10k/convo); nothing to configure here.
