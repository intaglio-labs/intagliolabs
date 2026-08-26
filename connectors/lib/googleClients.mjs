// WHICH GOOGLE OAUTH CLIENTS THIS MAC HOLDS CREDENTIALS FOR.
//
// A refresh token can only ever be renewed by the CLIENT THAT ISSUED IT.
// Google rejects the pairing outright, so the moment there is more than one
// client, "which client" stops being configuration and becomes a property of
// each individual grant. That is why token files carry `client` and why this
// module exists: with one client the question never came up, and the answer
// was hardcoded in two places.
//
// WHY MORE THAN ONE. An Internal client authorizes only accounts inside its
// own Workspace, and in exchange gives grants that never expire, no
// verification gate, and no cap. An External client takes any Google account —
// including a personal one — but is limited to 100 sensitive-scope logins for
// the lifetime of the project, never resettable, and every re-authorization
// spends one. So the right client differs per account, and using the External
// one for everything would spend a finite resource on accounts that did not
// need it (owner, 2026-08-26).
//
// TWO SHAPES ON DISK, because the first install predates the second:
//
//   gcal-client-id.txt + gcal-client-secret.txt   -> the client named "default"
//   google-client-<name>.json                     -> { client_id, client_secret, label }
//
// The legacy pair is not migrated. It works, it is what every existing token
// was issued by, and rewriting a live credential to tidy a filename is how an
// install stops being able to refresh.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSecretJson, readSecretLine } from './secrets.mjs';

const PREFIX = 'google-client-';
const SUFFIX = '.json';

export const DEFAULT_CLIENT = 'default';

const secretsDir = (home) => join(home, '.hazlie', 'secrets');
const legacyIdPath = (home) => join(secretsDir(home), 'gcal-client-id.txt');
const legacySecretPath = (home) => join(secretsDir(home), 'gcal-client-secret.txt');

export const googleClientPath = (name, home = homedir()) =>
  join(secretsDir(home), `${PREFIX}${name}${SUFFIX}`);

/**
 * Read one client's credentials, at USE TIME (connectors/AGENTS.md — a
 * re-issued secret must take effect without a daemon restart).
 *
 * A grant issued before clients were named carries no `client`, so an absent
 * or unknown name resolves to the legacy pair rather than throwing. That is
 * the whole backward-compatibility story: old token, old credential, no
 * migration, still refreshes.
 */
export function readGoogleClient(name = DEFAULT_CLIENT, { home = homedir() } = {}) {
  if (name && name !== DEFAULT_CLIENT) {
    const path = googleClientPath(name, home);
    const c = readSecretJson(path, {
      label: `google client "${name}"`,
      setupHint: 'run `node ops/gcal-auth.mjs --help` for how to register one',
      requiredKeys: ['client_id', 'client_secret'],
    });
    return { name, id: c.client_id, secret: c.client_secret, label: c.label ?? name };
  }
  return {
    name: DEFAULT_CLIENT,
    id: readSecretLine(legacyIdPath(home), { label: 'google client id' }),
    secret: readSecretLine(legacySecretPath(home), { label: 'google client secret' }),
    label: 'default',
  };
}

/**
 * Every client this machine can sign in with, for a UI that has to offer a
 * choice. Unreadable entries are skipped rather than thrown: one malformed
 * credential must not cost the others their row.
 */
export function listGoogleClients({ home = homedir() } = {}) {
  const out = [];
  if (existsSync(legacyIdPath(home)) && existsSync(legacySecretPath(home))) {
    out.push({ name: DEFAULT_CLIENT, label: 'default' });
  }
  let names = [];
  try {
    names = readdirSync(secretsDir(home));
  } catch {
    return out;
  }
  for (const file of names) {
    if (!file.startsWith(PREFIX) || !file.endsWith(SUFFIX)) continue;
    const name = file.slice(PREFIX.length, -SUFFIX.length);
    try {
      const c = JSON.parse(readFileSync(join(secretsDir(home), file), 'utf8'));
      if (!c?.client_id || !c?.client_secret) continue;
      out.push({ name, label: typeof c.label === 'string' && c.label ? c.label : name });
    } catch {
      // malformed; the status page reports the account that needed it
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
