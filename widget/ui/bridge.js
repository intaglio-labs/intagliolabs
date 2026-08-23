// The JS half of the bridge: promise-per-message over
// webkit.messageHandlers, replies dispatched by Bridge.swift into
// window.__hzDispatch. This file makes no network requests and cannot —
// every page's CSP is default-src 'none' and the navigation delegate
// refuses non-file URLs. All HTTP is native.
'use strict';
let hzSeq = 0;
const hzPending = new Map();

function hzPost(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++hzSeq;
    hzPending.set(id, { resolve, reject });
    try {
      window.webkit.messageHandlers.hz.postMessage({ id, type, payload });
    } catch (err) {
      hzPending.delete(id);
      reject(err);
    }
  });
}

// On the ear page only: a module-graph or runtime error must surface as a
// fixed chat note, not vanish — there is no devtools console in this app.
if (document.body && document.body.classList.contains('ear')) {
  const report = (msg) => {
    try {
      window.webkit.messageHandlers.hz.postMessage({
        id: ++hzSeq, type: 'voiceError', payload: { message: `ear page: ${msg}` },
      });
    } catch {}
  };
  window.addEventListener('error', (e) => report(e.message || 'script error'));
  window.addEventListener('unhandledrejection', (e) =>
    report((e.reason && e.reason.message) || String(e.reason || 'rejection')));
}

// ---------------- sfx ----------------
// The tones are SYNTHESIZED, never loaded. Every visible page runs
// default-src 'none', so an <audio src> would be blocked outright — and a
// sound file would be the first asset this app ever fetched, which is the one
// property the whole design is built around. Web Audio makes them from
// nothing: no files, no network, no CSP exception.
//
// One AudioContext, built on the first gesture because WebKit will not let a
// page make noise before someone has touched it, and reused after that.
let hzAudioCtx = null;
function hzAudio() {
  try {
    if (!hzAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      hzAudioCtx = new Ctx();
    }
    if (hzAudioCtx.state === 'suspended') hzAudioCtx.resume();
    return hzAudioCtx;
  } catch {
    return null; // no audio on this machine is not an error worth surfacing
  }
}

// One second of white noise, generated once and re-sliced. Everything
// percussive in here is a filtered burst of this — a typewriter key has no
// pitch to synthesise, and building a fresh buffer per keystroke would be
// dozens of allocations a second for a sound nobody can tell apart.
let hzNoiseBuf = null;
function hzNoise(ctx) {
  try {
    if (hzNoiseBuf && hzNoiseBuf.sampleRate === ctx.sampleRate) return hzNoiseBuf;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    hzNoiseBuf = buf;
    return buf;
  } catch {
    return null; // no noise is a quieter keystroke, not an error
  }
}

// One voice: an oscillator through its own gain, softened by a shared
// lowpass so nothing in here can get shrill.
function hzVoice(ctx, { type, from, to, dur, peak, attack = 0.008, delay = 0 }) {
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2600;
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain); gain.connect(tone); tone.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

// Silenced from settings; native owns the value, same as the motion
// override. Default true — the tones are the feature, the switch is the
// escape hatch.
let hzSoundsOn = true;
window.__hzSounds = (on) => { hzSoundsOn = on !== false; };

