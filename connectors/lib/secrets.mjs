// Secret-file discipline for the connectors, replicating hermes'
// readSecretFile checks (ui/server/hermes.mjs) for files hermes never reads:
// the Granola API key, the Gmail app password, the Oura OAuth token file.
// Hermes cannot loan us its loader — it validates 64-hex specifically, and a
// Granola key or an OAuth JSON blob is not that shape — so the CHECKS are
// replicated here and the shape validation is split per reader.
//
// Every check is load-bearing, same as the original:
//   lstat, not stat   a symlink is rejected instead of followed to a target
//                     whose mode says nothing about who can retarget the link
//   regular file      a FIFO or device node is not a secret
//   no group/other    an 0644 secret is not a secret
//   owner is us       a root-owned readable file smells like a copy mistake
//   parent dir 0700   an 0600 file inside a group-writable directory is not
//                     owner-only: whoever can write the directory can replace
//                     the file with their own
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function defaultHermesTokenPath(home = homedir()) {
  return join(home, '.hazlie', 'secrets', 'hermes-token.txt');
}

// The shared permission gauntlet. Throws with a human fix in the message;
// returns the file's contents as UTF-8 once every check passes. Exported so
// the daemon can hold config.json (not a secret, but it names mail accounts
// and folders) to the same standard.
export function assertOwnerOnlyFile(filePath, { label, setupHint = 'see ops/CONNECTORS.md' }) {
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} file is missing at ${filePath}; ${setupHint}`);
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new Error(`${label} path must be a regular, non-symlink file: ${filePath}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${label} file must not be accessible by group or other users: ${filePath}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`${label} file must be owned by the connectors user: ${filePath}`);
  }
  const parent = dirname(filePath);
  const parentMode = statSync(parent).mode & 0o777;
  if (parentMode !== 0o700) {
    throw new Error(
      `${label} directory must have mode 0700: ${parent} is ${parentMode.toString(8)}`
    );
  }
  return readFileSync(filePath, 'utf8');
}

// One-line secrets: the Granola API key, the Gmail app password, the hermes
// bearer token. The value is whatever the single line holds — no format is
// assumed here, because providers disagree (hex, base64-ish, spaced app
// passwords); the caller that knows the shape validates it.
export function readSecretLine(filePath, { label, setupHint } = {}) {
  if (!label) throw new Error('readSecretLine requires a label');
  const raw = assertOwnerOnlyFile(filePath, { label, setupHint });
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(`${label} file is empty: ${filePath}`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} file must hold exactly one line: ${filePath}`);
  }
  return value;
}

// JSON secret files — the Oura OAuth token store ({access_token,
// refresh_token, ...}). Same permission gauntlet, then a parse and a closed
// check that every key the caller depends on is actually present, so a
// half-written token file fails at read time with the missing key named
// rather than as an unauthorized API call an hour later.
export function readSecretJson(filePath, { label, setupHint, requiredKeys = [] } = {}) {
  if (!label) throw new Error('readSecretJson requires a label');
  const raw = assertOwnerOnlyFile(filePath, { label, setupHint });
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} file is not valid JSON: ${filePath}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} file must hold a JSON object: ${filePath}`);
  }
  for (const key of requiredKeys) {
    const held = value[key];
    if (held === undefined || held === null || held === '') {
      throw new Error(`${label} file is missing required key ${JSON.stringify(key)}: ${filePath}`);
    }
  }
  return value;
}

// The hermes bearer token, with the exact shape hermes generates and expects:
// one 256-bit lowercase-hex line from ops/setup-llm.sh. Validated here so a
// truncated copy fails at the connector with a real message instead of as a
// uniform 401 from hermes (which deliberately does not say why).
export function readHermesTokenFile(filePath = defaultHermesTokenPath()) {
  const value = readSecretLine(filePath, {
    label: 'Hermes bearer token',
    setupHint: 'run ops/setup-llm.sh',
  });
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Hermes bearer token must be one generated 256-bit hex key: ${filePath}`);
  }
  return value;
}
