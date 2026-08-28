// Who "the owner" is, read from the LOCAL connectors config — never hardcoded
// in committed source. The owner's own email addresses and name are personal
// data; a private repo is not an excuse to bake them into a tracked file, and
// the config already holds them (selfName, and each mail account's address).
//
// Returns { addresses: Set<string>, names: string[] } — the addresses that
// mean "from me" and the names that mean "the owner" when resolving people.
// Callers pass this into buildGraph so the graph module carries no identity.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function ownerConfigPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'config.json');
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
  for (const a of raw?.ownerEmails ?? []) {
    if (typeof a === 'string' && a.includes('@')) addresses.add(a.toLowerCase());
  }
  const names = [];
  if (typeof raw?.selfName === 'string' && raw.selfName.trim()) names.push(raw.selfName.trim());
  // A full name helps LinkedIn-message attribution; the config carries only a
  // first name, so callers may extend `names` if they know the surname. Empty
  // is fine — it just means owner-name resolution falls back to addresses.
  return { addresses, names };
}
