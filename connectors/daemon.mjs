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
import { defaultDaemonLockPath, processIsAlive } from './lib/daemonLock.mjs';
import {
  DEFAULT_HERMES_BASE_URL,
  adminCompletePeopleYear,
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
// Moved to a leaf module so connect can read the roster without loading this
// file's module-scope registry resolution; re-exported because run.mjs, the
// config validator and three tests already import it from here.
import { CONNECTOR_NAMES } from './lib/connectorNames.mjs';

export { CONNECTOR_NAMES };
import {
  connectorsDisabledBy,
  enabledFeatureNames,
  optionalConnectors,
  readFeatureRegistry,
} from './lib/features.mjs';
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


// Settings deliberately keeps these integrations out of the current product
// surface. A hidden connector must also be inert: scheduling it anyway leaks
// implementation-in-progress into Activity and can touch data the person
// cannot enable or control from the app.
//
// ~~Keep this in lockstep with widget/ui/connections.js's HIDDEN_CONNECTORS
// until each integration ships.~~ That was two hand-maintained lists, in two
// languages, that had to agree, with nothing checking that they did. Both are
// DERIVED now, from ops/features.json — see ops/FEATURES.md. The lockstep is a
// fact rather than an instruction.
//
// `matrix` joins the list whenever `bridges` is off, and it is the entry the
// registry cannot express directly: Matrix is not a source somebody connects,
// it is the transport the seven bridges share, so it follows the bridges
// feature rather than a connector key of its own. Omitting it would leave the
// daemon polling a Synapse that provisioning no longer installs.
const FEATURE_REGISTRY = readFeatureRegistry({
  onProblem: (reason) => process.stderr.write(`connectors: ${reason}\n`),
});
export const FEATURES = FEATURE_REGISTRY.features;
// 'ok' | 'missing' | 'invalid'. The last two mean every connector is off,
// INCLUDING the card's own, which is a total outage that used to be reported
// only by the stderr line above — outside the structured log the app reads, and
// indistinguishable downstream from a deliberately quiet install. start() says
// it again as an event; connect/lib/status.mjs carries it to the shelf.
export const FEATURES_REGISTRY_STATE = FEATURE_REGISTRY.registryState;
export const DEFAULT_DISABLED_CONNECTORS = Object.freeze(
  connectorsDisabledBy(FEATURES, CONNECTOR_NAMES)
);
// Offered on the connections page, NOT auto-started here. These stay
// schedulable on purpose: 'optional' means the owner's own connect action
// (WhatsApp's .disabled marker, Granola's credential) is the gate, and a source
// that is never scheduled can never notice that gate opening. Exported so the
// distinction is visible to a reader and to the tests, not because the
// scheduler branches on it — the existing per-source gates already do that.
export const OPTIONAL_CONNECTORS = Object.freeze(
  optionalConnectors(FEATURES, CONNECTOR_NAMES)
);

// HOW SOON A SOURCE THAT COULD NOT RUN IS ASKED AGAIN, and why it is not the
// polling interval.
//
// A source whose needs() reports a missing prerequisite returns early and is
// rescheduled at its FULL interval -- fifteen minutes by default. That is the
// right cadence for a source that is working and the wrong one for the only
// moment this state is ever interesting: the owner has just signed in to Google
// or dropped their LinkedIn export in, and the thing they did is a quarter of an
// hour away from being noticed. On the second clean-machine onboarding run
// (2026-09-12) both sources answered "not ready" at 20:51, the owner completed
// screens 3 and 4, and ten minutes later neither had been asked again. The first
// clean run only picked them up because reinstalling the app restarted the
// daemon.
//
// So the first re-probe is a minute away, and each further one doubles until it
// reaches the interval the source would have used anyway. needs() is an
// existsSync or a token read, so the early probes are nearly free; the doubling
// means a machine where a connector is simply never going to be connected
// settles back onto its ordinary interval after a handful of ticks instead of
// polling a missing file forever.
//
// It is the CEILING that matters as much as the floor: below MIN_INTERVAL_S a
// poller is a busy-loop, and every configured interval is already >= 60 s, so
// Math.min below can never take this under a minute.
export const NOT_READY_REPROBE_MS = 60_000;

// THE FIRST-LOAD SPRINT, and the arithmetic that makes it necessary.
//
// The reconnect card needs somebody who has gone QUIET: RECONNECT_GATES asks for
// a person whose last activity is at least 180 days old. On a fresh Mac the
// forward window reaches about 157 days back and the yearly walk is still inside
// the current year, so NOBODY in the loaded corpus can qualify until last year's
// history lands -- and last year's history is paced at HISTORY_BUDGET_MS (20 s)
// per source per tick, with ticks fifteen minutes apart. Live on 2026-09-12 run
// two: thirty minutes after a fresh install the pool was empty in every mode,
// and iMessage's 2026 pass had gained 5.8k rows and then 9.9k rows in two ticks
// a quarter of an hour apart. The first card was hours away, and nothing on
// screen said so.
//
// So a machine that has not yet finished LAST year walks it hard for half an
// hour: a longer history budget, and a re-arm measured in seconds rather than
// the polling interval. Then it stops, permanently, whichever way it ended --
// this is a first-load phase, not a mode.
//
// LOCAL STORES ONLY. mail, granola, matrix and oura are network sources against
// rate-limited APIs, and the mail connector's own pacer is built around a
// per-minute budget it shares with nothing; sprinting one of those trades a
// first card for a 429. The sprint reads sqlite files on the owner's own disk.
export const SPRINT_MAX_MS = 30 * 60_000;
export const SPRINT_HISTORY_BUDGET_MS = 60_000;
// Two re-arms, because the owner already told us which machine they want. A
// fresh install defaults to less-power (PowerBudget's own default), so the
// GENTLE one is the default here too.
//
// TWENTY SECONDS, NOT SIXTY. ~~A minute, on the reading that less-power means a
// cool lap.~~ Against a 60 s history budget that is a 25% duty cycle, for at
// most half an hour, on disk-bound reads of local sqlite files -- and the thing
// the owner is waiting for is their FIRST CARD. Twenty gives a 75% duty cycle
// under the same ceiling and the same half hour, and the first evening this is
// protecting is the one where nothing has appeared yet. PowerBudget's own
// argument (a hot laptop on somebody's first evening is the impression that
// sticks) is about the steady state, and this phase ends.
export const SPRINT_REARM_MS = 10_000;
export const SPRINT_REARM_GENTLE_MS = 20_000;
// How the app tells its child which the owner picked. The same channel that
// already carries the owner pid at spawn (widget/src/Connectors.swift), not a
// config key: a second writer for a fact that already has one is how two
// definitions of the same setting drift apart. Absent means gentle, which is
// what a standalone `npm run daemon` and a fresh install both are.
export const PERFORMANCE_ENV = 'INTAGLIO_PERFORMANCE';
export function defaultSprintRearmMs(env = process.env) {
  return env[PERFORMANCE_ENV] === 'full' ? SPRINT_REARM_MS : SPRINT_REARM_GENTLE_MS;
}
// WHICH CONNECTORS MAY SPRINT. Named rather than derived from `walksHistory`,
// because the property that matters is not "walks history" but "reads a local
// file nobody is rate-limiting".
export const SPRINT_CONNECTORS = Object.freeze(['imessage', 'calendar', 'whatsapp']);
// WHEN THE SPRINT BEGAN, durably, so a restart inside the window resumes with
// what is left of it rather than starting a fresh half hour -- and so a machine
// that has already spent its sprint never takes another.
export const SPRINT_STARTED_KEY = 'sprint:started-ts';

export function sourceRetryDelay(result, intervalMs) {
  if (Number.isFinite(result?.nextDelayMs) && result.nextDelayMs >= 1_000) {
    return Math.min(60_000, Math.floor(result.nextDelayMs));
  }
  // Deliberately a SECOND field rather than nextDelayMs. That one is a source's
  // own request for a short retry and is capped at 60 s; this one is the
  // scheduler's own back-off and has to be able to grow PAST a minute, all the
  // way back up to the interval.
  // No 1-second floor here, unlike the branch above. That one guards against a
  // SOURCE handing back a silly number; this one is the scheduler's own
  // arithmetic over its own constant, and a floor would quietly swap an
  // injected test cadence for a fifteen-minute one.
  if (Number.isFinite(result?.notReadyDelayMs) && result.notReadyDelayMs > 0) {
    return Math.min(intervalMs, Math.floor(result.notReadyDelayMs));
  }
  // THE SPRINT RE-ARM, which is the only delay here allowed to be SHORTER than
  // the interval without a source asking for it. It comes back through this
  // function rather than being armed directly so the one-timer-per-source rule
  // in scheduleSource still holds: a sprint tick replaces the pending timer
  // exactly as an ordinary one does, and there is never a second pass in flight
  // over the same cursor.
  if (Number.isFinite(result?.sprintDelayMs) && result.sprintDelayMs > 0) {
    return Math.min(intervalMs, Math.floor(result.sprintDelayMs));
  }
  return intervalMs;
}

const PORTAL_JOIN_SAMPLE_KEY = 'matrix:portal-join-rate-sample';

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

// Measure what the queue actually does on this machine. Matrix may join many
// rooms in one burst or admit one and rate-limit the next, so neither the raw
// queue length nor the retry timer is a completion forecast. Wall-clock change
// between bounded passes is. Counts and timestamps only; no room identifiers.
export function observePortalJoinRate(state, pending, observedTs, seedMsPerRoom = null) {
  if (!Number.isInteger(pending) || pending < 0 || !Number.isFinite(observedTs)) return null;
  let previous = null;
  try { previous = JSON.parse(state.getCursor(PORTAL_JOIN_SAMPLE_KEY) ?? 'null'); } catch {}
  const samples = Array.isArray(previous?.samples)
    ? previous.samples.filter((n) => Number.isFinite(n) && n >= 1_000 && n <= 120_000).slice(-7)
    : [];
  // The first pass has no previous wall-clock sample. If that pass was rate
  // limited, its server-authored retry delay is a useful initial per-room
  // estimate; the rolling wall-clock median replaces it on following passes.
  if (samples.length === 0 && Number.isFinite(seedMsPerRoom)
      && seedMsPerRoom >= 1_000 && seedMsPerRoom <= 120_000) {
    samples.push(seedMsPerRoom);
  }
  if (Number.isInteger(previous?.pending) && pending < previous.pending) {
    const elapsed = observedTs - Number(previous.ts);
    const joined = previous.pending - pending;
    const msPerRoom = elapsed / joined;
    // Ignore app downtime and clock jumps. The next live pair will replace the
    // baseline one pass later instead of poisoning an hours-long estimate.
    if (elapsed >= 1_000 && elapsed <= 120_000 && msPerRoom >= 1_000 && msPerRoom <= 120_000) {
      samples.push(msPerRoom);
    }
  }
  state.setCursor(PORTAL_JOIN_SAMPLE_KEY, JSON.stringify({ pending, ts: observedTs, samples }));
  return median(samples);
}

export function portalJoinMsPerRoom(state) {
  try {
    const saved = JSON.parse(state.getCursor(PORTAL_JOIN_SAMPLE_KEY) ?? 'null');
    return median((saved?.samples ?? []).filter(
      (n) => Number.isFinite(n) && n >= 1_000 && n <= 120_000
    ));
  } catch {
    return null;
  }
}

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
  // The file-based export. Same hermes source as the bridge's LinkedIn rows
  // below (deliberately — every people-graph join that reads `linkedin`
  // keeps working regardless of which connector wrote a row); the two never
  // collide because their entity_id namespaces are disjoint.
  linkedin: 'linkedin',
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

// Re-exported rather than defined: the path, the JSON shape and the liveness
// question all live in lib/daemonLock.mjs now, because connect/lib/status.mjs
// asks the same question about the same file and used to carry its own copy.
export { defaultDaemonLockPath };

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
    setupHint: 'rerun ops/setup-bridges-native.sh',
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
  // Owner-confirmed schools used by the local people-search graph. This lives
  // in the shared config, so the daemon must accept and validate the same key
  // the UI reads; otherwise adding a school would stop every connector.
  'highSchools',
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
  // The export connector's config section. Still empty (LINKEDIN_KEYS === []
  // below) — it takes no options — but the key has to stay in this closed
  // schema for the same reason every other connector's does: an existing
  // config carrying `"linkedin": {}` from before the connector was restored
  // must not fail before ANY connector could start.
  'linkedin',
  'retention',
  // The Relationship Memory cap. hermes gates the whole reconnect card on
  // relationshipMemory.capPerDay, and assertClosedKeys throws on any unknown
  // top-level key — so before this line, writing the key that TURNS THE
  // FEATURE ON stopped every connector from starting. The daemon does not read
  // it; it only has to stop refusing it.
  'relationshipMemory',
]);
const MAIL_KEYS = Object.freeze([
  'host',
  'port',
  'user',
  'folders',
  'backfillDays',
  'maxBodyBytes',
  'getsPerMinute',
  'historyPagesPerPass',
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
  'getsPerMinute',
  'historyPagesPerPass',
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
// The export connector is back (it supplies connection metadata and the
// message archive the Matrix bridge cannot — see CONNECTOR_NAMES above) and
// still takes no config of its own: only the empty object is valid, same as
// before it was retired.
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

// AND THE FORWARD PASS GETS ONE TOO, for the reason the history pass got one.
//
// "The forward pass is small" held only while every source had a cursor. Delete
// one mid-life -- a purge, a hand-run DELETE against state.db, a store that
// reports a new stream -- and the source falls back to its cold-start floor:
// for mail that is January 1st of the current year, so the window reopens to
// months of mail and the pass runs to its own per-account cap (2,000 messages
// at ~90 API calls a minute, ~22 minutes PER MAILBOX) instead of the couple of
// seconds an ordinary tick costs.
//
// Nothing above noticed. runSource() deletes the source from `nextRuns` for the
// whole call, so an hour-long pass is an hour in which the source is absent
// from the activity queue and reads as unscheduled; the history slice below is
// only reached AFTER the forward pass returns, so its year never starts; and an
// app restart killed the pass before it had logged anything at all. That was
// the 2026-09-12 stall: mail "missing from the queue" while it was in fact
// running the whole time.
//
// So the forward pass is bounded like the backwards one. A source that pages is
// expected to check this between pages and return; one that ignores it behaves
// exactly as before. Generous next to a healthy tick (seconds) and still well
// inside the polling interval, so a cold window drains over several passes
// while the source stays visible, stays classified, and still gets its history
// slice.
export const FORWARD_BUDGET_MS = 120_000;
// HOW MANY CONSECUTIVE needs() THROWS BEFORE A RUNNING SOURCE LEAVES THE
// YEARLY BARRIER. Three, because the throws this absorbs are momentary -- a
// token file being rewritten, a store locked by a backup -- while what it
// prevents is a source dropping out of the activity queue and back in on every
// flap. Three polling intervals of a stalled backfill is the price.
//
// IT IS NO LONGER THE ONLY THING STANDING BETWEEN A FLAP AND A REWOUND WALK
// (round-4 finding 3). This tolerance used to carry that on its own, and it
// could not: above three ticks the recovery still read as a re-activation and
// dragged a multi-year backfill to the current year for every source.
// yearlyBackfill.classify now rewinds only for a connector the walk has
// actually left years behind, so a recovery after ANY number of failed ticks
// costs the ticks it lasted and nothing more.
//
// STARTUP DOES NOT USE IT. See the startup probe: with nothing classified yet,
// classify(name, false) is a first answer rather than a re-classification, and
// withholding it freezes advance() for every source.
export const NEEDS_FAILURE_TOLERANCE = 3;
// TODO: only mail reads ctx.deadline. matrix's forward pass is the other one
// that can run for many minutes, and while it does it is absent from the
// activity queue and reads as unscheduled -- the same symptom this budget was
// added for. It is registry-disabled on every default install, which is why it
// is a note rather than a change.


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
  for (const [field, values] of [
    ['ownerEmails', raw.ownerEmails],
    ['ownerPersonKeys', raw.ownerPersonKeys],
    ['highSchools', raw.highSchools],
  ]) {
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
    // `intervals.linkedin` is the export connector's own poll cadence again,
    // now that CONNECTOR_NAMES includes it — no longer a special-cased
    // upgrade no-op.
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
    // MEASURED (2026-09): a clean probe against two Google accounts hit the
    // per-user "Units per minute" quota after ~102 `messages.get` calls in a
    // fresh minute, i.e. ~100 gets/minute regardless of what the console
    // shows. 100 is allowed as an upper bound so an owner who wants to lean
    // right up against the measured ceiling can, but no config can ask for
    // more than what was actually measured.
    if (raw.mail.getsPerMinute !== undefined) {
      assertPositiveInt(raw.mail.getsPerMinute, 'mail.getsPerMinute', { max: 100 });
    }
    // How many API pages one historical pass may drain per account. Pacing
    // (getsPerMinute) is what protects the quota; this only bounds how long a
    // single pass runs, so the ceiling is generous but finite.
    if (raw.mail.historyPagesPerPass !== undefined) {
      assertPositiveInt(raw.mail.historyPagesPerPass, 'mail.historyPagesPerPass', { max: 50 });
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
        if (account.getsPerMinute !== undefined) {
          assertPositiveInt(account.getsPerMinute, `mail.accounts[${i}].getsPerMinute`, { max: 100 });
        }
        // RANGE-CHECKED, same bounds as their top-level twins above. These
        // two were in MAIL_ACCOUNT_KEYS -- so assertClosedKeys accepted them
        // -- and then nothing looked at the VALUE: accountSettings reads the
        // per-account entry in preference to the top-level one, so
        // `historyPagesPerPass: 1000000` booted fine and asked mail.mjs's
        // history loop for a million pages, and `{}` (or a string) made
        // `page < NaN` false on the first comparison, which silently stopped
        // that one account's history from ever advancing again. An allowlist
        // that admits a key it does not bound is not a validator for it.
        if (account.maxBodyBytes !== undefined) {
          assertPositiveInt(account.maxBodyBytes, `mail.accounts[${i}].maxBodyBytes`, { min: 1024 });
        }
        if (account.historyPagesPerPass !== undefined) {
          assertPositiveInt(account.historyPagesPerPass, `mail.accounts[${i}].historyPagesPerPass`, { max: 50 });
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
  // Injectable so a test can drive a real daemon without overwriting the owner's
  // live activity snapshot at ~/.hazlie/connectors/activity.json.
  activityPath = defaultActivityPath(),
  now = Date.now,
  completePeopleYear = adminCompletePeopleYear,
  // The first re-probe delay for a source whose prerequisites are missing;
  // it doubles from here up to that source's interval. Injectable for the same
  // reason activityPath is: a test cannot wait a real minute to prove that the
  // wait ends without a restart.
  reprobeFloorMs = NOT_READY_REPROBE_MS,
  // Injectable for the same reason reprobeFloorMs is: a test cannot wait out a
  // ten-second re-arm, let alone a thirty-minute sprint.
  sprintRearmMs = defaultSprintRearmMs(),
  sprintMaxMs = SPRINT_MAX_MS,
  sprintHistoryBudgetMs = SPRINT_HISTORY_BUDGET_MS,
}) {
  const timers = new Set();
  const nextRuns = new Map();
  // WHY A SOURCE CANNOT RUN, as of its last evaluation.
  //
  // `runSource` already asks every source's needs() on every tick and returns
  // early when anything is missing -- an unprovisioned source is scheduled, ticks,
  // finds no credential and does nothing, forever. That answer was only ever
  // logged. The activity queue is built from `nextRuns`, which knows the SCHEDULE
  // and not the PREREQUISITES, so a source that can never do work still reached
  // the owner as pending work.
  //
  // Absent from this map means "not evaluated yet", which is deliberately
  // different from "ready": an unevaluated source is shown rather than hidden, so
  // a needs() that is slow or throws can never silently empty the queue.
  const notReady = new Map();
  // HOW LONG THE LAST NOT-READY ANSWER BOUGHT, per source, so the next one can
  // double it. Cleared the moment a source becomes ready, is disabled, or its
  // needs() starts throwing -- a back-off is about one specific kind of wait,
  // and carrying it across a different one would silence a source that just
  // recovered. See NOT_READY_REPROBE_MS.
  const notReadyDelays = new Map();
  // THE LIVE TIMER PER SOURCE, so one can be REPLACED rather than added to.
  //
  // `timers` is a flat set for stop(); it cannot answer "is this source already
  // armed?". Nothing needed that while the only thing that scheduled a source
  // was its own completion -- but probeNotReady() schedules one out of band, and
  // without this it would arm a SECOND timer beside the one already pending.
  // Two timers for one source is exactly the overlap the module header's
  // setTimeout-not-setInterval rule exists to make structurally impossible:
  // both passes read the same store and each moves a cursor the other reads.
  const sourceTimers = new Map();
  // CONSECUTIVE needs() THROWS PER SOURCE, and the reason there is a count at
  // all rather than a verdict.
  //
  // A throwing needs() cannot be classified as "inactive" on the spot. It is
  // the same call classify(name, true) later reads as a RE-ACTIVATION, and
  // that rewinds the shared yearly walk: wasInactive deletes COMPLETE, sets
  // the year back to the CURRENT one and reopens its barriers, for every
  // source. So a token file being rewritten under a walk at 2015 -- a throw
  // that lasts one tick -- would reset everybody to 2026, every time it
  // happened, and the backfill would never reach the older years. Trading a
  // stall for an oscillation is the worse trade: an oscillation is permanent.
  //
  // A source that FLAPS therefore keeps its place: below the tolerance the
  // barrier is untouched, exactly as it was before the classification existed,
  // and the walk simply waits. Only a source that fails NEEDS_FAILURE_TOLERANCE
  // ticks in a row is genuinely unavailable, and only then does it leave the
  // barrier so advance() can move the year without it -- which is the deadlock
  // the classification was added to break. The cost of the tolerance is at
  // most three polling intervals of a stalled backfill; the cost of getting it
  // wrong in the other direction is a backfill that never finishes.
  //
  // What the tolerance does NOT have to buy any more is the walk's position:
  // classify() rewinds only for a connector that has actually been left behind
  // (connectors/lib/yearlyBackfill.mjs, missedYears). A source that goes
  // unavailable for an hour and recovers keeps the year it was on.
  const needsFailures = new Map();
  let stopped = false;
  const peopleBarrierEnabled = typeof completePeopleYear === 'function'
    && typeof ingestOpts?.tokenFile === 'string';
  // THE ROSTER IS THE SCHEDULE, not the catalogue.
  //
  // Every member of this roster has to be classified before advance() will move
  // the year, and classify() is only ever reached from a source the scheduler
  // actually runs. Built from `sources`, it therefore included history sources
  // the registry had switched off — `matrix` on every default install, because
  // bridges are off — and the barrier then waited for a classification that
  // could never arrive. The yearly backfill deadlocked at the current year for
  // ALL the others. Filter by the same list start() schedules from.
  const historyRoster = sources
    .filter((source) => source.walksHistory === true
      && !DEFAULT_DISABLED_CONNECTORS.includes(source.name))
    .map((source) => source.name);
  // The same roster start() schedules from, by name, because probeNotReady()
  // has a connector name in hand and needs the source object back.
  const scheduledByName = new Map(
    sources
      .filter((source) => !DEFAULT_DISABLED_CONNECTORS.includes(source.name))
      .map((source) => [source.name, source])
  );
  // THE SPRINT: is this machine still inside its first-load half hour, and is
  // there still a reason for one?
  //
  // BOTH HALVES, on every ask. The clock alone would keep sprinting a walk that
  // finished last year in four minutes; the walk alone would sprint forever on a
  // machine whose only local source is unprovisioned. `lastYearOpen` is asked of
  // the connectors that may actually sprint -- a source that cannot run is not a
  // reason to keep the phase open, but it is also not a reason to close it while
  // the clock says the owner is still waiting.
  const sprintRoster = () => SPRINT_CONNECTORS
    .filter((connector) => scheduledByName.has(connector));
  const lastYearOpen = () => {
    const lastYear = new Date(now()).getFullYear() - 1;
    return sprintRoster().some(
      (connector) => state.getCursor(`yearly-backfill:connector:${connector}:done:${lastYear}`) !== '1'
    );
  };
  // Epoch ms, or null where this machine has never begun one. Read from the
  // cursor store rather than a field, so a restart inside the window resumes
  // with what is left of it and a machine that has spent its sprint takes no
  // second one.
  const sprintStartedTs = () => {
    const parsed = Number(state.getCursor(SPRINT_STARTED_KEY));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const sprinting = () => {
    const started = sprintStartedTs();
    if (started === null) return false;
    if (now() - started >= sprintMaxMs) return false;
    return lastYearOpen();
  };
  /// Begin one if this machine is owed one. Idempotent, and deliberately never
  /// re-arms a sprint that has already been spent: the cursor is the record, and
  /// it outlives the process.
  const beginSprint = (trigger) => {
    if (sprintStartedTs() !== null) return false;
    if (sprintRoster().length === 0 || !lastYearOpen()) return false;
    state.setCursor(SPRINT_STARTED_KEY, String(now()));
    log.info('sprint_started', {
      trigger,
      sources: sprintRoster(),
      maxMs: sprintMaxMs,
      rearmMs: sprintRearmMs,
    });
    return true;
  };
  const sprintSnapshot = () => {
    const started = sprintStartedTs();
    if (started === null || !sprinting()) return null;
    return { since: started, until: started + sprintMaxMs, sources: sprintRoster() };
  };
  // Install the product-level barrier once. Existing connector year receipts
  // remain useful, so an upgrade rewinds to the current year without re-fetching
  // it: only People profiles run before the older connector walk
  // resumes. Years and booleans only—no corpus state enters the cursor store.
  const peopleBarrierVersionKey = 'yearly-backfill:people-barrier-version';
  if (peopleBarrierEnabled && state.getCursor(peopleBarrierVersionKey) !== '1') {
    const currentYear = new Date(now()).getFullYear();
    state.deleteCursor('yearly-backfill:complete');
    state.deleteCursor(`yearly-backfill:barrier:people:done:${currentYear}`);
    state.setCursor('yearly-backfill:year', String(currentYear));
    state.setCursor(peopleBarrierVersionKey, '1');
  }
  const yearlyBackfill = createYearlyBackfill({
    state,
    connectors: historyRoster,
    barriers: peopleBarrierEnabled ? ['people'] : [],
    now,
    // WHO MAY HOLD THE YEAR DURING THE SPRINT. Asked per call rather than set
    // once, so the barrier widens back out the moment the phase ends without
    // anything having to remember to say so.
    sprintingRoster: () => (sprinting() ? sprintRoster() : null),
  });
  let peopleGateTimer = null;
  let peopleGateRunning = false;

  // The settings queue is derived from the scheduler itself, not guessed from
  // a polling interval in the UI. Keep every queued source in chronological
  // order so the compact activity line can expand into the next real tasks.
  const scheduledQueue = () => [...nextRuns.entries()]
    // A source whose prerequisites are missing is scheduled but cannot work, and
    // listing it as pending told the owner they had work queued for accounts they
    // had never connected. matrix was already filtered this way through
    // connectedSocialPlatforms() below; this applies the same test one level up,
    // where it was missing.
    .filter(([connector]) => !notReady.has(connector))
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
  // WHAT IS CONNECTED-BUT-NOT-YET-READABLE, in the file the app already reads.
  //
  // These are deliberately NOT in `queue`. scheduledQueue() filters them out
  // because listing them as pending work is what put granola in the owner's
  // Activity menu for an account they had never connected, and that filter is
  // still right: a source that cannot work is not work. But "not pending" is
  // not the same as "say nothing", and saying nothing is how a sign-in that has
  // landed and a sign-in that never happened became indistinguishable from
  // outside this process. So they get their own key: a name, when the re-probe
  // is due, and HOW MANY prerequisites are missing.
  //
  // COUNT, NEVER THE STRINGS, for the same reason source_not_ready logs a
  // count: needs() messages embed absolute local paths.
  const waitingQueue = () => [...notReady.entries()]
    .map(([connector, missing]) => ({
      connector,
      missing: missing.length,
      ...(nextRuns.has(connector) ? { nextTs: nextRuns.get(connector) } : {}),
    }))
    .sort((a, b) => a.connector.localeCompare(b.connector));
  const intervalMsFor = (connector) =>
    (config.intervals?.[connector] ?? DEFAULT_INTERVAL_S) * 1000;
  // HOW LONG THE OUTSTANDING WORK TAKES -- backfill only, and null when there is
  // none.
  //
  // This used to seed the horizon with every routine scheduler deadline,
  // including the idle-window maintenance pass. Those are WAITS, not work: an
  // entirely idle daemon whose next maintenance sat at 03:30 tomorrow reported
  // "~ 17.3 hrs left" while `backfill` was empty and nothing at all was running.
  // The number was real and the sentence it formed was false, which is the worst
  // combination a status line can have.
  //
  // A routine pass is a few seconds of work on a fifteen-minute timer; the gap
  // before it says nothing about how much is left to do. Only resumable
  // Calendar/Matrix history spans multiple bounded passes and can honestly be
  // described in hours, so only that is counted here. Matrix pagination is
  // opaque, so this stays deliberately approximate rather than claiming
  // precision.
  const totalWorkEstimate = () => {
    const nowMs = now();
    // completionTimes starts EMPTY on purpose. Seeding it from scheduledQueue()
    // made an idle daemon report hours remaining off tomorrow's idle-window
    // maintenance pass -- a wait rendered as work. Only genuinely multi-pass
    // backfill may put a time in here.
    const completionTimes = [];
    const yearly = yearlyBackfill.snapshot();
    const backfill = yearly.pending;
    let backfillRooms = 0;
    // Portal discovery is finite work with a real remaining count. Its retry
    // timer is not an ETA, but its observed wall-clock throughput is: a short
    // rolling median absorbs Meta/Synapse's one-room bursts and rate limits.
    const portalInvitesPending = matrixHistoryRooms(
      state.getCursor('matrix:pending-portal-invites')
    );
    const portalMsPerRoom = portalJoinMsPerRoom(state);
    if (portalInvitesPending > 0 && portalMsPerRoom) {
      completionTimes.push(nowMs + portalInvitesPending * portalMsPerRoom);
    }

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

    // MATRIX HISTORY CONTRIBUTES NO ETA, ONLY A COUNT.
    //
    // It used to compute `minimumPasses = ceil(rooms / pagesPerPass)` and render
    // the result as an ETA. With 9 rooms and a rate of 11 that is ceil(9/11) = 1,
    // so the answer was always exactly one interval away -- "~ 0.2 hrs left" on
    // every single pass, while the per-room pagination cursors ran thousands of
    // events deep. The owner watched it and asked the only sensible question:
    // "why doesnt it ever progress from the first one / how do i knoe its working
    // / how much is left" (2026-08-29).
    //
    // The variable was honestly named minimumPasses and then rendered as though
    // it were a forecast. It is a FLOOR: Matrix pagination is opaque, a room can
    // need one more page or four hundred, and nothing here can know which. A
    // lower bound presented as time remaining is a fabricated metric in the sense
    // CLAUDE.md's first hard rule means -- it is not measuring what its label
    // claims. So: say how many conversations are being walked, and say nothing
    // about when it ends.
    //
    // TWO THINGS CHANGED IN THE MERGE, both load-bearing. The guard is main's
    // roster, not `!getCursor('matrix:history-done')`: under the year barrier
    // that cursor is written ONLY on the non-yearly branch
    // (sources/matrix.mjs), so the old guard would be permanently true. And the
    // count reads the YEAR queue first, because that is the queue the yearly
    // branch actually drains -- reading `matrix:history-rooms` there would show
    // a number that never moves, which is precisely the complaint above wearing
    // a different hat.
    if (backfill.includes('matrix')) {
      const rooms = matrixHistoryRooms(
        state.getCursor('matrix:history-year-rooms') ?? state.getCursor('matrix:history-rooms')
      );
      if (rooms > 0) {
        backfillRooms = rooms;
      }
    }

    // A count with no estimate is still worth publishing: it is the difference
    // between "something is happening to 9 conversations" and a silent panel.
    if (completionTimes.length === 0) {
      return backfill.length === 0 && portalInvitesPending === 0
        ? null
        : {
            backfill,
            backfillRooms,
            portalInvitesPending,
            ...(!yearly.complete && portalInvitesPending === 0
              ? { backfillYear: yearly.year }
              : {}),
          };
    }
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
      backfillRooms,
      portalInvitesPending,
      ...(!yearly.complete && portalInvitesPending === 0 ? { backfillYear: yearly.year } : {}),
    };
  };
  const publishActivity = (activity) => {
    const total = totalWorkEstimate();
    // WHICH REGISTRY THIS PROCESS IS RUNNING ON, in the file the app already
    // reads. FEATURE_REGISTRY is resolved once at module scope while connect
    // re-reads it per request, so a registry repaired under a running daemon
    // clears the shelf's red line while this process is still holding ALL_OFF
    // and scheduling nothing. One word costs nothing and makes the disagreement
    // legible; connect/lib/status.mjs carries it back to the shelf.
    const waiting = waitingQueue();
    // A SIBLING KEY, like `waiting`, and absent once the phase ends. The panel
    // and screen 6 both draw a sentence off it, and a phase that is over has to
    // stop claiming the machine is racing.
    const sprint = sprintSnapshot();
    writeActivity(
      {
        ...activity,
        queue: scheduledQueue(),
        ...(waiting.length > 0 ? { waiting } : {}),
        ...(sprint === null ? {} : { sprint }),
        registryState: FEATURES_REGISTRY_STATE,
        ...(total ?? {}),
      },
      activityPath
    );
  };
  const publishWaiting = () => {
    const next = scheduledQueue()[0];
    if (next) publishActivity({ phase: 'waiting', ...next });
  };

  // `blocking`, not `pending`: a trailing source is walking its own backlog above
  // the shared year and holds nobody. Gating the People year on it would put the
  // sprint's stall back one level down -- advance() waits on the People barrier,
  // and the People barrier would be waiting on mail.
  const peopleGateReady = () => {
    const snapshot = yearlyBackfill.snapshot();
    return !snapshot.complete
      && snapshot.blocking.length === 1
      && snapshot.blocking[0] === 'people';
  };

  function schedulePeopleGate(delayMs = 0) {
    if (!peopleBarrierEnabled || stopped || peopleGateRunning || peopleGateTimer || !peopleGateReady()) return;
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (peopleGateTimer === timer) peopleGateTimer = null;
      if (stopped || !peopleGateReady()) return;
      peopleGateRunning = true;
      const year = yearlyBackfill.snapshot().year;
      let retryDelayMs = null;
      try {
        const result = await completePeopleYear({ year }, ingestOpts);
        if (result.complete === true) {
          yearlyBackfill.recordBarrier('people', year);
          yearlyBackfill.advance();
        }
        publishWaiting();
        if (result.complete !== true) {
          retryDelayMs = Math.max(5_000, Math.min(60_000, Number(result.retryAfterMs) || 15_000));
        }
      } catch (error) {
        log.warn('people_year_completion_failed', {
          year,
          error: safeErrorFingerprint(error),
        });
        publishWaiting();
        retryDelayMs = 30_000;
      } finally {
        peopleGateRunning = false;
        // A completed receipt can reveal that the next older year already has
        // connector receipts from a pre-upgrade run. Start its People phase
        // immediately instead of waiting for a source's next 15-minute tick.
        if (!stopped && peopleGateReady()) schedulePeopleGate(retryDelayMs ?? 0);
      }
    }, delayMs);
    peopleGateTimer = timer;
    timers.add(timer);
  }

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

const makeCtx = ({ history = false, historyWindow = null, deadline = null } = {}) => ({
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
    // The history time budget, handed TO the source rather than only checked
    // between its invocations. HISTORY_BUDGET_MS was enforced by the
    // while-loop below, which can only notice the budget is spent once
    // source.run() has returned -- and a source that drains several API pages
    // per invocation now runs for minutes inside one call (mail at the
    // default 5 pages x 100 messages x ~667ms pacing is ~5.6 minutes per
    // account, 17x the 20s budget). A source that walks pages is expected to
    // check this between them; one that ignores it behaves exactly as before.
    ...(deadline === null ? {} : { deadline }),
  });

  async function runSource(source) {
    nextRuns.delete(source.name);
    // The disable marker is checked per run, not at startup, so
    // `run.mjs <name> --disable` takes effect at the next tick without
    // bouncing the daemon.
    if (existsSync(disableMarkerPath(source.name))) {
      needsFailures.delete(source.name);
      notReadyDelays.delete(source.name);
      yearlyBackfill.classify(source.name, false);
      yearlyBackfill.advance();
      schedulePeopleGate();
      log.info('source_disabled', { connector: source.name });
      return;
    }
    // Config reaches needs() because a source's prerequisites can depend on
    // it: calendar's Google backend requires OAuth tokens that the local
    // backend has no use for. Sources that ignore the argument are unaffected.
    //
    // A THROW HERE IS AN ANSWER, NOT AN ESCAPE -- EVENTUALLY. This call sat
    // outside every try in the process: a needs() that threw (an unreadable
    // store, a token file mid-rewrite) rejected straight past runSource into
    // schedule()'s catch, which logs and reschedules -- and never classifies.
    // classify() is reached only from a scheduled source's path, so a roster
    // member whose needs() keeps throwing is a member nothing will EVER
    // classify, and advance() waits on it forever: the year never moves for
    // anybody.
    //
    // But answering on the FIRST throw is the other bug. classify(name, false)
    // followed by a working tick's classify(name, true) drops the source out of
    // the activity queue and back in on every flap, and -- until round-4
    // finding 3 -- rewound the shared yearly walk with it. One flaky tick must
    // not cost the backfill its progress, so the answer is given only after the
    // tolerance; until then this is the stall it always was, and the source
    // keeps its place in the walk either way.
    //
    // `notReady` is CLEARED either way, and deliberately not set: absent from
    // that map is "not evaluated", which is shown in the activity queue rather
    // than hidden. Leaving the last answer standing was worse than both -- a
    // source that was unprovisioned last tick stayed filtered out of the queue
    // on the strength of a check that no longer runs.
    let missing;
    try {
      missing = await source.needs({ config });
    } catch (error) {
      const failures = (needsFailures.get(source.name) ?? 0) + 1;
      needsFailures.set(source.name, failures);
      notReady.delete(source.name);
      notReadyDelays.delete(source.name);
      if (failures >= NEEDS_FAILURE_TOLERANCE) {
        yearlyBackfill.classify(source.name, false);
        yearlyBackfill.advance();
        schedulePeopleGate();
      }
      // AND IT COUNTS AS A RUN THAT FAILED. Without this the run log's last
      // entry for the source stays its last SUCCESS, so "why has this source
      // not produced anything since Tuesday" has no answer anywhere the owner
      // can reach -- the same reason the run.mjs catch below records one.
      state.recordRun({
        connector: source.name,
        startedTs: now(),
        finishedTs: now(),
        ok: false,
        error: safeErrorFingerprint(error),
      });
      log.warn('source_needs_failed', {
        connector: source.name,
        failures,
        // The word the barrier acted on, so the log says whether this throw
        // moved anything or was absorbed.
        barrier: failures >= NEEDS_FAILURE_TOLERANCE ? 'unavailable' : 'waiting',
        error: safeErrorFingerprint(error),
      });
      publishWaiting();
      return;
    }
    needsFailures.delete(source.name);
    if (Array.isArray(missing) && missing.length > 0) {
      yearlyBackfill.classify(source.name, false);
      yearlyBackfill.advance();
      schedulePeopleGate();
      // Not a failure: an unprovisioned source waits, loudly, and is
      // re-checked next cycle. recordRun stays clean of noise runs.
      notReady.set(source.name, missing);
      // COUNT, NOT THE STRINGS. Those messages embed absolute local paths --
      // whatsapp's needs() returns "...missing at /Users/<name>/Library/Group
      // Containers/..." -- and this line runs every tick.
      // AND IT IS ASKED AGAIN SOON, not in fifteen minutes. The previous wait
      // doubles until it reaches the interval this source would have used
      // anyway; a source that becomes ready clears it below. See
      // NOT_READY_REPROBE_MS.
      const waited = notReadyDelays.get(source.name);
      const reprobeMs = Math.min(
        Number.isFinite(waited) ? waited * 2 : reprobeFloorMs,
        intervalMsFor(source.name)
      );
      notReadyDelays.set(source.name, reprobeMs);
      log.warn('source_not_ready', {
        connector: source.name,
        missing: missing.length,
        reprobeMs,
      });
      publishWaiting();
      return { notReadyDelayMs: reprobeMs };
    }
    notReady.delete(source.name);
    notReadyDelays.delete(source.name);
    const startedTs = now();
    const socialPlatforms = source.name === 'matrix' ? connectedSocialPlatforms() : [];
    // WAS THIS SOURCE'S STANDING A GUESS? If startup could not ask it, the
    // restart reconciliation ran against an incomplete answer and stopped: it
    // is called ONCE, and the year it could have crossed has no task left in it
    // to call advance() again. So the first real answer re-runs it.
    const wasProvisional = yearlyBackfill.snapshot().provisional.includes(source.name);
    yearlyBackfill.classify(
      source.name,
      source.walksHistory === true && (source.name !== 'matrix' || socialPlatforms.length > 0)
    );
    if (wasProvisional) {
      const recovery = yearlyBackfill.reconcile();
      if (recovery.advanced > 0 || recovery.repaired) {
        log.info('history_reconciled_after_guess', {
          connector: source.name,
          fromYear: recovery.fromYear,
          toYear: recovery.year,
          barriers: recovery.advanced,
          repaired: recovery.repaired,
          complete: recovery.complete,
        });
      }
      schedulePeopleGate();
    }
    publishActivity({
      phase: 'syncing',
      connector: source.name,
      ...(socialPlatforms.length ? { platforms: socialPlatforms.map((platform) => platform.label) } : {}),
      startedTs,
    });
    let nextDelayMs = null;
    // Read ONCE, before the forward pass, so one tick has one answer about which
    // phase it is in; re-asked after the history loop, where the answer may have
    // just changed because this very pass finished the year.
    const sprintingNow = sprinting();
    let sprintDelayMs = null;
    // THE ONE STOP THAT MUST NOT COME STRAIGHT BACK. A pass that read nothing is
    // a source with nothing to give, and asking it again in ten seconds is a
    // busy-loop. Every other ending is work in progress.
    //
    // DECLARED OUT HERE because the case that stalled the live run never entered
    // the history block at all: iMessage finished 2026, task() answered null
    // while the barrier had not advanced yet, and a re-arm keyed off `slices > 0`
    // saw zero and went back to sleep for nine hundred seconds. Waiting on a
    // barrier the sprint is actively clearing is the state that most needs to
    // come back soon, and it is the one that looks emptiest from inside the loop.
    let stoppedOnNothing = false;
    try {
      // The forward pass first, always: what arrived since last time is more
      // urgent than what happened in 2019, and history must never delay it.
      const forward = (await source.run(makeCtx({ deadline: now() + FORWARD_BUDGET_MS }))) ?? {};
      if (source.name === 'matrix' && Number.isInteger(forward.historyDiscoveryPending)) {
        observePortalJoinRate(
          state,
          forward.historyDiscoveryPending,
          now(),
          forward.historyDiscoveryPending > 0 && forward.historyDiscoveryJoined > 0
            ? forward.retryAfterMs
            : null
        );
      }
      // Sources may discover short-lived local work that should not wait for
      // their ordinary polling interval. Matrix uses this after Synapse rate-
      // limits a portal-join recovery pass. The source supplies only a bounded
      // delay, never an identifier or cursor.
      if (Number.isFinite(forward.retryAfterMs) && forward.retryAfterMs >= 1_000) {
        nextDelayMs = Math.min(60_000, Math.floor(forward.retryAfterMs));
      }
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
      // Matrix discovers one portal room per conversation. During a large
      // first-run invite backlog, starting yearly history immediately means
      // each newly joined room invalidates the traversal that just ran:
      // 2026→2025→2024→2026, over and over. Forward sync still lands every new
      // event; only the backwards walk waits until the finite discovery queue
      // reaches zero, then runs once across the complete room roster.
      const historyDiscoveryPending = Number(forward.historyDiscoveryPending) > 0;
      if (source.walksHistory === true && historyWindow && !historyDiscoveryPending) {
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
        // AND THE SPRINT SPENDS A BIGGER ONE. Same shape, same self-tuning, three
        // times the slice -- and paired with the re-arm below, which is what
        // actually moves the needle: the budget decides how much one tick walks,
        // the re-arm decides how soon the next tick comes.
        const inSprint = sprintingNow && SPRINT_CONNECTORS.includes(source.name);
        const deadline = now() + (inSprint ? sprintHistoryBudgetMs : HISTORY_BUDGET_MS);
        let slices = 0;
        let gained = 0;
        try {
          while (now() < deadline) {
            const rawBack = (await source.run(makeCtx({ history: true, historyWindow, deadline }))) ?? {};
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
              // The year this pass was HANDED, which for a trailing connector is
              // above the shared one. See yearlyBackfill.record.
              yearlyBackfill.record(source.name, rawBack, historyWindow.year);
              yearlyBackfill.advance();
              schedulePeopleGate();
              break;
            }
            // A sparse calendar can have an empty historical year while still
            // advancing its private cursor. Let that source continue through
            // the gap; sources that did not explicitly report progress keep
            // the old all-zero stop behaviour.
            if (
              back.ingested === 0 && back.updated === 0 && back.unchanged === 0
              && rawBack.historyProgressed !== true
            ) {
              stoppedOnNothing = true;
              break;
            }
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
      // COME STRAIGHT BACK. The whole point of the phase, and it is asked OUTSIDE
      // the history block on purpose: the three states worth returning for are a
      // pass the clock cut short, a pass that finished a year with more below it,
      // and a tick that found no window because a barrier has not lifted yet.
      // Only the first two are visible from inside the loop, and the live stall
      // was the third.
      //
      // `sprinting()` is re-asked rather than reusing `sprintingNow`, because a
      // pass that just recorded last year has ENDED the phase and must not be
      // the thing that extends it. `outstanding` is what keeps this from
      // becoming a busy-loop on a source that is genuinely finished.
      if (
        !stoppedOnNothing
        && sprinting()
        && SPRINT_CONNECTORS.includes(source.name)
        && yearlyBackfill.outstanding(source.name)
      ) {
        sprintDelayMs = sprintRearmMs;
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
        ...(sprintDelayMs === null ? {} : { sprintRearmMs: sprintDelayMs }),
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
    // nextDelayMs first: a source that asked for a short retry of its own (a
    // rate-limited portal join) is answering about work the sprint knows nothing
    // about. sourceRetryDelay reads them in that order too.
    return { nextDelayMs, sprintDelayMs };
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
      let result;
      try {
        result = await fn();
      } catch (error) {
        log.error('schedule_task_failed', {
          error: safeErrorFingerprint(error),
        });
      }
      if (!stopped) reschedule(result);
    }, delayMs);
    timers.add(timer);
    return timer;
  }

  // ONE TIMER PER SOURCE, ALWAYS -- see sourceTimers. Arming replaces whatever
  // was already armed for this source, so probeNotReady() can pull a waiting
  // source forward without leaving its old fifteen-minute timer behind to fire
  // a second, overlapping pass.
  function scheduleSource(source, delayMs) {
    const intervalMs = intervalMsFor(source.name);
    const armed = sourceTimers.get(source.name);
    if (armed !== undefined) {
      clearTimeout(armed);
      timers.delete(armed);
      sourceTimers.delete(source.name);
    }
    nextRuns.set(source.name, now() + delayMs);
    publishWaiting();
    const timer = schedule(
      () => runSource(source),
      delayMs,
      (result) => scheduleSource(
        source,
        sourceRetryDelay(result, intervalMs)
      )
    );
    if (timer !== undefined) sourceTimers.set(source.name, timer);
  }

  // ASK EVERY WAITING SOURCE AGAIN, RIGHT NOW.
  //
  // The back-off above shortens the wait; this removes it. The app is the
  // daemon's parent process and it is the process that KNOWS when the owner
  // finished signing in to Google or dropped their LinkedIn export in, so it
  // says so (SIGUSR2) rather than leaving the daemon to find out on a timer.
  // Onboarding then costs seconds instead of a minute, and a reinstall stops
  // being the thing that makes a first run work.
  //
  // ONLY SOURCES IN `notReady`, and only ones currently ARMED. A source absent
  // from nextRuns is mid-run -- runSource deletes it for the whole call -- and
  // its own tick is already the probe; re-arming it there would start a second
  // pass beside the one in flight. A needs() that THROWS is left exactly as it
  // was: the three-strike tolerance in runSource owns that state, and answering
  // it from here would hand the yearly walk a re-classification out of band.
  async function probeNotReady(trigger) {
    if (stopped) return { probed: 0, ready: [] };
    const pending = [...notReady.keys()];
    const ready = [];
    for (const connector of pending) {
      if (stopped) break;
      const source = scheduledByName.get(connector);
      if (source === undefined) continue;
      // Re-read rather than trusting the snapshot: this loop awaits, and another
      // source's tick can land inside it. A connector that answered for itself
      // while we were waiting has already been rescheduled, and pulling it
      // forward again would run it twice for one nudge.
      if (!notReady.has(connector)) continue;
      if (!nextRuns.has(connector)) continue;
      if (existsSync(disableMarkerPath(connector))) continue;
      let missing;
      try {
        missing = await source.needs({ config });
      } catch {
        continue;
      }
      if (Array.isArray(missing) && missing.length > 0) {
        notReady.set(connector, missing);
        continue;
      }
      notReady.delete(connector);
      notReadyDelays.delete(connector);
      ready.push(connector);
      scheduleSource(source, 0);
    }
    // AND THE NUDGE IS ALSO WHEN A FIRST LOAD BEGINS. Onboarding starts the
    // reader before the owner has connected anything, so the startup check below
    // can run on a machine with no local store to walk yet; the nudge is the
    // moment that stops being true.
    beginSprint(trigger);
    log.info('sources_reprobed', {
      trigger,
      waiting: pending.length,
      ready: ready.length,
    });
    publishWaiting();
    return { probed: pending.length, ready };
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
    probeNotReady,
    sprintSnapshot,
    start() {
      const scheduledSources = sources.filter((source) => !DEFAULT_DISABLED_CONNECTORS.includes(source.name));
      sources.forEach((source) => {
        if (DEFAULT_DISABLED_CONNECTORS.includes(source.name)) {
          log.info('source_hidden', { connector: source.name });
          // Belt and braces for the deadlock above: historyRoster is built from
          // the same filter, so this is a no-op today. It stops being one the
          // moment the two lists are computed in different places again.
          yearlyBackfill.withdraw(source.name);
        }
      });
      // THE OUTAGE SAYS SO, in the log the app reads.
      //
      // An unreadable registry is ALL_OFF including imessage, mail, calendar
      // and contacts — the card's own sources — so this daemon is scheduling
      // nothing and the connections page is drawing an empty shelf. Counts and
      // the state name only, which is all a diagnosis needs.
      if (FEATURES_REGISTRY_STATE !== 'ok') {
        log.error('features_registry_unreadable', {
          registryState: FEATURES_REGISTRY_STATE,
          detail: 'every feature and connector is off until the registry is readable — reinstall',
          scheduled: scheduledSources.length,
          hidden: DEFAULT_DISABLED_CONNECTORS.length,
        });
      }
      // ASK WHAT CANNOT RUN BEFORE PUBLISHING A QUEUE, not after.
      //
      // notReady is populated inside runSource, so it is EMPTY at startup — and
      // scheduleSource publishes immediately. Every daemon restart therefore
      // listed granola and mail as pending work for up to a full stagger
      // (~90s) before their first ticks corrected it. The owner saw exactly
      // that: "granola's started showing back up in the activity menu when it
      // isnt connected". It was not a regression of the filter; the filter had
      // nothing to filter on yet.
      //
      // needs() is cheap — an existsSync or a token read — and the whole point
      // of it being re-checked before every run is that it is safe to call. So
      // call it once up front. Failures leave the source ABSENT from the map,
      // which shows it: unknown must never read as unprovisioned.
      Promise.allSettled(scheduledSources.map(async (source) => {
        // Match runSource's first gate. A manually disabled history source is
        // unavailable for the barrier even if all of its ordinary credentials
        // remain present.
        if (existsSync(disableMarkerPath(source.name))) {
          yearlyBackfill.classify(source.name, false);
          return;
        }
        // Same reasoning as runSource's gate for notReady -- a throwing needs()
        // leaves the source ABSENT from that map, because unknown must not read
        // as unprovisioned.
        //
        // BUT NOT THE TOLERANCE (round-4 finding 14). The three-strike rule
        // exists to stop a flaky tick from turning into a RE-activation, and a
        // re-activation is what rewinds the shared walk. At startup nothing has
        // been classified yet, so classify(name, false) here is the source's
        // FIRST answer rather than a re-classification, and it costs the walk
        // nothing. Withholding it costs plenty: advance() waits on
        // unclassified(), so one throwing needs() froze the year for every
        // source until the tolerance was spent -- up to 30 minutes at default
        // intervals -- and reconcile() below, which runs once and only here,
        // gave up immediately on an unclassified roster and left a restart's
        // already-complete barriers uncrossed.
        //
        // AND IT IS SAID OUT LOUD. This path runs BEFORE any tick, so it is
        // the one that answers "why was this source unavailable at startup",
        // and it used to swallow the error whole: the single diagnostic for
        // that question did not exist on the path that reaches it first.
        let missing;
        try {
          missing = await source.needs({ config });
        } catch (error) {
          // The count carries into the running daemon's own gate, so a source
          // that is broken rather than briefly locked reaches the tolerance
          // one tick sooner than if startup had said nothing.
          const failures = (needsFailures.get(source.name) ?? 0) + 1;
          needsFailures.set(source.name, failures);
          // CLASSIFIED, AND MARKED AS A GUESS. The classification still has to
          // happen -- advance() waits on unclassified(), and reconcile() below
          // gives up on an unclassified roster -- but a throw is "we could not
          // ask", and the walk must not advance a year on the strength of it.
          // A Photos library locked for twenty seconds across a restart was
          // enough to advance 2026 past a source that had 2026 work, and the
          // recovering tick then rewound the whole walk to fetch it again.
          // See yearlyBackfill's `provisional`; the wait ends at this source's
          // first real tick, one stagger away.
          yearlyBackfill.classify(source.name, false, { unanswered: true });
          log.warn('source_needs_failed', {
            connector: source.name,
            failures,
            barrier: 'unavailable',
            at: 'startup',
            error: safeErrorFingerprint(error),
          });
          return;
        }
        needsFailures.delete(source.name);
        if (Array.isArray(missing) && missing.length > 0) {
          notReady.set(source.name, missing);
          yearlyBackfill.classify(source.name, false);
          return;
        }
        const socialPlatforms = source.name === 'matrix' ? connectedSocialPlatforms() : [];
        yearlyBackfill.classify(
          source.name,
          source.walksHistory === true
            && (source.name !== 'matrix' || socialPlatforms.length > 0)
        );
      })).then(() => {
        const recovery = yearlyBackfill.reconcile();
        if (recovery.advanced > 0 || recovery.repaired) {
          log.info('history_restart_reconciled', {
            fromYear: recovery.fromYear,
            toYear: recovery.year,
            barriers: recovery.advanced,
            // A COMPLETE mark that nothing could have written honestly, cleared.
            // It is the one line that explains why a machine that reported its
            // history finished has started walking again.
            repaired: recovery.repaired,
            complete: recovery.complete,
          });
        }
        schedulePeopleGate();
        // AFTER the probe, not before it: beginSprint asks which sprint-eligible
        // sources are scheduled and whether last year is still open, and both
        // answers are worth having once readiness has been evaluated.
        beginSprint('startup');
        publishWaiting();
      });

      scheduledSources.forEach((source, i) => scheduleSource(source, 1_000 + i * FIRST_RUN_STAGGER_MS));
      scheduleMaintenance();
      log.info('daemon_started', {
        sources: scheduledSources.map((s) => s.name),
        hidden: DEFAULT_DISABLED_CONNECTORS,
        // NAMES ONLY — the logger refuses row content and this is the same
        // discipline: what is on, never the file and never a count that could
        // be read as owner data. It is also the line that answers "why did this
        // source never run" without anyone opening the bundle.
        features: enabledFeatureNames(FEATURES),
        optional: OPTIONAL_CONNECTORS,
        maintainHour: config.retention?.maintainHour ?? '03:30',
      });
      if (scheduledSources.length === 0) {
        log.warn('no_sources', { detail: 'connectors/sources/ is empty; every source is disabled or missing' });
        // AND SAY SO ON DISK. publishWaiting only writes when there is a next
        // task, so the state an unreadable registry produces — nothing
        // scheduled, ever — was also the state in which this daemon never wrote
        // an activity file at all. The one outage the owner cannot diagnose is
        // not the one to stay silent about.
        publishActivity({ phase: 'waiting' });
      }
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      sourceTimers.clear();
      peopleGateTimer = null;
    },
  };
}

// --- CLI entry ------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// THE NUDGE, AND WHY ITS HANDLER IS INSTALLED BEFORE THERE IS A DAEMON TO NUDGE.
//
// This process is a child of the app (widget/src/Connectors.swift), and the app
// is what knows the moment the owner finished signing in to Google or dropped
// their LinkedIn export in. A signal is the channel that already exists between
// a parent and its child: no listener, no file to watch, nothing added to the
// network posture at the top of this file. The back-off in NOT_READY_REPROBE_MS
// is what covers a daemon nobody nudged.
//
// SIGUSR2 rather than SIGUSR1, which node reserves for its own debugger.
//
// AND THE DEFAULT ACTION FOR SIGUSR2 IS TERMINATE. Between exec and the line
// that handles it, a nudge KILLS this process — and the startup this races is
// exactly the one the app is nudging, because both are triggered by the same
// launch. So the handler goes in as early as there is a logger to report
// through, and a nudge that arrives before the daemon exists is REMEMBERED
// rather than dropped: the startup probe answers the same question, but only
// for the readiness that existed when it ran.
let nudgeTarget = null;
let nudgePending = false;

function runNudge(daemon, log, trigger) {
  daemon.probeNotReady(trigger).catch((error) => {
    log.warn('reprobe_failed', { error: safeErrorFingerprint(error) });
  });
}

function armNudge(daemon, log) {
  nudgeTarget = daemon;
  if (!nudgePending) return;
  nudgePending = false;
  runNudge(daemon, log, 'SIGUSR2-during-startup');
}

if (isMain) {
  const log = createLogger();
  process.on('SIGUSR2', () => {
    if (nudgeTarget === null) {
      nudgePending = true;
      return;
    }
    runNudge(nudgeTarget, log, 'SIGUSR2');
  });
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
    armNudge(daemon, log);
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
