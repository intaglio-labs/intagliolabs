// WHICH GOOGLE ACCOUNTS THIS MAC IS AUTHORIZED FOR, and where each one's
// tokens live. No network, no refresh, no API calls — just the filesystem
// question "whose mail and calendar may we read?", so the connect page, the
// mail connector and the calendar connector all get the same answer.
//
// ONE FILE PER ACCOUNT, and that is the whole point of this module.
// ~~A single ~/.hazlie/secrets/gcal-tokens.json.~~ One grant, one account, and
// the owner asked for several mailboxes (2026-08-26). A Google OAuth grant is
// per ACCOUNT — one refresh token authorizes one mailbox and one calendar —
// so more mailboxes means more grants, and more grants need somewhere to live
// that is not a single fixed filename.
//
// The account's address is IN the file rather than only in its name. The
// filename combines a readable, lossy slug with a hash that prevents slug
// collisions, but `account_email` remains the source of truth for naming.
//
// NOT A SECRET, but these files hold refresh tokens, so every read goes
// through the same owner-only gauntlet as every other credential here.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSecretJson } from './secrets.mjs';

const PREFIX = 'google-tokens-';
const SUFFIX = '.json';

export const googleSecretsDir = (home = homedir()) => join(home, '.hazlie', 'secrets');

// Same shape as connect/lib/status.mjs's mailSecretName and for the same
// reason: whatever an address contains, the filename it produces is
// [a-z0-9-] and cannot climb out of the secrets directory.
export function googleAccountSlug(email) {
  return String(email).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
}

export function googleTokensPath(email, home = homedir()) {
  const canonical = String(email).trim().toLowerCase();
  // The readable slug is lossy (`a.b@x.co` and `a-b@x.co` collide), so it may
  // never be the identity by itself. A hash of the complete canonical address
  // separates those accounts while keeping paths stable across case changes.
  // Bound the human-readable portion so an unusually long valid address cannot
  // exceed the filesystem's component limit.
  const slug = googleAccountSlug(canonical).slice(0, 80) || 'account';
  const fingerprint = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return join(googleSecretsDir(home), `${PREFIX}${slug}-${fingerprint}${SUFFIX}`);
}

/**
 * Every account with tokens on this machine.
 *
 * Returns [{ email, slug, tokensPath, scopes }], sorted by address so the
 * order is stable across runs — a connector that iterates these must not
 * reorder its work because readdir felt like it.
 *
 * A file that is unreadable, not owner-only, or missing its refresh token is
 * SKIPPED rather than thrown, and the reason rides along in `problem`. One
 * corrupt account must not cost the others their sync; the caller logs the
 * count and carries on. (Same call the mail connector already made about one
 * mailbox's app password failing.)
 */
export function listGoogleAccounts({ home = homedir() } = {}) {
  let names = [];
  try {
    names = readdirSync(googleSecretsDir(home));
  } catch {
    return []; // no secrets dir yet: nothing is authorized, which is not an error
  }
  const out = [];
  for (const name of names) {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    const tokensPath = join(googleSecretsDir(home), name);
    try {
      const t = readSecretJson(tokensPath, {
        label: 'google tokens',
        setupHint: 'run `node ops/gcal-auth.mjs` (browser consent)',
        requiredKeys: ['access_token', 'refresh_token'],
      });
      const email = typeof t.account_email === 'string' ? t.account_email : null;
      if (!email) {
        out.push({ email: null, slug: name.slice(PREFIX.length, -SUFFIX.length), tokensPath,
          scopes: [], problem: 'no account_email in the token file' });
        continue;
      }
      out.push({
        email,
        slug: googleAccountSlug(email),
        tokensPath,
        scopes: typeof t.scope === 'string' ? t.scope.split(/\s+/u).filter(Boolean) : [],
        // Set once a connector has been refused by Google. See
        // markGoogleAccountStale — nothing on disk reveals a dead grant, so
        // this is the only way a status check can know.
        stale: t.stale && typeof t.stale === 'object' ? t.stale : null,
        problem: null,
      });
    } catch (error) {
      out.push({ email: null, slug: name.slice(PREFIX.length, -SUFFIX.length), tokensPath,
        scopes: [], problem: error?.message ?? 'unreadable' });
    }
  }
  return out.sort((a, b) => String(a.email ?? a.slug).localeCompare(String(b.email ?? b.slug)));
}

// Accounts whose grant actually covers a capability. A token minted before a
// scope was added is a real state — the owner re-authorizes to widen it — and
// a connector must skip such an account rather than call and take a 403.
/**
 * Record that a grant is DEAD, so something other than a log can say so.
 *
 * A dead grant is invisible on disk. The token file still parses, still has
 * both tokens, still names its account — everything a status check can see
 * looks exactly like a working account, because the only way to learn
 * otherwise is to ask Google and be refused. So the connector that gets
 * refused is the one that has to write it down; nothing else is in a position
 * to know.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Without it a revoked or expired grant
 * is a mailbox that simply stops. No error the owner sees, no dot that
 * changes, no new mail — and the failure is silent for exactly as long as
 * nobody thinks to check. That is the worst shape a data connector can fail
 * in, and it is the ordinary outcome of a password change, a revoked app, or
 * an OAuth client still in Testing (where Google expires refresh tokens after
 * seven days).
 *
 * The tokens are KEPT, not cleared. They are useless, but the file is also
 * what remembers WHICH ACCOUNT this was — delete it and the row vanishes
 * instead of asking to be fixed, which is the same silence by another route.
 * A fresh authorization overwrites the whole file, so the mark clears itself.
 */
export function markGoogleAccountStale(tokensPath, reason) {
  try {
    const t = JSON.parse(readFileSync(tokensPath, 'utf8'));
    if (t.stale) return false; // already recorded; keep the FIRST time it broke
    const next = { ...t, stale: { since: Date.now(), reason: String(reason).slice(0, 200) } };
    const tmp = `${tokensPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, tokensPath);
    return true;
  } catch {
    // The file is gone or unreadable. That is its own kind of broken and the
    // status check reports it directly; failing here would turn a diagnosable
    // problem into a crash inside the connector that found it.
    return false;
  }
}

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

// Accounts a connector can actually USE: scoped, readable, and not already
// known dead. A stale account is deliberately excluded rather than retried —
// re-presenting a refused refresh token every tick earns nothing but rate
// limiting, and the owner has already been told. It comes back the moment a
// fresh authorization overwrites the file.
export function accountsWithScope(scope, opts = {}) {
  return listGoogleAccounts(opts)
    .filter((a) => !a.problem && !a.stale && a.scopes.includes(scope));
}

// Every account with the scope, dead ones included. The connect page needs
// this: a grant that has died is exactly the row it must still draw.
export function accountsWithScopeIncludingStale(scope, opts = {}) {
  return listGoogleAccounts(opts).filter((a) => !a.problem && a.scopes.includes(scope));
}
