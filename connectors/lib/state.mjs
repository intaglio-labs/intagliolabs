// The connectors' own local state: cursors (high-water marks per source),
// the contact identifier→person membership/name map, the quarantine list of iMessage rows the
// typedstream decoder could not handle, and the run log. NONE of this is
// corpus — corpus rows live in context.db behind hermes — but cursors and
// contact names are still household-private, so the file gets the same
// 0600-in-0700 discipline and the same "deleted means deleted" PRAGMAs as
// hermes' own store (ui/server/hermes.mjs hardenConnection).
//
// run_log.error holds sanitized error fingerprints from this package's own code. The log
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
  /* Opaque stable membership of one Address Book card. Every phone and email
     on that card shares this value, so identity resolution does not have to
     pretend that an exact display-name match is a person id. NULL for weaker
     sources such as an unnamed calendar attendee. */
  person_ref   TEXT,
  /* WHERE THE NAME CAME FROM, because more than one place knows names and they
     do not rank equally. 'contacts' is the address book -- a name the owner
     chose. 'calendar' is an event attendee: a real name, but one an invite
     supplied. Contacts wins on conflict; see upsertContacts. */
  source       TEXT NOT NULL DEFAULT 'contacts',
  updated_ts   INTEGER NOT NULL
);
/* Contact photos, so the People page can show a face instead of initials.
   Keyed by the SAME identifier as contact_ids, because that is what the
   people graph resolves a person to — the join is already there.
   The bytes are the Contacts framework's THUMBNAIL, not the original photo:
   a list draws them at 26px, and the full image is often megabytes.
   Separate table rather than a column on contact_ids: one contact has many
   identifiers and they would each carry a copy of the same blob, and every
   query that wants a NAME would drag the image along with it. */
