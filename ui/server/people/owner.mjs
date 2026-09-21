// Who "the owner" is, read from the LOCAL connectors config — never hardcoded
// in committed source. The owner's own email addresses and name are personal
// data; a private repo is not an excuse to bake them into a tracked file, and
// the config already holds them (selfName, and each mail account's address).
//
// Returns { addresses: Set<string>, names: string[], keys: Set<string> } — the
// addresses that mean "from me", names that mean "the owner", and explicitly
// owner-marked graph identities. Callers pass this into buildGraph so the graph
// module carries no identity.
//
// The addresses come from three places, all local: the Google grants on this
// machine (which is where an OAuth install's mailboxes actually are), the
// legacy `mail.accounts[].user` array, and the `ownerEmails` aliases the owner
// listed by hand. Nothing is inferred from the corpus.

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { listGoogleAccounts } from '../../../connectors/lib/googleAccounts.mjs';

const RELATIONSHIP_ROLES = new Set(['friend', 'business', 'romantic', 'family']);
const SUB_ROLES = new Set(['investor', 'founder', 'operator']);

export function ownerConfigPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'config.json');
}

function asStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function emailsIn(identifiers) {
  const out = new Set();
  // Identifiers are usually bare addresses, but source adapters can prefix
  // them (for example `mail:me@example.com`). Only addresses are promoted to
  // owner aliases; a display name or social handle is never guessed as self.
  const pattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/giu;
  for (const id of asStrings(identifiers)) {
    for (const match of id.matchAll(pattern)) out.add(match[0].toLowerCase());
  }
  return [...out];
}

// WHICH INSTALL'S GOOGLE GRANTS COUNT AS THE OWNER'S (round-4 finding 11).
//
// The grants live at <home>/.hazlie/secrets, so an EXPLICIT `home` names the
// install outright and wins over everything below. The complication is
// `configPath`: a caller may hand over a config file without saying which
// install it belongs to, and reading the RUNNING machine's grants for it would
// make a test pointing at a temporary config answer differently on every
// developer's Mac -- which is what this derivation exists to prevent.
//
// It used to be three unconditional dirname hops off configPath. That is
// correct for exactly one path shape and silently wrong for every other: a
// config in a bare tmpdir resolved its grants to the tmpdir's grandparent,
// which on a Mac is somewhere under /var/folders. So the hops now only stand
// in for `home` when the path IS <home>/.hazlie/connectors/config.json, proven
// by rebuilding it and comparing. Anything else has named no install, and the
// honest answer for an install we cannot name is NO grants -- never the
// running machine's.
//
// THE COMPARISON IS BETWEEN PLACES, NOT BETWEEN STRINGS (round-5 finding 17).
//
// Both halves of the test were done on the raw string: three dirname hops off
// the path as given, then `===` against the path as given. A path can name the
// canonical install and still fail both -- a doubled slash, a `.` or `..`
// segment, a symlinked home, or a tmpdir handed over as /var/... and rebuilt
// as /private/var/..., since /var is itself a symlink on macOS. And the hops
// are the worse half: `.hazlie/connectors/./config.json` hops to the
// GRANDPARENT of the install, so no comparison could have rescued it.
//
// Failing here is not a smaller answer, it is a silently empty one: zero
// Google grants, i.e. none of the owner's own addresses, on a config file that
// named the install perfectly well.
//
// So canonicalise FIRST and hop the canonical path. realpath on the DIRECTORY
// plus the basename, rather than on the whole path, because the config file
// itself need not exist yet -- a fresh install is exactly the case where it
// does not -- while the directory holding it usually does. A path that cannot
// be resolved at all falls back to resolve(), which still settles the slashes
// and the dot segments.
function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}

/// THE INSTALL A CONFIG PATH BELONGS TO, or null when the path names none.
///
/// Exported because hermes asks the same question of the same seam. Several of
/// its readers take a `home` and go looking under `<home>/.hazlie` for grants,
/// an activity file, a LinkedIn export; a caller who points hermes at one
/// install's config and then has those readers answer from the RUNNING user's
/// home gets one screen describing two machines (round-6 finding 12). They ask
/// this rather than repeat the dirname arithmetic, so there is one answer to
/// "which install is this" and one place it can be wrong.
///
/// Null is a real answer and the safe one: a path that names no install is not
/// an invitation to fall back to this Mac.
export function installHomeFor(configPath) {
  if (typeof configPath !== 'string' || configPath === '') return null;
  const canonical = canonicalPath(configPath);
  const candidate = dirname(dirname(dirname(canonical)));
  return canonicalPath(ownerConfigPath(candidate)) === canonical ? candidate : null;
}

