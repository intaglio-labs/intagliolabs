// Spawn the Calendar/Contacts helper and hand back what it read.
//
// WHY THERE IS A HELPER AT ALL. Both of those sources used to be reachable only
// by opening the backing sqlite store -- Calendar.sqlitedb, AddressBook-v22.abcddb
// -- which is Full Disk Access. EventKit and the Contacts framework each have
// their own TCC permission scoped to just that data, but they are native APIs
// and this daemon is Node, so a small Swift binary does the call and answers in
// JSON. See widget/helpers/AppleData.swift.
//
// It ships inside the app bundle, beside the backend this file is part of, and
// is spawned as a child so TCC attributes the access to the app and the grants
// the owner already gave it.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// connectors/lib/ -> connectors/ -> backend/, where build.sh puts helpers/.
const here = dirname(fileURLToPath(import.meta.url));
export const HELPER_PATH = join(here, '..', '..', 'helpers', 'apple-data');

/// exit(2) is the helper's "not permitted", kept distinct from a crash so a
/// denial can be reported as a missing grant rather than a broken helper.
export const NOT_PERMITTED = 2;

export function helperAvailable(path = HELPER_PATH) {
  return existsSync(path);
}

export class AppleDataError extends Error {
  constructor(message, { code, denied = false } = {}) {
    super(message);
    this.name = 'AppleDataError';
    this.code = code;
    this.denied = denied;
  }
}

// Run one subcommand and parse its stdout.
//
// stdout is the data and can be large (a decade of occurrences), so it is
// collected as chunks and joined once. stderr is counts and reasons only -- the
// helper is built never to write row content there -- so it is safe to put a
// failure's stderr into an error message.
export function runHelper(args, { path = HELPER_PATH, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!helperAvailable(path)) {
      reject(new AppleDataError(`helper not found at ${path}`, { code: 'ENOENT' }));
      return;
    }
    const child = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new AppleDataError(`helper timed out after ${timeoutMs}ms`, { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AppleDataError(`helper failed to start: ${error.message}`, { code: error.code }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code === NOT_PERMITTED) {
        reject(new AppleDataError(stderr || 'access not granted', { code, denied: true }));
        return;
      }
      if (code !== 0) {
        reject(new AppleDataError(stderr || `helper exited ${code}`, { code }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')));
      } catch (error) {
        reject(new AppleDataError(`helper returned unparseable JSON: ${error.message}`, { code }));
      }
    });
  });
}

// Apple absolute seconds: the epoch the helper speaks, and the same units the
// sqlite stores hold, so neither side converts.
const APPLE_EPOCH_MS = 978_307_200_000;
export const msToAppleSeconds = (ms) => (ms - APPLE_EPOCH_MS) / 1000;

export function readEvents({ fromTs, toTs }, opts = {}) {
  return runHelper(
    ['events', '--from', String(msToAppleSeconds(fromTs)), '--to', String(msToAppleSeconds(toTs))],
    opts
  );
}

export function readContacts(opts = {}) {
  return runHelper(['contacts'], opts);
}
