// The desktop widget's status read: the same truth renderConnectPage draws,
// over JSON instead of HTML. This is a NATIVE-CLIENT channel, deliberately
// unreachable from a browser:
//
//   - Any request carrying an Origin header is refused outright. A browser
//     fetch always sends one; the widget's URLSession never does. Do not
//     reuse lib/origin.mjs here — sameOrigin() is built to ACCEPT same-origin
//     posts (including `Origin: null` under sec-fetch-site), which is the
//     exact inverse of this rule.
//   - Auth is the hermes bearer token, not a connect link token. The widget
//     must hold ~/.hazlie/secrets/hermes-token.txt anyway to reach
//     /vault/ask; a second secret would add a rotation surface with zero
//     privilege reduction. Shape-check before timingSafeEqual, same order as
//     hermes' authorize().
//   - The response is status booleans and fixed descriptions from
//     readStatus() — no corpus rows, so the corpus boundary is untouched.
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readToken } from './memory.mjs';
import {  readStatus } from './status.mjs';

const BEARER_RE = /^Bearer ([0-9a-f]{64})$/u;
const TOKEN_RE = /^[0-9a-f]{64}$/u;

export function bearerAuthorized(authorization, home) {
  const match = BEARER_RE.exec(authorization ?? '');
  if (!match) return false;
  let expected;
  try {
    // readToken, not a bare readFileSync.
    //
    // This compared against whatever was in the file, with no check that the
    // file was a regular file rather than a symlink, and none that it was
    // owner-only. connect's own lib/memory.mjs has enforced exactly those
    // since it was written, and hermes enforces a stricter set again — so this
    // was the one reader on the machine that would happily authorize against a
    // 0644 file, or a symlink pointing anywhere.
    //
    // It fails closed either way: an unreadable or ill-guarded token file now
    // throws, and the catch below turns that into "nothing can authorize",
    // which is the same answer for a better reason.
    expected = readToken({ home });
  } catch {
    return false; // no usable token file → nothing can authorize; fail closed
  }
  if (!TOKEN_RE.test(expected)) return false;
  return timingSafeEqual(Buffer.from(match[1]), Buffer.from(expected));
}

// Pure decision: headers in, { status, body } out, so the whole channel is
// assertable in a test without binding a port.
export function statusResponse({ origin, authorization, home = homedir() } = {}) {
  if (origin !== undefined) {
    return { status: 403, body: { error: 'browser channel refused' } };
  }
  if (!bearerAuthorized(authorization, home)) {
    // One response for missing, malformed and wrong — a probe learns nothing.
    return { status: 401, body: { error: 'unauthorized' } };
  }
  return { status: 200, body: { sources: readStatus({ home }) } };
}