const hzSfx = {
  // A soft downward blip — the sound of something giving under a thumb.
  squish() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    hzVoice(ctx, { type: 'sine', from: 380, to: 210, dur: 0.09, peak: 0.15, attack: 0.005 });
  },
  // Outgoing, so it rises: D5 up to A5.
  send() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    hzVoice(ctx, { type: 'triangle', from: 587.33, to: 880, dur: 0.13, peak: 0.13 });
  },
  // Waking up: a little rising figure, one note per beat of the bounce —
  // crouch, leap, land — over a D major triad, with a sine sparkle on the
  // landing so it arrives somewhere instead of just stopping. Deliberately
  // the busiest tone in here; it is the only one that answers a tap on the
  // face rather than on a control.
  wake() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    [587.33, 739.99, 880].forEach((f, i) => {
      hzVoice(ctx, { type: 'triangle', from: f, to: f, dur: 0.11, peak: 0.12, attack: 0.006, delay: i * 0.07 });
    });
    hzVoice(ctx, { type: 'sine', from: 1174.66, to: 1174.66, dur: 0.32, peak: 0.06, attack: 0.012, delay: 0.14 });
  },
  // The message bar unfurling: a low, soft slide upward. Deliberately
  // quieter and lower than send — opening the bar is a preamble, not the act,
  // and it must not be mistaken for the message having gone.
  expand() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    hzVoice(ctx, { type: 'sine', from: 300, to: 520, dur: 0.16, peak: 0.10, attack: 0.02 });
  },
  // Shutting something: a falling fourth, E5 down to A4. Conclusive rather
  // than sad, and pitched well clear of squish so dismissing a window never
  // reads as just another button press.
  close() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    hzVoice(ctx, { type: 'triangle', from: 659.25, to: 659.25, dur: 0.10, peak: 0.11, attack: 0.006 });
    hzVoice(ctx, { type: 'triangle', from: 440, to: 440, dur: 0.22, peak: 0.10, attack: 0.008, delay: 0.075 });
  },
  // One key on a mechanical typewriter, and the emphasis is on MECHANICAL.
  // The first version was a square-wave blip at 1.5kHz, which is a beep — a
  // toy, a UI chirp, whimsical. A key striking paper is not a pitch at all:
  // it is a broadband CLACK with a wooden thud under it, and the pitched
  // version was the one thing guaranteed to sound like neither.
  //
  // So: a burst of noise through a bandpass for the strike, and a short low
  // triangle falling underneath for the weight of the arm. Nothing sustains,
  // nothing is in tune with anything, and there is no melody for the ear to
  // start following across a sentence.
  //
  // Fired per character at 38ms — ~26 a second — which is the constraint on
  // all of it: 30ms total, and the low end kept short so a run of them does
  // not smear into a rumble.
  type(i) {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    const t0 = ctx.currentTime;
    const noise = hzNoise(ctx);
    if (noise) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      // A different slice of the same second of noise per keystroke. Real
      // keys are not identical and a literally identical click 26 times a
      // second reads as a buzz; re-generating a buffer each time would be
      // 26 allocations a second for the same effect.
      const offset = ((i * 0.037) % 0.9);
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1350 + (i % 4) * 110; // the strike, not a note
      band.Q.value = 0.9;
      const dull = ctx.createBiquadFilter();
      dull.type = 'lowpass';
      dull.frequency.value = 3200; // paper and felt, not a snare
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.075, t0 + 0.0015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.026);
      src.connect(band); band.connect(dull); dull.connect(gain);
      gain.connect(ctx.destination);
      src.start(t0, offset, 0.05);
      src.stop(t0 + 0.045);
    }
    // The arm landing. Falls, so it reads as an impact rather than a note.
    hzVoice(ctx, { type: 'triangle', from: 158, to: 88, dur: 0.04, peak: 0.055, attack: 0.0015 });
  },
  // Winding up. One blip per tap while the orb is being hammered, climbing a
  // semitone at a time — the ratchet on a fruit machine as the handle comes
  // back. Square, short and dry so a fast run of them reads as clicks rather
  // than as a chord.
  ratchet(step) {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    const f = 330 * Math.pow(2, Math.min(step, 12) / 12);
    hzVoice(ctx, { type: 'square', from: f, to: f, dur: 0.05, peak: 0.07, attack: 0.003 });
  },
  // The payout, ONCE — fired when the jackpot trips and never again during
  // it. It used to re-fire every ten taps, so a long hammering carried two
  // overlapping sounds: this fanfare cutting across the per-tap ratchet, on
  // its own rhythm, obscuring the very thing the ratchet exists to do (make
  // each number audible). The ratchet is the payout's voice now; this is
  // just the door opening.
  //
  // A pentatonic run up two octaves — no semitones, so however
  // fast it spills it cannot sound wrong — over a bed of low coin thuds. The
  // 5.5 notes-per-second of the run is the tempo a machine pays out at; any
  // slower and it reads as a melody rather than as winnings.
  jackpot() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    const run = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760];
    run.forEach((f, i) => {
      hzVoice(ctx, { type: 'triangle', from: f, to: f, dur: 0.16, peak: 0.10, attack: 0.004, delay: i * 0.055 });
      // A sine an octave up, quieter, on every other note: the glassy ring on
      // top of a bell without a second full run.
      if (i % 2 === 0) {
        hzVoice(ctx, { type: 'sine', from: f * 2, to: f * 2, dur: 0.22, peak: 0.045, attack: 0.006, delay: i * 0.055 });
      }
    });
    // Coins. Detuned low triangles on an irregular scatter — evenly spaced
    // would be a drum roll, and a payout is a pile, not a rhythm.
    [0.02, 0.11, 0.17, 0.29, 0.34, 0.48, 0.55, 0.71].forEach((t, i) => {
      hzVoice(ctx, {
        type: 'triangle', from: 150 + (i % 3) * 18, to: 88,
        dur: 0.12, peak: 0.09, attack: 0.003, delay: t,
      });
    });
  },
  // The 69th tap, staged like the visual: 0.3s of rising strain while the
  // orb charges, then the bang — skin crack, an upward squeal, and a low
  // thud underneath, because a pop with no low end is a click. The delay is
  // the drama; the thud is the size.
  pop() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    const t0 = ctx.currentTime;
    const D = 0.385; // the charge — lands on pop-body's 62% burst frame
    hzVoice(ctx, { type: 'sine', from: 180, to: 1150, dur: 0.28, peak: 0.07, attack: 0.02 });
    const noise = hzNoise(ctx);
    if (noise) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass'; band.frequency.value = 900; band.Q.value = 0.3;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0 + D);
      gain.gain.exponentialRampToValueAtTime(0.34, t0 + D + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + D + 0.18);
      src.connect(band); band.connect(gain); gain.connect(ctx.destination);
      src.start(t0 + D, 0.31, 0.22); src.stop(t0 + D + 0.22);
    }
    hzVoice(ctx, { type: 'triangle', from: 220, to: 1500, dur: 0.07, peak: 0.18, attack: 0.002, delay: D });
    hzVoice(ctx, { type: 'sine', from: 150, to: 52, dur: 0.34, peak: 0.22, attack: 0.004, delay: D });
  },
  // The message flying to the orb: a swipe, not a note. Noise through a
  // bandpass that sweeps UP as it goes — rising pitch is the only cue the
  // ear needs for "travelling away from you" — and cut short, because the
  // gulp is what ends it.
  whoosh() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    const t0 = ctx.currentTime;
    const noise = hzNoise(ctx);
    if (!noise) return;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 3.2; // narrow, so the sweep reads as pitch rather than hiss
    band.frequency.setValueAtTime(420, t0);
    band.frequency.exponentialRampToValueAtTime(2100, t0 + 0.42);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.1, t0 + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.46);
    src.connect(band); band.connect(gain); gain.connect(ctx.destination);
    src.start(t0, 0.05, 0.5); src.stop(t0 + 0.5);
  },
  // The orb going down the pipe. The mirror of whoosh: pitch falls instead
  // of rising (leaving, not arriving), with a sine sliding under it so there
  // is a body to the thing being swallowed rather than just air. Ends on a
  // soft plug — the moment the pipe takes it.
  pipe() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    const t0 = ctx.currentTime;
    hzVoice(ctx, { type: 'sine', from: 760, to: 150, dur: 0.6, peak: 0.1, attack: 0.03 });
    const noise = hzNoise(ctx);
    if (noise) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 2.6;
      band.frequency.setValueAtTime(1900, t0);
      band.frequency.exponentialRampToValueAtTime(320, t0 + 0.55);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.085, t0 + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
      src.connect(band); band.connect(gain); gain.connect(ctx.destination);
      src.start(t0, 0.62, 0.65); src.stop(t0 + 0.65);
    }
    // The plug: a short low blip where the orb disappears.
    hzVoice(ctx, { type: 'triangle', from: 190, to: 96, dur: 0.12, peak: 0.11, attack: 0.004, delay: 0.55 });
  },
  // Concussed. Two detuned sines sliding down a minor third apart, beating
  // against each other — the interval is the point: a clean fall is sad, a
  // fall that WOBBLES is dizzy. Long and quiet, because it plays under a
  // five-second stagger rather than announcing anything.
  woozy() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    [[392, 233], [466, 277]].forEach(([from, to], i) => {
      hzVoice(ctx, {
        type: 'sine', from, to, dur: 1.5, peak: 0.075,
        attack: 0.05, delay: i * 0.04,
      });
    });
  },
  // Arriving, so it settles: two bell partials a fourth apart, the second
  // just behind the first, with a slow tail.
  receive() {
    if (!hzSoundsOn) return;
    const ctx = hzAudio(); if (!ctx) return;
    hzVoice(ctx, { type: 'sine', from: 880, to: 880, dur: 0.42, peak: 0.10, attack: 0.02 });
    hzVoice(ctx, { type: 'sine', from: 1174.66, to: 1174.66, dur: 0.5, peak: 0.07, attack: 0.02, delay: 0.07 });
  },
};

