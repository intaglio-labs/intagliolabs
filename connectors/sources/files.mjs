// The files connector: the owner's cloud-sync folders → hermes.
//
//   entity files:<absolute path>    filename + folder trail, plus content
//                                   when the file is local, small and text
//
// WHAT THIS CONNECTOR IS FOR. iCloud Drive, Box and Dropbox hold the things
// the owner made and kept — contracts, decks, notes, scans. The names and
// the folder trails alone answer questions the rest of the corpus cannot.
//
// WHAT IT WILL NOT DO. Many cloud-drive entries can be dataless — names and
// sizes with no bytes on disk. Opening them could silently download a large
// archive on a timer. So dataless files are ingested as metadata and never
// opened. lib/fileWalk.mjs holds the detection and the reasoning.
//
// NO NETWORK. This connector makes no outbound connection of any kind; it
// reads the local mirrors those services maintain. That is why it does not
// appear in the egress table in connectors/AGENTS.md.
//
// FULL DISK ACCESS is not required for the owner's own iCloud/Box/Dropbox
// folders, which is why this runs where the Apple-store connectors cannot.
//
// LOG POLICY: counts and root labels only. Never a filename — a filename is
// corpus content here, and often the most revealing part of it.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DOCUMENT_EXTS, extensionOf, walkFiles } from '../lib/fileWalk.mjs';
import { extractText, TEXT_EXTS } from '../lib/fileText.mjs';
import { fileToRow } from '../lib/fileRows.mjs';

const CURSOR_KEY = 'files:max-mtime';
// One run's worth. The walk is metadata-only, so the bound is on rows
// delivered, not paths visited.
const MAX_ROWS_PER_SCAN = 2000;

