'use strict';
// THE SETUP FLOW: six screens, each of which checks the thing it claims.
//
// The rule the whole file is written to is that a screen may only go green on
// evidence it collected itself. Every one of these steps has an easier version
// that reads a file, a permission status or a config key and believes it —
// and every one of those easier versions has already been wrong here:
//
//   permissions   Full Disk Access has no query API, so the check is a real
//                 read of chat.db from THIS process (the reader is a child of
//                 this app and inherits its identity). A machine with no
//                 chat.db reports `unavailable`, not `granted`.
//   google        a token file on disk is not a read. The probe asks Gmail
//                 for one message and shows what Google answered.
//   linkedin      the file is checked for the header column the parser keys
//                 on BEFORE it is copied, because an unparseable export
//                 ingests as zero rows and ok:true.
//   engine        "the claude binary resolves" is not "the claude binary
//                 works". Only a probe that ran and came back ok may put the
//                 opt-in switch on screen.
//   first load    no wall-clock timer anywhere. A source is green when people
//                 were found, amber when the projection has demonstrably read
//                 every row and found nobody, and grey until it has.
//
// The typing demo and the widget spotlight from the old flow are still here,
// at the bottom, and are reached only when ops/features.json has `chat` on.
// They are not checks and they never replace one.

const screens = {
  1: document.getElementById('screen'),
  2: document.getElementById('screenPerms'),
  3: document.getElementById('screenGoogle'),
  4: document.getElementById('screenLinkedIn'),
  5: document.getElementById('screenEngine'),
  6: document.getElementById('screenLoad'),
  // Behind `chat`; see the bottom of this file.
  demo: document.getElementById('screen2'),
  home: document.getElementById('screen3'),
};

// The order with every optional scene in it. The live sequence is a subset,
// and `FULL_ORDER` is what a resume falls back through when the step it
// remembers is no longer shown.
const FULL_ORDER = ['1', 'demo', '2', '3', '4', '5', 'home', '6'];
const SETUP_ORDER = ['1', '2', '3', '4', '5', '6'];
let flow = SETUP_ORDER;

// Both orbs read the same time-of-day band as the widget (bridge.js).
for (const el of document.querySelectorAll('.orb')) hzApplyTimeOfDay(el);

// Which screen is up. The setup steps finish asynchronously — a download can
// land while the owner has already moved on — so they check this before
// advancing rather than yanking whatever is on screen.
let currentScreen = '1';

// What the owner declined. A skipped source renders "not connected" on the
// last screen — grey, and never amber: amber means "i read it and found
// nobody", which is a different and much worse thing to say about a source
// nobody connected.
const skipped = new Set();
// Set when Permissions reports `unavailable` for Full Disk Access: there is no
// chat.db on this Mac at all. The iMessage row is then omitted rather than
// drawn at zero, because zero rows is the correct outcome and looks identical
// to a failure.
let noMessagesOnThisMac = false;

function showScreen(n) {
  const key = String(n);
  leaveScreen(currentScreen);
  currentScreen = key;
  for (const [k, el] of Object.entries(screens)) {
    if (!el) continue;
    el.hidden = key !== k;
    el.classList.remove('leaving', 'entering');
  }
  screens[key]?.classList.add('entering');
  if (key === 'demo') runDemo();
  if (key === 'home') { clearDemo(); runHome(); }
  if (key === '1') enterWelcome();
  if (key === '2') enterPerms();
  if (key === '3') enterGoogle();
  if (key === '4') enterLinkedIn();
  if (key === '5') enterEngine();
  if (key === '6') enterLoad();
  // The scrim gets out of the way of the real widget only on the spotlight.
  document.body.classList.toggle('spotlight', key === 'home');
  // Remember where we are. Granting Full Disk Access makes macOS offer "Quit &
  // Reopen", and taking it used to restart the flow from the welcome — the whole
  // thing again, right after the hardest step in it. Fire-and-forget: a failed
  // write costs a resume, never the flow.
  hzPost('onboardingStep', { step: key }).catch(() => {});
}

// Every screen that starts a timer stops it here. A poll left running behind a
// screen nobody is looking at is a request every three seconds, forever, and
// on this flow two of them write nothing but one of them starts connectors.
function leaveScreen(key) {
  if (key === '2') stopPermPolling();
  if (key === '3') stopGooglePolling();
  if (key === '6') stopLoadPolling();
}

// LEAVING THE FLOW IS LEAVING A SCREEN, and it was not treated as one.
//
// showScreen() is the only caller of leaveScreen, so escaping the panel — or
// finishing it — stopped nothing: `currentScreen` never changed, every tick's
// own `if (currentScreen !== …) return` guard therefore never fired, and the
// panel reuses the same loaded page, so the timers outlived the window. From
// screen 3 that is a live Gmail messages.list every poll for the rest of the
// ten-minute window; from screen 6 a relCardPeek that refills the producer's
// batch, forever, behind a closed panel.
function leaveFlow() {
  leaveScreen(currentScreen);
}

// ...and the panel can also go away without the page being told: native orders
// it out on its own routes (the widget's own close, a screen change). An
// ordered-out webview reports itself hidden, which is the only signal the page
// gets, so it is treated as leaving too.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { leaveFlow(); return; }
  // Back on screen: re-arm the two local polls. Google is deliberately not
  // re-armed — it has a focus probe and a button, and restarting its window
  // here would reopen ten minutes of API calls nobody asked for.
  if (currentScreen === '2') startPermPolling();
  if (currentScreen === '6') startLoadPolling({ peekNow: false });
});

function nextScreen() {
  // HELD, not dropped, until native has said where this flow starts. See the
  // entry gate below.
  if (!entrySettled) { pendingAdvance = true; return; }
  const at = flow.indexOf(currentScreen);
  const to = at === -1 ? '1' : flow[Math.min(at + 1, flow.length - 1)];
  showScreen(to);
}

// A RESUME THAT ARRIVES LATE IS NOT A RESUME — SO THE FLOW WAITS FOR IT.
//
// native calls exactly one of __hzOnboardingResume and __hzOnboardingReset on
// every open (main.swift openOnboarding: the remembered step if this is a
// launch back into a flow, a rewind otherwise), immediately after creating the
// panel. On the very first launch the page has not finished loading, so WebKit
// runs the evaluation once the document exists — which can be seconds later,
// and on the owner's machine that was AFTER they had pressed "hello". The flow
// showed the welcome, moved to the permissions screen on the click, and was
// then yanked to the remembered step: screen 2 was on screen for a few frames
// and the owner never saw it, on the one screen everything downstream depends
// on.
//
// The first fix was an `ownerMoved` flag — whichever of the two got there
// first won. That is a race with a coin in it, not one race fewer, and losing
// it costs the owner screens 2 to 4 a second time.
//
// This removes the race instead of picking a winner. The welcome is painted as
// it always was (there is no blank screen and nothing to see), but the one
// press available on it is HELD until native has spoken, and then replayed on
// a rewind — the owner is exactly where they thought they were — or dropped on
// a resume, where native is putting them on a later screen the press was never
// aimed at. The wait is one message hop. ENTRY_WAIT_MS bounds it so a page
// opened with no native behind it is never stuck.
//
// AND THE BOUND IS A BOUND ON WAITING, NOT A DEADLINE ON NATIVE. A resume that
// arrives at 2 s — a cold launch on a slow machine, which is exactly the
// launch that follows granting Full Disk Access and taking macOS's "Quit &
// Reopen" — used to be dropped on the floor, and the owner redid screens 2 to
// 4. What the fallback settles is the PRESS: after it, the welcome's button
// works. If nobody has pressed it, nothing has been decided and a late resume
// is still the right answer, which is what the ownerMoved flag was right
// about. So the late rule is the old one: honour it unless the owner has
// already moved under their own steam. main.swift does not rely on this — it
// asks the page to acknowledge and re-delivers if it did not — but the two
// defences answer different halves of the same hop.
const ENTRY_WAIT_MS = 1500;
let entrySettled = false;
let pendingAdvance = false;
// The one press this flow holds. Not `pendingAdvance`, which is consumed by
// the flush: this records that the owner acted at all.
let ownerPressed = false;
// Native says exactly one of resume/reset per open. A resume is a launch-only
// word about a freshly loaded page, so a second one is a re-delivery of the
// first and must not move a flow that has already acted on it.
let resumeHeard = false;
const entryFallback = setTimeout(() => {
  settleEntry();
  flushPendingAdvance();
}, ENTRY_WAIT_MS);

function settleEntry() {
  entrySettled = true;
  clearTimeout(entryFallback);
  setCtaHeld(false);
}

// The held press, shown. The CTA plays its sound and then swallows the move
// while the gate is closed, which reads as a dead button; disabling it says
// "heard you, waiting" in the one vocabulary the screen already has, and stops
// a second press playing the sound again. `.ob-cta[disabled]` is in palette.css.
function setCtaHeld(on) {
  const cta = document.getElementById('cta');
  if (cta) cta.disabled = on;
}

function flushPendingAdvance() {
  if (!pendingAdvance) return;
  pendingAdvance = false;
  nextScreen();
}

// Called by native when the app is launching back into a flow it was already in,
// rather than replaying one from settings.
//
// Only ever the FIRST word about this page: main.swift passes resume:true only
// at launch, which always builds the panel and its page fresh, and a reused
// panel is rewound by __hzOnboardingReset below.
window.__hzOnboardingResume = (step) => {
  // Acknowledged either way: main.swift reads this to decide whether anything
  // was listening, and a page that has already been told was listening.
  if (resumeHeard) return true;
  resumeHeard = true;
  // Late, i.e. the fallback has already let the welcome's button go live.
  const late = entrySettled;
  settleEntry();
  // They pressed on before native spoke and the flow let them. Yanking them
  // back now is the failure the hold exists to prevent, in the other
  // direction.
  if (late && ownerPressed) return true;
  clearDemo();
  demoArmed = false;
  // Their press was aimed at the welcome; native is moving them past it.
  pendingAdvance = false;
  showScreen(resumeTarget(step));
  return true;
};