CREATE TABLE IF NOT EXISTS contact_avatars(
  identifier TEXT PRIMARY KEY,
  jpeg       BLOB NOT NULL,
  updated_ts INTEGER NOT NULL
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
    if (!contactCols.has('person_ref')) {
      db.exec('ALTER TABLE contact_ids ADD COLUMN person_ref TEXT');
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
  const deleteCursorStmt = db.prepare('DELETE FROM cursor WHERE name = ?');
  // WHAT A PURGE HAS TO FORGET, WHICH IS MORE THAN ONE NAMESPACE.
  //
  // Observed on the live machine 2026-09-12: `node run.mjs mail --purge`
  // deleted 81,725 mail rows from hermes and left every
  // `yearly-backfill:connector:mail:done:<year>` behind, because those keys
  // live under the SCHEDULER's prefix rather than the connector's. The re-pull
  // then fetched a few days forward and one unfinished history year; 2024, 2025
  // and 2026 were still marked done and would never have been fetched again. A
  // cursor asserting "this year is finished" about a corpus that no longer
  // exists is the worst kind of survivor: it is silent, and it is believed.
  //
  // THE ONE KEY THAT STAYS is `<connector>:history-slices-per-pass` — a rolling
  // measurement of how many slices the last pass got through, which the
  // activity panel turns into an ETA. It describes the machine, not the rows,
  // so a purge has nothing to say about it.
  const deleteCursorsStmt = db.prepare(
    "DELETE FROM cursor WHERE (name = ? OR name LIKE ? ESCAPE '\\' "
      + "OR name = ? OR name LIKE ? ESCAPE '\\') AND name <> ?"
  );
  // Did this connector take part in the yearly walk at all? See deleteCursors.
  const countYearlyStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM cursor WHERE name = ? OR name LIKE ? ESCAPE '\\'"
  );
  // The product barriers for the year a reopened walk restarts at. See
  // deleteCursors: yearlyBackfill's own reopen() and classify() both call
  // reopenBarriers(currentYear), and this is the third door into the same
  // state, so it has to leave the same state behind.
  const deleteBarriersStmt = db.prepare(
    "DELETE FROM cursor WHERE name LIKE 'yearly-backfill:barrier:%:done:' || ?"
  );
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
    'INSERT INTO contact_ids(identifier, display_name, kind, person_ref, source, updated_ts) ' +
      'VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(identifier) DO UPDATE SET display_name = excluded.display_name, ' +
      'kind = excluded.kind, person_ref = CASE WHEN excluded.source = \'contacts\' ' +
      'THEN COALESCE(excluded.person_ref, contact_ids.person_ref) ELSE contact_ids.person_ref END, ' +
      'source = excluded.source, updated_ts = excluded.updated_ts ' +
      "WHERE excluded.source = 'contacts' OR contact_ids.source != 'contacts'"
  );
  const upsertAvatarStmt = db.prepare(
    'INSERT INTO contact_avatars(identifier, jpeg, updated_ts) VALUES(?, ?, ?) ' +
      'ON CONFLICT(identifier) DO UPDATE SET jpeg = excluded.jpeg, updated_ts = excluded.updated_ts'
  );
  const resolveStmt = db.prepare(
    'SELECT display_name, kind FROM contact_ids WHERE identifier = ?'
  );

  function validateContacts(contacts) {
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
      if (c.personRef !== undefined && (typeof c.personRef !== 'string' || c.personRef.length === 0 || c.personRef.length > 200)) {
        throw new Error(`contacts[${i}]: "personRef" must be a non-empty string of at most 200 characters`);
      }
      if (c.source !== undefined && !CONTACT_SOURCES.includes(c.source)) {
        throw new Error(`contacts[${i}]: "source" must be one of ${CONTACT_SOURCES.join(', ')}`);
      }
    }
    return list;
  }

  // Where the SHARED yearly walk stands — the three keys that are nobody's
  // connector namespace. Exposed on the handle below; see the comment there.
  function reopenYearlyWalk() {
    let changes = 0;
    // COMPLETE, because yearlyBackfill.task() short-circuits on it for EVERY
    // connector: left standing over a purged source's missing checkpoints it
    // means that source is never scheduled to walk its history again.
    //
    // THE YEAR, because with COMPLETE gone and the saved year still pointing at
    // 1997 the reopened walk resumes at 1997 and the recent years never come
    // back. An absent year reads as the current one, which is where a re-walk
    // has to start.
    for (const key of ['yearly-backfill:complete', 'yearly-backfill:year']) {
      changes += Number(deleteCursorStmt.run(key).changes);
    }
    // AND THE PRODUCT BARRIER FOR THE YEAR THE WALK NOW RESTARTS AT. A barrier
    // still marked done there claims the product phase for that year is
    // finished — over a corpus that has just changed under it — so advance()
    // would step straight past the year without rebuilding anything. This is
    // what yearlyBackfill's own reopen() and classify() do (reopenBarriers) when
    // they rewind the same walk from inside the daemon; three doors into one
    // piece of state have to leave the same state behind. Barrier names are not
    // known in this file, so the year is the key and the LIKE covers the roster.
    // Older years are finished work and are left alone.
    changes += Number(deleteBarriersStmt.run(String(new Date().getFullYear())).changes);
    return changes;
  }

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

    // A source can complete an old history walk, then discover a new stream
    // that needs walking too. Removing only this exact mark (rather than the
    // whole connector namespace) lets it resume history without losing its
    // forward cursor or any per-room progress.
    deleteCursor(name) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('cursor name must be a non-empty string');
      }
      return Number(deleteCursorStmt.run(name).changes);
    },

    // THE GLOBAL RESET, AS A CALL OF ITS OWN — the only thing in this file
    // that touches state no single connector owns.
    //
    // It used to be three statements inlined at the end of deleteCursors, which
    // made a per-connector verb do two jobs of very different blast radius and
    // return one number covering both. Split out, each half can be called and
    // counted on its own, and the name says what the blast radius is.
    //
    // WHAT IT DOES NOT TOUCH: any other connector's year receipts. Those stay,
    // deliberately — a walk reopened at the current year re-uses every year the
    // other sources already finished instead of re-fetching a decade. What it
    // clears is only the three pieces of state that describe WHERE THE SHARED
    // WALK IS, which a purge has just made untrue.
    reopenYearlyWalk,

    // Wipes every cursor a connector owns: the exact name plus the
    // `<name>:...` namespace. Used by run.mjs --purge so a purged source
    // re-ingests from scratch instead of resuming past its own absence.
    //
    // AND THE GLOBAL GATE, WHEN THIS CONNECTOR WAS PART OF WHAT CLOSED IT.
    //
    // `yearly-backfill:complete` is not somebody else's key. It is the barrier
    // that says every history-walking source has finished walking, and
    // yearlyBackfill.task() short-circuits on it for EVERY connector — so a
    // purge that removes one source's year checkpoints while leaving COMPLETE
    // set means the purged source is never scheduled to walk its history
    // again. The rows come back forward-only, and the years that were marked
    // done stay gone.
    //
    // It survived because classify() happens to delete COMPLETE when it sees a
    // connector with no current-year checkpoint — a branch written for a
    // connector that becomes available mid-run, which rescues this by
    // accident, and only while the connector is still available. Correctness
    // that depends on an unrelated branch is not correctness.
    //
    // GATED ON THIS CONNECTOR'S OWN EVIDENCE rather than on a walksHistory
    // flag the caller would have to supply: the purge path in run.mjs never
    // loads the source module. A connector that has yearly-backfill rows is by
    // definition one that took part in the walk, and one that has none
    // contributed nothing the barrier could have been counting — so the
    // globals are left exactly as they were.
    //
    // `reopenYearly: false` DECLINES the global half, for a caller that means
    // "this namespace and nothing else". The default stays ON: retain.mjs's
    // purge is the only production caller and is the path the whole branch
    // exists for, so flipping the default would silently restore the bug the
    // paragraphs above describe. A caller that wants the two halves separately
    // now calls deleteCursors(name, { reopenYearly: false }) and
    // reopenYearlyWalk(), each returning its own count.
    deleteCursors(connector, { reopenYearly = true } = {}) {
      if (typeof connector !== 'string' || connector.length === 0) {
        throw new Error('deleteCursors requires a connector name');
      }
      const escaped = connector.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
      const yearly = `yearly-backfill:connector:${connector}`;
      const walked = reopenYearly && Number(
        countYearlyStmt.get(yearly, `yearly-backfill:connector:${escaped}:%`)?.n ?? 0
      ) > 0;
      const changes = Number(
        deleteCursorsStmt.run(
          connector,
          `${escaped}:%`,
          yearly,
          `yearly-backfill:connector:${escaped}:%`,
          `${connector}:history-slices-per-pass`
        ).changes
      );
      return changes + (walked ? reopenYearlyWalk() : 0);
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
    // plus stable Address Book card membership, so iMessage, mail, and meeting
    // sources can aggregate all of one person's exact identifiers.
    // Names come from the AddressBook store (a human typed them), which is
    // the sanctioned side of the no-voiceprints line.
    /**
     * Contact photos, keyed by the same identifier as upsertContacts.
     *
     * Separate call rather than a field on a contact entry: most contacts have
     * no picture, the two arrive from different fields of the same fetch, and
     * a name write must never be blocked by an image write.
     */
    replaceAvatars(avatars, now = Date.now()) {
      const list = Array.isArray(avatars) ? avatars : [avatars];
      for (const [i, a] of list.entries()) {
        if (a === null || typeof a !== 'object') throw new Error(`avatars[${i}]: not an object`);
        if (typeof a.identifier !== 'string' || a.identifier.length === 0) {
          throw new Error(`avatars[${i}]: missing "identifier" string`);
        }
        if (!(a.jpeg instanceof Uint8Array) || a.jpeg.length === 0) {
          throw new Error(`avatars[${i}]: "jpeg" must be a non-empty Uint8Array`);
        }
      }
      db.exec('BEGIN');
      try {
        // A Contacts-framework fetch is a complete snapshot. Replace rather
        // than only upsert so deleting a contact or removing their photo also
        // removes the old bytes from local state.
        db.exec('DELETE FROM contact_avatars');
        for (const a of list) upsertAvatarStmt.run(a.identifier, a.jpeg, now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return list.length;
    },

    upsertContacts(contacts, now = Date.now()) {
      const list = validateContacts(contacts);
      db.exec('BEGIN');
      try {
        for (const c of list)
          upsertContactStmt.run(c.identifier, c.displayName, c.kind, c.personRef ?? null, c.source ?? 'contacts', now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return list.length;
    },

    // A full Contacts read is a snapshot, not an event stream. Replacing only
    // the address-book-owned rows makes removed emails stop resolving to their
    // former card. Calendar-owned fallback names are left intact. Callers must
    // use upsertContacts for limited-access or partial reads, where absence is
    // not evidence that the owner removed an identifier.
    replaceContacts(contacts, now = Date.now()) {
      const list = validateContacts(contacts);
      if (list.some((c) => c.source !== undefined && c.source !== 'contacts')) {
        throw new Error('replaceContacts accepts only address-book contacts');
      }
      db.exec('BEGIN');
      try {
        db.exec("DELETE FROM contact_ids WHERE source = 'contacts'");
        for (const c of list) {
          upsertContactStmt.run(c.identifier, c.displayName, c.kind, c.personRef ?? null, 'contacts', now);
        }
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
