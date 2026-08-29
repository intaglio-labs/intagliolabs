// Retention, from the connector side. Hermes is the corpus's sole deleter —
// this module never opens context.db; it REQUESTS deletion through the
// bearer-only /admin/* routes, per source, on the schedule config.retention
// declares, and requests /admin/maintain (the blocking FTS rebuild + VACUUM)
// once per day in the configured idle window (default 03:30) so the VACUUM
// holds hermes when nothing else needs it.
//
// Local artifacts are a different story: cursors, caches, and quarantine
// rows are OURS, and deleting them happens directly (see run.mjs --purge,
// which pairs an /admin/purge with wipeLocalArtifacts below). Backup policy
// for all of it is NONE by default — a backup is a second unguarded corpus
// copy, and everything here re-ingests from its source of truth. The one-time,
// owner-only bridge-runtime migration backup is documented separately in
// connectors/AGENTS.md and does not contain this connector state.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adminMaintain, adminRetain, DEFAULT_HERMES_BASE_URL } from './lib/ingestClient.mjs';
import { defaultHermesTokenPath } from './lib/secrets.mjs';
import { openStateDb } from './lib/state.mjs';
import { createLogger } from './lib/log.mjs';
import { safeErrorFingerprint } from './lib/safeError.mjs';
// A STATIC import despite the cycle (daemon.mjs imports this module back):
// ESM resolves static cycles by hoisting, and both sides touch the other's
// bindings only inside function bodies. The obvious-looking dynamic
// `await import('./daemon.mjs')` in the CLI block below would DEADLOCK
// instead — daemon.mjs's evaluation waits on this module, which is itself
// suspended on that await (Node exits 13, "unsettled top-level await").
import { loadConfig } from './daemon.mjs';

export const DEFAULT_MAINTAIN_HOUR = '03:30';

// Milliseconds from `nowMs` to the next occurrence of the idle window,
// computed against local wall-clock time because "03:30" means the
// household's 03:30. Always strictly positive: landing exactly on the minute
// schedules the NEXT day rather than a zero-delay double fire.
export function msUntilIdleWindow(maintainHour = DEFAULT_MAINTAIN_HOUR, nowMs = Date.now()) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(maintainHour));
  if (!match) throw new Error(`maintainHour must be "HH:MM" (24-hour), got ${JSON.stringify(maintainHour)}`);
  const target = new Date(nowMs);
  target.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (target.getTime() <= nowMs) {
    // NEXT DAY BY DATE FIELDS, not by adding 86,400,000 ms.
    //
    // This header says the window is local wall-clock, and a fixed day in
    // milliseconds is not: a local day is 23 or 25 hours across a DST
    // transition, so adding a flat 24h landed the blocking VACUUM an hour off
    // twice a year and stayed off until something else reset it. The same
    // reasoning is written at the weekday/month tables in
    // ui/server/memory/episodic.mjs — "DST days are 23 or 25 hours long".
    //
    // setDate then setHours: setDate alone keeps the old clock time, which is
    // the thing that shifts.
    target.setDate(target.getDate() + 1);
    target.setHours(Number(match[1]), Number(match[2]), 0, 0);
  }
  return target.getTime() - nowMs;
}

// Whether `nowMs` is inside the maintenance window at all. The window is one
// hour wide starting at maintainHour — wide enough that a timer firing a few
// minutes late still counts, narrow enough that a machine which slept through
// the night does not.
export function isInsideIdleWindow(maintainHour = DEFAULT_MAINTAIN_HOUR, nowMs = Date.now()) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(maintainHour));
  if (!match) return false;
  const start = new Date(nowMs);
  start.setHours(Number(match[1]), Number(match[2]), 0, 0);
  let startMs = start.getTime();
  if (nowMs < startMs) {
    // The window straddles midnight for any maintainHour from 23:01 on, and
    // a timer firing just after 00:00 sees TODAY's occurrence in the future
    // — the open window is yesterday's. Previous day by date fields, not a
    // flat 24h, for the DST reasoning written at msUntilIdleWindow.
    start.setDate(start.getDate() - 1);
    start.setHours(Number(match[1]), Number(match[2]), 0, 0);
    startMs = start.getTime();
  }
  return nowMs >= startMs && nowMs < startMs + 3_600_000;
}