// A REMEMBERED STEP MAY NO LONGER BE A SCREEN. `chat` can be turned off
// between the write and the read, and the demo and spotlight leave the
// sequence when it is. Falling back to 1 would replay the whole flow right
// after its hardest step, which is the exact failure onboardingStep exists to
// prevent — so fall back to the nearest EARLIER screen that is still shown.
function resumeTarget(step) {
  const key = String(step ?? '');
  if (flow.includes(key)) return key;
  const at = FULL_ORDER.indexOf(key);
  if (at === -1) return '1';
  for (let i = at - 1; i >= 0; i -= 1) {
    if (flow.includes(FULL_ORDER[i])) return FULL_ORDER[i];
  }
  return '1';
};

// Reopening from settings reuses the same panel AND the same loaded page, so
// the flow would otherwise resume on whatever screen it was abandoned on.
// Native calls this on every open; on the very first one the page has not
// loaded yet, which is why the caller guards on the function existing.
window.__hzOnboardingReset = () => {
  settleEntry();
  clearDemo();
  demoArmed = false;
  // Replays always start at the welcome; the app location is handled by the
  // normal DMG/Finder install flow, not as a product onboarding step.
  showScreen('1');
  // ...and a press held while the page was waiting was aimed at this screen,
  // which is the screen it is now on. Honour it rather than eating it.
  flushPendingAdvance();
  // Acknowledged, for the same reason as the resume above.
  return true;
};

// The optional scenes, resolved once. hzFeatures() caches per page load and
// fails closed, so no answer means the setup sequence — which is the sequence
// that contains every actual check.
hzFeatures().then((set) => {
  if (hzFeatureOn(set, 'chat')) flow = FULL_ORDER;
}).catch(() => {});

// ---------------- 1: who this is for ----------------
const modesEl = document.getElementById('modes');
const modeNote = document.getElementById('modeNote');

function paintMode(mode) {
  for (const b of modesEl.querySelectorAll('.ob-mode')) {
    b.classList.toggle('ob-mode-on', b.dataset.mode === mode);
  }
}

// READ THE MODE, DO NOT ASSUME IT. A replay of onboarding on a machine where
// the owner deliberately chose "founders" must not redraw as "anyone" — the
// row would then be one tap from writing a choice they never made back over
// the real one. relCardPeek is used because it already answers the server's
// current mode and records nothing: no `shown`, no cap slot, no cooldown.
function enterWelcome() {
  // A REPLAY IS NOT THE SESSION THAT FAILED. The note is written by writeMode
  // and cleared by nothing, so an apology from a run where hermes was down
  // survived every later showing of this screen -- including one where the
  // choice had since landed.
  modeNote.textContent = '';
  hzPost('relCardPeek')
    .then((out) => { if (out && typeof out.mode === 'string') paintMode(out.mode); })
    .catch(() => {});
}

// AND THE ROUTE'S ANSWER IS READ, because it is the only thing that knows.
//
// POST /admin/relationship/mode deliberately answers 200 with
// `persisted: false` when its config write fails: the mode IS live in the
// running reader, so a 4xx would make the picker look broken when what broke
// is durability. Throwing that flag away left the note directly under this row
// promising "your choice is kept by the reader" while the next restart
// silently reverted it to the old one.
//
// Retried once -- the write is an atomic read-modify-write of one small file,
// so a second attempt is a real chance rather than a ritual -- and then said
// out loud. Quietly: the same ob-note voice as the promise it is correcting,
// no alarm colour, because nothing the owner did caused this and the choice
// they made is in force right now.
//
// A reply with no `persisted` at all is a reply that never reached the route.
// That is the hermes-still-starting case the note above already describes, so
// there is nothing here to add to it.
function writeMode(mode, retried) {
  return hzPost('relMode', { mode })
    .then((out) => {
      if (!out || typeof out.persisted !== 'boolean') return undefined;
      if (out.persisted) { modeNote.textContent = ''; return undefined; }
      if (!retried) return writeMode(mode, true);
      // AND THE SENTENCE CHANGED WITH THE FACTS. The pick is now written down
      // natively the moment it is made and re-delivered until the reader keeps
      // it (Bridge.cardModePending), exactly as the daily cap already was -- so
      // "it will go back to the last saved one" stopped being true. What is
      // still true is that it is not saved YET.
      modeNote.textContent = 'i could not write that choice down yet, so i am holding on to it '
        + 'and will try again. it is in use right now either way.';
      return undefined;
    })
    .catch(() => {});
}

// Only an actual click writes. See above.
modesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.ob-mode');
  if (!btn) return;
  paintMode(btn.dataset.mode);
  writeMode(btn.dataset.mode, false);
});

document.getElementById('cta').addEventListener('click', () => {
  hzSfx.wake();
  ownerPressed = true;
  // Held rather than acted on, and the button says so until native speaks or
  // the gate times out. See setCtaHeld.
  if (!entrySettled) setCtaHeld(true);
  nextScreen();
});

// ---------------- 2: your messages ----------------
const permsEl = document.getElementById('perms');
const permNote = document.getElementById('permNote');
const permBundle = document.getElementById('permBundle');
const permNext = document.getElementById('permNext');

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
  unavailable: 'nothing to read',
};

let lastPerms = null;

function paintPerms(map) {
  for (const row of permsEl.querySelectorAll('.ob-perm')) {
    const which = row.dataset.which;
    const st = (map && map[which]) || 'undetermined';
    const btn = row.querySelector('button');
    const on = st === 'granted';
    row.classList.toggle('on', on);
    row.classList.toggle('nothing', st === 'unavailable');
    if (which === 'fda') {
      // No prompt exists for this one, so the button is a door to Settings
      // rather than a request — and once it is on there is nothing to press.
      // `unavailable` is neither: there is no Messages history on this Mac, so
      // the switch would buy nothing and the row says so instead of going
      // green over an empty source.
      if (st === 'unavailable') {
        noMessagesOnThisMac = true;
        btn.textContent = 'no messages on this Mac';
        btn.disabled = true;
      } else {
        btn.textContent = on ? 'on' : 'open settings';
        btn.disabled = on;
      }
      permNext.disabled = !(on || st === 'unavailable');
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
  if (which === 'fda') {
    // Everything this used to explain in a disclosure triangle — which row to
    // find, what to press if it is missing — is now ON SCREEN beside System
    // Settings, as a card holding the app itself. Written steps describing a
    // window the reader is already looking at are worse than the window.
    hzPost('openFullDiskAccess').catch(() => {});
    return;
  }
  // macOS shows a prompt once and remembers a refusal, so a previously denied
  // permission cannot be re-asked from here — Settings is the only way back.
  if (btn.textContent === 'open settings' || btn.textContent === 'turn on in settings') {
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
    permNote.textContent =
      "macOS didn't show the prompt for that one — you can switch it on in Settings.";
  }
  if (map[which] === 'granted') startedSources();
  // The grant just moved, so the question the bundle note answers may have a
  // different answer now. This is the "and after a permission request" half of
  // the deep check, which was described in two comments and implemented in
  // neither.
  recheckBundleNote();
});

// ~~"granting to: io.intaglio.widget"~~ ON EVERY MAC. A bundle identifier on
// the second screen of a consumer flow, explaining a problem almost nobody
// looking at it has: the August rename left one identifier allowed in Full Disk
// Access and the other denied, and the line existed so the owner could tell
// which Settings row was the live one.
//
// Native probes for that now (Permissions.staleGrantBundle) and answers
// `staleBundle` only when this process cannot read AND this Mac carries the
// marks of a pre-rename install. With no mismatch there is nothing to say, and
// the screen says nothing — which is every ordinary install.
function paintBundleNote(res) {
  // A POLL REPLY CARRIES NO ANSWER TO THIS. The probe is two directory reads
  // and two stats, so native runs it only on the deep check (screen entry, and
  // after a permission request) and says which kind of reply this is. Treating
  // an ordinary tick as "no mismatch" would rub out the line entry drew, three
  // seconds after drawing it.
  if (res?.staleChecked !== true) return;
  const stale = typeof res?.staleBundle === 'string' ? res.staleBundle : '';
  const mine = typeof res?.bundle === 'string' ? res.bundle : '';
  if (!stale || !mine) {
    permBundle.textContent = '';
    return;
  }
  // CONDITIONAL, because nothing here can see that list. TCC.db is protected by
  // the very grant being probed, so this Mac carrying the marks of an older
  // install is as close as we get — the row may or may not still be listed, and
  // a sentence that promises two rows to somebody looking at one sends them
  // hunting. "if you see" is true either way, and useful only in the case the
  // probe exists for.
  permBundle.textContent = `if you see a row for an older copy of me (${stale}), that one is not `
    + `this one — the switch has to be on for ${mine}.`;
}

// THE ANSWER CAN CHANGE WHILE THE SCREEN IS UP, and this is what asks again.
// The deep check ran on entry and nowhere else, so the note outlived the thing
// it described: the owner granted Full Disk Access, the row turned green on the
// next poll, and the sentence about which switch to use stayed on screen until
// they left and came back.
function recheckBundleNote() {
  hzPost('permissionState', { diagnostic: true })
    .then((res) => {
      if (!res) return;
      paintBundleNote(res);
    })
    .catch(() => {});
}

// LIVE PERMISSION POLLING, which is what makes this feel like it is watching.
//
// Full Disk Access has no query API and no callback, so the only way to know is
// to keep trying the read — and the only honest moment to say "on" is when it
// actually works. Polling while this screen is up means the row turns green a
// second or so after the switch is flipped in Settings, with no "press check
// when you're done" and no way to be told you granted something you did not.
//
// The same poll covers Contacts and Calendar, which can also be changed in
// Settings behind our back.
let permTimer = null;

// 3s, not 1.5s. Every tick is a real protected read — a FileHandle open on
// chat.db and a one-byte read — and on a denied machine every one of those is
// a tccd denial event. The row still turns green within a breath of the switch
// moving in Settings, which is the whole point of polling at all; twice the
// number of denials bought none of it.
const PERM_POLL_MS = 3000;

function startPermPolling() {
  stopPermPolling();
  permTimer = setInterval(async () => {
    if (currentScreen !== '2') return;
    const res = await hzPost('permissionState').catch(() => null);
    if (!res || !res.permissions) return;
    paintBundleNote(res);
    const prev = lastPerms || {};
    const next = { ...res.permissions };
    // Keep the more precise word: the poll only ever reports denied, and
    // downgrading "we were never asked" to "you said no" loses the truth.
    for (const k of Object.keys(next)) {
      if (prev[k] === 'unasked' && next[k] === 'denied') next[k] = 'unasked';
    }
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      lastPerms = next;
      paintPerms(next);
      // Something turned green since the last look: the reader can suddenly
      // see more, and it only picks that up when it runs.
      if (Object.values(next).includes('granted')) startedSources();
      // A READ THAT NOW WORKS ENDS THE QUESTION. The whole note is about which
      // app the switch belongs to; once this one can read, it belongs to this
      // one, and the sentence is answered rather than merely stale. Cleared
      // here without a round trip, and re-asked below in case the grant landed
      // on something else.
      if (next.fda === 'granted') permBundle.textContent = '';
      else if (prev.fda !== next.fda) recheckBundleNote();
    }
  }, PERM_POLL_MS);
}

