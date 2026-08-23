'use strict';
// The widget is the message bar, the orb, and one door into settings.
//
// The trinket shelf that used to hang connector status here is gone: it was
// rendering exactly what the settings popup already shows, so the widget
// polled /status once a minute to duplicate a list nobody was reading at a
// glance. Status now lives in the popup only. The native sleep-wake poke
// (__hzWake) went with it — main.swift guards the call, so nothing breaks.

// The always-present message bar IS the chat entry point: submitting
// opens the chat window with the message already sent.
const winput = document.getElementById('winput');
function submitFromWidget() {
  const utterance = winput.value.trim().slice(0, 2000);
  if (!utterance) return;
  winput.value = '';
  hzSfx.send();
  hzPost('openChatWith', { utterance });
}
document.getElementById('wsend').addEventListener('click', submitFromWidget);
// The orb is the tap-to-arm voice control (VOICE-PLAN rev 3 §2): one tap
// arms exactly one spoken turn, a second tap cancels. Native relays state
// back so the orb runs its .talking timings while armed or speaking.
// The button is the hit target and carries the press-squash; the inner span
// is the orb itself and carries the resting jelly and the armed warp, so
// `talking` goes on the inner one.
const orbBtn = document.getElementById('orb');
const orbEl = orbBtn.querySelector('.orb');
// The wake fires HERE, off the click, not off the voice stack. Arming has to
// reach native, start the ear page, load models and speak a greeting before
// any state comes back — and if voice is not provisioned, none ever does.
// Tapping a sleeping orb has to answer immediately regardless.
function wakeOrb() {
  orbEl.classList.remove('waking');
  void orbEl.offsetWidth; // reflow, so a second tap restarts the animation
  orbEl.classList.add('waking');
}
orbEl.addEventListener('animationend', (e) => {
  // Only the wake clears the class — the state animations underneath loop
  // forever and would otherwise strip it mid-bounce.
  if (e.animationName === 'orb-wake') orbEl.classList.remove('waking');
});

// ---------------- jackpot ----------------
// Hammer the orb and it pays out. The look is palette.css §jackpot; what is
// here is the counting, the sound, and the one thing that actually needed
// solving — voice.
//
// THE INTERLOCK. `voiceArm` is a toggle: one tap arms a spoken turn, the next
// cancels it. Left alone, a dozen taps is a dozen toggles, and every odd one
// starts the greeting over — which is what spamming the orb used to sound
// like.
//
// So a BURST IS ONE TAP. The first one arms, exactly as a deliberate tap
// does, and every tap after it inside the burst posts nothing at all. One
// greeting, and the session that tap started is left alone to run or to time
// out on its own.
//
// The first version of this posted a second `voiceArm` to cancel, on the
// theory that landing on "disarmed" was tidier. It is not: the ear's own
// start is asynchronous, and a cancel arriving mid-start left the session
// half-torn-down, which came back as "Session already started" on the next
// arm. Nothing about hammering the orb should reach into a voice session
// that is still assembling itself.
const SPAM_GAP = 340;    // taps closer than this belong to the same burst
const SPAM_TRIP = 6;     // taps in one burst that trip the payout
const BURST_END = 700;   // quiet for this long and the burst is over
const PAYOUT_MS = 2000;  // payout runs this long past the LAST tap
const PAYOUT_CAP = 8000; // ...but never longer than this in total
// SIXTY-NINE. The badge counts every tap of the payout and the orb swells a
// little with each one; at the ceiling it bursts and comes back concussed.
// The number is the joke, so it is a constant rather than a magic literal —
// and PAYOUT_CAP is why the swell has to be per-TAP rather than per-second:
// a payout can only run 8s, but there is no limit on how fast someone
// clicks, so the count is the only honest measure of effort.
const POP_AT = 69;
const SWELL_PER_TAP = 0.004; // 1.25x at the ceiling — see the clipping note
// The daze must END on daze-sway's 0% pose, because undaze-right STARTS
// there — same seam trick as daze-reform into daze-sway, run in reverse. So
// its length is not free: reform (620ms) plus WHOLE sway cycles (2 × 2600ms).
const DAZE_MS = 5820;        // how long it sleeps the concussion off
const UNDAZE_MS = 900;       // the righting — matches palette.css undaze-right

let lastTap = 0;
let burst = 0;          // taps in the current burst, 0 when there is no burst
let jackpotOn = false;
let jackpotStarted = 0;
let jackpotTimer = null;
let burstTimer = null;
let dazed = false;   // concussed: taps do nothing until it wears off
let dazeTimer = null;

// The Reduce Motion override, from the pref rather than from the DOM. A
// payout borrows `motion-anyway` for its duration (palette.css writes the
// whole Reduce Motion block as `body:not(.motion-anyway)`, so one class turns
// all of it off and the payout needs no restatement) — and reading the class
// back afterwards would restore whatever the payout itself had set. Native
// can also push a change mid-payout; this keeps the value and applies it at
// the end.
let motionPref = false;
const applyMotion = window.__hzMotion;
window.__hzMotion = (on) => {
  motionPref = on === true;
  if (!jackpotOn) applyMotion(motionPref);
};

