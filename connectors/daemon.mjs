// The connectors daemon: resident pollers that read the owner's own stores
// and services (iMessage, Calendar, IMAP mail, Granola's REST API, Oura's
// API) and write what they find into the context store through hermes'
// POST /ingest — never through a database handle of their own.
//
// NETWORK POSTURE — LOOPBACK-ONLY, STATED PLAINLY: this process opens NO
// listener of any kind. Its sockets are outbound only: loopback HTTP to
// hermes (HAZLIE_HERMES_URL, then config "hermesUrl", default 127.0.0.1:51789
// — the canonical port since 2026-08-20; an unrelated dev server squats 8787
// on the machine — an unrelated dev server commonly holds 8787), and outbound HTTPS to the
// approved endpoints in
// connectors/AGENTS.md (IMAP to the mail provider, Granola's REST API,
// Oura's API v2). An earlier design had a LAN listener here for Health Auto
// Export pushes; the owner replaced Apple-Health-via-HAE with the Oura Ring
// API (2026-08-19), health data now arrives by POLLING
// https://api.ouraring.com/v2/usercollection/* exactly like the Granola
// poller, and the listener — the one non-loopback surface this system ever
// contemplated — is gone with it. Adding any listener here is a design
// change, not a feature.
//
// Scheduling is a self-rescheduling setTimeout per source, never
// setInterval: an interval fires on the clock regardless of whether the
// previous run finished, and two overlapping runs of one source would race
// on its cursor and double-deliver its window. Rescheduling only after the
// run completes makes overlap structurally impossible; a slow run simply
// delays its own next pass. First runs are staggered ~10 s apart so five
// sources do not stampede hermes and the Apple stores in one instant.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runChecks } from './lib/checks.mjs';
import {
  DEFAULT_HERMES_BASE_URL,
  adminDeleteEntities,
  adminEntities,
  adminMaintain,
  adminPurge,
  adminRetain,
  canonicalLoopbackBase,
  ingest,
} from './lib/ingestClient.mjs';
import { assertOwnerOnlyFile, defaultHermesTokenPath } from './lib/secrets.mjs';
import { openStateDb, runCounts } from './lib/state.mjs';
import { createLogger } from './lib/log.mjs';
import { safeErrorFingerprint } from './lib/safeError.mjs';
import { createYearlyBackfill } from './lib/yearlyBackfill.mjs';
import {
  retentionPass,
  maintainPass,
  msUntilIdleWindow,
  isInsideIdleWindow,
  wipeLocalArtifacts,
} from './retain.mjs';
import { PLATFORMS, bridgeStatus } from '../connect/lib/bridge.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Matrix is the transport, not the thing a person connected. Its one /sync
// batches every social bridge, so Activity expands it into the platforms whose
// bridge database confirms a real signed-in account. This is deliberately
// local read-only status; an unlinked bridge is neither queued nor named.
function connectedSocialPlatforms() {
  return Object.entries(PLATFORMS)
    .filter(([id]) => bridgeStatus(id).connected)
    .map(([id, platform]) => ({ id, label: platform.label }));
}

// The closed set of connectors this daemon will ever schedule. A sources/
// module whose name is not here is a typo or an unreviewed data source, and
// both must fail loudly at startup rather than quietly begin polling.
export const CONNECTOR_NAMES = Object.freeze([
  'imessage',
  'calendar',
  'mail',
  'granola',
  'oura',
  'photos',
  'notes',
  'contacts',
  'notion',
  'files',
  'whatsapp',
  // The social bridges' DMs, read out of the local Matrix bus. One connector
  // for seven platforms: the row's `source` comes from which bridge's ghost
  // sent it (lib/matrixRows.mjs), so messenger and slack land as themselves.
  'matrix',
]);

// Settings deliberately keeps these integrations out of the current product
// surface. A hidden connector must also be inert: scheduling it anyway leaks
// implementation-in-progress into Activity and can touch data the person
// cannot enable or control from the app. Keep this in lockstep with
// widget/ui/connections.js's HIDDEN_CONNECTORS until each integration ships.
export const DEFAULT_DISABLED_CONNECTORS = Object.freeze([
  'oura', 'photos', 'files', 'notion', 'notes',
]);

// Connector name → the hermes `source` its rows land under. Oura is the
// health connector (entity ids stay health:<metric>:<date> /
// health:workout:<start_iso> — the id scheme names the data, not the
// vendor). Contacts maps to null because contacts never write corpus at all:
// they are resolution state in the local state.db only.
export const CONNECTOR_HERMES_SOURCE = Object.freeze({
  imessage: 'imessage',
  calendar: 'calendar',
  mail: 'mail',
  granola: 'granola',
  oura: 'health',
  photos: 'photos',
  notes: 'notes',
  contacts: null,
  notion: 'notion',
  files: 'files',
  whatsapp: 'whatsapp',
  // Unlike contacts, Matrix DOES write corpus — one source for every bridge.
  // Keep the full set here because run.mjs --purge uses this mapping too: a
  // null sentinel means "no corpus" and previously made a Matrix purge report
  // success while leaving every bridged message behind.
  matrix: Object.freeze([
    'messenger',
    'instagram',
    'twitter',
    'telegram',
    'discord',
    'slack',
    'linkedin',
  ]),
});

// What retention config may name: hermes sources that connectors own rows
// for. 'seed' is deliberately absent (dev fixtures are not this daemon's to
// expire).
export const RETENTION_SOURCES = Object.freeze([
  'imessage',
  'calendar',
  'mail',
  'granola',
  'health',
  'photos',
  'notes',
  'notion',
  'files',
  // Still written — by the matrix connector now, not an import.
  'linkedin',
  'whatsapp',
  // Written by the matrix connector, one source per bridged platform.
  'messenger',
  'instagram',
  'twitter',
  'telegram',
  'discord',
  'slack',
  'hazlie_digest',
]);

export function defaultConfigPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'config.json');
}

export function defaultCacheDir(home = homedir()) {
  return join(home, '.hazlie', 'cache');
}

