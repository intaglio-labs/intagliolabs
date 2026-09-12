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
//
// A THIRD PLACE THEY CAN LIVE: SHIPPED WITH THE APP.
//
// Both shapes above describe ~/.hazlie/secrets, which on a machine that has
// never run this before is an EMPTY DIRECTORY — so onboarding's "sign in to
// google" button had nothing to sign in with, the helper exited before
// printing, and the owner got a button that did nothing (found live on the
// clean-machine retest, 2026-09-12). widget/build.sh now stages the build
// machine's registered clients into the bundle at ops/google-clients/, and
// this module reads them when the secrets directory has no file of that name.
//
// A DESKTOP CLIENT SECRET IS NOT A SECRET, which is what makes that safe to
// ship: RFC 8252 §8.5 says a native app cannot keep one, Google issues Desktop
// credentials on that understanding, and the security of the flow rests on
// PKCE and the loopback redirect instead. It is the same trade already written
// down for the Telegram api_id in widget/build.sh. So bundled files are read
// with a plain read and NOT through readSecretJson: that gauntlet demands 0600
// and an 0700 parent, and a file inside a signed app bundle is world-readable
// by design and would fail every time.
//
// A SECRETS-DIR FILE OF THE SAME NAME ALWAYS WINS. The bundle is a default the
// build machine chose; ~/.hazlie is what this install chose, and an owner who
// drops in a re-issued credential must not be silently overruled by the copy
// inside the .app.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOwnerOnlyFile, readSecretJson, readSecretLine } from './secrets.mjs';

const PREFIX = 'google-client-';
const SUFFIX = '.json';

export const DEFAULT_CLIENT = 'default';

const secretsDir = (home) => join(home, '.hazlie', 'secrets');
const legacyIdPath = (home) => join(secretsDir(home), 'gcal-client-id.txt');
const legacySecretPath = (home) => join(secretsDir(home), 'gcal-client-secret.txt');

export const googleClientPath = (name, home = homedir()) =>
  join(secretsDir(home), `${PREFIX}${name}${SUFFIX}`);

/**
 * Where widget/build.sh stages this build's registered clients.
 *
 * Resolved against THIS MODULE, not the process's working directory, because
 * the same relative path has to land in two layouts: connectors/lib/../../ops
 * is the repo root's ops/ in a checkout and Contents/Resources/backend/ops in
 * the app bundle. ops/features.json is already carried by exactly that trick
 * (connectors/lib/features.mjs), and build.sh copies both into the same dir.
 */
export const bundledClientsDir = () =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ops', 'google-clients');

// Plain read, no permission gauntlet — see the header. Returns null for
// anything that is not a usable client, so one malformed file shipped in a
// bundle cannot take the others down with it.
function readClientFile(path) {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    if (!c?.client_id || !c?.client_secret) return null;
    return c;
  } catch {
    return null;
  }
}

// ONE RULE FOR WHAT COUNTS AS A CLIENT FILE, APPLIED BY ALL THREE READERS
// (round-4 finding 7).
//
// Selection (listGoogleClients, defaultGoogleClient) used to enumerate the
// secrets directory with a plain read while readGoogleClient put the very same
// file through readSecretJson's 0600-file/0700-parent gauntlet. The two
// disagreed, and the disagreement had teeth: a client hand-created under umask
// 022 was OFFERED as the default and then threw when read, and because a
// secrets-dir file shadows the bundled client of the same name, adding that
// file made a working install stop working.
//
// The rule, now decided in one place: a credential in ~/.hazlie/secrets IS a
// secret and is held to the gauntlet; one inside the app bundle is not and
// never was (see the header -- a file in a signed .app is world-readable by
// design and would fail every time). A secrets file that fails the gauntlet is
// therefore not a client at all: selection does not offer it, and it does not
// shadow the bundled copy that still works.
//
// It is not silent. The read path below falls back to the bundle and, when
// there is no bundle to fall back to, still throws the gauntlet's own message
// naming the file and the mode it needs.
function readGuardedClientFile(path) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = assertOwnerOnlyFile(path, { label: 'google client' });
  } catch {
    return null;
  }
  try {
    const c = JSON.parse(raw);
    if (!c?.client_id || !c?.client_secret) return null;
    return c;
  } catch {
    return null;
  }
}

// Every `google-client-<name>.json` in one directory, newest caller wins.
// Used for both the secrets dir and the bundle so the two are read by the
// same rules and can be merged without either shape being special.
// `guarded` says which side of the rule above the directory sits on.
function clientsIn(dir, { guarded = false } = {}) {
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of names) {
    if (!file.startsWith(PREFIX) || !file.endsWith(SUFFIX)) continue;
    const path = join(dir, file);
    const c = guarded ? readGuardedClientFile(path) : readClientFile(path);
    if (!c) continue; // malformed or not owner-only; the read path says which
    const name = file.slice(PREFIX.length, -SUFFIX.length);
    out.push({
      name,
      label: typeof c.label === 'string' && c.label ? c.label : name,
      // An install with several registered clients and no legacy pair needs a
      // tiebreak that the build machine can set. `"default": true` in the
      // credential is it; see defaultGoogleClient.
      preferred: c.default === true,
    });
  }
  return out;
}

