// A file on disk → a hermes context row. Pure: no I/O, no clock.
//
// The text of a row is the file's own name and the folder path that leads to
// it, plus extracted content when there is any. That is not a placeholder:
// "Example Referral Agreement.docx" inside "Example Co" is a fact about the
// owner's year, and it is available for online-only files that this connector
// will never open. See lib/fileWalk.mjs for why it must not
// open them.

import { extensionOf } from './fileWalk.mjs';

// Folder names carry most of the signal in a path, and the machinery around
// them carries none. `/Users/x/Library/Mobile Documents/com~apple~CloudDocs/
// Example Co/2026/contract.pdf` is, to a reader, "Example Co / 2026".
export function relativeParts(path, root) {
  const rest = path.startsWith(root) ? path.slice(root.length) : path;
  return rest.split('/').filter(Boolean).slice(0, -1);
}

// Underscores and dashes are word separators in filenames, and an extension
// is noise once it is its own field. Keeps the human words, drops the rest.
export function humanizeName(name) {
  const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/u, '');
  return stem.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function composeText({ name, parts, content }) {
  const where = parts.length ? parts.join(' / ') : '';
  const head = where ? `${humanizeName(name)} — ${where}` : humanizeName(name);
  const body = typeof content === 'string' ? content.trim() : '';
  return body ? `${head}\n\n${body}` : head;
}

export function fileToRow({ path, name, stat, dataless, root, label, content = null }) {
  // ts is the modification time: a file's place in the timeline is when the
  // owner last worked on it. Birth time is kept in meta so the original date
  // survives; macOS gives us both.
  const ts = Number(stat.mtimeMs);
  if (!Number.isFinite(ts) || ts <= 0) return null;

  const parts = relativeParts(path, root);
  const text = composeText({ name, parts, content });
  if (!text) return null;

  const created = Number(stat.birthtimeMs);

  return {
    ts,
    source: 'files',
    // A file has no speaker. The author is the owner, but saying so would
    // invent a name they never typed — the same call notes.mjs makes.
    speaker: null,
    // Keyed on the path, because that is what identifies a file to its owner
    // and what stays stable across edits. A moved file becomes a new entity
    // and the old one expires by retention, which is the honest outcome:
    // this connector cannot observe a move, only an absence.
    entity_id: `files:${path}`,
    text,
    meta: {
      filename: name,
      // The cloud service the file lives in, so a query can tell "my Box" from
      // "my iCloud" without parsing a path.
      store: label,
      ...(parts.length ? { folder: parts.join('/') } : {}),
      ext: extensionOf(name),
      bytes: stat.size,
      // The single most important field for anyone reading this corpus later:
      // true means the bytes were never on this machine and the text above is
      // the filename alone, NOT a summary of contents.
      online_only: Boolean(dataless),
      has_content: typeof content === 'string' && content.trim().length > 0,
      ...(Number.isFinite(created) && created > 0 ? { created_ms: created } : {}),
    },
  };
}
