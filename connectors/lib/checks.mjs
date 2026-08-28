// checks — the pure probe library behind connectors/doctor.mjs.
//
// Every check returns {name, status, detail, fix}: status is the closed set
// PASS | WARN | FAIL, detail says what was observed, and fix is the sentence a
// human acts on when status is not PASS. Checks never throw — an unexpected
// error becomes a FAIL whose detail is the error, because a doctor that dies
// mid-diagnosis is worse than one that reports the symptom.
//
// SELF-CONTAINED ON PURPOSE. This module imports Node built-ins only and
// nothing from the rest of connectors/lib: doctor is the tool that runs when
// the daemon is broken, so it must not share a failure mode with the code it
// diagnoses (a syntax error in a lib module the daemon and doctor both import
// would take out both).
//
// LOG-CONTENT POLICY BINDS HERE TOO: no probe may put corpus content — a
// message body, a note title, a health value — into a detail string. Counts,
// ids, modes, durations, and schema facts only. The SQLite probes read from
// sqlite_master, never from a content table, so there is no content to leak.

import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { helperAvailable } from './apple-data.mjs';

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';

function result(name, status, detail, fix = null) {
  if (status !== PASS && status !== WARN && status !== FAIL) {
    throw new Error(`check ${name} produced unknown status ${JSON.stringify(status)}`);
  }
  return { name, status, detail, fix };
}

// --- stable binary ------------------------------------------------------------

// The FDA grant attaches to the RESPONSIBLE process. In production that is
// Intaglio Labs.app: the daemon runs as a child of the app (Connectors.swift), so
// macOS asks whether the APP holds the grant, and the row a person switches on in
// System Settings is "intaglio labs" — never node, which nobody installed and
// nobody should be asked to trust with their whole disk. The
// version stamp (written by ops/setup-connectors.sh next to the binary) is how
// a later run notices that someone swapped the binary underneath the grant.
function checkStableBinary(home) {
  const name = 'stable-binary';
  const stablePath = join(home, '.hazlie', 'bin', 'node');
  const stampPath = join(home, '.hazlie', 'bin', 'node.version');
  let stableReal;
  try {
    stableReal = realpathSync(stablePath);
  } catch {
    return result(
      name,
      FAIL,
      `${stablePath} does not exist`,
      'run ops/setup-connectors.sh to install the stable binary, then grant it Full Disk Access'
    );
  }
  const runningReal = realpathSync(process.execPath);
  if (runningReal !== stableReal) {
    return result(
      name,
      FAIL,
      `doctor is running under ${runningReal}, not ${stablePath}`,
      'expected in a dev shell; production spawns the stable binary via launchd. ' +
        `Re-run as: ${stablePath} connectors/doctor.mjs`
    );
  }
  let stamp;
  try {
    stamp = readFileSync(stampPath, 'utf8').trim();
  } catch {
    return result(
      name,
      WARN,
      `running the stable binary (${process.version}) but ${stampPath} is missing`,
      're-run ops/setup-connectors.sh to write the version stamp'
    );
  }
  if (stamp !== process.version) {
    return result(
      name,
      WARN,
      `stable binary is ${process.version} but the stamp says ${stamp}`,
      'the binary changed since setup last ran — re-run ops/setup-connectors.sh and re-verify the FDA grant'
    );
  }
  return result(name, PASS, `${stablePath} (${process.version}, stamp matches)`);
}

// --- node:sqlite backup API ---------------------------------------------------

// The Apple-store read strategy leans on node:sqlite's Online Backup API for
// coherent snapshots of actively-written databases. It is experimental, so a
// Node upgrade could remove or rename it out from under a working install;
// assert the seam instead of discovering its absence inside a poll cycle.
function checkSqliteBackup() {
  const name = 'sqlite-backup-api';
  if (typeof sqlite.DatabaseSync !== 'function') {
    return result(name, FAIL, 'node:sqlite has no DatabaseSync', 'the stable binary must be Node >= 23 — re-run ops/setup-connectors.sh');
  }
  if (typeof sqlite.backup !== 'function') {
    return result(
      name,
      FAIL,
      `node:sqlite.backup is ${typeof sqlite.backup}, not a function`,
      'this Node build lacks the Online Backup API the store readers use — install a Node with node:sqlite backup() and re-run ops/setup-connectors.sh'
    );
  }
  return result(name, PASS, 'DatabaseSync and backup() are present');
}

// --- ~/.hazlie tree permissions -----------------------------------------------

// Everything under ~/.hazlie is Intaglio Labs-private state (secrets, the context DB,
// connector cursors, store snapshots in cache/). One group-readable directory
// quietly widens all of it, so the tree is checked as a whole rather than
// trusting whichever setup run created each piece.
const TREE_DIRS = ['bin', 'lib', 'cache', 'connectors', 'secrets', 'context', 'logs'];

function checkTreePerms(home) {
  const name = 'hazlie-tree-perms';
  const root = join(home, '.hazlie');
  const problems = [];
  const missing = [];
  const modeOf = (p) => {
    const info = statSync(p);
    if (!info.isDirectory()) return null;
    return info.mode & 0o777;
  };
  let rootMode;
  try {
    rootMode = modeOf(root);
  } catch {
    return result(name, FAIL, `${root} does not exist`, 'run ops/setup-llm.sh, then ops/setup-connectors.sh');
  }
  if (rootMode !== 0o700) problems.push(`.hazlie is ${rootMode.toString(8)}`);
  for (const child of TREE_DIRS) {
    const p = join(root, child);
    let mode;
    try {
      mode = modeOf(p);
    } catch {
      missing.push(child);
      continue;
    }
    if (mode !== 0o700) problems.push(`${child}/ is ${mode === null ? 'not a directory' : mode.toString(8)}`);
  }
  if (problems.length > 0) {
    return result(
      name,
      FAIL,
      `expected mode 0700 throughout; ${problems.join(', ')}`,
      `chmod 700 the named paths under ${root} (ops/setup-connectors.sh reasserts all of them)`
    );
  }
  if (missing.length > 0) {
    return result(
      name,
      WARN,
      `0700 where present; missing: ${missing.join(', ')}`,
      'run ops/setup-connectors.sh to create the full runtime tree'
    );
  }
  return result(name, PASS, `~/.hazlie and ${TREE_DIRS.length} children are 0700`);
}

