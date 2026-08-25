// The connectors' own local state: cursors (high-water marks per source),
// the contact identifier→name map, the quarantine list of iMessage rows the
// typedstream decoder could not handle, and the run log. NONE of this is
// corpus — corpus rows live in context.db behind hermes — but cursors and
// contact names are still household-private, so the file gets the same
// 0600-in-0700 discipline and the same "deleted means deleted" PRAGMAs as
// hermes' own store (ui/server/hermes.mjs hardenConnection).
//
// run_log.error holds error MESSAGES from this package's own code. The log
// policy (connectors/AGENTS.md) binds here too: an error string must never
// embed row text, message bodies, or subjects — name the failure and the
// counts, not the content.
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Sources disagree on the name of the insert count, and run_log has one
// column for it. calendar, granola and oura translate their totals to
// `ingested`; files, imessage, mail, notes, notion and photos return
// `inserted` straight out of their own ingestAll. Every caller that read
// only `ingested` therefore recorded a flat 0 for those six: the first live
// `files` run put 2,000 rows into hermes and logged `ingested: 0`, and the
// photos backfill has been invisible in run_log for its whole life. Both
// recorders — the daemon and run.mjs — go through here so the two cannot
// drift again, and a new source may pick either name.
export function runCounts(counts = {}) {
  return {
    ingested: counts.ingested ?? counts.inserted ?? 0,
    updated: counts.updated ?? 0,
    unchanged: counts.unchanged ?? 0,
    deleted: counts.deleted ?? 0,
  };
}

