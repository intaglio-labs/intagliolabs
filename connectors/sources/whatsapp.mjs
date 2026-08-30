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

import { rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotStore } from '../lib/storeReader.mjs';
import { messagesToRows } from '../lib/whatsappRows.mjs';

const CURSOR_KEY = 'whatsapp:max-date';
const APPLE_EPOCH_MS = 978307200000;
const yearlyCursorKey = (year) => `whatsapp:history-year:${year}:max-date`;
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

export function scanFloor({ storedCursor, backfill, nowMs = Date.now() }) {
  if (!backfill && typeof storedCursor === 'string' && /^-?\d+(\.\d+)?$/u.test(storedCursor)) {
    return { seconds: Number(storedCursor), reason: 'cursor' };
  }
  if (backfill) return { seconds: -Infinity, reason: 'backfill' };
  // A fresh install must not leak old years into the graph before the shared
  // year barrier reaches them. The history lane below owns 2026, then 2025,
  // and so on across platforms; the forward lane starts at local New Year.
  return {
    seconds: (new Date(new Date(nowMs).getFullYear(), 0, 1).getTime() - APPLE_EPOCH_MS) / 1000 - 1,
    reason: 'current-year',
  };
}

export function createWhatsappSource({ home } = {}) {
  return {
    name: 'whatsapp',
    walksHistory: true,

    // Provisioned? The store belongs to WhatsApp Desktop. If it is not there,
    // there is nothing to read yet -- an unprovisioned source, not a broken one.
    //
    // This used to return [] unconditionally, on the reasoning that "the store
    // exists once WhatsApp Desktop has run at least once". That premise is
    // false, and the machine it was written for disproves it: WhatsApp is
    // installed, its group container is populated, and ChatStorage.sqlite is
    // simply absent -- the app was re-linked, which wipes the message store, and
    // has not re-synced. So the connector failed 459 consecutive times over six
    // days. snapshotStore() stats the source first (lib/storeReader.mjs), the
    // ENOENT escaped run()'s catch-less try/finally, and the daemon recorded
    // ok:false every fifteen minutes forever. An app that has nothing to give
    // yet is not a fault to alarm about.
    //
    // ENOENT ONLY, and that is deliberately not existsSync. Every other gate in
    // the roster (granola, notion, oura, calendar) stats a file THIS repo writes
    // under ~/.hazlie/secrets, where collapsing "absent" and "denied" into one
    // boolean costs nothing. This path is a third party's, inside a group
    // container, and the rule every local-store source states -- readability is
    // the run's job, because FDA attributes per spawner -- has to survive. A
    // denial (EPERM/EACCES, checks.mjs DENIED_CODES) therefore falls through to
    // the run, which is still the honest probe and still fails loudly. Same
    // split realReadSqlite already makes: ENOENT is missing, EPERM is denied,
    // and they are not one fact. existsSync would report a TCC denial as "not
    // installed", turning a loud failure into a silent one.
    //
    // FRESHNESS IS NOT THIS GATE'S BUSINESS. A present-but-frozen store passes,
    // so run() still reports the newest message's age and the watchdog can still
    // say "open whatsapp on your mac so it can sync". That sentence is for a
    // store that EXISTS and has stopped moving; this one is for a store that is
    // not there at all. Keeping the two apart is the whole point of the header.
    needs() {
      const store = chatStoragePath(home ?? homedir());
      try {
        statSync(store);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return [
            `whatsapp desktop store missing at ${store}: install WhatsApp Desktop ` +
              "and link it to your phone (the connect page's WhatsApp panel has the steps)",
          ];
        }
      }
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
      let tieFinished = false;
      let historyDone = false;
      let historyHasOlder = true;
      try {
        // The snapshot attempt IS the readability test.
        snapshotPath = await snapshotStore(srcPath, cacheDir);
        db = new DatabaseSync(snapshotPath, { readOnly: true });

        const yearly = ctx.history === true && ctx.historyWindow?.year
          ? {
              year: ctx.historyWindow.year,
              fromSeconds: (ctx.historyWindow.fromTs - APPLE_EPOCH_MS) / 1000,
              toSeconds: (ctx.historyWindow.toTs - APPLE_EPOCH_MS) / 1000,
            }
          : null;
        const floor = yearly
          ? {
              seconds: Number(
                ctx.state.getCursor(yearlyCursorKey(yearly.year))
                  ?? (yearly.fromSeconds - 1)
              ),
              reason: 'yearly-history',
            }
          : scanFloor({
              storedCursor: ctx.state.getCursor(CURSOR_KEY),
              backfill: Boolean(ctx.backfill),
              nowMs: ctx.now(),
            });

        // Message joined to its session for the JID and partner name. Group
        // sender is resolved separately (memberFor) to keep the mapper pure.
        const messageSelect = `SELECT m.Z_PK, m.ZTEXT, m.ZISFROMME, m.ZMESSAGEDATE, m.ZFROMJID, m.ZSTANZAID,
                  m.ZMESSAGETYPE, m.ZGROUPEVENTTYPE, m.ZGROUPMEMBER,
                  s.ZCONTACTJID AS chat_jid, s.ZPARTNERNAME AS chat_name
           FROM ZWAMESSAGE m
           JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION`;
        const stmt = db.prepare(yearly
          ? `${messageSelect}
             WHERE m.ZMESSAGEDATE > ? AND m.ZMESSAGEDATE >= ? AND m.ZMESSAGEDATE < ?
             ORDER BY m.ZMESSAGEDATE ASC
             LIMIT ?`
          : `${messageSelect}
             WHERE m.ZMESSAGEDATE > ?
             ORDER BY m.ZMESSAGEDATE ASC
             LIMIT ?`);
        const floorSec = Number.isFinite(floor.seconds) ? floor.seconds : -1e12;
        let dbRows = yearly
          ? stmt.all(floorSec, yearly.fromSeconds, yearly.toSeconds, MAX_MESSAGES_PER_SCAN)
          : stmt.all(floorSec, MAX_MESSAGES_PER_SCAN);
        capped = dbRows.length >= MAX_MESSAGES_PER_SCAN;

        // A tie wider than the whole batch: the one-second rewind below would
        // re-select this identical batch forever — the livelock files.mjs's
        // nextFileCursor steps past (accepting the loss). Whole seconds keep
        // the tie span bounded, so here the escape is to finish the second
        // instead: refetch it with no cap so every tied row lands this pass,
        // and let the cursor advance past it.
        if (capped && dbRows[0].ZMESSAGEDATE === dbRows[dbRows.length - 1].ZMESSAGEDATE) {
          dbRows = db
            .prepare(`${messageSelect} WHERE m.ZMESSAGEDATE = ? ORDER BY m.Z_PK ASC`)
            .all(dbRows[0].ZMESSAGEDATE);
          tieFinished = true;
        }

        for (const r of dbRows) {
          if (maxDate === null || r.ZMESSAGEDATE > maxDate) maxDate = r.ZMESSAGEDATE;
        }
        if (yearly) {
          const continuation = maxDate ?? floorSec;
          historyDone = db.prepare(
            'SELECT 1 AS found FROM ZWAMESSAGE WHERE ZMESSAGEDATE > ? AND ZMESSAGEDATE < ? LIMIT 1'
          ).get(continuation, yearly.toSeconds) === undefined;
          historyHasOlder = db.prepare(
            'SELECT 1 AS found FROM ZWAMESSAGE WHERE ZMESSAGEDATE < ? LIMIT 1'
          ).get(yearly.fromSeconds) !== undefined;
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
              : Math.floor((ctx.now() - (newestSeen * 1000 + APPLE_EPOCH_MS)) / 86_400_000),
          ...(yearly ? { historyYear: yearly.year } : {}),
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
      // files.mjs (nextFileCursor) makes for its mtime cursor. The exception
      // is a batch-wide tie: the refetch above already delivered the whole
      // boundary second, so the cursor moves past it — rewinding there would
      // re-select the same batch forever.
      if (maxDate !== null) {
        const cursor = String(capped && !tieFinished ? maxDate - 1 : maxDate);
        if (ctx.history === true && ctx.historyWindow?.year) {
          ctx.state.setCursor(yearlyCursorKey(ctx.historyWindow.year), cursor);
        } else {
          ctx.state.setCursor(CURSOR_KEY, cursor);
        }
      }
      return {
        ...totals,
        skipped,
        ...(ctx.history === true && ctx.historyWindow?.year ? {
          historyDone,
          historyHasOlder,
          // A page of media/system rows can produce no corpus rows while its
          // durable timestamp cursor still advances. Tell the daemon to keep
          // draining instead of mistaking that safe progress for a stall.
          historyProgressed: maxDate !== null || historyDone,
        } : {}),
      };
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
