'use strict';
// The welcome flow, three scenes that run into each other: screen 1 (§07)
// introduces, screen 2 (§08) is a chat demo with one press in it, screen 3
// (§09, "your turn") is the answer coming back. The only thing the viewer has
// to do is send the message on screen 2; everything else advances itself.

const screens = {
  0: document.getElementById('screen0'),
  1: document.getElementById('screen'),
  2: document.getElementById('screen2'),
  3: document.getElementById('screen3'),
};
// Both orbs read the same time-of-day band as the widget (bridge.js).
for (const el of document.querySelectorAll('.orb')) hzApplyTimeOfDay(el);

function showScreen(n) {
  for (const [k, el] of Object.entries(screens)) {
    el.hidden = String(n) !== k;
    el.classList.remove('leaving', 'entering');
  }
  screens[n]?.classList.add('entering');
  if (String(n) === '2') runDemo();
  if (String(n) === '3') { clearDemo(); runHome(); }
  // The scrim gets out of the way of the real widget only on the last scene.
  document.body.classList.toggle('spotlight', String(n) === '3');
}

// Reopening from settings reuses the same panel AND the same loaded page, so
// the flow would otherwise resume on whatever screen it was abandoned on.
// Native calls this on every open; on the very first one the page has not
// loaded yet, which is why the caller guards on the function existing.
// The move: one press, and the rest is native — copy, relaunch, quit. The
// button narrates while the process dies under it. If native reports there
// was nothing to move (dev override, or a race), fall through to welcome.
const moveGo = document.getElementById('moveGo');
moveGo.addEventListener('click', () => {
  moveGo.disabled = true;
  moveGo.textContent = 'moving…';
  hzPost('moveToApplications')
    .then((d) => {
      if (!d || d.moved !== true) showScreen(1);
      // moved === true: this process is about to terminate; nothing to do.
    })
    .catch(() => {
      moveGo.disabled = false;
      moveGo.textContent = 'move to Applications';
    });
});
document.getElementById('moveSkip').addEventListener('click', () => showScreen(1));

// Whether the app needs moving to /Applications — screen 0's condition.
// False until prefs says otherwise, so an old native (or no bridge at all)
// never nags about a move it cannot perform.
let needsMove = false;
function refreshNeedsMove() {
  return hzPost('prefs')
    .then((p) => { needsMove = !!p && p.inApplications === false; })
    .catch(() => {});
}
refreshNeedsMove().then(() => { if (needsMove) showScreen(0); });

window.__hzOnboardingReset = () => {
  clearDemo();
  demoArmed = false;
  // The move button may have been left mid-gesture — a failed attempt says
  // "moving…", a skip leaves nothing — and a first run has never touched it.
  moveGo.disabled = false;
  moveGo.textContent = 'move to Applications';
  // also clears body.spotlight, so a reopened flow starts dim
  showScreen(needsMove ? 0 : 1);
  // Replay is a fresh-install rehearsal, and the one fact that can change
  // between rehearsals is where the app is (the move itself changes it).
  // Open on the cached answer, correct it when the fresh one lands — but
  // only while still on an opening screen; never yank a flow mid-scene.
  refreshNeedsMove().then(() => {
    if (needsMove && !screens[1].hidden) showScreen(0);
    if (!needsMove && !screens[0].hidden) showScreen(1);
  });
};



// ---------------- screen 2: the demo ----------------
const demoLog = document.getElementById('demoLog');
const demoText = document.getElementById('demoText');
const demoPh = document.getElementById('demoPlaceholder');
const demoSend = document.getElementById('demoSend');
const demoOrb = document.getElementById('demoOrb');

// The line, in runs rather than as one string, because ONE WORD of it is set
// in Trina (palette.css §trina). The accent face is a highlighter here, not a
// body face: `people` is what the sentence is actually about, and setting the
// whole line in it makes the screen read as a different app.
const DEMO_RUNS = [
  { text: 'help me find my ' },
  { text: 'people', accent: true },
  { text: '...' },
];
const DEMO_LINE = DEMO_RUNS.map((r) => r.text).join('');

// Types the first `n` characters of the line into `host`, keeping each run in
// its own span so the accent survives. Rebuilding the whole line each tick
// rather than appending: a character can land mid-run, and the alternative is
// tracking which span is currently open.
function renderLine(host, n) {
  const out = [];
  let seen = 0;
  for (const run of DEMO_RUNS) {
    if (seen >= n) break;
    const span = document.createElement('span');
    if (run.accent) span.className = 'ob-trina';
    span.textContent = run.text.slice(0, n - seen);
    out.push(span);
    seen += run.text.length;
  }
  host.replaceChildren(...out);
}

