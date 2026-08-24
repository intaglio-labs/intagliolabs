// Oura API v2 client for the health connector: mode selection (real API vs
// Oura's unauthenticated sandbox), next_token pagination, and the
// rotation-safe OAuth2 token manager.
//
// THE ONE FACT THAT SHAPES THIS FILE: Oura refresh tokens are SINGLE-USE.
// Every refresh returns a NEW access+refresh pair and invalidates the old
// one, so a refresh that is used before it is persisted — or run twice
// concurrently — strands the grant, and the only recovery is the owner
// re-running `node ops/oura-auth.mjs` through browser consent. Hence:
//   - one in-flight refresh per client: concurrent callers share the same
//     promise instead of each burning a rotation;
//   - the new pair is persisted ATOMICALLY (tmp 0600 → rename, previous file
//     kept one-deep at .prev — mirroring writeTokensAtomically in
//     ops/oura-auth.mjs, which establishes the storage contract) BEFORE the
//     new access token's first use, so a crash between "used the refresh
//     token" and "saved its replacement" cannot happen;
//   - `invalid_grant` is terminal: the error names the fix (rerun the OAuth
//     helper) and is NEVER retried — a retry loop against a dead grant is
//     just a slower way of telling the owner nothing.
//
// Refresh policy: proactive when obtained_at + expires_in·1000 − 120 s has
// passed (the slack absorbs clock skew and in-flight time), reactive on a
// 401 exactly once per request. Tokens are re-read from disk at use time,
// never cached across calls (connectors/AGENTS.md secrets discipline), which
// also lets a rotation by another process land without a restart.
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSecretJson, readSecretLine } from './secrets.mjs';

export const OURA_API_BASE = 'https://api.ouraring.com/v2/usercollection/';
// The sandbox is Oura's own: every collection has a twin under /sandbox/
// that needs no CREDENTIAL (any Authorization string passes — see
// OURA_SANDBOX_AUTH below) and serves generated sample data. It exists so
// URL shapes and pagination can be exercised against the real service
// without a grant and without touching anyone's personal data.
export const OURA_SANDBOX_BASE = 'https://api.ouraring.com/v2/sandbox/usercollection/';
export const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';

// Measured against the live service (2026-08-19): the sandbox needs no
// CREDENTIAL, but it 400s when the Authorization header is absent entirely
// ('Missing auth token. Include any string...'). A fixed placeholder
// satisfies it while guaranteeing no real token ever travels to the sandbox.
export const OURA_SANDBOX_AUTH = 'Bearer sandbox';

const EXPIRY_SLACK_MS = 120_000;
// Our collections over a 90-day backfill are at most a few hundred records;
// a pagination loop that runs longer than this is a server bug or a
// next_token cycle, and an unbounded loop against a rate-limited API is
// worse than a loud stop.
const MAX_PAGES = 200;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLLECTION_RE = /^[a-z][a-z0-9_]*$/;

export function defaultOuraTokensPath(home = homedir()) {
  return join(home, '.hazlie', 'secrets', 'oura-tokens.json');
}
export function defaultOuraClientIdPath(home = homedir()) {
  return join(home, '.hazlie', 'secrets', 'oura-client-id.txt');
}
export function defaultOuraClientSecretPath(home = homedir()) {
  return join(home, '.hazlie', 'secrets', 'oura-client-secret.txt');
}

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Mirror of ops/oura-auth.mjs writeTokensAtomically: tmp 0600 → rename is
// atomic on the same filesystem, and the one-deep .prev backup preserves the
// pair we are replacing in case the NEW pair turns out unusable (the old
// refresh token is dead either way, but .prev makes the failure diagnosable).
// 0o600 at creation cannot be widened by umask (umask only clears bits).
// PID-suffixed like gcalClient.mjs: a fixed `.tmp` name is shared state
// between the daemon's timer refresh and an ops/oura-auth.mjs re-auth, and
// an interleave destroys the live pair AND the .prev backup — which for
// Oura's single-use refresh tokens means browser consent again.
function writeTokensAtomically(path, tokens) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  if (existsSync(path)) renameSync(path, `${path}.prev`);
  renameSync(tmp, path);
}

