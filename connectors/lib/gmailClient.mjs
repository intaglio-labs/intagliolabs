// Gmail REST, read-only, for one authorized account.
//
// WHY NOT IMAP, WHICH THIS REPLACED. The mail connector reached the provider
// over IMAP with a 16-character app password. Moving to OAuth was the owner's
// ask (2026-08-26) — an app password is minted by hand and carries the whole
// account rather than a scope. The obvious move, keeping IMAP and
// authenticating with XOAUTH2, does NOT work: Google will not accept
// `gmail.readonly` over IMAP. IMAP demands the full-mailbox scope, which is
// read, write, delete AND send. Taking it would have bought read access with
// the power to destroy the mailbox, against CLAUDE.md rule 5. The REST API is
// where read-only is actually read-only, so the transport changed.
//
// TOKENS ARE SHARED WITH CALENDAR and refreshed the same way: one grant per
// Google account covers both. This file deliberately mirrors gcalClient.mjs
// rather than abstracting over it — two ~40-line refresh loops that can be
// read side by side beat one indirection that has to be held in your head,
// and the failure modes (401 after refresh = revoked) are worth stating twice.

import { homedir } from 'node:os';
import { readSecretJson, readSecretLine } from './secrets.mjs';
import {
  defaultGcalClientIdPath as clientIdPathFor,
  defaultGcalClientSecretPath as clientSecretPathFor,
} from './gcalClient.mjs';
import { googleTokensPath } from './googleAccounts.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// The same host the calendar client uses. gmail.googleapis.com serves the
// identical API and is the name Google's current docs give, but adding a
// second host to ops/EGRESS.json buys nothing a reader wants: one declared
// Google API host, two paths under it, is a smaller thing to audit.
const API_BASE = 'https://www.googleapis.com/gmail/v1';
const EXPIRY_SKEW_MS = 60_000;

function statusError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function createGmailClient({
  email,
  home = homedir(),
  tokensPath = null,
  fetchImpl = fetch,
} = {}) {
  const path = tokensPath ?? googleTokensPath(email, home);
  // READ AT USE TIME, never cached (connectors/AGENTS.md). A re-auth that
  // rotates the client secret or the refresh token must take effect without a
  // daemon restart, and a file that turned group-readable after startup has to
  // be caught on the next call rather than never.
  const clientId = () => readSecretLine(clientIdPathFor(home), { label: 'google client id' });
  const clientSecret = () => readSecretLine(clientSecretPathFor(home), { label: 'google client secret' });
  const readTokens = () =>
    readSecretJson(path, {
      label: `google tokens for ${email ?? path}`,
      setupHint: 'run `node ops/gcal-auth.mjs` (browser consent)',
      requiredKeys: ['access_token', 'refresh_token'],
    });

  const expiresAt = (t) =>
    Number.isFinite(t.expires_in) && Number.isFinite(t.obtained_at)
      ? t.obtained_at + t.expires_in * 1000
      : 0;

  let refreshInFlight = null;
  async function refreshTokens(staleAccessToken) {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      // Re-read before spending the refresh token: another process may have
      // rotated the pair since our caller read it, and refreshing from what we
      // remember would write the stale grant back over the live one.
      const current = readTokens();
      if (current.access_token !== staleAccessToken && Date.now() < expiresAt(current) - EXPIRY_SKEW_MS) {
        return current;
      }
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId(),
          client_secret: clientSecret(),
          refresh_token: current.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      if (!res.ok) {
        throw statusError(res.status, `google token refresh failed: HTTP ${res.status}`);
      }
      const payload = await res.json();
      const next = {
        ...current,
        access_token: payload.access_token,
        expires_in: payload.expires_in ?? current.expires_in,
        scope: payload.scope ?? current.scope,
        obtained_at: Date.now(),
      };
      const { writeFileSync, renameSync } = await import('node:fs');
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
      return next;
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  async function accessToken() {
    const t = readTokens();
    if (Date.now() >= expiresAt(t) - EXPIRY_SKEW_MS) {
      return (await refreshTokens(t.access_token)).access_token;
    }
    return t.access_token;
  }

  async function apiGet(subpath, params = {}, { name = subpath } = {}) {
    let token = await accessToken();
    const url = `${API_BASE}${subpath}?${new URLSearchParams(params)}`;
    const call = (tk) =>
      fetchImpl(url, { headers: { Authorization: `Bearer ${tk}` }, redirect: 'error' });
    let res = await call(token);
    if (res.status === 401) {
      // Reactive refresh, ONCE. A second 401 on a freshly rotated token is not
      // an expiry problem and refreshing again cannot fix it.
      token = (await refreshTokens(token)).access_token;
      res = await call(token);
      if (res.status === 401) {
        throw statusError(401,
          `Gmail ${name} still answers 401 after a refresh — the authorization is likely revoked; ` +
          'rerun `node ops/gcal-auth.mjs`');
      }
    }
    if (!res.ok) {
      throw statusError(res.status,
        `Gmail ${name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    email,
    tokensPath: path,
    profile: () => apiGet('/users/me/profile', {}, { name: 'profile' }),
    // `q` is Gmail's own search syntax; the connector uses it for the date
    // window so the server does the filtering rather than this Mac.
    listMessages: ({ q, pageToken, maxResults = 100 }) =>
      apiGet('/users/me/messages',
        { q, maxResults: String(maxResults), ...(pageToken ? { pageToken } : {}) },
        { name: 'messages.list' }),
    // `full` gives headers and body parts in one call. `raw` would hand back
    // RFC-822 that mailparser could read directly, but it is markedly larger
    // per message and this connector only wants a handful of headers plus the
    // text part.
    getMessage: (id) =>
      apiGet(`/users/me/messages/${encodeURIComponent(id)}`, { format: 'full' },
        { name: 'messages.get' }),
  };
}
