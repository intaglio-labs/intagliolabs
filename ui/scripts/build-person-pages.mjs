#!/usr/bin/env node
// Build person pages (L5 step 4) for the eligible pool, one mode at a time.
//
//   node ui/scripts/build-person-pages.mjs --mode investor,founder --limit 40
//   node ui/scripts/build-person-pages.mjs --mode investor --person name:jane --force
//
// THIS SCRIPT NEVER OPENS THE DATABASE. hermes is the corpus's sole writer
// (same rule ui/AGENTS.md states and connectors/AGENTS.md enforces for every
// other script here) -- and a person page WRITES pending claims about a real
// human being, so it goes through hermes' own bearer-only route
// (POST /admin/relationship/pages/build) rather than a second process
// touching the file directly. eligiblePool is read the same way, over the
// existing GET /admin/relationship/pool route.
//
// NEVER LOGS PAGE TEXT. Each line of output is one JSON object with a
// PSEUDONYMISED person key plus counts and timing. The real key stays in the
// request body sent to hermes; it never reaches this process's stdout/stderr.
//
// THE HASH IS SALTED, and it has to be. ~~sha256(personKey).slice(0, 8),
// "never the real key".~~ An unsalted digest over a key space that IS the
// people table is not a pseudonym, it is an index into it: the key space is
// a few thousand legible strings ("name:jane doe"), so anyone holding the
// output and a name list recovers every row by hashing the list. Corrected
// 2026-09 with a per-machine secret from ~/.hazlie/secrets (0600, created on
// first use), which is exactly the boundary that makes the digest useless
// without the box it was produced on -- the same posture as every other
// secret this system keeps there. A truncated hash is still a pseudonym for
// grouping lines, not an anonymiser, and this output is a dev log either way.

import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from 'node:fs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--mode', '--limit', '--engine', '--person', '--force']);
for (const arg of argv) {
  if (arg.startsWith('--') && !KNOWN_FLAGS.has(arg)) fail(`unknown flag ${arg}`);
}
function value(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const modes = String(value('--mode', 'investor,founder'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const m of modes) {
  if (!['investor', 'founder', 'any'].includes(m)) fail(`--mode: unknown mode "${m}"`);
}
const limit = Number(value('--limit', '40'));
if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer');
const engine = value('--engine', null);
if (engine !== null && !['claude-cli', 'llama'].includes(engine)) {
  fail('--engine must be "claude-cli" or "llama"');
}
const onlyPerson = value('--person', null);
const force = argv.includes('--force');

const FORCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // skip a person built in the last 7 days unless --force

function readHermesToken() {
  const path = process.env.HERMES_TOKEN_FILE ?? join(homedir(), '.hazlie', 'secrets', 'hermes-token.txt');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    fail(
      `could not read the Hermes bearer token at ${path}: ${error?.message ?? error}\n` +
        'Run ops/setup-llm.sh, or set HERMES_TOKEN_FILE.'
    );
  }
  return null;
}

// The per-machine pseudonym secret, read once and created on first use.
// `wx` so two concurrent runs cannot each write a different salt: the loser
// of that race reads the winner's file rather than overwriting it, which
// matters because a changed salt silently renames every person in the output.
//
// ~~write a temp file, then renameSync it into place, and treat the loser's
// EEXIST as "re-read the winner"~~ REVERTED 2026-09 (review G finding 2).
// renameSync on POSIX SILENTLY REPLACES the destination; EEXIST from rename
// is a Windows/non-empty-directory behaviour, so `if (error?.code !==
// 'EEXIST') throw` could never fire on macOS or Linux and the loser of the
// race overwrote the winner's salt -- the exact outcome the `wx` it replaced
// existed to prevent, with a guard that reads as protection and cannot
// trigger. `open(path, 'wx')` is O_EXCL: claiming the NAME is the atomic
// step, and it is the only one that can be.
//
// What tmp+rename was buying, and what replaces it: rename made the CONTENT
// appear all at once, so a crash mid-write could not leave a short file for
// the next run to read as a bad salt. Under O_EXCL that window is back, and
// it is closed on both sides instead -- the writer unlinks its own partial
// file if write or fsync throws, and the loser's retry loop treats a
// too-short read as "the winner has not finished writing yet" and waits for
// it rather than failing on it.
function sleepSync(ms) {
  // Atomics.wait needs a SharedArrayBuffer-backed view; this is a short,
  // synchronous retry loop for a race that resolves in well under a second.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

// Reads the salt file. Returns { salt } on a good read, { short: true } when
// the file exists but is too short to be real entropy (distinct from "not
// there yet" so the two failures don't get the same misleading message), or
// null when the file does not exist.
function readSaltFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
  if (text.length < 32) return { short: true };
  return { salt: text };
}

// Re-reads while the answer is "nothing usable yet". A file that is present
// but too short is EITHER truncated for good OR a concurrent creator caught
// between its open and its close, and nothing here can tell those apart -- so
// wait the millisecond a live writer needs before reporting the permanent
// fault. Under tmp+rename this could not happen and there was no wait; under
// O_EXCL the name appears before the content does, which is the cost of
// having the race guard actually work.
function awaitSaltFile(path, attempts) {
  let found = readSaltFile(path);
  for (let attempt = 0; attempt < attempts && (found === null || found.short === true); attempt += 1) {
    sleepSync(20);
    found = readSaltFile(path);
  }
  return found;
}

function readPseudonymSalt() {
  const path = process.env.HAZLIE_PSEUDONYM_SALT_FILE
    ?? join(homedir(), '.hazlie', 'secrets', 'pseudonym-salt.txt');

  // No retry on a plain absence: that is the ordinary first run, and the
  // create path below is what answers it.
  let initial = readSaltFile(path);
  if (initial !== null && initial.short) initial = awaitSaltFile(path, 5);
  if (initial !== null) {
    if (initial.short) {
      fail(`salt file too short at ${path}; delete it to regenerate`);
      return null;
    }
    return initial.salt;
  }

  // Two concurrent runs can both find no file and both try to create one.
  // O_EXCL decides it: exactly one open() succeeds, the loser gets EEXIST and
  // reads the winner's file instead of writing its own.
  const salt = randomBytes(32).toString('hex');
  const previousUmask = process.umask(0o077);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    sweepStaleTemps(path);
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // We lost the race, so the winner's file is the salt -- never ours.
      const found = awaitSaltFile(path, 5);
      if (found !== null && !found.short) return found.salt;
      fail(`could not read the pseudonym salt at ${path} after losing the create race; if it is short, empty or unreadable, delete it to regenerate`);
      return null;
    }
    // We hold the name. fsync before close so the salt every subsequent run
    // will read is on disk: a machine that loses power here would otherwise
    // leave a present-but-empty file, and the next build would rename every
    // person against a salt this one never durably recorded.
    try {
      writeSync(fd, `${salt}\n`, null, 'utf8');
      fsyncSync(fd);
    } catch (error) {
      // Our own partial file, and nobody else's: remove it so the next run
      // creates a whole one rather than reading this as a bad salt.
      try { closeSync(fd); } catch { /* already closing on the error path */ }
      try { unlinkSync(path); } catch { /* best effort */ }
      throw error;
    }
    closeSync(fd);
    return salt;
  } catch (error) {
    fail(`could not create the pseudonym salt at ${path}: ${error?.message ?? error}`);
    return null;
  } finally {
    process.umask(previousUmask);
  }
}

