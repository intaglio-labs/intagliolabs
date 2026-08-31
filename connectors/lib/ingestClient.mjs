// The connectors' one write path into the context store: POST /ingest on the
// loopback hermes, plus thin wrappers over the bearer-only /admin/* lifecycle
// routes. Nothing in this package opens context.db — hermes is the corpus's
// sole writer AND sole deleter, and this module is how connectors ask.
//
// The base URL is validated as an HTTP loopback origin before any request:
// every row this module carries is corpus content, and a config typo must not
// be able to point the firehose at a LAN address.
//
// ONE RULE BINDS EVERY CALLER (ops/INGESTION.md): connectors must PRE-SORT
// semantically-unordered arrays in `meta` (attendees, recipients, categories)
// before ingest. Hermes computes the canonical content hash server-side and
// canonicalizes object key order, but it keeps array order — a generic
// canonicalizer cannot know which arrays are really sets — so a reordered
// attendee list would read as an edit and churn an update on every delivery.
// Do not compute or send a hash from this side; there is deliberately no
// field for it (a second implementation would eventually disagree on
// serialization, turning every redelivery into a spurious update).
import { readHermesTokenFile, defaultHermesTokenPath } from './secrets.mjs';

// 51789 is the canonical hermes port (moved 2026-08-20; an unrelated dev
// server holds 8787 on the owner's Mac). Must match hermes.mjs and
// ops/setup-connectors.sh.
export const DEFAULT_HERMES_BASE_URL = 'http://127.0.0.1:51789';

// Hermes caps request bodies at 1 MiB. Staying at half that (and ≤200 rows)
// leaves headroom for rows that serialize larger than they were measured
// (escaping) and keeps a single blocking parse on hermes' single thread
// short. A 413 can still happen — a batch is then split recursively below —
// but the planner makes it the exception, not the routine.
const MAX_BATCH_ROWS = 200;
const MAX_BATCH_BYTES = 512 * 1024;

// Redelivery is free by construction (entity upsert makes a retried batch
// come back `unchanged`), which is what makes blind retry of a network error
// or 5xx safe: the worst case of "the write landed but the response was
// lost" is an unchanged-count, not a duplicate row.
const RETRIES = 3;

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

function requireOpts(opts) {
  if (opts === null || typeof opts !== 'object') {
    throw new Error('ingest client requires an options object with baseUrl and tokenFile');
  }
  const {
    baseUrl = DEFAULT_HERMES_BASE_URL,
    tokenFile = defaultHermesTokenPath(),
    fetchImpl = fetch,
    backoffMs = 500,
  } = opts;
  return { baseUrl: canonicalLoopbackBase(baseUrl), tokenFile, fetchImpl, backoffMs };
}

// Same acceptance rule as hermes' own HERMES_LLAMA_URL check: plain HTTP, a
// loopback host, no credentials or path. Corpus rows go to loopback hermes or
// they go nowhere.
export function canonicalLoopbackBase(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('hermes baseUrl must be an HTTP loopback origin');
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (
    url.protocol !== 'http:' ||
    !loopback ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('hermes baseUrl must be an HTTP loopback origin');
  }
  return url.origin;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One request with the retry policy. Network errors and 5xx retry with
// exponential backoff (see RETRIES above for why that is safe here); every
// 4xx is the caller's bug or the caller's instruction and returns to the
// caller unretried. The token is passed in, already read — the per-call
// re-read happens once in the public entry points so rotation lands without
// a restart, but a 3-batch delivery does not stat the file three times.
async function request({ baseUrl, fetchImpl, backoffMs }, method, path, token, body) {
  let lastFailure;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // canonicalLoopbackBase proves the ORIGIN is loopback; it cannot prove
        // where a reply sends us next. Without this, a 307 from whatever holds
        // :51789 forwards the batch -- corpus rows and the bearer both -- to a
        // host of its choosing, and the loopback check above would have passed
        // on the way out. Same reasoning and same spelling as
        // ui/server/hermes.mjs' llama call.
        redirect: 'error',
      });
    } catch (error) {
      lastFailure = error;
      continue; // network-level failure: hermes restarting, socket refused
    }
    if (res.status >= 500) {
      lastFailure = statusError(res.status, `hermes answered ${res.status} for ${path}`);
      continue;
    }
    return res;
  }
  throw Object.assign(
    new Error(
      `hermes at ${baseUrl} is unreachable after ${RETRIES + 1} attempts: ${lastFailure?.message ?? lastFailure}`
    ),
    { status: lastFailure?.status ?? 503, cause: lastFailure }
  );
}

