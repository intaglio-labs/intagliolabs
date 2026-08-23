#!/usr/bin/env node
// doctor — preflight and diagnosis for the connectors tier.
//
//   node connectors/doctor.mjs             human-readable report
//   node connectors/doctor.mjs --json      machine-readable report
//   node connectors/doctor.mjs --network   also probe the approved remote
//                                          endpoints (off by default so a
//                                          local diagnosis opens no sockets
//                                          to third parties)
//
// Exit code is 0 iff no check FAILed. WARNs do not fail the run: they name
// connectors that are disabled by design (no Oura tokens yet, no Gmail app
// password) or edges the store readers already handle.
//
// READ THE CAVEAT IN lib/checks.mjs BEFORE TRUSTING FDA ROWS FROM A SHELL:
// macOS attributes the Full Disk Access grant to the responsible process, so
// the fda-* checks only PASS when launchd spawns this process. A dev shell
// showing fda-* FAILs against a granted binary is expected; the fix text on
// each row carries the launchctl one-liner that yields the production truth.

import { pathToFileURL } from 'node:url';
import { runChecks } from './lib/checks.mjs';

function usage() {
  return 'usage: node connectors/doctor.mjs [--json] [--network]';
}

export async function main(argv = process.argv.slice(2)) {
  let json = false;
  let network = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--network') network = true;
    else {
      process.stderr.write(`unknown flag: ${arg}\n${usage()}\n`);
      return 2;
    }
  }

  const checks = await runChecks({ network });
  const fails = checks.filter((c) => c.status === 'FAIL').length;
  const warns = checks.filter((c) => c.status === 'WARN').length;
  const passes = checks.length - fails - warns;
  const ok = fails === 0;

  if (json) {
    process.stdout.write(
      JSON.stringify({ ok, network, passes, warns, fails, checks }, null, 2) + '\n'
    );
    return ok ? 0 : 1;
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  process.stdout.write(`hazlie doctor — ${checks.length} checks (network: ${network ? 'on' : 'off'})\n\n`);
  for (const c of checks) {
    process.stdout.write(` ${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}\n`);
    if (c.status !== 'PASS' && c.fix) {
      process.stdout.write(`        ${' '.repeat(width)} fix: ${c.fix}\n`);
    }
  }
  process.stdout.write(`\n${passes} PASS, ${warns} WARN, ${fails} FAIL\n`);
  if (!ok) {
    process.stdout.write(
      'fda-* FAILs from a dev shell do not indict the production grant — see the fix text on those rows.\n'
    );
  }
  return ok ? 0 : 1;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`doctor crashed: ${error?.stack ?? error}\n`);
      process.exit(2);
    }
  );
}