export function defaultDaemonLockPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'daemon.lock');
}

export function defaultActivityPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'activity.json');
}

export function defaultSocialReimportPendingPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'social-reimport-v1.pending');
}

export function defaultSocialReimportCompletedPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'social-reimport-v1.completed');
}

export function disableMarkerPath(name, home = homedir()) {
  return join(home, '.hazlie', 'connectors', `${name}.disabled`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// One daemon owns the shared cursor database. A forced app stop used to leave
// its child running, and every relaunch added another scheduler. The lock
// refuses the second writer; the owner-PID watch at the CLI entry cleans this
// file after a forced app stop, so the next launch starts cleanly.
export function acquireDaemonLock({
  home = homedir(),
  pid = process.pid,
  isAlive = processIsAlive,
} = {}) {
  const path = defaultDaemonLockPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid, token, startedTs: Date.now() }) + '\n');
      return () => {
        try {
          const current = JSON.parse(readFileSync(path, 'utf8'));
          if (current?.token === token) unlinkSync(path);
        } catch {}
        try { closeSync(fd); } catch {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = 0;
      try { owner = Number(JSON.parse(readFileSync(path, 'utf8'))?.pid); } catch {}
      if (isAlive(owner)) return null;
      // A hard kill cannot run our cleanup handler. Only an unreadable/dead
      // owner is cleared; a live daemon always keeps its lock.
      try { unlinkSync(path); } catch {}
    }
  }
  return null;
}

function writeActivity(activity, path = defaultActivityPath()) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(activity) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
}

// Consume the marker written by setup-bridges' one-time full-history reset.
// The bridge databases are source-side state; this is the matching derived-
// data half. Purge every social Hermes source before forgetting Matrix's local
// cursors, then atomically rename the marker. If any purge fails, the pending
// marker and cursors survive so the next supervised daemon start safely retries
// (already-purged sources are idempotent).
export async function applyPendingSocialReimport({
  pendingPath = defaultSocialReimportPendingPath(),
  completedPath = defaultSocialReimportCompletedPath(),
  state,
  cacheDir = defaultCacheDir(),
  log,
  purge,
}) {
  if (!existsSync(pendingPath)) return { applied: false };
  if (typeof purge !== 'function') throw new Error('social reimport requires a purge function');
  assertOwnerOnlyFile(pendingPath, {
    label: 'social reimport marker',
    setupHint: 'rerun ops/setup-bridges.sh',
  });

  let deleted = 0;
  for (const source of CONNECTOR_HERMES_SOURCE.matrix) {
    const result = await purge({ source });
    deleted += result?.deleted ?? 0;
  }
  const local = wipeLocalArtifacts('matrix', { state, cacheDir, log });
  renameSync(pendingPath, completedPath);
  log?.info('social_history_reimport_ready', {
    sources: CONNECTOR_HERMES_SOURCE.matrix.length,
    deleted,
    cursorsDeleted: local.cursorsDeleted,
  });
  return { applied: true, deleted, ...local };
}

// --- config -------------------------------------------------------------------
//
// Closed key sets at every level, enforced with throws: an unknown key is a
// caller bug (usually a misspelling of one the daemon reads — `interval` for
// `intervals`, `backfill_days` for `backfillDays`) and silently ignoring it
// would turn "poll hourly" into "poll at the default" without anyone
// noticing until the bill or the gap.


const TOP_KEYS = Object.freeze([
  // Accepted and ignored. The role machinery (which machine runs which
  // connectors, for a two-machine split that no longer exists) was removed
  // 2026-08-22; every install now runs every source it has credentials for.
  // The KEY stays allowed because assertClosedKeys throws on unknown keys, and
  // an install whose config still says `role` must keep booting rather than
  // die on startup over a field that no longer does anything.
  'role',
  'selfName',
  // The owner's own email addresses beyond the mail-connector accounts —
  // aliases and old company addresses that ARE the owner. Read by the people
  // graph (ui/server/people/owner.mjs) so an alias is not mistaken for a
  // separate person; the connectors themselves do not use it.
  'ownerEmails',
  // Explicit graph identities marked by the owner as themselves. This is the
  // local fallback for sources whose identifiers are not email addresses.
  'ownerPersonKeys',
  // Explicit relationship-role corrections. The people graph supplies a local
  // message-derived guess; these owner choices replace it per stable key.
  'personRoles',
  // The same corrections scoped to one calendar year. Keeping this in the
  // daemon's closed schema is essential: the UI writes it into this shared
  // config, and rejecting it on the next launch would prevent every connector
  // from starting after the first year-specific edit.
  'personRolesByYear',
  'hermesUrl',
  'intervals',
  'mail',
  'imessage',
  'calendar',
  'granola',
  'oura',
  'photos',
  'notion',
  'files',
  'matrix',
  // Accepted and ignored for upgrade compatibility. LinkedIn used to be a
  // standalone export connector with an empty config section; removing the
  // key from this closed schema made every existing config carrying
  // `"linkedin": {}` fail before ANY connector could start.
  'linkedin',
  'retention',
]);
const MAIL_KEYS = Object.freeze([
  'host',
  'port',
  'user',
  'folders',
  'backfillDays',
  'maxBodyBytes',
  'accounts',
]);
// Per-account overrides. No nested `accounts`: one level of mailboxes, not a tree.
const MAIL_ACCOUNT_KEYS = Object.freeze([
  'host',
  'port',
  'user',
  'folders',
  'backfillDays',
  'maxBodyBytes',
]);
const IMESSAGE_KEYS = Object.freeze(['backfillDays']);
// `backend` selects where occurrences come from: the local macOS store
// (default) or Google's API. Never both — see the comment in
// sources/calendar.mjs run(); the two would delete each other's rows.
const CALENDAR_KEYS = Object.freeze(['backend']);
const CALENDAR_BACKENDS = Object.freeze(['local', 'google']);
const GRANOLA_KEYS = Object.freeze(['includeTranscripts']);
const OURA_KEYS = Object.freeze(['backfillDays']);
const PHOTOS_KEYS = Object.freeze(['backfillDays']);
const NOTION_KEYS = Object.freeze([]);
// Retired but still validated for upgrade compatibility. The export connector
// took no config, so only the empty object old installs already carry is valid.
const LINKEDIN_KEYS = Object.freeze([]);
// `roots` overrides the discovered cloud folders; `materializeDataless` is the
// opt-in that lets the walk OPEN online-only files. It defaults false and the
// validator states the cost, because turning it on on this Mac would pull
// 45.6 GB through the owner's iCloud on a timer. See lib/fileWalk.mjs.
const FILES_KEYS = Object.freeze(['roots', 'materializeDataless']);

