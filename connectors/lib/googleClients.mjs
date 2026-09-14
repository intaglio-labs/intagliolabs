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
//
// AND IT WINS EVEN WHEN IT IS BROKEN (round-5 finding 2). "Wins" is about the
// NAME, not about being readable: a secrets file that fails the permission
// gauntlet is an error naming the file and the fix, never a quiet fall back to
// the bundled credential of the same name. See guardedClientFile below for
// why that distinction is the difference between a message the owner can act
// on and a mailbox that dies an hour later.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
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
// (round-4 finding 7, corrected by round-5 findings 2 and 3).
//
// Selection (listGoogleClients, defaultGoogleClient) used to enumerate the
// secrets directory with a plain read while readGoogleClient put the very same
// file through readSecretJson's 0600-file/0700-parent gauntlet. The two
// disagreed, and the disagreement had teeth: a client hand-created under umask
// 022 was OFFERED as the default and then threw when read.
//
// Round 4 settled the disagreement the wrong way round. It made a secrets file
// that fails the gauntlet "not a client at all", so the BUNDLED file of the
// same name answered instead -- which is the one substitution this module
// exists to prevent. `~/.hazlie/secrets/google-client-work.json` restored at
// 0644 by an rsync, beside a bundled `google-client-work.json` holding a
// different client_id, meant every grant carrying `client: "work"` was
// refreshed against a credential that did not mint it: invalid_grant an hour
// later, and nothing anywhere naming the mode. Finding 3 is the same failure
// one level up -- `chmod 755 ~/.hazlie/secrets` fails the gauntlet for EVERY
// file at once, so every named client on the machine would have been swapped
// for the bundle's in one step.
//
// So the rule, decided in one place and the same for all three readers:
//
//   ABSENT      the bundle answers. That is what the bundle is for.
//   PRESENT     the file owns its name, usable or not. It is never stood in
//               for by a same-named bundled credential, because a grant can
//               only be renewed by the client that issued it, and a legible
//               "fix this file" beats a dead mailbox an hour later.
//
// Which leaves what SELECTION shows for a present file it cannot use, and the
// two reasons it cannot are not the same reason:
//
//   REFUSED     mode, ownership, a symlink, or a parent directory that is not
//               0700. The credential inside may be perfectly good; this is the
//               reader declining to trust it, and it is the failure that hits
//               every file at once when ~/.hazlie/secrets is 0755. So the name
//               is offered, carrying `unusable`. Withholding it would leave
//               ops/gcal-auth.mjs saying "no Google OAuth client is installed
//               on this Mac" about a machine holding one with the wrong mode --
//               true about the state, useless about the cause.
//   MALFORMED   not JSON, or no client_id/client_secret. There is no
//               credential in it to offer, so selection skips it exactly as it
//               always has; the read still throws rather than substituting.
//
// A credential inside the app bundle is not a secret and never was (see the
// header: a file in a signed .app is world-readable by design and would fail
// the gauntlet every time), so the bundle keeps its plain read.
//
// Returns exactly one of:
//   { client }                          usable
//   { absent: true }                    nothing at that path
//   { problem, refused: true }          present, and the gauntlet said no
//   { problem, malformed: true }        present, and there is no credential in it
function guardedClientFile(path) {
  // lstat, not existsSync: a dangling symlink "does not exist" to existsSync,
  // and treating one as ABSENT would hand its name back to the bundle -- the
  // substitution above, reached through a link the owner can see in the
  // directory listing.
  try {
    lstatSync(path);
  } catch {
    return { absent: true };
  }
  let raw;
  try {
    raw = assertOwnerOnlyFile(path, { label: 'google client' });
  } catch (error) {
    return { problem: error?.message ?? String(error), refused: true };
  }
  let c;
  try {
    c = JSON.parse(raw);
  } catch {
    return { problem: `google client file is not valid JSON: ${path}`, malformed: true };
  }
  if (!c?.client_id || !c?.client_secret) {
    return {
      problem: `google client file is missing client_id or client_secret: ${path}`,
      malformed: true,
    };
  }
  return { client: c };
}