function stopPermPolling() {
  if (permTimer) clearInterval(permTimer);
  permTimer = null;
}

// Writes the connectors config if it is missing, retires the launchd agent and
// starts the daemon as a child of this app. Idempotent, and cheap enough to
// call on every edge rather than tracking whether it has run.
function startedSources() {
  hzPost('startSources').catch(() => {});
}

function enterPerms() {
  // THE DIAGNOSTIC IS ASKED FOR HERE, and only here and after a request.
  // Permissions.writeDiagnostic() evaluates every permission a second time and
  // writes ~/.hazlie/logs/permissions.json; on the poll path that was a second
  // full round of protected reads plus a createDirectory and a file write
  // every tick. It is worth writing when somebody is about to read it — the
  // moment this screen opens, and the moment a prompt has been answered.
  hzPost('permissionState', { diagnostic: true }).then((res) => {
    if (!res) return;
    paintBundleNote(res);
    lastPerms = res.permissions || null;
    paintPerms(lastPerms);
  }).catch(() => {});
  startPermPolling();
}

document.getElementById('permSkip').addEventListener('click', () => {
  skipped.add('imessage');
  skipped.add('contacts');
  skipped.add('calendar');
  nextScreen();
});
// LEAVING THIS SCREEN STARTS THE READER, whether or not a grant changed hands
// here. startedSources() used to fire only on a permission turning green, so a
// Mac that already had every grant (any reinstall; the second clean-machine
// run, 2026-09-12) walked past this screen with nothing started and the daily
// card's settings unwritten until the LinkedIn import or screen 6's button
// happened to call it. Starting twice is harmless: native guards a running
// daemon and the card-defaults write is only-when-absent.
permNext.addEventListener('click', () => { startedSources(); nextScreen(); });

// ---------------- 3: your mail and calendar ----------------
const googleStatus = document.getElementById('googleStatus');
const googleNext = document.getElementById('googleNext');
const googleStart = document.getElementById('googleStart');

let googleTimer = null;
let googleUntil = 0;
let googleProbes = 0;
// Set when the owner presses the button this visit; see paintGoogle's last branch.
let googleAsked = false;
// WHY THE BUTTON DID NOTHING, WHEN IT DID NOTHING.
//
// The sign-in can fail before Google is ever reached: no OAuth client on this
// Mac, the helper missing from the bundle, connect down, the browser refusing
// the launch. Every one of those came back as a rejected reply into
// `.catch(() => {})` and left the owner looking at "opening google in your
// browser…" with no browser and no explanation (seen live on the clean-machine
// retest, 2026-09-12).
//
// It is kept in a variable rather than only written to the element because the
// probes that follow would paint over it: googleProbe cannot tell "nothing
// signed in yet" from "the sign-in could not be started", and the more
// specific sentence is the one worth keeping. Cleared on entering the screen
// and on every fresh press, so it never outlives the attempt it describes.
let googleRefusal = null;
// WHEN THE BROWSER WAS OPENED, or 0 if no sign-in is in flight.
//
// The press starts a poll with a leading probe, and on a fresh install that
// probe answers {accounts:0, stale:0, failures:[]} -- which is indistinguishable
// from a sign-in the owner walked away from. Live on the clean-machine walk
// (2026-09-12) the alarm-coloured "that sign-in did not finish" appeared within
// a second of the press, while the browser was still opening. The googleAsked
// gate fixed the probe on ENTERING the screen; this is the same accusation one
// press later.
//
// Cleared by the owner coming back (the focus probe), by an account that
// actually reads, and by the wait below running out -- so the failure copy is
// still reachable on a machine where the focus event never arrives.
let googleOpenedAt = 0;

// EVERY PROBE IS A REAL GMAIL READ, per live account
// (connect/lib/googleProbe.mjs asks messages.list), uncached and unthrottled,
// against the same measured per-user ceiling the mail connector is spending
// while the daemon backfills behind this screen. At 3s that was 200 probes in
// the ten-minute window and roughly 40 calls a minute out of the budget — and
// the failure it produced was self-inflicted: the probe 403s with
// rateLimitExceeded and this screen renders "signed in, but google refused the
// read", an amber accusation caused by the poll asking.
//
// 15s is still well inside "it turns green while you are looking at it", and
// the two paths that actually matter — coming back from the browser, and
// pressing the button — probe immediately regardless.
const GOOGLE_POLL_MS = 15000;
// And a ceiling on the whole visit, so a page left open on this screen cannot
// spend the budget by sitting there. 40 covers the ten-minute window.
const GOOGLE_PROBE_CAP = 40;
// HOW LONG "waiting for you in the browser…" OUTLIVES THE PRESS with nobody
// coming back. Four ticks of the poll, so it is stated in the unit that
// actually repaints the screen rather than in a second number that has to be
// kept in step with the first. A minute is long enough to pick an account and
// answer a second factor; past it, an owner staring at this screen has a
// browser they did not finish with, and saying so is the useful thing.
const GOOGLE_WAIT_MS = 4 * GOOGLE_POLL_MS;
// HOW MUCH OF THAT WINDOW IS LEFT, and why it is a variable.
//
// Coming back from the browser used to ZERO the window, on the theory that an
// owner who has returned has finished with it. They have -- but `ops/gcal-auth`
// is still writing the grant, and the focus event beats that write by about a
// second. The probe then reads zero live accounts with the window already spent
// and the screen says "that sign-in did not finish" about a consent the owner
// just completed: the exact accusation the window exists to prevent, arriving
// through the one event most likely to coincide with it.
//
// So focus RESTARTS the window rather than clearing it, and shortens it to a
// single poll: long enough to cover the token write, short enough that an owner
// who really did cancel hears so within fifteen seconds instead of a minute.
let googleWaitMs = GOOGLE_WAIT_MS;

function paintGoogle(out) {
  googleStatus.classList.remove('ok', 'warn', 'bad');
  if (!out || out.state !== 'ok') {
    // The probe itself could not answer. If the owner is looking at a reason
    // the sign-in never started, that is still the truest thing on screen.
    if (paintGoogleRefusal()) return;
    googleStatus.textContent = 'not connected';
    return;
  }
  if (out.reading > 0) {
    googleRefusal = null;
    googleOpenedAt = 0;
    googleStatus.classList.add('ok');
    const n = out.reading;
    googleStatus.textContent = `mail and calendar — ${n} account${n === 1 ? '' : 's'}, reading`;
    googleNext.hidden = false;
    googleStart.textContent = 'sign in to another account';
    return;
  }
  const failure = (out.failures || [])[0];
  if (failure) {
    // AMBER, AND SAY WHAT GOOGLE SAID. Consent completed and the read was
    // refused — the project over its restricted-scope cap, or gmail.readonly
    // unticked while calendar stayed on. Showing the raw status and reason is
    // the difference between a screen the owner can act on and one that says
    // "something went wrong" about a grant they can see they gave.
    googleStatus.classList.add('warn');
    const reason = failure.reason ? ` (${failure.reason})` : '';
    googleStatus.textContent = failure.status
      ? `signed in, but google refused the read (HTTP ${failure.status})${reason}`
      : 'signed in, but the check could not reach google';
    googleNext.hidden = false;
    return;
  }
  if (out.stale > 0) {
    googleStatus.classList.add('warn');
    googleStatus.textContent = 'that sign-in has expired — sign in again';
    return;
  }
  // NOTHING SIGNED IN. Before the owner has pressed the button this is the
  // ordinary state of a fresh install, and the immediate probe on entering the
  // screen used to paint it in the alarm colour as a sign-in that "did not
  // finish" -- an accusation about a step nobody had taken (seen live on the
  // first clean-machine run, 2026-09-12). The failure copy belongs to a
  // sign-in the owner started on this visit and came back from empty-handed.
  if (paintGoogleRefusal()) return;
  if (!googleAsked) {
    googleStatus.textContent = 'not connected';
    return;
  }
  // STILL IN THE BROWSER. Nothing is wrong yet: consent takes as long as it
  // takes, and the leading probe fires within a second of the press. Neutral,
  // and no colour class -- an empty result during a sign-in that is still
  // happening is the expected reading, not a finding.
  if (Date.now() - googleOpenedAt < googleWaitMs) {
    googleStatus.textContent = 'waiting for you in the browser…';
    return;
  }
  googleStatus.classList.add('bad');
  googleStatus.textContent = 'that sign-in did not finish';
}

// AMBER, NOT RED, and in connect's own words. This is a prerequisite the owner
// can act on — install the client, start the service — not a grant they gave
// that failed. Returns whether it painted, so paintGoogle can hand it the two
// states it would otherwise describe less accurately.
function paintGoogleRefusal() {
  if (!googleRefusal) return false;
  googleStatus.classList.add('warn');
  googleStatus.textContent = googleRefusal;
  return true;
}