// Below one minute a poller is a busy-loop against stores and rate-limited
// APIs; nothing this daemon reads updates that fast (the courier's 2 s loop
// is a different process with a different design).
const MIN_INTERVAL_S = 60;
export const DEFAULT_INTERVAL_S = 900;
const FIRST_RUN_STAGGER_MS = 10_000;

function configError(message) {
  return new Error(`config.json: ${message}`);
}

function assertClosedKeys(obj, allowed, where) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw configError(`${where} must be a JSON object`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw configError(
        `unknown key ${JSON.stringify(key)} in ${where}; allowed: ${allowed.join(', ') || '(none)'}`
      );
    }
  }
}

function assertPositiveInt(value, where, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(`${where} must be an integer between ${min} and ${max}`);
  }
}

const RELATIONSHIP_ROLES = Object.freeze(['friend', 'business', 'romantic', 'family']);

function assertPersonRoles(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(`${where} must be an object`);
  }
  for (const [key, role] of Object.entries(value)) {
    if (key.length === 0 || key.length > 300 || !RELATIONSHIP_ROLES.includes(role)) {
      throw configError(`${where} values must be friend, business, romantic, or family`);
    }
  }
}

export function validateConfig(raw) {
  assertClosedKeys(raw, TOP_KEYS, 'the top level');
  if (raw.selfName !== undefined && (typeof raw.selfName !== 'string' || raw.selfName.length === 0)) {
    throw configError('"selfName" must be a non-empty string');
  }
  for (const [field, values] of [['ownerEmails', raw.ownerEmails], ['ownerPersonKeys', raw.ownerPersonKeys]]) {
    if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 300))) {
      throw configError(`"${field}" must be an array of non-empty strings`);
    }
  }
  if (raw.personRoles !== undefined) {
    assertPersonRoles(raw.personRoles, '"personRoles"');
  }
  if (raw.personRolesByYear !== undefined) {
    if (raw.personRolesByYear === null || typeof raw.personRolesByYear !== 'object' || Array.isArray(raw.personRolesByYear)) {
      throw configError('"personRolesByYear" must be an object');
    }
    for (const [year, roles] of Object.entries(raw.personRolesByYear)) {
      const numericYear = Number(year);
      if (!/^\d{4}$/u.test(year) || numericYear < 1900 || numericYear > 3000) {
        throw configError('"personRolesByYear" keys must be years from 1900 through 3000');
      }
      assertPersonRoles(roles, `"personRolesByYear.${year}"`);
    }
  }
  // The per-machine hermes address, for Macs where the canonical port (51789)
  // is taken by something else.
  // Env still wins — the launchd plists set HAZLIE_HERMES_URL explicitly —
  // but hand-run `node run.mjs <source>` reads its target from here instead
  // of silently POSTing corpus rows at whatever holds the default port.
  // Same acceptance rule as every ingest call: HTTP, loopback, bare origin.
  if (raw.hermesUrl !== undefined) {
    try {
      canonicalLoopbackBase(raw.hermesUrl);
    } catch {
      throw configError('"hermesUrl" must be an HTTP loopback origin, e.g. "http://127.0.0.1:51789"');
    }
  }
  if (raw.intervals !== undefined) {
    // `intervals.linkedin` belonged to the retired export poller. Accept it as
    // a no-op so an upgrade keeps booting; Matrix has its own interval now.
    assertClosedKeys(raw.intervals, [...CONNECTOR_NAMES, 'linkedin'], '"intervals"');
    for (const [name, seconds] of Object.entries(raw.intervals)) {
      assertPositiveInt(seconds, `intervals.${name} (seconds)`, { min: MIN_INTERVAL_S, max: 86_400 });
    }
  }
  if (raw.mail !== undefined) {
    assertClosedKeys(raw.mail, MAIL_KEYS, '"mail"');
    if (raw.mail.host !== undefined && (typeof raw.mail.host !== 'string' || !raw.mail.host)) {
      throw configError('mail.host must be a non-empty string');
    }
    if (raw.mail.port !== undefined) assertPositiveInt(raw.mail.port, 'mail.port', { max: 65_535 });
    if (raw.mail.user !== undefined && (typeof raw.mail.user !== 'string' || !raw.mail.user)) {
      throw configError('mail.user must be a non-empty string');
    }
    if (raw.mail.folders !== undefined) {
      if (
        !Array.isArray(raw.mail.folders) ||
        raw.mail.folders.length === 0 ||
        raw.mail.folders.some((f) => typeof f !== 'string' || !f)
      ) {
        throw configError('mail.folders must be a non-empty array of folder names');
      }
    }
    if (raw.mail.backfillDays !== undefined) {
      assertPositiveInt(raw.mail.backfillDays, 'mail.backfillDays', { max: 3650 });
    }
    if (raw.mail.maxBodyBytes !== undefined) {
      assertPositiveInt(raw.mail.maxBodyBytes, 'mail.maxBodyBytes', { min: 1024 });
    }
    // Several mailboxes, because Gmail issues app passwords per account and
    // the owner's mail is split across addresses. The keys outside `accounts`
    // stay as the defaults every account inherits, so the single-account
    // spelling keeps working unchanged.
    if (raw.mail.accounts !== undefined) {
      if (!Array.isArray(raw.mail.accounts) || raw.mail.accounts.length === 0) {
        throw configError('mail.accounts must be a non-empty array of {user, ...} objects');
      }
      const seen = new Set();
      for (const [i, account] of raw.mail.accounts.entries()) {
        if (account === null || typeof account !== 'object' || Array.isArray(account)) {
          throw configError(`mail.accounts[${i}] must be an object`);
        }
        assertClosedKeys(account, MAIL_ACCOUNT_KEYS, `"mail.accounts[${i}]"`);
        if (typeof account.user !== 'string' || !account.user) {
          throw configError(`mail.accounts[${i}].user must be a non-empty string`);
        }
        // A duplicate address would mean two rows racing for one secret file.
        if (seen.has(account.user)) {
          throw configError(`mail.accounts lists "${account.user}" more than once`);
        }
        seen.add(account.user);
        if (account.port !== undefined) {
          assertPositiveInt(account.port, `mail.accounts[${i}].port`, { max: 65_535 });
        }
        if (account.backfillDays !== undefined) {
          assertPositiveInt(account.backfillDays, `mail.accounts[${i}].backfillDays`, { max: 3650 });
        }
        if (account.folders !== undefined) {
          if (
            !Array.isArray(account.folders) ||
            account.folders.length === 0 ||
            account.folders.some((f) => typeof f !== 'string' || !f)
          ) {
            throw configError(`mail.accounts[${i}].folders must be a non-empty array`);
          }
        }
      }
    }
  }
  if (raw.imessage !== undefined) {
    assertClosedKeys(raw.imessage, IMESSAGE_KEYS, '"imessage"');
    if (raw.imessage.backfillDays !== undefined) {
      assertPositiveInt(raw.imessage.backfillDays, 'imessage.backfillDays', { max: 3650 });
    }
  }
  if (raw.photos !== undefined) {
    assertClosedKeys(raw.photos, PHOTOS_KEYS, '"photos"');
    if (raw.photos.backfillDays !== undefined) {
      assertPositiveInt(raw.photos.backfillDays, 'photos.backfillDays', { max: 36500 });
    }
  }
  if (raw.notion !== undefined) {
    assertClosedKeys(raw.notion, NOTION_KEYS, '"notion"');
  }
  if (raw.linkedin !== undefined) {
    assertClosedKeys(raw.linkedin, LINKEDIN_KEYS, '"linkedin"');
  }
  if (raw.files !== undefined) {
    assertClosedKeys(raw.files, FILES_KEYS, '"files"');
    if (raw.files.roots !== undefined) {
      if (!Array.isArray(raw.files.roots) || raw.files.roots.length === 0) {
        throw configError('files.roots must be a non-empty array of {label, path}');
      }
      for (const [i, root] of raw.files.roots.entries()) {
        assertClosedKeys(root, ['label', 'path'], `files.roots[${i}]`);
        for (const key of ['label', 'path']) {
          if (typeof root[key] !== 'string' || root[key].length === 0) {
            throw configError(`files.roots[${i}].${key} must be a non-empty string`);
          }
        }
        // A relative root resolves against the daemon's cwd, which under
        // launchd is `/`. That silently walks the wrong tree rather than
        // failing, so it is refused here.
        if (!root.path.startsWith('/')) {
          throw configError(`files.roots[${i}].path must be absolute`);
        }
      }
    }
    if (raw.files.materializeDataless !== undefined) {
      if (typeof raw.files.materializeDataless !== 'boolean') {
        throw configError('files.materializeDataless must be a boolean');
      }
      if (raw.files.materializeDataless === true) {
        // Not refused — it is the owner's call — but it must not be possible
        // to enable it without the number being said out loud somewhere.
        throw configError(
          'files.materializeDataless is not implemented. Enabling it would download every ' +
            'online-only file in the configured roots. Implement it deliberately, with a size ' +
            'budget and explicit user confirmation, before setting this.'
        );
      }
    }
  }
  if (raw.calendar !== undefined) {
    assertClosedKeys(raw.calendar, CALENDAR_KEYS, '"calendar"');
    if (raw.calendar.backend !== undefined && !CALENDAR_BACKENDS.includes(raw.calendar.backend)) {
      throw configError(`calendar.backend must be one of: ${CALENDAR_BACKENDS.join(', ')}`);
    }
  }
  if (raw.granola !== undefined) {
    assertClosedKeys(raw.granola, GRANOLA_KEYS, '"granola"');
    if (
      raw.granola.includeTranscripts !== undefined &&
      typeof raw.granola.includeTranscripts !== 'boolean'
    ) {
      throw configError('granola.includeTranscripts must be a boolean');
    }
  }
  if (raw.oura !== undefined) {
    assertClosedKeys(raw.oura, OURA_KEYS, '"oura"');
    if (raw.oura.backfillDays !== undefined) {
      assertPositiveInt(raw.oura.backfillDays, 'oura.backfillDays', { max: 3650 });
    }
  }
  if (raw.retention !== undefined) {
    assertClosedKeys(raw.retention, [...RETENTION_SOURCES, 'maintainHour'], '"retention"');
    for (const [key, value] of Object.entries(raw.retention)) {
      if (key === 'maintainHour') {
        if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
          throw configError('retention.maintainHour must be "HH:MM" (24-hour)');
        }
      } else {
        assertPositiveInt(value, `retention.${key} (days)`, { max: 3650 });
      }
    }
  }
  return raw;
}

