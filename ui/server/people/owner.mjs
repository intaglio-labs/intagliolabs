// Who "the owner" is, read from the LOCAL connectors config — never hardcoded
// in committed source. The owner's own email addresses and name are personal
// data; a private repo is not an excuse to bake them into a tracked file, and
// the config already holds them (selfName, and each mail account's address).
//
// Returns { addresses: Set<string>, names: string[], keys: Set<string> } — the
// addresses that mean "from me", names that mean "the owner", and explicitly
// owner-marked graph identities. Callers pass this into buildGraph so the graph
// module carries no identity.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const RELATIONSHIP_ROLES = new Set(['friend', 'business', 'romantic', 'family']);

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

export function loadOwner({ home = homedir(), configPath = null } = {}) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath ?? ownerConfigPath(home), 'utf8')) ?? {};
  } catch {
    raw = {};
  }
  const addresses = new Set();
  for (const a of raw?.mail?.accounts ?? []) {
    if (typeof a?.user === 'string' && a.user.includes('@')) addresses.add(a.user.toLowerCase());
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
  const schools = [...new Set([
    ...asStrings(raw?.schools),
    ...asStrings(raw?.highSchools),
    ...(typeof raw?.highSchool === 'string' ? [raw.highSchool] : []),
  ].map((school) => school.trim()).filter(Boolean))];
  return { addresses, names, keys, roles, rolesByYear, schools, highSchools: schools };
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
