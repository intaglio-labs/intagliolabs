// What the connect page renders: one row per source, with the truth about
// whether it is actually usable right now.
//
// These checks deliberately mirror connectors/doctor.mjs rather than shelling
// out to it. Doctor is a diagnostic that must run under launchd to prove the
// Full Disk Access grant; the connect page is a UI that wants a cheap answer
// on every load. Where they can disagree is exactly the FDA rows — so those
// rows say so, instead of rendering a red X the owner cannot act on.

import { DatabaseSync } from 'node:sqlite';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PLATFORMS, bridgeStatus } from './bridge.mjs';
import {
  CALENDAR_SCOPE,
  GMAIL_SCOPE,
  accountsWithScope,
  accountsWithScopeIncludingStale,
} from '../../connectors/lib/googleAccounts.mjs';
import { listGoogleClients } from '../../connectors/lib/googleClients.mjs';
import { REGISTRY_STATES, defaultOverridePath, readFeatureRegistry } from '../../connectors/lib/features.mjs';
import { daemonLockIsLive } from '../../connectors/lib/daemonLock.mjs';
import { CONNECTOR_NAMES } from '../../connectors/lib/connectorNames.mjs';

const SECRETS = (home) => join(home, '.hazlie', 'secrets');

// A source the owner turned off with `run.mjs <name> --disable`. The daemon
// checks this marker every tick (connectors/daemon.mjs), so a disabled source
// never runs — and a row that still reported "connected" because its store
// happens to be readable would be describing a poll that will not happen.
// Readable is not the same as running.
function connectorForStatusRow(id) {
  if (id.startsWith('mail:')) return 'mail';
  // The export row, whose poller is sources/linkedin.mjs — NOT the bridge that
  // shares the platform name one line below. Ahead of the PLATFORMS test on
  // purpose: `linkedin` is in that table, so without this the export tile would
  // answer to the Matrix marker and ignore its own.
  if (id === LINKEDIN_EXPORT_ID) return 'linkedin';
  // Seven status rows, one Matrix poller and therefore one disable marker.
  if (Object.hasOwn(PLATFORMS, id)) return 'matrix';
  return id;
}

const disabledMarker = (home, id) => {
  const connector = connectorForStatusRow(id);
  return existsSync(join(home, '.hazlie', 'connectors', `${connector}.disabled`));
};

function withDisabled(row, home) {
  if (!disabledMarker(home, row.id)) return row;
  // WhatsApp is the one passive store a fresh app deliberately gates in the
  // product UI. Preserve the existing CLI-only semantics for every other
  // source: their markers may have been created by run.mjs --disable, and the
  // native enable action is intentionally not authorized to mutate them.
  if (row.id !== 'whatsapp') {
    const connector = connectorForStatusRow(row.id);
    return {
      ...row,
      connected: false,
      broken: false,
      // THE FLAG, NOT ONLY THE WORDS. `detail: 'turned off'` fixed the connect
      // page, which renders the sentence -- but the widget's shelf renders from
      // the row's SHAPE, so a disabled source still drew as merely un-set-up and
      // still offered to sign the owner into it. A surface cannot tell "off"
      // from "not yet connected" out of prose. connector-tile.js already reads
      // this flag for the WhatsApp case below; this is the same signal for the
      // CLI-disabled ones, without the enable button, because those markers are
      // run.mjs' and the native action is deliberately not authorized to remove
      // them.
      disabled: true,
      detail: 'turned off',
      action: null,
      fix: `re-enable with: rm ~/.hazlie/connectors/${connector}.disabled`,
      caveat: null,
    };
  }
  return {
    ...row,
    connected: false,
    broken: false, // off on purpose is not a fault; it must never paint red
    disabled: true,
    detail: 'not connected yet',
    action: 'enable',
    fix: null,
    caveat: null,
  };
}

// One app password per mailbox, filed under a slug of the address. Gmail
// issues app passwords per-account, so there is no single credential that
// could cover several mailboxes even in principle.
export function mailSecretName(address) {
  return `gmail-app-password-${String(address).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}.txt`;
}

// Mailboxes this Mac holds a Gmail grant for. The connectors' own account
// store is the single source of truth — connect/ and connectors/ disagreeing
// about which mailboxes exist is exactly what the old config coupling was
// there to prevent, and this keeps that property on a better credential.
// The sign-in clients available, for a UI that has to ask which to use.
export function googleClientChoices({ home = homedir() } = {}) {
  try {
    return listGoogleClients({ home });
  } catch {
    return []; // an unreadable secrets dir costs the choice, not the page
  }
}