// WHAT THE NATIVE REPLY SAYS ABOUT WHETHER ANYTHING STARTED.
//
// `refused` is GoogleLogin's: a URL that is not Google's, or a browser macOS
// would not launch. `state` is bridgeCall's, stamped on every answer it
// SYNTHESISES — auth, down, or a non-200 carrying connect's own `error`. The
// successful reply carries NEITHER, because Bridge.swift answers a launched
// browser with {ok, opened} straight from GoogleLogin — so an absent `state`
// is success here, and testing `state !== 'ok'` would paint every working
// sign-in amber.
//
// AND THE POSITIVE FIELDS ARE TESTED, NOT INFERRED FROM TWO ABSENCES. The
// success reply is `{ok: true, opened: true}`, so `opened === false` is the
// native side saying in as many words that no browser opened. Today
// GoogleLogin.present always supplies a `why` alongside a false, which is the
// only reason reading neither field has worked; a future `done(false, nil)`
// would return null here and start ten minutes of live Gmail reads against a
// browser that never opened. Read what the reply says.
function googleAuthRefusal(out) {
  if (!out) return 'could not start the google sign-in';
  if (typeof out.refused === 'string' && out.refused) return out.refused;
  if (out.state && out.state !== 'ok') {
    return typeof out.error === 'string' && out.error
      ? out.error
      : 'could not start the google sign-in';
  }
  if (out.ok === false || out.opened === false) return 'could not start the google sign-in';
  return null;
}

// THE CAP BELONGS TO THE TIMER, AND ONLY TO IT — THE SPENDING AS WELL AS THE
// CHECK.
//
// It used to be checked here, ahead of everything, so once the window's 40
// were spent the BUTTON and the returning-from-the-browser probe both became
// silent no-ops and the screen sat on "opening google in your browser…"
// forever. The comment above GOOGLE_POLL_MS asserts the opposite of that in so
// many words: the two paths that answer an owner action probe immediately
// regardless. An owner who alt-tabs enough to spend the cap is the owner most
// likely to be waiting on this screen.
//
// Moving the check out but leaving the COUNT here was the same bug wearing a
// hat: 40 alt-tabs while signing in still filled the counter, the interval
// killed itself on its next tick, and the screen's automatic polling was dead
// for the rest of the visit with nothing on screen saying so. The cap's own
// stated purpose is that a page cannot spend the budget by doing NOTHING, so
// what it counts is the probes nobody asked for.
function probeGoogle() {
  return hzPost('googleProbe').then(paintGoogle).catch(() => {});
}

// Ten minutes of polling after the browser opens, because consent happens in
// another application and there is no callback into this page. After that,
// on focus only: a poll that runs forever behind a screen nobody is on is a
// live API call every three seconds.
function startGooglePolling() {
  stopGooglePolling();
  googleUntil = Date.now() + 10 * 60 * 1000;
  // ONE PROBE NOW. The button starts this poll, and without a leading probe
  // the first feedback the owner gets after pressing it is one GOOGLE_POLL_MS
  // away -- 15s, where the 3s poll this replaced used to answer in 3.
  probeGoogle();
  googleTimer = setInterval(() => {
    // The cap is the timer's, so a page left sitting on this screen cannot
    // spend the per-user read budget by doing nothing.
    if (currentScreen !== '3' || Date.now() > googleUntil || googleProbes >= GOOGLE_PROBE_CAP) {
      stopGooglePolling();
      return;
    }
    googleProbes += 1;
    probeGoogle();
  }, GOOGLE_POLL_MS);
}

function stopGooglePolling() {
  if (googleTimer) clearInterval(googleTimer);
  googleTimer = null;
}

// AND THE OLD POLL IS STOPPED BEFORE THE NEW BUDGET IS HANDED OUT. The
// interval self-terminates only on a tick where the screen has changed, so
// leaving screen 3 and returning inside the ten-minute window comes back to a
// poll that is still alive -- and resetting the counter under it gives that
// same interval a second full GOOGLE_PROBE_CAP. Every probe is a live Gmail
// read, so a few laps of screen 3 spent the budget several times over.
// Stopping first makes the reset mean what it says: one visit, one budget.
//
// Stopped rather than restarted, because the lines that follow already clear
// `googleAsked` and `googleOpenedAt` -- a re-entry is this screen starting
// over, and a poll left running underneath that contradicted it. The owner is
// not left without an answer: the entry probes once, and returning from the
// browser probes again on window focus.
//
// The cap itself is per VISIT, not per page load: leaving and coming back is
// the owner asking again, and that is a different thing from a page sitting on
// this screen for an hour.
function enterGoogle() {
  // EXCEPT WHEN THERE IS A CONSENT SCREEN STILL OPEN.
  //
  // Clearing the press on re-entry made this screen forget a sign-in that is
  // still happening: it says "not connected" about a browser tab the owner is
  // looking at, and the poll that would have turned it green has been stopped,
  // so nothing but another focus event ever corrects it. A re-entry is this
  // screen starting over for everything EXCEPT the one thing that outlives it.
  const outstanding = googleAsked && Date.now() - googleOpenedAt < googleWaitMs;
  stopGooglePolling();
  googleProbes = 0;
  googleRefusal = null;
  googleAsked = outstanding;
  if (!outstanding) {
    googleOpenedAt = 0;
    googleWaitMs = GOOGLE_WAIT_MS;
    probeGoogle();
    return;
  }
  // The budget is per VISIT, so this visit gets its own; the press it is
  // waiting on is not a new one.
  startGooglePolling();
}

window.addEventListener('focus', () => {
  if (currentScreen !== '3') return;
  // THE OWNER IS BACK, and the probe about to run is the one most likely to
  // race the grant being written. See googleWaitMs: one more poll of neutral
  // copy, not none, and not the whole minute the press bought.
  if (googleAsked) {
    googleOpenedAt = Date.now();
    googleWaitMs = GOOGLE_POLL_MS;
  } else {
    googleOpenedAt = 0;
  }
  probeGoogle();
});

googleStart.addEventListener('click', () => {
  googleAsked = true;
  googleRefusal = null;
  googleStatus.classList.remove('ok', 'warn', 'bad');
  googleStatus.textContent = 'opening google in your browser…';
  // AND THE POLL ONLY STARTS IF SOMETHING DID. Ten minutes of live Gmail reads
  // is the cost of waiting for a consent screen; a consent screen that was
  // never opened is not worth one call, let alone forty.
  hzPost('googleAuth', { flow: 'google' })
    .then((out) => {
      const why = googleAuthRefusal(out);
      if (why) {
        googleAsked = false;
        googleOpenedAt = 0;
        googleRefusal = why;
        paintGoogleRefusal();
        return;
      }
      // A BROWSER IS OPEN. Marked before the poll, because startGooglePolling
      // probes immediately and that probe is the one that used to paint the
      // accusation.
      googleOpenedAt = Date.now();
      googleWaitMs = GOOGLE_WAIT_MS;
      startGooglePolling();
    })
    .catch(() => {
      googleAsked = false;
      googleOpenedAt = 0;
      googleRefusal = 'could not start the google sign-in';
      paintGoogleRefusal();
    });
});
googleNext.addEventListener('click', () => nextScreen());
document.getElementById('googleSkip').addEventListener('click', () => {
  skipped.add('mail');
  skipped.add('calendar');
  nextScreen();
});

// ---------------- 4: who you know professionally ----------------
const linkedInStatus = document.getElementById('linkedInStatus');
const linkedInNext = document.getElementById('linkedInNext');

function paintLinkedIn(out) {
  linkedInStatus.classList.remove('ok', 'warn', 'bad');
  if (!out || out.state === 'cancelled') { linkedInStatus.textContent = ''; return; }
  if (out.state === 'ok') {
    linkedInStatus.classList.add('ok');
    const n = Number(out.connections || 0);
    linkedInStatus.textContent = n > 0
      ? `${n.toLocaleString()} connections`
      : 'imported';
    // AND WHEN ITS AGE COULD NOT BE RECORDED, SAY SO HERE RATHER THAN LET IT
    // SURFACE LATER AS A REFUSAL. An export with no readable date whose stamp
    // also failed leaves the installed copy dated "now", and a later import of
    // the owner's own file would otherwise be turned away as older than the one
    // they have. Native no longer refuses on a date it does not know; this is
    // the sentence that stops the owner being surprised by the consequence.
    if (Array.isArray(out.unknownVintage) && out.unknownVintage.length > 0) {
      linkedInStatus.textContent +=
        " — i could not tell how old it is, so i won't turn away a later one.";
    }
    linkedInNext.hidden = false;
    return;
  }
  linkedInStatus.classList.add('bad');
  if (out.reason === 'columns') {
    // THE COLUMN, NAMED BACK. "I cannot read this" is an accusation with no
    // remedy in it; the first column tells the owner exactly what happened.
    linkedInStatus.textContent =
      `i don't recognise this file's columns — the first one is "${out.firstColumn}". `
      + 'i can only read the english export today.';
    return;
  }
  // ~~"that's the zip — unzip it and choose Connections.csv from inside it."~~
  // The zip IS the file LinkedIn sends, and telling the owner to go and unpack
  // it by hand was the app refusing the only thing it had actually asked for.
  // Native takes Connections.csv out of the archive now (Bridge
  // extractConnections), so the two zip answers left are the two real failures,
  // and only one of them has a remedy in it.
  if (out.reason === 'zip-connections') {
    linkedInStatus.textContent =
      `there is no Connections.csv anywhere in ${out.file || 'that zip'} — tick `
      + '"connections" when you request the export and it will be in the next one.';
    return;
  }
  if (out.reason === 'zip') {
    linkedInStatus.textContent = "i couldn't open that zip.";
    return;
  }
  if (out.reason === 'newer') {
    linkedInStatus.textContent =
      `you already have a newer ${out.file} — i kept the one you have.`;
    return;
  }
  if (out.reason === 'duplicate') {
    // BOTH NAMES, because the remedy is choosing between them and the app
    // cannot do that. Two downloads of the same export — Connections.csv and
    // Connections (1).csv — are one destination, and picking one on the
    // owner's behalf would be guessing at which is the real one.
    const [first, second] = out.files || [];
    linkedInStatus.textContent =
      `"${first}" and "${second}" are both ${out.file} — choose one.`;
    return;
  }
  linkedInStatus.textContent = "i couldn't read that file.";
}

