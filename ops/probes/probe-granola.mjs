// Probe: does this Granola account's API key actually work against the
// official REST API?
//
// Granola currently gates personal API keys behind Business/Enterprise
// workspaces, so the connector's viability hinges on one live call — an
// entitlement preflight, not a schema question. GET /v1/folders is the
// cheapest authenticated endpoint; a 200 means the key and tier are good and
// the Granola connector proceeds, a 401/403 means the connector is descoped
// now rather than discovered dead in Phase 4. This egress is approved in
// AGENTS.md (official REST fetch-back of content Granola already holds); the
// MCP query_* tools are NOT approved and nothing here goes near them.
//
// The key is read with the same structural discipline as hermes'
// readSecretFile — non-symlink regular file, owner-only mode, owned by us,
// 0700 parent directory — but NOT its 64-hex format rule: that rule validates
// secrets hermes GENERATES, and Granola issues its own opaque token format.
// The relaxed rule here is one non-empty line of printable non-whitespace.
//
// Prints HTTP status and a folder COUNT only — never a folder name or id.
// Needs no FDA and no launchd; runs directly. No TTY assumed.
// Exit: 0 PASS · 2 BLOCKED (no key provisioned) · 1 FAIL.

import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY_PATH = join(homedir(), '.hazlie', 'secrets', 'granola-api-key.txt');

const done = (status, part, evidence) => {
  console.log(`${status} ${part}: ${evidence}`);
  console.log(`RESULT probe-granola: ${status}`);
  process.exit(status === 'PASS' ? 0 : status === 'BLOCKED' ? 2 : 1);
};

function readGranolaKey() {
  let info;
  try {
    info = lstatSync(KEY_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      done(
        'BLOCKED',
        'granola key',
        `${KEY_PATH} is missing; create it 0600 inside the 0700 secrets directory with the ` +
          'API key from Granola settings'
      );
    }
    throw error;
  }
  if (!info.isFile()) done('FAIL', 'granola key', 'key path must be a regular, non-symlink file');
  if ((info.mode & 0o077) !== 0) {
    done('FAIL', 'granola key', 'key file must not be accessible by group or other users');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    done('FAIL', 'granola key', 'key file must be owned by the connectors user');
  }
  const dirMode = statSync(dirname(KEY_PATH)).mode & 0o777;
  if (dirMode !== 0o700) {
    done('FAIL', 'granola key', `secrets directory must have mode 0700 (is ${dirMode.toString(8)})`);
  }
  const key = readFileSync(KEY_PATH, 'utf8').trim();
  if (key.length === 0 || /\s/.test(key) || !/^[\x21-\x7e]+$/.test(key)) {
    done('FAIL', 'granola key', 'key file must hold one non-empty line of printable non-whitespace');
  }
  return key;
}

const key = readGranolaKey();

let res;
try {
  res = await fetch('https://public-api.granola.ai/v1/folders', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    // A misbehaving endpoint must not bounce the Authorization header to a
    // host we never approved.
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
} catch (error) {
  done('FAIL', 'granola preflight', `request failed: ${error.cause?.code ?? error.name}`);
}

if (res.status === 401 || res.status === 403) {
  done(
    'FAIL',
    'granola preflight',
    `HTTP ${res.status} — key rejected; personal API keys currently require a ` +
      'Business/Enterprise workspace, so the Granola connector is descoped until the tier changes'
  );
}
if (res.status !== 200) {
  done('FAIL', 'granola preflight', `HTTP ${res.status} from /v1/folders`);
}

let body;
try {
  body = await res.json();
} catch {
  done('FAIL', 'granola preflight', 'HTTP 200 but the body is not JSON');
}
// Count whatever array the response carries without assuming its exact
// envelope; only the COUNT ever reaches stdout, never a folder name.
const list = Array.isArray(body)
  ? body
  : Array.isArray(body?.folders)
    ? body.folders
    : Array.isArray(body?.data)
      ? body.data
      : null;
if (list === null) {
  done(
    'PASS',
    'granola preflight',
    `HTTP 200; entitlement confirmed, but the folder count was unrecognizable ` +
      `(top-level keys: ${Object.keys(body ?? {}).join(', ') || '(none)'})`
  );
}
done('PASS', 'granola preflight', `HTTP 200; folder count: ${list.length}`);