// --- secrets ------------------------------------------------------------------

// Mirrors the discipline of readSecretFile() in ui/server/hermes.mjs without
// importing it (self-containment above): lstat so a symlink is rejected rather
// than followed, regular-file test, owner-only mode. Returns null when the
// file is fine, else the sentence describing what is wrong.
function secretFileProblem(filePath) {
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    return `unreadable (${error?.code ?? error})`;
  }
  if (!info.isFile()) return 'not a regular, non-symlink file';
  if ((info.mode & 0o077) !== 0) {
    return `mode ${(info.mode & 0o777).toString(8)}, must be 0600`;
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    return 'not owned by this user';
  }
  return null;
}

function checkGranolaSecret(home) {
  const name = 'secret-granola';
  const p = join(home, '.hazlie', 'secrets', 'granola-api-key.txt');
  const problem = secretFileProblem(p);
  if (problem === 'missing') {
    // WARN, not FAIL — the same reasoning checkOuraSecret states below. In
    // this module's semantics (see the startup preflight in daemon.mjs) WARN
    // means "not provisioned yet, disabled by design" and FAIL means broken,
    // and the daemon treats a FAIL as fatal to ITSELF, not to the one source:
    // provisioning the Mac Mini on 2026-08-19 it refused to start at all,
    // with calendar and oura both fully authorized, because this one file was
    // absent. Granola issues these keys only to Business/Enterprise
    // workspaces, so "not provisioned yet" is the normal state of a new
    // machine. A malformed or world-readable key stays FAIL below: that is
    // broken rather than absent.
    return result(
      name,
      WARN,
      `${p} is missing — granola connector disabled`,
      'save the Granola API key there (0600); the granola connector is disabled without it'
    );
  }
  if (problem) return result(name, FAIL, `${p}: ${problem}`, `chmod 600 ${p} (and make it a plain owner-owned file)`);
  return result(name, PASS, 'present, owner-only');
}

function checkOuraSecret(home) {
  const name = 'secret-oura';
  const p = join(home, '.hazlie', 'secrets', 'oura-tokens.json');
  const problem = secretFileProblem(p);
  if (problem === 'missing') {
    // WARN, not FAIL: the Oura OAuth helper that mints this file is future
    // work, and until it runs the oura connector is disabled by design.
    return result(
      name,
      WARN,
      `${p} is missing — oura connector disabled`,
      'run the Oura OAuth helper when it lands (ops/CONNECTORS.md, "The Oura connector")'
    );
  }
  if (problem) return result(name, FAIL, `${p}: ${problem}`, `chmod 600 ${p} (and make it a plain owner-owned file)`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return result(name, FAIL, `${p} is not valid JSON`, 're-run the Oura OAuth helper to re-mint the token file');
  }
  for (const field of ['access_token', 'refresh_token']) {
    if (typeof parsed?.[field] !== 'string' || parsed[field].length === 0) {
      return result(
        name,
        FAIL,
        `${p} lacks a ${field} string`,
        're-run the Oura OAuth helper; the connector needs both tokens to poll and to rotate'
      );
    }
  }
  return result(name, PASS, 'present, owner-only, carries access and refresh tokens');
}

// CHECK THE THING THE CONNECTOR ACTUALLY GATES ON.
//
// Twice now this has checked a credential nobody reads. First a bare
// `gmail-app-password.txt` while everything else read a per-account
// `gmail-app-password-<address>.txt`; that was fixed on 2026-08-25 by moving to
// the per-account name. Then mail moved to Google OAuth on 2026-08-26 --
// sources/mail.mjs's needs() reads accountsWithScope(GMAIL_SCOPE) and nothing
// else, and connect/ deleted the routes that wrote a password -- and this was
// left checking the pair that no longer decides anything.
//
// So it lied in BOTH directions on every install this branch produces: a working
// OAuth mailbox got "no mail.accounts[] in config.json -- mail connector
// disabled", with a fix line pointing at a password form that no longer exists;
// and an upgraded install with a leftover file got a PASS for a connector that
// runs on something else entirely. The first version of this comment was written
// to kill exactly that failure. Gating on the grant is what actually ends it.
//
// mail.accounts[] still exists, but only as per-account overrides
// (sources/mail.mjs) -- backfillDays and maxBodyBytes. It selects nothing, so it
// answers nothing here.
//
// Kept as WARN rather than FAIL: mail is opt-in, and a machine that never
// authorized it is not broken.
const GMAIL_SCOPE_URL = 'https://www.googleapis.com/auth/gmail.readonly';

// Read straight from disk rather than importing googleAccounts: this module is
// built-ins only by design (see its header), so the filename convention is
// re-stated here rather than reaching across for it.
function googleGrantFiles(home) {
  const dir = join(home, '.hazlie', 'secrets');
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith('google-tokens-') && n.endsWith('.json'))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function grantHasScope(path, scope) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const scopes = parsed?.scope ?? parsed?.scopes ?? '';
    const list = Array.isArray(scopes) ? scopes : String(scopes).split(/\s+/u);
    return { ok: list.includes(scope), stale: parsed?.stale === true || parsed?.problem != null };
  } catch {
    return { ok: false, stale: false, unreadable: true };
  }
}

