// The contacts resolver: macOS Contacts → the name↔phone↔email spine.
//
// THIS CONNECTOR WRITES NO CORPUS. It maps to hermes source null in the
// daemon: its whole output is the `contact_ids` table in the local state.db,
// which query-time joins read so the same human stops surfacing three times —
// once as a phone number, once as an email local-part, once as a full name in
// a meeting. It is
// deliberately a resolution spine rather than a second corpus: rows are
// (identifier, displayName, kind∈{phone,email}, opaque personRef). personRef
// preserves the hard fact that several identifiers came from one Address Book
// card; all corpus aggregation still happens at query time.
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
import { createHash } from 'node:crypto';
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

// Opaque on purpose: a CNContact identifier or a fallback list of private
// identifiers should not become a readable graph key. The same card produces
// the same ref, and different cards with the same display name stay distinct.
function personRefFor({ contactId = null, displayName = '', identifiers = [] } = {}) {
  const explicit = typeof contactId === 'string' && contactId.trim() ? contactId.trim() : null;
  const seed = explicit
    ? `cn:${explicit}`
    : `fallback:${displayName}\u0000${[...identifiers].sort().join('\u0000')}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
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

  const byOwner = new Map();
  const add = (owner, identifier, kind) => {
    if (!identifier || !names.has(owner)) return;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push({ identifier, kind });
  };
  const phone = tableColumns(db, 'ZABCDPHONENUMBER');
  if (phone.has('ZOWNER') && phone.has('ZFULLNUMBER')) {
    for (const r of db.prepare('SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER').all()) {
      const owner = Number(r.ZOWNER);
      add(owner, normalizePhone(r.ZFULLNUMBER), 'phone');
    }
  }
  const email = tableColumns(db, 'ZABCDEMAILADDRESS');
  if (email.has('ZOWNER') && email.has('ZADDRESS')) {
    for (const r of db.prepare('SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS').all()) {
      const owner = Number(r.ZOWNER);
      add(owner, normalizeEmail(r.ZADDRESS), 'email');
    }
  }
  // THE REST OF THE CARD (ingestion round one, 2026-09-20): job title,
  // department, nickname from the record; relation labels from
  // ZABCDRELATEDNAME. Apple stores a stock label as `_$!<Mother>!$_` and a
  // custom one bare; both become one short lowercase word. Read only where the
  // column exists, so an older store shape reads as "no facts", not a failure.
  const factCols = ['ZJOBTITLE', 'ZDEPARTMENT', 'ZNICKNAME'].filter((c) => rec.has(c));
  const factRows = new Map();
  if (factCols.length > 0) {
    for (const r of db.prepare(`SELECT Z_PK, ${factCols.join(', ')} FROM ZABCDRECORD`).all()) {
      const owner = Number(r.Z_PK);
      if (!byOwner.has(owner)) continue;
      const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      factRows.set(owner, {
        jobTitle: rec.has('ZJOBTITLE') ? clean(r.ZJOBTITLE) : null,
        department: rec.has('ZDEPARTMENT') ? clean(r.ZDEPARTMENT) : null,
        nickname: rec.has('ZNICKNAME') ? clean(r.ZNICKNAME) : null,
        relationLabels: [],
      });
    }
  }
  const related = tableColumns(db, 'ZABCDRELATEDNAME');
  if (related.has('ZOWNER') && related.has('ZLABEL')) {
    for (const r of db.prepare('SELECT ZOWNER, ZLABEL FROM ZABCDRELATEDNAME').all()) {
      const owner = Number(r.ZOWNER);
      if (!byOwner.has(owner)) continue;
      const label = relationLabel(r.ZLABEL);
      if (!label) continue;
      if (!factRows.has(owner)) factRows.set(owner, { jobTitle: null, department: null, nickname: null, relationLabels: [] });
      factRows.get(owner).relationLabels.push(label);
    }
  }
  // GROUPS: ZABCDGROUP holds the names; the membership join table is
  // generated per schema version (Z_<n>PARENTGROUPS / Z_<n>CONTACTS), so it is
  // discovered by its column names rather than spelled. A store without one
  // reads as no groups.
  const groupsByOwner = readGroups(db);
  const facts = [];
  for (const [owner, identifiers] of byOwner) {
    const displayName = names.get(owner);
    const personRef = personRefFor({ displayName, identifiers: identifiers.map((item) => item.identifier) });
    for (const item of identifiers) entries.push({ ...item, displayName, personRef });
    const f = factRows.get(owner) ?? { jobTitle: null, department: null, nickname: null, relationLabels: [] };
    const groups = groupsByOwner.get(owner) ?? [];
    if (f.jobTitle || f.department || f.nickname || f.relationLabels.length || groups.length) facts.push({ personRef, ...f, groups });
  }
  return { entries, facts, reason: null };
}

export function readGroups(db) {
  const out = new Map();
  const group = tableColumns(db, 'ZABCDGROUP');
  if (!group.has('Z_PK') || !group.has('ZNAME')) return out;
  const names = new Map();
  for (const r of db.prepare('SELECT Z_PK, ZNAME FROM ZABCDGROUP').all()) {
    if (typeof r.ZNAME === 'string' && r.ZNAME.trim()) names.set(Number(r.Z_PK), r.ZNAME.trim().slice(0, 60));
  }
  if (names.size === 0) return out;
  let joinTable = null;
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'Z\\_%' ESCAPE '\\'").all()) {
    const cols = [...tableColumns(db, t.name)];
    const g = cols.find((c) => /GROUPS$/u.test(c));
    const c = cols.find((c2) => /CONTACTS$/u.test(c2));
    if (g && c) { joinTable = { name: t.name, g, c }; break; }
  }
  if (!joinTable) return out;
  for (const r of db.prepare(`SELECT ${joinTable.g} AS g, ${joinTable.c} AS c FROM "${joinTable.name}"`).all()) {
    const name = names.get(Number(r.g));
    if (!name) continue;
    const owner = Number(r.c);
    if (!out.has(owner)) out.set(owner, []);
    out.get(owner).push(name);
  }
  return out;
}

// `_$!<Mother>!$_` -> "mother"; a custom label stays as typed, lowercased and
// bounded. Anything that is not a short word of letters is dropped: a label is
// a category, and a sentence in the label field is not one.
export function relationLabel(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^_\$!<(.+)>!\$_$/u);
  const word = (m ? m[1] : raw).trim().toLowerCase();
  if (!word || word.length > 40 || !/^[\p{L}\p{M}' -]+$/u.test(word)) return null;
  return word;
}

// The Contacts-framework path's equivalent: the helper may hand back
// `jobTitle`, `department`, `nickname` and `relations` ([{label, name}]) per
// card; absent keys mean an older helper, and read as no facts.
export function factsFromContacts(contacts) {
  const facts = [];
  for (const c of Array.isArray(contacts) ? contacts : []) {
    const display = typeof c?.displayName === 'string' ? c.displayName.trim() : '';
    if (!display) continue;
    const identifiers = [
      ...(Array.isArray(c.phones) ? c.phones : []).map(normalizePhone),
      ...(Array.isArray(c.emails) ? c.emails : []).map(normalizeEmail),
    ].filter(Boolean);
    const personRef = personRefFor({ contactId: c?.contactId, displayName: display, identifiers });
    const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const relationLabels = (Array.isArray(c.relations) ? c.relations : []).map((r) => relationLabel(r?.label)).filter(Boolean);
    const groups = (Array.isArray(c.groups) ? c.groups : []).filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim().slice(0, 60));
    const f = { personRef, jobTitle: clean(c.jobTitle), department: clean(c.department), nickname: clean(c.nickname), relationLabels, groups };
    if (f.jobTitle || f.department || f.nickname || relationLabels.length || groups.length) facts.push(f);
  }
  return facts;
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
    const identifiers = [];
    for (const raw of Array.isArray(c.phones) ? c.phones : []) {
      const identifier = normalizePhone(raw);
      if (identifier) identifiers.push({ identifier, kind: 'phone' });
    }
    for (const raw of Array.isArray(c.emails) ? c.emails : []) {
      const identifier = normalizeEmail(raw);
      if (identifier) identifiers.push({ identifier, kind: 'email' });
    }
    const unique = [...new Map(identifiers.map((item) => [`${item.kind}:${item.identifier}`, item])).values()];
    const personRef = personRefFor({
      contactId: c?.contactId,
      displayName: display,
      identifiers: unique.map((item) => item.identifier),
    });
    for (const item of unique) entries.push({ ...item, displayName: display, personRef });
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
          const raw = await readContacts();
          // LIMITED ACCESS IS NOT FULL ACCESS, and the OS reports both as
          // granted. The helper appends a marker saying which; without it a
          // half-visible address book is indistinguishable from a complete one,
          // and the only symptom is a phone number where a name should be for
          // somebody the owner knows they have saved.
          let access = 'full';
          const cards = [];
          for (const c of Array.isArray(raw) ? raw : []) {
            if (c && typeof c.__access === 'string') access = c.__access;
            else cards.push(c);
          }
          const entries = entriesFromContacts(cards);
          // Only full access makes absence meaningful. With limited access the
          // OS hides cards, so replacing would turn an incomplete view into
          // destructive identity churn.
          if (access === 'full') ctx.state.replaceContacts(entries);
          else if (entries.length > 0) ctx.state.upsertContacts(entries);
          // The rest of the card, only when the read was complete: a partial
          // view cannot prove a label was removed. Never costs the run its names.
          if (access === 'full' && typeof ctx.state.replaceContactFacts === 'function') {
            try { ctx.state.replaceContactFacts(factsFromContacts(cards)); } catch (e) {
              ctx.log.warn('contacts_facts_failed', { connector: 'contacts', code: String(e?.code ?? e?.name ?? '') });
            }
          }
          // Photos are a nice-to-have on top of the spine: a failure here must
          // never cost the run its names, which are the thing the graph cannot
          // work without.
          let avatars = 0;
          try {
            const rows = avatarsFromContacts(cards);
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
            access,
          });
          if (access === 'limited') {
            ctx.log.warn('contacts_access_limited', {
              connector: 'contacts',
              identifiers: entries.length,
              fix: 'System Settings → Privacy & Security → Contacts → Intaglio Labs → allow full access',
            });
          }
          return { inserted: entries.length, updated: 0, unchanged: 0, skipped: 0, access };
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
      const factsByRef = new Map();
      let storesRead = 0;
      const attempts = [];
      const cacheDir = join(ctx.cacheDir, 'contacts');
      for (const src of stores) {
        let snapshotPath = null;
        let db = null;
        try {
          snapshotPath = await snapshotStore(src, cacheDir);
          db = new DatabaseSync(snapshotPath, { readOnly: true });
          // A STORE THAT DID NOT YIELD A USABLE READ IS NOT A STORE THAT WAS
          // READ. Counting it made a PARTIAL failure look total-success: the
          // 403 below only fires when EVERY store failed, and the cursor at the
          // end advanced past the one that broke -- after which the mtime
          // short-circuit skipped the whole connector on every later run. One
          // silent failure masked itself permanently.
          const { entries, facts = [], reason } = readStore(db);
          for (const f of facts) factsByRef.set(f.personRef, f);
          if (reason) {
            attempts.push(`${src} (${reason})`);
            ctx.log.info('contacts_store_skipped', { connector: 'contacts', code: reason });
          } else {
            storesRead += 1;
          }
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
      // All stores read means this is a complete snapshot. A partial pass can
      // safely improve known rows but cannot prove a missing identifier was
      // removed from Contacts.
      if (stores.length > 0 && storesRead === stores.length) ctx.state.replaceContacts(entries);
      else if (entries.length > 0) ctx.state.upsertContacts(entries);
      // The rest of the card rides the same completeness rule as the names.
      if (stores.length > 0 && storesRead === stores.length && typeof ctx.state.replaceContactFacts === 'function') {
        try { ctx.state.replaceContactFacts([...factsByRef.values()]); } catch (e) {
          ctx.log.warn('contacts_facts_failed', { connector: 'contacts', code: String(e?.code ?? e?.name ?? '') });
        }
      }
      ctx.log.info('contacts_scan', {
        connector: 'contacts',
        stores: stores.length,
        storesRead,
        identifiers: entries.length,
      });
      // ONLY WHEN EVERY STORE WAS READ. newestMtime is the max over stores that
      // merely STATTED, including any whose read failed, so advancing on a
      // partial pass writes a watermark covering data nobody looked at.
      //
      // Deliberate trade: a permanently unreadable store (a stale Sources/<uuid>
      // with a corrupt database) now means the cursor never advances and the
      // full read repeats each pass. That is the cheap direction to be wrong in
      // -- contacts is a small, whole-file read, and repeating it costs seconds
      // where skipping it costs an address book.
      if (stores.length > 0 && storesRead === stores.length) {
        ctx.state.setCursor(CURSOR_KEY, String(newestMtime));
      }
      // The daemon's run_log wants ingest-shaped counts; identifiers landed in
      // state.db, not hermes, and `ingested` reports them so the run is
      // visible in the log rather than reading as a permanent no-op.
      return { inserted: entries.length, updated: 0, unchanged: 0, skipped: 0 };
    },
  };
}

export default createContactsSource();
