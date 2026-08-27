// Telling "the model is not running" apart from "the model said no".
//
// Both used to arrive at the owner as the same sentence. A refused connection to
// llama-server threw a bare TypeError out of /vault/ask, the generic handler
// shaped it as `500 {"error":"fetch failed"}`, and Bridge's `default:` arm
// rendered every unrecognised status as "something went wrong on this app's
// side" -- the app-bug string -- for a condition that is neither a bug nor
// permanent. The widget has always had the right words for it
// ("memory isn't running -- it should come back on its own in a moment"); the
// status never reached them. widget/build.sh kickstarts llama-server on every
// deploy, so this is not a rare state.

/// The status for "the local model is not reachable right now". 503 rather than
/// 502: the model is a dependency that comes and goes, and Retry-After is a
/// meaningful thing to say about it. Bridge maps this (and proxyLlama's 502) to
/// the "down" state.
export const LLAMA_UNREACHABLE_STATUS = 503;
export const LLAMA_UNREACHABLE_MESSAGE = 'local llama-server is unreachable';

/// True when the failure is "nothing is listening", rather than something the
/// model actually answered. Matched on the error CODE first, because that is
/// the reliable signal; the message is a narrow fallback for undici's wrapping,
/// deliberately tight so a timeout or a client abort is never mistaken for this.
export function isUnreachable(error) {
  if (!error) return false;
  const code = error.cause?.code ?? error.code ?? '';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') return true;
  return /ECONNREFUSED|ECONNRESET|fetch failed/iu.test(String(error?.message ?? ''));
}

/// The error to raise for it, carrying the status the route should send.
export function unreachableError() {
  return Object.assign(new Error(LLAMA_UNREACHABLE_MESSAGE), {
    status: LLAMA_UNREACHABLE_STATUS,
  });
}

// A MODEL THAT ACCEPTED THE CONNECTION AND THEN SAID NOTHING.
//
// Distinct from unreachable, and distinct from an app bug. The ceiling on the ask
// rejects with a TimeoutError DOMException from the COMBINED signal, so the
// disconnect controller reads as not-aborted and isUnreachable is deliberately
// false -- which left it falling through to a 500 and the app-bug string, for the
// one failure where the owner's best move is simply to ask again.
export const LLAMA_TIMEOUT_STATUS = 504;
export const LLAMA_TIMEOUT_MESSAGE = 'local llama-server did not answer in time';

export function isTimeout(error) {
  if (!error) return false;
  // Matched on the name rather than the message: DOMException's text is not a
  // contract, and AbortSignal.any surfaces the reason's name faithfully.
  return error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError';
}

export function timeoutError() {
  return Object.assign(new Error(LLAMA_TIMEOUT_MESSAGE), { status: LLAMA_TIMEOUT_STATUS });
}