function checkGmailSecret(home) {
  const name = 'secret-gmail';
  const authorized = [];
  const stale = [];
  const unreadable = [];

  for (const p of googleGrantFiles(home)) {
    // FAIL is daemon-fatal, so it stays reserved for a credential file that is
    // genuinely unsafe to hold -- not for one that is merely expired.
    const problem = secretFileProblem(p);
    if (problem && problem !== 'missing') {
      return result(name, FAIL, `${p}: ${problem}`, `chmod 600 ${p} (and make it a plain owner-owned file)`);
    }
    const scoped = grantHasScope(p, GMAIL_SCOPE_URL);
    if (scoped.unreadable) unreadable.push(p);
    else if (!scoped.ok) continue;
    else if (scoped.stale) stale.push(p);
    else authorized.push(p);
  }

  // A LEFTOVER PASSWORD IS A NOTE, NOT A VERDICT. It is no longer a credential
  // this product uses, so its presence says nothing about whether mail works --
  // but a secret sitting on disk that nothing reads is worth naming once.
  const strayCount = ['gmail-app-password.txt']
    .concat(
      (() => {
        try {
          return readdirSync(join(home, '.hazlie', 'secrets'))
            .filter((n) => n.startsWith('gmail-app-password-'));
        } catch {
          return [];
        }
      })()
    )
    .filter((n) => secretFileProblem(join(home, '.hazlie', 'secrets', n)) !== 'missing').length;
  const stray = strayCount > 0
    ? ` (${strayCount} leftover app-password file(s) are present, which nothing reads any more)`
    : '';

  if (unreadable.length > 0) {
    return result(
      name,
      WARN,
      `${unreadable.length} Google grant file(s) could not be parsed${stray}`,
      'run: node ops/gcal-auth.mjs   (re-authorize; a half-written token file is not recoverable)'
    );
  }
  if (authorized.length > 0) {
    return result(
      name,
      PASS,
      `${authorized.length} Google account(s) authorized for Gmail${
        stale.length > 0 ? `, ${stale.length} needing re-authorization` : ''
      }${stray}`
    );
  }
  if (stale.length > 0) {
    return result(
      name,
      WARN,
      `${stale.length} Google account(s) had Gmail access and it has since been revoked or expired${stray}`,
      'open the connect page and sign in with Google again'
    );
  }
  return result(
    name,
    WARN,
    `no Google account is authorized for Gmail — mail connector disabled${stray}`,
    'open the connect page and use "sign in with Google" to authorize mail'
  );
}

// --- hermes -------------------------------------------------------------------

// Probe WHERE INGEST WILL ACTUALLY WRITE, which is not always a local hermes.
// HAZLIE_HERMES_URL is what connectors/lib/ingestClient.mjs uses, so it must
// win here too. The case that first proved it — the personal Mac reaching the
// Mini's hermes through an SSH tunnel on a port deliberately NOT 8787 — is
// retired, but the rule outlives it: any install that points ingest somewhere
// other than the default needs the probe pointed at the same place.
//
// Reading only HERMES_PORT made the preflight probe that squatter, fail its
// identity check, and take the whole daemon down — while ingest, using the
// other variable, would have reached the right server. A health check that
// tests a different endpoint than the traffic it gates is worse than none.
function hermesBase(env, config) {
  const configured = env.HAZLIE_HERMES_URL;
  if (typeof configured === 'string' && configured.length > 0) {
    return configured.replace(/\/+$/u, '');
  }
  // Same fallback chain as the two ingest entry points (daemon.mjs, run.mjs):
  // env, then config.hermesUrl, then the design default. A doctor run in a
  // bare shell must probe the hermes that ingest would actually write to,
  // not the one a fresh install would have.
  if (typeof config?.hermesUrl === 'string' && config.hermesUrl.length > 0) {
    return config.hermesUrl.replace(/\/+$/u, '');
  }
  const port = Number(env.HERMES_PORT ?? 51789);
  return `http://127.0.0.1:${port}`;
}

// The same acceptance rule as ingestClient.mjs' canonicalLoopbackBase, and
// REPLICATED rather than imported on purpose: this module is built-ins-only
// (see the header) so that doctor cannot share a failure mode with the code it
// diagnoses. Returned as a problem string rather than thrown, because checks
// never throw.
//
// Both probes below need this because both spend a credential on whatever the
// URL names. HAZLIE_HERMES_URL is an environment variable and config.hermesUrl
// is a hand-edited file; either can be pointed off-box by a typo, and
// checkHermesStats then sends the 256-bit bearer there to find out whether it
// should have. Refusing to probe is the only answer that does not leak the
// token in the course of diagnosing it.
function loopbackProblem(base) {
  let url;
  try {
    url = new URL(String(base));
  } catch {
    return 'is not a URL';
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (url.protocol !== 'http:') return `is not plain http (${url.protocol.replace(':', '')})`;
  if (!loopback) return `is not loopback (host ${url.hostname})`;
  if (url.username || url.password) return 'carries credentials in the URL';
  if (url.pathname !== '/' || url.search || url.hash) return 'carries a path, query or fragment';
  return null;
}

const LOOPBACK_FIX =
  'point HAZLIE_HERMES_URL (or config.json "hermesUrl") at the loopback hermes, e.g. http://127.0.0.1:51789';

// This module is deliberately built-ins-only (see the header), so it cannot
// import loadConfig from daemon.mjs. It re-reads the file leniently instead:
// hermesUrl or nothing. Validation is not this module's job — a broken
// config fails loudly in loadConfig, and the checks then probe the default.
function readConfigLeniently(home) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(home, '.hazlie', 'connectors', 'config.json'), 'utf8')
    );
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Identity, not just liveness: a 200 from a port is only Hermes if the body
// is Hermes' exact health answer. Anything else means some OTHER process
// holds the port — at which point a caller that went on to POST would be
// sending household rows at a stranger. (Observed for real on 2026-08-19: a
// different local app serving HTML on :8787, which is why hermes moved to
// :51789 on this Mac.) Exported so run.mjs can gate hand-runs on the same
// probe the daemon's preflight uses.
export async function verifyHermesIdentity(base, { fetchImpl = fetch } = {}) {
  const offBox = loopbackProblem(base);
  if (offBox) {
    return { ok: false, detail: `hermes URL ${base} ${offBox}`, fix: LOOPBACK_FIX };
  }
  let res;
  try {
    res = await fetchImpl(`${base}/health`, {
      signal: AbortSignal.timeout(4000),
      // Without this a squatter on the port answers 302 to a host it controls,
      // that host returns {"ok":true}, and the identity gate this function
      // exists to be passes — after which the caller POSTs household rows to
      // the squatter. The loopback check above constrains where we START, not
      // where a reply can send us.
      redirect: 'error',
    });
  } catch (error) {
    return {
      ok: false,
      detail: `${base}/health unreachable (${error?.cause?.code ?? error?.name ?? error})`,
      fix: 'launchctl kickstart -k gui/$UID/io.intaglio.hermes (or bash ops/setup-connectors.sh)',
    };
  }
  const text = await res.text().catch(() => '');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  // Hermes' EXACT answer, per connectors/AGENTS.md: `{ok:true}` and nothing
  // else. `body?.ok === true` was too loose to do the job this function is
  // named for — it admits any JSON that happens to carry ok:true, which is
  // precisely what a health endpoint belonging to some OTHER service is most
  // likely to return. The key-count test is what makes it an identity check
  // rather than a liveness check. ui/server/hermes.mjs' /health carries a
  // comment forbidding new fields for this reason (Bridge.swift and
  // ops/setup-connectors.sh compare the same body verbatim).
  const keys = body === null || typeof body !== 'object' ? null : Object.keys(body);
  if (res.status !== 200 || keys === null || keys.length !== 1 || keys[0] !== 'ok' || body.ok !== true) {
    return {
      ok: false,
      detail: `${base}/health answered ${res.status} with a non-Hermes body — another process may hold the port`,
      fix: `lsof -nP -iTCP:${new URL(base).port} -sTCP:LISTEN  # see who holds the port, then point HAZLIE_HERMES_URL (or config.json "hermesUrl") at the real hermes`,
    };
  }
  return { ok: true };
}