// The tmp+rename version left `${path}.tmp-<pid>` behind on any crash between
// its write and its rename, and on a non-EEXIST rename error the throw
// skipped its own unlink. Nothing ever swept them, and each one is a valid
// 64-hex salt at 0600 sitting in the secrets directory. This file no longer
// creates them; it clears whatever the old version left. Best effort by
// design -- an unreadable directory or an undeletable file must not stop a
// build over housekeeping.
function sweepStaleTemps(path) {
  const dir = dirname(path);
  const prefix = `${basename(path)}.tmp-`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      if (!/^\d+$/u.test(name.slice(prefix.length))) continue;
      try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

const PSEUDONYM_SALT = readPseudonymSalt();
const SALT_FINGERPRINT = createHash('sha256').update(PSEUDONYM_SALT, 'utf8').digest('hex').slice(0, 8);

function hashPersonKey(personKey) {
  return createHash('sha256').update(`${PSEUDONYM_SALT}\u0000${personKey}`, 'utf8').digest('hex').slice(0, 8);
}

const hermesBase = process.env.HAZLIE_HERMES_URL ?? 'http://127.0.0.1:51789';
const token = readHermesToken();

async function call(method, path, body) {
  const res = await fetch(`${hermesBase}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(150_000),
    redirect: 'error',
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} returned non-JSON (status ${res.status})`);
  }
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${json?.error ?? text.slice(0, 200)}`);
  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function candidatesForMode(mode) {
  if (onlyPerson) return [{ personKey: onlyPerson, name: onlyPerson }];
  const { rows } = await call('GET', `/admin/relationship/pool?mode=${encodeURIComponent(mode)}&includeOffered=1`);
  return rows.slice(0, limit);
}

async function alreadyBuiltRecently(personKey) {
  if (force) return false;
  try {
    const { page } = await call('GET', `/admin/relationship/page?personKey=${encodeURIComponent(personKey)}`);
    return typeof page?.builtAt === 'number' && Date.now() - page.builtAt < FORCE_WINDOW_MS;
  } catch {
    return false;
  }
}

async function main() {
  // Printed once per run: a changed or deleted salt file silently renames
  // every person in the output, and this fingerprint is how that shows up
  // in a diff of two runs' logs without ever printing the salt itself.
  process.stdout.write(`${JSON.stringify({ salt: SALT_FINGERPRINT })}\n`);
  const totals = { people: 0, kept: 0, dropped: 0, skipped: 0, rejected: 0, cost_usd: 0, ms: 0 };
  for (const mode of modes) {
    const candidates = await candidatesForMode(mode);
    for (const candidate of candidates) {
      const personKey = candidate.personKey;
      if (await alreadyBuiltRecently(personKey)) continue;

      const start = Date.now();
      let result;
      try {
        result = await call('POST', '/admin/relationship/pages/build', {
          personKey,
          ...(engine ? { engine } : {}),
        });
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({ personKey: hashPersonKey(personKey), error: String(error?.message ?? error) })}\n`
        );
        continue;
      }
      const ms = Date.now() - start;
      const line = {
        personKey: hashPersonKey(personKey),
        kept: result.kept ?? 0,
        dropped: result.dropped ?? 0,
        cost_usd: typeof result.cost_usd === 'number' ? result.cost_usd : null,
        ms,
      };
      process.stdout.write(`${JSON.stringify(line)}\n`);

      totals.people += 1;
      totals.kept += result.kept ?? 0;
      totals.dropped += result.dropped ?? 0;
      totals.skipped += result.skipped ?? 0;
      totals.rejected += result.rejected ?? 0;
      totals.cost_usd += typeof result.cost_usd === 'number' ? result.cost_usd : 0;
      totals.ms += ms;

      await sleep(1000);
    }
  }
  process.stdout.write(`${JSON.stringify({ totals })}\n`);
}

main().catch((error) => fail(String(error?.message ?? error)));
