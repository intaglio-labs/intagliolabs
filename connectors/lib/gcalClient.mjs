// Google Calendar API client. Read-only, loopback-authorized, rotation-safe.
//
// THE FACT THAT SHAPES THIS FILE, and it differs from Oura's: Google refresh
// tokens are LONG-LIVED and reusable — a refresh returns a new access token
// and usually no new refresh token. So the failure mode Oura has (burn the
// refresh token twice and you are locked out) does not apply here. The
// discipline is kept anyway, because the *other* half is identical: a refresh
// that IS rotated and then lost is unrecoverable, and Google does rotate on
// its own schedule and when a grant is re-consented. Persist first, use after.
//
// The second Google-specific fact: a refresh can fail permanently. An app in
// Testing mode has its refresh tokens expire after 7 days, and a revoked or
// re-consented grant returns invalid_grant. That is not a retryable error and
// must surface as "re-run ops/gcal-auth.mjs", not as a generic HTTP failure.

import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSecretJson, readSecretLine } from './secrets.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
// Refresh this far before nominal expiry so a long scan cannot straddle it.
const EXPIRY_SKEW_MS = 120_000;

export const defaultGcalTokensPath = (home = homedir()) =>
  join(home, '.hazlie', 'secrets', 'gcal-tokens.json');
export const defaultGcalClientIdPath = (home = homedir()) =>
  join(home, '.hazlie', 'secrets', 'gcal-client-id.txt');
export const defaultGcalClientSecretPath = (home = homedir()) =>
  join(home, '.hazlie', 'secrets', 'gcal-client-secret.txt');