async function checkHermesHealth(env, config) {
  const name = 'hermes-health';
  const base = hermesBase(env, config);
  const identity = await verifyHermesIdentity(base);
  if (!identity.ok) return result(name, FAIL, identity.detail, identity.fix);
  return result(name, PASS, `${base}/health is Hermes`);
}

async function checkHermesStats(env, home, config) {
  const name = 'hermes-stats';
  // The destination is settled BEFORE the token is read, not after. This probe
  // is the one place doctor spends the bearer, so an off-box URL has to end the
  // check while the secret is still on disk — reading it first and deciding
  // afterwards means a bad HAZLIE_HERMES_URL has already pulled the credential
  // into a process that is about to describe where it went.
  const base = hermesBase(env, config);
  const offBox = loopbackProblem(base);
  if (offBox) {
    return result(name, FAIL, `hermes URL ${base} ${offBox} — bearer not read`, LOOPBACK_FIX);
  }
  const tokenPath = env.HERMES_TOKEN_FILE ?? join(home, '.hazlie', 'secrets', 'hermes-token.txt');
  const problem = secretFileProblem(tokenPath);
  if (problem) {
    return result(name, FAIL, `bearer token ${tokenPath}: ${problem}`, 'run ops/setup-llm.sh to generate the Hermes token');
  }
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return result(name, FAIL, `${tokenPath} is not one 256-bit hex token`, 'rm the file and re-run ops/setup-llm.sh');
  }
  let res;
  try {
    // No Origin header on purpose: that is what selects Hermes' bearer
    // channel, the same channel every connector uses. Passing this check
    // therefore attests the exact auth path production writes ride.
    res = await fetch(`${base}/stats`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
      // This request carries the bearer. A redirect would carry it onward.
      redirect: 'error',
    });
  } catch (error) {
    return result(name, FAIL, `${base}/stats unreachable (${error?.cause?.code ?? error?.name ?? error})`, 'see hermes-health');
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return result(
      name,
      FAIL,
      `${base}/stats answered ${res.status}`,
      res.status === 401
        ? 'the token on disk does not match the one Hermes reads — check HERMES_TOKEN_FILE in the hermes agent, then re-run ops/setup-llm.sh'
        : 'see hermes-health'
    );
  }
  const body = await res.json().catch(() => null);
  if (typeof body?.rows !== 'number') {
    return result(name, FAIL, `${base}/stats returned an unexpected shape`, 'another process may hold the port; see hermes-health');
  }
  return result(name, PASS, `bearer channel ok, ${body.rows} context rows`);
}

// --- Full Disk Access probes ----------------------------------------------------
//
// These are REAL reads, not stat calls: TCC decides at open()/read(), so the
// only probe that proves anything is opening the protected store and pulling
// bytes out of it. Each probe opens the file read-only, checks the SQLite
// header, then opens a read-only connection and SELECTs a count from
// sqlite_master — schema facts only, never a content table.
//
// THE CAVEAT THAT MAKES SHELL RUNS LOOK BROKEN: macOS attributes a Full Disk
// Access grant to the RESPONSIBLE PROCESS, and for anything spawned from a
// shell that is the terminal app, not the app this daemon belongs to. Verified on
// this machine (2026-08-19): the same binary reads chat.db when spawned by
// something that holds the grant and is DENIED when a shell spawns it.
// So these probes only PASS under launchd; a dev shell will see FAILs that
// production will not, and the fix text says so instead of sending anyone off
// to re-grant a permission that is already granted.

const FDA_SHELL_CAVEAT =
  'if the grant exists (System Settings > Privacy & Security > Full Disk Access > "intaglio labs"), ' +
  'this FAIL is expected from a dev shell — TCC attributes the grant to the responsible process, ' +
  'so only a run spawned by something that holds it proves anything: ' +
  'launchctl submit -l io.intaglio.doctor -o /tmp/doctor.out -e /tmp/doctor.err -- ' +
  '~/.hazlie/bin/node <repo>/connectors/doctor.mjs --json  (then launchctl remove io.intaglio.doctor). ' +
  'If it fails there too, switch on "intaglio labs" under Full Disk Access — the app opens that pane ' +
  'for you and puts itself on screen as a draggable icon; ops/CONNECTORS.md has the runbook.';

const DENIED_CODES = new Set(['EPERM', 'EACCES']);