// Every button on every page squishes, from one listener rather than a call
// at each site — except the few that have a tone of their own, which would
// otherwise play both and muddy into one longer noise.
const HZ_OWN_TONE = new Set(['wsend', 'orb', 'fold', 'close', 'demoSend']);
document.addEventListener('pointerdown', (e) => {
  const hit = e.target.closest('button, [role="button"]');
  if (!hit || HZ_OWN_TONE.has(hit.id)) return;
  hzSfx.squish();
}, true);

// ---------------- time of day ----------------
// The orb's hue drifts across five moods (palette.css §time of day). This
// lives here, not in widget.js, because the onboarding orb has to land on the
// same band — two copies of these boundaries would drift apart the first time
// one of them was tuned. Hours are this repo's judgement; the canvas names the
// moods but never says when they are.
const HZ_TOD_BANDS = ['tod-early', 'tod-late', 'tod-power', 'tod-happy', 'tod-night'];
function hzTodBand(hour) {
  if (hour >= 5 && hour < 9) return 'tod-early';
  if (hour >= 9 && hour < 12) return 'tod-late';
  if (hour >= 12 && hour < 17) return 'tod-power';
  if (hour >= 17 && hour < 21) return 'tod-happy';
  return 'tod-night'; // 21:00–04:59, the one band that wraps midnight
}
// Returns the apply function so a caller can re-run it on demand — the widget
// hangs it off the native sleep-wake poke.
function hzApplyTimeOfDay(orbEl) {
  const apply = () => {
    if (!orbEl) return;
    const band = hzTodBand(new Date().getHours());
    for (const c of HZ_TOD_BANDS) orbEl.classList.toggle(c, c === band);
  };
  apply();
  // Ten minutes is fine for boundaries an hour apart, and these pages are idle
  // in between.
  setInterval(apply, 10 * 60_000);
  return apply;
}