const badge = orbEl.querySelector('.orb-badge');
const panelEl = document.getElementById('panel');

// The swell rides on the BUTTON, not the orb — palette.css §69 explains why
// (the orb's transform is already spoken for by jack-spaz).
function setSwell(mult) {
  orbBtn.style.setProperty('--jgrow', String(mult));
}

function endJackpot() {
  jackpotOn = false;
  jackpotTimer = null;
  orbEl.classList.remove('jackpot');
  applyMotion(motionPref);
  badge.textContent = '1'; // back to what the notify face expects to find
  setSwell(1);
}

// 69: the orb bursts, then comes back concussed and sleeps it off. Motion
// stays borrowed for the whole sequence — this is the same "six deliberate
// taps asked for it" exemption the payout runs under, and stopping halfway
// through would strand the orb mid-burst.
function popAndDaze() {
  clearTimeout(jackpotTimer);
  jackpotTimer = null;
  jackpotOn = false;
  dazed = true;
  orbEl.classList.remove('jackpot');
  badge.textContent = '1';
  setSwell(1); // the burst's own keyframes own the scale from here
  orbEl.classList.add('pop');
  hzSfx.pop();
  // The jolt lands at the BANG (0.3s into the animation, where the charge
  // gives), not at the start — a shelf that shakes before the burst gives
  // the ending away.
  setTimeout(() => {
    panelEl.classList.add('quake');
    setTimeout(() => panelEl.classList.remove('quake'), 470);
  }, 385); // 62% of pop-body's 0.62s — the frame the skin gives

  // Gone for a beat before it comes back — the gap is what makes it read as
  // having actually burst rather than having changed costume.
  setTimeout(() => {
    orbEl.classList.remove('pop');
    orbEl.classList.add('dazed');
    hzSfx.woozy();
  }, 780);

  dazeTimer = setTimeout(() => {
    // The morph back to sleep. dazed comes off exactly on the sway's 0%
    // pose (DAZE_MS is sized to make that true) and undaze picks up from
    // that pose: the orb rights itself while the eye closes over the
    // spiral. Taps stay swallowed until it has actually settled.
    orbEl.classList.remove('dazed');
    orbEl.classList.add('undaze');
    dazeTimer = setTimeout(() => {
      dazed = false;
      dazeTimer = null;
      orbEl.classList.remove('undaze');
      applyMotion(motionPref); // hand Reduce Motion back at the very end
    }, UNDAZE_MS);
  }, 780 + DAZE_MS);
}

function bumpJackpot(count) {
  badge.textContent = String(Math.min(count, POP_AT));
  // Each tap adds a little size, and the growth is cumulative from the tap
  // that tripped the payout — the button's existing squish transition turns
  // each step into an ease rather than a jump.
  setSwell(1 + Math.min(count - SPAM_TRIP, POP_AT - SPAM_TRIP) * SWELL_PER_TAP);
  if (!jackpotOn) {
    jackpotOn = true;
    jackpotStarted = Date.now();
    orbEl.classList.remove('waking');
    orbEl.classList.add('jackpot');
    applyMotion(true);
    hzSfx.jackpot();
  }
  if (count >= POP_AT) { popAndDaze(); return; }
  clearTimeout(jackpotTimer);
  // Held open by continued hammering, but only up to the cap — otherwise a
  // finger left on the mouse button never lets it stop.
  const left = Math.max(0, PAYOUT_CAP - (Date.now() - jackpotStarted));
  jackpotTimer = setTimeout(endJackpot, Math.min(PAYOUT_MS, left));
}

function endBurst() {
  burst = 0;
  burstTimer = null;
}

function orbTap() {
  // Concussed: it cannot hear you. Swallowing the tap entirely is the point —
  // arming voice out of a burst face would undo the joke, and the state ends
  // on its own in a few seconds.
  if (dazed) return;
  const now = Date.now();
  const fast = now - lastTap < SPAM_GAP;
  lastTap = now;
  burst = fast ? burst + 1 : 1;
  clearTimeout(burstTimer);
  burstTimer = setTimeout(endBurst, BURST_END);

  if (burst === 1) {
    // An ordinary tap, unchanged: wake, arm, greet.
    hzSfx.wake();
    wakeOrb();
    hzPost('voiceArm');
    return;
  }

  // Winding up. One climbing blip per tap instead of the wake tone, which at
  // this rate stacks into noise.
  hzSfx.ratchet(burst - 2);
  if (burst >= SPAM_TRIP) bumpJackpot(burst);
  else wakeOrb();
}
orbBtn.addEventListener('click', orbTap);