// THE SECOND RUN (design P12). A machine that imported an export last month
// met this screen saying only "choose the file", with `next` disabled — the
// flow asking again for something it already had, and the only way past it
// being to hand over the same file twice. Counts and a date, read from the
// file the connector actually reads; the button then offers to replace it.
const linkedInPick = document.getElementById('linkedInPick');

function paintLinkedInExisting(out) {
  if (!out || out.present !== true) return;
  linkedInStatus.classList.remove('warn', 'bad');
  linkedInStatus.classList.add('ok');
  const n = Number(out.connections || 0);
  const when = Number(out.modifiedTs);
  const dated = Number.isFinite(when)
    ? ` · imported ${new Date(when).toLocaleDateString()}`
    : '';
  linkedInStatus.textContent = n > 0
    ? `${n.toLocaleString()} connections already here${dated}`
    : `an export is already here${dated}`;
  linkedInPick.textContent = 'replace';
  linkedInNext.hidden = false;
}

function enterLinkedIn() {
  hzPost('linkedInState').then(paintLinkedInExisting).catch(() => {});
}

// AN EXPORT THAT LANDED WHILE THIS SCREEN WAS UP. The owner presses "request a
// copy", goes to the browser, comes back — and the archive may arrive at any
// point after that, including while they are still looking at this screen (the
// Downloads watcher notices it and the notification imports it). Native pokes
// this; without it the screen would go on saying "waiting" about a file that is
// already installed. Guarded on `present`, like the entry read, so a poke that
// arrives for some other reason claims nothing.
window.__hzLinkedInChanged = () => {
  if (currentScreen !== '4') return;
  hzPost('linkedInState').then(paintLinkedInExisting).catch(() => {});
};

// ASKING IS NOT HAVING, and this button is the "asking" half.
//
// It opens LinkedIn's own data-download page in the owner's browser through a
// door that takes no URL from this page at all (Bridge `openLinkedInExport`),
// and native drops the scrim out of the browser's way exactly as the Google
// sign-in does — the panel is full-screen at .floating and a browser window is
// an ordinary one, so without that the page the owner was just sent to opens
// underneath a scrim that swallows every click on it.
//
// NOTHING IS WAITED FOR. There is no poll here and no gate: the file arrives by
// email in ten minutes or tomorrow, and the flow is not going to sit on this
// screen for either. The status line says what was opened and `later` still
// goes on.
//
// AND THIS SCREEN IS WHERE THE WATCHER IS ARMED, not the launch.
//
// The first read of ~/Downloads is what makes macOS ask the owner for that
// folder, and arming at launch put that dialog over screens 1 to 3 — before
// anything had mentioned an export, and while screen 2 is explaining a
// different grant with a different dialog. Both answers that mean "the file is
// still to come" arm it: this button and `later`. "i have it" does not, because
// that path ends with an export installed and there is then nothing to wait for.
const armExportWatch = () => { hzPost('watchForExport').catch(() => {}); };

const linkedInRequest = document.getElementById('linkedInRequest');
linkedInRequest.addEventListener('click', () => {
  armExportWatch();
  linkedInStatus.classList.remove('ok', 'warn', 'bad');
  linkedInStatus.textContent = 'opening linkedin in your browser…';
  hzPost('openLinkedInExport')
    .then((out) => {
      if (!out || out.opened !== true) {
        linkedInStatus.classList.add('bad');
        linkedInStatus.textContent = "i couldn't open linkedin — the page is "
          + 'linkedin.com → settings → data privacy → get a copy of your data.';
        return;
      }
      // A PROMISE THIS SCREEN CAN KEEP. The watcher is what makes it true: the
      // archive is noticed in ~/Downloads whenever it lands, and one press on
      // the notification imports it. See ExportWatch.
      linkedInStatus.textContent =
        "when it arrives, leave it in your downloads and i'll offer to take it.";
    })
    .catch(() => {
      linkedInStatus.classList.add('bad');
      linkedInStatus.textContent = "i couldn't open linkedin just now.";
    });
});

linkedInPick.addEventListener('click', () => {
  hzPost('importLinkedIn').then(paintLinkedIn).catch(() => {});
});
linkedInNext.addEventListener('click', () => nextScreen());
document.getElementById('linkedInSkip').addEventListener('click', () => {
  // "LATER" MEANS LATER, WHICH IS THE ANSWER THAT MOST NEEDS THE WATCHER. The
  // owner is going on without the file and is the least likely of anyone to
  // reopen this flow when it arrives; arming here is what makes the button
  // honest. `skipped` still records it, which is what screen 6 renders as "not
  // connected" — true at that moment, and the import corrects it.
  armExportWatch();
  skipped.add('linkedin');
  nextScreen();
});

// ---------------- 5: how it reads ----------------
const engineStatus = document.getElementById('engineStatus');
const engineToggleRow = document.getElementById('engineToggleRow');
const engineToggle = document.getElementById('engineToggle');
const engineAgain = document.getElementById('engineAgain');
const engineLocal = document.getElementById('engineLocal');
const engineCancel = document.getElementById('engineCancel');
const engineModel = document.getElementById('engineModel');
const engineBar = document.getElementById('engineBar');
const engineModelLabel = document.getElementById('engineModelLabel');

const fmtGB = (b) => `${(b / 1e9).toFixed(1)} GB`;

const ENGINE_COPY = {
  auth: 'claude is installed but not signed in. open it, sign in, then check again.',
  limit: 'claude is installed and signed in, but your plan is rate-limited right now.',
  upgrade: 'this claude is too old for the way i call it.',
  slow: 'claude did not answer. it may be busy — check again in a moment.',
  busy: 'still checking…',
  error: "claude is here but it did not answer the way i expected.",
};

function resetEngineChrome() {
  engineToggleRow.hidden = true;
  engineAgain.hidden = true;
  engineLocal.hidden = true;
  engineCancel.hidden = true;
  engineModel.hidden = true;
}

function paintEngine(out) {
  resetEngineChrome();
  const state = out && out.state;
  if (state === 'ok') {
    engineStatus.textContent = 'claude is here and answering.';
    engineToggleRow.hidden = false;
    // FROM THE CONFIG, NEVER FROM A CONSTANT. A replay on a machine where the
    // owner already opted in must not draw this off: that is a silent implied
    // opt-out nobody made, one tap from being written back as the real answer.
    setToggle(out.engine === 'claude-cli');
    return;
  }
  if (state === 'missing') {
    // No question is asked. The tier comes from this Mac's own hardware, and
    // there is no setup question whose answer the app cannot measure.
    startLocalModel();
    return;
  }
  engineStatus.textContent = ENGINE_COPY[state] || ENGINE_COPY.error;
  engineAgain.hidden = false;
  // A NON-OK PROBE NEVER WRITES THE ENGINE KEY. That is the whole difference
  // between "you have it" and "it works": writing it on a rate-limited probe
  // would mean every page build for the next few hours fails and the card
  // silently degrades.
  engineLocal.hidden = false;
}

