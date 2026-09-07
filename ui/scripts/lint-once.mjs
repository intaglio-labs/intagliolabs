#!/usr/bin/env node
// Run one lint pass (step 5½), spawned by the Distiller's timer (Swift-side,
// see widget/src/Distiller.swift) or by hand.
//
//   node ui/scripts/lint-once.mjs
//
// THIS SCRIPT NEVER OPENS THE DATABASE, for the same reason lookup-once.mjs
// and sweep-once.mjs never do: hermes is the corpus's sole writer, and a
// lint pass WRITES lint_run/lint_finding rows, so it goes through hermes'
// own bearer-only route (POST /admin/relationship/lint) rather than a second
// process touching the file directly.
//
// lookup-once.mjs, MINUS ITS FLAGS AND ITS pmset FALLBACK: lint has no model
// call, so it has no power mode, no battery/on-AC/thermal reading, and no
// budget -- every one of those exists on lookup-once.mjs/sweep-once.mjs only
// to gate or size a model call this file never makes. There is nothing here
// for the Distiller to pass but the request itself.
//
// NO PERSON KEYS OR TEXT ARE EVER PRINTED. lint_run rows (what this prints)
// carry only counts, a checks-run list and per-check JSON counts -- never a
// person_key, a claim's text, or any excerpt of what anyone said.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length > 0) fail(`unknown argument ${argv[0]} -- lint-once.mjs takes none`);

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
  let res;
  try {
    res = await fetch(`${hermesBase}/admin/relationship/lint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
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
    process.stdout.write(`${JSON.stringify({ error: res.status, message: 'non-JSON response' })}\n`);
    process.exit(1);
    return;
  }

  if (!res.ok) {
    process.stdout.write(`${JSON.stringify({ error: res.status, ...json })}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(`${JSON.stringify(json)}\n`);
}

main().catch((error) => fail(String(error?.message ?? error)));
