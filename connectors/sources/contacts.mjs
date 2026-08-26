// The contacts resolver: macOS Contacts → the name↔phone↔email spine.
//
// THIS CONNECTOR WRITES NO CORPUS. It maps to hermes source null in the
// daemon: its whole output is the `contact_ids` table in the local state.db,
// which query-time joins read so the same human stops surfacing three times —
// once as a phone number, once as an email local-part, once as a full name in
// a meeting. It is
// deliberately a lookup table and not a person schema: rows are
// (identifier, displayName, kind∈{phone,email}), resolution happens at query
// time, and the spine must never become the project.
//
// FULL DISK ACCESS: the AddressBook stores are TCC territory, so this runs
// under launchd with the stable binary, same as iMessage. Layout confirmed by
// ops/probes/probe-calendar-contacts.mjs on this seed: a top-level
// AddressBook-v22.abcddb plus Sources/<account>/AddressBook-v22.abcddb.
// Schema is Apple-private, so every table/column is probed before it is read
// and a missing one degrades to a logged count, never a crash.
//
// LOG POLICY: counts only. A name next to a phone number is exactly the kind
// of line that must never reach a log file.

import { readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readContacts, helperAvailable } from '../lib/apple-data.mjs';
import { snapshotStore } from '../lib/storeReader.mjs';

const CURSOR_KEY = 'contacts:max-mtime';

export function addressBookStores(home = homedir()) {
  const base = join(home, 'Library', 'Application Support', 'AddressBook');
  const stores = [join(base, 'AddressBook-v22.abcddb')];
  try {
    for (const entry of readdirSync(join(base, 'Sources'))) {
      stores.push(join(base, 'Sources', entry, 'AddressBook-v22.abcddb'));
    }
  } catch {
    // ENOENT (no synced accounts) is fine; a TCC denial surfaces on open.
  }
  return stores;
}

// E.164-ish normalization so the spine's phone identifiers collide with
// iMessage handles ("+15555550123"). Ten digits get a US country code — this
// corpus's handles are US-formatted — and anything shorter than 7 digits is
// noise (extensions, short codes), not a person.
export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/gu, '');
  if (digits.length < 7) return null;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function normalizeEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return s.includes('@') ? s : null;
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  } catch {
    return new Set();
  }
}

// Read one snapshot store. Pure given a db handle; exported for the test,
// which runs it against a synthetic store with the same table shapes.
export function readStore(db) {
  const entries = [];
  const rec = tableColumns(db, 'ZABCDRECORD');
  if (!rec.has('Z_PK')) return { entries, reason: 'no ZABCDRECORD' };
  const nameBits = ['ZFIRSTNAME', 'ZLASTNAME'].filter((c) => rec.has(c));
  const orgCol = rec.has('ZORGANIZATION') ? 'ZORGANIZATION' : null;
  const names = new Map();
  const sel = [...nameBits, ...(orgCol ? [orgCol] : [])];
  for (const r of db.prepare(`SELECT Z_PK, ${sel.join(', ')} FROM ZABCDRECORD`).all()) {
    const person = nameBits.map((c) => r[c]).filter((v) => typeof v === 'string' && v.trim()).join(' ').trim();
    const org = orgCol && typeof r[orgCol] === 'string' ? r[orgCol].trim() : '';
    const display = person || org;
    if (display) names.set(Number(r.Z_PK), display);
  }

  const phone = tableColumns(db, 'ZABCDPHONENUMBER');
  if (phone.has('ZOWNER') && phone.has('ZFULLNUMBER')) {
    for (const r of db.prepare('SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER').all()) {
      const display = names.get(Number(r.ZOWNER));
      const id = normalizePhone(r.ZFULLNUMBER);
      if (display && id) entries.push({ identifier: id, displayName: display, kind: 'phone' });
    }
  }
  const email = tableColumns(db, 'ZABCDEMAILADDRESS');
  if (email.has('ZOWNER') && email.has('ZADDRESS')) {
    for (const r of db.prepare('SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS').all()) {
      const display = names.get(Number(r.ZOWNER));
      const id = normalizeEmail(r.ZADDRESS);
      if (display && id) entries.push({ identifier: id, displayName: display, kind: 'email' });
    }
  }
  return { entries, reason: null };
}

