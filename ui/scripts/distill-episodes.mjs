#!/usr/bin/env node
// One distillation pass over EPISODES rather than rows.
//
//   node ui/scripts/distill-episodes.mjs [--limit 40] [--context] [--dry-run]
//
// A sibling of distill-once.mjs, not a replacement. That script still works and
// still distils a row at a time; this one reads the episode index built by
// scripts/build-episodes.mjs and sends a conversation per call. Keeping them
// apart means episode mode is opt-in, revertible by not running it, and cannot
// break the path that is already working.
//
// --context admits the messages the owner did NOT write as reading context.
// It is off by default and it is the one flag here that changes what a model
// may see, so the run records which way it ran (distill_run.episode_context) and
// every claim it produced can be found again by that column alone.
//
// SAME PROPERTIES AS ITS SIBLING:
//   1. loopback only, asserted at startup -- a URL pointing off-box would
//      exfiltrate corpus text AND the llama key on every call.
//   2. it proposes; hermes decides. Nothing here writes a claim.
//   3. it never logs row text. Counts, ids and reasons only.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  promptSha,
  cacheKey,
  parseClaims,
  buildEpisodeRequest,
  validateEpisodeClaims,
  MAX_CLAIMS_PER_RUN,
} from '../server/memory/distill.mjs';
import { readCached, putCached } from '../server/memory/cache.mjs';
import { episodeLines } from '../server/memory/episodeStore.mjs';
import {
  canonicalLoopbackBase,
  defaultDbPath,
  readHermesToken,
  readLlamaApiKey,
  DEFAULT_LLAMA_BASE_URL,
} from '../server/hermes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const fail = (m) => {
  process.stderr.write(`${m}\n`);
  process.exit(1);
};

const limit = Number(value('--limit', '40'));
if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer');
const withContext = flag('--context');
const dryRun = flag('--dry-run');

const PROMPT_PATH = join(repoRoot, 'prompts', 'distill_claims.md');
const system = readFileSync(PROMPT_PATH, 'utf8');
const sha = promptSha(system);

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

