// Print one deterministic energy-audit digest to stdout and exit. Read-only
// by construction: the database is opened with {readOnly: true}, so this
// script cannot write, migrate, or chmod anything even by accident — if the
// database needs creating or upgrading, that is hermes' job, and the error
// below points there.
//
// The database path resolves exactly as hermes resolves it: importing
// server/hermes.mjs runs its ui/.env.local loader (real environment wins),
// then HERMES_DB overrides the default ~/.hazlie/context/context.db.
//
// Usage, from ui/:  node scripts/digest-once.mjs

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath } from '../server/hermes.mjs';
import { computeAggregates, renderDigestLines } from '../server/vault/digest.mjs';

const dbPath = process.env.HERMES_DB ?? defaultDbPath();

if (!existsSync(dbPath)) {
  console.error(
    `context database not found: ${dbPath}\n` +
      'Nothing has been ingested yet on this machine. Start hermes to create it ' +
      '(cd ui && npm run hermes; see ops/setup-llm.sh), or point HERMES_DB at an ' +
      'existing context.db.'
  );
  process.exit(1);
}

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  const now = Date.now();
  const agg = computeAggregates(db, { now });
  process.stdout.write(renderDigestLines(agg, { now }).join('\n') + '\n');
} catch (error) {
  console.error(`digest failed: ${error?.message ?? error}`);
  process.exit(1);
} finally {
  try {
    db?.close();
  } catch {}
}