async function readBody(res, path) {
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    throw statusError(res.status, `hermes answered ${res.status} for ${path} with a non-JSON body`);
  }
  return parsed;
}

// Throws for every non-200 the retry loop let through. 400 carries hermes'
// own detail (it names the failing row index) because the whole batch was
// rejected and nothing was written — retrying it would only fail again.
async function expectOk(res, path) {
  const parsed = await readBody(res, path);
  if (res.status !== 200) {
    throw statusError(res.status, `hermes ${res.status} for ${path}: ${parsed?.error ?? 'no detail'}`);
  }
  return parsed;
}

// Greedy batch planner: cut a new batch at 200 rows or 512 KiB of serialized
// rows, whichever comes first. A single row larger than the cap travels
// alone — hermes' real limit is 1 MiB, so it may still fit — and if it does
// not, the 413 below is unsplittable and honest.
function* planBatches(rows) {
  let batch = [];
  let bytes = 2; // the enclosing []
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1; // +1 for the comma
    if (batch.length > 0 && (batch.length >= MAX_BATCH_ROWS || bytes + size > MAX_BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 2;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}

async function deliver(ctx, token, batch, totals) {
  const res = await request(ctx, 'POST', '/ingest', token, batch);
  if (res.status === 413) {
    await res.arrayBuffer().catch(() => {});
    if (batch.length === 1) {
      throw statusError(
        413,
        'a single row exceeds hermes’ request body cap; the source must truncate or drop it'
      );
    }
    // The planner mis-measured (escaping inflated the serialization) or the
    // cap moved. Halving recursively terminates at single rows, and the
    // upsert makes re-delivering the half that already landed harmless.
    const mid = Math.ceil(batch.length / 2);
    await deliver(ctx, token, batch.slice(0, mid), totals);
    await deliver(ctx, token, batch.slice(mid), totals);
    return;
  }
  const counts = await expectOk(res, '/ingest');
  for (const key of ['inserted', 'updated', 'unchanged']) {
    if (!Number.isFinite(counts?.[key])) {
      throw new Error(`hermes /ingest response is missing a numeric "${key}" count`);
    }
    totals[key] += counts[key];
  }
}

// Deliver rows (one object or an array) to POST /ingest, batching and
// splitting as required. Returns aggregate {inserted, updated, unchanged}
// across all batches. The bearer token is re-read from disk on every call so
// setup can rotate it without restarting the daemon — hermes does the same
// on its side of the file.
export async function ingest(rows, opts) {
  const ctx = requireOpts(opts);
  const list = Array.isArray(rows) ? rows : [rows];
  const totals = { inserted: 0, updated: 0, unchanged: 0 };
  if (list.length === 0) return totals;
  const token = readHermesTokenFile(ctx.tokenFile);
  for (const batch of planBatches(list)) {
    await deliver(ctx, token, batch, totals);
  }
  return totals;
}

// --- /admin/* wrappers --------------------------------------------------------
//
// Bearer-only on hermes' side; this process never sends an Origin header, so
// these land on the bearer channel by construction. Every admin operation is
// idempotent (retain/purge/delete re-run to the same end state, maintain is a
// cleanup), which is why they share the ingest retry policy.

export async function adminRetain({ source, keepDays }, opts) {
  const ctx = requireOpts(opts);
  const token = readHermesTokenFile(ctx.tokenFile);
  const res = await request(ctx, 'POST', '/admin/retain', token, {
    source,
    keep_days: keepDays,
  });
  return expectOk(res, '/admin/retain'); // {deleted, claims_deleted}
}

export async function adminPurge({ source }, opts) {
  const ctx = requireOpts(opts);
  const token = readHermesTokenFile(ctx.tokenFile);
  const res = await request(ctx, 'POST', '/admin/purge', token, { source });
  return expectOk(res, '/admin/purge'); // {deleted, claims_deleted, maintained}
}

// Contacts has no corpus source of its own, but its identifiers and names can
// be present in Hermes' rebuildable People projection. Its explicit purge uses
// this route so deleting connector state cannot leave that derived copy behind.
export async function adminClearPeopleProjection(opts) {
  const ctx = requireOpts(opts);
  const token = readHermesTokenFile(ctx.tokenFile);
  const res = await request(ctx, 'POST', '/admin/people/clear', token, {});
  return expectOk(res, '/admin/people/clear'); // {cleared}
}

// Advance the product-level year barrier after connector data is complete.
// The response is deliberately aggregate: the connector process may schedule
// and display progress, but person keys and derived summaries remain inside
// Hermes with the corpus.
export async function adminCompletePeopleYear({ year }, opts) {
  if (!Number.isInteger(year) || year < 1990 || year > 3000) {
    throw new Error('adminCompletePeopleYear requires an integer year');
  }
  const ctx = requireOpts(opts);
  const token = readHermesTokenFile(ctx.tokenFile);
  const res = await request(ctx, 'POST', '/admin/people/complete-year', token, { year });
  const body = await expectOk(res, '/admin/people/complete-year');
  for (const field of [
    'year', 'profiles', 'summariesTotal', 'summariesComplete',
    'summariesSkipped', 'summariesPending',
  ]) {
    if (!Number.isFinite(body?.[field])) {
      throw new Error(`hermes people-year response is missing numeric "${field}"`);
    }
  }
  if (typeof body.complete !== 'boolean' || typeof body.state !== 'string') {
    throw new Error('hermes people-year response is missing completion state');
  }
  return body;
}

// Hermes accepts 1–500 ids per call; this wrapper chunks a larger list so a
// reconciler can hand over one diff without knowing the transport cap, and
// sums the deleted counts. Deleting an already-deleted id deletes zero rows,
// so a retried chunk cannot overshoot.
export async function adminDeleteEntities({ source, entityIds }, opts) {
  const ctx = requireOpts(opts);
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    throw new Error('adminDeleteEntities requires a non-empty entityIds array');
  }
  const token = readHermesTokenFile(ctx.tokenFile);
  let deleted = 0;
  for (let i = 0; i < entityIds.length; i += 500) {
    const res = await request(ctx, 'POST', '/admin/delete-entities', token, {
      source,
      entity_ids: entityIds.slice(i, i + 500),
    });
    deleted += (await expectOk(res, '/admin/delete-entities')).deleted;
  }
  return { deleted };
}

export async function adminMaintain(opts) {
  const ctx = requireOpts(opts);
  const token = readHermesTokenFile(ctx.tokenFile);
  const res = await request(ctx, 'POST', '/admin/maintain', token, {});
  return expectOk(res, '/admin/maintain'); // {maintained}
}

// Aggregate connector coverage only. Hermes performs the DISTINCT and date
// grouping while it still owns the corpus handle; this process receives no
// message text, people, addresses, room ids, or entity ids.
export async function adminCoverage(opts) {
  const ctx = requireOpts(opts);
  const token = readHermesTokenFile(ctx.tokenFile);
  const res = await request(ctx, 'GET', '/admin/coverage', token);
  const body = await expectOk(res, '/admin/coverage');
  if (!Array.isArray(body?.sources)) {
    throw new Error('hermes /admin/coverage response is missing the sources array');
  }
  return body;
}

// The read half of window reconciliation. Returns [{entity_id, ts}] — ids and
// timestamps are ALL hermes will ever send back here, by design: corpus text
// crossing into this process would land it inside logs and state files that
// sit outside the corpus boundary. A 413 means the window holds >5000
// entities and the caller must reconcile in slices; it is thrown, not
// swallowed, because a truncated list would read as "these entities no longer
// exist" and the reconciler would delete the remainder.
export async function adminEntities({ source, fromTs, toTs }, opts) {
  const ctx = requireOpts(opts);
  const token = readHermesTokenFile(ctx.tokenFile);
  const params = new URLSearchParams({ source });
  if (fromTs !== undefined) params.set('from_ts', String(fromTs));
  if (toTs !== undefined) params.set('to_ts', String(toTs));
  const res = await request(ctx, 'GET', `/admin/entities?${params}`, token);
  const body = await expectOk(res, '/admin/entities');
  if (!Array.isArray(body?.entities)) {
    throw new Error('hermes /admin/entities response is missing the entities array');
  }
  return body.entities;
}
