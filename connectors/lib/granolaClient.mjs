// READ-ONLY client for Granola's official REST API (public-api.granola.ai).
// This is approved egress item 2 in ui/AGENTS.md: fetching back the owner's
// own notes over the documented REST endpoints — never the MCP query_* tools
// (they run inference server-side and are not approved), and never Granola's
// local cache (AES-encrypted with an entitlement-gated key; do not attempt).
//
// MEASURED response envelope — authenticated development probe,
// GET /v1/notes?page_size=1 → HTTP 200 (field names recorded from the real
// response, not guessed from docs):
//
//   {
//     notes:   [ { id, object, title, owner: { name, email },
//                  created_at, updated_at } ],
//     hasMore: boolean,
//     cursor:  string
//   }
//
// Pagination therefore follows `hasMore` and resumes by echoing `cursor`
// back as the `cursor` query parameter (the request-side parameter name
// mirrors the response field; only the response side was probed live).
// The list items carry NO summary — the caller must fetch GET /notes/{id}
// per note for summary_markdown, attendees, and the calendar event.
//
// Rate limits (API-documented): burst 25 requests / 5 s, sustained 5 req/s.
// The token bucket below paces at ≤4 req/s with a burst of 4 — inside both
// limits with headroom, so a well-behaved run should never see a 429; when
// one arrives anyway the Retry-After header is honored, never tight-retried.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSecretLine } from './secrets.mjs';

export const GRANOLA_BASE_URL = 'https://public-api.granola.ai/v1';

// The API's page_size ceiling; asking for more is a 4xx, not a bigger page.
export const MAX_PAGE_SIZE = 30;

export function defaultGranolaKeyPath(home = homedir()) {
  return join(home, '.hazlie', 'secrets', 'granola-api-key.txt');
}

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A real token bucket rather than a fixed inter-request delay, so a short
// burst (list page + a handful of detail fetches) goes out immediately and
// only a sustained stream is paced. now/sleep are injectable so tests can
// drive it with a fake clock instead of waiting wall-clock seconds.
export function createTokenBucket({
  capacity = 4,
  refillPerSec = 4,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  let tokens = capacity;
  let last = now();
  return {
    async take() {
      for (;;) {
        const t = now();
        tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
        last = t;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep(Math.ceil(((1 - tokens) / refillPerSec) * 1000));
      }
    },
  };
}

// Retry-After arrives as delta-seconds or an HTTP-date; anything unparseable
// falls back to the caller's default rather than a zero-wait tight loop.
export function parseRetryAfterMs(header, nowMs) {
  if (typeof header !== 'string' || header.length === 0) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return null;
}

// Cache every successful raw response body to disk (repo convention: "cache
// API responses to disk; these experiments get re-run"). The key is
// sha256(full URL including query params) so distinct pages and filters land
// in distinct files. tmp-file + rename keeps an interrupted write from ever
// leaving a torn cache file at the stable name; 0600-in-0700 is the standard
// household-private discipline. Error bodies are deliberately NOT cached —
// a 429/5xx body landing at the same key would overwrite a good snapshot of
// the real data with an error message.
function writeCache(cacheDir, href, body) {
  const previousUmask = process.umask(0o077);
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const mode = statSync(cacheDir).mode & 0o777;
    if (mode !== 0o700) {
      throw new Error(`granola cache directory must have mode 0700: ${cacheDir} is ${mode.toString(8)}`);
    }
    const dest = join(cacheDir, `${createHash('sha256').update(href).digest('hex')}.json`);
    const tmp = `${dest}.tmp-${process.pid}`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, dest);
    return dest;
  } finally {
    process.umask(previousUmask);
  }
}

const MAX_429_RETRIES = 3;