async function resolveModel() {
  const res = await fetch(`${llamaBase}/v1/models`, {
    headers: { Authorization: `Bearer ${llamaKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`llama-server /v1/models returned ${res.status}`);
  const body = await res.json();
  const id = body?.data?.[0]?.id ?? body?.models?.[0]?.name;
  if (typeof id !== 'string' || id.length === 0) throw new Error('llama-server named no model');
  return id;
}

async function askModel(episode, lines, model) {
  const res = await fetch(`${llamaBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llamaKey}` },
    body: JSON.stringify(buildEpisodeRequest({ system, episode, lines, model, context: withContext })),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`llama-server returned ${res.status}`);
  const body = await res.json();
  return body?.choices?.[0]?.message?.content ?? null;
}

const dbPath = defaultDbPath();
let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });

  // The model has to be known BEFORE the pending query, because it is part of
  // what "already done" means.
  const model = dryRun ? '(dry-run)' : await resolveModel();

  // Settled episodes THIS prompt, model and arm has not already produced a run
  // for. All four parts matter and the first version had only two:
  //
  //   member_hash  -- not the episode id, because the index is rebuilt and
  //                   replaced, so ids move and content does not;
  //   episode_context -- or running with --context after an --off pass selects
  //                   NOTHING, and the comparison this flag exists for cannot be
  //                   run on any episode already processed. That is the whole
  //                   experiment, silently doing nothing;
  //   prompt_sha, model -- the comment claimed prompt/model specificity and the
  //                   query did not implement it, so a prompt edit or a swapped
  //                   model would have looked like "nothing new".
  const pending = db
    .prepare(
      'SELECT e.* FROM episode e ' +
        'WHERE e.settled_at <= ? ' +
        '  AND NOT EXISTS (SELECT 1 FROM distill_run r ' +
        '       WHERE r.episode_hash = e.member_hash ' +
        "         AND r.status = 'complete' " +
        '         AND r.episode_context IS ? ' +
        '         AND r.prompt_sha = ? ' +
        '         AND r.model = ?) ' +
        'ORDER BY e.started_at LIMIT ?'
    )
    .all(Date.now(), withContext ? 'on' : 'off', sha, model, limit);

  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dry_run: true,
          prompt_sha: sha.slice(0, 16),
          context: withContext ? 'on' : 'off',
          episodes_pending: pending.length,
          lines: pending.reduce((n, e) => n + e.row_count, 0),
        },
        null,
        2
      )}\n`
    );
    process.exit(0);
  }

  if (pending.length === 0) {
    process.stdout.write(`${JSON.stringify({ episodes_in: 0, note: 'nothing new' })}\n`);
    process.exit(0);
  }

  const stats = {
    episodes_in: pending.length,
    from_cache: 0,
    parse_failures: 0,
    model_errors: 0,
    flooded: 0,
    dropped: {},
    proposed: 0,
    context: withContext ? 'on' : 'off',
  };

  // One hermes batch PER EPISODE. The apply route resolves a claim's line
  // through the episode named on the run, so a batch mixing two episodes could
  // not be resolved -- and this way a single bad episode fails alone.
  const applied = [];
  for (const episode of pending) {
    const lines = episodeLines(db, episode.id);
    if (lines.length === 0) continue;

    // The cache key is the episode's CONTENT hash, so a rebuilt index is free
    // and an edited message is a miss, exactly as with rows.
    const key = cacheKey({
      promptSha: sha,
      model,
      contentHash: `${episode.member_hash}:${withContext ? 'ctx' : 'own'}`,
    });
    let raw = readCached(key);
    if (raw === null) {
      try {
        raw = await askModel(episode, lines, model);
        putCached(key, raw);
      } catch (error) {
        stats.model_errors += 1;
        console.error(`episode ${episode.id}: ${error?.message ?? error}`);
        continue;
      }
    } else {
      stats.from_cache += 1;
    }

    const parsed = parseClaims(raw);
    if (!parsed.ok) {
      stats.parse_failures += 1;
      console.error(`episode ${episode.id}: ${parsed.reason}`);
      continue;
    }
    const { kept, dropped, flooded } = validateEpisodeClaims(lines, parsed.claims);
    if (flooded) stats.flooded += 1;
    for (const d of dropped) stats.dropped[d.reason] = (stats.dropped[d.reason] ?? 0) + 1;
    stats.proposed += kept.length;

    if (stats.proposed > MAX_CLAIMS_PER_RUN) {
      console.error(
        `pass produced more than ${MAX_CLAIMS_PER_RUN} claims and stopped. ` +
          'That is a prompt or model change, not a busy month; nothing further was applied.'
      );
      break;
    }

    // A pass over an episode that yielded nothing STILL records a run, or the
    // next pass picks it up again forever. rows_in is the episode's line count.
    const body = {
      run: {
        model,
        prompt_path: 'prompts/distill_claims.md',
        prompt_sha: sha,
        params: { temperature: 0, max_tokens: 512, constrained: true, episode: true },
        rows_in: lines.length,
        episode_hash: episode.member_hash,
        episode_context: withContext ? 'on' : 'off',
      },
      claims: kept.map((c) => ({
        kind: c.kind,
        text: c.text,
        when_phrase: c.when_phrase,
        p_claim: c.p,
        // The LINE. hermes resolves the row itself -- see the note on
        // APPLY_SOURCE_FIELDS; a caller-supplied context_id is refused.
        source: { line: c.line, quote: c.quote, content_hash: c.content_hash },
      })),
    };
    // An empty claims array is deliberate and accepted for an episode run: it
    // records "read, found nothing", which is what most conversations are and
    // what stops this episode being re-read on every future pass.

    try {
      const res = await fetch(`${hermesBase}/admin/memory/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hermesToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const out = await res.json();
      if (!res.ok) {
        console.error(`episode ${episode.id}: hermes refused (${res.status}) ${out?.error ?? ''}`);
        continue;
      }
      applied.push(out);
    } catch (error) {
      console.error(`episode ${episode.id}: ${error?.message ?? error}`);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      { ...stats, applied: applied.reduce((n, a) => n + (a?.applied ?? 0), 0) },
      null,
      2
    )}\n`
  );
} catch (error) {
  fail(`distill-episodes failed: ${error?.message ?? error}`);
} finally {
  try {
    db?.close();
  } catch {}
}