// tmp → rename is atomic on one filesystem; the one-deep .prev makes a
// half-rotated grant diagnosable instead of merely dead.
function writeTokensAtomically(path, tokens) {
  // PID-SUFFIXED, like granolaClient.mjs:104 and storeReader.mjs:48.
  //
  // A fixed `.tmp` name is shared state between processes. The daemon refreshes
  // this grant on a timer and `ops/gcal-auth.mjs` writes the same path during a
  // re-auth, so the two can interleave: both write the tmp file, one renames
  // path -> .prev, the other renames tmp -> path. The window destroys the live
  // token AND the one-deep backup that exists to make a half-rotated grant
  // diagnosable — leaving the owner re-authorising from scratch.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  if (existsSync(path)) renameSync(path, `${path}.prev`);
  renameSync(tmp, path);
}

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createGcalClient({
  tokensPath = defaultGcalTokensPath(),
  clientIdPath = defaultGcalClientIdPath(),
  clientSecretPath = defaultGcalClientSecretPath(),
  fetchImpl = fetch,
} = {}) {
  // READ AT USE TIME, not cached here.
  //
  // connectors/AGENTS.md: "Secrets are read AT USE TIME, never cached across
  // calls." Every sibling client obeys that and says why — granolaClient.mjs
  // carries the comment verbatim. This one read all three at construction and
  // held them in the closure for the life of the daemon, which is the one
  // thing the rule forbids: a re-auth that rotates the client secret has no
  // effect until someone restarts, so the owner does the work, sees no error,
  // and the connector keeps presenting the old credential.
  //
  // Re-reading also replays the full owner-only permission gauntlet on every
  // call, which is the other half of what the rule is for — a file that became
  // group-readable after startup would otherwise never be noticed.
  const clientId = () => readSecretLine(clientIdPath, { label: 'gcal client id' });
  const clientSecret = () => readSecretLine(clientSecretPath, { label: 'gcal client secret' });

  function readTokens() {
    return readSecretJson(tokensPath, {
      label: 'gcal tokens',
      setupHint: 'run `node ops/gcal-auth.mjs` (browser consent)',
      requiredKeys: ['access_token', 'refresh_token'],
    });
  }

  function expiresAt(tokens) {
    if (!Number.isFinite(tokens.expires_in) || !Number.isFinite(tokens.obtained_at)) return 0;
    return tokens.obtained_at + tokens.expires_in * 1000;
  }

  async function doRefresh(staleAccessToken) {
    // Re-read before spending the refresh token, mirroring ouraClient: if
    // another process (an ops/gcal-auth.mjs re-auth) rotated the pair since
    // our caller read it, the pair on disk is the live one, and refreshing
    // from what we remember would write the stale grant back over it.
    const current = readTokens();
    if (current.access_token !== staleAccessToken && Date.now() < expiresAt(current) - EXPIRY_SKEW_MS) {
      return current;
    }
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
        client_id: clientId(),
        client_secret: clientSecret(),
      }),
      // A 307/308 would re-POST this body — client_secret and refresh token —
      // to wherever the reply points. The token endpoint never legitimately
      // redirects; same rule as lib/ingestClient.mjs.
      redirect: 'error',
    });
    if (!res.ok) {
      const body = await res.text();
      if (/invalid_grant/u.test(body)) {
        throw statusError(
          res.status,
          'Google refused the refresh token (invalid_grant): the grant is dead. Causes, in order of ' +
            'likelihood: the OAuth app is still in Testing mode (refresh tokens expire after 7 days), ' +
            'the grant was revoked at myaccount.google.com/permissions, or the account password changed. ' +
            'Re-run `node ops/gcal-auth.mjs`.'
        );
      }
      throw statusError(res.status, `Google token refresh failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const payload = await res.json();
    if (typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new Error('Google token refresh response is missing access_token');
    }
    const next = {
      ...current,
      access_token: payload.access_token,
      // Google usually omits refresh_token on refresh; keeping the existing
      // one is correct, and taking a new one when offered is required.
      refresh_token: payload.refresh_token ?? current.refresh_token,
      expires_in: payload.expires_in ?? current.expires_in,
      scope: payload.scope ?? current.scope,
      obtained_at: Date.now(),
    };
    // Persist BEFORE the new token is used anywhere.
    writeTokensAtomically(tokensPath, next);
    return next;
  }

  // One in-flight refresh per client: concurrent callers share it rather than
  // racing to rotate the same grant.
  let refreshInFlight = null;
  function refreshTokens(staleAccessToken) {
    if (!refreshInFlight) {
      refreshInFlight = doRefresh(staleAccessToken).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function accessToken() {
    const tokens = readTokens();
    if (Date.now() >= expiresAt(tokens) - EXPIRY_SKEW_MS) {
      return (await refreshTokens(tokens.access_token)).access_token;
    }
    return tokens.access_token;
  }

  async function apiGet(path, params, { name = path } = {}) {
    let token = await accessToken();
    const url = `${API_BASE}${path}?${new URLSearchParams(params)}`;
    let res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
    if (res.status === 401) {
      // Reactive refresh, ONCE. A second 401 on a freshly rotated token is not
      // an expiry problem and refreshing again cannot fix it.
      token = (await refreshTokens(token)).access_token;
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
      if (res.status === 401) {
        throw statusError(
          401,
          `Google ${name} still answers 401 after a refresh — the authorization is likely revoked; ` +
            'rerun `node ops/gcal-auth.mjs`'
        );
      }
    }
    if (!res.ok) {
      throw statusError(res.status, `Google ${name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    async listCalendars() {
      const out = [];
      let pageToken;
      do {
        const page = await apiGet(
          '/users/me/calendarList',
          { maxResults: '250', ...(pageToken ? { pageToken } : {}) },
          { name: 'calendarList' }
        );
        out.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },

    // singleEvents=true is the whole reason this connector beats the local
    // store: Google expands recurrences server-side and returns concrete
    // occurrences, so there is no RRULE engine here to get subtly wrong — and
    // no dependence on a lazily-populated OccurrenceCache.
    async listEvents({ calendarId, timeMinMs, timeMaxMs }) {
      const out = [];
      let pageToken;
      do {
        const page = await apiGet(
          `/calendars/${encodeURIComponent(calendarId)}/events`,
          {
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: '2500',
            timeMin: new Date(timeMinMs).toISOString(),
            timeMax: new Date(timeMaxMs).toISOString(),
            ...(pageToken ? { pageToken } : {}),
          },
          { name: `events(${calendarId})` }
        );
        out.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },
  };
}