// The per-app Reduce Motion override. Native owns the value — this webview's
// data store is non-persistent, so the page cannot remember it across
// launches — and pushes changes in through __hzMotion. Every visible page
// asks for it once on load; the CSS keys off body.motion-anyway.
window.__hzMotion = (on) => {
  if (document.body) document.body.classList.toggle('motion-anyway', on === true);
};
function hzApplyPrefs() {
  hzPost('prefs')
    .then((d) => {
      window.__hzMotion(d && d.motion === true);
      window.__hzSounds(!d || d.sounds !== false); // absent reads as on
    })
    .catch(() => {}); // no bridge: honour the system setting, keep sound on
}

// ---------------- fitting a popup to its content ----------------
// A fixed window height is a GUESS ABOUT CONTENT, and every guess in this app
// has expired at least once: the connector grid gained a third row and the
// last one was cut off by the window edge; one long answer filled the chat
// popup end to end with nothing to say there was more. Both pages now measure
// and ask; native clamps the answer to the screen, so this is a request.
//
// `.win` is height:100%, so its own scrollHeight only ever reports the window
// back at you. The overflow to recover is what the SCROLLER could not show —
// scrollHeight minus clientHeight — added to the viewport.
//
// The observer rather than a call at each site: both pages mutate their
// scroller from several places (a status refresh, a settings re-render, a
// message arriving, an answer replacing the dots), and a measurement that has
// to be remembered at every one of them is a measurement that will be
// forgotten at the next one.
function hzAutoFit(scroller) {
  if (!scroller) return () => {};
  let last = 0;
  let queued = false;
  const measure = () => {
    queued = false;
    const height = Math.ceil(
      window.innerHeight + (scroller.scrollHeight - scroller.clientHeight));
    // The resize this triggers changes what fits, which re-measures: without
    // a deadband the two chase each other a pixel at a time forever.
    if (!Number.isFinite(height) || Math.abs(height - last) < 3) return;
    last = height;
    hzPost('fitContent', { height }).catch(() => {});
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    let ran = false;
    const run = () => { if (ran) return; ran = true; measure(); };
    requestAnimationFrame(run);
    // A TIMER BACKSTOP, and it is not belt-and-braces. requestAnimationFrame
    // does not fire in a window that is ordered out, and BOTH popups load
    // while hidden — the settings page fetches its connectors and renders the
    // whole grid before anyone opens it. Without this the first measurement
    // never runs and the panel opens at the stale guess it was trying to
    // replace.
    setTimeout(run, 120);
  };
  new MutationObserver(schedule).observe(scroller, {
    childList: true, subtree: true, characterData: true,
  });
  window.addEventListener('resize', schedule);
  schedule();
  return schedule;
}

