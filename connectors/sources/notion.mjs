// The notion connector: pages the owner shared with the integration → hermes.
//
//   entity notion:<page_id>    title + the page's text blocks
//
// CONSENT IS PER-PAGE AND NOTION ENFORCES IT. An internal integration starts
// with access to nothing; the owner shares individual pages or databases with
// it. So an empty run is the normal first outcome and is reported as such —
// `sharedWithIntegration: 0` means "nothing shared yet", not "connector
// broken", and those two must never look the same in a log.
//
// CURSOR: last_edited_time. /search returns newest-edited first, so the scan
// stops at the first page at or below the cursor instead of paging to the end
// of the workspace every 15 minutes.
//
// NESTED BLOCKS ARE NOT FOLLOWED (yet). Toggles and columns hold their text
// in children one level down, so their contents are missing from these rows.
// That is a real gap, recorded in meta as blocks:<n> and here in writing,
// rather than papered over — following children means a request per container
// and a recursion bound, and it should be measured before it is built.
//
// LOG POLICY: counts and ids only. Never a page title — a title is corpus
// content, and Notion titles are frequently the most sensitive line on a page.

import { existsSync } from 'node:fs';
import { createNotionClient, defaultNotionKeyPath, MAX_PAGE_SIZE } from '../lib/notionClient.mjs';
import { notionToRow } from '../lib/notionRows.mjs';

const CURSOR_KEY = 'notion:last-edited';
const MAX_PAGES_PER_SCAN = 200;
// One request per 100 blocks. A very long page is truncated at the row level
// anyway (notionRows maxChars), so paging its blocks forever buys nothing.
const MAX_BLOCK_PAGES = 5;

export function scanFloorMs({ storedCursor, backfill }) {
  if (!backfill && typeof storedCursor === 'string') {
    const parsed = Date.parse(storedCursor);
    if (Number.isFinite(parsed)) return { ms: parsed, reason: 'cursor' };
  }
  return { ms: -Infinity, reason: backfill ? 'backfill' : 'no-cursor' };
}

