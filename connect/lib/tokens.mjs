// Connect-link tokens: mint, persist, validate, revoke.
//
// The token IS the authentication for the connect page. There is no account,
// no password and no Firebase, because there is nothing to disambiguate: the
// page runs on the owner's own Mac, binds loopback, and the link reaches the
// owner over iMessage's end-to-end encryption. Possession of the token plus
// the ability to reach 127.0.0.1 on this machine is the proof.
//
// That places the whole security burden here, so:
//   - 16 bytes of entropy, compared in constant time
//   - an expiry, because a link that lives in a Messages thread forever is a
//     credential that lives in a Messages thread forever
//   - revocation, so finishing onboarding closes the door behind it
//   - 0600 on the store, 0700 on its directory, same standard as every other
//     secret in ~/.hazlie

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function defaultTokenStorePath(home = homedir()) {
  return join(home, '.hazlie', 'connect', 'tokens.json');
}

function readStore(path) {
  if (!existsSync(path)) return { tokens: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.tokens) ? parsed : { tokens: [] };
  } catch {
    // A corrupt store must not lock the owner out of onboarding forever; the
    // cost of discarding it is one dead link and one re-send.
    return { tokens: [] };
  }
}

function writeStore(path, store) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode is filtered by umask; be explicit
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// Expired entries are dropped on every write rather than swept on a timer: the
// store is touched only during onboarding, so there is no loop to hang one on.
function prune(tokens, now) {
  return tokens.filter((t) => t.expiresAt > now && !t.revokedAt);
}

export function mintToken({
  path = defaultTokenStorePath(),
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
  rng = randomBytes,
} = {}) {
  const token = rng(16).toString('base64url');
  const store = readStore(path);
  store.tokens = prune(store.tokens, now);
  // MINTING A NEW LINK REVOKES THE OLD ONES.
  //
  // This file said revocation "closes the door behind onboarding" and nothing
  // ever called revokeToken or revokeAll, so live links simply accumulated for
  // their full 24 hours — every restart of the connect agent added one more.
  //
  // Revoking on onboarding-COMPLETION was considered and rejected: "done" is
  // genuinely ambiguous (one connector? all of them? they come back next week
  // to add another), and guessing wrong locks the owner out mid-setup, which
  // is worse than a link living out its TTL. Re-minting is unambiguous — the
  // owner is asking for a new link right now, so the previous one dying is
  // exactly what they expect, and there is no moment where they hold a link
  // that has silently stopped working.
  const superseded = store.tokens.length;
  for (const t of store.tokens) t.revokedAt = now;
  store.tokens.push({ token, createdAt: now, expiresAt: now + ttlMs, revokedAt: null });
  writeStore(path, store);
  return { token, expiresAt: now + ttlMs, superseded };
}

// Constant-time comparison against every live token. The loop is over a
// handful of entries and each comparison is fixed-cost, so a timing signal
// cannot reveal which token matched — only how many are stored.
export function validateToken(candidate, { path = defaultTokenStorePath(), now = Date.now() } = {}) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const supplied = Buffer.from(candidate);
  let matched = false;
  for (const entry of readStore(path).tokens) {
    const known = Buffer.from(entry.token);
    if (known.length !== supplied.length) continue;
    if (!timingSafeEqual(known, supplied)) continue;
    if (entry.revokedAt) continue;
    if (entry.expiresAt <= now) continue;
    matched = true;
  }
  return matched;
}

export function revokeToken(candidate, { path = defaultTokenStorePath(), now = Date.now() } = {}) {
  const store = readStore(path);
  let revoked = false;
  for (const entry of store.tokens) {
    if (entry.token === candidate && !entry.revokedAt) {
      entry.revokedAt = now;
      revoked = true;
    }
  }
  if (revoked) writeStore(path, store);
  return revoked;
}

export function revokeAll({ path = defaultTokenStorePath(), now = Date.now() } = {}) {
  const store = readStore(path);
  let n = 0;
  for (const entry of store.tokens) {
    if (!entry.revokedAt) {
      entry.revokedAt = now;
      n += 1;
    }
  }
  if (n) writeStore(path, store);
  return n;
}