function grantsHomeFor({ home, homeGiven, configPath }) {
  if (homeGiven || configPath === null) return home;
  return installHomeFor(configPath);
}

export function loadOwner(options = {}) {
  const { configPath = null } = options;
  // `home` is read off the options object rather than destructured with a
  // default, because grantsHomeFor has to know the difference between "the
  // caller named this install" and "nobody said, so it is this machine".
  const homeGiven = options.home !== undefined;
  const home = homeGiven ? options.home : homedir();
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath ?? ownerConfigPath(home), 'utf8')) ?? {};
  } catch {
    raw = {};
  }
  const grantsHome = grantsHomeFor({ home, homeGiven, configPath });
  const addresses = new Set();
  for (const a of raw?.mail?.accounts ?? []) {
    if (typeof a?.user === 'string' && a.user.includes('@')) addresses.add(a.user.toLowerCase());
  }
  // AND EVERY GOOGLE ACCOUNT THIS MAC HOLDS A GRANT FOR, which is where the
  // owner's own addresses actually live now.
  //
  // `mail.accounts[]` stopped deciding which mailboxes exist when the
  // connector moved to OAuth (2026-08-26 — connect/lib/status.mjs: "an
  // AUTHORIZED account is a configured one"). Nothing writes that array any
  // more, so on an ordinary install it is EMPTY and this set held only
  // `ownerEmails`, which is empty too until the owner marks somebody. The
  // owner's own Gmail address was therefore not an owner address at all, and
  // graph.mjs minted them as a calendar person off their own invitations: a
  // calendar of solo events reported people met.
  //
  // This is not inference. A grant on this machine is an account the owner
  // signed into; the calendar connector reads the same grants, so the two
  // sides now agree about who "me" is. An alias the owner has never marked and
  // never authorized is still not guessed at — that is what `ownerEmails` is
  // for, and it stays the only way in.
  for (const account of (grantsHome === null ? [] : listGoogleAccounts({ home: grantsHome }))) {
    if (typeof account?.email === 'string' && account.email.includes('@')) {
      addresses.add(account.email.toLowerCase());
    }
  }
  // Additional owner addresses beyond the mail-connector accounts — the
  // owner's other aliases (old company addresses, forwards) that Intaglio Labs has no
  // connector for but that ARE the owner. Without these, an alias looks like a
  // separate person and even shows up as a "warm-intro bridge" to the owner
  // themselves. Config-only (local), never guessed from the corpus.
  for (const a of asStrings(raw?.ownerEmails)) {
    if (typeof a === 'string' && a.includes('@')) addresses.add(a.toLowerCase());
  }
  const names = [];
  if (typeof raw?.selfName === 'string' && raw.selfName.trim()) names.push(raw.selfName.trim());
  // A full name helps LinkedIn-message attribution; the config carries only a
  // first name, so callers may extend `names` if they know the surname. Empty
  // is fine — it just means owner-name resolution falls back to addresses.
  const keys = new Set(asStrings(raw?.ownerPersonKeys));
  const roles = new Map(
    Object.entries(raw?.personRoles ?? {}).filter(
      ([key, role]) => typeof key === 'string' && key.length > 0 && RELATIONSHIP_ROLES.has(role)
    )
  );
  const rolesByYear = new Map();
  for (const [year, values] of Object.entries(raw?.personRolesByYear ?? {})) {
    if (!/^\d{4}$/u.test(year) || values === null || typeof values !== 'object' || Array.isArray(values)) continue;
    const yearRoles = new Map(
      Object.entries(values).filter(
        ([key, role]) => typeof key === 'string' && key.length > 0 && RELATIONSHIP_ROLES.has(role)
      )
    );
    if (yearRoles.size) rolesByYear.set(year, yearRoles);
  }
  const schools = [...new Set(asStrings(raw?.highSchools).map((school) => school.trim()).filter(Boolean))];
  // Owner corrections for sub-role tags (investor/founder/operator), keyed by
  // graph person key -- same shape and same override-wins posture as
  // personRoles above, read from the same local, gitignored config.
  const subRoles = new Map();
  if (raw?.personSubRoles && typeof raw.personSubRoles === 'object' && !Array.isArray(raw.personSubRoles)) {
    for (const [key, values] of Object.entries(raw.personSubRoles)) {
      if (typeof key !== 'string' || key.length === 0) continue;
      const list = [...new Set(asStrings(values).filter((role) => SUB_ROLES.has(role)))].sort();
      subRoles.set(key, list);
    }
  }
  return { addresses, names, keys, roles, rolesByYear, subRoles, schools, highSchools: schools };
}

