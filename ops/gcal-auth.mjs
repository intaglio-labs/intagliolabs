// One-time Google Calendar OAuth2 authorization for the calendar connector.
//
// Run it on the Mac (`node ops/gcal-auth.mjs`), approve in the browser tab it
// opens, and it writes ~/.hazlie/secrets/gcal-tokens.json.
//
// WHY THIS EXISTS AT ALL (ui/AGENTS.md egress path 5, owner-decided
// 2026-08-19): the owner's calendar lives in Notion Calendar, which talks to
// Google directly and never syncs into macOS Calendar.app — measured on this
// seed, all three Google calendars registered there hold zero events. Google
// also ended basic-auth CalDAV on 2025-03-14, so a Gmail app password cannot
// reach Calendar. OAuth is the only remaining mechanism.
//
// SCOPE IS READ-ONLY AND STAYS READ-ONLY. `calendar.readonly` means the
// connector cannot create, move or delete an event even if a bug tried to.
// Widening this scope is an egress-policy change, not a code change.
//
// Google requires the redirect URI to be HTTPS with exactly one exemption:
// loopback. That is why this binds 127.0.0.1 and why the connect flow is
// Mac-only. PKCE is used because Google mandates it for Desktop clients and
// because it makes an intercepted code useless on its own.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const SECRETS_DIR = join(homedir(), '.hazlie', 'secrets');
const CLIENT_ID_FILE = join(SECRETS_DIR, 'gcal-client-id.txt');
const CLIENT_SECRET_FILE = join(SECRETS_DIR, 'gcal-client-secret.txt');
const TOKENS_FILE = join(SECRETS_DIR, 'gcal-tokens.json');

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PORT = 8818; // 8817 is Oura's; running both at once must not collide
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';
const TIMEOUT_MS = 15 * 60 * 1000;

function fail(msg) {
  console.error(`gcal-auth: ${msg}`);
  process.exit(1);
}

// Same discipline as hermes readSecretFile and ops/oura-auth.mjs: refuse
// symlinks, group/other bits, foreign owners and loose parent dirs.
function readSecret(path, label) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    fail(
      `${label} missing at ${path}\n` +
        '  Create an OAuth client first — see the runbook printed by: node ops/gcal-auth.mjs --help'
    );
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
  const tmp = `${TOKENS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  if (existsSync(TOKENS_FILE)) renameSync(TOKENS_FILE, `${TOKENS_FILE}.prev`);
  renameSync(tmp, TOKENS_FILE);
}

if (process.argv.includes('--help')) {
  console.log(`gcal-auth — one-time Google Calendar authorization

Before running this, create an OAuth client (once, in a browser):

  1. https://console.cloud.google.com/ → create or pick a project
  2. APIs & Services → Library → enable "Google Calendar API"
  3. APIs & Services → OAuth consent screen
       User type: External. Fill app name + your email.
       Add yourself under "Test users" — an app in Testing mode only
       authorizes its listed test users, and skipping this is the usual
       cause of "access_denied" at the consent screen.
       Scope: ${SCOPES}
  4. APIs & Services → Credentials → Create credentials
       → OAuth client ID → Application type: **Desktop app**
       Desktop is required: Google allows a loopback redirect only for that
       client type, and loopback is the only non-HTTPS redirect it accepts.
  5. Copy the client id and secret into these files, owner-only:

     umask 077
     printf '%s\\n' 'YOUR_CLIENT_ID'     > ${CLIENT_ID_FILE}
     printf '%s\\n' 'YOUR_CLIENT_SECRET' > ${CLIENT_SECRET_FILE}
     chmod 600 ${CLIENT_ID_FILE} ${CLIENT_SECRET_FILE}

Then: node ops/gcal-auth.mjs

A refresh token arrives only with prompt=consent + access_type=offline, both
of which this helper sends. Without a refresh token the connector would stop
working in an hour, so this exits non-zero if one is absent.
`);
  process.exit(0);
}

const clientId = readSecret(CLIENT_ID_FILE, 'gcal client id');
const clientSecret = readSecret(CLIENT_SECRET_FILE, 'gcal client secret');
const state = randomBytes(16).toString('hex');

// PKCE: the verifier never leaves this process; only its SHA-256 goes out in
// the authorize URL, so a code intercepted in transit cannot be redeemed.
const codeVerifier = randomBytes(32).toString('base64url');
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state,
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
  // Google issues a refresh token ONLY with both of these, and only on the
  // first consent unless prompt=consent forces a fresh one. A connector that
  // cannot refresh is a connector that dies in an hour.
  access_type: 'offline',
  prompt: 'consent',
})}`;

const timeout = setTimeout(() => {
  fail(
    `no callback within 15 minutes. If Google showed a redirect_uri_mismatch, the OAuth client ` +
      `must be of type "Desktop app" (its allowed redirect is exactly ${REDIRECT_URI}).`
  );
}, TIMEOUT_MS);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
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
    finish(400, `Google returned an error: ${err}`);
    fail(
      `authorize error: ${err} ${url.searchParams.get('error_description') ?? ''}\n` +
        '  access_denied usually means your account is not listed under "Test users" on the consent screen.'
    );
  }

  // Stray hits (browser prefetch, an old tab, a port scan) must not kill the
  // flow — reject them and keep waiting. Same lesson as oura-auth.
  const gotState = Buffer.from(url.searchParams.get('state') ?? '');
  const wantState = Buffer.from(state);
  if (gotState.length !== wantState.length || !timingSafeEqual(gotState, wantState)) {
    console.error('gcal-auth: ignoring a callback with a wrong/missing state (stray request); still waiting');
    finish(400, 'Not the authorization this helper is waiting for — close this tab.');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    console.error('gcal-auth: ignoring a callback with no code; still waiting');
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
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    const detail = (await tokenRes.text()).slice(0, 300);
    finish(500, 'Token exchange failed — see the terminal.');
    fail(`token exchange HTTP ${tokenRes.status}: ${detail}`);
  }
  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    finish(500, 'Token response had no access token — see the terminal.');
    fail(`token response missing access_token (keys: ${Object.keys(tokens).join(',')})`);
  }
  if (!tokens.refresh_token) {
    finish(500, 'Google returned no refresh token — see the terminal.');
    fail(
      'token response carried no refresh_token. Google withholds it when the app was already\n' +
        '  authorized; revoke this app at https://myaccount.google.com/permissions and rerun.'
    );
  }

  writeTokensAtomically({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type ?? 'Bearer',
    expires_in: tokens.expires_in ?? null,
    scope: tokens.scope ?? SCOPES,
    obtained_at: Date.now(),
  });

  // Prove the grant works, and report how many calendars it can see — the
  // whole point of this connector is that Calendar.app could see none.
  const verify = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  let calendarCount = null;
  if (verify.ok) {
    try {
      calendarCount = (await verify.json()).items?.length ?? null;
    } catch {
      calendarCount = null;
    }
  }

  finish(200, 'Hazlie is connected to Google Calendar. You can close this tab.');
  clearTimeout(timeout);
  server.close();
  console.log(`gcal-auth: tokens written to ${TOKENS_FILE} (0600, .prev backup kept)`);
  console.log(`gcal-auth: verification calendarList -> HTTP ${verify.status}`);
  if (calendarCount !== null) console.log(`gcal-auth: ${calendarCount} calendars visible to this grant`);
  process.exit(verify.ok ? 0 : 1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('gcal-auth: waiting for the browser approval (15 minute limit)…');
  console.log(`gcal-auth: if no tab opened, visit:\n${authorizeUrl}`);
  spawn('open', [authorizeUrl], { stdio: 'ignore', detached: true }).unref();
});