function setToggle(on) {
  engineToggle.classList.toggle('on', on);
  engineToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// THE SAME SWITCH AS THE SETTINGS ROW, and it needs the same check. hzPost does
// not reject for a handled verb — Bridge.reply always sends ok:true — and
// setEngine goes through relHermes, which RESOLVES with {state:'down'} when
// hermes is restarting and {state:'auth'} when there is no bearer yet. The
// catch this replaces therefore never ran: on a first launch, where hermes is
// most likely to still be warming up, the switch stayed where it was pressed
// and the config was untouched. On this screen that is a false privacy claim,
// which is the one thing it cannot afford.
engineToggle.addEventListener('click', async () => {
  const on = !engineToggle.classList.contains('on');
  setToggle(on);
  const out = await hzPost('setEngine', { engine: on ? 'claude-cli' : 'local' }).catch(() => null);
  if (out?.state === 'ok' && out?.ok !== false) return;
  setToggle(!on);
  engineStatus.textContent = 'that did not save — i may still be starting up. nothing changed.';
});

function startLocalModel() {
  engineModel.hidden = false;
  engineCancel.hidden = false;
  engineBar.style.width = '0%';
  engineStatus.textContent = 'no claude here, so i will read with a local model.';
  engineModelLabel.textContent = 'fetching…';
  hzPost('modelDownload', {}).catch(() => {});
}

engineAgain.addEventListener('click', () => {
  engineStatus.textContent = 'checking…';
  hzPost('engineProbe').then(paintEngine).catch(() => {});
});
engineLocal.addEventListener('click', () => startLocalModel());
engineCancel.addEventListener('click', () => {
  engineCancel.disabled = true;
  engineCancel.textContent = 'stopping…';
  hzPost('modelCancel').catch(() => {});
});
document.getElementById('engineNext').addEventListener('click', () => nextScreen());

// THE PROBE IS SKIPPED WHILE A DOWNLOAD IS ALREADY RUNNING.
//
// Escape does not mark the flow done, so backing out on this screen and
// relaunching resumes here — and a second modelDownload answers "a download is
// already running", which this page would render as a failure with that string
// as the error. setupState first, and the in-flight progress is what gets
// drawn.
function enterEngine() {
  resetEngineChrome();
  engineStatus.textContent = 'checking whether you already have claude on this Mac…';
  hzPost('setupState').then((st) => {
    if (st && st.downloading) {
      engineModel.hidden = false;
      engineCancel.hidden = false;
      engineStatus.textContent = 'still fetching the local model.';
      return;
    }
    return hzPost('engineProbe').then(paintEngine);
  }).catch(() => paintEngine({ state: 'error' }));
}

// Native pushes every model state change through here — progress, the install
// step after the bytes land, and both endings.
window.__hzSetup = (d) => {
  if (!d || typeof d !== 'object') return;
  if (d.phase === 'downloading') {
    const pct = d.total > 0 ? Math.min(100, (d.got / d.total) * 100) : 0;
    engineBar.style.width = `${pct}%`;
    engineModelLabel.textContent =
      `${fmtGB(d.got)} of ${fmtGB(d.total)} — it will make the fan run while it is answering.`;
    return;
  }
  if (d.phase === 'installing') {
    engineBar.style.width = '100%';
    engineModelLabel.textContent = 'making sure it arrived intact…';
    return;
  }
  if (d.phase === 'ready') {
    engineBar.style.width = '100%';
    engineModelLabel.textContent = 'ready';
    engineCancel.hidden = true;
    return;
  }
  if (d.phase === 'failed') {
    // TERMINAL FOR THE SCREEN, NOT FOR THE FLOW. A model that will not install
    // leaves the card serving from counts and quotes, which is the floor this
    // product is built on — so this says so and lets the owner go on rather
    // than parking them in front of a retry.
    engineCancel.hidden = true;
    if (d.error !== 'cancelled') {
      engineModelLabel.textContent = `${d.error || 'that did not work'} — the card still works without it.`;
    } else {
      engineModel.hidden = true;
      engineModelLabel.textContent = '';
    }
  }
};

// ---------------- 6: first load ----------------
const loadBody = document.getElementById('loadBody');
const loadBanner = document.getElementById('loadBanner');
const loadStatus = document.getElementById('loadStatus');
const loadStart = document.getElementById('loadStart');
const loadFinish = document.getElementById('loadFinish');

// THE ONE LINE THE TABLE DOES NOT GET A ROW FOR. Rows kept from sources this
// install does not read people from — a photo library, a bridge switched off in
// ops/features.json. The route collapses them to a total on purpose (see
// `dormant` in /admin/onboarding/progress), so this is a sentence rather than
// seven grey rows the owner would read as seven things to fix. Built here
// rather than in onboarding.html because it is the route's shape that decides
// whether it says anything at all.
const loadDormant = document.createElement('p');
loadDormant.className = 'ob-status';
loadDormant.id = 'loadDormant';
loadDormant.hidden = true;
loadStatus.before(loadDormant);

// THE POOL IS NOT EMPTY, THE MODE IS -- and those are different sentences.
//
// Live on run three: twenty minutes in, the eligible pool held six people and
// none of them was an investor. "nobody qualifies yet, i need more history" is
// then false twice over: there IS history, and there ARE people. What there is
// not is anybody in the group the owner picked on screen 1.
//
// Built here rather than in onboarding.html for the same reason loadDormant is:
// it is the ROUTE's answer that decides whether this says anything at all, and
// a row that is hidden on every ordinary install belongs next to the code that
// decides to show it.
//
// Its own line, under the status rather than replacing it, because the sprint
// sentence above is still true while this is: the reader is filling last year,
// and the mode is empty, and the owner may want to act on the second without
// being told the first has stopped.
const loadMode = document.createElement('p');
loadMode.className = 'ob-status';
loadMode.id = 'loadMode';
loadMode.hidden = true;
loadStatus.after(loadMode);

// AND AN OFFER, NEVER A SWITCH -- WHICH MEANS THIS ONE CARD, NOT THIS SETTING.
//
// ~~"start with anyone", posting relMode.~~ That wrote the mode to the config
// durably: the comment said the screen does not get to change the owner's choice
// and the handler changed it, with nothing on this screen to say so and no way
// back from it here. A button that reads as widening one card must widen one
// card. The peek takes a one-off mode (hermes' askedMode) which wins for that
// request and leaves relationshipMemory.mode alone; the card panel's own chips
// stay the way the standing choice is made.
const loadAnyMode = document.createElement('button');
loadAnyMode.className = 'ob-ghost';
loadAnyMode.id = 'loadAnyMode';
loadAnyMode.type = 'button';
loadAnyMode.hidden = true;
loadAnyMode.textContent = 'show me anyone, just this once';
loadStart.before(loadAnyMode);

const hideModeShortfall = () => {
  loadMode.hidden = true;
  loadAnyMode.hidden = true;
};

/// "an investor", "a founder". The route names the mode; the sentence has to
/// read like one a person wrote.
const article = (word) => (/^[aeiou]/iu.test(word) ? 'an' : 'a');

// WHICH YEAR, BECAUSE IT IS NOT ALWAYS LAST YEAR.
//
// The phase used to stop the moment last year landed, so "reading last year" was
// true for the whole of it. It runs its window out now -- the card wants somebody
// QUIET, and on a real install the first one only appeared once the walk was
// several years down -- so naming last year would be right for a minute and stale
// after that. An older daemon that does not publish the year gets the sentence
// without one, which is vague rather than wrong.
function sprintSentence() {
  const currentYear = new Date().getFullYear();
  if (readerSprintYear === null) return 'reading back through your history so i can tell who has gone quiet';
  const named = readerSprintYear === currentYear - 1 ? 'last year' : String(readerSprintYear);
  return `reading ${named} so i can tell who has gone quiet`;
}

// THE GROUP IS EMPTY FOR A REASON THE OWNER CAN FIX, AND IT IS NOT "more
// history".
//
// founder and investor are decided from the LinkedIn export's job titles, so on
// a Mac with no export there are no rows to be a founder or an investor IN —
// hermes says so with `modeFallback: 'linkedin-pending'` rather than letting
// the screen blame the reader. "nobody quiet who is an investor yet" is true and
// sends the owner off to wait for a corpus that will never produce one.
//
// Same sentence here and on the card (reconnect.js), because it is the same
// fact: two wordings for one cause is two explanations, and the owner only gets
// to believe one. It is BUILT in bridge.js rather than spelled out on either
// page, so the two cannot drift -- and it has two forms now, because a hold
// that never ends is a promise this screen should stop making. See
// hzModeHoldLine.
//
// IT DOES NOT ARRIVE ON THE REASON YOU WOULD EXPECT. The flag rides
// `pool-exhausted`, not `pool-exhausted-mode` — hermes suppresses the latter
// while the pick is held, because under the fallback the serve mode is already
// `any` and there is nothing left to widen to. Written down here because the
// first version of this branch lived in the `pool-exhausted-mode` path and was
// therefore unreachable: the sentence existed, the tests passed, and nothing
// could ever have painted it. See peekCard.
const linkedInPending = (out) =>
  out?.modeFallback === 'linkedin-pending'
  && typeof out?.mode === 'string' && out.mode.length > 0
  && out.mode !== 'any';

function paintModeShortfall(out) {
  if (linkedInPending(out)) {
    loadMode.textContent = hzModeHoldLine(out.mode, out.heldSince);
    loadMode.hidden = false;
    // AND NO OFFER TO WIDEN, because the widening has already happened. Under
    // the fallback hermes is serving from `any` already, so "show me anyone,
    // just this once" asks the owner to choose what they are being given —
    // and a one-off peek names a mode, which suppresses the fallback and comes
    // back with the identical empty answer. A button that cannot change the
    // screen it is on is worse than no button.
    loadAnyMode.hidden = true;
    return;
  }
  const mode = typeof out.mode === 'string' && out.mode.length > 0 ? out.mode : null;
  const inAll = Number(out.counts?.any) > 0
    ? ` — ${Number(out.counts.any).toLocaleString()} `
      + `${Number(out.counts.any) === 1 ? 'person' : 'people'} in all`
    : '';
  loadMode.textContent = mode === null
    ? `nobody quiet in that group yet${inAll}`
    : `nobody quiet who is ${article(mode)} ${mode} yet${inAll}`;
  loadMode.hidden = false;
  loadAnyMode.hidden = false;
}

loadAnyMode.addEventListener('click', () => {
  loadAnyMode.disabled = true;
  // NOT HIDDEN ON THE PRESS. A widened peek that lands on the refill throttle
  // comes back a plain `pool-exhausted` with no counts -- modeEmptyCounts answers
  // nothing for 'any' -- so nothing repaints the row, the button vanishes, and
  // the sentence reverts to the sprint line until the next ordinary poll fifteen
  // seconds later. It is self-healing and it reads as the press having failed.
  // The row goes when an ANSWER says it should, which is peekCard's job.
  // ONE REQUEST, ONE MODE. No relMode, no config write: the peek carries the
  // widening and the owner's standing pick is still whatever they chose on
  // screen 1. Stamped so the timer does not immediately spend a second peek on
  // top of this one -- the throttle is on the RATE, and the owner's own press is
  // not charged to it.
  lastPeekAt = Date.now();
  hzPost('relCardPeek', { mode: 'any' })
    .then((out) => {
      loadAnyMode.disabled = false;
      peekCard(out, { fromOneOff: true });
    })
    .catch(() => { loadAnyMode.disabled = false; });
});

const SOURCE_NAMES = {
  imessage: 'messages', mail: 'mail', calendar: 'calendar',
  contacts: 'contacts', linkedin: 'linkedin',
};

// What the people column MEANS for this source, because it is not the same
// question everywhere. A LinkedIn export has no authors at all, an address
// book's rows are names rather than correspondents, and a calendar's people are
// the ones who were in the room — nobody authors an invitation.
const PEOPLE_SUFFIX = {
  listed: 'in your export', names: 'in your address book', met: 'you met',
  // The ordinary case, and it used to live in the column header ("people who
  // wrote to you"). The header is one word now, so the qualifier carries it —
  // and every row says which kind of people it is counting rather than three
  // of the four rows correcting a heading.
  authors: 'who wrote to you',
};

const STATUS_COPY = {
  reading: 'reading',
  ok: 'reading',
  empty: 'connected, nobody found yet',
  idle: 'waiting',
  // CONNECTED, AND NOBODY HAS LOOKED YET -- which is not the same sentence as
  // `empty`, and must not wear its amber. This is the row for the thirty
  // seconds after the owner signs in to Google or drops their export in:
  // the route can see the token file or the CSV, and the reader has not
  // reached the source even once. "connected, nobody found yet" there would
  // report a verdict on a search that has not happened.
  waiting: 'reading soon',
  failing: 'not reading',
  skipped: 'not connected',
};

// No wall-clock timer: every word here comes from the route, which derives it
// from the projection's own revisions. See /admin/onboarding/progress.
function statusCell(row) {
  const cell = document.createElement('td');
  if (skipped.has(row.source)) {
    cell.className = 'ob-st grey';
    cell.textContent = STATUS_COPY.skipped;
    return cell;
  }
  const cls = { ok: 'green', empty: 'amber', failing: 'red' }[row.status] || 'grey';
  cell.className = `ob-st ${cls}`;
  cell.textContent = row.status === 'ok'
    ? `${row.people.toLocaleString()} found`
    : STATUS_COPY[row.status] || 'reading';
  // ~~`not reading (ERR_SQLITE_ERROR: ...)`~~ THE RAW ERROR IS NOT FOR THIS
  // SCREEN. Every other line in this flow is hand-written, and an internal
  // error string in the middle of them reads as the app breaking in front of
  // the owner. It is not thrown away — it goes in the cell's tooltip, which is
  // where somebody debugging will look and nobody else will.
  if (row.status === 'failing' && row.lastError) {
    cell.textContent = `${STATUS_COPY.failing} — i will keep trying`;
    cell.title = String(row.lastError);
  }
  return cell;
}

// IS THE READER STILL WALKING LAST YEAR? Held between the two polls that draw
// screen 6, because the table's poll is the one told and the card peek's is the
// one with a sentence to write. See peekCard.
let readerSprinting = false;
// Which year the reader is on, when it said. See sprintSentence.
let readerSprintYear = null;

function paintLoad(out) {
  // CLEARED BY AN ANSWER, not by the absence of one.
  //
  // ~~Set false before the early return.~~ That fixed a stale sentence outliving
  // the phase and bought a flicker instead: ONE failed poll mid-sprint dropped
  // the flag, and the next card peek fell through to "nobody qualifies yet -- i
  // need more history", which is the sentence the sprint branch exists to
  // suppress and is false while the reader is mid-pass. A poll that did not
  // arrive says nothing about the sprint; only one that did may end it.
  if (!out || out.state !== 'ok') return;
  readerSprinting = out.sprint !== null && typeof out.sprint === 'object';
  readerSprintYear = readerSprinting && Number.isInteger(out.sprint.year)
    ? out.sprint.year
    : null;
  const runs = out.runs || {};
  const rows = (out.sources || []).filter((row) => {
    // A Mac with no chat.db has nothing to read and never will; a row at zero
    // there is correct and indistinguishable from a failure.
    if (row.source === 'imessage' && noMessagesOnThisMac) return false;
    return true;
  });
  loadBody.replaceChildren(...rows.map((row) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = SOURCE_NAMES[row.source] || row.source;
    const count = document.createElement('td');
    count.textContent = Number(row.rows || 0).toLocaleString();
    const people = document.createElement('td');
    people.textContent = Number(row.people || 0).toLocaleString();
    const suffix = PEOPLE_SUFFIX[row.peopleKind];
    if (suffix) {
      const qualifier = document.createElement('span');
      qualifier.className = 'ob-qualifier';
      qualifier.textContent = ` ${suffix}`;
      people.appendChild(qualifier);
    }
    tr.append(name, count, people, statusCell({ ...row, lastError: runs[row.source]?.lastError }));
    return tr;
  }));

  // THERE IS AN EXIT AS SOON AS THERE IS ANYTHING TO LEAVE.
  //
  // "finish anyway" used to appear only after ten minutes on this screen, or on
  // `no-cap-configured`. Every other unrecognised reason lands on "no card yet"
  // — the state in the run-5 screenshot — and the owner's only way out was an
  // undocumented Escape. A table with rows in it means the reading has started
  // and this screen is now a thing to watch rather than a gate to pass, so the
  // button is offered. The ten-minute timer below still covers a table that
  // never fills.
  if (rows.length > 0) loadFinish.hidden = false;

  // BELOW THE TABLE, AND ONLY WHEN THERE IS SOMETHING TO SAY. Silent at zero:
  // a fresh install has no legacy rows, and a sentence about none of them is
  // one more thing to read on the screen that is already asking for patience.
  const dormantRows = Number(out.dormant?.rows || 0);
  loadDormant.hidden = dormantRows === 0;
  if (dormantRows > 0) {
    // NOT "switched-off sources". `dormant` collects every source that fails
    // EITHER gate -- the ones a bridge flag turned off AND the ones that were
    // never going to mint a person at all (photos, notes, files, web, seed,
    // hazlie_digest). Nothing switched photos off; calling it switched off
    // sends the owner looking for a switch that does not exist.
    // "rows" is a database word, like the column header this used to sit under.
    loadDormant.textContent =
      `${dormantRows.toLocaleString()} more are kept from places i do not look for people in`;
  }

  // ABOVE THE TABLE, NOT IN IT. The daemon holding a stale lock, or exiting on
  // a config error, makes every source read zero — and per-source amber would
  // then blame five sources for one process that is not running.
  // KEYED OFF THE RUN LOG, AND NOTHING ELSE. This used to fall back to
  // `!noMessagesOnThisMac` when there was no run history at all — so whether
  // the Mac happens to have an iMessage database decided whether the owner was
  // told the reader is not running. A Mac with no Messages history and no run
  // history got neither the banner nor the button to start it, which is
  // exactly the machine most likely to need both; and `noMessagesOnThisMac` is
  // only ever set if screen 2 was painted, so a resume straight into this
  // screen left it false and got the banner by accident rather than by fact.
  // No run history means nothing has run. That is the whole question.
  const last = out.daemonLastRunTs;
  const stopped = last === null || (Date.now() - last) > 10 * 60 * 1000;
  loadBanner.hidden = !stopped;
  if (stopped) loadBanner.textContent = 'nothing is running. let me start it.';
  loadStart.hidden = !stopped;

  // AND WHEN PRESSING THE BUTTON CANNOT WORK, SAY SO INSTEAD.
  //
  // The reader refuses a ~/.hazlie it cannot trust and says so only in its own
  // log, so a directory this app could not make owner-only -- symlinked to a
  // wider target, not a directory at all, or owned by root from a sudo setup
  // run -- is four dead starts and a screen that waits forever. The native side
  // knows which paths it could not fix; this is the only place the owner is
  // looking while it happens.
  const blockers = out.treePermsBlockers;
  if (Array.isArray(blockers) && blockers.length > 0) {
    loadBanner.hidden = false;
    loadBanner.textContent =
      'i cannot start reading until these are yours alone — run chmod 700 on '
      + blockers.join(' ');
    // The button restarts the reader, and the reader will refuse again.
    loadStart.hidden = true;
  }

  const projection = out.projection;
  if (projection && projection.lastRebuildError) {
    loadStatus.classList.add('bad');
    // Same rule as statusCell above: the sentence is written, the raw text is
    // carried in the tooltip rather than put in front of a new owner.
    loadStatus.textContent = 'something went wrong putting that together. it will try again.';
    loadStatus.title = String(projection.lastRebuildError);
  }
}

