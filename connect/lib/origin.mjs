// Is this state-changing POST coming from our own page?
//
// A form POST is the one thing a hostile page can do cross-origin without
// being able to read the reply, so the write route needs a same-origin signal
// beyond the token in the path.
//
// Sec-Fetch-Site is the primary signal: the browser sets it, a page cannot
// forge it, and it states the relationship directly. Origin only corroborates.
//
// WHY ORIGIN ALONE WAS WRONG, learned the hard way: the server sends
// `Referrer-Policy: no-referrer`, and under that policy browsers serialize the
// Origin of a *navigational* form POST as the string "null". So the hardening
// header broke the hardening check — every real submission was refused while
// curl with a hand-written Origin sailed through, which is exactly the wrong
// way round for a test to pass. A literal "null" is therefore accepted, but
// only when Sec-Fetch-Site independently says same-origin.
//
// This lives in lib/ rather than server.mjs so a test can import it without
// starting a listener.

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u;

export function sameOrigin(headers = {}) {
  const site = headers['sec-fetch-site'];
  const origin = headers.origin;
  const originOk = origin === undefined || origin === 'null' || LOCAL_ORIGIN.test(origin);

  if (site !== undefined) {
    // Modern browsers always send it, so when present it decides. An opaque
    // Origin is fine here; a wrong one is not, even if the site header agrees.
    return site === 'same-origin' && originOk;
  }
  // No Sec-Fetch-Site (a very old browser, or a non-browser client): fall back
  // to Origin, and refuse the opaque "null" since nothing corroborates it.
  return origin !== 'null' && originOk;
}
