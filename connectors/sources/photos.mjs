// The Photos connector: the owner's photo library → hermes.
// WHY THIS ONE STILL READS THE STORE, when calendar and contacts stopped.
//
// It is not an oversight and it is not next on a list. Calendar and contacts
// moved to EventKit and the Contacts framework because those frameworks return
// the same data for a far narrower grant. PhotoKit does not: there is no
// PHPerson, no PHFace, and no title or description on PHAsset -- verified
// against the SDK headers, which mention none of them. Faces joined to person
// names are most of the value here ("who was I with"), and a PhotoKit backend
// would drop them silently while looking like an improvement.
//
// So photos sits with iMessage and notes: Full Disk Access is what its data
// actually costs, and as of 2026-08-24 that is the ONLY thing it costs. The app
// used to also ask for the photo library through PhotoKit and then never use the
// answer -- a second permission on the screen buying nothing, for data the disk
// grant was already delivering. That ask is gone; verified by resetting the
// Photos grant with FDA still in place and watching this connector open and
// query the library normally.
//
// If that ever changes -- a public people API -- this is the file to revisit,
// and Permissions.swift's photos() and the onboarding row have to come back with
// it, so that photos can leave the disk grant rather than merely be asked for
// twice.
//
// PERSONAL ROLE ONLY. It is the owner's library on the owner's Mac; the Mini
// has an empty one under a different Apple account.
//
// NO SNAPSHOT, unlike the iMessage connector, and the reason is size. The
// snapshot pattern copies the whole database first — measured at ~2 s for
// chat.db's 1 GB. Photos.sqlite is 3.2 GB here, so a copy per scan would cost
// ~7 s and 3.2 GB of writes every pass. A persistent read-only connection
// reads at zero copy cost; under WAL each STATEMENT gets snapshot isolation
// (storeReader.mjs mode b), and the scan below runs its asset, name and face
// queries as three separate statements with no wrapping transaction — so the
// scan as a whole is NOT one snapshot, and the faces/names reads can see a
// later WAL epoch than the asset batch. That drift is acceptable here: each
// statement is still internally coherent — never a torn read — and the
// faces/names merely reflect a slightly newer library state for the same
// asset PKs. The mode trade-off is recorded in ops/PROBES.md; the retired
// courier made the same call for its chat.db poll loop.
//
// FULL DISK ACCESS: same rule as every other Apple store — TCC attributes the
// grant to the responsible process, so this only works spawned by launchd
// from ~/.hazlie/bin/node.
//
// FACES: IDENTITY ONLY. Read under the owner's consent decision of 2026-08-20
// (recorded in the private repo's CLAUDE.md, which is not part of this repo). This takes the cluster a face belongs to and the owner's own
// name for it — enough to answer "who was I with in San Francisco" — and
// takes NONE of Apple's inferred attributes (age, gender, ethnicity, hair,
// expression, gaze). See lib/peopleRows.mjs for why: they answer none of the
// questions this corpus exists for, and ZETHNICITYTYPE has no published code
// mapping, so storing it means meaningless integers or an invented label
// about a real person — which never-fabricate forbids.
//
// LOG POLICY: counts only. Never a filename, never a caption, never OCR text,
// never a coordinate.

import { join } from 'node:path';
import { openPersistentReader } from '../lib/storeReader.mjs';
import { assetToRow } from '../lib/photoRows.mjs';
import { groupPeopleByAsset, peopleMeta, peopleText, personNames } from '../lib/peopleRows.mjs';

const DEFAULT_BACKFILL_DAYS = 365;
// One pass is bounded because photo libraries can be large and decoding OCR
// spawns a plutil per photo. The cursor advances, so the remainder arrives on
// later passes rather than being lost.
const MAX_ASSETS_PER_SCAN = 2000;
const CURSOR_KEY = 'photos:max-created';
const APPLE_EPOCH_MS = 978307200000;

export function libraryPath(home) {
  return join(home, 'Pictures', 'Photos Library.photoslibrary', 'database', 'Photos.sqlite');
}

// Core Data stores SECONDS since 2001. The cursor is kept in those same
// seconds so it compares directly against ZDATECREATED without a conversion
// at query time — the place an off-by-31000-years bug would hide.
export function scanFloorSeconds({ storedCursor, backfill, nowMs, backfillDays }) {
  if (!backfill && typeof storedCursor === 'string' && /^-?\d+(\.\d+)?$/u.test(storedCursor)) {
    return { seconds: Number(storedCursor), reason: 'cursor' };
  }
  const floorMs = nowMs - backfillDays * 86_400_000;
  return { seconds: (floorMs - APPLE_EPOCH_MS) / 1000, reason: backfill ? 'backfill' : 'no-cursor' };
}