// One retention pass: /admin/retain for every source config.retention names
// (maintainHour is scheduling metadata, not a source). Failures are per
// source — one source's failed retention is recorded and the rest still run,
// same isolation rule as the pollers.
export async function retentionPass({ config, state, log, ingestOpts, now = Date.now }) {
  const retention = config.retention ?? {};
  const results = {};
  for (const [source, keepDays] of Object.entries(retention)) {
    if (source === 'maintainHour') continue;
    const startedTs = now();
    try {
      const { deleted } = await adminRetain({ source, keepDays }, ingestOpts);
      results[source] = { deleted };
      state?.recordRun({
        connector: `retain:${source}`,
        startedTs,
        finishedTs: now(),
        ok: true,
        deleted,
      });
      log?.info('retention', { source, keepDays, deleted });
    } catch (error) {
      results[source] = { error: safeErrorFingerprint(error) };
      state?.recordRun({
        connector: `retain:${source}`,
        startedTs,
        finishedTs: now(),
        ok: false,
        error: safeErrorFingerprint(error),
      });
      log?.error('retention_failed', { source, error: safeErrorFingerprint(error) });
    }
  }
  return results;
}

export async function maintainPass({ log, ingestOpts }) {
  const result = await adminMaintain(ingestOpts);
  log?.info('maintain', { maintained: result.maintained === true });
  return result;
}

// Delete a connector's LOCAL artifacts: cursors (exact name and its
// namespace), the per-connector cache directory, and the connector-owned
// state tables. Called by run.mjs --purge after /admin/purge succeeds, so a
// purged source cannot resume from a cursor that points past its own absence
// — the next run re-observes from scratch and re-ingests only what the
// owner still wants held.
export function wipeLocalArtifacts(connector, { state, cacheDir, log }) {
  const cursorsDeleted = state.deleteCursors(connector);
  if (connector === 'imessage') state.db.exec('DELETE FROM imessage_undecoded');
  if (connector === 'contacts') {
    // Contact thumbnails are household-private state too. Leaving them behind
    // made an explicit contacts purge remove the names but retain every face.
    state.db.exec('DELETE FROM contact_avatars; DELETE FROM contact_ids');
  }
  rmSync(join(cacheDir, connector), { recursive: true, force: true });
  log?.info('local_artifacts_wiped', { connector, cursorsDeleted });
  return { cursorsDeleted };
}

// CLI: an explicit invocation means the operator wants retention NOW, idle
// window or not — the schedule is the daemon's job (daemon.mjs wires
// retentionPass + maintainPass onto msUntilIdleWindow).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const log = createLogger();
  const state = openStateDb();
  try {
    const config = loadConfig();
    const ingestOpts = {
      baseUrl: process.env.HAZLIE_HERMES_URL ?? config.hermesUrl ?? DEFAULT_HERMES_BASE_URL,
      tokenFile: defaultHermesTokenPath(),
    };
    const results = await retentionPass({ config, state, log, ingestOpts });
    // Report what hermes ACTUALLY said. This printed the literal `true`
    // regardless of the response, so a maintenance pass that hermes declined —
    // because it was outside the idle window, or busy — was reported to the
    // operator as done. maintainPass has always returned the real result; the
    // CLI just ignored it. A status line that cannot say "no" is not a status
    // line.
    const maintain = await maintainPass({ log, ingestOpts });
    console.log(
      JSON.stringify({ retention: results, maintained: maintain?.maintained === true })
    );
  } catch (error) {
    console.error(`retention failed (${safeErrorFingerprint(error)}); run npm run doctor`);
    process.exitCode = 1;
  } finally {
    state.close();
    log.close();
  }
}
