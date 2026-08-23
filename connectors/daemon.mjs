// The connectors daemon: resident pollers that read the owner's own stores
// and services (iMessage, Calendar, IMAP mail, Granola's REST API, Oura's
// API) and write what they find into the context store through hermes'
// POST /ingest — never through a database handle of their own.
//
// NETWORK POSTURE — LOOPBACK-ONLY, STATED PLAINLY: this process opens NO
// listener of any kind. Its sockets are outbound only: loopback HTTP to
// hermes (HAZLIE_HERMES_URL, then config "hermesUrl", default 127.0.0.1:8789
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
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { retentionPass, maintainPass, msUntilIdleWindow, isInsideIdleWindow } from './retain.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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
  'linkedin',
  'whatsapp',
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
  linkedin: 'linkedin',
  whatsapp: 'whatsapp',
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
  'linkedin',
  'whatsapp',
  'hazlie_digest',
]);

export function defaultConfigPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'config.json');
}

export function defaultCacheDir(home = homedir()) {
  return join(home, '.hazlie', 'cache');
}

export function disableMarkerPath(name, home = homedir()) {
  return join(home, '.hazlie', 'connectors', `${name}.disabled`);
}

// --- config -------------------------------------------------------------------
//
// Closed key sets at every level, enforced with throws: an unknown key is a
// caller bug (usually a misspelling of one the daemon reads — `interval` for
// `intervals`, `backfill_days` for `backfillDays`) and silently ignoring it
// would turn "poll hourly" into "poll at the default" without anyone
// noticing until the bill or the gap.

// Which machine this is. Two-machine setup: `hazlie` runs on the Mac Mini
// under its OWN Apple ID and does everything except read the owner's
// messages; `personal` runs on the owner's Mac and does nothing BUT that,
// shipping rows to the Mini's hermes over the network.
//
// `personal` predates the 2026-08-20 move and no machine is configured for it
// today. It is kept in ROLES rather than removed for the reason the next
// comment gives: a config that predates a role list must not be silently
// repurposed by shortening it. Note the SSH tunnel it once shipped through is
// gone; hermes is local, so nothing tunnels anywhere.
//
// The default is `hazlie`, because that is the single-machine setup that
// already exists — an unset role must not silently switch a working install
// into reading-only mode.
export const ROLES = Object.freeze(['full', 'courier', 'hazlie', 'personal']);
// Unchanged on purpose. Adding roles must not silently repurpose an install
// whose config predates them, and the Mini cannot be reconfigured from here.
export const DEFAULT_ROLE = 'hazlie';

// The whole point of the role: a machine only runs the connectors it is the
// right machine for. Without this the MacBook would poll Oura and Google
// alongside the Mini, doubling every API call and racing on cursors.
// Owner decision 2026-08-20: ALL processing moves to the owner's Mac, and the
// Mini keeps only the two things that are physically its own — the 24/7 mic
// and Hazlie's Apple ID. The corpora end up on separate machines rather than
// merged on one, which is a better answer to the question CLAUDE.md flags
// than the source allowlist that was declined earlier: household audio never
// meets the personal corpus because they are not on the same box.
export const ROLE_SOURCES = Object.freeze({
  // The owner's Mac. Everything: its own stores AND the cloud APIs, which are
  // reachable from here exactly as well as from the Mini.
  full: Object.freeze([
    'imessage',
    'photos',
    'notes',
    'calendar',
    'mail',
    'granola',
    'oura',
    'contacts',
    'notion',
    'files',
    'linkedin',
    'whatsapp',
  ]),
  // Hazlie's Mac. No connectors at all: it captures audio (the rig, not this
  // daemon) and speaks as Hazlie. It holds none of the owner's corpus.
  courier: Object.freeze([]),

  // The earlier two-machine split, kept so an install that predates the change
  // keeps behaving as configured until its role is set deliberately.
  hazlie: Object.freeze(['calendar', 'mail', 'granola', 'oura', 'contacts']),
  personal: Object.freeze(['imessage', 'photos', 'notes', 'whatsapp']),
});