loadStart.addEventListener('click', () => {
  startedSources();
  loadBanner.textContent = 'starting…';
});

let loadTimer = null;
let loadPeekTimer = null;
// The wait-out-the-remainder timer, and when the last peek actually went. Both
// belong to the PAGE, not to one arming of the poll: the whole point is that
// arming it again does not reset the throttle. See startLoadPolling.
let loadPeekDelay = null;
let lastPeekAt = 0;
let loadSince = 0;

// The table is cheap and local, so it can be quick. The card peek is NOT: a
// peek runs produceBatch/produceOweBatch, applies the cap and the servability
// gate and writes the producers' refill bookkeeping, and the route's own
// comment describes the widget poll it was designed against as TEN MINUTES.
// Three seconds was two hundred times that rate.
const LOAD_POLL_MS = 5000;
const PEEK_POLL_MS = 15000;

function stopLoadPolling() {
  if (loadTimer) clearInterval(loadTimer);
  if (loadPeekTimer) clearInterval(loadPeekTimer);
  if (loadPeekDelay) clearTimeout(loadPeekDelay);
  loadTimer = null;
  loadPeekTimer = null;
  loadPeekDelay = null;
}

// THE FLOW ALWAYS HAS AN EXIT. relCardPeek can legitimately answer null
// forever — a config with no capPerDay returns {card:null,
// reason:'no-cap-configured'} immediately and permanently — and a screen that
// waits for a card would then spin for the life of the install.
// Split out of enterLoad so coming back to a panel that was ordered out
// resumes the polls without resetting the ten-minute clock the owner has
// already been waiting on.
// `peekNow` is false on the re-show path. A peek is not a read: it runs
// produceBatch/produceOweBatch, applies the cap and the servability gate and
// writes the producers' refill bookkeeping. Firing one on every hide/show
// cycle spends exactly what PEEK_POLL_MS was introduced to stop spending, and
// a panel that is occluded and revealed repeatedly would then cost more than
// the 3s poll this replaced. The TABLE still repaints immediately, because
// that is the part the owner is looking at and it is local and cheap.
//
// BUT NOT PEEKING IS NOT THE SAME AS NEVER PEEKING, and the first version of
// this could not tell the difference. `peekNow: false` dropped the leading
// peek AND started a fresh interval from zero, so a panel ordered out and
// revealed more often than PEEK_POLL_MS reached the fifteen-second mark
// exactly never: screen 6's reconnect card never populated, which is the one
// thing the whole flow is walking towards. The throttle is a rate, so it is
// kept as a TIME — `lastPeekAt`, which outlives any one arming. A peek that is
// already due fires now; one that is not waits out its remainder and then
// falls into the interval, so re-arming can delay a peek and can never cancel
// one.
function startLoadPolling({ peekNow = true } = {}) {
  stopLoadPolling();
  const tick = () => {
    if (currentScreen !== '6') { stopLoadPolling(); return; }
    hzPost('onboardingProgress').then(paintLoad).catch(() => {});
    if (Date.now() - loadSince > 10 * 60 * 1000) loadFinish.hidden = false;
  };
  const peek = () => {
    if (currentScreen !== '6') { stopLoadPolling(); return false; }
    // Stamped when it is SPENT, not when it answers: the throttle is on the
    // asking, and the answer can take as long as the producers take.
    lastPeekAt = Date.now();
    hzPost('relCardPeek').then(peekCard).catch(() => {});
    return true;
  };
  const armPeeks = () => { loadPeekTimer = setInterval(peek, PEEK_POLL_MS); };
  tick();
  loadTimer = setInterval(tick, LOAD_POLL_MS);
  const since = Date.now() - lastPeekAt;
  if (peekNow || since >= PEEK_POLL_MS) {
    if (peek()) armPeeks();
  } else {
    loadPeekDelay = setTimeout(() => {
      loadPeekDelay = null;
      if (peek()) armPeeks();
    }, PEEK_POLL_MS - since);
  }
}

