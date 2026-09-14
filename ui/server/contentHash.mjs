// The canonical content hash -- extracted from hermes.mjs (L5 step 6, public
// lookup) so a second writer of context rows (ui/server/relationship/lookup.mjs,
// which writes source='web' rows for a public-lookup change) can compute the
// SAME hash hermes.mjs computes for every other row, rather than forking a
// second implementation that could disagree on serialization.
//
// Computed HERE and only here. The hash decides whether an upsert is a real
// change, so a second implementation in a client is a fork waiting to disagree
// on serialization — at which point every redelivery becomes a spurious UPDATE
// (plus FTS churn), or worse, a real edit hashes equal and is dropped.
// Connectors send plain rows; Hermes hashes them.
//
// Canonical form of {ts, speaker, text, meta}: object keys sorted recursively;
// null-valued and missing keys normalized to the same absence (omitted), so
// {"speaker":null} and {} describe the same row; meta is canonicalized as the
// parsed JSON value it arrives as, never as whatever string a client happened
// to serialize. Arrays keep their order and their nulls — order and arity are
// data in an array, and a generic canonicalizer cannot know which arrays are
// really sets. CONNECTORS MUST THEREFORE PRE-SORT semantically-unordered
// arrays (attendees, recipients) before ingest, or a reordered attendee list
// reads as an edit; the rule is written down in ops/INGESTION.md.

import { createHash } from 'node:crypto';

export function canonicalize(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const c = canonicalize(item);
      return c === undefined ? null : c;
    });
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const c = canonicalize(value[key]);
      if (c !== undefined) out[key] = c;
    }
    return out;
  }
  return value;
}

// Hashes the NORMALIZED row — ts after truncation/default, speaker collapsed
// to absence when null — so the hash describes what would be stored, not what
// the wire happened to carry. Exported for tests and for lookup.mjs; no other
// caller may grow a second implementation of this.
export function canonicalHash({ ts, speaker, text, meta }) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ ts, speaker, text, meta })))
    .digest('hex');
}
