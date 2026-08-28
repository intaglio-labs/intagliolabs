// Extract the plain string from a Messages `attributedBody` blob.
//
// WHY THIS FILE EXISTS AT ALL: on modern macOS, most Messages rows can carry
// their text ONLY in `attributedBody`, while comparatively few populate
// `message.text`. A reader that trusts `text` captures a small fraction of the
// corpus and looks like it works. This is an OS schema behavior, not a property
// of one mailbox.
//
// The blob is an NSKeyedArchiver *typedstream* — the old NeXT binary format,
// not the plist-based archive, so there is no builtin to parse it. Rather than
// take a dependency to read one string, this decodes the one shape that
// matters: the NSString payload that follows the class name.
//
// Layout, empirically stable across the tested fixtures:
//
//   ... "NSString" <flags> 0x2B <length> <utf8 bytes> ...
//
// where <length> is one byte when < 0x80; 0x81 introduces a 2-byte
// little-endian length, 0x82 a 4-byte one. Anything else, we decline.
//
// This decodes conservatively and returns null rather than guessing: a wrong
// string in the corpus is worse than a missing one, because a missing one is
// visible in the counts and a wrong one is not.

const NSSTRING = Buffer.from('NSString', 'latin1');
const MARKER = 0x2b;
// Nothing legitimate is longer than this; it bounds a corrupt length prefix
// from turning into a huge allocation.
const MAX_LEN = 1 << 20;

export function decodeAttributedBody(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length === 0) return null;

  const at = buf.indexOf(NSSTRING);
  if (at === -1) return null;

  // Scan forward for the 0x2B that introduces the payload. It sits within a
  // few bytes of the class name; a wider window would risk locking onto a
  // 0x2B inside unrelated archive data.
  let i = at + NSSTRING.length;
  const limit = Math.min(buf.length, i + 16);
  while (i < limit && buf[i] !== MARKER) i += 1;
  if (i >= limit || buf[i] !== MARKER) return null;
  i += 1;

  if (i >= buf.length) return null;
  let len = buf[i];
  i += 1;
  if (len === 0x81) {
    if (i + 2 > buf.length) return null;
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > buf.length) return null;
    len = buf.readUInt32LE(i);
    i += 4;
  } else if (len >= 0x80) {
    // An encoding this decoder does not claim to understand.
    return null;
  }

  if (len === 0 || len > MAX_LEN || i + len > buf.length) return null;
  const text = buf.subarray(i, i + len).toString('utf8');
  // A decode that produced replacement characters means the length or offset
  // was wrong; report nothing rather than storing mojibake as the message.
  if (text.includes('�')) return null;
  // U+FFFC OBJECT REPLACEMENT CHARACTER marks where an attachment sits. The
  // `text` column omits it and the blob keeps it, which is the entire reason
  // this decoder's output disagreed with `text` on 90 of 4000 rows — not a
  // parsing error, a semantic one. It is a placeholder, never content, so it
  // goes; the fact of an attachment belongs in meta, not mid-sentence.
  const stripped = text.replace(/￼/gu, '').trim();
  return stripped.length > 0 ? stripped : null;
}

// True when the blob carried an attachment placeholder. Kept separate so a
// caller can record that a message had a photo without the marker polluting
// the text.
export function hasAttachmentPlaceholder(blob) {
  if (!blob) return false;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return buf.includes(Buffer.from('￼', 'utf8'));
}

// The reader's one entry point: prefer the plain column when the server
// populated it, fall back to the blob, and be explicit that neither worked.
export function messageText({ text, attributedBody }) {
  if (typeof text === 'string' && text.length > 0) return text;
  return decodeAttributedBody(attributedBody);
}
