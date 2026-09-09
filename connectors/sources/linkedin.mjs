// One-time LinkedIn archive importer. The archive supplies history without
// crawling LinkedIn. The Matrix bridge separately supplies new messages.
// Both paths use the same message entity key, so an overlap is harmless.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectionsToRows, messagesToRows } from '../lib/linkedinRows.mjs';

const CURSOR_KEY = 'linkedin:max-mtime';
const ARCHIVE_FILES = Object.freeze(['Connections.csv', 'messages.csv']);

export function defaultImportDir(home = homedir()) {
  return join(home, '.hazlie', 'imports', 'linkedin');
}

export function createLinkedinSource({ home } = {}) {
  return {
    name: 'linkedin',

    needs() {
      const dir = defaultImportDir(home);
      return ARCHIVE_FILES.some((name) => existsSync(join(dir, name)))
        ? []
        : ['LinkedIn archive not imported yet. Use the LinkedIn connection card to select the downloaded ZIP or CSV files.'];
    },

    async run(ctx) {
      const dir = defaultImportDir(home ?? ctx.home);
      const files = ARCHIVE_FILES
        .map((name) => join(dir, name))
        .filter((path) => existsSync(path));
      if (files.length === 0) {
        ctx.log.info('linkedin_archive_scan', { connector: 'linkedin', files: 0 });
        return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      }

      const newestMtime = Math.max(...files.map((path) => statSync(path).mtimeMs));
      const stored = Number(ctx.state.getCursor(CURSOR_KEY) ?? 0);
      if (!ctx.backfill && Number.isFinite(stored) && newestMtime <= stored) {
        ctx.log.info('linkedin_archive_scan', {
          connector: 'linkedin',
          files: files.length,
          unchangedSinceMtime: true,
        });
        return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      }

      const rows = [];
      let skipped = 0;
      for (const path of files) {
        const text = readFileSync(path, 'utf8');
        const out = path.endsWith('Connections.csv')
          ? connectionsToRows(text, { fallbackTs: statSync(path).mtimeMs })
          : messagesToRows(text, { selfName: ctx.config.selfName ?? null });
        rows.push(...out.rows);
        skipped += out.skipped;
      }

      ctx.log.info('linkedin_archive_scan', {
        connector: 'linkedin',
        files: files.length,
        rows: rows.length,
        skipped,
      });
      const totals = rows.length > 0
        ? await ingestAll(ctx, rows)
        : { inserted: 0, updated: 0, unchanged: 0 };
      ctx.state.setCursor(CURSOR_KEY, String(newestMtime));
      return { ...totals, skipped };
    },
  };
}

async function ingestAll(ctx, rows, batchSize = 200) {
  const totals = { inserted: 0, updated: 0, unchanged: 0 };
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const result = await ctx.ingest(rows.slice(offset, offset + batchSize));
    totals.inserted += result.inserted ?? result.ingested ?? 0;
    totals.updated += result.updated ?? 0;
    totals.unchanged += result.unchanged ?? 0;
  }
  return totals;
}

export default createLinkedinSource();