export function googleMailAccounts({ home = homedir() } = {}) {
  try {
    // INCLUDING THE DEAD ONES. accountsWithScope hides a stale grant from the
    // CONNECTORS, which is right — re-presenting a refused token every tick
    // earns nothing but rate limiting. It would be exactly wrong here: a
    // mailbox that has stopped working is the row this page most needs to
    // draw, and hiding it is how a broken source becomes an invisible one.
    return accountsWithScopeIncludingStale(GMAIL_SCOPE, { home });
  } catch {
    return []; // an unreadable secrets dir costs the mail rows, not the page
  }
}

// Per-account SETTINGS (backfill window, body cap) still live in the
// connectors config — see accountSettings in connectors/sources/mail.mjs. This
// no longer decides which mailboxes EXIST; the grants do.
export function mailAccounts({ home = homedir() } = {}) {
  const path = join(home, '.hazlie', 'connectors', 'config.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const accounts = raw?.mail?.accounts;
    if (!Array.isArray(accounts)) return [];
    return accounts.filter((a) => typeof a?.user === 'string' && a.user.length > 0);
  } catch {
    return [];
  }
}

// ~~isMailAddress / addMailAccount / ADDRESS.~~ Deleted with the app password
// (2026-08-26). They existed so this page could register a mailbox in the
// connectors config and then accept a secret filed under it; an OAuth grant
// registers itself, so there is nothing left to validate or write.
// mailSecretName stays: connectors/lib/checks.mjs still names the old secret
// file when telling an owner about an obsolete credential left on disk.

