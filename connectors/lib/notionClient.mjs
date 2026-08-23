// Notion API v1 client. Outbound HTTPS to api.notion.com and nowhere else.
//
// AUTH is an internal integration token (`ntn_…`), created by the owner at
// notion.so/my-integrations and stored as an owner-only file. Notion's
// integrations see NOTHING by default: each page or database must be shared
// with the integration explicitly. That is a better consent story than a
// broad OAuth scope, and it means an empty first run is the expected
// outcome, not a failure — the connector says so rather than looking broken.
//
// VERSION PINNING is mandatory: the Notion-Version header selects the schema,
// and omitting it is an error, not a default. Pinned here so a server-side
// release cannot silently change the response shape under a running daemon.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSecretLine } from './secrets.mjs';

export const NOTION_BASE_URL = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
// Notion documents ~3 requests/second average. A page's content costs one
// request per 100 blocks, so a page-heavy run hits this quickly.
export const MIN_REQUEST_INTERVAL_MS = 350;
export const MAX_PAGE_SIZE = 100;

// Retries for a 429 before giving up and letting the next poll try again.
// Small on purpose: the cursor is unchanged, so a skipped cycle costs only a
// delay, while an unbounded retry costs the connector entirely.
export const MAX_RATE_LIMIT_RETRIES = 5;

export function defaultNotionKeyPath(home = homedir()) {
  return join(home, '.hazlie', 'secrets', 'notion-api-key.txt');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createNotionClient({
  keyPath = defaultNotionKeyPath(),
  baseUrl = NOTION_BASE_URL,
  fetchImpl = globalThis.fetch,
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
  now = () => Date.now(),
  sleepImpl = sleep,
} = {}) {
  let lastAt = 0;

  async function request(path, { method = 'GET', body = null, attempt = 0 } = {}) {
    const wait = minIntervalMs - (now() - lastAt);
    if (wait > 0) await sleepImpl(wait);
    lastAt = now();

    // Read at use time, never cached across calls — lib/secrets.mjs replays
    // the full owner-only check on every read, and caching would defeat it.
    const token = readSecretLine(keyPath, {
      label: 'Notion integration token',
      setupHint: 'see ops/CONNECTORS.md — notion',
    });

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': NOTION_VERSION,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 429) {
      // BOUNDED. This recursed with no ceiling, so a workspace that stayed
      // rate-limited retried at roughly one request per second forever: the
      // source never returned, so its timer never rescheduled, so the notion
      // connector stopped for good — while looking busy rather than broken.
      // An unbounded retry inside a resident poller is not resilience, it is a
      // hang with a progress indicator.
      //
      // Giving up is safe here in a way it would not be for a write: the next
      // scheduled poll starts again from the same cursor, so the only cost of
      // failing now is one skipped cycle.
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        const err = new Error(
          `notion ${method} ${path}: still rate limited after ${MAX_RATE_LIMIT_RETRIES} retries`
        );
        err.status = 429;
        err.code = 'rate_limited';
        throw err;
      }
      const retry = Number(res.headers?.get?.('retry-after') ?? 1);
      await sleepImpl(Math.min(Number.isFinite(retry) ? retry * 1000 : 1000, 60_000));
      return request(path, { method, body, attempt: attempt + 1 });
    }
    if (!res.ok) {
      // The body can carry the token back in an error echo, and it can carry
      // page titles. Neither belongs in a log line, so only the status and
      // Notion's own error code cross this boundary.
      let code = '';
      try {
        code = String((await res.json())?.code ?? '');
      } catch {
        code = '';
      }
      const err = new Error(`notion ${method} ${path}: HTTP ${res.status}${code ? ` (${code})` : ''}`);
      err.status = res.status;
      err.code = code;
      throw err;
    }
    return res.json();
  }

  return {
    // Pages and databases the integration has been given access to, newest
    // edit first so a cursor can stop early.
    async search({ startCursor = null, pageSize = MAX_PAGE_SIZE } = {}) {
      return request('/search', {
        method: 'POST',
        body: {
          page_size: pageSize,
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          ...(startCursor ? { start_cursor: startCursor } : {}),
        },
      });
    },

    async blockChildren(blockId, { startCursor = null, pageSize = MAX_PAGE_SIZE } = {}) {
      const q = new URLSearchParams({ page_size: String(pageSize) });
      if (startCursor) q.set('start_cursor', startCursor);
      return request(`/blocks/${blockId}/children?${q}`);
    },

    // Cheap auth probe for doctor: succeeds or throws with a status.
    async whoami() {
      return request('/users/me');
    },
  };
}