export function createPhotosSource({ home } = {}) {
  return {
    name: 'photos',

    // Not pre-checked, same as calendar and imessage: under TCC a stat can
    // pass where the later open is denied. The run is the honest probe.
    needs() {
      return [];
    },

    async run(ctx) {
      const resolvedHome = home ?? ctx.home ?? (await import('node:os')).homedir();
      const path = libraryPath(resolvedHome);

      let db;
      const rows = [];
      let skipped = 0;
      let maxCreated = null;
      let withPeople = 0;
      try {
        // Mode (b) of lib/storeReader.mjs — the sanctioned persistent-reader
        // entry point, whose wrapper explains the missing--shm failure a raw
        // open reports cryptically.
        db = openPersistentReader(path);
        const floor = scanFloorSeconds({
          storedCursor: ctx.state.getCursor(CURSOR_KEY),
          backfill: Boolean(ctx.backfill),
          nowMs: ctx.now(),
          backfillDays: ctx.config?.photos?.backfillDays ?? DEFAULT_BACKFILL_DAYS,
        });

        // OCR IS NOT READ, and the reason is measured rather than assumed.
        // This used to point at connectors/lib/ocrPlist.mjs, a decoder the
        // connector never called; the code is deleted and its finding moved
        // here, next to the decision it justifies. Measured on a private photo
        // library:
        //
        //   - the blob in ZCHARACTERRECOGNITIONATTRIBUTES.ZCHARACTER-
        //     RECOGNITIONDATA IS a binary plist (magic `bplist00`), readable
        //     with plutil — no dependency needed. That part was right;
        //   - `plutil -convert json` REFUSES it: the archive embeds <data>
        //     elements and JSON cannot represent them ("Invalid object in
        //     plist for JSON format"). xml1 converts the same blob happily.
        //     The failure reads as "no text in any photo" rather than as a
        //     format error, which is the kind of wrong mistaken for an empty
        //     library;
        //   - but the recognized text is NOT in the plist's <string>
        //     elements. Those are NSKeyedArchiver class names, identical in
        //     every photo. Sampled blobs returned the same boilerplate;
        //   - the text sits in a ~25 KB <data> element that is not itself a
        //     plist (magic 103bdee9…) — protobuf, or a Vision encoding.
        //
        // So reading it means decoding an undocumented binary format, not
        // unwrapping a plist: real work, not the afternoon it looked like.
        //
        // The trap worth remembering: the first version LOOKED like it
        // worked. It returned text, for every photo, with no errors. Only
        // comparing hashes across photos revealed every "decode" was the same
        // string — which shipped would have put one boilerplate string in all
        // rows and made every future search match everything.
        const stmt = db.prepare(
          `SELECT a.Z_PK, a.ZUUID, a.ZDATECREATED, a.ZKIND, a.ZKINDSUBTYPE, a.ZLATITUDE, a.ZLONGITUDE,
                  a.ZFAVORITE, a.ZWIDTH, a.ZHEIGHT, a.ZDURATION, a.ZTRASHEDSTATE, a.ZFILENAME,
                  b.ZTITLE, b.ZASSETDESCRIPTION
           FROM ZASSET a
           LEFT JOIN ZADDITIONALASSETATTRIBUTES b ON b.ZASSET = a.Z_PK
           WHERE a.ZDATECREATED > ? AND a.ZTRASHEDSTATE = 0
           ORDER BY a.ZDATECREATED ASC
           LIMIT ?`
        );
        const assets = stmt.all(floor.seconds, MAX_ASSETS_PER_SCAN);

        // Faces are fetched for THIS BATCH's assets only, not the whole
        // library: joining every detection per-row would be a round trip per
        // photo, and loading them all would be most of the table for one
        // batch's answers.
        let peopleByAsset = new Map();
        if (assets.length > 0) {
          const pks = assets.map((a) => Number(a.Z_PK)).filter(Number.isFinite);
          const holes = pks.map(() => '?').join(',');
          const names = personNames(
            db.prepare('SELECT Z_PK, ZFULLNAME FROM ZPERSON WHERE ZFULLNAME IS NOT NULL').all()
          );
          const faces = db
            .prepare(
              `SELECT ZASSETFORFACE, ZPERSONFORFACE FROM ZDETECTEDFACE
               WHERE ZASSETFORFACE IN (${holes})`
            )
            .all(...pks);
          peopleByAsset = groupPeopleByAsset(faces, { names });
        }

        for (const asset of assets) {
          const created = Number(asset.ZDATECREATED);
          if (Number.isFinite(created) && (maxCreated === null || created > maxCreated)) {
            maxCreated = created;
          }
          const row = assetToRow(asset, { ocr: null });
          if (row === null) {
            skipped += 1;
            continue;
          }
          const bucket = peopleByAsset.get(Number(asset.Z_PK));
          const pMeta = peopleMeta(bucket);
          if (Object.keys(pMeta).length > 0) {
            row.meta = { ...row.meta, ...pMeta };
            // Names join the TEXT too: text is what a later search matches,
            // so a name buried only in meta would not be findable.
            const withWho = peopleText(bucket);
            if (withWho) row.text = `${row.text}\n${withWho}`;
            withPeople += 1;
          }
          rows.push(row);
        }

        ctx.log.info('photos_scan', {
          connector: 'photos',
          backfill: Boolean(ctx.backfill),
          floorReason: floor.reason,
          examined: assets.length,
          rows: rows.length,
          withPeople,
          skipped,
          capped: assets.length >= MAX_ASSETS_PER_SCAN,
        });
      } finally {
        try {
          db?.close();
        } catch {}
      }

      const totals =
        rows.length > 0 ? await ingestAll(ctx, rows) : { inserted: 0, updated: 0, unchanged: 0 };

      // Cursor advances only after the batch is in hermes; written first, an
      // ingest failure would be skipped permanently and invisibly.
      if (maxCreated !== null) ctx.state.setCursor(CURSOR_KEY, String(maxCreated));
      return { ...totals, skipped, withPeople };
    },
  };
}

async function ingestAll(ctx, rows, batchSize = 250) {
  const totals = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += batchSize) {
    const t = await ctx.ingest(rows.slice(i, i + batchSize));
    totals.inserted += t.inserted ?? t.ingested ?? 0;
    totals.updated += t.updated ?? 0;
    totals.unchanged += t.unchanged ?? 0;
  }
  return totals;
}

export default createPhotosSource();
