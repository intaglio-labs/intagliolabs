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
// The account's address is IN the file rather than only in its name. The name
// is a slug and slugs are lossy: `a.b@x.co` and `a-b@x.co` slug identically,
// and reading the address back out of a filename would eventually hand the
// wrong label to a row. The filename is for finding; `account_email` is for
// naming.
//
// NOT A SECRET, but these files hold refresh tokens, so every read goes
// through the same owner-only gauntlet as every other credential here.

import { readdirSync } from 'node:fs';
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
  return join(googleSecretsDir(home), `${PREFIX}${googleAccountSlug(email)}${SUFFIX}`);
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
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export function accountsWithScope(scope, opts = {}) {
  return listGoogleAccounts(opts).filter((a) => !a.problem && a.scopes.includes(scope));
}
