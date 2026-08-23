// The fixed lines the voice feature speaks, and nothing else.
//
// This file was the deterministic intent catalog: an INTENTS table of ~130
// lines with a template mini-language (choice groups, optional groups, typed
// slots) plus spoken-number formatting helpers. All of it was removed
// 2026-08-22 because nothing consumed it — the header described templates
// "compiled by lib/router.mjs", and no router.mjs exists in this repo. The
// tier-1 router it belonged to is not part of the widget app.
//
// What survives is the one thing with a live consumer: CANNED_LINES, read by
// widget/voice/scripts/bake-voice.mjs to pre-synthesise each line to a WAV.
// If a router ever lands, it brings its own catalog; this is not a stub
// waiting for one.

// Every fixed line in one place: assetName -> the exact text to synthesise
// into ui/public/voice/<assetName>.wav (served at /voice/). 'mm' and 'hey'
// belong to the wake-only acknowledgment, which the turn state machine fires
// after ~400ms of post-wake silence, and 'timer_done' is the expiry chime the
// page's timer fires -- no transcript ever reaches the router for those.
export const CANNED_LINES = {
  okay: 'Okay.',
  cancelled: 'Okay, cancelled.',
  night_night: 'Night night.',
  hi: 'Hi.',
  help:
    'I can set a timer and tell you how long is left, tell you the time, ' +
    'and turn the volume up or down. Say stop if you want me to be quiet. ' +
    'For anything else, just ask.',
  say_again: 'Say that again?',
  mm: 'Mm?',
  // Named 'hey' for its historical role (the connect-time greeting spoken
  // once the session goes live); the text itself carries no special meaning
  // now that there is no wake word to echo back.
  hey: 'Yeah?',
  timer_done: "Time's up!",
};