// One real read of one SQLite file. Returns {ok:true, detail} on success,
// {denied:true} on a TCC-shaped denial, {missing:true} when the file is not
// there, and {ok:false, detail} for anything else (e.g. the missing -shm edge
// on a WAL database whose owning app is closed — the FILE was readable, which
// is what FDA governs, so callers report that as WARN rather than FAIL).
function realReadSqlite(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true };
    if (DENIED_CODES.has(error?.code)) return { denied: true };
    return { ok: false, detail: `open failed: ${error?.code ?? error}` };
  }
  try {
    const header = Buffer.alloc(16);
    const n = readSync(fd, header, 0, 16, 0);
    if (n < 16 || !header.toString('latin1').startsWith('SQLite format 3')) {
      return { ok: false, detail: 'readable, but not a SQLite database' };
    }
  } catch (error) {
    if (DENIED_CODES.has(error?.code)) return { denied: true };
    return { ok: false, detail: `read failed: ${error?.code ?? error}` };
  } finally {
    closeSync(fd);
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(filePath, { readOnly: true });
    const { n } = db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    return { ok: true, detail: `read ok, ${Number(n)} schema objects` };
  } catch (error) {
    // Raw bytes came out above, so FDA itself is proven; this is a
    // SQLite-level refusal (commonly the WAL -shm sidecar being absent while
    // the owning app is closed, which a read-only connection cannot create).
    return { ok: false, fdaProven: true, detail: `file readable, SQLite open failed: ${error?.message ?? error}` };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function fdaResult(name, store, r) {
  if (r.denied) return result(name, FAIL, `${store}: open denied`, FDA_SHELL_CAVEAT);
  if (r.missing) return result(name, WARN, `${store}: file does not exist on this machine`, 'nothing to grant yet; re-check after the owning app has data');
  if (r.ok) return result(name, PASS, `${store}: ${r.detail}`);
  if (r.fdaProven) return result(name, WARN, `${store}: ${r.detail}`, 'FDA is proven (raw bytes read); the store reader handles this edge — see ops/CONNECTORS.md');
  return result(name, FAIL, `${store}: ${r.detail}`, FDA_SHELL_CAVEAT);
}

// Calendar and Contacts stopped needing Full Disk Access when the helper landed
// -- they reach the same data through EventKit and the Contacts framework, each
// of which has its own far narrower TCC permission. Reporting a missing FDA
// grant as THEIR problem is then just wrong: the grant buys those two sources
// nothing, and the owner acting on the report would be widening a permission
// for no reason. iMessage is not in this position and never will be; chat.db has
// no framework in front of it.
function fdaNotNeeded(name, api) {
  return result(
    name,
    PASS,
    `reached through ${api}, which needs no Full Disk Access`,
    ''
  );
}

function checkFdaImessage(home) {
  const p = join(home, 'Library', 'Messages', 'chat.db');
  return fdaResult('fda-imessage', p, realReadSqlite(p));
}

function checkFdaCalendar(home) {
  const name = 'fda-calendar';
  if (helperAvailable()) return fdaNotNeeded(name, 'EventKit');
  // Group Containers is where current macOS keeps the store; the legacy
  // ~/Library/Calendars path survives on upgraded systems. Probe in that
  // order and report the first path that exists — a denial counts as
  // existing, since TCC hides files by refusing access, not by ENOENT.
  const candidates = [
    join(home, 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb'),
    join(home, 'Library', 'Calendars', 'Calendar.sqlitedb'),
  ];
  for (const p of candidates) {
    const r = realReadSqlite(p);
    if (r.missing) continue;
    return fdaResult(name, p, r);
  }
  return result(
    name,
    WARN,
    'no Calendar.sqlitedb at the Group Containers or legacy path',
    'this macOS 27 seed may have moved the store — record the real path in ops/PROBES.md before building the calendar connector'
  );
}

function checkFdaContacts(home) {
  const name = 'fda-contacts';
  if (helperAvailable()) return fdaNotNeeded(name, 'the Contacts framework');
  const base = join(home, 'Library', 'Application Support', 'AddressBook');
  const stores = [];
  const top = join(base, 'AddressBook-v22.abcddb');
  stores.push(top);
  // Sources/* each hold their own store (one per account). Listing the
  // directory is itself TCC-gated, which makes a denial here as informative
  // as a denied read.
  let sourceListDenied = false;
  try {
    for (const entry of readdirSync(join(base, 'Sources'))) {
      stores.push(join(base, 'Sources', entry, 'AddressBook-v22.abcddb'));
    }
  } catch (error) {
    if (DENIED_CODES.has(error?.code)) sourceListDenied = true;
    // ENOENT: no Sources directory is a fine state (no synced accounts).
  }
  if (sourceListDenied) {
    return result(name, FAIL, `${join(base, 'Sources')}: listing denied`, FDA_SHELL_CAVEAT);
  }
  let okCount = 0;
  let lastDetail = '';
  for (const p of stores) {
    const r = realReadSqlite(p);
    if (r.denied) return result(name, FAIL, `${p}: open denied`, FDA_SHELL_CAVEAT);
    if (r.missing) continue;
    if (r.ok || r.fdaProven) {
      okCount += 1;
      lastDetail = r.detail;
    } else {
      return result(name, FAIL, `${p}: ${r.detail}`, FDA_SHELL_CAVEAT);
    }
  }
  if (okCount === 0) {
    return result(
      name,
      WARN,
      `no AddressBook stores under ${base}`,
      'this macOS 27 seed may have moved the store — record the real layout in ops/PROBES.md before building the contacts resolver'
    );
  }
  return result(name, PASS, `${okCount} store(s) readable (${lastDetail})`);
}

// --- network (opt-in: doctor --network) -----------------------------------------
//
// Off by default because a diagnosis of the local install should not open
// sockets to third parties as a side effect. NO LAN-listener checks live here
// or anywhere: the connectors daemon is loopback-only by design (the HAE LAN
// listener was removed with the Oura swap — ops/CONNECTORS.md), so there is
// deliberately nothing inbound to probe.

function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = connect({ host, port });
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, detail });
    };
    sock.setTimeout(timeoutMs, () => done(false, `no connect within ${timeoutMs}ms`));
    sock.once('connect', () => done(true, `tcp connect to ${host}:${port} ok`));
    sock.once('error', (error) => done(false, `${error?.code ?? error}`));
  });
}

