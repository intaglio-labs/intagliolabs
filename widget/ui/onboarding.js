'use strict';
// The welcome flow: welcome, message demo, connections, model, then the live
// widget spotlight. The setup steps are named because they are real work, not
// a numbered tour, and either can be skipped without renumbering the rest.
const screens = {
  1: document.getElementById('screen'),
  2: document.getElementById('screen2'),
  3: document.getElementById('screen3'),
};
// Both orbs read the same time-of-day band as the widget (bridge.js).
for (const el of document.querySelectorAll('.orb')) hzApplyTimeOfDay(el);

// Which screen is up. The setup steps finish asynchronously — a download can
// land while the owner has already moved on — so they check this before
// advancing rather than yanking whatever is on screen.
let currentScreen = 1;

function showScreen(n) {
  currentScreen = n;
  for (const [k, el] of Object.entries(screens)) {
    el.hidden = String(n) !== k;
    el.classList.remove('leaving', 'entering');
  }
  screens[n]?.classList.add('entering');
  if (String(n) === '2') runDemo();
  if (String(n) === '3') { clearDemo(); runHome(); }
  // The scrim gets out of the way of the real widget only on the last scene.
  document.body.classList.toggle('spotlight', String(n) === '3');
  // Remember where we are. Granting Full Disk Access makes macOS offer "Quit &
  // Reopen", and taking it used to restart the flow from the welcome — the whole
  // thing again, right after the hardest step in it. Fire-and-forget: a failed
  // write costs a resume, never the flow.
  hzPost('onboardingStep', { step: String(n) }).catch(() => {});
}

// Called by native when the app is launching back into a flow it was already in,
// rather than replaying one from settings.
window.__hzOnboardingResume = (step) => {
  if (!step || !(step in screens)) { showScreen(1); return; }
  clearDemo();
  demoArmed = false;
  showScreen(step);
};

// Reopening from settings reuses the same panel AND the same loaded page, so
// the flow would otherwise resume on whatever screen it was abandoned on.
// Native calls this on every open; on the very first one the page has not
// loaded yet, which is why the caller guards on the function existing.
window.__hzOnboardingReset = () => {
  clearDemo();
  demoArmed = false;
  // Replays always start at the welcome; the app location is handled by the
  // normal DMG/Finder install flow, not as a product onboarding step.
  showScreen(1);
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
// pressed. The typing is Intaglio Labs' half of the rehearsal; the send is yours.
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
  // The demo hands directly into connections. Model choice follows that, and
  // only then does the real widget surface in the bottom-right spotlight.
  at(1960, () => showScreen(3));
}
demoSend.addEventListener('click', demoSendNow);


// ---------------- final scene: where it lives ----------------
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
const HOME_FALLBACK = { x: 0.78, y: 0.86, w: 0.20, h: 0.10, clearY: 0.83 };

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
  // Leave a deliberate 8px of air above the ring. It keeps the button from
  // reading as part of the outline while still making the handoff feel tight.
  // The ring extends 10px above the measured widget rectangle.
  homeCard.style.bottom = `${Math.max(24, h - top + 18)}px`;
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
// ...and native calls this after it re-stretches the scrim for a screen change.
// `resize` alone is not enough: the widget itself moves to the new corner in the
// same beat, so the measurements have to be taken again even when this window's
// own size happens to come out unchanged.
window.__hzRehome = () => {
  if (!screens[3].hidden) runHome();
};
document.getElementById('homeDone').addEventListener('click', () => finish());

// ---------------- flow ----------------
// Welcome -> demo -> home spotlight. Connections and model choice live in Settings.
document.getElementById('cta').addEventListener('click', () => {
  hzSfx.wake();
  // Fresh installs use the roughly 5 GB model without interrupting the welcome
  // flow. An existing choice is respected; changing it lives in Settings.
  hzPost('setupState').then((st) => {
    if (st && !st.model && !st.downloading) {
      hzPost('modelDownload', { tier: '8b' }).catch(() => {});
    }
  }).catch(() => {});
  showScreen(2);
});

