// The LinkedIn connector: the owner's data export → hermes.
//
// DELIBERATELY FILE-BASED. There is no LinkedIn API here and never should be:
// scraping risks the owner's account, the official API exposes almost nothing,
// and the export ("Settings → Data privacy → Get a copy of your data") already
// contains the two files that matter. The owner downloads the archive and
// unzips it (or just the two CSVs) into ~/.hazlie/imports/linkedin/. This
// connector notices, ingests, and goes quiet until a file changes.
//
//   Connections.csv   who, where they work, and — the point — Connected On.
//   messages.csv      optional; DMs, treated like mail (excluded from claims
//                     and the episodic shelf).
//
// CURSOR: the files' mtimes. An export is static; re-parsing a few thousand
// rows every 15 minutes to find nothing changed is silly, so a scan runs only
// when a file is newer than the last one seen. `--backfill` ignores the
// cursor and re-reads both files.
//
// LOG POLICY: counts only — never a name, company, or message fragment.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connectionsToRows, messagesToRows } from '../lib/linkedinRows.mjs';
import { clearExportReady, importDir } from '../lib/linkedinExport.mjs';

const CURSOR_KEY = 'linkedin:max-mtime';

// The import folder, and the name the rest of the repo already calls it by.
// The derivation itself moved to lib/linkedinExport.mjs, next to the marker
// that lives in the same directory -- two readers deriving one path by hand is
// how two surfaces come to disagree about where the file goes.
export { importDir as defaultImportDir };

export function createLinkedinSource({ home } = {}) {
  return {
    name: 'linkedin',

    // What is MISSING, so [] means ready. Connections.csv is the requirement;
    // messages.csv is optional and its absence is not a fault.
    needs() {
      const dir = importDir(home);
      const conn = join(dir, 'Connections.csv');
      return existsSync(conn)
        ? []
        : [
            `LinkedIn export missing: put Connections.csv (and optionally messages.csv) in ${dir}. ` +
              'Get the export at linkedin.com Settings → Data privacy → Get a copy of your data.',
          ];
    },

    async run(ctx) {
      const dir = importDir(home ?? ctx.home);
      // THE EXPORT IS HERE, SO THE NUDGE IS SPENT. run() is only reached once
      // needs() has seen Connections.csv, which is exactly the event
      // export-ready.json was waiting for: the owner opened the mail, followed
      // it, and dropped the file. Deleting it here rather than at the surfaces
      // keeps "is the export ready to fetch" a fact about the disk instead of a
      // flag somebody has to remember to clear. Idempotent -- an absent marker
      // is the state this is trying to reach.
      clearExportReady(home ?? ctx.home);
      const files = ['Connections.csv', 'messages.csv']
        .map((name) => join(dir, name))
        .filter((p) => existsSync(p));
      if (files.length === 0) {
        ctx.log.info('linkedin_scan', { connector: 'linkedin', files: 0 });
        return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      }

      const newestMtime = Math.max(...files.map((p) => statSync(p).mtimeMs));
      const stored = Number(ctx.state.getCursor(CURSOR_KEY) ?? 0);
      if (!ctx.backfill && Number.isFinite(stored) && newestMtime <= stored) {
        ctx.log.info('linkedin_scan', { connector: 'linkedin', files: files.length, unchangedSinceMtime: true });
        return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      }

      const rows = [];
      let skipped = 0;
      for (const path of files) {
        const text = readFileSync(path, 'utf8');
        const out = path.endsWith('Connections.csv')
          ? connectionsToRows(text, { fallbackTs: statSync(path).mtimeMs })
          : messagesToRows(text);
        rows.push(...out.rows);
        skipped += out.skipped;
      }

      ctx.log.info('linkedin_scan', {
        connector: 'linkedin',
        files: files.length,
        rows: rows.length,
        skipped,
      });

      const totals =
        rows.length > 0 ? await ingestAll(ctx, rows) : { inserted: 0, updated: 0, unchanged: 0 };
      // Cursor advances only after the batch is in hermes.
      ctx.state.setCursor(CURSOR_KEY, String(newestMtime));
      return { ...totals, skipped };
    },
  };
}

async function ingestAll(ctx, rows, batchSize = 200) {
  const totals = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += batchSize) {
    const t = await ctx.ingest(rows.slice(i, i + batchSize));
    totals.inserted += t.inserted ?? t.ingested ?? 0;
    totals.updated += t.updated ?? 0;
    totals.unchanged += t.unchanged ?? 0;
  }
  return totals;
}

export default createLinkedinSource();