export function sourcesForRole(role) {
  return ROLE_SOURCES[role] ?? ROLE_SOURCES[DEFAULT_ROLE];
}

const TOP_KEYS = Object.freeze([
  'role',
  'selfName',
  // The owner's own email addresses beyond the mail-connector accounts —
  // aliases and old company addresses that ARE the owner. Read by the people
  // graph (ui/server/people/owner.mjs) so an alias is not mistaken for a
  // separate person; the connectors themselves do not use it.
  'ownerEmails',
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

export function validateConfig(raw) {
  assertClosedKeys(raw, TOP_KEYS, 'the top level');
  if (raw.role !== undefined && !ROLES.includes(raw.role)) {
    throw configError(`"role" must be one of: ${ROLES.join(', ')}`);
  }
  if (raw.selfName !== undefined && (typeof raw.selfName !== 'string' || raw.selfName.length === 0)) {
    throw configError('"selfName" must be a non-empty string');
  }
  // The per-machine hermes address, for Macs where the canonical port (8789)
  // is taken by something else.
  // Env still wins — the launchd plists set HAZLIE_HERMES_URL explicitly —
  // but hand-run `node run.mjs <source>` reads its target from here instead
  // of silently POSTing corpus rows at whatever holds the default port.
  // Same acceptance rule as every ingest call: HTTP, loopback, bare origin.
  if (raw.hermesUrl !== undefined) {
    try {
      canonicalLoopbackBase(raw.hermesUrl);
    } catch {
      throw configError('"hermesUrl" must be an HTTP loopback origin, e.g. "http://127.0.0.1:8789"');
    }
  }
  if (raw.intervals !== undefined) {
    assertClosedKeys(raw.intervals, CONNECTOR_NAMES, '"intervals"');
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
            'online-only file in the configured roots (45.6 GB when measured on 2026-08-20). ' +
            'Implement it deliberately, with a size budget, before setting this.'
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
  let stopped = false;

  const admin = {
    retain: (args) => adminRetain(args, ingestOpts),
    purge: (args) => adminPurge(args, ingestOpts),
    deleteEntities: (args) => adminDeleteEntities(args, ingestOpts),
    maintain: () => adminMaintain(ingestOpts),
    entities: (args) => adminEntities(args, ingestOpts),
  };

  const makeCtx = () => ({
    state,
    ingest: (rows) => ingest(rows, ingestOpts),
    admin,
    config,
    cacheDir,
    log,
    now,
    backfill: false,
  });

  async function runSource(source) {
    // The disable marker is checked per run, not at startup, so
    // `run.mjs <name> --disable` takes effect at the next tick without
    // bouncing the daemon.
    if (existsSync(disableMarkerPath(source.name))) {
      log.info('source_disabled', { connector: source.name });
      return;
    }
    // Config reaches needs() because a source's prerequisites can depend on
    // it: calendar's Google backend requires OAuth tokens that the local
    // backend has no use for. Sources that ignore the argument are unaffected.
    const missing = await source.needs({ config });
    if (Array.isArray(missing) && missing.length > 0) {
      // Not a failure: an unprovisioned source waits, loudly, and is
      // re-checked next cycle. recordRun stays clean of noise runs.
      log.warn('source_not_ready', { connector: source.name, missing });
      return;
    }
    const startedTs = now();
    try {
      const counts = runCounts((await source.run(makeCtx())) ?? {});
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
        error: error?.message ?? String(error),
      });
      log.error('source_failed', { connector: source.name, error: error?.message ?? String(error) });
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
          error: String(error?.message ?? error).slice(0, 200),
        });
      }
      if (!stopped) reschedule();
    }, delayMs);
    timers.add(timer);
  }

  function scheduleSource(source, delayMs) {
    const intervalMs = (config.intervals?.[source.name] ?? DEFAULT_INTERVAL_S) * 1000;
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
    schedule(
      async () => {
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
        if (!isInsideIdleWindow(config.retention?.maintainHour, now())) {
          log.info('maintenance_skipped', {
            reason: 'fired outside the idle window (slept, or the clock moved)',
            maintainHour: config.retention?.maintainHour ?? '03:30',
          });
          return;
        }
        try {
          await retentionPass({ config, state, log, ingestOpts, now });
          await maintainPass({ log, ingestOpts });
        } catch (error) {
          log.error('maintenance_failed', { error: error?.message ?? String(error) });
        }
      },
      delay,
      scheduleMaintenance
    );
  }

  return {
    start() {
      sources.forEach((source, i) => scheduleSource(source, 1_000 + i * FIRST_RUN_STAGGER_MS));
      scheduleMaintenance();
      log.info('daemon_started', {
        sources: sources.map((s) => s.name),
        maintainHour: config.retention?.maintainHour ?? '03:30',
      });
      if (sources.length === 0) {
        log.warn('no_sources', { detail: 'connectors/sources/ is empty; Phase 4 has not landed' });
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
  try {
    const config = loadConfig();

    // Startup preflight lives in lib/checks.mjs (owned by doctor's author;
    // contract: runChecks() → [{name, status: PASS|WARN|FAIL, detail, fix}],
    // never throws). Its absence is tolerated with a warning — the module
    // lands from a concurrent work stream — but when present, a FAIL is
    // fatal: in that module's own semantics WARN means "not provisioned yet,
    // disabled by design" and FAIL means broken, and a daemon that polls past
    // a broken foundation buries the symptom in per-source noise.
    let checks = null;
    try {
      checks = await import('./lib/checks.mjs');
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error?.message).includes('checks.mjs')) {
        log.warn('checks_missing', { detail: 'lib/checks.mjs not present; startup checks skipped' });
      } else {
        throw error;
      }
    }
    if (typeof checks?.runChecks === 'function') {
      const results = await checks.runChecks();
      for (const r of results) {
        if (r.status === 'WARN') log.warn('startup_check', { name: r.name, detail: r.detail });
        if (r.status === 'FAIL') log.error('startup_check', { name: r.name, detail: r.detail, fix: r.fix });
      }
      const failed = results.filter((r) => r.status === 'FAIL');
      if (failed.length > 0) {
        throw new Error(
          `startup checks failed: ${failed.map((r) => r.name).join(', ')} — run \`npm run doctor\` for the fixes`
        );
      }
    }

    const state = openStateDb();
    // Filtered by role, not merely loaded. Without this the personal Mac
    // would poll Oura and Google alongside the Mini — doubling every API
    // call and racing on the same cursors — which is the whole reason the
    // role exists. sourcesForRole was defined and unit-tested before it was
    // ever called from here; the test passed while the daemon ignored it.
    const role = config.role ?? DEFAULT_ROLE;
    const allowed = sourcesForRole(role);
    const discovered = await loadSources();
    const sources = discovered.filter((s) => allowed.includes(s.name));
    log.info('daemon_role', {
      role,
      running: sources.map((s) => s.name),
      skipped: discovered.map((s) => s.name).filter((n) => !allowed.includes(n)),
    });
    const ingestOpts = {
      baseUrl: process.env.HAZLIE_HERMES_URL ?? config.hermesUrl ?? DEFAULT_HERMES_BASE_URL,
      tokenFile: defaultHermesTokenPath(),
    };
    const daemon = createDaemon({ config, state, log, sources, ingestOpts });
    daemon.start();

    const shutdown = (signal) => {
      log.info('daemon_stopping', { signal });
      daemon.stop();
      state.close();
      log.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    // Refuse loudly: a daemon that half-starts is worse than one that names
    // its blocker and exits for launchd to report.
    log.error('daemon_failed_to_start', { error: error?.message ?? String(error) });
    console.error(`connectors daemon failed to start: ${error?.message ?? error}`);
    process.exit(1);
  }
}