function enterLoad() {
  loadSince = Date.now();
  loadFinish.hidden = true;
  // The screen that waits for rows makes sure something is producing them.
  // Same idempotent call as screen 2's next; a resume straight into this
  // screen otherwise depends on a permission having changed on some earlier
  // visit.
  startedSources();
  startLoadPolling();
}

// THE CARD THE OWNER ASKED FOR IS NOT THE CARD THE PANEL WOULD FETCH.
//
// "show me anyone, just this once" peeks under a one-off mode; the flow then
// finishes and the panel opens and pulls under the STANDING mode, which is the
// one with nobody in it. Live on run five: the owner pressed the button, the
// flow completed, and the panel said "nothing to review" with the investor chip
// lit. The widening has to travel with the hand-off or it is not a hand-off.
let finishedOnOneOff = null;

function peekCard(out, { fromOneOff = false } = {}) {
  if (!out) return;
  // Cleared on every answer: this row belongs to one reason, and leaving it up
  // under a different one would offer a remedy for a problem that has moved on.
  //
  // EXCEPT the answer to the press itself. A widened peek that hits the refill
  // throttle answers `pool-exhausted` with no counts, and clearing the row there
  // takes away the button that produced it for a reason that has not changed:
  // the owner's mode is still empty, and they may well want to press again.
  if (!(fromOneOff && out.reason === 'pool-exhausted')) hideModeShortfall();
  if (out.card) {
    // The mode this card was produced under, when it was not the owner's own.
    // `mode` on a one-off reply is still the standing pick, so servedMode is
    // what the panel has to ask for to see this card.
    finishedOnOneOff = out.oneOff === true && typeof out.servedMode === 'string'
      ? out.servedMode
      : null;
    // A real card is waiting. The table has done its job; hand over to the
    // panel that actually serves, which is where this whole flow was going.
    stopLoadPolling();
    document.getElementById('loadTable').hidden = true;
    loadDormant.hidden = true;
    loadStatus.textContent = 'here is your first one.';
    finish();
    return;
  }
  if (out.reason === 'no-cap-configured') {
    // ~~"the daily card is switched off in your config."~~ named a file the
    // owner cannot open and offered no way out of the sentence. The fact is
    // the same and the remedy is the button below it.
    loadStatus.textContent = 'one card a day is switched off, so there is nothing to show yet.';
    loadFinish.hidden = false;
    return;
  }
  // THE REASON IS A WIRE WORD, NOT A SENTENCE FOR A PERSON. `pool-exhausted`
  // reached the owner verbatim on the clean-machine run, on the screen whose
  // entire job is to say how it is going. It means the producer found nobody
  // who qualifies YET -- an install with too little history behind it, which is
  // the ordinary state of the machine this screen is drawn on -- so it says
  // that, and says when it will look again if the route told us.
  if (out.reason === 'pool-exhausted') {
    // The press was answered by a throttle, not by an empty house. Say so and
    // leave the row where it was.
    if (fromOneOff) {
      loadStatus.textContent = readerSprinting
        ? sprintSentence()
        : 'still looking — try that again in a moment';
      return;
    }
    // THE PICK IS BEING HELD, AND NO AMOUNT OF READING WILL RELEASE IT.
    //
    // This is where the flag actually lands. hermes suppresses
    // `pool-exhausted-mode` while the pick is held — the serve mode is already
    // `any`, so there is nothing to widen to and no counts to report — which
    // means a fallback empty answer arrives as a plain `pool-exhausted` with
    // `modeFallback` on it. Its own line, under whatever the status says next,
    // because both facts are true at once: the house is empty AND the owner's
    // group is waiting on a file. The sentence about the file is the one they
    // can act on.
    if (linkedInPending(out)) paintModeShortfall(out);
    // AND WHEN THE READER IS ALREADY DOING SOMETHING ABOUT IT, SAY THAT INSTEAD.
    //
    // "i need more history" is true and useless on a fresh Mac: the card wants
    // somebody whose last activity is at least 180 days old, the forward window
    // only reaches about 157 days back, and nobody can qualify until last year
    // lands. The reader walks last year hard for the first half hour for exactly
    // this reason (connectors/daemon.mjs, SPRINT_MAX_MS), and while it is doing
    // that the honest sentence names the work rather than the shortfall.
    if (readerSprinting) {
      loadStatus.textContent = sprintSentence();
      return;
    }
    const minutes = Number(out.retryAfterMs) > 0
      ? Math.max(1, Math.round(Number(out.retryAfterMs) / 60000))
      : null;
    loadStatus.textContent =
      'nobody qualifies yet — i need more history before i can pick someone'
      + (minutes === null ? '' : `, checking again in ${minutes} min`);
    return;
  }
  // THE MODE IS EMPTY, NOT THE POOL. See paintModeShortfall: there is history and
  // there are people, and none of them is in the group the owner picked. The
  // sprint sentence keeps the line above, because both are true at once.
  if (out.reason === 'pool-exhausted-mode') {
    loadStatus.textContent = readerSprinting ? sprintSentence() : '';
    paintModeShortfall(out);
    return;
  }
  // Every other reason is one the owner cannot act on and would not recognise.
  if (out.reason) loadStatus.textContent = 'no card yet';
}

loadFinish.addEventListener('click', () => finish());

// ---------------- flow ----------------
function finish() {
  // Every poll stops before the window does. See leaveFlow().
  leaveFlow();
  // Put the widget back under the windows before anything else. Native does
  // this too when the panel closes, because a desktop widget left floating
  // above everything would be the worst bug this app could ship — but asking
  // first means it happens while the scene is still up rather than after.
  hzPost('spotlightWidget', { on: false }).catch(() => {});
  // Mark it done BEFORE closing: if the window goes first the page can be
  // torn down mid-message and the flow reappears on the next launch.
  hzPost('onboardingDone')
    .catch(() => {})
    // Close the full-screen scrim first, then open the reconnect panel it was
    // leading toward. ~~People.~~ The flow now ends on the card, which is the
    // thing it spent six screens getting ready to show. The onboarding webview
    // survives orderOut, so this second message remains deliverable after
    // close resolves.
    .then(() => hzPost('close'))
    // WITH THE WIDENING, when there was one. Native holds it for exactly one
    // fetch (Bridge.pendingOneOffMode), so the panel opens on the card the owner
    // asked for and everything after that is their standing pick again.
    .then(() => hzPost('openReconnect', finishedOnOneOff === null
      ? {}
      : { oneOffMode: finishedOnOneOff }))
    .catch(() => {});
}

// Escape leaves but does NOT mark it done — dismissing is not finishing, and a
// flow you backed out of should still be there next time.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === 'Return') && currentScreen === 'demo' && demoArmed) {
    e.preventDefault();
    demoSendNow();
    return;
  }
  if (e.key === 'Escape') {
    clearDemo();
    // A press held by the entry gate is cancelled with the flow. It survives
    // the close otherwise — the page does — and fires showScreen() behind a
    // panel nobody can see, which the next open then has to undo.
    pendingAdvance = false;
    setCtaHeld(false);
    // Dismissing is not finishing, but it IS leaving: the page survives the
    // close, so a poll not stopped here runs behind a window nobody can see.
    leaveFlow();
    hzSfx.close();
    hzPost('spotlightWidget', { on: false }).catch(() => {});
    hzPost('close');
  }
});

hzApplyPrefs();

// ==================== behind the `chat` flag ==========================
//
// The typing demo and the widget spotlight. They are reached only when
// ops/features.json has `chat` on, which puts them into `flow` (see
// hzFeatures() above) — the demo between 1 and 2, the spotlight between 5 and
// 6. Neither replaces a check screen, and with the flag off neither is ever
// shown. Kept rather than deleted because the flag exists to be turned back
// on, and because the bubble's flight and the spotlight's ring are the two
// pieces of this flow nobody would rebuild from a description.

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
  screens.demo.classList.remove('clear-out', 'bar-out');

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
  at(140, () => screens.demo.classList.add('bar-out'));
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
    screens.demo.classList.add('clear-out');
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
  // The demo hands back into the setup sequence at whatever comes next --
  // screen 2, the permissions -- rather than at a hardcoded screen number.
  at(1960, () => nextScreen());
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
  if (!screens.home.hidden) runHome();
});
// ...and native calls this after it re-stretches the scrim for a screen change.
// `resize` alone is not enough: the widget itself moves to the new corner in the
// same beat, so the measurements have to be taken again even when this window's
// own size happens to come out unchanged.
window.__hzRehome = () => {
  if (!screens.home.hidden) runHome();
};
// ~~finish()~~. With `chat` on the spotlight sits between screen 5 and screen
// 6, so this hands on to the first-load table rather than ending the flow: the
// flow ends on the card, wherever the optional scenes are placed.
document.getElementById('homeDone').addEventListener('click', () => nextScreen());

// LAST LINE ON PURPOSE. showScreen() can enter any screen, and the optional
// scenes below declare state it touches; starting the flow from the middle of
// the file would read that state inside its temporal dead zone.
showScreen('1');