async function checkNetGranola(home) {
  const name = 'net-granola';
  const keyPath = join(home, '.hazlie', 'secrets', 'granola-api-key.txt');
  const problem = secretFileProblem(keyPath);
  if (problem) {
    return result(name, WARN, `skipped: granola key ${problem}`, 'see secret-granola');
  }
  const key = readFileSync(keyPath, 'utf8').trim();
  let res;
  try {
    // The one approved Granola surface is the official REST API at
    // public-api.granola.ai (the host named in the egress policy; verified
    // live 2026-08-19 — api.granola.ai 404s the same path). /v1/folders is its
    // cheapest authenticated read, so a 200 attests key + reachability without
    // pulling any note content onto this machine.
    res = await fetch('https://public-api.granola.ai/v1/folders', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    return result(name, FAIL, `public-api.granola.ai unreachable (${error?.cause?.code ?? error?.name ?? error})`, 'check network/DNS; the granola poller will stall until this recovers');
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 200) return result(name, PASS, 'GET /v1/folders answered 200');
  if (res.status === 401 || res.status === 403) {
    return result(name, FAIL, `GET /v1/folders answered ${res.status} — key rejected`, 'replace ~/.hazlie/secrets/granola-api-key.txt with a valid key (Business/Enterprise entitlement required)');
  }
  return result(name, FAIL, `GET /v1/folders answered ${res.status}`, 'transient upstream trouble is possible; re-run --network before acting');
}

async function checkNetOura() {
  const name = 'net-oura';
  // TCP reachability only: without oura-tokens.json there is nothing to
  // authenticate with, and the point of this check is "would the poller be
  // able to reach Oura at all", which a socket answers.
  const r = await tcpProbe('api.ouraring.com', 443);
  if (r.ok) return result(name, PASS, r.detail);
  return result(name, FAIL, `api.ouraring.com:443 ${r.detail}`, 'check network/DNS; the oura poller will stall until this recovers');
}

// IS THE ANSWER MODEL THERE?
//
// There was no check for llama-server at all, on a doctor that checks hermes,
// connect, every secret and four network hosts. hermes now distinguishes three
// states for it -- unreachable (503), reached-and-errored (502), and
// reached-and-silent (504) -- and none of them reached this surface, so an
// owner whose model was down had a green doctor and a chat that could not
// answer.
//
// /health is unauthenticated and answers 200 only when the weights are loaded;
// while loading it answers 503 "Loading model", which is a WAIT, not a fault.
// Startup testing observed connection refusal, then loading, then healthy.
async function checkLlama({ fetchImpl = fetch } = {}) {
  const name = 'llama';
  const base = process.env.HAZLIE_LLAMA_URL ?? 'http://127.0.0.1:51780';
  let res;
  try {
    res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(4000) });
  } catch {
    // WARN, not FAIL: the model is not required for ingestion, and a machine
    // that has not finished setting one up is not broken. The chat says so for
    // itself now.
    return result(
      name,
      WARN,
      'llama-server is not answering — questions will report the model as down',
      'launchctl kickstart -k gui/$UID/io.intaglio.llama-server   (or run ops/setup-llm.sh)'
    );
  }
  if (res.status === 503) {
    return result(name, PASS, 'llama-server is loading its weights (answers in a few seconds)');
  }
  if (!res.ok) {
    return result(
      name,
      WARN,
      `llama-server answered ${res.status}`,
      'check ~/.hazlie/logs/llama-server.err.log'
    );
  }
  return result(name, PASS, 'llama-server is loaded and answering');
}

// PROBE THE HOST THE CONNECTOR ACTUALLY REACHES.
//
// This probed imap.gmail.com:993 -- correct while mail was IMAP, and a
// permanent FAIL the moment it was not. Mail moved to the Gmail API over
// www.googleapis.com on 2026-08-26, and imap.gmail.com went out of
// ops/EGRESS.json in the same change, so this was probing a host the project
// had just declared it does not talk to, and failing the doctor over it.
//
// Renamed with it: a check called `net-imap` that probes an HTTPS API is the
// same lie one layer down.
async function checkNetGmail() {
  const name = 'net-gmail';
  const r = await tcpProbe('www.googleapis.com', 443);
  if (r.ok) return result(name, PASS, r.detail);
  return result(
    name,
    FAIL,
    `www.googleapis.com:443 ${r.detail}`,
    'check network/DNS; the mail and calendar connectors will stall until this recovers'
  );
}

// --- runner ---------------------------------------------------------------------

// Every check runs even when earlier ones fail: doctor's job is the whole
// picture in one pass, not the first symptom. A check that itself throws is
// converted to a FAIL naming the check, so one broken probe cannot hide the
// other results.
// The bridges' privacy hardening, checked rather than remembered.
//
// WHY THIS EXISTS. site/privacy/index.html is about to tell the public that
// linking a chat platform pulls "new messages only -- no history", that the
// bridge never marks conversations read, and that it never reports you online
// or typing. All three are true today and none of them is enforced: they come
// from three settings in ~/.hazlie/matrix/*/config.yaml, a GITIGNORED file that
// bridges/README.md says to reapply with `yq` after any regeneration. A public
// promise resting on a step someone has to remember is the shape of claim this
// whole ledger exists to stop. Miss it once and the bridge does a bulk history
// pull, which also marks a pile of chats read on the real account -- the exact
// footprint the hardening exists to avoid.
//
// FAILS CLOSED. mautrix's own defaults are the permissive ones, so a setting we
// cannot find or cannot parse is reported as a problem, never as a pass. The
// cost of a false alarm is one look at a config; the cost of a false pass is a
// false sentence in a published privacy policy.
//
// READS NOTHING IT REPORTS. These config files hold as_token, hs_token and the
// harvested platform cookies. Nothing from the file body reaches a detail
// string -- only the setting name, the bridge's directory name, and whether the
// value matched. The log-content policy binds doctor too.
//
// The YAML here is scanned, not parsed: this module is built-ins-only (see the
// header) and a real parser is a dependency. It looks for one top-level key,
// then one child of it, which is all these three settings need.
// Resolves one dotted path by tracking indentation. Handles arbitrary depth
// because the bridges do not agree on shape: the bridgev2 bridges (meta,
// instagram, slack, telegram, twitter) put it at backfill.enabled, while
// mautrix-discord is the older generation and puts it four levels down at
// bridge.backfill.forward_limits.initial.dm. A two-level lookup silently
// reported discord as unconfigured no matter what its config said.
function yamlPathValue(text, path) {
  const stack = []; // [{ indent, key }]
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/gu, '  ');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/u);
    if (!match) continue;
    const indent = line.length - line.trimStart().length;
    const [, key, rest] = match;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });
    if (stack.length !== path.length) continue;
    if (stack.every((frame, i) => frame.key === path[i])) return rest.split('#')[0].trim();
  }
  return undefined;
}

