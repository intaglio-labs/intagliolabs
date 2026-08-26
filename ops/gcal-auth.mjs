// One-time Google OAuth2 authorization for the calendar AND mail connectors.
//
// Run it on the Mac (`node ops/gcal-auth.mjs`), approve in the browser tab it
// opens, and it writes ~/.hazlie/secrets/gcal-tokens.json.
//
// THE NAME IS NARROWER THAN THE JOB, and knowingly so for now. This grants one
// Google account — calendar and mail — and `gcal-*` says calendar. The honest
// name is google-auth.mjs with google-tokens.json, and the reason it has not
// been renamed yet is blast radius, not disagreement: fifteen tracked files
// name `gcal`, including two that another session had open. The rename is
// cheapest while nothing is authorized (there is no token file to migrate), so
// it should happen soon — but a refactor across three sessions' files is not
// the same change as widening a scope, and running them together would make
// both harder to review. Documented rather than done (owner, 2026-08-26).
//
// WHY THIS EXISTS AT ALL (ui/AGENTS.md egress path 5, owner-decided
// 2026-08-19): the owner's calendar lives in Notion Calendar, which talks to
// Google directly and never syncs into macOS Calendar.app — measured on this
// seed, all three Google calendars registered there hold zero events. Google
// also ended basic-auth CalDAV on 2025-03-14, so a Gmail app password cannot
// reach Calendar. OAuth is the only remaining mechanism.
//
// SCOPE IS READ-ONLY AND STAYS READ-ONLY. `calendar.readonly` means the
// connector cannot create, move or delete an event even if a bug tried to;
// `gmail.readonly` means it cannot send, delete, or so much as mark a message
// read. Widening this scope is an egress-policy change, not a code change —
// so ops/EGRESS.json moved in the same commit that added the mail scope.
//
// WHY gmail.readonly AND NOT IMAP. The mail connector used to reach
// imap.gmail.com with a 16-character app password, which is a worse credential
// on both counts: the owner has to mint it by hand, and it carries the whole
// account rather than a scope. The obvious swap — keep IMAP, authenticate with
// XOAUTH2 — does not work here, and the reason is worth writing down because
// it is not obvious: Google does not accept `gmail.readonly` over IMAP. IMAP
// requires the full-mailbox scope instead — the bare mail domain, spelled as a
// URL, which is why it is described here rather than quoted: it looks exactly
// like a host to connectors/test/egress.test.mjs, and naming a host in order
// to say we do NOT reach it is how the ledger acquires a lie. That scope is
// read, write, delete and send. Taking that route would have handed this app the
// power to delete the owner's mail in order to gain the power to read it,
// which is the exact opposite of the promise in CLAUDE.md rule 5 and of what
// the calendar entry in the ledger already claims. So the mail connector moved
// off IMAP and onto the Gmail REST API instead, where read-only is real.
// (Owner decision 2026-08-26, presented as the trade it is.)
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
// ~~Two fixed filenames.~~ Resolved through connectors/lib/googleClients.mjs
// now, so --client picks a registered pair; the legacy files remain the client
// named "default" and are what every existing grant was issued by.
const CLIENT_ID_FILE = join(SECRETS_DIR, 'gcal-client-id.txt');
const CLIENT_SECRET_FILE = join(SECRETS_DIR, 'gcal-client-secret.txt');
// ~~const TOKENS_FILE = .../gcal-tokens.json~~ — gone with the single-account
// assumption. The path is now derived per account at write time; see
// writeTokensAtomically below and connectors/lib/googleAccounts.mjs.

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PORT = 8818; // 8817 is Oura's; running both at once must not collide
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
// Space-separated, which is what the OAuth2 spec and Google both expect. One
// grant covering both connectors: the owner signs in to Google once, not once
// per source, and there is a single refresh token to keep alive.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');
const TIMEOUT_MS = 15 * 60 * 1000;
// Print the authorize URL instead of opening a browser. Used by the connect
// server, which hands it to the app's own sign-in window.
const PRINT_URL = process.argv.includes('--print-url');
// WHICH OAUTH CLIENT TO SIGN IN WITH. An Internal client reaches only its own
// Workspace but never expires and has no cap; an External one reaches any
// Google account and is limited to 100 sensitive-scope logins for the LIFETIME
// of its project, never resettable, one spent per authorization. So the right
// client differs per account, and the grant records which issued it — Google
// will not renew a refresh token against a different one.
const CLIENT_ARG = (() => {
  const i = process.argv.indexOf('--client');
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : 'default';
})();

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