// HOLDING COUNTS. Once the payout is running — the badge is counting — a
// held press keeps tapping at machine rate, so getting to 69 is a hold
// rather than an endurance test. Gated on jackpotOn at press time: a plain
// press-and-hold on a sleeping orb is the drag gesture and a voice arm, and
// must not turn into a burst. The interval stops itself the moment the
// payout ends for any reason (pop, timeout), and every release path clears
// it. Auto-taps go through orbTap, so the cap, the counting and the
// interlock all apply to a hold exactly as to clicks.
let holdTimer = null;
function endHold() {
  if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
}
orbBtn.addEventListener('pointerdown', () => {
  if (!jackpotOn || dazed) return;
  endHold();
  holdTimer = setInterval(() => {
    if (!jackpotOn || dazed) { endHold(); return; }
    orbTap();
  }, 90);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  orbBtn.addEventListener(ev, endHold);
}
// Four faces (palette.css §the face), exactly one at a time. Native only ever
// tells us `talking`, so idle and talking are the two that are live today;
// listening and notify are reachable through __hzOrbState for whoever wires
// the arm-vs-speak split and real notifications later.
const ORB_STATES = ['idle', 'notify', 'listening', 'talking'];
function setOrbState(state) {
  for (const s of ORB_STATES) orbEl.classList.toggle(s, s === state);
}
window.__hzOrb = (talking) => setOrbState(talking === true ? 'talking' : 'idle');
window.__hzOrbState = (state) => {
  if (ORB_STATES.includes(state)) setOrbState(state);
};

// Time of day lives in bridge.js so the onboarding orb reads the same bands.
// A wake from sleep is when the clock is most likely to have moved a long way
// since the last check — native already pokes this hook.
window.__hzWake = hzApplyTimeOfDay(orbEl);
winput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitFromWidget();
});
// Collapsed, the pill shows a bare ellipsis; the real placeholder only
// reads once a click has focused it and slid the bar out. Expansion is
// click-driven — hover proved twitchy. Focus also surfaces the chat
// window, so the conversation is on screen before the first keystroke.
// A class, not :focus — the widget lives in a nonactivating panel, where
// WebKit fires focus/blur events but does not reliably apply the :focus
// pseudo-class. The minimize badge overrides everything, draft included:
// the bar stays collapsed until the sliver is clicked again.
let barMinimized = false;
// The bar is an <input>, so the delegated button squish never sees it. The
// tone is tied to the OPENING rather than to a click: the sliver, a focus
// from anywhere, and a restored draft all open it, and only the transition
// should sound — syncBar runs on every focus and blur.
let barWasOpen = false;
function syncBar() {
  const open = !barMinimized && (document.activeElement === winput || winput.value.length > 0);
  if (open && !barWasOpen) hzSfx.expand();
  barWasOpen = open;
  winput.placeholder = open ? 'Message…' : '…';
  winput.classList.toggle('open', open);
  document.getElementById('wmin').style.display = open ? 'flex' : 'none';
}
winput.addEventListener('focus', () => { barMinimized = false; syncBar(); });
// NOT on focus: the native openChat makes the chat panel key, which yanks
// focus off this input mid-click and the bar snaps shut before a keystroke
// lands. Until the bridge can order the chat front without focusing it,
// the chat appears on send instead.
winput.addEventListener('blur', syncBar);
// POINTERDOWN, not click. The collapse arrow is only rendered while the bar
// is open, and pressing it blurs the input — which runs syncBar, which sets
// the arrow to display:none. On the press. So by the time the button came up
// again there was nothing under the cursor to receive a click, and whether
// the bar collapsed depended on which of the two paths happened to win.
// Acting on the press means the button cannot be taken away mid-gesture, and
// it feels quicker besides.
document.getElementById('wmin').addEventListener('pointerdown', (e) => {
  e.preventDefault(); // or the input takes focus back on the way up
  barMinimized = true;
  winput.blur();
  syncBar();
});

// The gear is the only way into settings now — connectors, their status, and
// the motion switch all live behind it.
const gearBtn = document.getElementById('gear');
gearBtn.addEventListener('click', () => {
  // The nudge's ask was "press me"; pressing it answers immediately rather
  // than waiting for native to round-trip the same conclusion.
  window.__hzGearNudge(false);
  hzPost('openConnections');
});

// People: opens the who's-who / person-index feature in its own popup.
document.getElementById('people').addEventListener('click', () => {
  hzPost('openPeople');
});
document.getElementById('globe').addEventListener('click', () => {
  hzPost('openSky');
});

// The handoff out of onboarding: the flow ends pointing at the widget, and
// the gear is the next scene's door — so it bounces and glows until settings
// has been opened once. Native drives it live (finish -> on, open -> off);
// the prefs check below is what survives a relaunch in between.
window.__hzGearNudge = (on) => gearBtn.classList.toggle('nudge', on === true);
hzPost('prefs')
  .then((p) => {
    if (p && p.onboarded === true && p.connectorsIntroDone === false) {
      window.__hzGearNudge(true);
    }
  })
  .catch(() => {});

// Anywhere that isn't a control drags the window.
document.body.addEventListener('mousedown', (e) => {
  if (e.target.closest('button, input')) return;
  hzPost('drag');
});

// Native owns the Reduce Motion override; ask for it once the page exists.
hzApplyPrefs();
