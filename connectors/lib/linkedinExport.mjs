// The LinkedIn data export on disk, and the one note left beside it.
//
// WHY THE PATHS MOVED HERE. `defaultImportDir` lived in sources/linkedin.mjs
// and three things outside that file already reached for it (hermes' setup
// screen, connect's tile, and now mail). A second reader deriving
// ~/.hazlie/imports/linkedin by hand is how two surfaces come to disagree
// about where the owner is supposed to drop a file, so the derivation is
// stated once, here, and sources/linkedin.mjs re-exports it under the name
// its callers already use.
//
// THE MARKER. `export-ready.json` is the mail connector's note to the setup
// screen: LinkedIn has mailed the owner to say their archive is downloadable.
// It is NOT corpus. It holds ONE NUMBER -- when that mail arrived -- and
// nothing else.
//
// ~~and its subject line~~ DROPPED (review finding 18). The subject was
// written, read back, and consumed by nothing: every surface says its own
// sentence ("your export is ready -- open the email") and only ever needed the
// timestamp. What it actually did was leave a string an outsider chose sitting
// at rest in the owner's import folder, for no reader. No body, no link, no
// sender was ever in here, for the same reason, and a link copied out of a
// mail is a credential-shaped thing this file has no business holding. The
// mail itself stays in the corpus, where deletion works.
//
// IT IS A NUDGE, AND A NUDGE OUTLIVED BY ITS OWN ANSWER IS NOISE. Once
// Connections.csv is in place the marker says nothing anybody needs: the
// export is imported and the tile says so. So the READER refuses to answer
// while the export is installed, and the linkedin connector's own run deletes
// the file. Both, deliberately -- the delete is the tidy-up and the read gate
// is what makes a marker left behind by a crashed pass harmless.
//
// AND A NUDGE OUTLIVED BY ITS OWN LINK IS WORSE THAN NOISE (review finding 7).
// LinkedIn's download expires in days; the marker did not expire at all, so an
// owner who never fetched the archive kept a badge pointing at a dead link for
// the life of the install. Fourteen days is the bound, applied on BOTH sides --
// the writer will not record a mail older than that, and the reader stops
// answering when one ages past it. The read gate is the load-bearing half: a
// marker written the day it was legitimate still has to go quiet later, and
// nothing else runs to retire it.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// `undefined` means "the running user", the same default every other reader in
// this package takes. `null` does NOT: hermes passes the home of the install
// its caller named, and null there means the caller named no install at all
// (see hermes' installHome). Answering about THIS Mac for that caller is the
// one-screen-describing-two-machines bug, so every entry point below refuses a
// null or empty home rather than coalescing it.
function usableHome(home) {
  if (home === undefined) return homedir();
  return typeof home === 'string' && home !== '' ? home : null;
}

export function importDir(home = homedir()) {
  return join(home, '.hazlie', 'imports', 'linkedin');
}

export function connectionsPath(home) {
  return join(importDir(home), 'Connections.csv');
}

export function markerPath(home) {
  return join(importDir(home), 'export-ready.json');
}

// Has the owner actually put the export in place? Existence only -- nothing is
// read out of the file here or anywhere else on this path.
export function exportInstalled(home) {
  const at = usableHome(home);
  if (at === null) return false;
  try {
    return existsSync(connectionsPath(at));
  } catch {
    return false;
  }
}

// How long a "your export is ready" mail is worth saying anything about.
// LinkedIn's own download expires in days; this is the outer bound on a
// sentence that sends the owner back to that mail.
export const EXPORT_READY_MAX_AGE_MS = 14 * 86_400_000;

// `{ at }` or null. Null while the export is installed (the nudge has been
// answered), null once the mail is older than EXPORT_READY_MAX_AGE_MS, and
// null for anything unreadable, unparseable, or carrying no usable timestamp
// -- absence of a claim is not a claim.
export function readExportReady(home, { now = Date.now } = {}) {
  const at = usableHome(home);
  if (at === null || exportInstalled(at)) return null;
  try {
    const raw = JSON.parse(readFileSync(markerPath(at), 'utf8'));
    const ts = Number(raw?.at);
    if (!Number.isFinite(ts)) return null;
    if (now() - ts > EXPORT_READY_MAX_AGE_MS) return null;
    return { at: ts };
  } catch {
    return null;
  }
}

// WHAT THE SURFACES GET, and all there is to get: the timestamp.
export function exportReadyAt(home, options) {
  return readExportReady(home, options)?.at ?? null;
}

// Records the note. Returns true when the file was written.
//
// REFUSED while the export is installed: the owner has already done the thing
// the nudge asks for. Refused for a mail already older than the age bound,
// which no reader would answer with anyway. And refused for a mail no newer
// than the marker already on disk, which is what keeps a backfill re-reading
// the same message -- or a second mailbox carrying a copy of it -- from
// rewriting the file on every pass.
export function noteExportReady(home, { at } = {}, { now = Date.now } = {}) {
  const at_ = usableHome(home);
  if (at_ === null) return false;
  const ts = Number(at);
  if (!Number.isFinite(ts)) return false;
  if (now() - ts > EXPORT_READY_MAX_AGE_MS) return false;
  if (exportInstalled(at_)) return false;
  const existing = readExportReady(at_, { now });
  if (existing !== null && existing.at >= ts) return false;
  const path = markerPath(at_);
  const tmp = `${path}.${process.pid}.tmp`;
  const body = { at: ts };
  try {
    mkdirSync(importDir(at_), { recursive: true, mode: 0o700 });
    // Owner-only and atomic, like every other small file this package writes:
    // it names something the owner received, and a half-written one must never
    // be readable as a whole one.
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch {}
    return false;
  }
}

// RE-VALIDATES THE FILE AGAINST THE RULE THAT WOULD HAVE WRITTEN IT, and
// deletes it when it does not hold up. Returns true when it deleted one.
//
// The writer owns this file, so the writer is what has to retire it. A marker
// is checked on the way IN against the pass's floor and the age bound, and
// until now nothing checked it again afterwards -- so a marker left by a build
// that had no floor, or one that outlived a purge or a re-install, was believed
// for as long as its own timestamp stayed inside the age bound. The reader
// refusing to answer for it is not enough: the file is still there, and the
// next reader to relax anything starts believing it again.
//
// Run once per pass, BEFORE the scan, so a marker this install would not have
// written is gone whether or not this pass finds a mail of its own. An
// unparseable file goes the same way: nothing can be said for it either.
export function sweepExportReady(home, { floor = Number.NEGATIVE_INFINITY, now = Date.now } = {}) {
  const at = usableHome(home);
  if (at === null) return false;
  let text;
  try {
    text = readFileSync(markerPath(at), 'utf8');
  } catch {
    return false; // no file, or none this process can read: nothing to retire
  }
  let ts = Number.NaN;
  try {
    ts = Number(JSON.parse(text)?.at);
  } catch {}
  const stands = Number.isFinite(ts) && ts >= floor && now() - ts <= EXPORT_READY_MAX_AGE_MS;
  return stands ? false : clearExportReady(at);
}

// Drops the note. Absent is the desired state, so an absent file is a success.
export function clearExportReady(home) {
  const at = usableHome(home);
  if (at === null) return false;
  try {
    unlinkSync(markerPath(at));
    return true;
  } catch {
    return false;
  }
}