// cacheDir is REQUIRED and comes from the daemon's ctx (~/.hazlie/cache/…):
// this module must never invent a location, and above all never cache API
// bodies into the checkout.
export function createGranolaClient({
  keyFile = defaultGranolaKeyPath(),
  cacheDir,
  fetchImpl = fetch,
  now = Date.now,
  sleep = defaultSleep,
  timeoutMs = 30_000,
  baseUrl = GRANOLA_BASE_URL,
} = {}) {
  if (typeof cacheDir !== 'string' || cacheDir.length === 0) {
    throw new Error('createGranolaClient requires cacheDir (from ctx.cacheDir; never the checkout)');
  }
  const bucket = createTokenBucket({ now, sleep });

  async function request(path, params = {}) {
    const url = new URL(baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const href = url.toString();

    for (let attempt = 0; ; attempt += 1) {
      await bucket.take();
      // The key is re-read from disk on every request (secrets discipline:
      // read at use time, never cached), so a rotated key takes effect
      // mid-run without a restart. readSecretLine replays the full
      // owner-only permission gauntlet each time.
      const key = readSecretLine(keyFile, {
        label: 'Granola API key',
        setupHint: 'put the key at ~/.hazlie/secrets/granola-api-key.txt (0600, dir 0700)',
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let res;
      try {
        res = await fetchImpl(href, {
          method: 'GET', // read-only by construction: nothing here can write to Granola
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: controller.signal,
          // This request carries the bearer; a redirect would carry it
          // onward, past the egress ledger. Same rule as lib/ingestClient.mjs.
          redirect: 'error',
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw statusError(408, `granola request timed out after ${timeoutMs} ms: ${path}`);
        }
        throw Object.assign(new Error(`granola request failed: ${path}: ${error?.message ?? error}`), {
          status: 503,
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429) {
        await res.arrayBuffer().catch(() => {});
        if (attempt >= MAX_429_RETRIES) {
          throw statusError(429, `granola kept answering 429 after ${MAX_429_RETRIES} waits: ${path}`);
        }
        // Clamped like notionClient.mjs: a malformed or hostile Retry-After
        // ('99999999', an HTTP-date years out) would otherwise hold this
        // await for that long — and the schedule only re-arms a source when
        // run() returns, so the granola connector would never come back.
        const waitMs = Math.min(parseRetryAfterMs(res.headers?.get?.('retry-after'), now()) ?? 1000, 60_000);
        await sleep(waitMs);
        continue;
      }

      const body = await res.text();
      if (res.status < 200 || res.status >= 300) {
        // Message carries the path and status only — a Granola error body
        // could quote note content, and .status errors end up in run_log.
        throw statusError(res.status, `granola answered ${res.status} for ${path}`);
      }
      writeCache(cacheDir, href, body);
      try {
        return JSON.parse(body);
      } catch {
        throw statusError(502, `granola answered non-JSON for ${path}`);
      }
    }
  }

  return {
    request,
    // GET /notes — page_size ≤ 30; filters created_after / updated_after;
    // cursor pagination per the measured envelope above.
    listNotes({ pageSize = MAX_PAGE_SIZE, createdAfter, updatedAfter, cursor } = {}) {
      return request('/notes', {
        page_size: Math.min(pageSize, MAX_PAGE_SIZE),
        created_after: createdAfter,
        updated_after: updatedAfter,
        cursor,
      });
    },
    // GET /notes/{id} — summary_markdown, attendees, calendar event;
    // ?include=transcript folds the transcript into the same response.
    getNote(noteId, { includeTranscript = false } = {}) {
      return request(
        `/notes/${encodeURIComponent(noteId)}`,
        includeTranscript ? { include: 'transcript' } : {}
      );
    },
    // GET /notes/{id}/transcript — the transcript on its own.
    getTranscript(noteId) {
      return request(`/notes/${encodeURIComponent(noteId)}/transcript`);
    },
    // GET /folders — verified live 2026-08-19 (HTTP 200, 8 folders).
    listFolders() {
      return request('/folders');
    },
  };
}