// PRESSES MUST NOT OUTRUN THEIR OWN ANIMATION. The pressable controls all
// carry an :active transform (palette.css), and a CSS transform moves the
// HIT BOX with the pixels — scale(1.10, 0.91) pulls the top and bottom
// edges in 9% the instant the pointer goes down, so an edge press slips
// OFF the element before release and no click ever fires. (Found by audit,
// 2026-08-22; likely the real story behind the historical "two taps"
// collapse-arrow bug that acceptsFirstMouse was blamed for.) Pointer
// capture pins the gesture to the pressed control for its whole life, so
// click fires no matter what the transform does under the cursor.
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest && e.target.closest(
    '.send, .gear, .orb-btn, .close, .bar-min, .switch, .row, .hint-x, .hold-ok');
  if (b && b.setPointerCapture) {
    try { b.setPointerCapture(e.pointerId); } catch {}
  }
}, true);

window.__hzDispatch = (envelope) => {
  const entry = hzPending.get(envelope.id);
  if (!entry) return;
  hzPending.delete(envelope.id);
  if (envelope.ok) entry.resolve(envelope.data);
  else entry.reject(new Error(envelope.error || 'bridge error'));
};

// Shared connector glyphs: hand-drawn inline SVG, generated in-house —
// nothing is fetched in this app, so brand assets can't come from a CDN.
// Each is a minimal monochrome mark evoking its service, tinted by the
// glass tile's currentColor.
//
// Two coordinate systems on purpose. The 38-viewBox glyphs are transcribed
// verbatim from the design file's "12 — GLASS ICONS / CONNECTIONS" section
// (Terminal-inspired brand palette project) so a designer diffing against
// the canvas sees identical path data; only the white stroke became
// currentColor. As of 2026-08-22 the canvas draws every connector —
// photos, files, mail and oura landed in a second pass — so the whole map
// is 38-viewBox transcriptions; HZ_SVG (24) remains only for the unknown-id
// fallback circle.
const HZ_SVG = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const HZ_SVG38 = (inner, w = 2.4) =>
  `<svg viewBox="0 0 38 38" fill="none" stroke="currentColor" stroke-width="${w}" ` +
  `stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
// A canvas glyph authored at its brand's own viewBox (Slack ships a 122.8
// grid). Filled by default — currentColor so the tile still tints it.
const HZ_SVGVB = (vb, inner) =>
  `<svg viewBox="${vb}" fill="currentColor">${inner}</svg>`;
const HZ_GLYPHS = {
  imessage: HZ_SVG38('<path d="M19 6c-8.3 0-15 5.4-15 12 0 3.8 2.2 7.2 5.6 9.4-.3 2-1.3 3.8-2.6 5 2.6-.3 5-1.3 6.8-2.7 1.6.4 3.4.7 5.2.7 8.3 0 15-5.4 15-12.4S27.3 6 19 6z"/>'),
  calendar: HZ_SVG38('<rect x="5" y="8" width="28" height="25" rx="6"/><path d="M5 16h28M13 4.5v6M25 4.5v6"/><text x="19" y="28.5" text-anchor="middle" font-family="\'IBM Plex Mono\', monospace" font-size="10.5" font-weight="600" fill="currentColor" stroke="none">22</text>'),
  notion: HZ_SVG38('<path d="M11 12h18v20H11z"/><path d="M11 12l5-6h17l-4 6M29 12l4-6v18l-4 4"/><text x="20" y="27.5" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" font-size="13" font-weight="700" fill="currentColor" stroke="none">N</text>'),
  notes: HZ_SVG38('<rect x="6" y="6" width="26" height="26" rx="6"/><path d="M6 13h26M12 20h14M12 26h9"/>'),
  granola: HZ_SVG38('<path d="M19 19c0-1.8 2.2-2.6 3.7-1.5 1.9 1.4 1.9 4.3 0 5.9-2.6 2.2-6.5 1.4-8.3-1.3-2.3-3.5-.8-8 2.9-9.9 4.5-2.3 9.9-.3 11.9 4.2 2.3 5.2-.3 11.2-5.7 13.2-6 2.3-12.7-.9-14.7-7"/>', 2.6),
  instagram: HZ_SVG38('<rect x="5" y="5" width="28" height="28" rx="9"/><circle cx="19" cy="19" r="7"/><circle cx="28" cy="10" r="1.6" fill="currentColor" stroke="none"/>'),
  linkedin: HZ_SVG38('<text x="19" y="26" text-anchor="middle" font-family="\'IBM Plex Mono\', monospace" font-size="20" font-weight="600" fill="currentColor" stroke="none">in</text>'),
  whatsapp: HZ_SVG38('<path d="M19 5.5c-7.5 0-13.5 5.9-13.5 13.2 0 2.6.8 5 2.1 7L6 32.5l7.1-1.5c1.8.9 3.8 1.4 5.9 1.4 7.5 0 13.5-5.9 13.5-13.2S26.5 5.5 19 5.5z"/><path d="M14 14.5c0 5 4.5 9.5 9.5 9.5l1.5-2.5-3-2-1.5 1.5c-1.5-.7-3-2.2-3.7-3.7l1.5-1.5-2-3-2.3 1.7z"/>'),
  // The canvas labels this one "facebook"; the connector id is messenger
  // (connect/lib/bridge.mjs PLATFORMS) — the id wins, the art is the same.
  messenger: HZ_SVG38('<path d="M24 6.5h-3.5c-3.3 0-5.5 2.2-5.5 5.5v4h-4v5h4v11.5h5.5V21h4.5l1-5h-5.5v-3c0-1.2.8-2 2-2h3z"/>', 2.6),
  // Canvas label "x"; connector id twitter (same id-wins rule). A filled
  // path in the canvas, so stroke none per element like the photos petals.
  twitter: HZ_SVG38('<path d="M22.3 16.6 32.6 5h-2.4l-9 10.1L14.1 5H5.8l10.8 15.3L5.8 32.5h2.4l9.5-10.7 7.5 10.7h8.3zM9.1 6.8h3.7l17 24h-3.7z" fill="currentColor" stroke="none"/>'),
  telegram: HZ_SVG38('<path d="M32.5 7.2 27.6 30c-.3 1.4-1.2 1.7-2.4 1.1l-7-5.2-3.4 3.3c-.4.4-.7.7-1.4.7l.5-7.1L26.8 11c.6-.5-.1-.8-.9-.3L10 20.7l-6.9-2.2c-1.5-.5-1.5-1.5.3-2.2l26.9-10.4c1.2-.5 2.3.3 2.2 1.3z" fill="currentColor" stroke="none"/>'),
  discord: HZ_SVG38('<path d="M28.6 9.7A23 23 0 0 0 23 8l-.7 1.4a21 21 0 0 0-6.6 0L15 8a23 23 0 0 0-5.6 1.7C6 14.8 5.1 19.7 5.5 24.6a23 23 0 0 0 6.9 3.4l1.4-2.3a13 13 0 0 1-2.2-1l.5-.4a16.4 16.4 0 0 0 13.8 0l.5.4c-.7.4-1.4.8-2.2 1l1.4 2.3a23 23 0 0 0 6.9-3.4c.5-5.7-.9-10.6-3.9-14.9zM14.7 21.6c-1.3 0-2.4-1.2-2.4-2.7s1.1-2.7 2.4-2.7 2.5 1.2 2.4 2.7c0 1.5-1.1 2.7-2.4 2.7zm8.6 0c-1.3 0-2.4-1.2-2.4-2.7s1.1-2.7 2.4-2.7 2.5 1.2 2.4 2.7c0 1.5-1 2.7-2.4 2.7z" fill="currentColor" stroke="none"/>'),
  slack: HZ_SVGVB('0 0 122.8 122.8', '<path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zM32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"/><path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zM45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"/><path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zM90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"/><path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zM77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"/>'),
  // Contacts: outer ring stroked (wrapper), head + shoulders filled.
  contacts: HZ_SVG38('<circle cx="19" cy="19" r="13"/><circle cx="19" cy="15" r="4.6" fill="currentColor" stroke="none"/><path d="M10.5 28.5c1.5-4.5 4.7-6.8 8.5-6.8s7 2.3 8.5 6.8" fill="currentColor" stroke="none"/>', 2.2),
  // Filled translucent petals, not outlines — the overlap is the art.
  photos: HZ_SVG38('<ellipse cx="19" cy="10" rx="5.2" ry="8.6" transform="rotate(0 19 19)" fill="currentColor" fill-opacity="0.45" stroke="none"/><ellipse cx="19" cy="10" rx="5.2" ry="8.6" transform="rotate(45 19 19)" fill="currentColor" fill-opacity="0.45" stroke="none"/><ellipse cx="19" cy="10" rx="5.2" ry="8.6" transform="rotate(90 19 19)" fill="currentColor" fill-opacity="0.45" stroke="none"/><ellipse cx="19" cy="10" rx="5.2" ry="8.6" transform="rotate(135 19 19)" fill="currentColor" fill-opacity="0.45" stroke="none"/><ellipse cx="19" cy="10" rx="5.2" ry="8.6" transform="rotate(180 19 19)" fill="currentColor" fill-opacity="0.45" stroke="none"/><ellipse cx="19" cy="10" rx="5.2" ry="8.6" transform="rotate(225 19 19)" fill="currentColor" fill-opacity="0.45" stroke="none"/><ellipse cx="19" cy="10" rx="5.2" ry="8.6" transform="rotate(270 19 19)" fill="currentColor" fill-opacity="0.45" stroke="none"/><ellipse cx="19" cy="10" rx="5.2" ry="8.6" transform="rotate(315 19 19)" fill="currentColor" fill-opacity="0.45" stroke="none"/><circle cx="19" cy="19" r="3.4" fill="currentColor" fill-opacity="0.9" stroke="none"/>'),
  files: HZ_SVG38('<path d="M5 12c0-2.2 1.8-4 4-4h6l3 4h11c2.2 0 4 1.8 4 4v12c0 2.2-1.8 4-4 4H9c-2.2 0-4-1.8-4-4z"/><path d="M5 17h28"/>'),
  mail: HZ_SVG38('<rect x="5" y="9" width="28" height="20" rx="5"/><path d="M6.5 11.5 19 21l12.5-9.5"/>'),
  oura: HZ_SVG38('<circle cx="19" cy="23" r="9.5"/><path d="M12.5 8.5h13"/>', 2.8),
};
function hzGlyph(id) {
  if (id.startsWith('mail:')) return HZ_GLYPHS.mail;
  return HZ_GLYPHS[id] || HZ_SVG('<circle cx="12" cy="12" r="7.5"/>');
}
