// The Notes connector: Apple Notes → hermes.
//
// The highest-signal text source in this system, because notes are things the
// owner WROTE. Messages are half other people; photo metadata is machine
// output; a note is intent.
//
// FULL DISK ACCESS: NoteStore.sqlite is TCC territory like every other Apple
// store, so this only works spawned by launchd from ~/.hazlie/bin/node.
//
// SNAPSHOT, unlike photos. The store is 22 MB here against Photos' 3.2 GB, so
// a copy costs milliseconds and buys a frozen, private view — the read-mode
// decision in ops/PROBES.md applied to a small store rather than a large one.
//
// TWO WAYS A NOTE IS DELETED, and only checking one lets the other through.
// ZMARKEDFORDELETION is the sync flag; a note dragged to the bin instead sits
// in a folder whose ZFOLDERTYPE is 1 ("Recently Deleted") with that flag
// unset. The first run ingested one such note — caught because the folder
// name came through in meta, which is a good argument for carrying it.
//
// PASSWORD-PROTECTED NOTES ARE NOT READ. Their bodies are encrypted with a key
// derived from a passphrase this system does not have, and the count is
// reported so "18 notes missing" is visible rather than looking like a gap in
// the scan. Notes in the trash are not read either — the owner deleted them.
//
// LOG POLICY: counts only. Never a title, never a body, never a folder name.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotStore } from '../lib/storeReader.mjs';
import { noteToRow } from '../lib/noteRows.mjs';

const CURSOR_KEY = 'notes:max-modified';
const MAX_NOTES_PER_SCAN = 500;
const APPLE_EPOCH_MS = 978307200000;

export function storePath(home) {
  return join(home, 'Library', 'Group Containers', 'group.com.apple.notes', 'NoteStore.sqlite');
}

// Core Data seconds since 2001, like Photos and unlike chat.db's nanoseconds.
// Keyed on MODIFICATION rather than creation: an edited note is new
// information, and a creation cursor would never see the edit.
export function scanFloorSeconds({ storedCursor, backfill }) {
  if (!backfill && typeof storedCursor === 'string' && /^-?\d+(\.\d+)?$/u.test(storedCursor)) {
    return { seconds: Number(storedCursor), reason: 'cursor' };
  }
  // No date window: 591 notes is small enough to take whole, and a window
  // would silently drop the old notes that are often the useful ones.
  return { seconds: -Infinity, reason: backfill ? 'backfill' : 'no-cursor' };
}

export function createNotesSource({ home } = {}) {
  return {
    name: 'notes',

    // Not pre-checked: under TCC a stat can pass where the later open is
    // denied, so the run is the honest probe.
    needs() {
      return [];
    },

    async run(ctx) {
      const resolvedHome = home ?? ctx.home ?? (await import('node:os')).homedir();
      const cacheDir = join(ctx.cacheDir, 'notes');
      const snapshotPath = await snapshotStore(storePath(resolvedHome), cacheDir);

      const rows = [];
      let skipped = 0;
      let locked = 0;
      let undecodable = 0;
      let maxModified = null;
      let db;
      try {
        db = new DatabaseSync(snapshotPath, { readOnly: true });
        const floor = scanFloorSeconds({
          storedCursor: ctx.state.getCursor(CURSOR_KEY),
          backfill: Boolean(ctx.backfill),
        });

        locked = Number(
          db
            .prepare('SELECT count(*) n FROM ZICCLOUDSYNCINGOBJECT WHERE ZISPASSWORDPROTECTED = 1')
            .get().n
        );

        // ZTITLE2 on the FOLDER row is the folder's name; a note points at its
        // folder through ZFOLDER. The self-join is what turns that id into
        // something a person recognises.
        const notes = db
          .prepare(
            `SELECT o.Z_PK, o.ZIDENTIFIER, o.ZTITLE1, o.ZSNIPPET,
                    o.ZCREATIONDATE1, o.ZMODIFICATIONDATE1,
                    f.ZTITLE2 AS folder,
                    d.ZDATA AS body
             FROM ZICCLOUDSYNCINGOBJECT o
             JOIN ZICNOTEDATA d ON d.ZNOTE = o.Z_PK
             LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = o.ZFOLDER
             WHERE o.ZMARKEDFORDELETION IS NOT 1
               AND o.ZISPASSWORDPROTECTED IS NOT 1
               AND (f.ZFOLDERTYPE IS NULL OR f.ZFOLDERTYPE != 1)
               AND o.ZMODIFICATIONDATE1 > ?
             ORDER BY o.ZMODIFICATIONDATE1 ASC
             LIMIT ?`
          )
          .all(Number.isFinite(floor.seconds) ? floor.seconds : -1e12, MAX_NOTES_PER_SCAN);

        for (const note of notes) {
          const modified = Number(note.ZMODIFICATIONDATE1);
          if (Number.isFinite(modified) && (maxModified === null || modified > maxModified)) {
            maxModified = modified;
          }
          const row = noteToRow(note);
          if (row === null) {
            skipped += 1;
            if (note.body) undecodable += 1;
          } else {
            rows.push(row);
          }
        }

        ctx.log.info('notes_scan', {
          connector: 'notes',
          backfill: Boolean(ctx.backfill),
          floorReason: floor.reason,
          examined: notes.length,
          rows: rows.length,
          skipped,
          undecodable,
          lockedNotIngested: locked,
          capped: notes.length >= MAX_NOTES_PER_SCAN,
        });
      } finally {
        try {
          db?.close();
        } catch {}
        // The snapshot has served its scan; a copy of every note the owner has
        // written is not something to leave in a cache directory.
        rmSync(snapshotPath, { force: true });
      }

      const totals =
        rows.length > 0 ? await ingestAll(ctx, rows) : { inserted: 0, updated: 0, unchanged: 0 };

      // Cursor advances only after the batch is in hermes.
      if (maxModified !== null) ctx.state.setCursor(CURSOR_KEY, String(maxModified));
      return { ...totals, skipped, lockedNotIngested: locked };
    },
  };
}

async function ingestAll(ctx, rows, batchSize = 100) {
  const totals = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += batchSize) {
    const t = await ctx.ingest(rows.slice(i, i + batchSize));
    totals.inserted += t.inserted ?? t.ingested ?? 0;
    totals.updated += t.updated ?? 0;
    totals.unchanged += t.unchanged ?? 0;
  }
  return totals;
}

export default createNotesSource();
