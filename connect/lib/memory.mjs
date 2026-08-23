// The connect page's client for hermes' memory routes.
//
// WHY THIS IS AN HTTP CLIENT AND NOT A DATABASE HANDLE. connect could open
// context.db read-only — it already does exactly that for the Full Disk Access
// rows in status.mjs — and reading pending claims that way would be less code.
// It is not done, for two reasons worth keeping:
//
//   1. Decisions are WRITES, and hermes is the sole writer. A page that read
//      claims directly and wrote them through hermes would have two different
//      views of the same table, and the first bug would be a review page
//      showing a claim that had already been decided.
//   2. `claim_decision` has append-only triggers whose whole point is that
//      nothing else holds a writable handle. Opening one here would make that
//      guarantee a matter of this file's good behaviour.
//
// ui/AGENTS.md says courier must never hold a context-DB handle, and the same
// reasoning applies to connect. (Note the handoff's flag: courier's watch.mjs
// still DOES hold a read-only handle. Do not widen that by citing it as
// precedent. audit.mjs was the other exception and is gone — the energy digest
// was retired 2026-08-20, taking its read-only handle with it.)

import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_HERMES_BASE = 'http://127.0.0.1:8789';

// The bearer below authorizes hermes' /admin/* routes, so the base it rides
// to must be a loopback origin — the same refusal connectors/lib/
// ingestClient.mjs and this package's bridge.mjs (assertLoopbackBase) already
// make. HAZLIE_HERMES_URL has gone stale once before (the connect plist
// carried the retired 8790 tunnel port); a stale or mis-set value must throw
// here, not deliver the admin credential to whatever host it names. The throw
// surfaces as the review page's honest "could not reach its own store".
export function hermesBase(env = process.env) {
  let url;
  try {
    url = new URL(String(env.HAZLIE_HERMES_URL ?? DEFAULT_HERMES_BASE));
  } catch {
    throw new Error('hermes base must be an HTTP loopback origin');
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (
    url.protocol !== 'http:' ||
    !loopback ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('hermes base must be an HTTP loopback origin');
  }
  return url.origin;
}

// Read the bearer token with the same discipline the secret loaders use: a
// regular file, owner-only, no symlink. A world-readable token is not a token,
// and the honest response is to say the page cannot reach hermes rather than
// to send a credential that anyone on the machine could have replaced.
export function readToken({ home = homedir() } = {}) {
  const path = join(home, '.hazlie', 'secrets', 'hermes-token.txt');
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`${path} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} must be owner-only (chmod 600)`);
  const value = readFileSync(path, 'utf8').trim();
  if (value.length === 0) throw new Error(`${path} is empty`);
  return value;
}

async function call(path, { method = 'GET', body = null, env = process.env, home } = {}) {
  const token = readToken(home === undefined ? {} : { home });
  const res = await fetch(`${hermesBase(env)}${path}`, {
    method,
    // No Origin header, deliberately: admin routes are bearer-only and 403 the
    // browser channel. This is a server-to-server call that happens to be
    // triggered by a page load.
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === null ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(parsed?.error ?? `hermes returned ${res.status}`);
  }
  return parsed;
}

export function fetchPending(opts = {}) {
  return call('/admin/memory/pending', opts);
}

export function decide(claimId, action, opts = {}) {
  return call('/admin/memory/decide', {
    ...opts,
    method: 'POST',
    body: { claim_id: claimId, action },
  });
}
