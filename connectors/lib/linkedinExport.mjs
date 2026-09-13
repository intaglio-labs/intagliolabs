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
// It is NOT corpus. It holds the message's timestamp and its subject line and
// nothing else -- no body, no link, no sender -- because the surfaces that
// read it only ever say "your export is ready, open the email", and a link
// copied out of a mail is a credential-shaped thing this file has no business
// holding. The mail itself stays in the corpus, where deletion works.
//
// IT IS A NUDGE, AND A NUDGE OUTLIVED BY ITS OWN ANSWER IS NOISE. Once
// Connections.csv is in place the marker says nothing anybody needs: the
// export is imported and the tile says so. So the READER refuses to answer
// while the export is installed, and the linkedin connector's own run deletes
// the file. Both, deliberately -- the delete is the tidy-up and the read gate
// is what makes a marker left behind by a crashed pass harmless.

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

// `{ at, subject }` or null. Null while the export is installed (the nudge has
// been answered), and null for anything unreadable, unparseable, or carrying
// no usable timestamp -- absence of a claim is not a claim.
export function readExportReady(home) {
  const at = usableHome(home);
  if (at === null || exportInstalled(at)) return null;
  try {
    const raw = JSON.parse(readFileSync(markerPath(at), 'utf8'));
    const ts = Number(raw?.at);
    if (!Number.isFinite(ts)) return null;
    return { at: ts, subject: typeof raw?.subject === 'string' ? raw.subject : null };
  } catch {
    return null;
  }
}

// WHAT THE SURFACES GET, and all they get: the timestamp. The subject is for
// the owner's own eye on their own Mac, not for a status payload that three
// processes relay -- a surface that never receives it cannot leak it.
export function exportReadyAt(home) {
  return readExportReady(home)?.at ?? null;
}

// Records the note. Returns true when the file was written.
//
// REFUSED while the export is installed: the owner has already done the thing
// the nudge asks for. Refused, too, for a mail no newer than the marker
// already on disk, which is what keeps a backfill re-reading the same message
// -- or a second mailbox carrying a copy of it -- from rewriting the file on
// every pass.
export function noteExportReady(home, { at, subject } = {}) {
  const at_ = usableHome(home);
  if (at_ === null) return false;
  const ts = Number(at);
  if (!Number.isFinite(ts)) return false;
  if (exportInstalled(at_)) return false;
  const existing = readExportReady(at_);
  if (existing !== null && existing.at >= ts) return false;
  const path = markerPath(at_);
  const tmp = `${path}.${process.pid}.tmp`;
  const body = { at: ts, subject: typeof subject === 'string' ? subject : null };
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