function finish() {
  // Put the widget back under the windows before anything else. Native does
  // this too when the panel closes, because a desktop widget left floating
  // above everything would be the worst bug this app could ship — but asking
  // first means it happens while the scene is still up rather than after.
  hzPost('spotlightWidget', { on: false }).catch(() => {});
  // Mark it done BEFORE closing: if the window goes first the page can be
  // torn down mid-message and the flow reappears on the next launch.
  hzPost('onboardingDone')
    .catch(() => {})
    // Close the full-screen scrim first, then open the real People popup it was
    // leading toward. The onboarding webview survives orderOut, so this second
    // message remains deliverable after close resolves.
    .then(() => hzPost('close'))
    .then(() => hzPost('openPeople'))
    .catch(() => {});
}

// Escape leaves but does NOT mark it done — dismissing is not finishing, and a
// flow you backed out of should still be there next time.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === 'Return') && String(currentScreen) === '2' && demoArmed) {
    e.preventDefault();
    demoSendNow();
    return;
  }
  if (e.key === 'Escape') {
    clearDemo();
    hzSfx.close();
    hzPost('spotlightWidget', { on: false }).catch(() => {});
    hzPost('close');
  }
});

hzApplyPrefs();

// The old setup implementation remains isolated below for resume compatibility
// with an already-loaded page, but its screens are no longer part of the DOM or
// reachable from onboarding. Settings owns both connections and model choice.
if (document.getElementById('screenModel')) {
// ---------------- setup: one real data source, then the model ---------------
//
// Connections come before model choice so the onboarding reads like the
// product's natural first question: what should I know about? Then it asks how
// it should think, and finally reveals the widget.
//
// Both are genuinely skippable. Everything except answering questions works
// with no model, and the app is honest-but-empty with no sources — a setup step
// that cannot be refused is a demand, not a choice, and this one is asking for
// gigabytes and access to a person's messages.

const fmtGB = (b) => `${(b / 1e9).toFixed(1)} GB`;

const modelChoices = document.getElementById('modelChoices');
const modelProg = document.getElementById('modelProg');
const modelBar = document.getElementById('modelBar');
const modelLabel = document.getElementById('modelLabel');
const modelErr = document.getElementById('modelErr');
let setupState = null;
let modelDone = false;

function renderChoices() {
  modelChoices.replaceChildren();
  if (!setupState) return;
  for (const t of setupState.tiers || []) {
    const b = document.createElement('button');
    b.className = 'ob-choice' + (t.id === setupState.recommended ? ' rec' : '');
    const head = document.createElement('b');
    head.textContent = t.label;
    const size = document.createElement('span');
    size.className = 'ob-choice-size';
    size.textContent = fmtGB(t.bytes);
    const why = document.createElement('span');
    why.className = 'ob-choice-why';
    why.textContent = t.detail;
    b.append(head, size, why);
    // One tag per card, and installed outranks recommended: what you HAVE is
    // more useful to know than what we would have suggested.
    const installed = setupState.model && t.id === setupState.model;
    if (installed || t.id === setupState.recommended) {
      const tag = document.createElement('span');
      tag.className = 'ob-choice-tag' + (installed ? ' on' : '');
      tag.textContent = installed ? 'installed' : 'suits this Mac';
      b.appendChild(tag);
    }
    b.addEventListener('click', () => startModel(t.id));
    b.dataset.tier = t.id;
    modelChoices.appendChild(b);
  }
  renderSelection();
}

// A click IS the choice. The size is on the card, so the press is informed, and
// an extra confirm step for something you can cancel from the very next frame
// is ceremony. The chosen card stays marked while it runs.
let selectedTier = null;

function renderSelection() {
  for (const el of modelChoices.querySelectorAll('.ob-choice')) {
    const on = el.dataset.tier === selectedTier;
    el.classList.toggle('sel', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

// The screen has exactly two states and ONE function decides which is up.
//
// They used to be toggled from five places, and the states drifted apart: a
// capture during testing caught the cards AND the progress bar on screen
// together, showing "starting…" forever under a set of buttons that implied
// nothing had started. Two booleans in five hands is how that happens.
function showModelPhase(phase) {
  const busy = phase === 'busy';
  modelChoices.hidden = busy;
  modelProg.hidden = !busy;
  const cancel = document.getElementById('modelCancel');
  if (cancel) {
    cancel.hidden = !busy;
    cancel.disabled = false;
    cancel.textContent = 'cancel';
  }
}

function startModel(tier) {
  // Already the installed one: nothing to fetch, and pretending to download
  // 5 GB that are already here would be a lie with a progress bar on it.
  if (setupState && setupState.model === tier) {
    showScreen(3);
    return;
  }
  selectedTier = tier;
  renderSelection();
  modelErr.hidden = true;
  showModelPhase('busy');
  modelBar.style.width = '0%';
  modelLabel.textContent = 'fetching…';
  downloading = true;
  hzPost('modelDownload', { tier }).catch(() => {});
  // MOVE ON. A multi-gigabyte download is not something to watch, and the next
  // screen is work the owner can do WHILE it runs — which is the whole reason
  // setup comes before the demo now. The fetch is native and lives in the app,
  // not in this page, so leaving the screen does not touch it, and a
  // notification finds them wherever they are when it lands.
  clearTimeout(autoAdvance);
  autoAdvance = setTimeout(() => {
    // Gated on the SCREEN, not on whether a model exists. It used to check
    // !modelDone, which loadSetup() sets true for an already-installed model —
    // so on any Mac that already had one the screen never advanced at all.
    if (currentScreen === 'model') showScreen(3);
  }, 5000);
}
let autoAdvance = null;
let downloading = false;

// Native pushes every state change through here — progress, the install step
// after the bytes land, and both endings.
window.__hzSetup = (d) => {
  if (!d || typeof d !== 'object') return;
  if (d.phase === 'downloading') {
    const pct = d.total > 0 ? Math.min(100, (d.got / d.total) * 100) : 0;
    modelBar.style.width = `${pct}%`;
    modelLabel.textContent = `${fmtGB(d.got)} of ${fmtGB(d.total)}`;
    return;
  }
  if (d.phase === 'installing') {
    modelBar.style.width = '100%';
    modelLabel.textContent = 'making sure it arrived intact…';
    return;
  }
  if (d.phase === 'ready') {
    modelDone = true;
    downloading = false;
    modelBar.style.width = '100%';
    modelLabel.textContent = 'ready';
    const cancel = document.getElementById('modelCancel');
    if (cancel) cancel.hidden = true;
    // May well arrive after the flow has moved on — that is expected, and the
    // notification is what actually delivers the news. Only advance if the
    // owner is still sitting on this screen watching it.
    setTimeout(() => { if (currentScreen === 'model') showScreen(3); }, 1200);
    return;
  }
  if (d.phase === 'failed') {
    downloading = false;
    showModelPhase('choose');
    if (d.error !== 'cancelled') {
      modelErr.hidden = false;
      modelErr.textContent = d.error || 'that did not work';
    }
  }
};

document.getElementById('modelCancel').addEventListener('click', () => {
  const btn = document.getElementById('modelCancel');
  btn.disabled = true;
  btn.textContent = 'stopping…';
  hzPost('modelCancel').catch(() => {});
  // Native answers with a 'failed' phase carrying "cancelled", which restores
  // the choices below. Not restored here: doing both would race, and a button
  // that clears the screen before the work has actually stopped is the lie this
  // whole change is about.
});
document.getElementById('modelSkip').addEventListener('click', () => showScreen(3));

// ---- the data screen -------------------------------------------------------
//
// Three of these are real system prompts and one is not, and the screen says so
// rather than pretending otherwise. Contacts, Calendar and Photos have APIs;
// Messages and Notes are SQLite files under ~/Library with no API at all, so
// macOS only offers Full Disk Access for them.
//
// The prompts land on THIS APP, which works because the reader is now a child of
// it and inherits its identity. Under launchd it was node asking, and no app can
// request a prompt for a binary it does not own.

const dataStatus = document.getElementById('dataStatus');
const permsEl = document.getElementById('perms');

// "denied" covers two very different situations and the label has to as well.
//
// A person who saw a prompt and said no should be sent to Settings. A person
// who saw NOTHING — because macOS declined to show the prompt at all — is being
// told they refused something they were never asked, which is the one message
// this app must never send. The two are told apart by whether the status was
// still undetermined when we asked: if it was, and it came back denied, no
// prompt was displayed.
const PERM_LABEL = {
  granted: 'on',
  denied: 'open settings',
  undetermined: 'allow',
  unasked: 'turn on in settings',
};

function paintPerms(map) {
  for (const row of permsEl.querySelectorAll('.ob-perm')) {
    const which = row.dataset.which;
    const st = (map && map[which]) || 'undetermined';
    const btn = row.querySelector('button');
    const on = st === 'granted';
    row.classList.toggle('on', on);
    if (which === 'fda') {
      // No prompt exists for this one, so the button is a door to Settings
      // rather than a request — and once it is on there is nothing to press.
      btn.textContent = on ? 'on' : 'open settings';
      btn.disabled = on;
      continue;
    }
    btn.textContent = PERM_LABEL[st] || 'allow';
    btn.disabled = on;
  }
}

permsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const row = e.target.closest('.ob-perm');
  if (!btn || !row) return;
  const which = row.dataset.which;
  if (which === 'fda') return; // its own handler below
  // macOS shows a prompt once and remembers a refusal, so a previously denied
  // permission cannot be re-asked from here — Settings is the only way back.
  if (btn.textContent === 'open settings') {
    hzPost('openFullDiskAccess').catch(() => {});
    return;
  }
  btn.disabled = true;
  const before = (lastPerms && lastPerms[which]) || 'undetermined';
  const res = await hzPost('requestPermission', { which }).catch(() => null);
  const map = {};
  if (res && res.which) {
    // Never asked, yet refused: macOS did not display the prompt. Say that,
    // rather than implying a decision the owner never made.
    map[res.which] =
      before === 'undetermined' && res.status === 'denied' ? 'unasked' : res.status;
  }
  lastPerms = { ...(lastPerms || {}), ...map };
  paintPerms(lastPerms);
  if (map[which] === 'unasked') {
    dataStatus.textContent =
      "macOS didn't show the prompt for that one — you can switch it on in Settings.";
  }
});

let lastPerms = null;

// LIVE PERMISSION POLLING, which is what makes this feel like it is watching.
//
// Full Disk Access has no query API and no callback, so the only way to know is
// to keep trying the read — and the only honest moment to say "on" is when it
// actually works. Polling while this screen is up means the row turns green a
// second or so after the switch is flipped in Settings, with no "press check
// when you're done" and no way to be told you granted something you did not.
//
// The same poll covers Contacts, Calendar and Photos, which can also be changed
// in Settings behind our back.
let permTimer = null;
function startPermPolling() {
  stopPermPolling();
  permTimer = setInterval(async () => {
    if (currentScreen !== 'data') return;
    const res = await hzPost('permissionState').catch(() => null);
    if (!res || !res.permissions) return;
    const prev = lastPerms || {};
    const next = { ...res.permissions };
    // Keep the more precise word: the poll only ever reports denied, and
    // downgrading "we were never asked" to "you said no" loses the truth.
    for (const k of Object.keys(next)) {
      if (prev[k] === 'unasked' && next[k] === 'denied') next[k] = 'unasked';
    }
    if (JSON.stringify(next) !== JSON.stringify(prev)) { lastPerms = next; paintPerms(next); }
  }, 1500);
}
function stopPermPolling() {
  if (permTimer) clearInterval(permTimer);
  permTimer = null;
}

document.getElementById('fdaOpen').addEventListener('click', () => {
  // Everything this used to explain in a disclosure triangle — which row to find,
  // what to press if it is missing — is now ON SCREEN beside System Settings, as
  // a card holding the app itself. Written steps describing a window the reader
  // is already looking at are worse than the window.
  hzPost('openFullDiskAccess').catch(() => {});
});

document.getElementById('dataCheck').addEventListener('click', async () => {
  dataStatus.textContent = 'having a look…';
  await hzPost('startSources').catch(() => {});
  // The ROW COUNT is the check: it only moves when something was really read
  // and really written. macOS gives this process no honest answer about a
  // grant, so we do not ask it — we look at what arrived.
  // PATIENCE IS FREE HERE, because this stops the moment anything arrives.
  //
  // The ceiling was 10 tries -- 25 seconds -- in front of a first pass whose
  // length depends on how much history there is to read. Usually rows land in
  // the first second or two and none of this matters; when they do not, 25
  // seconds was long enough to feel broken and too short to actually wait, so
  // the flow moved on and said "nothing yet" about a machine that was working.
  // A longer ceiling costs the common case nothing at all, since the loop exits
  // on the first non-zero count.
  let rows = 0;
  for (let i = 0; i < 24 && rows === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await hzPost('setupState').catch(() => null);
    rows = (st && st.rows) || 0;
    // After the first handful of tries, say that it is still going rather than
    // repeating one word at someone watching an ellipsis not change.
    if (rows === 0) {
      dataStatus.textContent = i < 6 ? 'having a look…' : 'still looking — a big library takes a minute…';
    }
  }
  if (rows > 0) {
    // FINDING IS NOT KNOWING, and saying only the first is how this went wrong.
    //
    // Rows arrive in seconds; they are answerable only once the local model has
    // read them into claims, which takes a while and used to happen nowhere at
    // all. "found 18,440 things" followed by an app that answers nothing is the
    // most confusing thing this flow could say, so it says both numbers.
    const st2 = await hzPost('setupState').catch(() => null);
    const mem = (st2 && st2.memory) || null;
    dataStatus.textContent = mem && mem.pending > 0
      ? `found ${rows.toLocaleString()} things — now reading them`
      : `found ${rows.toLocaleString()} things so far`;
    setTimeout(() => { if (currentScreen === 'data') showScreen('model'); }, 1400);
  } else {
    dataStatus.textContent = "nothing yet — that's fine, i'll keep looking as you go.";
    setTimeout(() => { if (currentScreen === 'data') showScreen('model'); }, 2600);
  }
});
document.getElementById('dataSkip').addEventListener('click', () => showScreen('model'));

// Loaded once, when the flow reaches the setup screens.
async function loadSetup() {
  setupState = await hzPost('setupState').catch(() => null);
  if (!setupState) return;
  const perms = await hzPost('permissionState').catch(() => null);
  lastPerms = (perms && perms.permissions) || null;
  paintPerms(lastPerms);
  // ALWAYS SHOW THE CHOICES. An installed model marks its card; it does not
  // replace the screen.
  //
  // This used to hide the cards entirely and say "already here", which turned
  // the one screen where a person picks how the thing thinks into a dead end:
  // no way to move up to the bigger model, no way to move down to the smaller
  // one on a Mac that was struggling, and no way to even see what the options
  // were. Having one already is a reason to mark it, not a reason to take the
  // menu away.
  // What is installed is a FACT ABOUT THE CARDS, not a statement that this
  // step is finished — conflating the two is what froze the screen.
  selectedTier = setupState.model || null;
  renderChoices();
  showModelPhase('choose');
}
}
