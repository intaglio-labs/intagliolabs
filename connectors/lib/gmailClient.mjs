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
import { readSecretJson } from './secrets.mjs';
import { readGoogleClient } from './googleClients.mjs';
import { googleTokensPath, listGoogleAccounts, markGoogleAccountStale } from './googleAccounts.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// The same host the calendar client uses. gmail.googleapis.com serves the
// identical API and is the name Google's current docs give, but adding a
// second host to ops/EGRESS.json buys nothing a reader wants: one declared
// Google API host, two paths under it, is a smaller thing to audit.
const API_BASE = 'https://www.googleapis.com/gmail/v1';
const EXPIRY_SKEW_MS = 60_000;

// A 52k-message backfill trips Gmail's per-user "Units per minute" quota
// mid-run; a smaller mailbox never does, which is why one account worked and
// the other never did. MEASURED (2026-09, daemon paused, two separate Google
// accounts, each in a fresh minute at 250ms between `messages.get` calls):
// both hit HTTP 403 "Quota exceeded ... Units per minute per user" after
// exactly ~102 calls, i.e. ~37 seconds in. The effective budget is ~100 gets
// (~500 units) per user per minute, regardless of what the console displays
// (it shows 6,000) — so the earlier base-1s/cap-32s backoff could never
// outlast the window it was retrying against: a rolling one-minute quota
// needs a wait that can exceed a minute, not one bounded at 32 seconds. On a
// quota 429/403 (Retry-After still wins when Google sends one), the wait is
// now 60s plus 0-10s jitter, bounded at 5 attempts total — unbounded retry
// inside a resident poller is a hang wearing a progress indicator, same
// reasoning as notionClient.mjs's MAX_RATE_LIMIT_RETRIES.
const RATE_LIMIT_QUOTA_WAIT_MS = 60_000;
const RATE_LIMIT_QUOTA_JITTER_MS = 10_000;
const MAX_RATE_LIMIT_ATTEMPTS = 5;

// Reasons Google's error body uses for a 403 that is really a rate/quota
// limit, not a permissions problem. `insufficientPermissions` and friends
// must still throw immediately — retrying a real permissions error just
// delays the failure the owner needs to see.
const QUOTA_403_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

function statusError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Parses just enough of the error body to tell a quota 403 from any other
// 403, without assuming the body is JSON (a proxy or an outage can hand back
// plain text). `bodyText` is passed in already read, once, by the caller.
function isQuotaLimited(status, bodyText) {
  if (status === 429) return true;
  if (status !== 403) return false;
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  const error = parsed?.error;
  const reasons = Array.isArray(error?.errors) ? error.errors.map((e) => e?.reason) : [];
  if (reasons.some((r) => QUOTA_403_REASONS.has(r))) return true;
  if (QUOTA_403_REASONS.has(error?.status)) return true;
  return /quota exceeded/iu.test(String(error?.message ?? bodyText ?? ''));
}

// Retry-After (seconds) wins when Google sends it. Otherwise a flat 60s plus
// 0-10s jitter: the measured budget is a per-minute window, so every wait has
// to be able to outlast a full minute regardless of which attempt this is —
// backing off shorter than the window it's waiting out just fails again.
// Jitter keeps many callers backing off at once from all retrying in lockstep.
function rateLimitDelayMs(res) {
  // `Number(null)` is 0, so a genuinely absent header must be checked before
  // the numeric parse — otherwise no Retry-After silently becomes
  // "Retry-After: 0" and the quota wait never actually happens.
  const raw = res.headers?.get?.('retry-after');
  const retryAfter = raw === null || raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  return RATE_LIMIT_QUOTA_WAIT_MS + Math.random() * RATE_LIMIT_QUOTA_JITTER_MS;
}

export function createGmailClient({
  email,
  home = homedir(),
  tokensPath = null,
  fetchImpl = fetch,
  sleep = defaultSleep,
} = {}) {
  // Reuse the path discovered from disk first. The first per-account release
  // used slug-only filenames; new grants use a collision-resistant suffix.
  // Reading both keeps an existing authorization live without renaming a
  // credential behind a running daemon.
  const existing = tokensPath === null
    ? listGoogleAccounts({ home }).find(
        (account) => account.email?.toLowerCase() === String(email).toLowerCase()
      )
    : null;
  const path = tokensPath ?? existing?.tokensPath ?? googleTokensPath(email, home);
  // READ AT USE TIME, never cached (connectors/AGENTS.md). A re-auth that
  // rotates the client secret or the refresh token must take effect without a
  // daemon restart, and a file that turned group-readable after startup has to
  // be caught on the next call rather than never.
  // THE CLIENT THAT ISSUED THIS GRANT, not "the" client. Google will not renew
  // a refresh token against a different client, so once this Mac holds more
  // than one, the pairing is a property of the token rather than of the
  // install. A grant written before clients were named carries no `client` and
  // resolves to the legacy pair, which is exactly what issued it.
  const issuer = () => readGoogleClient(readTokens().client, { home });
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
      const issued = issuer();
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: issued.id,
          client_secret: issued.secret,
          refresh_token: current.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // invalid_grant IS THE DEAD-GRANT SIGNAL, and it is not retryable.
        // Google returns it when the refresh token has been revoked, the
        // password changed, the app was removed from the account, or the
        // OAuth client is still in Testing and seven days have passed.
        //
        // Recorded rather than only thrown: a thrown error reaches a log, and
        // a log is not where the owner looks. Written down, the connect page
        // and the shelf can say this mailbox needs signing in again — which is
        // the difference between a source that asks to be fixed and one that
        // just quietly stops.
        if (/invalid_grant/u.test(body)) {
          markGoogleAccountStale(path, 'Google refused the refresh token (invalid_grant)');
          throw statusError(res.status,
            `Google refused the refresh token for ${email ?? path} (invalid_grant): the grant is dead. ` +
            'Sign in again from the Connections shelf, or run `node ops/gcal-auth.mjs`.');
        }
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

    for (let attempt = 0; ; attempt += 1) {
      let res = await call(token);
      if (res.status === 401) {
        // Reactive refresh, ONCE. A second 401 on a freshly rotated token is
        // not an expiry problem and refreshing again cannot fix it.
        token = (await refreshTokens(token)).access_token;
        res = await call(token);
        if (res.status === 401) {
          throw statusError(401,
            `Gmail ${name} still answers 401 after a refresh — the authorization is likely revoked; ` +
            'rerun `node ops/gcal-auth.mjs`');
        }
      }
      if (res.ok) return res.json();

      const bodyText = await res.text();
      // Every other 4xx (including a real insufficientPermissions 403) is the
      // caller's bug or the caller's instruction, and throws immediately —
      // only a genuine rate/quota limit is worth waiting out.
      if (isQuotaLimited(res.status, bodyText) && attempt < MAX_RATE_LIMIT_ATTEMPTS - 1) {
        await sleep(rateLimitDelayMs(res));
        continue;
      }
      throw statusError(res.status, `Gmail ${name} failed: HTTP ${res.status} ${bodyText.slice(0, 200)}`);
    }
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
