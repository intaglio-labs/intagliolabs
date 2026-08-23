// Probe: can we poll health data from the Oura Ring API v2?
//
// The health connector is an Oura poller (owner decision, replacing the Apple
// Health / Health Auto Export LAN listener): health data arrives by outbound
// HTTPS to api.ouraring.com exactly like the Granola poller, which keeps the
// connectors daemon fully loopback-plus-approved-egress with NO LAN listener.
// Oura deprecated personal access tokens in December 2025, so API v2 access
// requires an OAuth2 application even for one person reading their own ring —
// hence a tokens FILE (access + refresh) rather than a bare key.
//
// Expected state today: the tokens file does not exist, because registering
// the OAuth2 app is a human step. In that state this probe prints BLOCKED with
// the exact steps — that is the correct current result, not an error.
//
// Token file contract (written by the future ops/oura-auth helper):
//   ~/.hazlie/secrets/oura-tokens.json — 0600 in the 0700 secrets dir,
//   JSON object with at least {access_token, refresh_token}, extra fields
//   (expires_at, client_id, ...) allowed.
//
// When tokens exist: GET /v2/usercollection/daily_sleep for the last 7 local
// days and report HTTP status + record COUNT only — never a value, never a
// date-of-record list. A 401 with tokens present means the access token has
// expired and the refresh flow (the helper's job, not this probe's) must run.
//
// Needs no FDA and no launchd; runs directly. No TTY assumed.
// Exit: 0 PASS · 2 BLOCKED (no tokens yet) · 1 FAIL.

import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const TOKENS_PATH = join(homedir(), '.hazlie', 'secrets', 'oura-tokens.json');

const done = (status, part, evidence) => {
  console.log(`${status} ${part}: ${evidence}`);
  console.log(`RESULT probe-oura: ${status}`);
  process.exit(status === 'PASS' ? 0 : status === 'BLOCKED' ? 2 : 1);
};

function readOuraTokens() {
  let info;
  try {
    info = lstatSync(TOKENS_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log(`BLOCKED oura tokens: ${TOKENS_PATH} does not exist. Human steps to unblock:`);
      console.log('  1. Sign in at https://cloud.ouraring.com/oauth/applications and register an');
      console.log('     OAuth2 application (Oura deprecated personal access tokens Dec 2025; v2');
      console.log('     needs an app even for personal use). Note the client id and secret.');
      console.log('  2. Run the ops/oura-auth helper (built in Phase 3) — it walks the');
      console.log('     authorization-code flow in a browser and writes the long-lived access +');
      console.log(`     refresh tokens to ${TOKENS_PATH} (0600).`);
      console.log('  3. Re-run this probe; it should then report the daily_sleep record count.');
      console.log('RESULT probe-oura: BLOCKED');
      process.exit(2);
    }
    throw error;
  }
  if (!info.isFile()) done('FAIL', 'oura tokens', 'tokens path must be a regular, non-symlink file');
  if ((info.mode & 0o077) !== 0) {
    done('FAIL', 'oura tokens', 'tokens file must not be accessible by group or other users');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    done('FAIL', 'oura tokens', 'tokens file must be owned by the connectors user');
  }
  const dirMode = statSync(dirname(TOKENS_PATH)).mode & 0o777;
  if (dirMode !== 0o700) {
    done('FAIL', 'oura tokens', `secrets directory must have mode 0700 (is ${dirMode.toString(8)})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
  } catch {
    done('FAIL', 'oura tokens', 'tokens file is not valid JSON');
  }
  for (const field of ['access_token', 'refresh_token']) {
    if (typeof parsed?.[field] !== 'string' || parsed[field].length === 0) {
      done('FAIL', 'oura tokens', `tokens JSON is missing a non-empty "${field}" string`);
    }
  }
  return parsed;
}

// Oura's date params are local calendar days, so format in local time — a UTC
// slice would clip or duplicate the edge day depending on the hour this runs.
function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const tokens = readOuraTokens();
const end = new Date();
const start = new Date(end.getTime() - 7 * 86_400_000);
const url =
  'https://api.ouraring.com/v2/usercollection/daily_sleep' +
  `?start_date=${localDate(start)}&end_date=${localDate(end)}`;

let res;
try {
  res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
} catch (error) {
  done('FAIL', 'oura preflight', `request failed: ${error.cause?.code ?? error.name}`);
}

if (res.status === 401) {
  done(
    'FAIL',
    'oura preflight',
    'HTTP 401 — access token rejected (expired?); run the ops/oura-auth refresh flow and retry'
  );
}
if (res.status !== 200) {
  done('FAIL', 'oura preflight', `HTTP ${res.status} from daily_sleep`);
}

let body;
try {
  body = await res.json();
} catch {
  done('FAIL', 'oura preflight', 'HTTP 200 but the body is not JSON');
}
if (!Array.isArray(body?.data)) {
  done(
    'FAIL',
    'oura preflight',
    `HTTP 200 but no "data" array (top-level keys: ${Object.keys(body ?? {}).join(', ') || '(none)'})`
  );
}
done(
  'PASS',
  'oura preflight',
  `HTTP 200; daily_sleep records in the last 7 days: ${body.data.length}`
);