function readMutableConfig(configPath) {
  if (existsSync(configPath) && !lstatSync(configPath).isFile()) {
    throw new Error('owner config must be a regular file');
  }
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) ?? {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('owner config must be a JSON object');
    }
    return raw;
  } catch (error) {
    if (error?.message === 'owner config must be a JSON object') throw error;
    throw new Error('owner config is not valid JSON');
  }
}

function writeMutableConfig(configPath, raw) {
  const parent = dirname(configPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.config-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, configPath);
  chmodSync(configPath, 0o600);
}

// Persist an explicit local correction. The page supplies only a graph key;
// Hermes finds its identifiers itself, and this module promotes only
// address-shaped identifiers to aliases. The key remains the safe fallback for
// sources whose IDs cannot be inferred as email addresses.
export function markOwnerPerson({ key, identifiers = [], configPath = ownerConfigPath() } = {}) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) {
    throw new Error('owner person key must be a non-empty string of at most 300 characters');
  }
  const raw = readMutableConfig(configPath);

  const ownerPersonKeys = [...new Set([...asStrings(raw.ownerPersonKeys), key])];
  const emails = emailsIn(identifiers);
  const ownerEmails = [...new Set([...asStrings(raw.ownerEmails).map((email) => email.toLowerCase()), ...emails])];
  raw.ownerPersonKeys = ownerPersonKeys;
  if (ownerEmails.length) raw.ownerEmails = ownerEmails;

  writeMutableConfig(configPath, raw);
  return { key, emails };
}

export function markPersonRole({ key, role, year = null, configPath = ownerConfigPath() } = {}) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) {
    throw new Error('person key must be a non-empty string of at most 300 characters');
  }
  if (!RELATIONSHIP_ROLES.has(role)) {
    throw new Error('role must be friend, business, romantic, or family');
  }
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 3000)) {
    throw new Error('role year must be an integer from 1900 through 3000');
  }
  const raw = readMutableConfig(configPath);
  if (year !== null) {
    const rolesByYear = raw.personRolesByYear
      && typeof raw.personRolesByYear === 'object'
      && !Array.isArray(raw.personRolesByYear)
      ? raw.personRolesByYear
      : {};
    const yearKey = String(year);
    const existingYearRoles = rolesByYear[yearKey]
      && typeof rolesByYear[yearKey] === 'object'
      && !Array.isArray(rolesByYear[yearKey])
      ? rolesByYear[yearKey]
      : {};
    // Object.fromEntries treats `__proto__` as an ordinary own key. Direct
    // assignment to a plain object would mutate its prototype instead, which
    // is the wrong primitive for any identifier ultimately derived from data.
    const yearRoles = Object.fromEntries([...Object.entries(existingYearRoles), [key, role]]);
    raw.personRolesByYear = Object.fromEntries([
      ...Object.entries(rolesByYear).filter(([storedYear]) => storedYear !== yearKey),
      [yearKey, yearRoles],
    ]);
    writeMutableConfig(configPath, raw);
    return { key, role, year };
  }
  const existingRoles = raw.personRoles && typeof raw.personRoles === 'object' && !Array.isArray(raw.personRoles)
    ? raw.personRoles
    : {};
  raw.personRoles = Object.fromEntries([...Object.entries(existingRoles), [key, role]]);
  writeMutableConfig(configPath, raw);
  return { key, role };
}

