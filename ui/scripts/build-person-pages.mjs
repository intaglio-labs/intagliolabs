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
// NEVER LOGS PAGE TEXT. Each line of output is one JSON object with a HASHED
// person key (sha256, first 8 hex chars -- never the real key, which is
// frequently a legible "name:jane doe" string) plus counts and timing. The
// real key stays in the request body sent to hermes; it never reaches this
// process's stdout/stderr.

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

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

function hashPersonKey(personKey) {
  return createHash('sha256').update(personKey, 'utf8').digest('hex').slice(0, 8);
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
