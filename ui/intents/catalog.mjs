// Hazlie's deterministic intent catalog, v1 -- tier 1 of the two-tier router.
//
// Small and boring on purpose: every added template is a new way to
// false-match, and on a family device the costly direction is a wrong action,
// not a slow answer. Growth pressure routes to the LLM tier, not here.
//
// Template mini-language (compiled by lib/router.mjs):
//   (a|b)        exactly one of the alternatives; alternatives may be
//                multi-word ("the volume")
//   (word)       a group with a single alternative is optional
//   (a|b|)       an empty alternative also makes a choice group optional
//   {name:type}  slot; 'duration' parses spoken or digit spans to whole
//                seconds, 'number' parses 0-99 as words or any integer as
//                digits
//
// reply is a string for FIXED lines -- pre-baked to WAV assets by
// scripts/bake-voice.mjs, which reads CANNED_LINES below -- or a function
// (slots, state) => string for values only known at runtime, spoken through
// short live Kokoro synthesis. Callers pass state as
// { now?: Date, timer?: { remainingSeconds } | null }. Timer state lives in
// the page, never in the LLM.

export const CATALOG_VERSION = 'v1';

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

// --- spoken formatting for computed replies -------------------------------
// These produce words rather than digits where it matters, because the TTS
// reads exactly what it is given.

const UNIT_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS_WORDS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety',
];

// 0-99 as words; anything larger falls back to digits, which Kokoro reads
// acceptably and which a kitchen timer should never need anyway.
function numberToWords(n) {
  if (n < 0 || n > 99 || !Number.isInteger(n)) return String(n);
  if (n < 20) return UNIT_WORDS[n];
  const rest = n % 10;
  const tens = TENS_WORDS[Math.floor(n / 10)];
  return rest ? `${tens} ${UNIT_WORDS[rest]}` : tens;
}

function countOf(n, unit) {
  return `${numberToWords(n)} ${unit}${n === 1 ? '' : 's'}`;
}

function durationToSpeech(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const parts = [];
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) parts.push(countOf(h, 'hour'));
  if (m) parts.push(countOf(m, 'minute'));
  if (sec) parts.push(countOf(sec, 'second'));
  if (!parts.length) return 'zero seconds';
  return parts.join(' and ');
}

// "3:42" reads fine in Kokoro; a bare "9:00" does not, hence o'clock.
function timeToSpeech(date) {
  const h = date.getHours() % 12 || 12;
  const m = date.getMinutes();
  if (m === 0) return `${h} o'clock`;
  return `${h}:${String(m).padStart(2, '0')}`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// --- the catalog ----------------------------------------------------------

export const INTENTS = [
  {
    // Computed, spoken live -- too many time-of-day combinations to pre-bake
    // without sounding stitched.
    id: 'time.query',
    templates: [
      'what time is it (right now)',
      "(what's|what is) the time (right now)",
      'do you know what time it is',
    ],
    slots: {},
    reply: (slots, state = {}) => `It's ${timeToSpeech(state.now || new Date())}.`,
  },
  {
    // Confirmation is live synthesis because the duration varies; expiry
    // speaks the pre-baked timer_done line above.
    id: 'timer.set',
    templates: [
      '(set|start) (a) timer for {seconds:duration}',
      '(set|start) (a) {seconds:duration} timer',
      'timer for {seconds:duration}',
    ],
    slots: { seconds: 'duration' },
    reply: (slots) => `${cap(durationToSpeech(slots.seconds))}, starting now.`,
  },
  {
    id: 'timer.remaining',
    templates: [
      'how long (is) left (on the timer)',
      'how much longer (on the timer)',
      'how much time is left (on the timer)',
    ],
    slots: {},
    reply: (slots, state = {}) =>
      state.timer
        ? `${cap(durationToSpeech(state.timer.remainingSeconds))} left.`
        : "There's no timer running.",
  },
  {
    // consequential: an LLM-classified cancel must not run on the model's
    // say-so alone -- it executes only once the full envelope has arrived and
    // its spoken confirmation is already streaming (see useLocalVoice.js).
    id: 'timer.cancel',
    templates: ['(cancel|stop) (the) timer'],
    slots: {},
    reply: CANNED_LINES.cancelled,
    consequential: true,
  },
  // Security-first resolution of the earlier router-policy contradiction:
  // volume is deterministic-template-only. useLocalVoice excludes all three
  // ids from the LLM action enum and rejects any unoffered action again at the
  // callback boundary. `consequential` remains a defense-in-depth marker; it
  // does not make these actions LLM-classifiable.
  {
    id: 'volume.up',
    templates: [
      'volume up',
      'turn (it|the volume) up',
      'turn up the volume',
      '(make it) louder',
    ],
    slots: {},
    reply: CANNED_LINES.okay,
    consequential: true,
  },
  {
    id: 'volume.down',
    templates: [
      'volume down',
      'turn (it|the volume) down',
      'turn down the volume',
      '(make it) quieter',
    ],
    slots: {},
    reply: CANNED_LINES.okay,
    consequential: true,
  },
  {
    // The router only extracts the number; clamping to the device's real
    // range is the handler's job.
    id: 'volume.set',
    templates: ['(set) (the) volume to {level:number}'],
    slots: { level: 'number' },
    reply: CANNED_LINES.okay,
    consequential: true,
  },
  {
    // The eye-state transition is the real response; the line is garnish.
    id: 'sleep',
    templates: ['go to sleep', '(goodnight|good night) (hazlie)'],
    slots: {},
    reply: CANNED_LINES.night_night,
  },
  {
    id: 'wake',
    templates: ['wake up (hazlie)'],
    slots: {},
    reply: CANNED_LINES.hi,
  },
  {
    // Deliberately the fastest path in the system: the handler kills playback
    // and aborts any in-flight LLM stream. Silence IS the response, so reply
    // is null rather than a line.
    id: 'stop',
    templates: ['stop (it)', '(never mind|nevermind)', 'forget it', 'shush'],
    slots: {},
    reply: null,
  },
  {
    id: 'help',
    templates: ['what can you do', 'help', 'what do you know how to do'],
    slots: {},
    reply: CANNED_LINES.help,
  },
  {
    // Fired by the turn state machine on post-wake silence, never by
    // transcript matching -- hence no templates. 'hey' is the alternate take.
    id: 'wake_ack',
    templates: [],
    slots: {},
    reply: CANNED_LINES.mm,
  },
  {
    // Reached only through the router's sanity floor (empty or gibberish
    // transcript after template exhaustion). Never sent to the LLM: mumbles
    // get a fast honest retry, not a slow confident hallucination.
    id: 'say_again',
    templates: [],
    slots: {},
    reply: CANNED_LINES.say_again,
  },
];
