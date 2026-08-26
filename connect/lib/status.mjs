// What the connect page renders: one row per source, with the truth about
// whether it is actually usable right now.
//
// These checks deliberately mirror connectors/doctor.mjs rather than shelling
// out to it. Doctor is a diagnostic that must run under launchd to prove the
// Full Disk Access grant; the connect page is a UI that wants a cheap answer
// on every load. Where they can disagree is exactly the FDA rows — so those
// rows say so, instead of rendering a red X the owner cannot act on.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PLATFORMS, bridgeStatus } from './bridge.mjs';
import { GMAIL_SCOPE, accountsWithScope } from '../../connectors/lib/googleAccounts.mjs';

const SECRETS = (home) => join(home, '.hazlie', 'secrets');

// A source the owner turned off with `run.mjs <name> --disable`. The daemon
// checks this marker every tick (connectors/daemon.mjs), so a disabled source
// never runs — and a row that still reported "connected" because its store
// happens to be readable would be describing a poll that will not happen.
// Readable is not the same as running.
const disabledMarker = (home, id) =>
  existsSync(join(home, '.hazlie', 'connectors', `${id}.disabled`));

function withDisabled(row, home) {
  if (!disabledMarker(home, row.id)) return row;
  // WhatsApp is the one passive store a fresh app deliberately gates in the
  // product UI. Preserve the existing CLI-only semantics for every other
  // source: their markers may have been created by run.mjs --disable, and the
  // native enable action is intentionally not authorized to mutate them.
  if (row.id !== 'whatsapp') {
    return {
      ...row,
      connected: false,
      broken: false,
      detail: 'turned off',
      action: null,
      fix: `re-enable with: rm ~/.hazlie/connectors/${row.id}.disabled`,
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
export function googleMailAccounts({ home = homedir() } = {}) {
  try {
    return accountsWithScope(GMAIL_SCOPE, { home });
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
// touching Meta. Not yet linked → a row that opens Hazlie's own login panel
// (action 'bridge'), never a third-party client.
function bridgeRows({ home = homedir() } = {}) {
  return Object.values(PLATFORMS).map((p) => {
    const st = bridgeStatus(p.id, { home });
    return {
      id: p.id,
      label: p.label,
      connected: st.connected,
      detail: st.connected
        ? `linked${st.name ? ` as ${st.name}` : ''} · DMs syncing`
        : `link your ${p.label} DMs`,
      action: st.connected ? null : 'bridge',
      caveat: st.connected ? null : 'reads your own DMs through a local bridge on this Mac — the bridge stays signed in to the platform to do it.',
    };
  });
}

// ~~linkedinRow: connected meant Connections.csv was sitting in
// ~/.hazlie/imports/linkedin, from an export the owner had to request,
// wait hours for, download and unzip.~~ Yeeted (owner, 2026-08-25, asked
// twice): LinkedIn is a social platform like the other six and now rides the
// same bus — mautrix-linkedin in bridges/docker-compose.yml, listed by
// bridgeRows() below from the PLATFORMS table. Its rows keep the SAME
// `linkedin` source name the export wrote, so nothing downstream changed.

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
    const tokens = join(SECRETS(home), 'gcal-tokens.json');
    const ok = ownerOnlyFileExists(tokens);
    return {
      id: 'calendar',
      label: 'Calendar',
      connected: ok,
      detail: ok ? 'authorized · Google Calendar API' : 'needs authorizing',
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
    ...googleMailAccounts({ home }).map((account) => ({
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
      label: googleMailAccounts({ home }).length === 0 ? 'Gmail' : 'Another mailbox',
      connected: false,
      optional: true,
      detail: googleMailAccounts({ home }).length === 0
        ? 'sign in to Google to read your mail'
        : 'sign in with another Google account',
      action: 'gcal',
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
