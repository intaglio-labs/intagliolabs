// One-time Oura OAuth2 authorization for the health connector.
//
// Run it on the Mac (`node ops/oura-auth.mjs`), approve in the browser tab it
// opens, and it writes ~/.hazlie/secrets/oura-tokens.json. Everything after
// that is the connector's job: Oura refresh tokens are SINGLE-USE (each
// refresh returns a new pair and invalidates the old), so this file also
// establishes the storage contract the connector must keep honoring —
// write-the-new-tokens-atomically-BEFORE-using-them, and keep a one-deep
// .prev backup, because a crash between "used the refresh token" and "saved
// its replacement" locks us out and forces this browser dance again.
//
// The redirect URI must byte-match one registered on the Oura app
// (https://cloud.ouraring.com/oauth/applications). This helper binds loopback
// only; nothing here is reachable off-machine.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const SECRETS_DIR = join(homedir(), '.hazlie', 'secrets');
const CLIENT_ID_FILE = join(SECRETS_DIR, 'oura-client-id.txt');
const CLIENT_SECRET_FILE = join(SECRETS_DIR, 'oura-client-secret.txt');
const TOKENS_FILE = join(SECRETS_DIR, 'oura-tokens.json');

const AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
const TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const REDIRECT_URI = 'http://localhost:8817/callback';
const PORT = 8817;
// `daily` covers the sleep/readiness/activity summaries; the rest are the
// per-domain scopes Oura documents. No `email` — the connector never needs it.
const SCOPES = 'personal daily heartrate workout session spo2 stress';
// 15 minutes: the approval competes with whatever else the owner is doing;
// two real runs timed out at 5.
const TIMEOUT_MS = 15 * 60 * 1000;

function fail(msg) {
  console.error(`oura-auth: ${msg}`);
  process.exit(1);
}

// Same discipline as hermes readSecretFile: refuse symlinks, group/other bits,
// foreign owners, and loose parent dirs, so a misconfigured checkout can't
// quietly serve credentials to another local user.
function readSecret(path, label) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    fail(`${label} missing at ${path}`);
  }
  if (!st.isFile() || st.isSymbolicLink()) fail(`${label} must be a regular file: ${path}`);
  if ((st.mode & 0o077) !== 0) fail(`${label} must be 0600: chmod 600 '${path}'`);
  if (st.uid !== process.getuid()) fail(`${label} must be owned by this user: ${path}`);
  const dir = lstatSync(dirname(path));
  if ((dir.mode & 0o777) !== 0o700) fail(`parent of ${label} must be 0700: chmod 700 '${dirname(path)}'`);
  const value = readFileSync(path, 'utf8').trim();
  if (!value || value.includes('\n')) fail(`${label} must be one non-empty line`);
  return value;
}

function writeTokensAtomically(tokens) {
  // PID-suffixed like gcalClient.mjs: the daemon's timer refresh writes the
  // same path, and a shared `.tmp` name interleaving with it destroys the
  // live pair and the .prev backup.
  const tmp = `${TOKENS_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  if (existsSync(TOKENS_FILE)) renameSync(TOKENS_FILE, `${TOKENS_FILE}.prev`);
  renameSync(tmp, TOKENS_FILE);
}

const clientId = readSecret(CLIENT_ID_FILE, 'oura client id');
const clientSecret = readSecret(CLIENT_SECRET_FILE, 'oura client secret');
const state = randomBytes(16).toString('hex');

const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state,
})}`;

const timeout = setTimeout(() => {
  fail(
    'no callback within 15 minutes. If the Oura page showed a redirect_uri error, ' +
    `edit the app at cloud.ouraring.com/oauth/applications so its redirect URI is exactly ${REDIRECT_URI}, then rerun.`,
  );
}, TIMEOUT_MS);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const finish = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="font-family: system-ui; margin: 4em"><h2>${body}</h2></body></html>`);
  };

  const err = url.searchParams.get('error');
  if (err) {
    finish(400, `Oura returned an error: ${err}`);
    fail(`authorize error: ${err} ${url.searchParams.get('error_description') ?? ''}`);
  }

  // Stray hits on the callback port (browser prefetch, port scans, an old tab)
  // must not kill the flow — reject them and keep waiting for the real
  // redirect. Only an explicit error from Oura (above) or the timeout ends us.
  const gotState = Buffer.from(url.searchParams.get('state') ?? '');
  const wantState = Buffer.from(state);
  if (gotState.length !== wantState.length || !timingSafeEqual(gotState, wantState)) {
    console.error('oura-auth: ignoring a callback hit with a wrong/missing state (stray request); still waiting');
    finish(400, 'Not the authorization this helper is waiting for — close this tab.');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    console.error('oura-auth: ignoring a callback hit with no code; still waiting');
    finish(400, 'Missing code parameter — close this tab.');
    return;
  }

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!tokenRes.ok) {
    const detail = (await tokenRes.text()).slice(0, 300);
    finish(500, 'Token exchange failed — see the terminal.');
    fail(`token exchange HTTP ${tokenRes.status}: ${detail}`);
  }
  const tokens = await tokenRes.json();
  if (!tokens.access_token || !tokens.refresh_token) {
    finish(500, 'Token response was missing fields — see the terminal.');
    fail(`token response missing access_token/refresh_token (keys: ${Object.keys(tokens).join(',')})`);
  }

  writeTokensAtomically({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type ?? 'Bearer',
    expires_in: tokens.expires_in ?? null,
    scope: tokens.scope ?? SCOPES,
    obtained_at: Date.now(),
  });

  // Prove the token works with the least-personal endpoint; report status only.
  const verify = await fetch('https://api.ouraring.com/v2/usercollection/personal_info', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  // The product is Intaglio Labs; "Hazlie" is the old name the bundle stopped
  // carrying. Same string, same fix, so the two callback pages do not drift.
  finish(200, 'Intaglio Labs is connected to Oura. You can close this tab.');
  clearTimeout(timeout);
  server.close();
  console.log(`oura-auth: tokens written to ${TOKENS_FILE} (0600, .prev backup kept)`);
  console.log(`oura-auth: verification call personal_info -> HTTP ${verify.status}`);
  process.exit(verify.ok ? 0 : 1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('oura-auth: waiting for the browser approval (15 minute limit)…');
  console.log(`oura-auth: if no tab opened, visit:\n${authorizeUrl}`);
  spawn('open', [authorizeUrl], { stdio: 'ignore', detached: true }).unref();
});