// Backfill lives in two different places depending on the bridge's generation,
// and means two different things: a boolean in bridgev2, a per-chat-type
// message limit in the older discord bridge where 0 means off. Returns the
// observed value as a string plus whether it counts as "history is being
// pulled", so the caller does not have to know which shape it got.
function backfillState(text) {
  const modern = yamlPathValue(text, ['backfill', 'enabled']);
  if (modern !== undefined) return { where: 'backfill.enabled', found: modern, on: modern === 'true' };
  const legacy = yamlPathValue(text, ['bridge', 'backfill', 'forward_limits', 'initial', 'dm']);
  if (legacy !== undefined) {
    return {
      where: 'bridge.backfill.forward_limits.initial.dm',
      found: legacy,
      on: Number(legacy) !== 0,
    };
  }
  return { where: 'backfill.enabled', found: undefined, on: false };
}

// [topKey, childKey, wanted, severity].
//
// BACKFILL IS WANTED **ON**. Owner decision, 2026-08-22, explicitly:
// "all connections should pull bulk messages". This reverses what
// bridges/README.md § "Privacy hardening" set, and the reasoning it overrode is
// kept here rather than deleted, because it is the kind of thing a future
// reader will otherwise re-derive and re-apply: backfill was disabled to keep
// the bridge invisible on the remote account, since a bulk history pull marks
// many conversations READ on the real Meta/X/Slack account. That cost was
// accepted knowingly in exchange for Intaglio Labs having message history to reason
// over -- a bridge that starts empty is a memory that starts empty.
//
// So this probe now FAILS on backfill being off, which is the exact inverse of
// what it asserted when it was written an hour earlier. Recorded because the
// first version shipped a check that enforced a policy the owner did not hold.
//
// The other two are unchanged and still WARN: they are about the bridge's
// footprint on the remote account (never acting as you, never broadcasting that
// you are online), not about what Intaglio Labs gets to read, and nothing in the
// backfill decision touches them.
// NOT CHECKED: homeserver.presence. bridges/README.md tells you to set it, and
// this probe used to warn when it was missing — but the key DOES NOT EXIST in
// any of these bridge versions. Verified 2026-08-22 across all six configs: the
// bridges drop it on the config rewrite they do at startup, so it was a no-op
// being dutifully copied around, and warning about it produced a WARN that
// could never be cleared. A check nobody can satisfy gets ignored, and then so
// do the checks next to it. Presence, where it is controllable at all, is
// network.send_presence_on_typing (meta only, already false by default).
//
// Double puppeting IS real and IS the mechanism that matters: it is what would
// let a bridge act AS the owner rather than as a ghost, which is the only way
// read status could ever reach the remote account.
function doublePuppetState(text) {
  const modern = yamlPathValue(text, ['double_puppet', 'secrets']);
  if (modern !== undefined) return { where: 'double_puppet.secrets', found: modern, off: modern === '{}' };
  // discord's older generation spells it differently, and ships a placeholder
  // rather than an empty map.
  const legacy = yamlPathValue(text, ['bridge', 'double_puppet_server_map']);
  if (legacy !== undefined) {
    return {
      where: 'bridge.double_puppet_server_map',
      found: legacy === '' ? '(placeholder)' : legacy,
      off: legacy === '' || legacy === '{}',
    };
  }
  return { where: 'double_puppet', found: undefined, off: true };
}

