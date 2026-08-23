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
import { PLATFORMS, bridgeStatus, loadPanel, beginLogin, relay, loginUrlFrom } from './bridge.mjs';
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
      },
    };
  };

  try {
    if (method === 'GET' && subpath === '') {
      const st = bridgeStatus(platformId, { home });
      if (st.connected) return wrap([]);
      const { transcript } = await loadPanel(platformId, { home });
      return wrap(transcript);
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
    return { status: 502, body: { error: String(e?.message ?? e) } };
  }
}
