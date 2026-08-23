// Reading content out of a local file, for the few formats that can be read
// honestly with node builtins and no native module.
//
// WHAT IS DELIBERATELY NOT HERE: PDF and the Office/iWork formats. They are
// 1,607 pdf + 570 docx + 242 xlsx + 142 pptx on this machine, so the
// temptation is real — and every cheap way to "extract" them is the photos
// OCR mistake again: scrape the printable runs out of a binary and you get
// something for every input, which looks identical to getting the right
// thing until you compare across inputs. A docx is a zip; a pdf's text is
// usually compressed and often reordered. Both deserve a real parser or
// nothing, and until one is here they ingest as metadata rows like any other
// online-only file, with has_content:false saying so.

import { readFileSync } from 'node:fs';

export const TEXT_EXTS = Object.freeze(['md', 'markdown', 'txt', 'tex', 'csv', 'tsv']);
export const MAX_CONTENT_BYTES = 256 * 1024;

// A file is not text because it ends in .txt. UTF-8 decoding a binary blob
// yields replacement characters, and a run of NULs settles it outright.
export function looksLikeText(buf) {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0)) return false;
  let control = 0;
  for (const byte of sample) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / sample.length < 0.05;
}

export function normalize(text, { maxChars = 20000 } = {}) {
  const out = text
    .replace(/\r\n?/gu, '\n')
    // Control characters, written as escapes: a literal one in this source
    // is invisible in a diff and in a review, and U+2028 is a JS line
    // terminator that would split the regex and stop the file parsing.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

// RTF is worth the ~15 lines because TextEdit defaults to it and Notes
// exports it. Strips the control words and groups; it is not a full parser
// and does not pretend to be — but unlike a printable-run scrape it is driven
// by the format's actual syntax, so it fails visibly rather than plausibly.
export function stripRtf(text) {
  if (!text.startsWith('{\\rtf')) return null;
  return text
    .replace(/\\'([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\{\\\*[^{}]*\}/gu, '')
    // The trailing space is part of the control word's delimiter, so it is
    // consumed here too — otherwise every line after a \par starts with a
    // stray space that survives normalize().
    .replace(/\\par[d]?\b ?/gu, '\n')
    .replace(/\\line\b ?/gu, '\n')
    .replace(/\\tab\b ?/gu, '\t')
    .replace(/\\[a-z]+-?\d*\s?/giu, '')
    .replace(/[{}]/gu, '');
}

// Returns the file's text, or null when this module cannot read it honestly.
// Never called for a dataless file — see lib/fileWalk.mjs.
export function extractText(path, ext, { maxBytes = MAX_CONTENT_BYTES } = {}) {
  const readable = TEXT_EXTS.includes(ext) || ext === 'rtf';
  if (!readable) return null;

  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > maxBytes) return null;
  if (!looksLikeText(buf)) return null;

  const raw = buf.toString('utf8');
  if (ext === 'rtf') {
    const stripped = stripRtf(raw);
    return stripped === null ? null : normalize(stripped) || null;
  }
  return normalize(raw) || null;
}
