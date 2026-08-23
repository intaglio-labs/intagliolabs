// The contacts resolver: macOS Contacts → the name↔phone↔email spine.
//
// THIS CONNECTOR WRITES NO CORPUS. It maps to hermes source null in the
// daemon: its whole output is the `contact_ids` table in the local state.db,
// which query-time joins read so the same human stops surfacing three times —
// once as +1808…, once as ay@…, once as "Austin Yoshino" in a meeting. It is
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

export function createContactsSource({ home } = {}) {
  return {
    name: 'contacts',

    // Readability is deliberately not pre-checked — FDA attributes per
    // spawner, and the snapshot attempt is the honest probe (iMessage's rule).
    needs() {
      return [];
    },

    async run(ctx) {
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
          ctx.log.info('contacts_store_skipped', { connector: 'contacts', code: error?.code ?? '' });
        } finally {
          try {
            db?.close();
          } catch {}
          if (snapshotPath) rmSync(snapshotPath, { force: true });
        }
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
