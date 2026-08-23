// Pull the recognized text out of a Photos OCR blob — WHICH THIS DOES NOT
// YET DO. Kept because the negative result is worth more than the code: it
// records exactly how far the obvious approach gets and where it stops.
//
// MEASURED 2026-08-20, on a real 88,775-asset library:
//   - the blob IS a binary plist (magic bplist00) — that part was right;
//   - `plutil -convert json` REFUSES it: the archive embeds <data> elements
//     and JSON cannot represent them ("Invalid object in plist for JSON
//     format"). xml1 converts fine;
//   - but the recognized text is NOT in the plist's <string> elements. Those
//     are 26 NSKeyedArchiver class names, 5-27 chars each, IDENTICAL in every
//     photo. Collecting them yielded the same 214 characters for all 8
//     sampled blobs, whose sizes ranged 3.6 KB to 26.7 KB;
//   - the text is inside a ~25 KB <data> element that is not itself a plist
//     (magic 103bdee9…) — protobuf, or a Vision-framework encoding.
//
// So reading it means decoding an undocumented binary format, not unwrapping
// a plist. That is a real piece of work rather than the afternoon it looked
// like. The connector therefore does not call this, and photo rows carry no
// OCR text until it does.
//
// The trap worth remembering: the first version LOOKED like it worked. It
// returned text, for every photo, with no errors. Only comparing hashes
// across photos revealed that every "decode" was the same string.
//
// The blob in ZCHARACTERRECOGNITIONATTRIBUTES.ZCHARACTERRECOGNITIONDATA is a
// BINARY PLIST (magic `bplist00`), which macOS can convert with `plutil` — a
// system tool, so this needs no dependency to read a format that would
// otherwise be a parser project.
//
// XML1, NOT JSON. `plutil -convert json` REFUSES these outright: they embed
// <data> elements (the feature vectors beside the text) and JSON has no way
// to represent them, so it exits with "Invalid object in plist for JSON
// format" and yields nothing at all. xml1 converts the same blob happily.
// The failure looked like "no text in any photo" rather than like a format
// error, which is the kind of wrong that gets mistaken for an empty library.
//
// The decode is deliberately shallow. Apple's structure nests recognized
// strings among bounding boxes, confidences and algorithm versions, and the
// exact shape changes between OS releases. Rather than model it, this walks
// the decoded JSON and collects strings — a structure-independent read that
// keeps working when Apple moves a key, at the cost of also collecting the
// occasional identifier. The filter below is what keeps that tolerable.

import { spawn } from 'node:child_process';

const BPLIST_MAGIC = Buffer.from('bplist', 'latin1');

// spawn, not execFile: the async execFile has NO `input` option — that
// belongs to execFileSync — so passing one leaves plutil waiting on a stdin
// that never closes, and the call hangs until its timeout kills it. The
// symptom is silence rather than an error, which is how it survived a first
// test run.
function runPlutil(buf, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('plutil', ['-convert', 'xml1', '-o', '-', '-'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('plutil timed out'));
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      size += c.length;
      // A runaway blob must not become an unbounded buffer.
      if (size > 8 * 1024 * 1024) {
        child.kill('SIGKILL');
        reject(new Error('plutil output too large'));
        return;
      }
      chunks.push(c);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`plutil exited ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.on('error', () => {}); // plutil may close stdin early
    child.stdin.end(buf);
  });
}

export function looksLikeBplist(blob) {
  if (!blob) return false;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return buf.subarray(0, 6).equals(BPLIST_MAGIC);
}

// What survives: things a person could read. What does not: UUIDs, hex
// digests, single characters, and the algorithm-version strings that sit
// beside the text. Without this the corpus fills with machine identifiers
// that match no query anyone would type.
export function isProbablyText(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 2) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(t)) return false; // uuid
  if (/^[0-9a-f]{16,}$/iu.test(t)) return false; // hex digest
  if (/^[\d.]+$/u.test(t)) return false; // bare version or number
  if (!/[a-z]/iu.test(t)) return false; // no letters at all
  return true;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#(\d+));/gu, (_, name, dec) =>
    dec ? String.fromCodePoint(Number(dec)) : XML_ENTITIES[name]
  );
}

// Pull <string> values out of the plist XML, in document order and
// de-duplicated. OCR output repeats the same text at several granularities
// (line, word, candidate), so keeping every copy would multiply the text for
// no gain. Reading the tags rather than modelling Apple's structure means
// this keeps working when they move a key between OS releases.
export function collectStrings(xml) {
  const out = [];
  const seen = new Set();
  for (const m of String(xml).matchAll(/<string>([\s\S]*?)<\/string>/gu)) {
    const t = unescapeXml(m[1]).trim();
    if (isProbablyText(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// plutil reads the blob on stdin and writes JSON on stdout, so nothing is
// ever written to a temp file — a decoded photo's text is exactly the kind of
// thing that should not be left lying in /tmp.
export async function decodeOcrBlob(blob, { timeoutMs = 5000, maxChars = 4000 } = {}) {
  if (!looksLikeBplist(blob)) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  let xml;
  try {
    xml = (await runPlutil(buf, timeoutMs)).toString('utf8');
  } catch {
    // A blob plutil cannot read is not an error worth failing an ingest over.
    return null;
  }
  const strings = collectStrings(xml);
  if (strings.length === 0) return null;
  const joined = strings.join(' ');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}