// Owner corrections for sub-role tags (investor/founder/operator), same
// override-wins posture and same atomic-write path (readMutableConfig ->
// writeMutableConfig, one file) as markPersonRole above. An empty array is a
// valid, explicit override -- "none of these" -- not "no override": subRoles.mjs's
// subRolesFor distinguishes an explicit empty override from no override at
// all (overrideFor returns undefined only when the key is absent), so this
// must persist [] rather than treating it as nothing to write.
export function markPersonSubRoles({ key, subRoles, configPath = ownerConfigPath() } = {}) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) {
    throw new Error('person key must be a non-empty string of at most 300 characters');
  }
  if (!Array.isArray(subRoles) || !subRoles.every((role) => typeof role === 'string' && SUB_ROLES.has(role))) {
    throw new Error('subRoles must be an array drawn from investor, founder, operator');
  }
  const list = [...new Set(subRoles)].sort();
  const raw = readMutableConfig(configPath);
  const existing = raw.personSubRoles && typeof raw.personSubRoles === 'object' && !Array.isArray(raw.personSubRoles)
    ? raw.personSubRoles
    : {};
  raw.personSubRoles = Object.fromEntries([
    ...Object.entries(existing).filter(([storedKey]) => storedKey !== key),
    [key, list],
  ]);
  writeMutableConfig(configPath, raw);
  return { key, subRoles: list };
}

// THE ENGINE OPT-IN, WRITTEN BY THE SERVER AND NOWHERE ELSE.
//
// relationshipMemory.engine is the one config key whose value decides whether
// message excerpts leave this Mac (engines.mjs: with the key ABSENT,
// createEngine falls back to the loopback llama engine). So it gets the same
// atomic read-modify-write every other owner correction here gets — one tmp
// file, one rename, 0600 — rather than a second write path in the connect
// service, and the onboarding page never touches the file at all: it asks
// hermes, which calls this.
//
// TWO VALUES, CLOSED. 'claude-cli' sets the key; 'local' DELETES it, because
// absent-means-llama is engines.mjs's stated contract and writing the string
// "llama" would invent a third state nothing reads. Anything else throws, and
// the route answers 400 — an unrecognised engine name silently persisted here
// would be read back by createEngine as "not claude-cli" and quietly mean
// local, which is the right behaviour arrived at by accident.
//
// The daemon's TOP_KEYS already admits `relationshipMemory` and validateConfig
// does not descend into it, so this write cannot stop the connectors from
// starting. ui/test/onboarding-progress.test.mjs round-trips the written file
// through validateConfig to keep that true.
// The relationshipMemory section as a plain object, or null when there is
// none. Shared by the three setters below because each of them must preserve
// every key it does not own: capPerDay gates the card, engine decides whether
// excerpts leave the Mac, and mode picks the queue -- losing one while writing
// another would switch a feature off as a side effect of setting an unrelated
// one.
function relationshipMemorySection(raw) {
  return raw.relationshipMemory
    && typeof raw.relationshipMemory === 'object'
    && !Array.isArray(raw.relationshipMemory)
    ? raw.relationshipMemory
    : null;
}

export const RELATIONSHIP_ENGINES = Object.freeze(['claude-cli', 'local']);

export function setRelationshipEngine({ engine, configPath = ownerConfigPath() } = {}) {
  if (!RELATIONSHIP_ENGINES.includes(engine)) {
    throw new Error(`engine must be one of: ${RELATIONSHIP_ENGINES.join(', ')}`);
  }
  const raw = readMutableConfig(configPath);
  const existing = relationshipMemorySection(raw);
  if (engine === 'local') {
    // Nothing to opt out OF: no section, or no key in it. Do not create one
    // just to record an absence -- an empty relationshipMemory object written
    // by a "turn it off" press reads, to the next person, like a setting that
    // was configured.
    if (!existing || existing.engine === undefined) return { engine: 'local', changed: false };
    const next = Object.fromEntries(
      Object.entries(existing).filter(([key]) => key !== 'engine')
    );
    raw.relationshipMemory = next;
    writeMutableConfig(configPath, raw);
    return { engine: 'local', changed: true };
  }
  // Object.fromEntries rather than direct assignment, for the same reason
  // markPersonRole uses it: these objects are rebuilt from parsed JSON and a
  // `__proto__` key must land as an ordinary own property, never on a
  // prototype. cap, mode and every other relationshipMemory setting survives.
  raw.relationshipMemory = Object.fromEntries([
    ...Object.entries(existing ?? {}),
    ['engine', engine],
  ]);
  writeMutableConfig(configPath, raw);
  return { engine, changed: true };
}

