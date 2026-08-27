// One distillation pass: read the owner's own rows, ask the LOCAL model what
// they say, and propose the answers to hermes. Exit 0/1, counts on stdout,
// diagnostics on stderr.
//
// THREE PROPERTIES THIS SCRIPT HAS BY CONSTRUCTION, not by care:
//
//   1. It cannot write to the corpus. The database is opened {readOnly: true},
//      and the only write path in the process is an HTTP POST to hermes'
//      bearer-only apply route. Hermes stays the sole writer; a bug here can
//      lose a run, not corrupt a store.
//   2. It cannot widen its own input. Row selection is
//      server/memory/select.mjs, whose allowlist is the security boundary. No
//      flag here names a source.
//   3. It never logs source text. Counts, ids and reasons only. The corpus does
//      not leak into a log file that has none of the corpus' protections — and
//      launchd's stdout goes to a path outside ~/.hazlie entirely.
//
// The model is local llama-server on loopback and is given no tools, no file
// handle and no network. It sees one message at a time and returns JSON.
//
// Usage, from ui/:
//   node scripts/distill-once.mjs                    latest 30 days
//   node scripts/distill-once.mjs --from-days 7
//   node scripts/distill-once.mjs --dry-run          select and count, ask nothing
//   node scripts/distill-once.mjs --backfill --from-days 90
//
// There is deliberately no mode meaning "scan whatever is there".

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  canonicalLoopbackBase,
  defaultDbPath,
  readHermesToken,
  readLlamaApiKey,
  DEFAULT_LLAMA_BASE_URL,
} from '../server/hermes.mjs';
import { selectRows, DEFAULT_FROM_DAYS, DEFAULT_ROW_CAP } from '../server/memory/select.mjs';
import { putCached, readCached } from '../server/memory/cache.mjs';
import {
  buildRequest,
  cacheKey,
  parseClaims,
  promptSha,
  validateRowClaims,
  MAX_CLAIMS_PER_RUN,
} from '../server/memory/distill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(here, '..', '..', 'prompts', 'distill_claims.md');
const BACKFILL_ROW_CAP = 20_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// --- flags -------------------------------------------------------------------
const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--from-days', '--limit', '--dry-run', '--backfill']);
for (const arg of argv) {
  if (arg.startsWith('--') && !KNOWN_FLAGS.has(arg)) fail(`unknown flag ${arg}`);
}
function numFlag(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) fail(`${name} needs a positive number`);
  return n;
}
const dryRun = argv.includes('--dry-run');
const backfill = argv.includes('--backfill');
const fromDays = numFlag('--from-days', DEFAULT_FROM_DAYS);
const rowCap = Math.trunc(numFlag('--limit', backfill ? BACKFILL_ROW_CAP : DEFAULT_ROW_CAP));

// --- inputs ------------------------------------------------------------------
const dbPath = process.env.HERMES_DB ?? defaultDbPath();
if (!existsSync(dbPath)) {
  fail(
    `context database not found: ${dbPath}\n` +
      'Nothing has been ingested on this machine yet. Start hermes to create it ' +
      '(cd ui && npm run hermes), or point HERMES_DB at an existing context.db.'
  );
}
if (!existsSync(PROMPT_PATH)) fail(`prompt not found: ${PROMPT_PATH}`);
const system = readFileSync(PROMPT_PATH, 'utf8');
const sha = promptSha(system);

// Both bases go through hermes' own loopback canonicaliser rather than being
// trimmed and trusted. Property 3 in this file's header says the model "is
// local llama-server on loopback"; until this check existed that was a hope
// about an environment variable, not a property. HAZLIE_LLAMA_URL carries
// whole corpus rows AND the llama key on every askModel call, and
// HAZLIE_HERMES_URL carries the hermes bearer, so a value pointing off-box
// exfiltrates both. Failing here, at startup, beats failing after the first
// row has already been sent.
let hermesBase;
let llamaBase;
try {
  hermesBase = canonicalLoopbackBase(
    process.env.HAZLIE_HERMES_URL ?? 'http://127.0.0.1:51789',
    'HAZLIE_HERMES_URL'
  );
  llamaBase = canonicalLoopbackBase(
    process.env.HAZLIE_LLAMA_URL ?? DEFAULT_LLAMA_BASE_URL,
    'HAZLIE_LLAMA_URL'
  );
} catch (error) {
  fail(`${error?.message ?? error}`);
}

let llamaKey = null;
let hermesToken = null;
if (!dryRun) {
  try {
    llamaKey = readLlamaApiKey();
    hermesToken = readHermesToken();
  } catch (error) {
    fail(`${error?.message ?? error}`);
  }
}

// The model's identity, read from llama-server rather than assumed, because it
// is recorded on the run and keys the cache: a swapped model must not be able
// to reuse another model's answers under its own name.
async function resolveModel() {
  const res = await fetch(`${llamaBase}/v1/models`, {
    headers: { Authorization: `Bearer ${llamaKey}` },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`llama-server /v1/models returned ${res.status}`);
  const body = await res.json();
  const id = body?.data?.[0]?.id ?? body?.models?.[0]?.name;
  if (typeof id !== 'string' || id.length === 0) throw new Error('llama-server named no model');
  return id;
}

async function askModel(row, model) {
  const res = await fetch(`${llamaBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llamaKey}` },
    body: JSON.stringify(buildRequest({ system, row, model })),
    signal: AbortSignal.timeout(120_000),
    // A compromised or misconfigured loopback service must not redirect a
    // household conversation (or the API key) onto the network. hermes and
    // people/summary.mjs both state this rule -- summary.mjs's comment even
    // calls it "the same rule as every other llama call here" -- and these two,
    // which send whole conversations, were the exceptions.
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`llama-server returned ${res.status}`);
  const body = await res.json();
  return body?.choices?.[0]?.message?.content ?? null;
}

