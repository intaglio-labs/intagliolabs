// The WhatsApp connector: WhatsApp Desktop's local store → hermes.
//
// LANE 0 of SOCIAL-BRIDGES-PLAN.md, and the reason it exists: WhatsApp
// Desktop, linked to the phone, persists every message to a plaintext SQLite
// store under its group container. So continuous WhatsApp needs no bridge and
// no reverse-engineered protocol — the phone syncs, the desktop app writes the
// file, and this reads it. It is the chat.db pattern a third time (iMessage,
// then contacts, now this): snapshot under launchd because the store is FDA
// territory, read a frozen copy, delete it after.
//
//   entity whatsapp:<stanza_id>   one text message
//
// THE ONE HONEST BOUND: the store is only as fresh as the last time WhatsApp
// Desktop ran. The phone is the source of truth; the desktop app is a linked
// device that syncs while open. So a quiet connector can mean "nothing new"
// OR "the app has not run in a while", and the two must not look identical —
// the run reports the newest message's age so the watchdog can say "open
// WhatsApp" rather than reporting breakage. Recorded in ops/PROBES.md too.
//
// EXCLUDED FROM CLAIMS AND THE EPISODIC SHELF by default (select.mjs): this is
// third-party message text, exactly like mail and received iMessage. The graph
// joins read it as names, handles and counts; the model never reads the words.
//
// LOG POLICY (connectors/AGENTS.md): counts and cursors only — never message
// text, never a JID, never a contact name.

import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotStore } from '../lib/storeReader.mjs';
import { messagesToRows } from '../lib/whatsappRows.mjs';

const CURSOR_KEY = 'whatsapp:max-date';
// Apple-epoch seconds; the connector stores the cursor as the raw seconds
// string, same idea as iMessage's nanosecond cursor.
const MAX_MESSAGES_PER_SCAN = 5000;

export function chatStoragePath(home) {
  return join(
    home,
    'Library',
    'Group Containers',
    'group.net.whatsapp.WhatsApp.shared',
    'ChatStorage.sqlite'
  );
}

export function scanFloor({ storedCursor, backfill }) {
  if (!backfill && typeof storedCursor === 'string' && /^-?\d+(\.\d+)?$/u.test(storedCursor)) {
    return { seconds: Number(storedCursor), reason: 'cursor' };
  }
  // No date floor on a full read — the store holds at most a few years and a
  // few thousand rows, nothing like chat.db's 633k. Backfill re-reads all.
  return { seconds: -Infinity, reason: backfill ? 'backfill' : 'no-cursor' };
}

export function createWhatsappSource({ home } = {}) {
  return {
    name: 'whatsapp',

    // Readability is the honest probe, not a pre-check: FDA attributes per
    // spawner (the iMessage rule). needs() answers "provisioned?" — the store
    // exists once WhatsApp Desktop has run at least once.
    needs() {
      return [];
    },

    async run(ctx) {
      const resolvedHome = home ?? ctx.home ?? homedir();
      const cacheDir = join(ctx.cacheDir, 'whatsapp');
      const srcPath = chatStoragePath(resolvedHome);

      let snapshotPath = null;
      let db = null;
      let rows = [];
      let skipped = 0;
      let maxDate = null;
      let newestSeen = null;
      let capped = false;
      try {
        // The snapshot attempt IS the readability test.
        snapshotPath = await snapshotStore(srcPath, cacheDir);
        db = new DatabaseSync(snapshotPath, { readOnly: true });

        const floor = scanFloor({
          storedCursor: ctx.state.getCursor(CURSOR_KEY),
          backfill: Boolean(ctx.backfill),
        });

        // Message joined to its session for the JID and partner name. Group
        // sender is resolved separately (memberFor) to keep the mapper pure.
        const stmt = db.prepare(
          `SELECT m.Z_PK, m.ZTEXT, m.ZISFROMME, m.ZMESSAGEDATE, m.ZFROMJID, m.ZSTANZAID,
                  m.ZMESSAGETYPE, m.ZGROUPEVENTTYPE, m.ZGROUPMEMBER,
                  s.ZCONTACTJID AS chat_jid, s.ZPARTNERNAME AS chat_name
           FROM ZWAMESSAGE m
           JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
           WHERE m.ZMESSAGEDATE > ?
           ORDER BY m.ZMESSAGEDATE ASC
           LIMIT ?`
        );
        const floorSec = Number.isFinite(floor.seconds) ? floor.seconds : -1e12;
        const dbRows = stmt.all(floorSec, MAX_MESSAGES_PER_SCAN);
        capped = dbRows.length >= MAX_MESSAGES_PER_SCAN;

        for (const r of dbRows) {
          if (maxDate === null || r.ZMESSAGEDATE > maxDate) maxDate = r.ZMESSAGEDATE;
        }
        // Newest message in the WHOLE store, for the freshness report — not
        // just this batch, so "how stale is the app" is answerable even on a
        // no-op scan.
        newestSeen = db.prepare('SELECT MAX(ZMESSAGEDATE) d FROM ZWAMESSAGE').get()?.d ?? null;

        // Group member resolver: one prepared lookup, memoized within the scan.
        const memberStmt = db.prepare(
          'SELECT ZMEMBERJID AS jid, ZCONTACTNAME AS name, ZFIRSTNAME AS first FROM ZWAGROUPMEMBER WHERE Z_PK = ?'
        );
        const memberCache = new Map();
        const memberFor = (pk) => {
          if (memberCache.has(pk)) return memberCache.get(pk);
          const r = memberStmt.get(pk);
          const m = r ? { jid: r.jid, name: r.name || r.first || null } : null;
          memberCache.set(pk, m);
          return m;
        };

        ({ rows, skipped } = messagesToRows(dbRows, {
          selfName: ctx.config?.selfName ?? 'me',
          memberFor,
        }));

        ctx.log.info('whatsapp_scan', {
          connector: 'whatsapp',
          backfill: Boolean(ctx.backfill),
          floorReason: floor.reason,
          examined: dbRows.length,
          rows: rows.length,
          skipped,
          capped,
          // Days since the newest message anywhere in the store. The one signal
          // that separates "quiet" from "the app has not synced" — a count, not
          // a date, so no identifier leaks.
          storeAgeDays:
            newestSeen === null
              ? null
              : Math.floor((ctx.now() - (newestSeen * 1000 + 978307200000)) / 86_400_000),
        });
      } finally {
        try {
          db?.close();
        } catch {}
        if (snapshotPath) rmSync(snapshotPath, { force: true });
      }

      const totals =
        rows.length > 0 ? await ingestAll(ctx, rows) : { inserted: 0, updated: 0, unchanged: 0 };
      // Cursor advances only after the batch is safely in hermes.
      //
      // ZMESSAGEDATE is whole seconds (ops/PROBES.md), so a capped scan can
      // cut a batch mid-second: rows tied at maxDate that fell past the LIMIT
      // would sit below the strict `>` forever. On a capped scan the cursor
      // rewinds one second so the boundary tie is re-offered next pass —
      // already-delivered rows come back as `unchanged`, which the upsert
      // makes cheap, and the ones that did not fit finally land. Same call
      // files.mjs (nextFileCursor) makes for its mtime cursor.
      if (maxDate !== null) ctx.state.setCursor(CURSOR_KEY, String(capped ? maxDate - 1 : maxDate));
      return { ...totals, skipped };
    },
  };
}

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

export default createWhatsappSource();
