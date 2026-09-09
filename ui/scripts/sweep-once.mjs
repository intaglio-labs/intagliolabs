#!/usr/bin/env node
// Run one discovery-sweep pass (L5 step 5), spawned by the Distiller's timer
// (Swift-side, see widget/src/Distiller.swift) or by hand.
//
//   node ui/scripts/sweep-once.mjs --power trickle --battery 62 --on-ac 0 --thermal nominal
//   node ui/scripts/sweep-once.mjs --power full --limit 12 --engine claude-cli
//
// THIS SCRIPT NEVER OPENS THE DATABASE, for the same reason
// build-person-pages.mjs never does: hermes is the corpus's sole writer, and
// a sweep pass WRITES pending claims about real people, so it goes through
// hermes' own bearer-only route (POST /admin/relationship/sweep) rather than
// a second process touching the file directly.
//
// NO PERSON KEYS OR TEXT ARE EVER PRINTED. person_sweep_run rows (what this
// prints) carry only counts, timing and a power/engine label -- never a
// person_key or any excerpt of what anyone said, so unlike
// build-person-pages.mjs there is nothing here to hash before printing.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--limit', '--power', '--battery', '--on-ac', '--thermal', '--engine']);
for (const arg of argv) {
  if (arg.startsWith('--') && !KNOWN_FLAGS.has(arg)) fail(`unknown flag ${arg}`);
}
function value(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const limitRaw = value('--limit', null);
let limit = null;
if (limitRaw !== null) {
  limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer');
}

const power = value('--power', null);
if (power !== null && !['full', 'trickle'].includes(power)) {
  fail('--power must be "full" or "trickle"');
}

const engine = value('--engine', null);
if (engine !== null && !['claude-cli', 'llama'].includes(engine)) {
  fail('--engine must be "claude-cli" or "llama"');
}

const thermal = value('--thermal', null);
if (thermal !== null && !['nominal', 'fair', 'serious', 'critical'].includes(thermal)) {
  fail('--thermal must be one of: nominal, fair, serious, critical');
}

const batteryRaw = value('--battery', null);
let battery = null;
let batteryGiven = false;
if (batteryRaw !== null) {
  batteryGiven = true;
  battery = Number(batteryRaw);
  if (!Number.isFinite(battery) || battery < 0 || battery > 100) {
    fail('--battery must be a number from 0 through 100');
  }
}

const onAcRaw = value('--on-ac', null);
let onAc = null;
let onAcGiven = false;
if (onAcRaw !== null) {
  onAcGiven = true;
  if (onAcRaw !== '0' && onAcRaw !== '1') fail('--on-ac must be 0 or 1');
  onAc = onAcRaw === '1';
}

// Fallback for whichever of battery/onAc the caller did not pass on the
// command line: `pmset -g batt` works from Node (conflict #5 in the design --
// `pmset -g therm` reports CPU power warnings, not thermal state, and
// powermetrics needs root; only ProcessInfo.thermalState, Swift-side, is
// usable for --thermal, which is why there is no fallback for it here). If
// pmset itself is unavailable or its output does not match, send nothing for
// the field it would have filled -- the route already treats an absent
// battery/onAc as unknown rather than as a reason to skip.
function pmsetFallback() {
  try {
    return execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return null;
  }
}

if (!batteryGiven || !onAcGiven) {
  const out = pmsetFallback();
  if (out) {
    if (!batteryGiven) {
      const m = out.match(/(\d+)%/);
      if (m) battery = Number(m[1]);
    }
    if (!onAcGiven) {
      const m = out.match(/drawing from '(AC|Battery) Power'/);
      if (m) onAc = m[1] === 'AC';
    }
  }
}

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

const hermesBase = process.env.HAZLIE_HERMES_URL ?? 'http://127.0.0.1:51789';
const token = readHermesToken();

async function main() {
  const body = {};
  if (power !== null) body.power = power;
  if (limit !== null) body.limit = limit;
  if (battery !== null) body.battery = battery;
  if (onAc !== null) body.onAc = onAc;
  if (thermal !== null) body.thermal = thermal;
  if (engine !== null) body.engine = engine;

  let res;
  try {
    res = await fetch(`${hermesBase}/admin/relationship/sweep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
      redirect: 'error',
    });
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
    process.exit(1);
    return;
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    process.stdout.write(`${JSON.stringify({ status: res.status, error: 'non-JSON response' })}\n`);
    process.exit(1);
    return;
  }

  if (!res.ok) {
    // `status` on its own key, and hermes' body under `body` rather than
    // spread over the top level. Spreading it meant hermes' own `error`
    // string overwrote the HTTP status this line exists to report, so a 401
    // (no token), a 404 (an old build with no such route) and a 500 all
    // printed the same shape with the status gone -- and the one number that
    // tells those three apart is the one that was lost.
    process.stdout.write(`${JSON.stringify({ status: res.status, error: json?.error ?? null, body: json })}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(`${JSON.stringify(json)}\n`);
}

main().catch((error) => fail(String(error?.message ?? error)));