// Exported so the suite can prove it FIRES, not just that it passes on a clean
// machine — a guard nobody has watched fail is a guard nobody knows works.
export function checkBridgeHardening(home) {
  const name = 'bridge-hardening';
  const root = join(home, '.hazlie', 'matrix');
  let dirs;
  try {
    dirs = readdirSync(root).filter((d) => {
      try {
        return statSync(join(root, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return result(name, PASS, 'no bridge configs present — nothing to harden');
  }

  const problems = [];
  let worst = PASS;
  let checked = 0;
  for (const dir of dirs) {
    const file = join(root, dir, 'config.yaml');
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // a bridge dir without a config is not yet configured
    }
    checked += 1;
    const backfill = backfillState(text);
    if (!backfill.on) {
      problems.push(`${dir}: ${backfill.where} is ${backfill.found ?? 'unset'} — history is NOT being pulled`);
      worst = FAIL;
    }
    const dp = doublePuppetState(text);
    if (!dp.off) {
      problems.push(`${dir}: ${dp.where} is ${dp.found} — bridge could act as the owner`);
      if (worst !== FAIL) worst = WARN;
    }
  }

  if (checked === 0) return result(name, PASS, 'no bridge configs present — nothing to harden');
  if (worst === PASS) {
    return result(
      name,
      PASS,
      `${checked} bridge config(s) match owner intent: history backfill on, double puppeting off`
    );
  }
  return result(
    name,
    worst,
    problems.join('; '),
    'set the named keys in ~/.hazlie/matrix/<bridge>/config.yaml, then restart that bridge: ' +
      "yq -i '.backfill.enabled = true | .homeserver.presence = false | .double_puppet.secrets = {}' config.yaml — " +
      'backfill ON is the owner decision of 2026-08-22 (all connections pull bulk history); ' +
      'presence and double_puppet stay off so the bridge never acts as you on the remote account. ' +
      'NOTE bridges/README.md § "Privacy hardening" still prints the old line with ' +
      'backfill = false; that half of it is superseded.'
  );
}

// --- connect ------------------------------------------------------------------

// The onboarding/link server the widget reads its connector list from. Nothing
// probed it until now, and that gap is what let a real outage sit unexplained
// for a day: the canonical ports moved on 2026-08-23 (connect 8788 -> 51788),
// the launch agent on the machine was still the copy rendered BEFORE the move,
// so connect went on answering on 8788 while Bridge.swift asked 51788. The only
// thing on the whole machine that said anything was the widget, drawing
// "connect service unreachable - status unknown" on every tile. hermes had
// checkHermesHealth to name exactly that failure for its own port. connect had
// nothing, so the doctor ran clean while half the app was dark.
//
// 401 IS THE PASS, and that is not a workaround. /api/status requires an
// authorized caller (connect/server.mjs), so an UNAUTHENTICATED probe answered
// 401 has proved two things at once: something holds the port, and that
// something knows this route and guards it. That is as much identity as can be
// had without spending the bearer, and this module's standing rule is to spend
// it as rarely as possible (see checkHermesStats, which reads the token only
// after the destination is settled). A 200 here would mean the route had
// stopped authenticating - worse news than a dead port - so it fails loudly
// instead of passing as "reachable".
function connectBase(env) {
  // The same override name the widget honours (Bridge.swift's connectBase), so
  // a second connect on another port is diagnosed by the same knob that made
  // it. Host is not configurable here for the same reason it is not there.
  const port = Number(env.HAZLIE_CONNECT_PORT ?? 51788);
  return `http://127.0.0.1:${port}`;
}

// The installed plist is a RENDERED COPY of the template, not a link to it.
// Once written, the two drift independently and nothing re-reads the template
// until setup runs again - which is the entire mechanism behind this failure,
// and is invisible from inside the repo because the repo's own copy is correct.
const CONNECT_STALE_AGENT_FIX =
  'if this is ECONNREFUSED, suspect a launch agent that predates a port move: the installed plist is a ' +
  'rendered COPY of ops/io.intaglio.connect.plist, so it keeps launching the old port forever. Confirm with ' +
  "`grep -A1 -- --port ~/Library/LaunchAgents/io.intaglio.connect.plist` and `lsof -nP -iTCP -sTCP:LISTEN | grep node`. " +
  'Re-render it with `bash ops/setup-connectors.sh` RUN FROM THE TREE THE AGENT LAUNCHES - setup substitutes ' +
  '@REPO@ with wherever it is run, so running it from a dev checkout silently repoints production at a tree ' +
  'someone may later git-checkout out from under it.';

export async function checkConnectHealth(env, { fetchImpl = fetch } = {}) {
  const name = 'connect-health';
  const base = connectBase(env);
  const offBox = loopbackProblem(base);
  if (offBox) {
    return result(name, FAIL, `connect URL ${base} ${offBox}`, 'HAZLIE_CONNECT_PORT must name a port on loopback');
  }
  let res;
  try {
    res = await fetchImpl(`${base}/api/status`, {
      signal: AbortSignal.timeout(4000),
      // Same reasoning as verifyHermesIdentity: without this a squatter answers
      // 302 to a host it controls and borrows that host's status code.
      redirect: 'error',
    });
  } catch (error) {
    return result(
      name,
      FAIL,
      `${base}/api/status unreachable (${error?.cause?.code ?? error?.name ?? error}) - ` +
        'in this state the widget draws every connector as "status unknown"',
      CONNECT_STALE_AGENT_FIX
    );
  }
  if (res.status === 401) {
    return result(name, PASS, `${base}/api/status is connect (401 to an unauthorized probe, as designed)`);
  }
  if (res.status === 404) {
    // Bridge.swift maps this to the tile's `noroute` notice, which reads
    // "connect service predates /api/status". That is one of two explanations
    // and the less alarming one; the other is a stranger on the port.
    return result(
      name,
      FAIL,
      `${base}/api/status answered 404 - either a connect older than the route, or another process holds the port`,
      `lsof -nP -iTCP:${new URL(base).port} -sTCP:LISTEN  # see who actually holds it`
    );
  }
  if (res.status === 200) {
    return result(
      name,
      FAIL,
      `${base}/api/status answered 200 to a probe carrying NO bearer - the route is not authenticating`,
      'connect/server.mjs must reject an unauthorized /api/status; an open route here is a live exposure of the ' +
        'connector list, not a warning to get to later'
    );
  }
  return result(
    name,
    FAIL,
    `${base}/api/status answered ${res.status}`,
    `lsof -nP -iTCP:${new URL(base).port} -sTCP:LISTEN  # confirm connect, not something else, holds the port`
  );
}

export async function runChecks({ network = false, home = homedir(), env = process.env } = {}) {
  const config = readConfigLeniently(home);
  const checks = [
    () => checkStableBinary(home),
    () => checkSqliteBackup(),
    () => checkTreePerms(home),
    () => checkGranolaSecret(home),
    () => checkOuraSecret(home),
    () => checkGmailSecret(home),
    () => checkHermesHealth(env, config),
    () => checkHermesStats(env, home, config),
    () => checkConnectHealth(env),
    // Local, like hermes and connect: it is a loopback service this machine runs,
    // not a host on the network, so it belongs in the default set rather than
    // behind --network.
    () => checkLlama(),
    () => checkFdaImessage(home),
    () => checkFdaCalendar(home),
    () => checkFdaContacts(home),
    () => checkBridgeHardening(home),
  ];
  if (network) {
    checks.push(() => checkNetGranola(home), () => checkNetOura(), () => checkNetGmail());
  }
  const results = [];
  for (const run of checks) {
    try {
      results.push(await run());
    } catch (error) {
      results.push(
        result(
          run.name || 'unknown-check',
          FAIL,
          `check itself threw: ${error?.message ?? error}`,
          'this is a doctor bug; report it'
        )
      );
    }
  }
  return results;
}