// THE QUEUE THE OWNER PICKED ON SCREEN 1, KEPT.
//
// The mode row on onboarding's first screen is not a preview: the note under
// it says "your choice is kept by the reader". It was not. POST
// /admin/relationship/mode set rel.mode on the running hermes and nothing
// else, so the choice survived exactly as long as that process did and a
// restart silently reverted every owner who picked founders or investors back
// to the producer config's 'any'.
//
// The closed set lives here, next to the write, and hermes imports it --
// RELATIONSHIP_MODES was hermes' own const, and a second copy in this file
// would be a closed set that two files could disagree about.
export const RELATIONSHIP_MODES = Object.freeze(['investor', 'founder', 'any']);

export function setRelationshipMode({ mode, configPath = ownerConfigPath() } = {}) {
  if (!RELATIONSHIP_MODES.includes(mode)) {
    throw new Error(`mode must be one of: ${RELATIONSHIP_MODES.join(', ')}`);
  }
  const raw = readMutableConfig(configPath);
  const existing = relationshipMemorySection(raw);
  // An unchanged choice is not a write. The mode row posts on every click,
  // including the click that re-picks what is already selected, and rewriting
  // the file for that would churn the one file the connectors daemon reads at
  // start for no change at all.
  if (existing && existing.mode === mode) return { mode, changed: false };
  raw.relationshipMemory = Object.fromEntries([
    ...Object.entries(existing ?? {}),
    ['mode', mode],
  ]);
  writeMutableConfig(configPath, raw);
  return { mode, changed: true };
}

// WHAT PRESSING HELLO SETS, WRITTEN ONCE EACH AND NEVER AGAIN.
//
// Two keys, one owner-initiated call, the same rule for both: write only when
// the key is ABSENT. Anything already in the file is somebody's choice.
//
// capPerDay, because hermes' relationshipCap fails closed -- with the key
// absent it returns null and the card route answers 'no-cap-configured'
// forever, per the step-4 rule that thresholds are the owner's to set and never
// a default invented by the server. On a fresh install the config file the app
// writes is `{}`, so that rule -- correct in itself -- meant the reconnect card
// could never appear on a machine nobody had hand-edited. The resolution is not
// a server-side default: screen 1 says "one person a day" and "one card a day"
// directly above the button the owner presses to start the reader, so the press
// IS the owner choosing one a day, and onboarding records it.
//
// producer, because relationshipProducerConfig reads anything but the literal
// 'eligibility' as the legacy matcher path, calling that "the safe default for
// an owner who has never touched this key". A fresh install has no such owner.
// Every card judgment in the backup was made against the eligibility producer
// and the card this product ships IS that producer, so leaving the key absent
// hands a new install the path nobody is running rather than a safe one.
//
// ABSENT IS THE ONLY TRIGGER, and that matters most for the values that look
// like nothing. A capPerDay of 0 is the fail-closed state expressed
// deliberately -- "no cards" -- not an empty slot, and a producer of 'matcher'
// is an owner on the legacy path on purpose. Neither is overwritten here.
//
// The ceiling on the cap is the daily card's own shape. This is a feature that
// offers one person to reconnect with per day; a number in the hundreds is a
// typo or a caller with the wrong units, not a preference, and the cap is the
// last place to find that out before a day's worth of people are burned.
export const MAX_CAP_PER_DAY = 10;
export const RELATIONSHIP_PRODUCERS = Object.freeze(['eligibility', 'matcher']);

export function ensureRelationshipDefaults({
  capPerDay = 1, producer = 'eligibility', configPath = ownerConfigPath(),
} = {}) {
  if (!Number.isInteger(capPerDay) || capPerDay < 1 || capPerDay > MAX_CAP_PER_DAY) {
    throw new Error(`capPerDay must be an integer from 1 through ${MAX_CAP_PER_DAY}`);
  }
  if (!RELATIONSHIP_PRODUCERS.includes(producer)) {
    throw new Error(`producer must be one of: ${RELATIONSHIP_PRODUCERS.join(', ')}`);
  }
  const raw = readMutableConfig(configPath);
  const existing = relationshipMemorySection(raw);
  const proposed = { capPerDay, producer };
  const changed = {};
  const additions = [];
  for (const [key, value] of Object.entries(proposed)) {
    const absent = !existing || existing[key] === undefined;
    changed[key] = absent;
    if (absent) additions.push([key, value]);
  }
  // One read, one write, whatever the mix: two writes for two keys would leave
  // a window where the config on disk has a producer and no cap.
  if (additions.length === 0) {
    return { capPerDay: existing.capPerDay, producer: existing.producer, changed };
  }
  raw.relationshipMemory = Object.fromEntries([...Object.entries(existing ?? {}), ...additions]);
  writeMutableConfig(configPath, raw);
  const written = raw.relationshipMemory;
  return { capPerDay: written.capPerDay, producer: written.producer, changed };
}