// config.json is held to the secret-file standard even though it holds no
// credential: it names the mail account, folders, and the household's data
// sources, and it is the file whose silent replacement would redirect what
// this daemon polls.
export function loadConfig(path = defaultConfigPath()) {
  const raw = assertOwnerOnlyFile(path, {
    label: 'connectors config',
    setupHint: 'create ~/.hazlie/connectors/config.json (see ops/CONNECTORS.md)',
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError(`not valid JSON: ${path}`);
  }
  return validateConfig(parsed);
}

// Split a preflight result list into what stops the daemon and what only stops
// one source. Pure, so the policy can be tested without a TCC state to stand in
// — which matters here specifically, because a process launched from a terminal
// inherits the TERMINAL's Full Disk Access and reports a pass that says nothing
// about the app. The rule cannot be verified by running this from a shell; it
// can be verified from a fixture.
//
// The mapping is the naming convention: a check called `fda-<source>` is that
// source's grant. Everything else is foundational and fatal.
export function partitionChecks(results) {
  const failed = (Array.isArray(results) ? results : []).filter((r) => r?.status === 'FAIL');
  const isFda = (r) => typeof r.name === 'string' && r.name.startsWith('fda-');
  return {
    fatal: failed.filter((r) => !isFda(r)),
    fdaBlocked: new Set(failed.filter(isFda).map((r) => r.name.slice(4))),
  };
}

// --- sources ------------------------------------------------------------------
//
// The source contract: each connectors/sources/<name>.mjs default-exports
//   { name, needs(), run(ctx) }
// where `name` ∈ CONNECTOR_NAMES, `needs()` returns an array of
// human-readable missing prerequisites (empty = ready; e.g. "oura token file
// missing: run setup"), and `run(ctx)` does one full poll pass and returns
// {ingested, updated, unchanged, deleted} counts. needs() is re-checked
// before every run, so provisioning a secret un-blocks a source without a
// daemon restart. The directory is empty until Phase 4 — an empty roster is
// a warning, not an error.
export async function loadSources(dir = join(here, 'sources')) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const sources = [];
  const seen = new Set();
  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const source = mod.default;
    if (
      source === null ||
      typeof source !== 'object' ||
      !CONNECTOR_NAMES.includes(source.name) ||
      typeof source.needs !== 'function' ||
      typeof source.run !== 'function'
    ) {
      throw new Error(
        `sources/${file} must default-export {name ∈ ${CONNECTOR_NAMES.join('|')}, needs(), run(ctx)}`
      );
    }
    if (seen.has(source.name)) throw new Error(`duplicate source "${source.name}" (sources/${file})`);
    seen.add(source.name);
    sources.push(source);
  }
  return sources;
}