/**
 * Read one client's credentials, at USE TIME (connectors/AGENTS.md — a
 * re-issued secret must take effect without a daemon restart).
 *
 * A grant issued before clients were named carries no `client`, so an absent
 * or unknown name resolves to the legacy pair rather than throwing. That is
 * the whole backward-compatibility story: old token, old credential, no
 * migration, still refreshes.
 *
 * THE LEGACY PAIR IS NEVER SUBSTITUTED FOR BY SOME OTHER CLIENT. A grant
 * carrying no `client` was issued by those two files, and Google will not
 * renew it against a different credential — pairing it with whatever else the
 * bundle happens to hold would turn a legible "credential missing" into an
 * invalid_grant an hour later. The one thing that may stand in for the pair
 * when it is absent is a file someone deliberately named `default`, because
 * naming it that IS the claim that it is the same client. Callers that are
 * CHOOSING a client rather than honouring a grant ask defaultGoogleClient
 * first, which is allowed to answer with any bundled one.
 */
export function readGoogleClient(
  name = DEFAULT_CLIENT,
  { home = homedir(), bundledDir = bundledClientsDir() } = {}
) {
  if (name && name !== DEFAULT_CLIENT) {
    const path = googleClientPath(name, home);
    // SAME ORDER AS SELECTION, SAME RULE (round-4 finding 7). A usable
    // secrets-dir file wins; one that is absent OR that the gauntlet rejects
    // falls through to the bundle, which is exactly the set of files
    // listGoogleClients/defaultGoogleClient would have offered. Only when
    // nothing is usable anywhere does readSecretJson run, and then its throw is
    // the diagnostic: it names the file, and whether the problem is a missing
    // file, a mode, a parse or a missing key.
    const mine = readGuardedClientFile(path);
    if (mine) {
      return { name, id: mine.client_id, secret: mine.client_secret, label: mine.label ?? name };
    }
    const bundled = readClientFile(join(bundledDir, `${PREFIX}${name}${SUFFIX}`));
    if (bundled) {
      return {
        name,
        id: bundled.client_id,
        secret: bundled.client_secret,
        label: bundled.label ?? name,
      };
    }
    const c = readSecretJson(path, {
      label: `google client "${name}"`,
      setupHint: 'run `node ops/gcal-auth.mjs --help` for how to register one',
      requiredKeys: ['client_id', 'client_secret'],
    });
    return { name, id: c.client_id, secret: c.client_secret, label: c.label ?? name };
  }
  // BOTH LEGACY FILES, because it takes both to be the legacy pair — which is
  // what listGoogleClients and defaultGoogleClient have always required
  // (round-4 finding 10). Testing only the id file meant a half-present pair
  // (a secret deleted, a restore that dropped one) skipped the named/bundled
  // default entirely and fell to readSecretLine, which threw on the missing
  // half: the sign-in button 502'd on a machine that was holding a perfectly
  // usable bundled credential the whole time. With both tested, a half pair is
  // no pair, the bundled default answers, and the throw below is reached only
  // when there is genuinely nothing to sign in with.
  if (!(existsSync(legacyIdPath(home)) && existsSync(legacySecretPath(home)))) {
    const named = `${PREFIX}${DEFAULT_CLIENT}${SUFFIX}`;
    const c =
      readGuardedClientFile(join(secretsDir(home), named))
      ?? readClientFile(join(bundledDir, named));
    if (c) {
      return {
        name: DEFAULT_CLIENT,
        id: c.client_id,
        secret: c.client_secret,
        label: c.label ?? 'default',
      };
    }
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
 *
 * Bundled clients are merged in under the same names, and a secrets-dir file
 * shadows the bundled one it shares a name with.
 */
export function listGoogleClients({ home = homedir(), bundledDir = bundledClientsDir() } = {}) {
  const out = [];
  if (existsSync(legacyIdPath(home)) && existsSync(legacySecretPath(home))) {
    out.push({ name: DEFAULT_CLIENT, label: 'default' });
  }
  const merged = new Map();
  for (const c of clientsIn(bundledDir)) merged.set(c.name, c);
  for (const c of clientsIn(secretsDir(home), { guarded: true })) merged.set(c.name, c);
  for (const c of merged.values()) {
    if (c.name === DEFAULT_CLIENT && out.length) continue; // the legacy pair already claimed it
    out.push({ name: c.name, label: c.label });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * WHICH CLIENT TO SIGN A NEW ACCOUNT IN WITH, when the caller has not named
 * one. Distinct from readGoogleClient(DEFAULT_CLIENT), which honours an
 * EXISTING grant and must therefore mean the legacy pair and nothing else.
 *
 * Returns `{ name, label }`, or null when this machine holds no client at all
 * — which is a real state on a fresh install built without one, and the one
 * the caller has to say out loud rather than spawn a helper that exits.
 *
 * The order is oldest-commitment-first:
 *   1. the legacy pair, because every existing grant on such an install was
 *      issued by it and a second client is not what that install asked for;
 *   2. the only registered client, when there is exactly one — no choice to
 *      get wrong;
 *   3. the one marked `"default": true`, which is how a build machine that
 *      ships several says which is the front door;
 *   4. nothing. Guessing between two clients would hand half the accounts a
 *      credential whose refresh Google declines.
 */
export function defaultGoogleClient({ home = homedir(), bundledDir = bundledClientsDir() } = {}) {
  if (existsSync(legacyIdPath(home)) && existsSync(legacySecretPath(home))) {
    return { name: DEFAULT_CLIENT, label: 'default' };
  }
  const merged = new Map();
  for (const c of clientsIn(bundledDir)) merged.set(c.name, c);
  for (const c of clientsIn(secretsDir(home), { guarded: true })) merged.set(c.name, c);
  const rows = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (rows.length === 1) return { name: rows[0].name, label: rows[0].label };
  const marked = rows.find((c) => c.preferred);
  if (marked) return { name: marked.name, label: marked.label };
  return null;
}
