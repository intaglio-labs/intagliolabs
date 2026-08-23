// The distiller's answer cache, and the reason hermes shares it.
//
// One file per (prompt, model, row-content) triple, holding the model's RAW
// output for that row. For most rows that is `{"claims": []}` and harmless;
// for the rows that yielded claims it contains QUOTES from the owner's own
// messages — which makes this directory part of the corpus's blast radius,
// not an implementation detail beside it.
//
// That is why deletion lives here too. "Delete" only means anything if it
// reaches every derivative of a row: claims, decisions, FTS entries — and
// these files. Days 10–12 found the gap: 308 cached answers that no deletion
// path touched, in a directory Time Machine was backing up while ~/.hazlie
// sat excluded. The source protected, a derivative of it leaving the box.
// Hermes' deletion routes now unlink matching answers by content hash (see
// the callers in ui/server/hermes.mjs).
//
// The Time Machine half gets two mitigations, deliberately redundant:
//   * the cache root was excluded machine-side on 2026-08-20 (sticky), and
//   * putCached() re-asserts the exclusion at first write per process,
//     because a sticky exclusion lives in an xattr on the directory — a
//     recreated directory silently rejoins the backup set without this.
//   tmutil failures are tolerated: the exclusion is defence in depth, and the
//   unlinking above is the actual deletion story.
//
// HAZLIE_DISTILL_CACHE overrides the root. Read at call time, not import
// time, so tests can point it at a temp directory.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function cacheRoot(env = process.env) {
  return env.HAZLIE_DISTILL_CACHE ?? join(homedir(), '.cache', 'hazlie', 'distill');
}

let exclusionAsserted = false;
function ensureRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Only for the real root: a test's temp directory has no business in tmutil,
  // and the env override is how tests announce themselves.
  if (
    !exclusionAsserted &&
    process.platform === 'darwin' &&
    process.env.HAZLIE_DISTILL_CACHE === undefined
  ) {
    exclusionAsserted = true;
    try {
      execFileSync('tmutil', ['addexclusion', root], { stdio: 'ignore' });
    } catch {}
  }
}

export function readCached(key, root = cacheRoot()) {
  const path = join(root, key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// 0600 under a 0700 root: a cached answer quotes the corpus and gets the
// corpus's protections.
export function putCached(key, value, root = cacheRoot()) {
  ensureRoot(root);
  const path = join(root, key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

// Unlink every cached answer derived from these content hashes, across every
// prompt and model directory — an old prompt's answer about a deleted row is
// exactly as much residue as the current prompt's.
//
// The hash filter is not fussiness: these values normally come straight from
// hermes' own content_hash column, but a filename assembled from caller input
// is a path-traversal primitive the moment that assumption slips. Hex-ish or
// it does not become a path.
export function dropCachedDistillates(contentHashes, root = cacheRoot()) {
  const hashes = [...new Set(contentHashes)].filter(
    (h) => typeof h === 'string' && /^[a-zA-Z0-9]{8,128}$/u.test(h)
  );
  if (hashes.length === 0 || !existsSync(root)) return 0;
  let dropped = 0;
  for (const sha of readdirSync(root)) {
    const shaDir = join(root, sha);
    let models;
    try {
      models = readdirSync(shaDir);
    } catch {
      continue;
    }
    for (const model of models) {
      for (const hash of hashes) {
        try {
          unlinkSync(join(shaDir, model, `${hash}.json`));
          dropped += 1;
        } catch {
          // ENOENT: this row was never distilled under this prompt/model.
        }
      }
    }
  }
  return dropped;
}