export function defaultStateDbPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'state.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor(
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_ids(
  identifier   TEXT PRIMARY KEY,  /* E.164 phone or lowercased email */
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL,     /* 'phone' | 'email' */
  /* WHERE THE NAME CAME FROM, because more than one place knows names and they
     do not rank equally. 'contacts' is the address book -- a name the owner
     chose. 'calendar' is an event attendee: a real name, but one an invite
     supplied. Contacts wins on conflict; see upsertContacts. */
  source       TEXT NOT NULL DEFAULT 'contacts',
  updated_ts   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS imessage_undecoded(
  guid          TEXT PRIMARY KEY,
  rowid         INTEGER NOT NULL,
  first_seen_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_log(
  id          INTEGER PRIMARY KEY,
  connector   TEXT NOT NULL,
  started_ts  INTEGER NOT NULL,
  finished_ts INTEGER NOT NULL,
  ok          INTEGER NOT NULL,   /* 0 | 1 */
  ingested    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  unchanged   INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  error       TEXT                /* message only — never content */
);
`;

// Same three PRAGMAs hermes applies, for the same reason: contact names and
// deleted cursors should not survive legibly in the free list or a -wal
// sidecar whose mode nothing asserts.
function hardenConnection(db) {
  db.exec('PRAGMA secure_delete = ON');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA journal_mode = DELETE');
}

const CONTACT_KINDS = Object.freeze(['phone', 'email']);
// Named rather than open, so a third source has to decide where it ranks
// instead of silently outranking the address book by running last.
const CONTACT_SOURCES = Object.freeze(['contacts', 'calendar']);

export function openStateDb(path = defaultStateDbPath()) {
  // umask is process-global but everything here is synchronous; restore in
  // finally so a failure does not leave the process minting group-readable
  // files for whoever runs next.
  const previousUmask = process.umask(0o077);
  let db;
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dirMode = statSync(dir).mode & 0o777;
    if (dirMode !== 0o700) {
      // Fail closed rather than chmod: a caller pointing this at /tmp must be
      // told, not have /tmp silently made private for the process.
      throw new Error(
        `connectors state directory must have mode 0700: ${dir} is ${dirMode.toString(8)}`
      );
    }
    if (existsSync(path)) {
      if (!statSync(path).isFile()) {
        throw new Error(`connectors state path is not a regular file: ${path}`);
      }
      chmodSync(path, 0o600);
    }
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    hardenConnection(db);
    db.exec(SCHEMA);
    // contact_ids.source, for a state.db created before names had a ranking.
    // CREATE TABLE IF NOT EXISTS cannot add a column, so an existing install
    // would keep the old three-column table and every insert naming a source
    // would fail. Everything already there came from the address book, which is
    // exactly what the default says.
    const contactCols = new Set(
      db.prepare("SELECT name FROM pragma_table_info('contact_ids')").all().map((c) => c.name)
    );
    if (!contactCols.has('source')) {
      db.exec("ALTER TABLE contact_ids ADD COLUMN source TEXT NOT NULL DEFAULT 'contacts'");
    }
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      db?.close();
    } catch {}
    throw error;
  } finally {
    process.umask(previousUmask);
  }

  const getCursorStmt = db.prepare('SELECT value FROM cursor WHERE name = ?');
  const setCursorStmt = db.prepare(
    'INSERT INTO cursor(name, value, updated_ts) VALUES (?, ?, ?) ' +
      'ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts'
  );
  const deleteCursorsStmt = db.prepare("DELETE FROM cursor WHERE name = ? OR name LIKE ? ESCAPE '\\'");
  const recordRunStmt = db.prepare(
    'INSERT INTO run_log(connector, started_ts, finished_ts, ok, ingested, updated, unchanged, deleted, error) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  // PRECEDENCE IN THE SQL, not in the caller.
  //
  // Two sources now write names and they do not rank equally: the address book
  // is a name the owner chose, an invite attendee is a name somebody else
  // typed. Without the guard the last connector to run would win, so whether
  // a person had their real name depended on connector order -- which is not a
  // thing anyone should have to know.
  //
  // A 'contacts' write always lands. A 'calendar' write lands only where no
  // contacts row already holds that identifier.
  const upsertContactStmt = db.prepare(
    'INSERT INTO contact_ids(identifier, display_name, kind, source, updated_ts) ' +
      'VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(identifier) DO UPDATE SET display_name = excluded.display_name, ' +
      'kind = excluded.kind, source = excluded.source, updated_ts = excluded.updated_ts ' +
      "WHERE excluded.source = 'contacts' OR contact_ids.source != 'contacts'"
  );
  const resolveStmt = db.prepare(
    'SELECT display_name, kind FROM contact_ids WHERE identifier = ?'
  );

  return {
    db,

    getCursor(name) {
      const row = getCursorStmt.get(name);
      return row === undefined ? null : row.value;
    },

    // Values are stored as strings on purpose: cursors are opaque marks
    // (a ROWID, a UIDVALIDITY:UID pair, an ISO timestamp) and pretending to
    // know their type invites a lossy round-trip on the 2^53 boundary.
    setCursor(name, value, now = Date.now()) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('cursor name must be a non-empty string');
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('cursor value must be a non-empty string; serialize before storing');
      }
      setCursorStmt.run(name, value, now);
    },

    // Wipes every cursor a connector owns: the exact name plus the
    // `<name>:...` namespace. Used by run.mjs --purge so a purged source
    // re-ingests from scratch instead of resuming past its own absence.
    deleteCursors(connector) {
      if (typeof connector !== 'string' || connector.length === 0) {
        throw new Error('deleteCursors requires a connector name');
      }
      const escaped = connector.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
      return Number(deleteCursorsStmt.run(connector, `${escaped}:%`).changes);
    },

    recordRun({
      connector,
      startedTs,
      finishedTs,
      ok,
      ingested = 0,
      updated = 0,
      unchanged = 0,
      deleted = 0,
      error = null,
    }) {
      if (typeof connector !== 'string' || connector.length === 0) {
        throw new Error('recordRun requires a connector name');
      }
      for (const [label, v] of [
        ['startedTs', startedTs],
        ['finishedTs', finishedTs],
      ]) {
        if (!Number.isFinite(v)) throw new Error(`recordRun "${label}" must be epoch ms`);
      }
      recordRunStmt.run(
        connector,
        Math.trunc(startedTs),
        Math.trunc(finishedTs),
        ok ? 1 : 0,
        ingested,
        updated,
        unchanged,
        deleted,
        error === null ? null : String(error)
      );
    },

    // Contacts are RESOLUTION STATE, never corpus: identifier → display name
    // so the iMessage and mail sources can label rows with a human name.
    // Names come from the AddressBook store (a human typed them), which is
    // the sanctioned side of the no-voiceprints line.
    upsertContacts(contacts, now = Date.now()) {
      const list = Array.isArray(contacts) ? contacts : [contacts];
      for (const [i, c] of list.entries()) {
        if (c === null || typeof c !== 'object') throw new Error(`contacts[${i}]: not an object`);
        if (typeof c.identifier !== 'string' || c.identifier.length === 0) {
          throw new Error(`contacts[${i}]: missing "identifier" string`);
        }
        if (typeof c.displayName !== 'string' || c.displayName.length === 0) {
          throw new Error(`contacts[${i}]: missing "displayName" string`);
        }
        if (!CONTACT_KINDS.includes(c.kind)) {
          throw new Error(`contacts[${i}]: "kind" must be one of ${CONTACT_KINDS.join(', ')}`);
        }
        if (c.source !== undefined && !CONTACT_SOURCES.includes(c.source)) {
          throw new Error(`contacts[${i}]: "source" must be one of ${CONTACT_SOURCES.join(', ')}`);
        }
      }
      db.exec('BEGIN');
      try {
        for (const c of list)
          upsertContactStmt.run(c.identifier, c.displayName, c.kind, c.source ?? 'contacts', now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return list.length;
    },

    resolveIdentifier(identifier) {
      const row = resolveStmt.get(identifier);
      return row === undefined ? null : { displayName: row.display_name, kind: row.kind };
    },

    close() {
      db.close();
    },
  };
}