let demoTimers = [];
function clearDemo() {
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
}

// The bubble flies to wherever the orb actually is. The canvas hardcodes the
// trip as translate(-260px, -235px), true only for its own frame and that
// exact sentence; measured here, it lands in the mouth at any window size and
// any line length.
function aimAtOrb(fly) {
  // Measure the visible pill, set the vars on the outer wrapper: custom
  // properties inherit, so all three layers read the same trip.
  const b = fly.querySelector('.ob-msg').getBoundingClientRect();
  const o = demoOrb.getBoundingClientRect();
  fly.style.setProperty('--suck-x', `${Math.round(o.left + o.width / 2 - (b.left + b.width / 2))}px`);
  fly.style.setProperty('--suck-y', `${Math.round(o.top + o.height / 2 - (b.top + b.height / 2))}px`);
}

// Armed once the line is typed: the demo stops and waits for the send to be
// pressed. The typing is Hazlie's half of the rehearsal; the send is yours.
let demoArmed = false;

function runDemo() {
  clearDemo();
  demoArmed = false;
  demoLog.replaceChildren();
  renderLine(demoText, 0);
  demoPh.hidden = true;
  demoSend.classList.remove('sending', 'nudge');
  demoOrb.classList.remove('gulp');
  // The exit flight, rewound: the pipe wrapper back where it was, the bar
  // back from its fade. Without this a replayed scene 2 starts with no orb.
  document.getElementById('demoPipe').classList.remove('suck');
  screens[2].classList.remove('clear-out', 'bar-out');

  let t = 600;
  const at = (delay, fn) => demoTimers.push(setTimeout(fn, delay));

  // A character at a time. The canvas types at 32ms; 38.4 is exactly a fifth
  // slower, which reads as someone thinking rather than a machine filling in
  // a field.
  for (let i = 1; i <= DEMO_LINE.length; i += 1) {
    at(t, () => { renderLine(demoText, i); hzSfx.type(i); });
    t += 38.4;
  }
  t += 400;

  // Then the demo STOPS. The send button bounces — the notify orb's own
  // nudge, this app's one gesture for "this wants you" — and everything from
  // here belongs to the click.
  at(t, () => {
    demoArmed = true;
    demoSend.classList.add('nudge');
  });
}

// The user's half. Everything from the press to the placeholder is the same
// scripted sequence as before; it just starts on a click instead of a timer.
function demoSendNow() {
  if (!demoArmed) return;
  demoArmed = false;
  const at = (delay, fn) => demoTimers.push(setTimeout(fn, delay));

  demoSend.classList.remove('nudge');
  demoSend.classList.add('sending');
  hzSfx.send();
  // The flight has its own voice — send() is the button, whoosh() is the
  // bubble travelling. Slightly behind the press so they read as two events
  // rather than one thick noise.
  at(90, () => hzSfx.whoosh());
  // THE BAR LEAVES WITH THE MESSAGE. It used to hang around until the orb
  // was already flying away, which left a dead input sitting under a scene
  // that had moved on. Starting it here means the screen empties as the
  // message departs — one motion, not two.
  at(140, () => screens[2].classList.add('bar-out'));
  renderLine(demoText, 0);

  // Three nested layers, one animated axis each (palette.css §straight to
  // the orb) — the split is what keeps the flight composited and kink-free.
  const bubble = document.createElement('div');
  bubble.className = 'ob-fly';
  const flyY = document.createElement('div');
  flyY.className = 'ob-fly-y';
  const msg = document.createElement('div');
  msg.className = 'ob-msg user';
  renderLine(msg, DEMO_LINE.length); // the bubble keeps the accent word
  flyY.appendChild(msg);
  bubble.appendChild(flyY);
  demoLog.appendChild(bubble);
  // Straight to the orb — no delay and no entrance. One frame, only because
  // the bubble has to be laid out before it can be measured.
  requestAnimationFrame(() => {
    aimAtOrb(bubble);
    bubble.classList.add('suck');
  });

  at(600, () => demoSend.classList.remove('sending'));
  // The gulp starts at ~88% of the 1.1s flight, not after it — the orb
  // reacting to something arriving, not twitching once it has already gone.
  at(970, () => {
    demoOrb.classList.add('gulp');
    hzSfx.squish();
  });
  // Clear only once the bubble has actually finished; earlier would cut it
  // off mid-swallow.
  at(1110, () => demoLog.replaceChildren());
  // THE PIPE. The moment the swallow lands, the orb itself is sucked away —
  // down and right, into the corner where the real widget is about to
  // surface — while the bar fades out under it. Scene 3 opens the instant
  // the orb vanishes, and its spotlight lifts the real widget at the very
  // point the flight aimed for: the thing you talked to went THERE.
  //
  // The destination is measured, not guessed: widgetSpot is the widget's
  // real rectangle in window fractions (immune to pageZoom), fetched as the
  // flight is about to need it. If the bridge cannot say, the flight aims
  // at the corner the widget is pinned to anyway — a slightly imperfect
  // landing beats no exit at all.
  at(1150, () => {
    hzSfx.pipe(); // the orb being drawn away, mirror of the message's whoosh
    screens[2].classList.add('clear-out');
    hzPost('widgetSpot')
      .catch(() => null)
      .then((spot) => {
        const pipe = document.getElementById('demoPipe');
        const b = pipe.getBoundingClientRect();
        const s = spot && typeof spot.x === 'number'
          ? spot : { x: 0.78, y: 0.86, w: 0.2, h: 0.1 };
        // Aim at where the widget's ORB sits inside its window — the right
        // end of the bar row — not the window's centre.
        const tx = (s.x + s.w * 0.86) * window.innerWidth;
        const ty = (s.y + s.h * 0.32) * window.innerHeight;
        pipe.style.setProperty('--suck-x', `${Math.round(tx - (b.left + b.width / 2))}px`);
        pipe.style.setProperty('--suck-y', `${Math.round(ty - (b.top + b.height / 2))}px`);
        pipe.classList.add('suck');
      });
  });
  at(1960, () => showScreen(3));
}
demoSend.addEventListener('click', demoSendNow);


