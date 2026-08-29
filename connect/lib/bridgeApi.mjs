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
import {
  PLATFORMS, bridgeStatus, bridgeNeedsAppCredential, beginLogin, relay, loadPanel, loginUrlFrom,
} from './bridge.mjs';
import { maskOwn } from './bridgePage.mjs';
import { bearerAuthorized } from './statusApi.mjs';

// The owner's own messages are masked here too — a cookie blob must never leave
// this module in a response, native channel or not.
function safeTranscript(transcript) {
  return (transcript ?? []).map((m) => ({
    from: m.from,
    body: m.from === 'you' ? maskOwn(m.body) : m.body,
    ts: m.ts,
    // Only the BOT's images travel. The owner never sends one in this flow,
    // and an echo of something they pasted is exactly what maskOwn exists to
    // prevent — so the rule is the same for pixels as for text.
    ...(m.image && m.from === 'bot' ? { image: m.image } : {}),
  }));
}

// The transcript is a rolling history. Only the newest meaningful bot line
// can own a live input step; an older X passcode prompt must not block a fresh
// login after a later logout/success response. A validation error is the one
// exception: it keeps the preceding question active for retry.
const questionLine = (body) => String(body ?? '').split('\n')
  .map((line) => line.trim()).filter(Boolean)
  .find((line) => line.endsWith('?') || /^(please|enter|register|create|choose)\b/iu.test(line));

export function pendingBridgeQuestion(transcript) {
  const bodies = [...(transcript ?? [])].reverse()
    .filter((m) => m.from === 'bot')
    .map((m) => String(m.body ?? '').trim())
    .filter((body) => body && !body.startsWith('Login URL:') && !body.includes('`{'));
  if (!bodies.length) return null;
  const current = questionLine(bodies[0]);
  if (current) return current;
  if (!/^(invalid\b|must start with|not a valid|please try again)/iu.test(bodies[0])) return null;
  for (const body of bodies.slice(1)) {
    const prior = questionLine(body);
    if (prior) return prior;
  }
  return null;
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

  // `engine` is the honest answer to "is there a bridge stack behind this?", and
  // it exists because this route could not say. The GET below deliberately falls
  // back to wrap([]) on ANY failure so a fresh install still renders policy --
  // correct for the panel, disastrous for the caller, because native reads this
  // BEFORE presenting a login window and a 200 meant "go ahead". So the owner
  // typed a real Meta password into a real Meta page, the cookies were harvested,
  // and only THEN did POST begin discover there was no homeserver to hand them
  // to. The session was dropped and nothing resumed.
  //
  // 'up' means loadPanel actually reached the stack. 'down' means it did not.
  // 'unknown' means nothing probed it -- an already-connected platform, or a
  // route with no reason to ask. Callers must treat only 'down' as a refusal;
  // anything else keeps today's behaviour, which is what stops this from becoming
  // a new way for a fresh install to fail closed.
  const wrap = (transcript, { engine = 'unknown' } = {}) => {
    const st = bridgeStatus(platformId, { home });
    return {
      status: 200,
      body: {
        platform: platformId,
        label: platform.label,
        connected: st.connected,
        engine,
        name: st.name ?? null,
        transcript: safeTranscript(transcript),
        // Native uses this BEFORE presenting a browser window. That folds
        // "resume a live passcode" and "open a fresh login" into one tile
        // request instead of making the UI perform a preliminary status call
        // whose row can be replaced by the panel's focus refresh.
        pendingQuestion: pendingBridgeQuestion(transcript),
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
        // 'header' -> "a=1; b=2" (LinkedIn); anything else -> a JSON object
        // keyed by cookie name, which is what the Meta and X bridges parse.
        cookieFormat: platform.webLogin?.cookieFormat ?? 'json',
        // The full field contract when a bridge wants more than a cookie jar:
        // [{id, from: 'cookies'|'header', header?}]. Null for the platforms
        // whose login is cookies alone.
        fields: platform.webLogin?.fields ?? null,
        // An approval window: no harvest, no fields — the person answers on
        // the platform's own page and the bridge reports the outcome itself.
        approval: platform.webLogin?.approval === true,
        // WHERE A STORAGE FIELD'S VALUE LIVES. Slack's sign-in ends on a page
        // that offers to launch the desktop app and holds no token; the token
        // belongs to the web client behind its own link. The window walks there
        // itself once the cookies are in, rather than leaving the owner on a
        // page with nothing on it to press.
        storageUrl: platform.webLogin?.storageUrl ?? null,
        // SUBFRAMES ONLY: the hosts a challenge widget's iframes come from.
        // Separate from allowedHosts because the main frame is where a password
        // is typed and a widget is not a destination — BridgeLogin enforces the
        // split, this file authors it.
        allowedFrameHosts: platform.webLogin?.allowedFrameHosts ?? null,
        // A platform that refuses the default browser string gets its own.
        // Server-authored like the rest of this policy — Swift enforces it.
        userAgent: platform.webLogin?.userAgent ?? null,
        // 0 means "use the window's default width". Only a platform whose login
        // page does not declare a viewport needs to say anything here.
        windowWidth: platform.webLogin?.windowWidth ?? 0,
        // A QR WINDOW instead of a web login: the bridge posts an image, the
        // window shows it, a phone scans it, and the bridge reports the
        // outcome itself. Nothing is navigated to and nothing is harvested,
        // which is why it is its own flag rather than a shape of webLogin.
        qrLogin: platform.qrLogin === true,
        // Telegram's bridge will not start until an api_id/api_hash exists,
        // and a build may have shipped one. True means the card should walk
        // the owner through registering their own; false means it is already
        // configured and the card goes straight to the login conversation.
        // Read off the config, so the same card is right either way.
        needsAppCredential: bridgeNeedsAppCredential(platformId, { home }),
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
        return wrap(transcript, { engine: 'up' });
      } catch {
        // Same fallback as before -- policy alone, HTTP 200, fresh install
        // unaffected -- but it now SAYS the stack was unreachable instead of
        // looking identical to a healthy one.
        return wrap([], { engine: 'down' });
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