// The stores this connector knows how to find. Each is checked for existence
// at run time: a Mac without Dropbox simply has no Dropbox rows, which is not
// an error and must not read as one.
export function defaultRoots(home = homedir()) {
  return [
    { label: 'icloud', path: join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') },
    { label: 'box', path: join(home, 'Library', 'CloudStorage', 'Box-Box') },
    { label: 'dropbox', path: join(home, 'Dropbox') },
    // Google Drive mounts under a per-account directory name, so it cannot be
    // hardcoded; discoverGoogleDrive finds it. Absent on this Mac today.
  ];
}

// "GoogleDrive-someone@example.com" — the account is in the directory name,
// so the only way to find it is to look.
export function discoverGoogleDrive(home = homedir(), readdir) {
  const base = join(home, 'Library', 'CloudStorage');
  let entries;
  try {
    entries = readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('GoogleDrive-'))
    .map((e) => ({ label: 'googledrive', path: join(base, e.name) }));
}

// Which files earn a row. Documents always; text files always (they can also
// carry content). Everything else is counted and dropped — see fileWalk.
export function isWorthARow(name) {
  const ext = extensionOf(name);
  return DOCUMENT_EXTS.includes(ext) || TEXT_EXTS.includes(ext);
}

export function scanFloorMs({ storedCursor, backfill }) {
  if (!backfill && typeof storedCursor === 'string' && /^\d+(\.\d+)?$/u.test(storedCursor)) {
    return { ms: Number(storedCursor), reason: 'cursor' };
  }
  return { ms: -Infinity, reason: backfill ? 'backfill' : 'no-cursor' };
}

// Where the cursor lands after a scan, extracted so the tie cases have a
// witness — they are the part of this file most likely to lose a file quietly,
// and run() cannot be exercised without a filesystem.
//
// Returns { cursor, dropped, stalled }. `cursor` is null when nothing was
// delivered, which leaves the stored cursor untouched.
export function nextFileCursor({ batch, candidates, capped }) {
  if (!Array.isArray(batch) || batch.length === 0) return { cursor: null, dropped: 0, stalled: false };
  const last = batch[batch.length - 1].mtime;
  if (!capped) return { cursor: last, dropped: 0, stalled: false };
  // A tie wider than the whole batch cannot be re-offered without looping
  // forever, so step past it and report the loss.
  if (batch[0].mtime === last) {
    const tied = (Array.isArray(candidates) ? candidates : []).filter((c) => c.mtime === last).length;
    return { cursor: last + 1, dropped: Math.max(0, tied - batch.length), stalled: true };
  }
  // Otherwise rewind one millisecond so the boundary tie is offered again.
  // Files already delivered return as `unchanged`; the ones that did not fit
  // finally land.
  return { cursor: last - 1, dropped: 0, stalled: false };
}

export function createFilesSource({ home, roots } = {}) {
  return {
    name: 'files',

    needs() {
      return [];
    },

    async run(ctx) {
      const resolvedHome = home ?? ctx.home ?? homedir();
      const { readdirSync } = await import('node:fs');
      // Precedence: an explicit factory argument (direct construction and
      // tests), then config.files.roots, then the discovered cloud folders.
      //
      // config.files.roots was VALIDATED and never READ. daemon.mjs:377-392
      // checks it is a non-empty array of {label, path} with absolute paths and
      // five distinct error messages, and daemon.mjs:233 documents it as
      // overriding the discovered folders — but `roots` here is the factory
      // parameter, the default export constructs with no arguments, and
      // nothing ever passed the config through. An operator could set the key,
      // watch it validate, and get the hardcoded defaults anyway.
      const configuredRoots = Array.isArray(ctx.config?.files?.roots)
        ? ctx.config.files.roots
        : null;
      const configured =
        roots ??
        configuredRoots ?? [
          ...defaultRoots(resolvedHome),
          ...discoverGoogleDrive(resolvedHome, readdirSync),
        ];
      const present = configured.filter((r) => existsSync(r.path));

      const floor = scanFloorMs({
        storedCursor: ctx.state.getCursor(CURSOR_KEY),
        backfill: Boolean(ctx.backfill),
      });

      // Candidates first, rows second. The walk yields in directory order,
      // but the cursor is an mtime — so a run that took the first N files it
      // happened to see and then declined to advance the cursor (because it
      // was capped) would re-walk the same N forever and never reach the
      // second root. A private dry run filled the cap with iCloud rows
      // and never got as far as Box or Dropbox, and would not have on any
      // subsequent run either. Sorting by mtime and advancing to the end of
      // the delivered slice is what makes a capped run make progress.
      const candidates = [];
      let visited = 0;
      let datalessSeen = 0;
      const skips = {};
      const onSkip = (why) => {
        skips[why] = (skips[why] ?? 0) + 1;
      };

      for (const root of present) {
        for (const entry of walkFiles(root.path, { onSkip })) {
          visited += 1;
          if (entry.dataless) datalessSeen += 1;
          const mtime = Number(entry.stat.mtimeMs);
          if (!Number.isFinite(mtime) || mtime <= floor.ms) continue;
          if (!isWorthARow(entry.name)) continue;
          candidates.push({ ...entry, mtime, root: root.path, label: root.label });
        }
      }

      candidates.sort((a, b) => a.mtime - b.mtime);
      const batch = candidates.slice(0, MAX_ROWS_PER_SCAN);
      const capped = candidates.length > batch.length;

      const rows = [];
      let withContent = 0;
      // ONE decision point, and it counts itself.
      //
      // `datalessNeverOpened` used to be reported as `datalessSeen` — a copy of
      // the precondition rather than a measurement of the outcome. It would
      // therefore have printed the same reassuring number if the guard below
      // were inverted and 45.6 GB were pulling down through the owner's iCloud
      // on a timer. A counter whose value equals its own precondition cannot
      // detect the breach it exists to detect.
      //
      // Now the refusal and the count happen in the same place, so the number
      // is evidence: it is 0 because nothing was attempted, and it stops being
      // 0 the moment anything is.
      let datalessOpenAttempts = 0;
      const readContent = (entry) => {
        if (entry.dataless) {
          datalessOpenAttempts += 1;
          return null; // fail closed — refuse the read even while recording it
        }
        return extractText(entry.path, extensionOf(entry.name));
      };
      for (const entry of batch) {
        // Content only from files whose bytes are already here. This is the
        // line that keeps 45.6 GB where it is.
        const content = readContent(entry);
        if (content) withContent += 1;
        const row = fileToRow({ ...entry, content });
        if (row !== null) rows.push(row);
      }

      // The high-water mark of what was actually DELIVERED, not of what was
      // seen. Everything past it is still owed and must be re-offered.
      let maxMtime = batch.length ? batch[batch.length - 1].mtime : null;
      let tieDropped = 0;
      // THE OLD GUARD COULD NEVER FIRE. It read
      // `if (capped && maxMtime === floor.ms)`, but candidates are filtered to
      // mtime > floor, so the last delivered mtime is never equal to the floor.
      // The condition was unreachable by construction, and the loss it was
      // written to bound happened anyway: when the cap lands mid-tie, the
      // files sharing that millisecond which did not fit are dropped to
      // `mtime > maxMtime` on the next run and never offered again.
      //
      // So the boundary tie is now RE-OFFERED instead. Rewinding one
      // millisecond makes the next scan include everything at that mtime; the
      // ones already delivered come back as `unchanged`, which is cheap, and
      // the ones that did not fit finally land.
      //
      // The exception is the case the original comment feared: a tie WIDER
      // than the cap, where re-offering would loop forever and the connector
      // would never advance. Then, and only then, step past it and say so —
      // a bounded, reported loss beats an unbounded stall.
      const decided = nextFileCursor({ batch, candidates, capped });
      maxMtime = decided.cursor;
      tieDropped = decided.dropped;
      if (decided.stalled) {
        ctx.log.warn('files_tie_wider_than_cap', {
          connector: 'files',
          dropped: decided.dropped,
          note: 'more files share one mtime than the scan cap; stepping past to avoid a stall',
        });
      }

      ctx.log.info('files_scan', {
        connector: 'files',
        backfill: Boolean(ctx.backfill),
        floorReason: floor.reason,
        roots: present.map((r) => r.label),
        rootsMissing: configured.length - present.length,
        visited,
        datalessSeen,
        datalessOpenAttempts,
        datalessNeverOpened: datalessOpenAttempts === 0,
        candidates: candidates.length,
        rows: rows.length,
        withContent,
        capped,
        // Says outright how many are still owed, so a capped run does not
        // read as a complete one.
        remaining: candidates.length - batch.length,
        skips,
      });

      const totals =
        rows.length > 0 ? await ingestAll(ctx, rows) : { inserted: 0, updated: 0, unchanged: 0 };

      // Cursor advances only after the batch is in hermes, and only as far as
      // the batch actually reached.
      if (maxMtime !== null) ctx.state.setCursor(CURSOR_KEY, String(maxMtime));
      return {
        ...totals,
        visited,
        datalessSeen,
        withContent,
        capped,
        remaining: candidates.length - batch.length,
      };
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

export default createFilesSource();
