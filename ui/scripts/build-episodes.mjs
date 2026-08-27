#!/usr/bin/env node
// Rebuild the episode index from the context table.
//
//   node ui/scripts/build-episodes.mjs [--gap-minutes 60] [--dry-run]
//
// Arithmetic only. No model is called, nothing leaves the box, and the whole
// index is derived -- dropping both tables and running this again produces the
// identical state. That is why it can replace rather than merge, and why it is
// safe to run on a timer.
//
// LOG POLICY, and it matters more here than in most places: thread_key holds a
// chat guid, a chat guid holds a handle, and counterparty_key holds a person's
// name. This prints COUNTS. Never a key, never a row, never a name.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/hermes.mjs';
import { rebuildEpisodes } from '../server/memory/episodeStore.mjs';
import { loadSpine } from '../server/people/graph.mjs';
import { DEFAULT_GAP_MS } from '../server/memory/episodes.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const gapMinutes = Number(value('--gap-minutes', String(DEFAULT_GAP_MS / 60000)));
if (!Number.isFinite(gapMinutes) || gapMinutes <= 0) {
  process.stderr.write('--gap-minutes must be a positive number\n');
  process.exit(2);
}

const contextPath = join(homedir(), '.hazlie', 'context', 'context.db');
const statePath = join(homedir(), '.hazlie', 'connectors', 'state.db');

let db;
let state = null;
try {
  db = openDb(contextPath);
  // The contacts spine lives in the connectors' state, not the corpus. Absent
  // is a valid state: episodes still build, they just key by raw handle.
  try {
    state = new DatabaseSync(statePath, { readOnly: true });
  } catch {
    state = null;
  }
  const spine = state ? loadSpine(state) : null;

  if (flag('--dry-run')) {
    const counts = db
      .prepare(
        "SELECT source, COUNT(*) n FROM context WHERE source IN ('imessage','whatsapp','notes') GROUP BY source"
      )
      .all();
    process.stdout.write(
      `${JSON.stringify({ dry_run: true, gap_minutes: gapMinutes, rows_by_source: counts }, null, 2)}\n`
    );
    process.exit(0);
  }

  const started = Date.now();
  // FULL, ALWAYS. Running this by hand means "re-cut everything now" -- it is the
  // operator's override, not a scheduled tick. rebuildEpisodes also notices a
  // changed gap on its own, so this is belt and braces for the case where the
  // rule is the SAME and the operator still wants the whole index rebuilt.
  const out = rebuildEpisodes(db, { gapMs: gapMinutes * 60_000, spine, full: true });
  process.stdout.write(
    `${JSON.stringify({ ...out, gap_minutes: gapMinutes, ms: Date.now() - started }, null, 2)}\n`
  );
} catch (error) {
  process.stderr.write(`build-episodes failed: ${error?.message ?? error}\n`);
  process.exit(1);
} finally {
  try {
    db?.close();
  } catch {}
  try {
    state?.close();
  } catch {}
}