// The Contacts-framework shape -> the same spine entries readStore() produces.
//
// The helper hands back RAW numbers and addresses and does no normalising, so
// this runs them through the very same normalizePhone/normalizeEmail the sqlite
// path uses. That is the whole reason the split is drawn there: an identifier
// normalised two different ways is two different people to the resolver, and a
// backend switch would silently orphan every identifier already in the spine.
/**
 * The same contacts, as avatar rows — one per identifier that has a photo.
 *
 * Keyed per IDENTIFIER rather than per contact, deliberately: the people graph
 * resolves a person to identifiers, so this is the join that already exists.
 * A contact with three numbers and a photo stores three small rows; a contact
 * with no photo stores none, which is most of them.
 */
export function avatarsFromContacts(contacts) {
  const out = [];
  for (const c of Array.isArray(contacts) ? contacts : []) {
    const b64 = typeof c?.thumbnail === 'string' ? c.thumbnail : '';
    if (!b64) continue;
    let jpeg;
    try {
      jpeg = Buffer.from(b64, 'base64');
    } catch {
      continue; // a thumbnail that will not decode is not worth a failed run
    }
    if (jpeg.length === 0) continue;
    for (const raw of Array.isArray(c.phones) ? c.phones : []) {
      const identifier = normalizePhone(raw);
      if (identifier) out.push({ identifier, jpeg });
    }
    for (const raw of Array.isArray(c.emails) ? c.emails : []) {
      const identifier = normalizeEmail(raw);
      if (identifier) out.push({ identifier, jpeg });
    }
  }
  return out;
}