// ONE FILE PER ACCOUNT (owner, 2026-08-26: "i need to be able to add multiple
// mailboxes"). A Google grant authorizes ONE account — one mailbox, one
// calendar — so several mailboxes means several grants, and a single fixed
// TOKENS_FILE could only ever hold the last one. Re-running this script now
// ADDS an account instead of replacing the previous one.
//
// The address is written INTO the file as `account_email`, not just encoded in
// its name: the name is a slug and slugs are lossy (a.b@x.co and a-b@x.co slug
// alike), so reading an address back out of a filename would eventually label
// a row with the wrong mailbox. See connectors/lib/googleAccounts.mjs, which
// is the reader half of this contract.
function writeTokensAtomically(tokens, tokensFile) {
  const tmp = `${tokensFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  if (existsSync(tokensFile)) renameSync(tokensFile, `${tokensFile}.prev`);
  renameSync(tmp, tokensFile);
}

// WHICH ACCOUNT DID THE OWNER JUST APPROVE? Google does not say in the token
// response unless `openid`/`email` are among the scopes, and adding those to
// widen a read-only grant would be a scope change for a label. Both APIs we
// already hold answer it for free: Gmail's profile returns emailAddress, and
// the primary calendar's id IS the account address. Gmail first, calendar as
// the fallback, so a calendar-only grant still knows its own name.
async function discoverAccountEmail(accessToken) {
  const H = { Authorization: `Bearer ${accessToken}` };
  try {
    const r = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', { headers: H });
    if (r.ok) {
      const j = await r.json();
      if (typeof j.emailAddress === 'string' && j.emailAddress.includes('@')) return j.emailAddress;
    }
  } catch {}
  try {
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', { headers: H });
    if (r.ok) {
      const j = await r.json();
      if (typeof j.id === 'string' && j.id.includes('@')) return j.id;
    }
  } catch {}
  return null;
}

const accountSlug = (email) =>
  String(email).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');

if (process.argv.includes('--help')) {
  console.log(`gcal-auth — one-time Google authorization (Calendar + Gmail, read-only)

Before running this, create an OAuth client (once, in a browser):

  1. https://console.cloud.google.com/ → create or pick a project
  2. APIs & Services → Library → enable BOTH:
       "Google Calendar API"
       "Gmail API"   <- the plain one. "Gmail MCP API" is a different
                        product and does not grant mailbox access here.
  3. APIs & Services → OAuth consent screen
       User type depends on the account, and the difference is not cosmetic:

       INTERNAL — offered only when the project sits under a Google Workspace
         organisation, and the right answer when it is. No test-user list, no
         verification gate on a restricted scope, and REFRESH TOKENS DO NOT
         EXPIRE. It authorizes only accounts inside that org.

       EXTERNAL — the only option for a personal @gmail.com account. Fill app
         name + your email, then add yourself under "Test users": an app in
         Testing mode authorizes only its listed test users, and skipping that
         is the usual cause of "access_denied" at the consent screen.
         ~~This runbook said "User type: External" flatly.~~ That was written
         against a personal account and is wrong for a Workspace one, where
         External costs you a REFRESH TOKEN THAT EXPIRES EVERY 7 DAYS — which
         for a background connector means re-authorizing weekly, forever
         (found 2026-08-26, before it shipped, by reading the console rather
         than the instruction).
       Scopes (both):
         https://www.googleapis.com/auth/calendar.readonly
         https://www.googleapis.com/auth/gmail.readonly
       Google flags gmail.readonly as a RESTRICTED scope. On an EXTERNAL app
       it will mention verification; that applies to publishing to other
       people, and an app in Testing mode authorizes its listed test users
       without it. On an INTERNAL app the gate does not apply at all — the
       console says so: "Verification is not required since your app is
       configured with an Internal user type".
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

// Resolved through the client registry so --client works, and so a legacy
// install with only the two loose files keeps working untouched: they ARE the
// client named "default".
const chosen = (() => {
  if (CLIENT_ARG === 'default') {
    return {
      id: readSecret(CLIENT_ID_FILE, 'gcal client id'),
      secret: readSecret(CLIENT_SECRET_FILE, 'gcal client secret'),
    };
  }
  const path = join(SECRETS_DIR, `google-client-${CLIENT_ARG}.json`);
  if (!existsSync(path)) {
    fail(`no OAuth client named "${CLIENT_ARG}" at ${path}\n` +
      '  Register one, or omit --client to use the default pair.');
  }
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    if (!c.client_id || !c.client_secret) fail(`${path} needs client_id and client_secret`);
    return { id: c.client_id, secret: c.client_secret };
  } catch (error) {
    return fail(`${path} is not readable JSON: ${error.message}`);
  }
})();
const clientId = chosen.id;
const clientSecret = chosen.secret;
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

  // Ask WHO before writing, because the answer decides the filename. A grant
  // whose account cannot be identified is refused rather than filed under a
  // guess: an unnamed token file is one no connector can attribute a row to,
  // and a mailbox mislabelled is worse than a mailbox missing.
  const accountEmail = await discoverAccountEmail(tokens.access_token);
  if (!accountEmail) {
    finish(500, 'Authorized, but Google would not say which account. Nothing was saved.');
    clearTimeout(timeout);
    server.close();
    fail('could not determine the account address from either Gmail or Calendar; nothing written');
  }
  const tokensFile = join(SECRETS_DIR, `google-tokens-${accountSlug(accountEmail)}.json`);
  const replacing = existsSync(tokensFile);

  writeTokensAtomically({
    account_email: accountEmail,
    // The client that issued this grant. Refreshing against any other one is
    // refused by Google, so this is not bookkeeping — it is what makes a
    // second client possible at all.
    client: CLIENT_ARG,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type ?? 'Bearer',
    expires_in: tokens.expires_in ?? null,
    scope: tokens.scope ?? SCOPES,
    obtained_at: Date.now(),
  }, tokensFile);

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

  // ~~"Hazlie is connected to Google Calendar."~~ Two corrections in one
  // string (owner, 2026-08-26): the product is Intaglio Labs, which is what
  // the bundle has been called since it was renamed, and this grant is no
  // longer calendar-only — it carries gmail.readonly too, so naming one of
  // the two would understate what the owner just approved.
  finish(200, 'Intaglio Labs is connected to your Google account (Calendar and Gmail, read-only). You can close this tab.');
  clearTimeout(timeout);
  server.close();
  console.log(
    `gcal-auth: ${replacing ? 're-authorized' : 'added'} ${accountEmail}` +
    ` -> ${tokensFile} (0600, .prev backup kept)`
  );
  console.log('gcal-auth: run this again to add another mailbox; each account keeps its own file');
  console.log(`gcal-auth: verification calendarList -> HTTP ${verify.status}`);
  if (calendarCount !== null) console.log(`gcal-auth: ${calendarCount} calendars visible to this grant`);
  process.exit(verify.ok ? 0 : 1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('gcal-auth: waiting for the browser approval (15 minute limit)…');
  // --print-url: hand the URL to a CALLER that will show it, and open nothing.
  //
  // The app opens Google in its own window (widget/src/GoogleLogin.swift)
  // rather than kicking the owner out to their default browser, which is the
  // shape every other login in this product already has. The listener below is
  // unchanged either way — whatever renders the consent screen, Google
  // redirects to this process's loopback callback and the code is exchanged
  // here. The window is a viewport, not a participant.
  //
  // Printed on its own line with a fixed prefix so a caller can read it without
  // parsing prose, and flushed before anything else is logged.
  if (PRINT_URL) {
    console.log(`AUTHORIZE_URL ${authorizeUrl}`);
  } else {
    console.log(`gcal-auth: if no tab opened, visit:\n${authorizeUrl}`);
    spawn('open', [authorizeUrl], { stdio: 'ignore', detached: true }).unref();
  }
});