// THE JUDGMENT ENGINE'S SETTINGS (owner decision 2026-09-20: judgments on Jev,
// on by default whenever a key is present -- see ui/server/relationship/jev.mjs).
//
// One closed field set, one atomic read-modify-write, every sibling key
// preserved -- the same shape as setRelationshipEngine above. Under
// relationshipMemory rather than at the top level because the connectors
// daemon's TOP_KEYS admits relationshipMemory and validateConfig does not
// descend into it; a new top-level key would kill the daemon silently
// (connectors/AGENTS.md). ui/test/onboarding-progress.test.mjs round-trips the
// written file through validateConfig to keep that true.
//
// `enabled: false` is the only way to switch judgments OFF with a key present;
// there is no toggle in the product for it, by the owner's decision, so the
// key exists for a developer and for a route test, not a screen.
export const JEV_FIELDS = Object.freeze(['enabled', 'model', 'timeoutMs', 'maxRetries', 'dailyTokenBudget', 'judgments']);
export const JEV_JUDGMENTS = Object.freeze(['quote', 'ending', 'kind', 'distill', 'page', 'sweep']);
const JEV_MAX_DAILY_TOKENS = 500_000_000;

export function validateRelationshipJev(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('jev settings must be a JSON object');
  }
  for (const key of Object.keys(fields)) {
    if (!JEV_FIELDS.includes(key)) throw new Error(`unknown jev field ${JSON.stringify(key)}; accepted: ${JEV_FIELDS.join(', ')}`);
  }
  if (fields.enabled !== undefined && typeof fields.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  if (fields.model !== undefined && !(typeof fields.model === 'string' && /^jev-[a-z0-9.-]{1,32}$/u.test(fields.model))) {
    throw new Error('model must be a jev model id such as jev-latest');
  }
  if (fields.timeoutMs !== undefined && !(Number.isInteger(fields.timeoutMs) && fields.timeoutMs >= 1000 && fields.timeoutMs <= 60_000)) {
    throw new Error('timeoutMs must be an integer from 1000 through 60000');
  }
  if (fields.maxRetries !== undefined && !(Number.isInteger(fields.maxRetries) && fields.maxRetries >= 0 && fields.maxRetries <= 5)) {
    throw new Error('maxRetries must be an integer from 0 through 5');
  }
  if (fields.dailyTokenBudget !== undefined && !(Number.isInteger(fields.dailyTokenBudget) && fields.dailyTokenBudget >= 0 && fields.dailyTokenBudget <= JEV_MAX_DAILY_TOKENS)) {
    throw new Error(`dailyTokenBudget must be an integer from 0 through ${JEV_MAX_DAILY_TOKENS}`);
  }
  if (fields.judgments !== undefined) {
    if (fields.judgments === null || typeof fields.judgments !== 'object' || Array.isArray(fields.judgments)) {
      throw new Error('judgments must be an object of booleans');
    }
    for (const [k, v] of Object.entries(fields.judgments)) {
      if (!JEV_JUDGMENTS.includes(k)) throw new Error(`unknown judgment ${JSON.stringify(k)}; accepted: ${JEV_JUDGMENTS.join(', ')}`);
      if (typeof v !== 'boolean') throw new Error(`judgments.${k} must be a boolean`);
    }
  }
}

export function setRelationshipJev({ configPath = ownerConfigPath(), ...fields } = {}) {
  validateRelationshipJev(fields);
  const raw = readMutableConfig(configPath);
  const existing = relationshipMemorySection(raw);
  const current = existing?.jev && typeof existing.jev === 'object' && !Array.isArray(existing.jev) ? existing.jev : {};
  const merged = Object.fromEntries([
    ...Object.entries(current),
    ...Object.entries(fields).map(([k, v]) => (k === 'judgments'
      ? [k, Object.fromEntries([...Object.entries(current.judgments ?? {}), ...Object.entries(v)])]
      : [k, v])),
  ]);
  if (JSON.stringify(merged) === JSON.stringify(current)) return { jev: merged, changed: false };
  raw.relationshipMemory = Object.fromEntries([...Object.entries(existing ?? {}), ['jev', merged]]);
  writeMutableConfig(configPath, raw);
  return { jev: merged, changed: true };
}