function ownerOnlyFileExists(path) {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function canReadSqlite(path) {
  if (!existsSync(path)) return false;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

// The three not-connected outcomes here are not equivalent, which is why the
// row carries `broken`. No token file at all means the owner never authorized
// Oura — an empty slot. A file that exists but is truncated or unparseable
// means authorization HAPPENED and has since gone wrong, which the owner can
// only fix if something tells them.
function ouraState(home) {
  const path = join(SECRETS(home), 'oura-tokens.json');
  if (!ownerOnlyFileExists(path)) return { connected: false, detail: 'not authorized yet' };
  const reauth = 'Re-authorize Oura from this page — the stored token is unusable, so re-running the connect step replaces it.';
  try {
    const t = JSON.parse(readFileSync(path, 'utf8'));
    if (!t.access_token || !t.refresh_token) {
      return { connected: false, detail: 'tokens incomplete', broken: true, fix: reauth };
    }
    const scopes = String(t.scope ?? '').split(/\s+/u).filter(Boolean).length;
    return { connected: true, detail: `authorized · ${scopes} scopes` };
  } catch {
    return { connected: false, detail: 'token file unreadable', broken: true, fix: reauth };
  }
}

// BROKEN vs NOT SET UP. `connected: false` covers two situations the owner
// experiences completely differently, and until 2026-08-22 the shelf drew both
// as the same hollow dot: a source they have simply never linked (four bridges
// sitting there waiting), and a source that IS set up and cannot work (macOS
// revoked a permission, a token went bad). The first is an empty slot and needs
// no attention; the second is a failure and needs exactly one thing — to be
// told, and told what to do.
//
// So `broken: true` means: this is expected to work and does not. It drives the
// red dot, and it is set ONLY where the owner can act. `fix` is the sentence
// they act on. Absent `broken` is falsy, so every other row is unaffected.
const FDA_FIX =
  'Open System Settings → Privacy & Security → Full Disk Access, then switch on ' +
    // NAMES THE APP, NOT node. The reader is a CHILD of intaglio labs now
    // rather than a launchd agent, and macOS attributes a grant to the
    // RESPONSIBLE process — so the row to switch on is the app. Naming node
    // sent people to grant a permission that does nothing, and asked them to
    // trust a unix binary they never installed.
    'intaglio labs. If it is already listed, toggle it off and on again — macOS ' +
    'ties the permission to that exact app, and it is replaced on every update.';

// One row per Apple store this machine reads. All three are Full Disk Access
// territory, and TCC attributes the grant to the responsible process — so a
// red X here may only mean this page was started from a shell rather than by
// launchd. Saying that is better than a cross the owner cannot act on.
//
// That caveat is also why `broken` is only trustworthy from the launchd-run
// connect service (ops/io.intaglio.connect.plist runs it under
// ~/.hazlie/bin/node). Verified 2026-08-22: the same code says FAIL from a dev
// shell and PASS under launchd, on a machine whose grant was fine the whole
// time. A shell-run status must never be what paints the shelf red.
function localStoreRow({ id, label, path, reads }) {
  const ok = canReadSqlite(path);
  return {
    id,
    label,
    connected: ok,
    detail: ok ? reads : 'needs Full Disk Access',
    action: ok ? null : 'fda',
    broken: !ok,
    fix: ok ? null : FDA_FIX,
    caveat: ok
      ? null
      : 'If this page was started from a shell rather than launchd, the grant may exist and simply not apply here.',
  };
}

// Contacts is the identity spine (connectors/sources/contacts.mjs), not a
// corpus source — it reads the AddressBook stores under FDA, same posture as
// iMessage. "Connected" = at least one AddressBook-v22.abcddb is readable;
// there is always the top-level store plus one per synced account. The row
// leads with what makes it worth it: names, so hazlie says "dad" not a number.
function contactsRow(home) {
  const base = join(home, 'Library', 'Application Support', 'AddressBook');
  const stores = [join(base, 'AddressBook-v22.abcddb')];
  try {
    for (const entry of readdirSync(join(base, 'Sources'))) {
      stores.push(join(base, 'Sources', entry, 'AddressBook-v22.abcddb'));
    }
  } catch {
    // no synced accounts is fine; the top-level store still counts.
  }
  const ok = stores.some((p) => canReadSqlite(p));
  return {
    id: 'contacts',
    label: 'Contacts',
    connected: ok,
    detail: ok ? 'names behind the numbers' : 'needs Full Disk Access',
    action: ok ? null : 'fda',
    broken: !ok,
    fix: ok ? null : FDA_FIX,
    caveat: ok
      ? null
      : 'If this page was started from a shell rather than launchd, the grant may exist and simply not apply here.',
  };
}

// The cloud-sync folders. Not an FDA row and not an OAuth row: this reads the
// local mirrors iCloud/Box/Dropbox already maintain, so "connected" means the
// folders are present, and there is no credential and no network involved.
function filesRow(home) {
  const roots = [
    ['iCloud Drive', join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')],
    ['Box', join(home, 'Library', 'CloudStorage', 'Box-Box')],
    ['Dropbox', join(home, 'Dropbox')],
  ].filter(([, path]) => existsSync(path));
  return {
    id: 'files',
    label: 'Files',
    connected: roots.length > 0,
    detail: roots.length
      ? `reading names in ${roots.map(([label]) => label).join(', ')}`
      : 'no iCloud, Box or Dropbox folder found',
    action: roots.length ? null : 'files',
    caveat: null,
  };
}

function notionRow(home) {
  const ok = ownerOnlyFileExists(join(SECRETS(home), 'notion-api-key.txt'));
  return {
    id: 'notion',
    label: 'Notion',
    connected: ok,
    detail: ok ? 'integration token stored' : 'needs a Notion integration token',
    action: ok ? null : 'notion',
    caveat: null,
  };
}

// The owner's Mac after the 2026-08-20 change: it runs every connector, so
// every source belongs on one page. No link row is rendered at all — hermes is
// local now, and nothing crosses a network except the finished digest.
function whatsappRow(home) {
  // Local-store connector, so "connected" is: does WhatsApp Desktop's store
  // exist? It exists once the app has run and linked to the phone at least
  // once. Staleness (app not opened lately) is a run-time WARN, not a
  // connection state — the store is present either way.
  const ok = existsSync(join(home, 'Library', 'Group Containers',
    'group.net.whatsapp.WhatsApp.shared', 'ChatStorage.sqlite'));
  return {
    id: 'whatsapp',
    label: 'WhatsApp',
    connected: ok,
    detail: ok ? 'reading WhatsApp Desktop history' : 'needs WhatsApp Desktop, linked to your phone',
    action: ok ? null : 'whatsapp',
    caveat: 'Only as fresh as the last time WhatsApp Desktop ran — the phone syncs it while the app is open.',
  };
}

// The social bridges (Messenger, Instagram). "Connected" is read from each
// bridge's own DB — a live login row — so the page tells the truth without
// touching Meta. Not yet linked → a row that opens Intaglio Labs' own login panel
// (action 'bridge'), never a third-party client.
function bridgeRows({ home = homedir() } = {}) {
  return Object.values(PLATFORMS).map((p) => {
    const st = bridgeStatus(p.id, { home });
    const discordImport = p.id === 'discord' && st.connected
      ? discordImportState({ home })
      : null;
    // Authentication and usable data are two separate milestones for Discord.
    // Its QR approval writes the user row first; portal discovery and message
    // backfill follow asynchronously. Reporting the first milestone as a green
    // check left a long, silent gap in which the tile promised data that did
    // not exist yet. Keep the authenticated state (so pressing the tile cannot
    // start a second login), but expose `pending` until the bridge DB contains
    // imported message rows. The widget renders that as its waiting ring.
    const pending = discordImport?.ready === false;
    return {
      id: p.id,
      label: p.label,
      connected: st.connected,
      pending,
      detail: st.connected
        ? pending
          ? 'linked · finding conversations and importing messages'
          : `linked${st.name ? ` as ${st.name}` : ''} · DMs syncing`
        : `link your ${p.label} DMs`,
      action: st.connected ? null : 'bridge',
      caveat: st.connected ? null : 'reads your own DMs through a local bridge on this Mac — the bridge stays signed in to the platform to do it.',
      ...(discordImport?.verified ? {
        importedMessages: discordImport.messageCount,
        discoveredConversations: discordImport.portalCount,
      } : {}),
    };
  });
}

// Verify Discord DATA, not merely its login row. Exact aggregate counts are
// intentionally returned: they are local-only, contain no message content,
// and let the UI/API prove why the tile is ready. read_state_version advances
// during Discord's initial account sync; a non-zero value with no portals is
// the valid empty-account case and must not spin forever.
export function discordImportState({ home = homedir() } = {}) {
  let db;
  try {
    db = new DatabaseSync(join(home, '.hazlie', 'matrix', 'discord', 'mautrix-discord.db'), {
      readOnly: true,
    });
    const portalCount = Number(db.prepare(
      'SELECT COUNT(*) AS count FROM portal WHERE mxid IS NOT NULL'
    ).get()?.count ?? 0);
    const messageCount = Number(db.prepare('SELECT COUNT(*) AS count FROM message').get()?.count ?? 0);
    const readStateVersion = Number(db.prepare(
      'SELECT COALESCE(MAX(read_state_version), 0) AS version FROM "user"'
    ).get()?.version ?? 0);
    return {
      verified: true,
      portalCount,
      messageCount,
      ready: messageCount > 0 || (portalCount === 0 && readStateVersion > 0),
    };
  } catch {
    // Fail closed: if an authenticated Discord database cannot be verified,
    // the tile waits instead of claiming the import succeeded.
    return { verified: false, portalCount: 0, messageCount: 0, ready: false };
  } finally {
    try { db?.close(); } catch {}
  }
}

// ~~linkedinRow: connected meant Connections.csv was sitting in
// ~/.hazlie/imports/linkedin, from an export the owner had to request,
// wait hours for, download and unzip.~~ Yeeted (owner, 2026-08-25, asked
// twice): LinkedIn is a social platform like the other six and now rides the
// same bus — mautrix-linkedin in bridges/docker-compose.yml, listed by
// bridgeRows() below from the PLATFORMS table. Its rows keep the SAME
// `linkedin` source name the export wrote, so nothing downstream changed.
//
// BACK AS A SECOND ROW, and the reason is the feature registry rather than a
// reversal of that call. With `bridges` off, the bridge tile is correctly
// hidden — the bridge is not provisioned — while `connectors.linkedin` stays
// TRUE and connectors/sources/linkedin.mjs stays scheduled, waiting on a
// Connections.csv nothing on screen asks for. The owner had no surface telling
// them where to drop the file for a connector this install is actively running.
// One row per flow: the bridge tile lives behind `bridges`, this one behind the
// connector, and the shelf shows whichever applies (widget/ui/connections.js).
export const LINKEDIN_EXPORT_ID = 'linkedin-export';

function linkedinExportRow(home) {
  // File-based on purpose — the export, never an API or a scrape. Connected
  // means Connections.csv is in place; messages.csv is optional and not
  // checked, because its absence is a choice rather than a fault. Existence
  // only: no names, no counts of rows, nothing out of the file itself.
  const ok = existsSync(join(home, '.hazlie', 'imports', 'linkedin', 'Connections.csv'));
  return {
    id: LINKEDIN_EXPORT_ID,
    label: 'LinkedIn',
    connected: ok,
    // OPTIONAL, like "add another Google account" and for the same reason. The
    // archive is requested from LinkedIn, produced in its own time, mailed,
    // downloaded and unzipped by hand — a standing invitation rather than
    // outstanding work. Counted as work, the connect page's footer on a Mac
    // that never drops the file could never reach "all set", and the row took
    // the page's single filled accent away from something actionable.
    optional: true,
    detail: ok ? 'export imported' : 'needs your LinkedIn data export',
    action: ok ? null : 'linkedin',
    caveat: null,
  };
}

/// WHICH ROWS THIS BUILD ACTUALLY OFFERS — the one place that rule is written.
///
/// readStatus() answers every source this install CAN connect; the feature
/// registry says which of them this build runs. Until now only the widget shelf
/// (widget/ui/connections.js) applied that, and connect/server.mjs rendered the
/// raw list — so the loopback page drew bridge tiles for a bridge that is not
/// provisioned and two rows both called "LinkedIn".
///
/// Two rules, and the second is the one that is easy to forget:
///
///   * a row whose CONNECTOR feature is false is hidden — by connector, not by
///     id, because `mail:<address>` rows are the mail connector and the export
///     row is the linkedin one;
///   * every bridge tile goes with `bridges`, because the Matrix bus IS that
///     feature. `isBridgeRow` is the discriminator rather than the id, which
///     matters for LinkedIn precisely: `linkedin` is both a bridge platform and
///     the connector that reads the data export.
///
/// A connector the registry does not mention at all is LEFT ALONE, matching
/// connectorsDisabledBy: the daemon schedules such a module, and a shelf that
/// hid it would disagree with what the machine is doing.
///
/// The widget cannot import this (the shelf is a classic <script> in a
/// WKWebView), so connections.js carries the mirror; both are pinned against
/// the same cases, here and in widget/test/connector-visibility.test.mjs.
function isBridgeRow(row) {
  return row.action === 'bridge' || Object.hasOwn(PLATFORMS, row.id);
}

export function visibleStatusRows(rows, features) {
  const shown = rows.filter((row) => {
    if (isBridgeRow(row)) return features?.bridges === true;
    return features?.connectors?.[connectorForStatusRow(row.id)] !== false;
  });
  // BOTH LINKEDIN FLOWS CAN BE LIVE AT ONCE, and then each has to say which it
  // is. With `bridges` on and `connectors.linkedin` true the bridge logs in and
  // sources/linkedin.mjs still polls ~/.hazlie/imports/linkedin, so both are
  // real work — but they share the label the platform gave them. Rename only
  // when both survive: with bridges off there is one tile and "(export)" is
  // noise on it.
  const both = shown.some((row) => row.id === 'linkedin')
    && shown.some((row) => row.id === LINKEDIN_EXPORT_ID);
  if (!both) return shown;
  return shown.map((row) => {
    if (row.id === 'linkedin') return { ...row, label: `${row.label} (bridge)` };
    if (row.id === LINKEDIN_EXPORT_ID) return { ...row, label: `${row.label} (export)` };
    return row;
  });
}

/// 'ok' | 'missing' | 'invalid' — why the feature registry answered what it
/// answered. It rides the status payload because the shelf is the surface that
/// goes blank when the answer is one of the last two: every connector off, the
/// card's own included, drawn as the same empty list as "nothing connected".
/// The page needs to be able to say "unreadable" instead of saying nothing.
/// WITH `home`, because every other reader on this page has one. The override
/// lives at ~/.hazlie/features.json, so a read with no argument answers about
/// the DEVELOPER's machine on an alt-home install and in every temp-home test —
/// the same class of bug HAZLIE_FEATURES_OVERRIDE closes one layer down.
/// `overrideState` rides along because it is the part of this answer a home can
/// change: a broken registry is a broken bundle, the same file for every home.
export function featureRegistryStatus({ home = homedir() } = {}) {
  const { registryState, overrideState } = readFeatureRegistry({
    overridePath: defaultOverridePath(home),
  });
  return { registryState, overrideState };
}

export function featureRegistryState({ home = homedir() } = {}) {
  return featureRegistryStatus({ home }).registryState;
}

/// WHERE THE DAEMON STANDS, which is not always where this page stands.
///
/// connectors/daemon.mjs resolves the registry ONCE, at module scope; this file
/// re-reads it per request. Repair a broken ops/features.json under a running
/// daemon and the shelf's red line clears and the tiles come back, while the
/// daemon still holds ALL_OFF and schedules nothing until it is restarted — the
/// notice asserting a recovery that has not happened.
///
/// The daemon writes its own answer into the activity file it already
/// maintains, so this is one small local read and no new channel. `null` is
/// "it has not said" — an older daemon, a file not written yet, or a claim
/// nothing is standing behind any more — and must never paint an alarm:
/// absence of a claim is not a claim.
///
/// AND A FILE OUTLIVES THE PROCESS THAT WROTE IT. activity.json carries no
/// liveness stamp of its own, so a daemon that exited — a missing config is an
/// exit 1, and so is a crash or a kill — leaves its last registryState behind.
/// If that word was `missing` or `invalid`, the shelf then told the owner
/// FOREVER that "the connector service is still running on the old feature
/// registry — restart the app", about a process that is not running and that
/// restarting the app does not silence. The whole value of this field is that
/// it describes a RUNNING process, so it is only reported while there is one:
///
///   - the activity file's own mtime is recent — twice the SLOWEST configured
///     poll interval, which is the slowest cadence at which a working daemon
///     rewrites it; otherwise
///   - ~~the daemon holds daemon.lock with a live pid in it.~~ A LIVE PID IS
///     NOT A LIVE DAEMON. The lock outlives a hard kill (it is cleared only by
///     the CLI owner-PID watch or the next acquireDaemonLock), so once macOS
///     recycled that pid the check started asserting that a dead daemon was
///     running and the shelf revived exactly the stale alarm this field was
///     added to remove. daemonLockIsLive (connectors/lib/daemonLock.mjs) now
///     also requires the pid to have STARTED no later than the lock says it
///     did, and reads a foreign (EPERM) process as somebody else's: the daemon
///     runs as the owner. An idle daemon with every connector switched off is
///     still believed whatever the file's age, as long as it is the one that
///     wrote the lock.
///
/// Neither holds: `null`, and the shelf says nothing about the daemon. It is
/// deliberately not a fourth word — `connections.js` alarms on any
/// daemonRegistryState that is not 'ok', so a new one would trade a stale
/// alarm for a permanent one.
export const DEFAULT_INTERVAL_S = 900;

// THE CADENCE AT WHICH A WORKING DAEMON REWRITES THE FILE, WHICH THE OWNER
// CONFIGURES.
//
// ~~A hardcoded 2 x 900 s.~~ `intervals.<connector>` is a config key with a
// ceiling of 86,400 s (connectors/daemon.mjs validateConfig), so an owner who
// slows a connector past fifteen minutes moved the real republish cadence past
// this window and the daemon's registry state went quiet while the daemon was
// healthy.
//
// ~~The MAXIMUM over the configured intervals.~~ That read the file as though
// the slowest connector decided the cadence, and it is the fastest that does:
// every source's reschedule calls publishWaiting, so the file is rewritten
// whenever ANY source ticks (round-4 finding 13). `{"intervals":{"notion":
// 86400}}` therefore bought a 48-hour window on an install still republishing
// every fifteen minutes, and a daemon that died yesterday went on reporting its
// registry state as authoritative -- the stale-alarm class this window was
// widened to remove, arriving from the other side.
//
// So: the MINIMUM across the whole roster, with an unlisted connector counted
// at DEFAULT_INTERVAL_S because that is what it will actually run at. Doubled
// for the same reason the constant was -- one missed publish is not an outage
// -- and floored at the default, so an install with no `intervals` block, or
// one that only ever speeds a connector up, behaves exactly as before.
//
// The remaining looseness is named rather than hidden: a connector that is
// switched off does not tick, so an install that slows every connector it
// still runs and leaves a fast one disabled gets a window wider than its real
// cadence. The disabled set is not in this file, and erring wide here costs a
// late alarm while erring narrow costs a false one.
export function daemonActivityFreshMs({ home = homedir() } = {}) {
  let intervals = null;
  try {
    intervals = JSON.parse(
      readFileSync(join(home, '.hazlie', 'connectors', 'config.json'), 'utf8')
    )?.intervals;
  } catch {
    intervals = null;
  }
  const configured = intervals !== null && typeof intervals === 'object' && !Array.isArray(intervals)
    ? intervals
    : {};
  const cadence = Math.min(...CONNECTOR_NAMES.map((name) => {
    const seconds = configured[name];
    return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_INTERVAL_S;
  }));
  return 2 * Math.max(DEFAULT_INTERVAL_S, cadence) * 1000;
}

// The window an install with no interval overrides gets, which is what this
// constant always meant.
export const DAEMON_ACTIVITY_FRESH_MS = 2 * DEFAULT_INTERVAL_S * 1000;

export function daemonRegistryState({ home = homedir(), now = Date.now() } = {}) {
  const path = join(home, '.hazlie', 'connectors', 'activity.json');
  let state = null;
  let writtenAt = 0;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!REGISTRY_STATES.includes(raw?.registryState)) return null;
    state = raw.registryState;
    writtenAt = statSync(path).mtimeMs;
  } catch {
    return null; // no activity file is the normal case on a machine that never ran it
  }
  // Freshness first, because it is two file reads while the lock check now
  // asks the OS when that pid started. The union is unchanged — either kind of
  // evidence returns the state — so only the cost of the common case moves.
  if (now - writtenAt <= daemonActivityFreshMs({ home })) return state;
  return daemonLockIsLive({ home }) ? state : null;
}

/// The set itself, for the surfaces that draw what this build OFFERS rather
/// than only why it could not say.
export function featureSetFor({ home = homedir() } = {}) {
  return readFeatureRegistry({ overridePath: defaultOverridePath(home) }).features;
}

function fullStatus(home) {
  return [
    localStoreRow({
      id: 'imessage',
      label: 'iMessage', // owner (2026-08-25): the store's own name, not the app's
      path: join(home, 'Library', 'Messages', 'chat.db'),
      reads: 'reading your message history',
    }),
    localStoreRow({
      id: 'photos',
      label: 'Photos',
      path: join(home, 'Pictures', 'Photos Library.photoslibrary', 'database', 'Photos.sqlite'),
      reads: 'reading time, place and who is in them',
    }),
    localStoreRow({
      id: 'notes',
      label: 'Notes',
      path: join(home, 'Library', 'Group Containers', 'group.com.apple.notes', 'NoteStore.sqlite'),
      reads: 'reading what you wrote',
    }),
    contactsRow(home),
    filesRow(home),
    ...cloudAccountRows(home),
    notionRow(home),
    whatsappRow(home),
    linkedinExportRow(home),
    ...bridgeRows({ home }),
  ];
}

export function readStatus({ home = homedir() } = {}) {
  // Every source, always. This used to branch on a `role` naming which machine
  // this was in a two-machine split; that split and the roles are gone with it,
  // so there is one page and it shows everything this install can connect.
  //
  // The disable pass runs HERE rather than inside each row builder: it applies
  // to every source by the same rule, and one place to apply it is one place
  // for it to be forgotten from when a source is added.
  return fullStatus(home).map((row) => withDisabled(row, home));
}

// Which calendar backend is configured. The row has to follow it: checking
// the local store while the connector reads Google would report "connected"
// on the strength of a file the connector never opens — and on this seed the
// local store holds ZERO events for every Google calendar, so the page would
// have been confidently wrong in both directions at once.
function calendarBackend(home) {
  try {
    const raw = JSON.parse(readFileSync(join(home, '.hazlie', 'connectors', 'config.json'), 'utf8'));
    return raw?.calendar?.backend === 'google' ? 'google' : 'local';
  } catch {
    return 'local';
  }
}

function calendarRow(home) {
  if (calendarBackend(home) === 'google') {
    // The singleton gcal-tokens.json was retired when Google grants became
    // per-account. Use the same account store as the connector itself, and
    // require the Calendar scope rather than treating any Google token as one.
    // A REVOKED GRANT IS NOT "CONNECTED", AND IT IS NOT "NEVER SET UP" EITHER.
    //
    // accountsWithScope filters stale accounts out, so a calendar whose grant
    // had been revoked or expired fell into the same row as one that was never
    // authorized: "needs authorizing", no broken flag, and the tile read as an
    // ordinary un-set-up source. The mail rows already make this distinction
    // (accountsWithScopeIncludingStale, above); the calendar was left behind
    // when grants went per-account.
    const live = accountsWithScope(CALENDAR_SCOPE, { home });
    const anyGrant = accountsWithScopeIncludingStale(CALENDAR_SCOPE, { home });
    const ok = live.length > 0;
    const revoked = !ok && anyGrant.length > 0;
    return {
      id: 'calendar',
      label: 'Calendar',
      connected: ok,
      broken: revoked,
      detail: ok
        ? 'authorized · Google Calendar API'
        : revoked
          ? 'access was revoked or expired — sign in again'
          : 'needs authorizing',
      action: ok ? null : 'gcal',
      caveat: null,
    };
  }
  return localStoreRow({
    id: 'calendar',
    label: 'Apple Calendar', // owner (2026-08-25): names WHICH calendar this reads
    path: join(home, 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb'),
    reads: 'reading the local calendar store',
  });
}

function cloudAccountRows(home) {
  return [
    calendarRow(home),
    // ONE ROW PER AUTHORIZED GOOGLE ACCOUNT.
    //
    // ~~One row per mailbox in mail.accounts[], each wanting a 16-character
    // app password, plus an "add a mailbox" form that wrote that config.~~ All
    // of it went when the connector moved to OAuth (2026-08-26). An app
    // password is minted by hand and carries the whole account; a grant is
    // scoped and read-only. The consequence for this page is that there is no
    // address to type and no secret to paste: an AUTHORIZED account is a
    // configured one, so the rows are read from the grants on disk.
    //
    // That form was the right fix for the problem as it stood the same
    // morning — mail rows were generated from a config nothing could write, so
    // no install had any — and it is the wrong shape now. Deleted rather than
    // left beside the new path: two ways in, one of which silently no longer
    // reaches the connector, is worse than the bug it fixed.
    // BROKEN IS NOT THE SAME AS NEVER SET UP, and this row is the one place
    // that distinction has teeth: a grant dies silently — revoked, password
    // changed, or simply expired on an OAuth client still in Testing — and the
    // owner's experience is mail that stopped arriving with nothing to see.
    // `broken: true` is what pins the tile to the front of the shelf.
    ...googleMailAccounts({ home }).map((account) => (account.stale
      ? {
        id: `mail:${account.email}`,
        label: account.email,
        connected: false,
        broken: true,
        detail: 'sign in again — Google refused the saved grant',
        action: 'gcal',
        fix: 'Google will not renew this authorization. Sign in again from the Connections shelf; '
          + 'the usual causes are a revoked app, a password change, or an OAuth client left in Testing.',
        caveat: null,
      }
      : {
        id: `mail:${account.email}`,
        label: account.email,
        connected: true,
        detail: 'authorized · Gmail API, read-only',
        action: null,
        caveat: null,
      })),
    // The way to add one (or the first one). Optional, so a page with no
    // mailbox still reaches "all set" — reading mail is a choice, not an
    // outstanding task, and the counter is what tells the owner they are done.
    {
      id: 'mail',
      // "Google account", not "Another mailbox": one grant brings mail AND
      // calendar, so naming it after the mailbox undersells what the button
      // does and reads as a second, separate thing to connect.
      label: 'Google account',
      connected: false,
      optional: true,
      detail: googleMailAccounts({ home }).length === 0
        ? 'sign in to read your mail and calendar'
        : 'add another Google account',
      action: 'gcal',
      // WHICH CLIENTS THIS MAC CAN SIGN IN WITH. Carried on the row rather
      // than fetched separately, because the choice belongs to this button: an
      // Internal client reaches only its own Workspace but never expires, an
      // External one reaches any Google account and spends one of a finite,
      // unresettable 100. With a single client registered there is nothing to
      // ask, and the button stays a button.
      clients: googleClientChoices({ home }),
      caveat: null,
    },
    {
      id: 'granola',
      label: 'Granola',
      connected: ownerOnlyFileExists(join(SECRETS(home), 'granola-api-key.txt')),
      detail: ownerOnlyFileExists(join(SECRETS(home), 'granola-api-key.txt'))
        ? 'API key stored'
        : 'needs a Granola API key',
      action: ownerOnlyFileExists(join(SECRETS(home), 'granola-api-key.txt')) ? null : 'granola',
      caveat: null,
    },
    {
      id: 'oura',
      // Named "Health" in the UI because that is what the owner is connecting;
      // Oura replaced the Apple Health connector by owner decision 2026-08-19,
      // so the mockup's "needs the iPhone app" row no longer describes reality.
      label: 'Health',
      ...ouraState(home),
      action: ouraState(home).connected ? null : 'oura',
      caveat: null,
    },
  ];
}