// The cache itself lives in server/memory/cache.mjs, shared with hermes —
// deletion has to reach it, and hermes is the deleter. An edited row misses
// (keyed on content hash), so a re-run of an unchanged corpus costs nothing.

// --- run ---------------------------------------------------------------------
let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });

  // Resume where the last COMPLETE run stopped. A failed or interrupted run
  // leaves the cursor alone, so its rows are simply seen again — the apply
  // route is not idempotent by itself, but re-proposing a claim the owner has
  // not yet reviewed is a duplicate in the review queue, not corruption. That
  // is the cheap failure, and it is the one chosen here deliberately.
  const cursorRow = db
    // The LAST complete run, not MAX(through_changed_at): the cursor is now the
    // pair (store_changed_at, id), and the id that belongs with the newest
    // timestamp is only knowable from the same row. MAX() over one column would
    // pair a timestamp with some other run's id.
    .prepare(
      "SELECT through_changed_at AS c, through_id AS i FROM distill_run " +
        "WHERE status = 'complete' ORDER BY through_changed_at DESC, id DESC LIMIT 1"
    )
    .get();
  const sinceChangedAt = Number(cursorRow?.c ?? 0);
  // NULL on any run recorded before schema v7. Reading it as 0 re-offers the
  // whole tie group that run stopped inside -- the rows the old cursor skipped.
  const sinceId = Number(cursorRow?.i ?? 0);

  const rows = selectRows(db, { sinceChangedAt, sinceId, fromDays, limit: rowCap });
  const perSource = {};
  for (const row of rows) perSource[row.source] = (perSource[row.source] ?? 0) + 1;
  // Both halves come from the SAME row -- the last one this pass actually read.
  // Recording a timestamp without its id is what let the next pass step over the
  // rest of that row's tie group.
  const last = rows.length ? rows[rows.length - 1] : null;
  const throughChangedAt = last ? Number(last.store_changed_at) : sinceChangedAt;
  const throughId = last ? Number(last.id) : sinceId;

  if (dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          dry_run: true,
          prompt_sha: sha.slice(0, 16),
          from_days: fromDays,
          since_changed_at: sinceChangedAt,
          rows_in: rows.length,
          by_source: perSource,
        },
        null,
        2
      ) + '\n'
    );
    process.exit(0);
  }

  if (rows.length === 0) {
    process.stdout.write(JSON.stringify({ rows_in: 0, applied: 0, note: 'nothing new' }) + '\n');
    process.exit(0);
  }

  const model = await resolveModel();
  const stats = {
    rows_in: rows.length,
    by_source: perSource,
    from_cache: 0,
    parse_failures: 0,
    model_errors: 0,
    flooded_rows: 0,
    dropped: {},
    proposed: 0,
  };
  const proposals = [];

  for (const row of rows) {
    const key = cacheKey({ promptSha: sha, model, contentHash: row.content_hash });
    let raw = readCached(key);
    if (raw === null) {
      try {
        raw = await askModel(row, model);
        putCached(key, raw);
      } catch (error) {
        stats.model_errors += 1;
        console.error(`row ${row.id}: ${error?.message ?? error}`);
        continue;
      }
    } else {
      stats.from_cache += 1;
    }

    const parsed = parseClaims(raw);
    if (!parsed.ok) {
      stats.parse_failures += 1;
      console.error(`row ${row.id}: ${parsed.reason}`);
      continue;
    }
    const { kept, dropped, flooded } = validateRowClaims(row, parsed.claims);
    if (flooded) stats.flooded_rows += 1;
    for (const d of dropped) stats.dropped[d.reason] = (stats.dropped[d.reason] ?? 0) + 1;
    proposals.push(...kept);

    if (proposals.length > MAX_CLAIMS_PER_RUN) {
      console.error(
        `run produced more than ${MAX_CLAIMS_PER_RUN} claims and stopped. ` +
          'That is a prompt or model change, not a busy month; nothing was applied.'
      );
      process.exit(1);
    }
  }

  stats.proposed = proposals.length;
  if (proposals.length === 0) {
    process.stdout.write(JSON.stringify({ ...stats, applied: 0 }, null, 2) + '\n');
    process.exit(0);
  }

  const res = await fetch(`${hermesBase}/admin/memory/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hermesToken}` },
    body: JSON.stringify({
      run: {
        model,
        prompt_path: 'prompts/distill_claims.md',
        prompt_sha: sha,
        params: { temperature: 0, max_tokens: 512, constrained: true },
        from_changed_at: sinceChangedAt,
        through_changed_at: throughChangedAt,
        through_id: throughId,
        rows_in: rows.length,
      },
      claims: proposals,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const applied = await res.json();
  if (!res.ok) fail(`hermes refused the batch (${res.status}): ${applied?.error ?? 'no detail'}`);

  process.stdout.write(JSON.stringify({ ...stats, ...applied }, null, 2) + '\n');
} catch (error) {
  fail(`distill failed: ${error?.message ?? error}`);
} finally {
  try {
    db?.close();
  } catch {}
}
