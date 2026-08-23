// Which Messages thread is Hazlie's own conversation with the owner.
//
// One definition, imported by both sides of the loop that closed on
// 2026-08-19: the iMessage connector (which must not ingest that thread) and
// ui/server/memory/select.mjs (which must not distil it even if a row from
// before this change is still sitting in the store). Two copies of this
// answer would drift, and the failure mode of drift here is silent — the
// system quietly starts treating its own words as the owner's again.
//
// Survivor note (2026-08-21): the courier's iMessage send/listen lanes are
// retired — Hazlie no longer texts its user — but this reader stays, because
// its job was always on the INGEST side: a machine that once had a pinned
// hazlie thread must keep excluding it from the corpus, or the assistant's
// own old messages ingest as the owner's words.
//
// SOFT READ, BY DESIGN. The retired courier config loader THREW when the
// config was missing, which was right for a courier about to send and wrong
// here. A machine with no courier config has no pinned thread, so there is
// nothing to exclude — that is a correct empty answer, not a swallowed
// failure. The
// distinction that matters: this returns [] when no thread is PINNED, never
// because a read went wrong in a way that should have stopped the run.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function courierConfigPath(home = homedir()) {
  return join(home, '.hazlie', 'courier', 'config.json');
}

// Returns the pinned thread guid as a one-element array, or [] if none is
// pinned. An array rather than a string because both call sites want a list to
// test membership against, and because a second Hazlie thread is a plausible
// future (a household account, a second device) that should not need a
// signature change to accommodate.
export function pinnedThreadGuids({ home = homedir(), configPath = null } = {}) {
  const path = configPath ?? courierConfigPath(home);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // NO CONFIG AT ALL is a legitimate answer: nothing is pinned, so nothing
    // needs excluding, and [] is correct.
    if (error?.code === 'ENOENT') return [];
    // ANYTHING ELSE IS A FAILURE AND MUST NOT LOOK LIKE AN ANSWER.
    //
    // This used to `catch { return [] }` for every error, which made
    // "no thread is pinned" and "I could not read the file" identical — and
    // every caller uses the result to EXCLUDE the pinned thread. So a
    // permissions change or a half-written file silently turned the
    // self-ingestion guard off, and the only telemetry, `excludedThreads: 0`,
    // reads the same in both cases.
    //
    // That guard exists because of the 2026-08-19 self-ingestion incident:
    // Hazlie's own messages being read back in as household corpus. Failing
    // closed here costs one errored poll; failing open reopens that loop.
    throw Object.assign(
      new Error(`courier config at ${path} is unreadable, so the pinned thread cannot be excluded`),
      { cause: error }
    );
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // A truncated or corrupt config is the same class: present, unparseable,
    // and not evidence that nothing is pinned.
    throw Object.assign(
      new Error(`courier config at ${path} is not valid JSON, so the pinned thread cannot be excluded`),
      { cause: error }
    );
  }
  const guid = raw?.commandChatGuid;
  return typeof guid === 'string' && guid.trim() ? [guid.trim()] : [];
}
