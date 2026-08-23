// One-shot connector operations, for hands-on runs the daemon's schedule
// does not cover:
//
//   node run.mjs <source>              one poll pass, now
//   node run.mjs <source> --backfill   one pass with the source's backfill
//                                      window instead of its cursor
//   node run.mjs <source> --purge      /admin/purge the hermes source, then
//                                      wipe the connector's LOCAL artifacts
//                                      (cursors, cache, quarantine) so the
//                                      next run re-observes from scratch
//   node run.mjs <source> --disable    write the disable marker; the daemon
//                                      skips the source from its next tick
//                                      (remove the marker file to re-enable)
//
// Flags are mutually exclusive — each is a different intent, and combining
// them (purge-then-backfill?) should be two deliberate invocations, not one
// ambiguous one.
import { closeSync, existsSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONNECTOR_NAMES,
  CONNECTOR_HERMES_SOURCE,
  defaultCacheDir,
  disableMarkerPath,
  loadConfig,
  loadSources,
} from './daemon.mjs';
import {
  DEFAULT_HERMES_BASE_URL,
  adminDeleteEntities,
  adminEntities,
  adminMaintain,
  adminPurge,
  adminRetain,
  ingest,
} from './lib/ingestClient.mjs';
import { defaultHermesTokenPath } from './lib/secrets.mjs';
import { openStateDb, runCounts } from './lib/state.mjs';
import { verifyHermesIdentity } from './lib/checks.mjs';
import { createLogger } from './lib/log.mjs';
import { wipeLocalArtifacts } from './retain.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const FLAGS = Object.freeze(['--backfill', '--purge', '--disable']);

export function parseArgs(argv) {
  const [name, ...rest] = argv;
  if (!name || !CONNECTOR_NAMES.includes(name)) {
    throw new Error(
      `usage: node run.mjs <source> [--backfill|--purge|--disable]; sources: ${CONNECTOR_NAMES.join(', ')}`
    );
  }
  const flags = new Set();
  for (const arg of rest) {
    if (!FLAGS.includes(arg)) throw new Error(`unknown flag ${JSON.stringify(arg)}; flags: ${FLAGS.join(', ')}`);
    flags.add(arg);
  }
  if (flags.size > 1) throw new Error('flags are mutually exclusive: run two invocations');
  return { name, flag: [...flags][0] ?? null };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let state;
  let log;
  try {
    const { name, flag } = parseArgs(process.argv.slice(2));
    log = createLogger();
    state = openStateDb();
    const cacheDir = defaultCacheDir();
    const config = loadConfig();
    const ingestOpts = {
      baseUrl: process.env.HAZLIE_HERMES_URL ?? config.hermesUrl ?? DEFAULT_HERMES_BASE_URL,
      tokenFile: defaultHermesTokenPath(),
    };

    // Same identity gate the daemon's preflight runs, against the same base
    // ingest will use. Liveness is not enough: on this Mac the default port
    // is held by an unrelated dev server that answers 200 on /health, and a
    // hand-run without HAZLIE_HERMES_URL once POSTed a corpus row at it (it
    // 404'd — but only because that server happens to have no /ingest).
    // --disable writes a local marker and never touches hermes, so it must
    // keep working while hermes is down.
    if (flag !== '--disable') {
      const identity = await verifyHermesIdentity(ingestOpts.baseUrl);
      if (!identity.ok) {
        throw new Error(`refusing to run against ${ingestOpts.baseUrl}: ${identity.detail}\n  fix: ${identity.fix}`);
      }
    }

    if (flag === '--disable') {
      const marker = disableMarkerPath(name);
      const previousUmask = process.umask(0o077);
      try {
        closeSync(openSync(marker, 'a', 0o600));
      } finally {
        process.umask(previousUmask);
      }
      log.info('source_disabled_marker', { connector: name });
      console.log(JSON.stringify({ disabled: name, marker, reenable: `rm ${marker}` }));
    } else if (flag === '--purge') {
      // Hermes first, local second: if the /admin/purge fails, the cursors
      // survive and nothing is forgotten locally about data hermes still
      // holds. contacts maps to no hermes source (resolution state only) —
      // its purge is entirely local.
      const hermesSource = CONNECTOR_HERMES_SOURCE[name];
      const purged =
        hermesSource === null ? { deleted: 0, maintained: false } : await adminPurge({ source: hermesSource }, ingestOpts);
      const local = wipeLocalArtifacts(name, { state, cacheDir, log });
      console.log(JSON.stringify({ connector: name, hermesSource, ...purged, ...local }));
    } else {
      // A plain or --backfill run needs the source module, which lands in
      // Phase 4. Refusing loudly beats pretending an empty pass succeeded.
      const sources = await loadSources(join(here, 'sources'));
      const source = sources.find((s) => s.name === name);
      if (!source) {
        throw new Error(`sources/${name}.mjs does not exist yet (Phase 4); nothing to run`);
      }
      if (existsSync(disableMarkerPath(name))) {
        throw new Error(`${name} is disabled (${disableMarkerPath(name)}); remove the marker first`);
      }
      // needs() must see config: calendar's Google backend has prerequisites
      // the local one does not, and which set applies is a config question.
      const missing = await source.needs({ config });
      if (Array.isArray(missing) && missing.length > 0) {
        throw new Error(`${name} is not ready: ${missing.join('; ')}`);
      }
      const startedTs = Date.now();
      const ctx = {
        state,
        ingest: (rows) => ingest(rows, ingestOpts),
        admin: {
          retain: (args) => adminRetain(args, ingestOpts),
          purge: (args) => adminPurge(args, ingestOpts),
          deleteEntities: (args) => adminDeleteEntities(args, ingestOpts),
          maintain: () => adminMaintain(ingestOpts),
          entities: (args) => adminEntities(args, ingestOpts),
        },
        config,
        cacheDir,
        log,
        now: Date.now,
        backfill: flag === '--backfill',
      };
      const raw = (await source.run(ctx)) ?? {};
      state.recordRun({
        connector: name,
        startedTs,
        finishedTs: Date.now(),
        ok: true,
        ...runCounts(raw),
      });
      // The printed line keeps the source's own extra fields — `remaining`,
      // `capped`, `withContent`, `skipped` — which are the whole point of
      // running one connector by hand. runCounts only settles the four the
      // run log stores.
      console.log(JSON.stringify({ connector: name, backfill: flag === '--backfill', ...raw, ...runCounts(raw) }));
    }
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  } finally {
    state?.close();
    log?.close();
  }
}