// Mode selection, per the connector spec: an explicit sandbox=true wins;
// otherwise an ABSENT tokens file selects sandbox (there is nothing to
// authenticate with), and a present one selects the real API. Absent means
// ENOENT only — a tokens file that exists but fails the secrets gauntlet
// (wrong mode, symlink) must refuse loudly at read time, never quietly fall
// back to sample data.
export function createOuraClient({
  fetchImpl = fetch,
  sandbox = false,
  tokensPath = defaultOuraTokensPath(),
  clientIdPath = defaultOuraClientIdPath(),
  clientSecretPath = defaultOuraClientSecretPath(),
  log,
  now = Date.now,
} = {}) {
  let mode;
  let reason;
  if (sandbox === true) {
    mode = 'sandbox';
    reason = 'configured';
  } else if (!existsSync(tokensPath)) {
    mode = 'sandbox';
    reason = 'tokens-missing';
  } else {
    mode = 'api';
    reason = 'tokens-present';
  }
  // Once per run (the source builds one client per run): which Oura the
  // records are about to come from must be in the log, because sandbox data
  // is sample data and a run that silently used it would be undiagnosable.
  log?.info('oura_client_mode', { mode, reason });

  const base = mode === 'sandbox' ? OURA_SANDBOX_BASE : OURA_API_BASE;

  function readTokens() {
    return readSecretJson(tokensPath, {
      label: 'Oura tokens',
      setupHint: 'run `node ops/oura-auth.mjs` (browser consent)',
      requiredKeys: ['access_token', 'refresh_token'],
    });
  }

  function tokenIsStale(tokens) {
    const { obtained_at: obtainedAt, expires_in: expiresIn } = tokens;
    if (!Number.isFinite(obtainedAt) || !Number.isFinite(expiresIn)) {
      // Unknown lifetime (oura-auth writes expires_in: null when the token
      // endpoint omitted it): rely on the reactive 401 path.
      return false;
    }
    return now() >= obtainedAt + expiresIn * 1000 - EXPIRY_SLACK_MS;
  }

  async function doRefresh(staleAccessToken) {
    // Re-read before spending the rotation: if another caller of this
    // single-flight — or another process — already rotated the pair, the
    // refresh token on disk is the only live one and refreshing "again"
    // with what we remember would burn it for nothing.
    const current = readTokens();
    if (current.access_token !== staleAccessToken && !tokenIsStale(current)) {
      return current;
    }
    const clientId = readSecretLine(clientIdPath, {
      label: 'Oura client id',
      setupHint: 'see ops/CONNECTORS.md, "The Oura connector"',
    });
    const clientSecret = readSecretLine(clientSecretPath, {
      label: 'Oura client secret',
      setupHint: 'see ops/CONNECTORS.md, "The Oura connector"',
    });
    const res = await fetchImpl(OURA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      // A 307/308 would re-POST this body — client_secret and the single-use
      // refresh token — to wherever the reply points. The token endpoint
      // never legitimately redirects; same rule as lib/ingestClient.mjs.
      redirect: 'error',
    });
    let payload;
    try {
      payload = await res.json();
    } catch {
      payload = {};
    }
    if (!res.ok) {
      if (payload?.error === 'invalid_grant') {
        // Terminal by definition: the grant is dead (rotation raced, token
        // revoked, or a crash-before-persist under an older client). Only a
        // human in a browser can mint a new one — never retry this.
        throw statusError(
          res.status,
          'Oura refused the refresh token (invalid_grant): the grant is dead. ' +
            'Rerun `node ops/oura-auth.mjs` to re-authorize; do not retry.'
        );
      }
      throw statusError(res.status, `Oura token refresh failed: HTTP ${res.status}`);
    }
    if (typeof payload.access_token !== 'string' || !payload.access_token ||
        typeof payload.refresh_token !== 'string' || !payload.refresh_token) {
      throw new Error('Oura token refresh response is missing access_token/refresh_token');
    }
    const next = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      token_type: payload.token_type ?? current.token_type ?? 'Bearer',
      expires_in: payload.expires_in ?? null,
      scope: payload.scope ?? current.scope ?? null,
      obtained_at: now(),
    };
    // Persist BEFORE first use — this ordering is the whole crash-safety
    // argument (see the file header): once this line returns, dying at any
    // point costs nothing, because the live pair is on disk.
    writeTokensAtomically(tokensPath, next);
    log?.info('oura_tokens_rotated', { expiresIn: next.expires_in });
    return next;
  }

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
    if (tokenIsStale(tokens)) {
      return (await refreshTokens(tokens.access_token)).access_token;
    }
    return tokens.access_token;
  }

  async function expectOk(res, name) {
    if (res.ok) {
      let body;
      try {
        body = await res.json();
      } catch {
        throw statusError(res.status, `Oura ${name} answered non-JSON with HTTP ${res.status}`);
      }
      return body;
    }
    if (res.status === 429) {
      // 5000 req/5 min makes this near-impossible at our cadence, but the
      // contract (ops/CONNECTORS.md) is: never tight-retry — throw, let the
      // daemon's schedule push the whole cycle.
      const retryAfter = res.headers?.get?.('retry-after');
      throw statusError(
        429,
        `Oura rate limit on ${name}${retryAfter ? ` (Retry-After ${retryAfter}s)` : ''}; the cycle is pushed, not retried`
      );
    }
    throw statusError(res.status, `Oura ${name} answered HTTP ${res.status}`);
  }

  async function getJson(url, name) {
    if (mode === 'sandbox') {
      // The placeholder, never a real token: the sandbox requires the
      // header to exist but accepts any string (see OURA_SANDBOX_AUTH), and
      // an endpoint that needs no credential should never see one.
      return expectOk(
        await fetchImpl(url, { headers: { Authorization: OURA_SANDBOX_AUTH }, redirect: 'error' }),
        name
      );
    }
    let token = await accessToken();
    let res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
    if (res.status === 401) {
      // Reactive refresh, ONCE: the proactive path can miss (expires_in
      // null, revocation, clock skew beyond the slack). A second 401 with a
      // freshly-rotated token means refreshing cannot fix it.
      token = (await refreshTokens(token)).access_token;
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
      if (res.status === 401) {
        throw statusError(
          401,
          `Oura ${name} still answers 401 after a token refresh — the authorization is likely revoked; rerun \`node ops/oura-auth.mjs\``
        );
      }
    }
    return expectOk(res, name);
  }

  // Fetch every record of one collection for a day window, stitching
  // next_token pages. Page 1 carries start_date/end_date; every subsequent
  // page carries ONLY next_token — the token encodes the query, and Oura
  // rejects re-sending the dates alongside it.
  async function fetchCollection(name, { start_date, end_date } = {}) {
    if (typeof name !== 'string' || !COLLECTION_RE.test(name)) {
      throw new Error(`fetchCollection requires a collection name like "daily_sleep"; got ${JSON.stringify(name)}`);
    }
    for (const [key, value] of [['start_date', start_date], ['end_date', end_date]]) {
      if (typeof value !== 'string' || !DAY_RE.test(value)) {
        throw new Error(`fetchCollection ${name}: "${key}" must be a YYYY-MM-DD string`);
      }
    }
    const records = [];
    let url = `${base}${name}?${new URLSearchParams({ start_date, end_date })}`;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await getJson(url, name);
      if (!Array.isArray(body?.data)) {
        throw new Error(`Oura ${name} response is missing the "data" array`);
      }
      records.push(...body.data);
      if (!body.next_token) return records;
      url = `${base}${name}?${new URLSearchParams({ next_token: body.next_token })}`;
    }
    throw new Error(`Oura ${name} pagination exceeded ${MAX_PAGES} pages; refusing an unbounded loop`);
  }

  return { mode, reason, fetchCollection };
}
