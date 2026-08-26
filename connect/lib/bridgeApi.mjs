// The widget's native channel for social-bridge login — the same login flow as
// the connect page's /c/<token>/bridge panel, exposed as JSON so the widget can
// host the whole thing in its own native window (no browser). Same rules as
// /api/status (see statusApi.mjs): any request carrying an Origin header is
// refused (browsers always send one; the widget's URLSession never does), and
// auth is the hermes bearer token. Cookies the owner pastes are masked out of
// every transcript this returns, so they are never echoed back to any client.
//
// Routes (all under /api/bridge, bearer + Origin-less):
//   GET  /api/bridge?p=<platform>          → { connected, name, transcript }
//   POST /api/bridge/begin   {p}           → start login, returns the prompt
//   POST /api/bridge/cookies {p, cookies}  → send the pasted cookies/cURL

import { homedir } from 'node:os';
import { PLATFORMS, bridgeStatus, beginLogin, relay, loadPanel, loginUrlFrom } from './bridge.mjs';
import { maskOwn } from './bridgePage.mjs';
import { bearerAuthorized } from './statusApi.mjs';

// The owner's own messages are masked here too — a cookie blob must never leave
// this module in a response, native channel or not.
function safeTranscript(transcript) {
  return (transcript ?? []).map((m) => ({
    from: m.from,
    body: m.from === 'you' ? maskOwn(m.body) : m.body,
    ts: m.ts,
  }));
}

export async function bridgeApiResponse({
  method,
  subpath = '',
  origin,
  authorization,
  query,
  body,
  home = homedir(),
} = {}) {
  if (origin !== undefined) return { status: 403, body: { error: 'browser channel refused' } };
  if (!bearerAuthorized(authorization, home)) return { status: 401, body: { error: 'unauthorized' } };

  const platformId = query?.get?.('p') ?? body?.p ?? '';
  const platform = PLATFORMS[platformId];
  if (!platform) return { status: 404, body: { error: 'unknown platform' } };

  const wrap = (transcript) => {
    const st = bridgeStatus(platformId, { home });
    return {
      status: 200,
      body: {
        platform: platformId,
        label: platform.label,
        connected: st.connected,
        name: st.name ?? null,
        transcript: safeTranscript(transcript),
        // For the widget's in-app (Beeper-style) login: where to point the
        // embedded webview, and which domain's cookies to harvest once the user
        // has logged in there. loginUrl prefers the bot's own "Login URL:" line.
        loginUrl: loginUrlFrom(transcript, platform),
        cookieDomain: platform.cookieDomain,
        // The web-login POLICY, from the platform table -- the hosts that flow
        // may navigate to and the cookie that means "in". Null for the
        // platforms whose bridge takes a token or a phone code instead of
        // cookies, and the widget must not open a webview for those: an
        // embedded login it cannot complete is a blank window with no error.
        //
        // Sent rather than hardcoded in Swift because it was hardcoded in Swift
        // and drifted four platforms out of date. The widget enforces this; it
        // does not decide it.
        allowedHosts: platform.webLogin?.allowedHosts ?? null,
        sessionCookie: platform.webLogin?.sessionCookie ?? null,
        // Every cookie the bridge's login step demands (X wants auth_token AND
        // ct0). Absent for platforms whose session cookie is the whole story.
        requiredCookies: platform.webLogin?.requiredCookies ?? null,
      },
    };
  };

  try {
    if (method === 'GET' && subpath === '') {
      const st = bridgeStatus(platformId, { home });
      if (st.connected) return wrap([]);
      // BEST-EFFORT TRANSCRIPT, not none (owner hit the gap 2026-08-25).
      //
      // This returned [] unconditionally, and the reasoning was sound as far
      // as it went: requiring loadPanel() here made a fresh install fail on
      // missing Matrix credentials before Facebook/Instagram/X could even be
      // shown, so policy/status was made to stand alone. What it missed is
      // that a login can PAUSE mid-conversation — X accepts cookies and then
      // asks for its encrypted-DM PIN — and this route is what the panel
      // re-reads every time it reopens. Answering "no transcript" threw away
      // a live question the bridge was still waiting on: the prompt and its
      // input vanished on the next render while the login sat half-finished.
      //
      // So: try, and fall back to [] on ANY failure, which keeps the fresh-
      // install path exactly as it was — no Matrix stack, no credentials, or
      // an unreachable homeserver all still answer with policy alone.
      try {
        const { transcript } = await loadPanel(platformId, { home });
        return wrap(transcript);
      } catch {
        return wrap([]);
      }
    }
    if (method === 'POST' && subpath === 'begin') {
      const { transcript } = await beginLogin(platformId, { home });
      return wrap(transcript);
    }
    if (method === 'POST' && subpath === 'cookies') {
      const cookies = String(body?.cookies ?? '');
      if (cookies.trim().length === 0) return { status: 400, body: { error: 'no cookies provided' } };
      const { transcript } = await relay(platformId, cookies, { home });
      return wrap(transcript);
    }
    return { status: 404, body: { error: 'no such bridge route' } };
  } catch (e) {
    // NAME THE ACTUAL FAILURE. Every error here collapsed into the widget's
    // generic "status unavailable" — which is what the owner saw after a
    // complete X login (2026-08-25) when Docker Desktop had quit underneath
    // the stack: the cookies were fine, the homeserver simply was not there.
    // A login that cannot be delivered must say WHY, because the remedy
    // (start the engine) is nothing like the remedy for a bad password.
    const msg = String(e?.message ?? e);
    const unreachable = /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|fetch failed|socket hang up/iu.test(msg)
      || /credentials incomplete|ENOENT/iu.test(msg);
    if (unreachable) {
      return { status: 503, body: { error: 'bridge engine is not running', state: 'nobridge' } };
    }
    return { status: 502, body: { error: msg } };
  }
}