export function entriesFromContacts(contacts) {
  const entries = [];
  for (const c of Array.isArray(contacts) ? contacts : []) {
    const display = typeof c?.displayName === 'string' ? c.displayName.trim() : '';
    if (!display) continue;
    for (const raw of Array.isArray(c.phones) ? c.phones : []) {
      const identifier = normalizePhone(raw);
      if (identifier) entries.push({ identifier, displayName: display, kind: 'phone' });
    }
    for (const raw of Array.isArray(c.emails) ? c.emails : []) {
      const identifier = normalizeEmail(raw);
      if (identifier) entries.push({ identifier, displayName: display, kind: 'email' });
    }
  }
  return entries;
}

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createContactsSource({ home } = {}) {
  return {
    name: 'contacts',

    // Readability is deliberately not pre-checked — FDA attributes per
    // spawner, and the snapshot attempt is the honest probe (iMessage's rule).
    needs() {
      return [];
    },

    async run(ctx) {
      // PREFERRED PATH: the Contacts framework, through the helper binary.
      //
      // The sqlite path below reads AddressBook-v22.abcddb directly, which is
      // Full Disk Access -- every file the owner has, in order to read their
      // address book. The Contacts framework has its own TCC permission scoped
      // to exactly this, and the app already asks for it by name.
      //
      // No mtime cursor here: there is no store file to stat, and a full read is
      // cheap because the framework returns the address book rather than a
      // decade of rows. `contacts.backend: 'local'` forces the sqlite path, and
      // a missing helper falls through to it too.
      if (ctx.config?.contacts?.backend !== 'local' && helperAvailable()) {
        try {
          const contacts = await readContacts();
          const entries = entriesFromContacts(contacts);
          if (entries.length > 0) ctx.state.upsertContacts(entries);
          // Photos are a nice-to-have on top of the spine: a failure here must
          // never cost the run its names, which are the thing the graph cannot
          // work without.
          let avatars = 0;
          try {
            const rows = avatarsFromContacts(contacts);
            avatars = ctx.state.replaceAvatars(rows);
          } catch (e) {
            ctx.log.warn('contacts_avatars_failed', {
              connector: 'contacts',
              code: String(e?.code ?? ''),
            });
          }
          ctx.log.info('contacts_scan', {
            connector: 'contacts',
            backend: 'contacts-framework',
            identifiers: entries.length,
            avatars,
          });
          return { inserted: entries.length, updated: 0, unchanged: 0, skipped: 0 };
        } catch (error) {
          // A DENIAL is not a reason to read the same data the wide way. Falling
          // back to the sqlite store on `denied` would mean the owner refusing
          // Contacts and the app going after the file instead, which is the
          // opposite of what refusing meant. Anything else -- a helper that
          // crashed, timed out, or is not runnable here -- is a mechanical
          // failure with no such implication, so that does fall through.
          if (error?.denied) {
            ctx.log.warn('contacts_not_permitted', {
              connector: 'contacts',
              fix: 'allow Contacts for Intaglio Labs in System Settings → Privacy & Security → Contacts',
            });
            return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
          }
          ctx.log.warn('contacts_helper_failed', {
            connector: 'contacts',
            code: String(error?.code ?? ''),
          });
        }
      }

      const resolvedHome = home ?? ctx.home ?? homedir();
      const stores = addressBookStores(resolvedHome).filter((p) => {
        try {
          statSync(p);
          return true;
        } catch {
          return false;
        }
      });

      const newestMtime = stores.length
        ? Math.max(...stores.map((p) => statSync(p).mtimeMs))
        : 0;
      const stored = Number(ctx.state.getCursor(CURSOR_KEY) ?? 0);
      if (!ctx.backfill && stores.length > 0 && newestMtime <= stored) {
        ctx.log.info('contacts_scan', { connector: 'contacts', stores: stores.length, unchangedSinceMtime: true });
        return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      }

      const byIdentifier = new Map();
      let storesRead = 0;
      const attempts = [];
      const cacheDir = join(ctx.cacheDir, 'contacts');
      for (const src of stores) {
        let snapshotPath = null;
        let db = null;
        try {
          snapshotPath = await snapshotStore(src, cacheDir);
          db = new DatabaseSync(snapshotPath, { readOnly: true });
          const { entries } = readStore(db);
          storesRead += 1;
          // Later stores win on collision — Sources/* are the synced accounts
          // and are fresher than the legacy top-level store.
          for (const e of entries) byIdentifier.set(`${e.kind}:${e.identifier}`, e);
        } catch (error) {
          attempts.push(`${src} (${error?.message ?? error})`);
          ctx.log.info('contacts_store_skipped', { connector: 'contacts', code: error?.code ?? '' });
        } finally {
          try {
            db?.close();
          } catch {}
          if (snapshotPath) rmSync(snapshotPath, { force: true });
        }
      }

      // Every candidate passed the stat filter above (it exists) but not one
      // could actually be opened. Unlike a single bad store among several —
      // a genuine schema surprise, degraded per readStore()'s contract — this
      // is the FDA signature: every store denied is calendar.mjs's identical
      // all-candidates-failed case, and must fail loudly the same way rather
      // than read as a quiet "0 contacts".
      if (stores.length > 0 && storesRead === 0) {
        throw statusError(
          403,
          `contacts store is not readable at any candidate path: ${attempts.join('; ')}. ` +
            'If the store exists, this is Full Disk Access attribution: the read only works when ' +
            'launchd spawns the granted binary ~/.hazlie/bin/node directly — see the FDA runbook ' +
            'in ops/CONNECTORS.md.'
        );
      }

      const entries = [...byIdentifier.values()];
      if (entries.length > 0) ctx.state.upsertContacts(entries);
      ctx.log.info('contacts_scan', {
        connector: 'contacts',
        stores: stores.length,
        storesRead,
        identifiers: entries.length,
      });
      if (stores.length > 0) ctx.state.setCursor(CURSOR_KEY, String(newestMtime));
      // The daemon's run_log wants ingest-shaped counts; identifiers landed in
      // state.db, not hermes, and `ingested` reports them so the run is
      // visible in the log rather than reading as a permanent no-op.
      return { inserted: entries.length, updated: 0, unchanged: 0, skipped: 0 };
    },
  };
}

export default createContactsSource();