// ---------------- screen 3: where it lives ----------------
// The flow has been talking to an orb in the middle of the screen; the app it
// is introducing is a strip in the corner that sits UNDER every window. That
// gap is the last thing onboarding owes anyone, and a drawing of a widget
// would not close it — so native lifts the real one above the scrim and this
// scene rings it where it actually is.
const homeSpot = document.getElementById('homeSpot');
const homeCard = document.getElementById('homeCard');

// If the bridge cannot say where the widget is, put the ring where the widget
// is pinned anyway. A scene that points at roughly the right corner is worth
// more than one that does not appear.
const HOME_FALLBACK = { x: 0.78, y: 0.86, w: 0.20, h: 0.10 };

function placeHome(spot) {
  const s = spot && typeof spot.x === 'number' ? spot : HOME_FALLBACK;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const left = s.x * w;
  const top = s.y * h;
  const width = s.w * w;
  const height = s.h * h;
  homeSpot.style.cssText =
    `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
  // The card sits ABOVE the ring and shares its right edge, so the eye runs
  // straight down the copy into the thing being pointed at. Clamped off the
  // top so it cannot slide under the menu bar on a short display.
  homeCard.style.right = `${Math.max(24, w - (left + width))}px`;
  homeCard.style.bottom = `${Math.max(24, h - top + 26)}px`;
}

function runHome() {
  hzPost('spotlightWidget', { on: true }).catch(() => {});
  hzPost('widgetSpot')
    .then(placeHome)
    .catch(() => placeHome(null));
}
// The widget's corner does not move, but the window it is measured against
// does — a display change or a size change while this scene is up would
// leave the ring pointing at nothing.
window.addEventListener('resize', () => {
  if (!screens[3].hidden) runHome();
});
document.getElementById('homeDone').addEventListener('click', () => finish());

// ---------------- flow ----------------
document.getElementById('cta').addEventListener('click', () => {
  hzSfx.wake();
  showScreen(2);
});

function finish({ then } = {}) {
  // Put the widget back under the windows before anything else. Native does
  // this too when the panel closes, because a desktop widget left floating
  // above everything would be the worst bug this app could ship — but asking
  // first means it happens while the scene is still up rather than after.
  hzPost('spotlightWidget', { on: false }).catch(() => {});
  // Mark it done BEFORE closing: if the window goes first the page can be
  // torn down mid-message and the flow reappears on the next launch.
  hzPost('onboardingDone')
    .catch(() => {})
    .then(() => {
      if (then) hzPost(then).catch(() => {});
      return hzPost('close');
    });
}

// Escape leaves but does NOT mark it done — dismissing is not finishing, and a
// flow you backed out of should still be there next time.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    clearDemo();
    hzSfx.close();
    hzPost('spotlightWidget', { on: false }).catch(() => {});
    hzPost('close');
  }
});

hzApplyPrefs();