// The sentence a caller that cannot use the file should throw or show. Says
// what is wrong, and says out loud that the bundled copy is NOT going to be
// used instead -- otherwise the obvious next thought ("the app ships one, why
// is it not just using that") is exactly the wrong one.
//
// EXPORTED, BECAUSE THE SENTENCE HAS TO REACH THE OWNER AND THIS THROW IS NOT
// HOW IT GETS THERE (round-6 finding 4). The throw reaches ops/gcal-auth.mjs,
// which prints it on stderr and exits; connect spawned that helper with stderr
// discarded and answered a generic 502, so the one actionable message on the
// machine was composed, printed and thrown away. connect/server.mjs now refuses
// before it spawns anything when the chosen client carries `unusable`, and
// composes that refusal from here so the page, the helper and this module all
// say the same thing.
export function unusableClientMessage(name, problem) {
  return `google client "${name}" is unusable: ${problem}. Fix the file (mode 0600, inside a `
    + '0700 directory) or remove it; a credential shipped with the app is not substituted '
    + 'for it, because Google refuses to refresh a grant against a client that did not '
    + 'issue it';
}

function unusableClientError(name, problem) {
  return new Error(unusableClientMessage(name, problem));
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
    const name = file.slice(PREFIX.length, -SUFFIX.length);
    if (!guarded) {
      // A malformed file SHIPPED IN A BUNDLE is skipped rather than offered:
      // nobody on this machine can fix it, and one bad staged credential must
      // not cost the others their row.
      const c = readClientFile(path);
      if (!c) continue;
      out.push({
        name,
        label: typeof c.label === 'string' && c.label ? c.label : name,
        // An install with several registered clients and no legacy pair needs a
        // tiebreak that the build machine can set. `"default": true` in the
        // credential is it; see defaultGoogleClient.
        preferred: c.default === true,
      });
      continue;
    }
    const held = guardedClientFile(path);
    if (held.absent || held.malformed) continue; // nothing there to offer
    if (held.refused) {
      // OFFERED, AND SAID TO BE BROKEN. The name is taken -- the owner put a
      // file there -- so it must not silently become the bundle's. `label`
      // stays the bare name because the file's own label was never read.
      out.push({ name, label: name, preferred: false, unusable: held.problem });
      continue;
    }
    const c = held.client;
    out.push({
      name,
      label: typeof c.label === 'string' && c.label ? c.label : name,
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
    // SAME ORDER AS SELECTION, SAME RULE. A usable secrets-dir file wins; an
    // ABSENT one falls through to the bundle; a PRESENT one that the gauntlet
    // rejects stops here with the gauntlet's own sentence (round-5 finding 2).
    // Falling through on a rejection is what paired a live `client: "work"`
    // grant with the bundle's unrelated `work` credential -- a substitution
    // Google answers with invalid_grant an hour later, while every surface on
    // this machine still reads "connected". Only when nothing is present
    // anywhere does readSecretJson run, and then its throw is the diagnostic:
    // it names the file, and whether the problem is a missing file, a mode, a
    // parse or a missing key.
    const mine = guardedClientFile(path);
    if (mine.client) {
      return {
        name,
        id: mine.client.client_id,
        secret: mine.client.client_secret,
        label: mine.client.label ?? name,
      };
    }
    if (mine.problem) throw unusableClientError(name, mine.problem);
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
    // Same three-way answer as the named branch above: a `google-client-
    // default.json` the owner put here and got the mode wrong on is an error,
    // not a reason to sign in under the build machine's default instead.
    const held = guardedClientFile(join(secretsDir(home), named));
    if (held.problem) throw unusableClientError(DEFAULT_CLIENT, held.problem);
    const c = held.client ?? readClientFile(join(bundledDir, named));
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
 * choice. A malformed BUNDLED credential is skipped rather than thrown: one
 * bad staged file must not cost the others their row.
 *
 * Bundled clients are merged in under the same names, and a secrets-dir file
 * shadows the bundled one it shares a name with — including a secrets file
 * that cannot be read, which carries `unusable` (the sentence saying why)
 * instead of being dropped. Dropping it would hand its name back to the
 * bundle, and a caller comparing this list against a grant's `client` would
 * see a name that still resolves while resolving to the wrong credential.
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
    out.push({ name: c.name, label: c.label, ...(c.unusable ? { unusable: c.unusable } : {}) });
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
 *
 * A secrets file that cannot be read counts as a client here (round-5
 * finding 3). Skipping it would answer null on a machine whose one credential
 * is sitting in ~/.hazlie/secrets with the wrong mode, and null is rendered by
 * ops/gcal-auth.mjs as "no Google OAuth client is installed on this Mac" —
 * true about the state and useless about the cause. Returned, the read that
 * follows names the file and the mode.
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
