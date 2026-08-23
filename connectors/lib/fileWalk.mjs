// Walking the owner's cloud-sync folders without downloading them.
//
// THE MEASUREMENT THAT DECIDED THIS MODULE (this Mac, 2026-08-20). Across
// iCloud Drive, Box and Dropbox: 97,718 files, of which **96,262 are
// dataless** — present as names and sizes, with no bytes on disk. Reading
// one materializes it. Reading all of them would pull **45.6 GB** through
// the owner's iCloud account, silently, on a 15-minute timer.
//
// So the rule is: this connector NEVER opens a dataless file. It records
// that the file exists — name, folder, size, dates, type — which is real
// signal, and is exactly the shape the photos connector settled on. Content
// is read only from files already on disk. `materializeDataless` exists in
// config as an explicit opt-in and defaults off; there is no code path that
// turns it on by accident.
//
// DETECTING DATALESS FROM NODE. macOS marks these with the SF_DATALESS
// st_flag, which node's Stats does not expose. The proxy is `blocks === 0`
// with `size > 0`: verified on this machine against stat(1)'s flag string —
// dataless files report 0 allocated blocks, a materialized neighbour of
// 34,820 bytes reports 72. An APFS-compressed small file whose data lives
// entirely in an xattr can also report 0 blocks, so this can misjudge a
// local file as dataless. That direction is the safe one: it under-reads
// rather than triggering a download, which is the failure this exists to
// prevent.
//
// SYMLINKS ARE NEVER FOLLOWED. iCloud Drive's `Desktop` and `Documents` are
// symlinks back to ~/Desktop and ~/Documents. Following them would walk the
// whole home directory from inside a "cloud folder" walk, ingest everything
// twice, and escape the configured root entirely.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Dependency and build trees. Without these, 60k of the 96k files found here
// are a synced node_modules — `lodash/fp/toString.js` is not context about
// anyone's life, and it would bury the 3,843 real documents.
export const SKIP_DIRS = Object.freeze([
  'node_modules', '.git', '.svn', '.hg', 'build', 'Build', 'DerivedData', 'Pods',
  'Carthage', '.dart_tool', 'dist', '.next', '.nuxt', '.venv', 'venv', 'env',
  '__pycache__', '.gradle', '.terraform', 'vendor', '.cache', 'target', '.tox',
  '.pytest_cache', '.mypy_cache', 'Library', '.Trash', '.trash',
]);

// Names that say "this is a credential" loudly enough that walking into them
// is a mistake regardless of what the extension filter would do. The owner's
// iCloud has a folder literally called "Secret Keys"; a corpus is the wrong
// place for its contents and for its filenames.
export const SECRET_DIRS = Object.freeze([
  '.ssh', '.gnupg', '.aws', '.kube', '.docker', 'Secret Keys', 'secrets', '.secrets',
]);

// Matched against the whole filename, case-insensitively. Belt and braces
// with SECRET_DIRS: a key does not stop being a key because it was filed
// somewhere sensible.
export const SECRET_FILE_RE =
  /(^\.env($|\.)|\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg|keychain)$|(^|[-_.])id_(rsa|dsa|ecdsa|ed25519)($|\.)|credentials?\.json$|(^|[-_.])secrets?\.(ya?ml|json|toml)$)/iu;

export function isSecretName(name) {
  return SECRET_FILE_RE.test(name);
}

// `blocks === 0 && size > 0` — see the header. Exported so the decision is
// testable against fixtures rather than only against a live iCloud.
export function isDataless(stat) {
  return stat.blocks === 0 && stat.size > 0;
}

// The types worth a row. Everything else is counted and dropped: a walk that
// emits a row per .map and .xcconfig drowns the documents in its own output.
export const DOCUMENT_EXTS = Object.freeze([
  'pdf', 'docx', 'doc', 'pages', 'rtf', 'rtfd', 'odt',
  'md', 'markdown', 'txt', 'note', 'tex',
  'xlsx', 'xls', 'numbers', 'csv', 'tsv',
  'pptx', 'ppt', 'key',
  'epub',
]);

export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/u.exec(name);
  return m ? m[1].toLowerCase() : '';
}

// A generator so the caller controls the budget: this can visit ~100k paths,
// and materializing that as an array before filtering wastes the memory the
// bound was supposed to save.
export function* walkFiles(
  root,
  { skipDirs = SKIP_DIRS, secretDirs = SECRET_DIRS, maxDepth = 12, onSkip = () => {} } = {}
) {
  const skip = new Set(skipDirs);
  const secret = new Set(secretDirs);

  function* recurse(dir, depth) {
    if (depth > maxDepth) {
      onSkip('depth');
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is one directory, not a failed run.
      onSkip('unreadable');
      return;
    }
    for (const entry of entries) {
      // Checked before isDirectory(): a Dirent for a symlink to a directory
      // answers false to isDirectory(), but the check states the intent, and
      // the intent is that no link is ever traversed.
      if (entry.isSymbolicLink()) {
        onSkip('symlink');
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (secret.has(entry.name)) {
          onSkip('secret-dir');
          continue;
        }
        if (skip.has(entry.name) || entry.name.startsWith('.')) {
          onSkip('skip-dir');
          continue;
        }
        yield* recurse(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) {
        onSkip('dotfile');
        continue;
      }
      if (isSecretName(entry.name)) {
        onSkip('secret-file');
        continue;
      }
      let stat;
      try {
        stat = statSync(path);
      } catch {
        onSkip('unstattable');
        continue;
      }
      yield { path, name: entry.name, stat, dataless: isDataless(stat) };
    }
  }

  yield* recurse(root, 0);
}
