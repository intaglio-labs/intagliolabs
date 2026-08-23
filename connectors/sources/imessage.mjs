// The iMessage connector: chat.db → hermes.
//
// Reads a `backup()` SNAPSHOT, never the live store — the read-mode decision
// in ops/PROBES.md: ~2 s per snapshot against a ~1 GB chat.db is a ~1.7 % duty
// cycle for a ~2 min bulk scan, and the scan then reads a frozen, private,
// pressure-free 0600 copy that is deleted afterwards. (The courier's 2 s poll
// loop uses a persistent read-only connection instead; a snapshot per poll
// would write ~43 GB/day.)
//
// FULL DISK ACCESS: chat.db is TCC territory and macOS attributes the grant to
// the RESPONSIBLE process, so this must run under launchd with the stable
// ~/.hazlie/bin/node. A run from a dev shell is denied, and that denial says
// nothing about whether the production grant exists.
//
// LOG POLICY (connectors/AGENTS.md): counts and cursors only — never message
// text, never a handle, never a chat identifier.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotStore } from '../lib/storeReader.mjs';
import { messagesToRows } from '../lib/imessageRows.mjs';
import { pinnedThreadGuids } from '../lib/pinnedThread.mjs';

const DEFAULT_BACKFILL_DAYS = 90;
// Bounds a first run against a 633k-message store. The cursor advances, so the
// remainder arrives on subsequent passes rather than being lost.
const MAX_MESSAGES_PER_SCAN = 5000;
const CURSOR_KEY = 'imessage:max-date';

export function chatDbPath(home) {
  return join(home, 'Library', 'Messages', 'chat.db');
}

// Exported for the test. The cursor is a message.date in Apple nanoseconds,
// stored as a string because it exceeds 2^53 and must not round-trip through
// a JS number.
export function scanFloor({ storedCursor, backfill, nowMs, backfillDays }) {
  if (!backfill && typeof storedCursor === 'string' && /^\d+$/u.test(storedCursor)) {
    return { appleNanos: BigInt(storedCursor), reason: 'cursor' };
  }
  const floorMs = nowMs - backfillDays * 86_400_000;
  const APPLE_EPOCH_MS = 978307200000;
  return {
    appleNanos: BigInt(Math.round((floorMs - APPLE_EPOCH_MS) * 1e6)),
    reason: backfill ? 'backfill' : 'no-cursor',
  };
}

export function createImessageSource({ home } = {}) {
  return {
    name: 'imessage',

    // Like calendar's: readability is deliberately NOT pre-checked, because
    // FDA attributes per spawner and a needs()-time stat can pass where the
    // run's open would be denied. The run is the honest probe.
    needs() {
      return [];
    },

    async run(ctx) {
      const resolvedHome = home ?? ctx.home ?? (await import('node:os')).homedir();
      const cacheDir = join(ctx.cacheDir, 'imessage');
      const srcPath = chatDbPath(resolvedHome);
      // snapshotStore(srcPath, cacheDir) returns the snapshot path directly.
      // Attempting the snapshot IS the readability test: under TCC even stat
      // can lie about what a later open will be allowed to do.
      const snapshotPath = await snapshotStore(srcPath, cacheDir);

      let rows = [];
      let skipped = 0;
      let maxDate = null;
      let db;
      try {
        db = new DatabaseSync(snapshotPath, { readOnly: true });
        const floor = scanFloor({
          storedCursor: ctx.state.getCursor(CURSOR_KEY),
          backfill: Boolean(ctx.backfill),
          nowMs: ctx.now(),
          backfillDays: ctx.config?.imessage?.backfillDays ?? DEFAULT_BACKFILL_DAYS,
        });

        // handle.id and the chat guid are joined here rather than looked up
        // per row: 633k messages make a per-row query a per-row round trip.
        const stmt = db.prepare(
          `SELECT m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody,
                  m.date AS date, m.is_from_me AS is_from_me, m.service AS service,
                  m.item_type AS item_type, m.associated_message_type AS associated_message_type,
                  m.reply_to_guid AS reply_to_guid,
                  h.id AS handle_id_value, c.guid AS chat_guid
           FROM message m
           LEFT JOIN handle h ON h.ROWID = m.handle_id
           LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           LEFT JOIN chat c ON c.ROWID = cmj.chat_id
           WHERE m.date > ?
           ORDER BY m.date ASC
           LIMIT ?`
        );
        // message.date exceeds 2^53; without this the statement throws rather
        // than silently truncating, which is the behaviour we want.
        stmt.setReadBigInts(true);
        const dbRows = stmt.all(floor.appleNanos, BigInt(MAX_MESSAGES_PER_SCAN));

        for (const r of dbRows) {
          if (maxDate === null || r.date > maxDate) maxDate = r.date;
        }
        // Resolved per run rather than at module load, a habit kept from when
        // the courier could re-pin the thread while the daemon was up. The
        // courier's send/listen lanes are retired (2026-08-21) but any config
        // left on disk still names a thread that must stay excluded.
        const excludeChatGuids = pinnedThreadGuids({ home: resolvedHome });

        ({ rows, skipped } = messagesToRows(
          dbRows.map((r) => ({ ...r, date: r.date, is_from_me: Number(r.is_from_me) })),
          { selfName: ctx.config?.selfName ?? 'me', excludeChatGuids }
        ));

        ctx.log.info('imessage_scan', {
          connector: 'imessage',
          backfill: Boolean(ctx.backfill),
          floorReason: floor.reason,
          examined: dbRows.length,
          rows: rows.length,
          skipped,
          // A COUNT, never the guid: connectors/AGENTS.md forbids logging a
          // chat identifier, and 0 vs 1 is the whole diagnostic anyway.
          excludedThreads: excludeChatGuids.length,
          capped: dbRows.length >= MAX_MESSAGES_PER_SCAN,
        });
      } finally {
        try {
          db?.close();
        } catch {}
        // A lingering ~1 GB copy of every conversation in the cache dir is a
        // liability, not a cache.
        rmSync(snapshotPath, { force: true });
      }

      const totals = rows.length > 0 ? await ingestAll(ctx, rows) : { inserted: 0, updated: 0, unchanged: 0 };

      // The cursor advances ONLY after the batch is safely in hermes. Written
      // first, an ingest failure would be skipped permanently and invisibly.
      if (maxDate !== null) ctx.state.setCursor(CURSOR_KEY, String(maxDate));
      return { ...totals, skipped };
    },
  };
}

// Batched so one 5000-row scan is not a single enormous request body.
async function ingestAll(ctx, rows, batchSize = 500) {
  const totals = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += batchSize) {
    const t = await ctx.ingest(rows.slice(i, i + batchSize));
    totals.inserted += t.inserted ?? t.ingested ?? 0;
    totals.updated += t.updated ?? 0;
    totals.unchanged += t.unchanged ?? 0;
  }
  return totals;
}

export default createImessageSource();