// --- the daemon -----------------------------------------------------------------

export function createDaemon({
  config,
  state,
  log,
  sources,
  ingestOpts,
  cacheDir = defaultCacheDir(),
  now = Date.now,
}) {
  const timers = new Set();
  const nextRuns = new Map();
  let stopped = false;
  const historyRoster = sources.filter((source) => source.walksHistory === true)
    .map((source) => source.name);
  const yearlyBackfill = createYearlyBackfill({ state, connectors: historyRoster, now });

  // The settings queue is derived from the scheduler itself, not guessed from
  // a polling interval in the UI. Keep every queued source in chronological
  // order so the compact activity line can expand into the next real tasks.
  const scheduledQueue = () => [...nextRuns.entries()]
    .flatMap(([connector, nextTs]) => {
      if (connector !== 'matrix') return [{ connector, nextTs }];
      return connectedSocialPlatforms().map((platform) => ({
        connector,
        platform: platform.id,
        label: platform.label,
        nextTs,
      }));
    })
    .sort((a, b) => a.nextTs - b.nextTs);
  const intervalMsFor = (connector) =>
    (config.intervals?.[connector] ?? DEFAULT_INTERVAL_S) * 1000;
  // TOTAL QUEUE HORIZON, not the duration of the first/current row. The owner
  // asked for one pinned answer to "when is all the work in this queue done?".
  // Routine passes contribute their actual scheduler deadlines (including the
  // idle-window maintenance pass); resumable Calendar/Matrix history can extend
  // that horizon across additional bounded passes. Matrix pagination is opaque,
  // so this remains deliberately approximate rather than claiming precision.
  const totalWorkEstimate = () => {
    const nowMs = now();
    const completionTimes = scheduledQueue().map((task) => task.nextTs);
    const yearly = yearlyBackfill.snapshot();
    const backfill = yearly.pending;

    if (backfill.includes('calendar')) {
      const ceiling = positiveNumber(
        state.getCursor(CALENDAR_HISTORY_CURSOR_KEY),
        nowMs - 90 * 86_400_000
      );
      const remainingSlices = Math.max(
        1,
        Math.ceil((ceiling - CALENDAR_HISTORY_FLOOR_TS) / (365 * 86_400_000))
      );
      const slicesPerPass = positiveNumber(state.getCursor(HISTORY_RATE_KEY('calendar')), 20);
      const passes = Math.ceil(remainingSlices / slicesPerPass);
      const first = nextRuns.get('calendar') ?? nowMs + intervalMsFor('calendar');
      completionTimes.push(first + Math.max(0, passes - 1) * intervalMsFor('calendar'));
    }

    if (backfill.includes('matrix')) {
      const rooms = matrixHistoryRooms(state.getCursor('matrix:history-rooms'));
      if (rooms > 0) {
        const pagesPerPass = positiveNumber(state.getCursor(HISTORY_RATE_KEY('matrix')), 3);
        const minimumPasses = Math.ceil(rooms / pagesPerPass);
        const first = nextRuns.get('matrix') ?? nowMs + intervalMsFor('matrix');
        completionTimes.push(first + Math.max(0, minimumPasses - 1) * intervalMsFor('matrix'));
      }
    }

    if (completionTimes.length === 0) return null;
    const completion = Math.max(...completionTimes);
    const tenthsOfAnHour = Math.max(1, Math.round((completion - nowMs) / 360_000));
    // The estimate says that multi-pass work exists; `backfill` says which
    // source owns it. Keep it in next-run order so the orb can name the source
    // whose history slice will resume first while the daemon rests between
    // bounded passes.
    backfill.sort((a, b) => (nextRuns.get(a) ?? Infinity) - (nextRuns.get(b) ?? Infinity));
    return {
      estimate: `~ ${(tenthsOfAnHour / 10).toFixed(1)} hrs left`,
      backfill,
      ...(!yearly.complete ? { backfillYear: yearly.year } : {}),
    };
  };
  const publishActivity = (activity) => {
    const total = totalWorkEstimate();
    writeActivity({ ...activity, queue: scheduledQueue(), ...(total ?? {}) });
  };
  const publishWaiting = () => {
    const next = scheduledQueue()[0];
    if (next) publishActivity({ phase: 'waiting', ...next });
  };

  const admin = {
    retain: (args) => adminRetain(args, ingestOpts),
    purge: (args) => adminPurge(args, ingestOpts),
    deleteEntities: (args) => adminDeleteEntities(args, ingestOpts),
    maintain: () => adminMaintain(ingestOpts),
    entities: (args) => adminEntities(args, ingestOpts),
  };

  // HISTORY RUNS IN THE BACKGROUND, NEWEST-FIRST, AND IT HAS TO BE SCHEDULED.
  //
  // `backfill: false` was hardcoded here, and a source's forward cursor only
  // ever moves toward now -- so nothing in this daemon could ever reach a
  // message older than the day it was first run. A private development corpus
  // confirmed the symptom: only the initial forward window had been ingested.
  // The older years were not thin; they were never fetched. Do not put private
  // corpus sizes or date ranges in this public repository.
  //
  // A HISTORY PASS is the same source running backwards over its own second
  // cursor, one slice per turn. Scheduled rather than run at install, because
  // this is somebody's daily machine: a consumer app must not spend an hour of
  // their CPU before it is useful. Newest-first for the same reason -- last
  // year matters more than 2017, and the screens fill visibly while it runs.
  //
  // ONE AT A TIME, never alongside that source's forward pass: both read the
  // same store and each moves a cursor the other reads, so an overlap strands
  // rows between them with nothing to notice it by.
  // How long one cycle may spend walking history. Small enough to be invisible
// on the owner's machine, large enough that a decade of messages arrives in
// hours rather than days.
const HISTORY_BUDGET_MS = 20_000;
const HISTORY_RATE_KEY = (connector) => `${connector}:history-slices-per-pass`;
const CALENDAR_HISTORY_CURSOR_KEY = 'calendar:history-ceiling-ts';
const CALENDAR_HISTORY_FLOOR_TS = Date.UTC(1900, 0, 1);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function matrixHistoryRooms(value) {
  try {
    const rooms = JSON.parse(value ?? '[]');
    return Array.isArray(rooms)
      ? rooms.filter((room) => typeof room === 'string' && room.length > 0).length
      : 0;
  } catch {
    return 0;
  }
}

const makeCtx = ({ history = false, historyWindow = null } = {}) => ({
    state,
    ingest: (rows) => ingest(rows, ingestOpts),
    admin,
    config,
    cacheDir,
    log,
    now,
    backfill: false,
    history,
    historyComplete: yearlyBackfill.snapshot().complete,
    ...(historyWindow ? { historyWindow } : {}),
  });

  async function runSource(source) {
    nextRuns.delete(source.name);
    // The disable marker is checked per run, not at startup, so
    // `run.mjs <name> --disable` takes effect at the next tick without
    // bouncing the daemon.
    if (existsSync(disableMarkerPath(source.name))) {
      yearlyBackfill.classify(source.name, false);
      yearlyBackfill.advance();
      log.info('source_disabled', { connector: source.name });
      return;
    }
    // Config reaches needs() because a source's prerequisites can depend on
    // it: calendar's Google backend requires OAuth tokens that the local
    // backend has no use for. Sources that ignore the argument are unaffected.
    const missing = await source.needs({ config });
    if (Array.isArray(missing) && missing.length > 0) {
      yearlyBackfill.classify(source.name, false);
      yearlyBackfill.advance();
      // Not a failure: an unprovisioned source waits, loudly, and is
      // re-checked next cycle. recordRun stays clean of noise runs.
      log.warn('source_not_ready', { connector: source.name, missing: missing.length });
      return;
    }
    const startedTs = now();
    const socialPlatforms = source.name === 'matrix' ? connectedSocialPlatforms() : [];
    yearlyBackfill.classify(
      source.name,
      source.walksHistory === true && (source.name !== 'matrix' || socialPlatforms.length > 0)
    );
    publishActivity({
      phase: 'syncing',
      connector: source.name,
      ...(socialPlatforms.length ? { platforms: socialPlatforms.map((platform) => platform.label) } : {}),
      startedTs,
    });
    try {
      // The forward pass first, always: what arrived since last time is more
      // urgent than what happened in 2019, and history must never delay it.
      const forward = (await source.run(makeCtx())) ?? {};
      if (forward.historyReopened === true) yearlyBackfill.reopen(source.name);
      const counts = runCounts(forward);

      // Then ONE slice of history, if this source walks backwards and has not
      // reached the beginning of its store. Sequential with the forward pass and
      // never concurrent: both read the same store, and each moves a cursor the
      // other reads, so an overlap strands rows between them invisibly.
      //
      // A history failure is logged and dropped rather than failing the run. The
      // forward pass already succeeded and its counts are real; history is
      // catch-up work that retries on the next interval regardless.
      const historyWindow = yearlyBackfill.task(source.name);
      if (source.walksHistory === true && historyWindow) {
        // A TIME BUDGET, not a row count.
        //
        // One slice per cycle is too slow to be useful: 2,000 rows against a
        // 15-minute interval is two and a half days to walk 470k messages, and
        // an archive that arrives next week is not a feature. A row count is
        // also the wrong dial -- it means something different on every machine.
        //
        // So: keep taking slices until the budget is spent. The budget is small
        // enough that the owner never notices (this is their daily driver, and
        // the forward pass has already run), and it self-tunes -- a fast Mac
        // simply gets through more history per cycle.
        const deadline = now() + HISTORY_BUDGET_MS;
        let slices = 0;
        let gained = 0;
        try {
          while (now() < deadline) {
            const rawBack = (await source.run(makeCtx({ history: true, historyWindow }))) ?? {};
            const back = runCounts(rawBack);
            slices += 1;
            // `ingested`, not `inserted`: runCounts NORMALISES a source's
            // {inserted|ingested} into one name, and reading the pre-normalised
            // one back made this undefined. `gained` was NaN on every pass --
            // logged as null, which is how it went unnoticed -- and the all-zero
            // guard below could never fire through its first condition.
            gained += back.ingested + back.updated;
            // Nothing read means the walk reached the beginning of the store.
            // The source records that itself; stop asking.
            if (rawBack.historyDone === true) {
              yearlyBackfill.record(source.name, rawBack);
              yearlyBackfill.advance();
              break;
            }
            // A sparse calendar can have an empty historical year while still
            // advancing its private cursor. Let that source continue through
            // the gap; sources that did not explicitly report progress keep
            // the old all-zero stop behaviour.
            if (
              back.ingested === 0 && back.updated === 0 && back.unchanged === 0
              && rawBack.historyProgressed !== true
            ) break;
          }
          if (slices > 0) {
            // A short rolling measurement is enough for the activity panel to
            // turn a known number of remaining history slices into elapsed
            // wall-clock time. It is private cursor state, never corpus.
            state.setCursor(HISTORY_RATE_KEY(source.name), String(slices));
            log.info('history_pass', {
              connector: source.name,
              year: historyWindow.year,
              slices,
              gained,
            });
          }
        } catch (error) {
          log.warn('history_pass_failed', {
            connector: source.name,
            slices,
            error: safeErrorFingerprint(error),
          });
        }
      }
      state.recordRun({
        connector: source.name,
        startedTs,
        finishedTs: now(),
        ok: true,
        ...counts,
      });
      log.info('source_run', {
        connector: source.name,
        durationMs: now() - startedTs,
        ...counts,
      });
    } catch (error) {
      // One source failing must never take the others down: the error is
      // recorded and this source simply tries again next interval.
      state.recordRun({
        connector: source.name,
        startedTs,
        finishedTs: now(),
        ok: false,
        error: safeErrorFingerprint(error),
      });
      log.error('source_failed', { connector: source.name, error: safeErrorFingerprint(error) });
    } finally {
      publishActivity({ phase: 'idle', connector: source.name, finishedTs: now() });
    }
  }

  function schedule(fn, delayMs, reschedule) {
    if (stopped) return;
    // Deliberately NOT unref'd: these timers are the daemon's entire life,
    // and an unref'd schedule would let the process exit the moment startup
    // finished. stop() clears them, which is what lets tests exit.
    const timer = setTimeout(async () => {
      timers.delete(timer);
      // The catch and the reschedule are both load-bearing, and this callback
      // had neither.
      //
      // `fn()` is `runSource(source)`, which has its own narrow try — but
      // anything thrown OUTSIDE it (a client constructor, a secret read, a
      // config access) rejected this async callback. An unhandled rejection
      // terminates the process, so one source failing in the wrong place took
      // down all twelve. And because the throw skipped `reschedule()`, even
      // surviving would have left that source stopped forever with no timer
      // to bring it back.
      //
      // connectors/AGENTS.md: "A source failure is recorded in run_log and the
      // other sources keep running." This is what makes that true.
      try {
        await fn();
      } catch (error) {
        log.error('schedule_task_failed', {
          error: safeErrorFingerprint(error),
        });
      }
      if (!stopped) reschedule();
    }, delayMs);
    timers.add(timer);
  }

  function scheduleSource(source, delayMs) {
    const intervalMs = (config.intervals?.[source.name] ?? DEFAULT_INTERVAL_S) * 1000;
    nextRuns.set(source.name, now() + delayMs);
    publishWaiting();
    schedule(
      () => runSource(source),
      delayMs,
      () => scheduleSource(source, intervalMs)
    );
  }

  // Retention + physical maintenance, once per day in the configured idle
  // window (default 03:30). Retain first (cheap deletes), maintain after
  // (the blocking FTS rebuild + VACUUM on hermes) — the whole point of the
  // window is that nothing else is talking to hermes while VACUUM holds it.
  function scheduleMaintenance() {
    const delay = msUntilIdleWindow(config.retention?.maintainHour, now());
    // Maintenance is real app work too. Keeping it in the same ordered queue
    // gives the seven connector passes one honest item beyond the visible
    // seven-row window, so the expanded activity view can actually scroll.
    nextRuns.set('maintenance', now() + delay);
    publishWaiting();
    schedule(
      async () => {
        nextRuns.delete('maintenance');
        const startedTs = now();
        publishActivity({ phase: 'syncing', connector: 'maintenance', startedTs });
        // CHECKED WHEN IT FIRES, not only when it was armed.
        //
        // The delay was computed at arming time and never re-examined, so
        // anything that stretched the gap ran the blocking VACUUM whenever the
        // timer happened to come due. A laptop asleep through 03:30 wakes and
        // fires immediately — at 09:00, or during a call — and /admin/maintain
        // holds hermes exclusively for the length of an FTS rebuild plus a
        // VACUUM while every connector is mid-poll. The whole point of the
        // window is that nothing else is talking to hermes.
        //
        // Skipping is free: reschedule() below aims at the next real window.
        try {
          if (!isInsideIdleWindow(config.retention?.maintainHour, now())) {
            log.info('maintenance_skipped', {
              reason: 'fired outside the idle window (slept, or the clock moved)',
              maintainHour: config.retention?.maintainHour ?? '03:30',
            });
            return;
          }
          await retentionPass({ config, state, log, ingestOpts, now });
          await maintainPass({ log, ingestOpts });
        } catch (error) {
          log.error('maintenance_failed', { error: safeErrorFingerprint(error) });
        } finally {
          publishActivity({ phase: 'idle', connector: 'maintenance', finishedTs: now() });
        }
      },
      delay,
      scheduleMaintenance
    );
  }

  return {
    start() {
      const scheduledSources = sources.filter((source) => !DEFAULT_DISABLED_CONNECTORS.includes(source.name));
      sources.forEach((source) => {
        if (DEFAULT_DISABLED_CONNECTORS.includes(source.name)) {
          log.info('source_hidden', { connector: source.name });
        }
      });
      scheduledSources.forEach((source, i) => scheduleSource(source, 1_000 + i * FIRST_RUN_STAGGER_MS));
      scheduleMaintenance();
      log.info('daemon_started', {
        sources: scheduledSources.map((s) => s.name),
        hidden: DEFAULT_DISABLED_CONNECTORS,
        maintainHour: config.retention?.maintainHour ?? '03:30',
      });
      if (scheduledSources.length === 0) {
        log.warn('no_sources', { detail: 'connectors/sources/ is empty; every source is disabled or missing' });
      }
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

// --- CLI entry ------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const log = createLogger();
  let releaseLock = null;
  let ownerWatch = null;
  try {
    releaseLock = acquireDaemonLock();
    if (!releaseLock) {
      log.info('daemon_already_running');
      process.exit(0);
    }
    const config = loadConfig();

    // Startup preflight lives in lib/checks.mjs (owned by doctor's author;
    // contract: runChecks() → [{name, status: PASS|WARN|FAIL, detail, fix}],
    // never throws). Imported STATICALLY, like run.mjs imports
    // verifyHermesIdentity: a missing or broken checks.mjs used to be
    // tolerated with a warning (written while the module was landing from a
    // concurrent work stream), which let a partial deploy start the one
    // process with Full Disk Access with the entire preflight — hermes
    // identity gate included — silently skipped. Now that is a loud startup
    // failure, per the refuse-loudly rule below.
    //
    // WHICH FAILURES ARE FATAL. A broken foundation is: hermes identity, the
    // bridge hardening gate, the binary and the backup API. Poll past one of
    // those and the symptom is buried in per-source noise, so they still stop
    // the daemon dead.
    //
    // A MISSING FULL DISK ACCESS GRANT IS NOT THAT. It is one permission the
    // owner has not given yet, and it is specific to the sources that read a
    // protected sqlite store directly. Treating it as fatal meant three
    // unchecked boxes took down `files`, `granola`, `linkedin`, `mail`,
    // `notion`, `oura` and `whatsapp` as well — seven sources that touch nothing
    // TCC protects and ingest fine without the grant. That is what shipped, and
    // it is why a machine whose app reported `fda: granted` still ingested
    // nothing: these checks run in the CHILD, which does not inherit the
    // responsible-process attribution, so they failed and took everything with
    // them.
    //
    // So an FDA failure is ADVISORY: it is logged by name and the daemon starts.
    // It is deliberately not a disable either, for two reasons the sources
    // already encode. calendar.mjs's own note is that "the run itself is the
    // honest probe" — the grant attaches per spawning process, so a preflight
    // stat can pass where the real open is denied and vice versa, which makes
    // this check evidence and not a verdict. And calendar has a SECOND backend
    // that needs no FDA at all: on a machine using Google Calendar, sitting the
    // source out over a local-store check would have reproduced this very bug
    // one level down. Sitting a source out would also cost the fix button — the
    // connections panel raises "Open Full Disk Access" from a source's own
    // broken/fix state, which a source that never ran never reports.
    const results = await runChecks();
    for (const r of results) {
      if (r.status === 'WARN') log.warn('startup_check', { name: r.name, detail: r.detail });
      if (r.status === 'FAIL') log.error('startup_check', { name: r.name, detail: r.detail, fix: r.fix });
    }
    const { fatal, fdaBlocked } = partitionChecks(results);
    if (fatal.length > 0) {
      throw new Error(
        `startup checks failed: ${fatal.map((r) => r.name).join(', ')} — run \`npm run doctor\` for the fixes`
      );
    }
    if (fdaBlocked.size > 0) {
      // Loud, but not fatal, and not a disable: these sources still run and
      // still probe for themselves. Named individually so the log says which
      // grant is missing rather than "checks failed".
      log.warn('fda_missing_sources_may_fail', {
        sources: [...fdaBlocked],
        fix: 'grant Full Disk Access to Intaglio Labs, then restart it',
      });
    }

    const state = openStateDb();
    // Every source that was discovered runs, INCLUDING one whose Full Disk Access
    // check failed above — see the preflight note: that check is advisory, and
    // each source probes for itself. This used to also be filtered by a `role`
    // naming which machine ran which connectors; that split is gone and the
    // filter with it. Sources are still gated individually by config and by
    // whether their credentials exist.
    const sources = await loadSources();
    log.info('sources_loaded', { running: sources.map((s) => s.name) });
    const ingestOpts = {
      baseUrl: process.env.HAZLIE_HERMES_URL ?? config.hermesUrl ?? DEFAULT_HERMES_BASE_URL,
      tokenFile: defaultHermesTokenPath(),
    };
    await applyPendingSocialReimport({
      state,
      cacheDir: defaultCacheDir(),
      log,
      purge: (args) => adminPurge(args, ingestOpts),
    });
    const daemon = createDaemon({ config, state, log, sources, ingestOpts });
    daemon.start();

    const shutdown = (signal) => {
      log.info('daemon_stopping', { signal });
      if (ownerWatch) clearInterval(ownerWatch);
      daemon.stop();
      state.close();
      releaseLock?.(); releaseLock = null;
      log.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    const ownerPid = Number(process.env.INTAGLIO_CONNECTOR_OWNER_PID);
    if (Number.isInteger(ownerPid) && ownerPid > 1) {
      ownerWatch = setInterval(() => {
        if (!processIsAlive(ownerPid)) shutdown('owner-exited');
      }, 5_000);
    }
  } catch (error) {
    // Refuse loudly: a daemon that half-starts is worse than one that names
    // its blocker and exits for launchd to report.
    log.error('daemon_failed_to_start', { error: safeErrorFingerprint(error) });
    releaseLock?.();
    console.error(
      `connectors daemon failed to start (${safeErrorFingerprint(error)}); run npm run doctor`
    );
    process.exit(1);
  }
}