export function createNotionSource({ client, keyPath } = {}) {
  return {
    name: 'notion',

    // Returns what is MISSING, so [] means ready. existsSync only: the full
    // owner-only gauntlet runs at read time in the client, and needs()
    // answers "provisioned?", not "valid?" — the same split granola makes.
    needs() {
      const file = keyPath ?? defaultNotionKeyPath();
      return existsSync(file)
        ? []
        : [`notion integration token missing: put it at ${file} (0600, dir 0700)`];
    },

    async run(ctx) {
      const api = client ?? createNotionClient({ keyPath: keyPath ?? defaultNotionKeyPath() });
      const floor = scanFloorMs({
        storedCursor: ctx.state.getCursor(CURSOR_KEY),
        backfill: Boolean(ctx.backfill),
      });

      const rows = [];
      let examined = 0;
      let skipped = 0;
      let newestSeen = null;
      // What was actually DELIVERED, as opposed to merely looked at. The
      // cursor is a promise ("everything newer than this is in hermes"), and
      // only these two can honour it.
      let newestDelivered = null;
      let oldestDelivered = null;
      let capped = false;
      let cursor = null;
      let stoppedAtCursor = false;

      outer: for (let page = 0; page < Math.ceil(MAX_PAGES_PER_SCAN / MAX_PAGE_SIZE) + 1; page += 1) {
        const res = await api.search({ startCursor: cursor });
        const results = Array.isArray(res?.results) ? res.results : [];
        if (results.length === 0) break;

        for (const item of results) {
          examined += 1;
          const edited = Date.parse(item?.last_edited_time ?? '');
          if (Number.isFinite(edited) && (newestSeen === null || edited > newestSeen)) {
            newestSeen = edited;
          }
          // Descending order: the first page at or below the floor means every
          // page after it is too, so stop rather than paging the workspace.
          if (Number.isFinite(edited) && edited <= floor.ms) {
            stoppedAtCursor = true;
            break outer;
          }
          if (rows.length >= MAX_PAGES_PER_SCAN) {
            capped = true;
            break outer;
          }

          const blocks = await readBlocks(api, item?.id, ctx);
          const row = notionToRow(item, blocks);
          if (row === null) skipped += 1;
          else {
            rows.push(row);
            if (Number.isFinite(edited)) {
              if (newestDelivered === null || edited > newestDelivered) newestDelivered = edited;
              if (oldestDelivered === null || edited < oldestDelivered) oldestDelivered = edited;
            }
          }
        }

        if (!res?.has_more || !res?.next_cursor) break;
        cursor = res.next_cursor;
      }

      ctx.log.info('notion_scan', {
        connector: 'notion',
        backfill: Boolean(ctx.backfill),
        floorReason: floor.reason,
        // Distinguishes "you have not shared anything with the integration"
        // from "nothing changed since last run". They look identical in a
        // row count and mean completely different things.
        sharedWithIntegration: examined,
        examined,
        rows: rows.length,
        skipped,
        stoppedAtCursor,
        // Loud on purpose: a capped scan means pages were left behind, and
        // until a descending backfill exists nothing else will report it.
        capped,
      });
      if (capped) {
        ctx.log.warn('notion_scan_capped', {
          connector: 'notion',
          delivered: rows.length,
          cap: MAX_PAGES_PER_SCAN,
          note: 'pages older than the oldest delivered page are not reachable by a forward scan',
        });
      }

      const totals =
        rows.length > 0 ? await ingestAll(ctx, rows) : { inserted: 0, updated: 0, unchanged: 0 };

      // THE CURSOR MAY NOT CLAIM MORE THAN WAS DELIVERED.
      //
      // It used to advance to `newestSeen`, and in a DESCENDING scan the first
      // item examined is the newest page in the workspace — so a first scan of
      // 500 shared pages delivered 200 and then moved the floor to the newest
      // one anyway. Every page past the cap fell below the floor on the next
      // run, `stoppedAtCursor` fired immediately, and those 300 pages were
      // never ingested. Silently, permanently, and reported as a clean scan.
      //
      // A capped scan has delivered exactly the pages newer than its oldest
      // delivered one, so that is the only honest high-water mark. An
      // uncapped scan reached the floor and really did deliver everything
      // above it, so `newestSeen` is right there.
      //
      // WHAT THIS DOES NOT FIX, said plainly rather than left to be
      // rediscovered: a forward-only cursor cannot walk BACKWARDS. The pages
      // below the cap stay unreached by ordinary runs, and `--backfill` does
      // not help because the cap applies there too. Clearing that tail needs a
      // second, descending cursor and a scan that resumes from it. The change
      // here converts silent permanent loss into a loud, visible shortfall,
      // which is the half that was dangerous.
      const advanceTo = capped ? oldestDelivered : newestSeen;
      if (advanceTo !== null) ctx.state.setCursor(CURSOR_KEY, new Date(advanceTo).toISOString());
      return { ...totals, examined, skipped };
    },
  };
}

async function readBlocks(api, blockId, ctx) {
  if (typeof blockId !== 'string' || !blockId) return [];
  const out = [];
  let cursor = null;
  for (let i = 0; i < MAX_BLOCK_PAGES; i += 1) {
    let res;
    try {
      res = await api.blockChildren(blockId, { startCursor: cursor });
    } catch (err) {
      // A single unreadable page (deleted mid-scan, or shared then unshared)
      // must not fail a run of 200. The id is safe to log; the title is not.
      ctx.log.info('notion_block_read_failed', {
        connector: 'notion',
        block_id: blockId,
        status: err?.status ?? null,
        code: err?.code ?? '',
      });
      break;
    }
    if (Array.isArray(res?.results)) out.push(...res.results);
    if (!res?.has_more || !res?.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
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

export default createNotionSource();
