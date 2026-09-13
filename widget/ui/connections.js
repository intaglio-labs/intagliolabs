'use strict';
const grid = document.getElementById('grid');
const hintHost = document.getElementById('hintHost');

// One anchored hint pop-over floats over the connector that owns it. The
// native window stays at its normal Settings width; this observer catches
// every open/close and async repaint because they all mutate hintHost.
// CLOSING THE LOGIN WINDOW RETURNS YOU TO THE SHELF.
//
// `cancelled` is what the native side replies when the window is shut without a
// session (Bridge.swift, cookiesJSON == nil). Re-rendering the card there put the
// owner back exactly where they had just chosen to leave -- a "data stored
// locally / log in" panel over the shelf, reading as the app insisting. The tile
// is still there and still opens it again.
//
// A helper rather than the check written out at each call site: there are FIVE,
// and fixing one of them is precisely the bug this replaces -- the tile-press
// path kept showing the card while the in-card button no longer did.
//
// Only cancelled. A login that FAILED has something to say and the card is the
// only place that can say it.
const afterLoginAttempt = (data, show) => {
  if (data && data.state === 'cancelled') { closeHint(); return; }
  show(data);
};

// A cookie window is only the first half of X's login. The bridge can answer
// the cookie handoff before it posts its encrypted-DM passcode question, so the
// old UI painted a fresh "log in" card from that in-between response. Keep the
// card in a finishing state and re-read the local bridge until the next bot
// step lands. The same safeguard benefits any future cookie bridge with a
// second, non-browser step.
const bridgeSignature = (data) => ((data && data.transcript) || [])
  .map((m) => `${m.from || ''}|${m.body || ''}|${m.image ? 'image' : ''}`).join('\u0000');
// The transcript includes completed historical prompts. The shared helper
// deliberately follows only the CURRENT bot state (plus validation retries),
// so an old X Chat passcode question cannot consume the first fresh login tap.
const bridgeNeedsReply = (data) => !!hzPendingBridgeQuestion(data);
const settleWebLogin = (platform, first, show, settled) => {
  const finish = (data) => {
    settled(data);
    afterLoginAttempt(data, show);
  };
  if (!first || first.state === 'cancelled' || first.connected || first.state !== 'ok' || bridgeNeedsReply(first)) {
    finish(first);
    return;
  }
  // Do not make a successfully closed login window look like it forgot the
  // click while the bridge commits the new session. The tile keeps its waiting
  // ring until this poll reaches a real result; opening a card here would move
  // the wait away from the exact control whose state is changing.
  const before = bridgeSignature(first);
  let tries = 0;
  const poll = () => {
    hzPost('bridgeStatus', { p: platform })
      .then((next) => {
        if (!next || next.state !== 'ok' || next.connected || bridgeNeedsReply(next)
            || bridgeSignature(next) !== before || ++tries >= 12) {
          finish(next || first);
          return;
        }
        setTimeout(poll, 1500);
      })
      .catch(() => {
        if (++tries >= 12) finish(first);
        else setTimeout(poll, 1500);
      });
  };
  setTimeout(poll, 1200);
};

// Put the open card back on its tile. Returns false when there is no tile to
// put it on, which is the caller's cue to stop.
//
// THE ANCHOR IS RESOLVED, NOT ASSUMED. Every appender is supposed to mark its
// row .open first, but an async painter can land after a close or a rebuild has
// unmarked the world — and hzPlacePop's null-anchor guard then silently skips
// placement, which shows the card wherever its stale styles left it. Fall back
// to the live row that owns the card (both carry dataset.id for exactly this
// kind of reunion), and if no live row owns it, close the host: an unplaceable
// pop-over must not render.
//
// EXTRACTED so that scrolling can call it too. #grid is a ONE-LINE HORIZONTAL
// SCROLLER (.list is display:flex with overflow-x:auto and overflow-y:hidden),
// so most of the connector tiles are off screen at any moment, and pressing one
// runs row.scrollIntoView({inline:'nearest', behavior:'smooth'}). The card was
// placed once against the tile's rect and never again, so the smooth scroll then
// slid the tile out from under its own card: the owner pressed Instagram, the
// login succeeded, and the card ended up floating over the activity panel with
// no tile beneath it ("the tab moved way to the right", 2026-08-29). The card
// has to track its anchor for as long as the anchor can move.
//
// closeIfUnplaceable is a real difference between callers, not a knob. The
// mutation observer has just been handed a card, so a card with no tile is an
// error it must clear. The window fitter and the scroll listener run constantly
// against whatever the DOM happens to be mid-rebuild, and a transient miss there
// is not a reason to throw the owner's open card away.
const placeOpenHint = ({ closeIfUnplaceable = false } = {}) => {
  let anchor = document.querySelector('#grid .row.open');
  if (!anchor) {
    const cardEl = hintHost.querySelector('.hint');
    const id = cardEl ? cardEl.dataset.id : null;
    anchor = id
      ? [...document.querySelectorAll('#grid .row')].find((r) => r.dataset.id === id) || null
      : null;
    if (anchor) anchor.classList.add('open'); // so the next tap closes, never relaunches
  }
  if (!anchor) {
    if (closeIfUnplaceable) hintHost.replaceChildren();
    return false;
  }
  hzPlacePop(hintHost, anchor);
  return true;
};

const closeHint = () => {
  hintHost.replaceChildren();
  for (const r of document.querySelectorAll('#grid .row')) r.classList.remove('open');
};
new MutationObserver(() => {
  const open = [...hintHost.children].some((el) => !el.classList.contains('hint-x'));
  // Structural :not(:empty) animation restarted on every replaceChildren(),
  // so switching connector details looked like the whole UI reloaded. Keep a
  // stable state class instead: it animates only closed -> open, not content ->
  // different content while the pop-over remains open.
  hintHost.classList.toggle('open', open);
  // A card opening under the cursor leaves a label already on screen with
  // nothing to hide it: mouseleave never fires because the pointer has not
  // moved. Same reason as the focus case above.
  if (open) hideTileTip();
  if (open) {
    // A POP-OVER, not a side strip (owner, 2026-08-25): anchored to the tile
    // that was pressed — toggle() marks it .open just before appending — and
    // the window no longer widens for it (the extraWidth post left with the
    // strip). Re-placed on every content change, because the anchor is the
    // one fixed point while async login replies grow the card.
    // THE ANCHOR IS RESOLVED, NOT ASSUMED. Every appender is supposed to mark
    // its row .open first, but an async painter can land after a close or a
    // rebuild has unmarked the world — and hzPlacePop's null-anchor guard then
    // silently skips placement, which shows the card wherever its stale styles
    // left it. Fall back to the live row that owns the card (both carry
    // dataset.id for exactly this kind of reunion), and if no live row owns
    // it, close the host: an unplaceable pop-over must not render.
    if (!placeOpenHint({ closeIfUnplaceable: true })) return;
    if (!hintHost.querySelector('.hint-x')) {
      const x = document.createElement('button');
      x.className = 'hint-x';
      x.textContent = '×';
      x.title = 'Close';
      x.addEventListener('click', closeHint);
      hintHost.appendChild(x);
    }
  } else {
    hintHost.replaceChildren(); // drop an orphaned x so :empty hides the host
  }
}).observe(hintHost, { childList: true });
// The strip scrolls, so the card must follow. Passive because this only reads
// layout and repositions; blocking the scroll would make the very gesture that
// exposes the bug feel worse than the bug. rAF-coalesced: a smooth scroll fires
// this many times per second and hzPlacePop reads a rect each time.
{
  const grid = document.getElementById('grid');
  if (grid) {
    let queued = false;
    grid.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (hintHost.querySelector('.hint')) placeOpenHint();
      });
    }, { passive: true });
  }
}
const notice = document.getElementById('notice');
const settings = document.getElementById('settings');

// ~~infoHint / settingHint: a round "?" beside a label that opened a pop-over
// of explanation, and .setting-note, the paragraph under every label.~~ Both
// yeeted (owner, 2026-09-13, opening this panel: "what the fuck are these
// settings??? so much fucking text??"). The screenshot he was looking at is
// nine cards tall and only four of them are a control — the rest is prose.
//
// EVERY ROW IS ONE LINE NOW: a bold name on the left, its control on the
// right, nothing underneath. The copy was not deleted — each sentence is the
// `title` of the row it explained, which is hover-only and costs the column no
// height. The constants below are that copy, named rather than inlined so the
// ones that are PROMISES can still be found and compared against the screen
// that made them (ENGINE_PRIVACY is word-for-word onboarding's).
//
// The one exception is uninstall, which keeps a single short line on the
// surface: it is the one press here that cannot be taken back.
const CARD_HELP = 'change who it looks for on the card itself — the three chips at the top.';
const SOUNDS_HELP = 'presses, sending and replies make a sound.';
const MOTION_HELP = 'reduce motion is on for this Mac. this puts back only this app\u2019s own movement.';
const AWAKE_HELP = 'Keeps imports and local indexing moving while you step away, so they finish sooner. It still allows manual sleep and lid-close.';
const PERFORMANCE_HELP = 'maxx does more work in each pass and asks macOS for foreground priority, '
  + 'so imports and local indexing finish sooner. Using less power does the same work '
  + 'in smaller passes at background priority — slower, but the machine stays quiet. '
  + 'Both keep running on battery; neither one stops.';
const ESTIMATE_HELP = 'Your Mac is importing and indexing everything privately. More chats and years mean more time.';
// TRUE, AND CHECKED AGAINST WHAT ACTUALLY HAPPENS (main.swift
// applicationWillTerminate): the reader is this app's own child and stops with
// it, while hermes, connect and the model server are launch agents and keep
// running. Saying "everything keeps running" would be the comfortable sentence
// and the wrong one.
const QUIT_HELP = 'closes this window and the app. what it has already read stays, and the '
  + 'services behind it keep running — but nothing new is read until you open it again.';
const UNINSTALL_HELP = 'stops and removes the background services and deletes the app. everything it '
  + 'has read is left where it is, and the next screen says exactly what will happen.';
// THE ONE LINE LEFT ON THE SURFACE, under the one irreversible row. Seven
// words, and the count is not the constraint the wording is fighting: the row
// is 252px of monospace, so a line here is 41 characters and this is 41. "its"
// and "your" were the two words that could go without taking a fact with them.
const UNINSTALL_NOTE = 'removes the app and services. data stays.';

// One row per setting, and it is ONE LINE: the name, and the switch. Generic
// because there are three of them now and they differ only in wording, in
// which bridge message they send, and in whether they are shown at all.
//
// `help` is the row's hover, never a line under it — see the note above.
function settingRow({ name, help, on, message }) {
  const el = document.createElement('div');
  el.className = 'setting';
  if (help) el.title = help;

  const label = document.createElement('span');
  label.className = 'setting-name';
  label.textContent = name;

  const sw = document.createElement('button');
  sw.className = 'switch' + (on ? ' on' : '');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(on));
  // NO TITLE ON THE CONTROL. The row owns the hover; a second one on the
  // switch would answer a different sentence depending on where the pointer
  // happened to land.
  sw.setAttribute('aria-label', name);
  const knob = document.createElement('span');
  knob.className = 'knob';
  sw.appendChild(knob);
  sw.addEventListener('click', async () => {
    const next = !sw.classList.contains('on');
    sw.classList.toggle('on', next);
    sw.setAttribute('aria-checked', String(next));
    try {
      await hzPost(message, { on: next });
      // This page is not one of the two native pushes to, so it applies the
      // sound setting to itself — otherwise the switch would keep clicking
      // after being switched off.
      if (message === 'setSounds') window.__hzSounds(next);
    } catch {
      // Nothing was stored, so the switch must not claim otherwise.
      sw.classList.toggle('on', !next);
      sw.setAttribute('aria-checked', String(!next));
    }
  });

  el.append(label, sw);
  return el;
}

// WHAT THE DAILY CARD IS SET TO, read from the owner config rather than
// guessed. GET /admin/config/card (bridge verb `cardConfig`) answers mode,
// capPerDay, producer and engine WITHOUT running the producers — which is what
// makes it safe to ask on every settings render, where a card peek would spend
// a cap slot and flip the producers' turn for a panel nobody asked a card from.
//
// ONE REQUEST, TWO ROWS. The promise is made once in renderSettings and handed
// to whoever needs it, so opening settings is one question to the reader and
// not one per row.
// A REPLY IS NOT A SUCCESS.
//
// Bridge.reply always sends `ok: true` — that envelope says the message was
// dispatched, not that the verb worked — and bridge.js resolves on it. So
// hzPost NEVER rejects for a handled verb, and every `.catch` on one of these
// is decoration. relHermes, which every reader-facing verb goes through,
// answers `{state:'down'}` when hermes is restarting and `{state:'auth'}` when
// there is no bearer yet; both RESOLVE, and both mean nothing happened.
//
// `ok === false` is the other half: the route answered, and said no.
//
// NOT FOR engineProbe. Its states are the PROBE'S vocabulary, where 'auth'
// means claude is installed but not signed in — a real answer about the world,
// not a bridge failure. Two different words spelled the same; see paint().
const landed = (out) => out?.state === 'ok' && out?.ok !== false;

// WHAT THE CONFIG SAYS THE ENGINE IS, from a reply that arrived. 'claude-cli'
// is the only value that means anything leaves this Mac; every other answer,
// INCLUDING the absent key the route sends as null, is the loopback model
// (engines.mjs' own default). Returns null only for a reply that never came,
// which is the one state that may not be reported as a setting.
function configEngine(cfg) {
  if (cfg === null || cfg === undefined) return null;
  return cfg.engine === 'claude-cli' ? 'claude-cli' : 'local';
}

function cardConfigRow(configPromise) {
  const el = document.createElement('div');
  el.className = 'setting';
  // The picker is NOT duplicated here, deliberately: it lives on the card,
  // which is where you change your mind about it. This row exists because a
  // new owner reading settings saw no sign the product had modes at all — and
  // saying so takes a hover, not four lines of the column.
  el.title = CARD_HELP;
  const label = document.createElement('span');
  label.className = 'setting-name';
  label.textContent = 'daily card';
  const said = document.createElement('span');
  said.className = 'setting-said';
  // EMPTY UNTIL THE READER ANSWERS. A placeholder here would be a busy label
  // for a question that is usually answered in the same frame, and this panel
  // keeps one busy word per idea rather than one per row
  // (connect-affordances.test.mjs).
  said.textContent = '';
  // LABEL LEFT, VALUE RIGHT, one line.
  //
  // It was label, value and a description stacked in a text column, because
  // the value had been a right-hand slot and lost a width fight with the
  // description on a 312px panel (run 6, the row printing one word per line).
  // The description is gone — it is this row's `title` now — so the fight has
  // no second party: the value is the only thing beside the label, it is
  // nowrap and right-aligned, and the label ellipsizes before either wraps.
  el.append(label, said);

  configPromise.then((cfg) => {
    const bits = [];
    if (typeof cfg?.mode === 'string' && cfg.mode) bits.push(cfg.mode);
    // THE REAL NUMBER, ALWAYS. ~~`n === 1 ? 'one card a day' : ...`~~ — the
    // singular was a word where every other reading of this row is a digit,
    // and it read as a hard-coded "one" to an owner whose config says 50.
    if (Number.isInteger(cfg?.capPerDay) && cfg.capPerDay > 0) bits.push(`${cfg.capPerDay} a day`);
    // NOTHING IS ASSERTED WHEN NOTHING ANSWERED. A reader that is still
    // starting up must not be reported as a setting: an em dash says "not
    // known", where a default would say "investor" to somebody on 'any'.
    said.textContent = bits.length > 0 ? bits.join(' · ') : '—';
    // THE ENGINE IN WORDS, in the hover rather than as a third clause on the
    // line (owner: no third clause — the engine is the toggle above). It is
    // still SAID somewhere, because this row is where an owner who cannot see
    // that toggle (no claude on this Mac, or a probe that failed) finds out
    // which way it is set.
    //
    // ABSENT IS NOT UNKNOWN. The route answers `engine: null` when the config
    // key has never been written, and engines.mjs reads an absent key as the
    // loopback model — so on a fresh install "nothing is set" IS "nothing
    // leaves this Mac". An answer with no engine key is still an answer; only
    // a reply that never came is unknown, and that is `cfg` itself being null.
    if (cfg) {
      const engine = configEngine(cfg) === 'claude-cli' ? 'reading with claude' : 'reading on this Mac';
      el.title = `${CARD_HELP} ${engine}.`;
    }
    fitConnections();
  });
  return el;
}

// THE ONE SOURCE THIS APP CANNOT FETCH FOR ITSELF.
//
// Everything else on this panel is a switch or a login. LinkedIn is a FILE the
// owner asks LinkedIn for and then hands over, which gives it a state no other
// row has: asked for, not here yet. Until this row existed that state was
// invisible — settings showed no sign the export was a thing at all, and the
// only places to hand the file over were a connector card on the shelf above
// and a setup flow the owner had already finished.
//
// ONE LINE, LIKE EVERY ROW HERE (owner, 2026-09-13: "so much fucking text??").
// The value carries the state AND is the control: press it for the picker, or
// drop the file on this panel, which native takes and imports through the same
// path (ClickThroughWebView.onFileDrop). Every explanation, refusals included,
// is the row's hover.
const LINKEDIN_HELP = 'linkedin will not let anything read your connections, so you ask '
  + 'them for a copy and hand the file over. it is what tells a founder from an investor.';
const LINKEDIN_WAITING = 'waiting for your file · drop it here';
// ...and what the same row says once LinkedIn has mailed to say the archive is
// downloadable. "waiting for your file" is still true there and no longer
// useful: the thing being waited for has arrived, in the owner's inbox, and the
// errand is to go and get it. The mail connector leaves the note
// (connectors/lib/linkedinExport.mjs) and connect's linkedin-export row carries
// its timestamp — spent the moment an export is installed, so a timestamp
// reaching this row always means there is still something to do.
const LINKEDIN_READY = 'your export is ready — open the email';
// WHAT WENT WRONG, TWICE OVER: a few words on the line, the whole sentence on
// the hover. The row may not grow to hold a remedy, and a remedy nobody can
// read is not one — so the short form says which failure it was and the hover
// says what to do about it.
const LINKEDIN_REFUSALS = {
  'zip-connections': ['no connections in that zip',
    'there is no Connections.csv anywhere in that archive. tick "connections" when you '
    + 'request the export and it will be in the next one.'],
  zip: ["couldn't open that zip", 'that file is not an archive i can read.'],
  columns: ["columns i don't recognise", 'i can only read the english export today.'],
  newer: ['yours is older — kept', 'the export already here is newer than the file you chose.'],
  duplicate: ['two of those — choose one',
    'you chose two files that are both the same export. pick one of them.'],
};
const LINKEDIN_REFUSAL_DEFAULT = ["couldn't read that file", "i couldn't read that file."];

// Set when the row is built, so an import nobody started here — the Downloads
// watcher's notification, a file dropped on this panel — can repaint it.
// Native calls __hzLinkedInChanged; see main.swift linkedInExportChanged.
let repaintLinkedIn = null;
// The drop the export filter turned away, so the row that says "drop it here"
// can say what the file was not. Native swallows every drop on this panel now —
// it used to hand unmatched ones to WebKit, which NAVIGATES to them — so
// without a word here a drop the owner aimed at this row vanishes in silence.
let refuseLinkedInDrop = null;
// ...and the one fact the row cannot ask for itself. `linkedinExportReady`
// rides connect's linkedin-export source row, which refresh() below already
// fetches on every open and every focus — asking for it a second time through a
// bridge verb of its own would be two readers of one note, which is how two
// lines in one panel come to disagree.
//
// BUFFERED, NOT A SLOT TO CALL BACK INTO (review finding 13). renderSettings is
// async and builds the row after its own `await`, so refresh() could get there
// first, find nothing to hand the value to, and drop it — leaving the row
// reading "waiting for your file", which is the one sentence the marker exists
// to replace, until something refocused the panel. The value is kept here and
// the row reads it when it is built, whichever of the two arrives first.
let linkedInReadyTs = null;
let noteLinkedInReady = (ts) => {
  linkedInReadyTs = Number.isFinite(Number(ts)) ? Number(ts) : null;
};

function linkedInRow() {
  const row = document.createElement('div');
  row.className = 'setting';
  const label = document.createElement('span');
  label.className = 'setting-name';
  label.textContent = 'linkedin';
  // A BUTTON, NOT A SPAN. It is the control as well as the read-out, and a span
  // would lose the keyboard and the focus ring on the only door into the picker
  // this panel has.
  const said = document.createElement('button');
  said.type = 'button';
  said.className = 'setting-said setting-said-press';
  row.append(label, said);

  const say = (line, hover) => {
    said.textContent = line;
    row.title = hover;
    // The row owns the hover, so the control carries the whole line for anyone
    // reading it aloud — same split as settingRow.
    said.setAttribute('aria-label', `linkedin — ${line}`);
  };

  // WHAT THE ROW SAYS WHILE THERE IS NO FILE, which is one of two things: the
  // mail has arrived and the errand is to go and open it, or it has not and
  // there is nothing to do but wait. Held rather than read, because the two
  // answers arrive from different places at different times — the shelf hands
  // over the mail's timestamp, `linkedInState` says whether a file is here —
  // and whichever lands second must not paint the other one's answer away.
  // `linkedInReadyTs` is module-level and may already hold an answer refresh()
  // delivered before this row existed; see the buffer above.
  let installed = false;
  const paint = () => {
    if (installed) return;
    if (linkedInReadyTs !== null) {
      say(LINKEDIN_READY, `${LINKEDIN_HELP} press to choose it.`);
      return;
    }
    say(LINKEDIN_WAITING, LINKEDIN_HELP);
  };

  paint();

  // COUNTS AND A DATE. Nothing else ever crosses the bridge from that file —
  // see linkedInState in Bridge.swift. `present: false` is the ordinary
  // first-run answer and hands the line back to the two waiting states above.
  const paintState = (out) => {
    installed = out?.present === true;
    if (!installed) { paint(); return; }
    const n = Number(out.connections || 0);
    const when = Number(out.modifiedTs);
    const dated = Number.isFinite(when) ? ` · ${new Date(when).toLocaleDateString()}` : '';
    say(n > 0 ? `${n.toLocaleString()} connections${dated}` : `an export is here${dated}`,
      `${LINKEDIN_HELP} press to replace it.`);
  };

  const ask = () => hzPost('linkedInState').then(paintState).catch(() => {});
  repaintLinkedIn = ask;
  // A TIMESTAMP OR NULL, and null is an answer: the note is spent the moment an
  // export is installed, so the row has to be able to stop saying "open the
  // email" once the owner has. Writes the module-level buffer, so a later
  // rebuild of this row starts from the same answer.
  noteLinkedInReady = (ts) => {
    linkedInReadyTs = Number.isFinite(Number(ts)) ? Number(ts) : null;
    paint();
    fitConnections();
  };
  // A DROP THIS ROW ASKED FOR AND COULD NOT USE. Stays until the next thing
  // happens to the row, which is what every other refusal here does — the
  // owner has to be able to read it after the file has gone back to wherever
  // they dragged it from.
  refuseLinkedInDrop = (name) => {
    if (installed) return;
    say("that isn't a linkedin export",
      `${name || 'that file'} is not Connections.csv or the zip linkedin sends. ${LINKEDIN_HELP}`);
    fitConnections();
  };
  ask();

  said.addEventListener('click', () => {
    said.disabled = true;
    const previous = said.textContent;
    const previousHover = row.title;
    said.textContent = 'opening…';
    hzPost('importLinkedIn')
      .then((out) => {
        // A cancel is an answer, not a failure: the row goes back to saying
        // whatever it said before the panel opened.
        if (!out || out.state === 'cancelled') { say(previous, previousHover); return; }
        if (out.state === 'ok') {
          // Read back rather than rendered from the reply. The reply says what
          // this pick imported; this row's job is to say what is INSTALLED, and
          // a pick that lands two files would make those different answers.
          ask();
          return;
        }
        const [short, why] = LINKEDIN_REFUSALS[out.reason] ?? LINKEDIN_REFUSAL_DEFAULT;
        say(short, `${why} ${LINKEDIN_HELP}`);
      })
      .catch(() => {
        const [short, why] = LINKEDIN_REFUSAL_DEFAULT;
        say(short, `${why} ${LINKEDIN_HELP}`);
      })
      .finally(() => { said.disabled = false; fitConnections(); });
  });

  return row;
}

// A setting whose control is a BUTTON, because what it does happens once
// instead of being on or off. The press is awaited and the button is dead while
// it runs: both of these reach native, and one of them is deleting things.
function actionRow({ name, help, note, label, danger = false, onPress }) {
  // THE NOTE RUNS THE FULL WIDTH, under the name and the button rather than
  // beside them. Squeezed into the column left over by a 90px pill it had
  // about 25 characters a line, which turned one sentence into three lines —
  // and made native's live uninstall narration, which lands in this same
  // element, unreadable at the moment it matters most. With an empty note the
  // row is its head and nothing else, which is one line.
  const el = document.createElement('div');
  el.className = 'setting setting-col';
  if (help) el.title = help;
  const text = document.createElement('div');
  text.className = 'setting-head';
  const title = document.createElement('span');
  title.className = 'setting-name';
  title.textContent = name;
  // THE ONLY LINE LEFT UNDER A LABEL IN THIS PANEL, and only uninstall passes
  // one: it is the press that cannot be taken back, so what it keeps is said
  // on the surface rather than on a hover nobody is obliged to try.
  //
  // The element is built for every row regardless, because `say` writes into
  // it — quit's one failure sentence, and uninstall's step-by-step narration
  // from native — and a row that cannot report what just happened is worse
  // than a row with a line under it. Empty, it renders as nothing (`:empty`).
  const sub = document.createElement('span');
  sub.className = 'setting-note';
  sub.textContent = note || '';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'setting-btn' + (danger ? ' setting-btn-danger' : '');
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      // `say` rewrites the row's own note, which is where the owner is already
      // looking. A toast somewhere else would be a second place to watch for
      // the answer to a button they just pressed.
      await onPress({ say: (line) => { sub.textContent = line; fitConnections(); } });
    } catch {
      sub.textContent = 'that did not go through — try again.';
      fitConnections();
    } finally {
      btn.disabled = false;
    }
  });
  text.append(title, btn);
  el.append(text, sub);
  return el;
}

// WHY A START DID NOT HAPPEN, in the owner's words. The keys are
// Connectors.StartOutcome's own cases, so a new guard over there arrives here
// as `unknown` rather than as silence.
const START_REFUSED = {
  stopping: 'it is shutting down. reopen the app and it will start again.',
  modelMaintenance: 'it is paused while a local model finishes downloading.',
  missingRuntime: 'the local runtime is missing — this install needs repairing.',
  missingConfig: 'there is nothing set up for it to read yet. finish setup first.',
  // The reply itself did not land, or landed saying the settings write failed.
  // Whatever is or is not running, nothing here was configured.
  config: 'i could not write down what it should read. nothing changed.',
  unknown: 'it did not start, and did not say why.',
};

// THE ONE SWITCH THAT DECIDES WHETHER ANYTHING LEAVES THIS MAC, and until now
// it had no home outside the setup flow: `setEngine` was granted to onboarding
// alone, so once the flow was finished the owner could neither see the answer
// nor change it. Same copy as onboarding screen 5 on purpose — two wordings for
// one privacy switch is two promises, and only one of them can be the one that
// was read.
// THREE WORDS AND AN AMPERSAND (owner, 2026-09-13). The sentence this used to
// be — "use your claude subscription for reading and drafting" — wrapped to two
// lines at 312px before the panel had said anything at all. What it means is
// the hover, and the hover is the privacy promise itself.
const ENGINE_LABEL = 'claude reads & drafts';
const ENGINE_PRIVACY = "when this is on, excerpts of your messages go to anthropic's servers "
  + 'to be read. when it is off, nothing leaves this Mac.';
// NEUTRAL ABOUT THE DIRECTION, because the row shows it after a press either
// way — and it was written about turning the switch OFF, so turning it on
// printed an off-specific sentence about what had just been turned on.
const ENGINE_TIMING = 'this applies to the next person it reads about — one already being '
  + 'written finishes with what it started.';
// What a probe that is not `ok` means, in the same voice as the rest of this
// panel. NEVER a raw error string: see onboarding's statusCell for the same
// rule, and the review item that asked for it.
const ENGINE_STATE_COPY = {
  missing: 'no claude on this Mac, so it reads with the local model instead.',
  auth: 'claude is installed but not signed in. open it, sign in, then check again.',
  limit: 'claude is installed and signed in, but your plan is rate-limited right now.',
  upgrade: 'this claude is too old for the way i call it.',
  slow: 'claude did not answer. it may be busy — check again in a moment.',
  busy: 'still checking…',
  error: 'claude is here but it did not answer the way i expected.',
};
// A WRITE THAT DID NOT LAND. The switch snapping back is what the owner sees;
// these say why on the hover. Neither may imply anything was stored.
const ENGINE_NO_SAVE_AUTH = 'i could not reach the part of me that keeps this. nothing changed.';
const ENGINE_NO_SAVE = 'that did not save — the reader may still be starting up. nothing changed.';
const ENGINE_UNKNOWN = 'claude is here, but i cannot tell how this is set right now.';

function engineRow(configPromise) {
  const el = document.createElement('div');
  el.className = 'setting';
  const label = document.createElement('span');
  label.className = 'setting-name';
  label.textContent = ENGINE_LABEL;

  // EVERY SENTENCE THIS ROW USED TO PRINT, on the hover. It had two lines
  // under its label at all times — the privacy promise and a live state line —
  // which is four lines of a nine-row panel spent on one switch. The words did
  // not change; where they live did. The promise is always in there, because
  // it is the one this panel is answerable for.
  const say = (line) => { el.title = line ? `${ENGINE_PRIVACY} ${line}` : ENGINE_PRIVACY; };
  say('');

  // The control slot holds the busy word while a probe is in flight, then the
  // switch once one has come back ok, or a "check" pill when it has not — and
  // the switch keeps a one-word marker beside it if a write did not land.
  const control = document.createElement('span');
  control.className = 'setting-control';
  el.append(label, control);

  // ONE BUSY WORD, the same one onboarding's engine screen uses — see
  // connect-affordances.test.mjs, which rejects a new verb per call site.
  const busy = document.createElement('span');
  busy.className = 'setting-said';
  busy.textContent = 'checking…';

  // A FAILED WRITE IS SAID ON THE ROW, not only on its hover. The snap back
  // below is the first half of the report, and it is not enough on its own: a
  // switch that springs back with nothing beside it is a switch the owner
  // presses again, and this is the one control in the panel where what the
  // owner believes about it IS a privacy claim. One word, in the slot a value
  // would use, next to the switch rather than under it — the reason is the
  // hover, the fact is on the row. Cleared by the next answer of any kind.
  const warn = document.createElement('span');
  warn.className = 'setting-said setting-warn';
  warn.textContent = 'unsaved';

  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'switch';
  sw.setAttribute('role', 'switch');
  sw.appendChild(Object.assign(document.createElement('span'), { className: 'knob' }));
  const paintSwitch = (on) => {
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', on
      ? 'Reading with your Claude subscription'
      : 'Reading on this Mac only');
  };
  sw.addEventListener('click', async () => {
    const next = !sw.classList.contains('on');
    paintSwitch(next);
    const out = await hzPost('setEngine', { engine: next ? 'claude-cli' : 'local' })
      .catch(() => null);
    if (landed(out)) {
      control.replaceChildren(sw);
      say(ENGINE_TIMING);
      return;
    }
    // NOTHING WAS WRITTEN, so the switch must not claim otherwise — this is the
    // switch where a wrong paint is a false privacy claim, and the failure it
    // has to survive is the ordinary one: hermes mid-restart answers
    // {state:'down'} and RESOLVES, so the `catch` this replaces caught nothing
    // and the switch stayed where the owner put it while the config did not.
    paintSwitch(!next);
    control.replaceChildren(warn, sw);
    say(out?.state === 'auth' ? ENGINE_NO_SAVE_AUTH : ENGINE_NO_SAVE);
  });

  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'setting-btn';
  // 'check', not 'check again': at 312px the label above is 21 monospace
  // characters and the row has about 100px left for a control. The longer pill
  // did not fit beside it, and the row may not wrap.
  again.textContent = 'check';
  again.addEventListener('click', () => { probe({ manual: true }); });

  // THE SWITCH IS OFFERED ONLY WHEN THE PROBE WORKED. "you have it" and "it
  // works" are different questions, and only the second one may put a switch on
  // screen that sends message excerpts off this Mac — onboarding's own rule.
  //
  // AND ONLY WHEN ITS POSITION IS KNOWN. `paintSwitch(out.engine ===
  // 'claude-cli')` reads a MISSING field as off, which on this particular
  // switch is a silent implied opt-out nobody made — one tap from being written
  // back as the real answer. The probe carries the configured engine and so
  // does GET /admin/config/card, so the second answers when the first does not;
  // with neither able to say, there is no switch, exactly as with no probe.
  //
  // THE "CAN'T TELL" STATE IS A CONTROL, NOT A SENTENCE (owner, 2026-09-13),
  // and the control is the pill rather than a disabled switch: a switch drawn
  // disabled still draws a POSITION, and the position it would draw is off —
  // the exact false privacy answer the paragraph above exists to refuse. The
  // pill says the same "not now" and keeps the one verb that can change it.
  async function paint(out) {
    const st = out && out.state;
    if (st !== 'ok') {
      say(ENGINE_STATE_COPY[st] || ENGINE_STATE_COPY.error);
      control.replaceChildren(again);
      fitConnections();
      return;
    }
    const fromProbe = typeof out.engine === 'string' ? out.engine : null;
    const engine = fromProbe ?? configEngine(await configPromise);
    if (engine !== 'claude-cli' && engine !== 'local') {
      say(ENGINE_UNKNOWN);
      control.replaceChildren(again);
      fitConnections();
      return;
    }
    say(ENGINE_TIMING);
    paintSwitch(engine === 'claude-cli');
    control.replaceChildren(sw);
    fitConnections();
  }
  // A `busy` PROBE IS A QUEUE, NOT AN ANSWER. EngineProbe returns it when
  // another probe holds the job — which is exactly what happens while the
  // onboarding flow is open and probing beside this panel. It clears itself in
  // seconds, so the row asks again rather than parking on a pill the owner has
  // to notice and press. Bounded, because a probe that is busy for ever is a
  // different bug and a page that retries for ever hides it.
  let busyRetries = 0;
  // `manual` is a press, and a press starts the budget again. Without that the
  // three retries were spent once per panel session and every later press
  // parked on the busy pill for good — the exact state the retry was added to
  // get out of. Any answer that is not `busy` resets it too.
  function probe({ manual = false } = {}) {
    if (manual) busyRetries = 0;
    control.replaceChildren(busy);
    hzPost('engineProbe')
      .then((out) => {
        if (out?.state !== 'busy') busyRetries = 0;
        if (out?.state === 'busy' && busyRetries < 3) {
          busyRetries += 1;
          setTimeout(probe, 2000);
        }
        paint(out);
      })
      .catch(() => paint({ state: 'error' }));
  }
  probe();
  return el;
}

// ~~rangeRow: a setting that holds a NUMBER — a full-width track under its
// label, with a live read-out and a line of explanation.~~ The size slider was
// yeeted (owner, 2026-08-24: everything runs at 100%) and this builder stayed
// behind uncalled for three weeks. It is deleted here rather than kept
// "in case": it was the last thing in this file that put a paragraph under a
// label, and a panel whose rule is one line per row cannot carry a dormant
// exception to it. renderSettings still snaps a stored non-1 scale back to 1,
// which is the only part of the slider era that has to survive.

// One explicit performance switch replaces the old implicit charger/thermal
// policy. Both settings keep processing — only pass size and process priority
// change, and neither reads the charger.
//
// THE ROW IS NAMED FOR WHAT THE SWITCH TURNS ON (owner, 2026-09-13: "use less
// power" — the toggle IS the answer). ~~A row called "performance" with a
// "maxx / use less power" read-out printed beside its switch~~: the name asked
// a question the read-out then had to answer, which is two pieces of text for
// one control. Named this way the switch means what it says — ON is less
// power — and needs nothing beside it.
//
// THE POLARITY FLIPPED WITH THE NAME, AND ONLY ON SCREEN. What is stored and
// sent is untouched: `setPerformance` still writes full_speed / less_power,
// and a preference written before the rename still resolves rather than
// silently reading as the other setting. The owner's compact "maxx" name for
// the high-throughput side survives in the hover and in the accessible name.
function performanceRow(selected) {
  const el = document.createElement('div');
  el.className = 'setting';
  el.title = PERFORMANCE_HELP;

  const name = document.createElement('span');
  name.className = 'setting-name';
  name.textContent = 'use less power';

  const sw = document.createElement('button');
  sw.className = 'switch';
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  const knob = document.createElement('span');
  knob.className = 'knob';
  sw.appendChild(knob);

  // Old values are still accepted: a preference written before the rename must
  // not silently read as the other setting.
  const FULL = 'full_speed';
  const LESS = 'less_power';
  const normalise = (v) => (v === FULL || v === 'god_mode' ? FULL : LESS);
  let active = normalise(selected);
  const paint = () => {
    const less = active === LESS;
    sw.classList.toggle('on', less);
    sw.setAttribute('aria-checked', String(less));
    // The accessible name says what the switch DOES, since a screen reader user
    // gets no hover alongside it.
    sw.setAttribute('aria-label',
      less ? 'Processing: use less power' : 'Processing: maxx');
  };
  sw.addEventListener('click', async () => {
    const previous = active;
    const requested = active === FULL ? LESS : FULL;
    active = requested;
    paint();
    try {
      const response = await hzPost('setPerformance', { mode: requested });
      active = response && response.performance === requested ? requested : previous;
    } catch {
      active = previous;
    }
    paint();
  });
  paint();

  el.append(name, sw);
  return el;
}

// A small live view of work this app is ACTUALLY doing. It intentionally does
// not call a connector "active" just because its daemon is running: only model
// bytes in flight and app-owned indexing/distillation phases appear here.
function activityRow() {
  // WHAT THE LAST PRESS OF "start it" ANSWERED, held here rather than in a node.
  //
  // paint() below begins by emptying the list and runs on a two-second
  // interval, so a refusal written straight into the row was gone within two
  // seconds of the press — taking the entire reason the start outcome is
  // reported at all. Held in the closure, read on every repaint, cleared by a
  // fresh press or by the reader actually coming up.
  let startNote = null;
  const el = document.createElement('div');
  el.className = 'setting setting-col activity-setting';
  const head = document.createElement('div');
  head.className = 'setting-head';
  const name = document.createElement('span');
  name.className = 'setting-name';
  name.textContent = 'activity';
  const estimate = document.createElement('span');
  estimate.className = 'activity-estimate';
  estimate.hidden = true;
  // ~~a "?" beside the total, opening "why is this taking so long?"~~ The
  // question is worth answering and the icon was not: the answer is this
  // read-out's own hover now, on the very thing being asked about.
  estimate.title = ESTIMATE_HELP;
  head.append(name, estimate);
  const list = document.createElement('div');
  list.className = 'activity-list';
  el.append(head, list);

  const gb = (bytes) => `${(Number(bytes || 0) / 1e9).toFixed(1)}`;
  const paint = (data) => {
    const total = data && typeof data.estimate === 'string' ? data.estimate.trim() : '';
    estimate.textContent = total;
    estimate.hidden = !total;
    const latestItems = data && Array.isArray(data.items) ? data.items : [];
    // The queue stays intact: the first row is current and the remaining real
    // scheduled work follows in order. Current + next two fit; more scroll here.
    const active = latestItems.filter((item) => item && item.kind !== 'queue');
    const queued = latestItems.filter((item) => item && item.kind === 'queue');
    const items = [...active, ...queued];
    list.replaceChildren();
    if (!items.length) {
      // ~~"nothing processing right now"~~ WAS THE SAME SENTENCE for three
      // different states: the reader has finished what it can see, the reader
      // has never started, and the reader is not running any more. The first is
      // fine and the other two are the owner's problem to fix — and the panel
      // was telling them apart for nobody. `reading` is the app's own child
      // process, which is the thing that would be doing the work.
      const idle = document.createElement('span');
      idle.className = 'activity-idle';
      const reading = data && data.reading;
      if (reading !== false) startNote = null; // it came up; the refusal is history
      idle.textContent = startNote
        || (reading === false
          ? 'nothing is running.'
          : 'nothing to do right now — everything it can see is read.');
      list.appendChild(idle);
      if (reading === false) {
        // The same idempotent call onboarding's banner offers, and the same
        // one the permission screens make: native guards a daemon that is
        // already up, so pressing it twice costs nothing.
        const start = document.createElement('button');
        start.className = 'setting-btn';
        start.type = 'button';
        start.textContent = 'start it';
        start.addEventListener('click', async () => {
          start.disabled = true;
          startNote = null;
          idle.textContent = 'starting…';
          const out = await hzPost('startSources').catch(() => null);
          start.disabled = false;
          // A BUTTON THE OWNER PRESSES AND WATCHES. Native answers whether the
          // reader actually came up and, when it did not, which of the six
          // guards refused — two of which are states this button used to sit
          // in for ever, saying "starting…" and meaning nothing.
          //
          // STATE FIRST. `reading` rides on a reply whose `state` can be
          // "error": the config write failed and the daemon happened to be up
          // already, which is not a reader anybody configured. Trusting
          // `reading` alone said "reading now." about a configuration that was
          // never written.
          if (landed(out) && out.reading === true) {
            startNote = out.why === 'queued' ? 'starting…' : 'reading now.';
          } else if (!landed(out)) {
            startNote = START_REFUSED.config;
          } else {
            startNote = START_REFUSED[out?.why] || START_REFUSED.unknown;
          }
          idle.textContent = startNote;
          fitConnections();
        });
        list.appendChild(start);
      }
    } else {
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'activity-item';
        if (item.kind === 'backfill') row.classList.add('activity-backfill');
        if (item.kind === 'queue') row.classList.add('activity-queue');
        const dot = document.createElement('span');
        dot.className = 'activity-dot';
        const text = document.createElement('span');
        if (item.kind === 'model') {
          const verb = item.phase === 'verifying' ? 'verifying' : 'downloading';
          // `1.2/4.0 GB`, not `1.2 GB of 4.0 GB`: the list is three lines in a
          // 252px column and this one ellipsized mid-number.
          text.textContent = `${verb} ${item.tier || 'local model'} · ${gb(item.got)}/${gb(item.total)}`;
        } else {
          text.textContent = item.label || 'processing locally';
        }
        row.append(dot, text);
        list.appendChild(row);
      }
    }
    fitConnections();
  };
  const refreshActivity = () => hzPost('activity').then(paint).catch(() => {});
  refreshActivity();
  const timer = setInterval(refreshActivity, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  return el;
}

// Fit the popup to its content EXACTLY. hzAutoFit only ever grows (its measure
// is innerHeight + overflow, and overflow is 0 once the window is big enough),
// so a tall window stayed stuck above short content — the dead space up top the
// owner flagged. Measuring the column's own scrollHeight lets the window shrink
// to fit. The hint column, when open, can be taller than the settings column,
// so the window follows whichever is taller.
let fitLast = 0;
let fitQueued = false;
// A connector card is `position: fixed`, so resizing the native Settings
// window does not move it with its tile. The live activity row can change the
// Settings height at any moment; re-place an open card after the WebView has
// its new viewport rather than leaving it at the old, now-clipped coordinates.
function repositionOpenHint() {
  if (!hintHost.classList.contains('open')) return;
  // Same resolution as everywhere else. This used to do its own, without the
  // .open reunion step, so a card whose row had been rebuilt could be placed by
  // one path and skipped by the other.
  placeOpenHint();
}
function fitConnections() {
  if (fitQueued) return; // coalesce a burst of DOM mutations into one measure
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    const main = document.querySelector('.conn-main');
    if (!main) return;
    const pad = 28; // .win vertical padding, 14 top + 14 bottom
    // The column scrolls on purpose vertically, which means it CAN be
    // scrolled sideways by a focus() on something past an edge (overflow-x
    // hidden only hides the scrollbar, not the ability) — and a sideways
    // scroll here is the settings cards losing their left edge. This fitter
    // already wakes on every mutation, so it is the one place to undo that.
    if (main.scrollLeft !== 0) main.scrollLeft = 0;
    const mh = main.scrollHeight;
    // The hint no longer joins the measure: a pop-over floats over the page
    // and sizes itself to the room its tile leaves it (hzPlacePop).
    const h = Math.ceil(mh + pad);
    if (Math.abs(h - fitLast) < 3) return; // deadband, or the resize re-measures forever
    fitLast = h;
    hzPost('fitContent', { height: h }).catch(() => {});
  });
}
new MutationObserver(fitConnections).observe(document.querySelector('.win'), {
  childList: true, subtree: true, characterData: true,
  // Attributes too. This page shows and hides whole blocks by toggling `hidden`
  // — the memory row and `notice` both — and that changes the column's height
  // without touching childList or text. Without this the window kept the height
  // it measured while the block was still hidden, which is a popup that fits its
  // content exactly except when it does not. `style` is left out on purpose: the
  // only inline style here is a progress bar's width, which never changes height
  // and would re-measure every few seconds for nothing.
  attributes: true, attributeFilter: ['hidden', 'class'],
});
window.addEventListener('resize', () => {
  fitConnections();
  // `resize` fires after AppKit has accepted fitContent and changed this
  // WebView's bounds, which is the first point the fixed-position placer has
  // the correct viewport to clamp against.
  requestAnimationFrame(repositionOpenHint);
});
fitConnections();

async function renderSettings() {
  let p;
  try {
    p = await hzPost('prefs');
  } catch {
    return; // no bridge, nothing to toggle
  }
  const rows = [];
  // FIRST, BECAUSE IT IS THE ONLY ONE ABOUT DATA LEAVING THIS MAC. Everything
  // below it is about how the app behaves; this one is about where the words
  // go. It paints itself asynchronously — a probe runs the claude binary and
  // can take seconds, and settings must not wait on it to draw.
  // ASKED ONCE, READ TWICE. A rejected promise is an answer too — every reader
  // of it renders "not known" rather than a default — so the catch is here and
  // not at each use.
  // NULL FOR ANY REPLY THAT IS NOT OK. `.catch(() => null)` alone could never
  // produce that null: a down hermes resolves with {state:'down'}, which is
  // truthy, so every reader of this promise treated "the reader did not answer"
  // as a configuration — and the daily-card row said "reading on this Mac"
  // about a config it had not read.
  const cardConfig = hzPost('cardConfig')
    .then((out) => (landed(out) ? out : null))
    .catch(() => null);
  rows.push(engineRow(cardConfig));
  rows.push(cardConfigRow(cardConfig));
  // The motion row only appears when the system setting it overrides is
  // actually on. With Reduce Motion off it would do nothing, and a control
  // that does nothing is worse than no control.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    rows.push(settingRow({
      name: 'animations',
      help: MOTION_HELP,
      on: p && p.motion === true,
      message: 'setMotion',
    }));
  }
  // Sounds always show: there is no system setting behind them, so this is
  // the only place they can be turned off.
  rows.push(settingRow({
    name: 'sounds',
    help: SOUNDS_HELP,
    on: !p || p.sounds !== false,
    message: 'setSounds',
  }));
  rows.push(settingRow({
    name: 'keep mac awake',
    help: AWAKE_HELP,
    on: p && p.keepAwake === true,
    message: 'setKeepAwake',
  }));
  rows.push(performanceRow(p && p.performance));
  // Above the behaviour rows would put a file-handover between two switches;
  // below them, next to activity, is where the rows about what the app HAS
  // rather than how it behaves belong.
  rows.push(linkedInRow());
  // The size slider was yeeted (owner, 2026-08-24): everything runs at 100%.
  // Native's setScale plumbing survives untouched, so a stored non-1 scale
  // from the slider era is snapped back to 1 here — without the control, a
  // leftover 130% would be permanent.
  if (p && typeof p.scale === 'number' && Math.abs(p.scale - 1) > 0.001) {
    hzPost('setScale', { scale: 1 }).catch(() => {});
  }
  rows.push(activityRow());
  // The onboarding row was yeeted (owner, 2026-08-25): ~~a `run` pill that
  // replayed the welcome flow~~. Settings is where you change what the app
  // does, not where you re-watch its introduction, and the one control here
  // that took over the whole screen was the one nobody wanted twice.
  //
  // The grant behind it — and `markHandheld`, which no page ever called — went
  // with the surface review (2026-09-13), along with both bridge cases.
  // ~~"This page's `openOnboarding` grant and the bridge case behind it went
  // too"~~ was written here at the time and was NOT true: the grant and the
  // case both survived, so the settings page kept a door into the setup flow
  // that nothing on it could open. bridge-capabilities.test.mjs holds the map
  // to exactly what the pages call — an ungranted case is an orphan and a
  // granted-but-uncalled verb is a re-widened surface — and it was the comment,
  // not the test, that was wrong. main.swift keeps its own openOnboarding, so
  // first run and the two paths that still reach it (a resumed flow, and the
  // `onboarding` URL scheme) are unchanged.

  // LAST, AND IN THIS ORDER. Leaving is the bottom of a settings panel
  // everywhere else, and the reversible one goes above the one that is not.
  //
  // THE APP IS LSUIElement: no menu bar, no ⌘Q, no status item. Before these
  // two rows the only ways to stop it were Activity Monitor and a shell script
  // in a repo, which on somebody else's Mac means it cannot be turned off at
  // all — the worst thing on the surface, and the reason these are here.
  // NO LINE UNDER IT. Quitting is one press and one keystroke away from being
  // undone — reopen the app — so what it does is the hover, and the row is the
  // word and the button.
  rows.push(actionRow({
    name: 'quit',
    help: QUIT_HELP,
    label: 'quit',
    onPress: async () => { await hzPost('quitApp'); },
  }));
  // THE ONE ROW THAT KEEPS A LINE, because it is the one press that cannot be
  // taken back. Nine words, and the half of them that matter are the promise
  // that the data stays; the rest of what happens is the hover.
  rows.push(actionRow({
    name: 'uninstall',
    help: UNINSTALL_HELP,
    note: UNINSTALL_NOTE,
    label: 'uninstall',
    danger: true,
    onPress: async ({ say }) => {
      // NATIVE NARRATES IT. The work runs off the main thread and pushes each
      // step here as it lands, so a launchd that takes seconds per agent is a
      // row that is saying something rather than a window that has stopped
      // answering. Cleared when the call settles, whichever way it went.
      window.__hzUninstallStep = (step) => say(String(step));
      const out = await hzPost('uninstallApp').finally(() => {
        window.__hzUninstallStep = null;
      });
      // Native asks first, with an alert listing what is actually on this Mac.
      // A cancel is an answer, not a failure, and must leave the row as it was.
      if (!out || out.cancelled === true) return;
      if (out.state === 'partial') {
        // EXACTLY WHAT REMAINS, because the app does not quit on this path and
        // the owner is left looking at an install that is part gone. Native
        // puts the reader back before answering, so the thing they are looking
        // at is a working install and not a shell.
        const failures = Array.isArray(out.failures) ? out.failures : [];
        const gone = Array.isArray(out.services) ? out.services.length : 0;
        const removed = gone > 0 ? `${gone} service${gone === 1 ? '' : 's'} were removed. ` : '';
        // WHAT THE RESTART ACTUALLY ANSWERED. This used to assert "still
        // running and still reading" on every partial — including the one
        // where the app had just deleted its own bundle, so the reader had
        // nothing left to run and start() said so.
        const still = out.readerRestarted === true
          ? 'the app is still running and still reading.'
          : 'the app is still running, but the reader did not come back — quit and reopen it.';
        say(`${removed}this was left: ${failures.join('; ')}. ${still}`);
        return;
      }
      if (!landed(out)) {
        say('that did not go through — nothing was removed.');
        return;
      }
      // The app is quitting behind this line, so it is the last thing the owner
      // reads — and it has to name what was KEPT, because nothing else will get
      // the chance to.
      say(`removed. everything it read is still in ${out.dataKept || 'your home folder'}.`);
    },
  }));
  settings.replaceChildren(...rows);
}
renderSettings();

// AN EXPORT THAT LANDED WITHOUT ANYBODY PRESSING ANYTHING HERE — the Downloads
// watcher's notification, or a file dropped on this panel, which native takes
// because a page never sees a dropped file's path. The row reads its state once
// when it is built, so without this it would go on saying "waiting for your
// file" about a file that is installed. See main.swift linkedInExportChanged.
window.__hzLinkedInChanged = () => { if (repaintLinkedIn) repaintLinkedIn(); };
// ...and a drop this panel was given and could not use. Native takes every file
// drop on this window now, so it is the only thing that can answer for one.
window.__hzLinkedInDropRefused = (name) => {
  if (refuseLinkedInDrop) refuseLinkedInDrop(String(name ?? ''));
};

// ---------------- the connectors intro (yeeted) ----------------
// There WAS a guided first visit here: a banner above the shelf ("first --
// keep my sounds on?...") stepping through sounds, animations, connectors,
// pulsing each row in turn. The owner yeeted it (2026-08-22): no onboarding
// text above the shelf, ever. The native handshake survives -- onboarding
// still hands the gear off and pushes intro=true exactly once, so the hook
// stays and answers "seen" immediately, which stops native pushing it again.
window.__hzConnectorsIntro = (on) => {
  if (on === true) hzPost('connectorsIntroSeen').catch(() => {});
};
hzPost('prefs')
  .then((p) => {
    if (p && p.onboarded === true && p.connectorsIntroDone === false) {
      window.__hzConnectorsIntro(true);
    }
  })
  .catch(() => {});

// One sentence per source on how to connect it. Links open in the default
// browser via the native bridge — the webview itself can navigate nowhere.
const FDA_HINT = {
  // ~~text: the sentence walking through the grant.~~ Yeeted (owner,
  // 2026-08-25), same call as the broken-branch steps: the link IS the
  // walkthrough — it opens the exact pane with the right row to switch on.
  text: '',
  url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  link: 'Open System Settings',
  // One per Mac: there is no second Messages, Notes or photo library to add.
  // The `url` above is a Settings pane, not a sign-up page, so without this the
  // "+ add account" below offers to add an account by opening Full Disk Access.
  local: true,
};
// WRITTEN FOR SOMEBODY WHO INSTALLED AN APP. These used to name repo scripts
// (ops/gcal-auth.mjs) and secret file paths (~/.hazlie/secrets/*.txt) — neither
// of which exists for a person who downloaded this, and a secrets path in a
// tooltip is an invitation to go editing one by hand. Every one of them now
// points at the connect page, which is the door that actually opens.
//
// NOTE: this table is duplicated in connections.js and connector-tile.js. Both
// copies were corrected together; if you change one, change the other, or move
// it to a shared module.
const HINTS = {
  imessage: FDA_HINT, photos: FDA_HINT, notes: FDA_HINT,
  files: { text: 'Sign in to iCloud Drive, Box, or Dropbox on this Mac — any one of them counts.' },
  calendar: { text: 'Connect your Google account on the connect page and approve read-only calendar access.' },
  // ~~"Create a 16-letter Google app password, then paste it on the connect
  // page", linking myaccount.google.com/apppasswords.~~ False since the
  // connector moved to OAuth (2026-08-26): there is no app password to make,
  // the page it pointed at no longer leads anywhere useful, and the form on
  // the connect page that would have accepted one is deleted. A hint that
  // describes a flow the product no longer has is worse than no hint — it
  // sends the owner off to do work that cannot succeed.
  // The tile/button already starts and names this flow; repeating the setup
  // sentence in the anchored card adds no information.
  mail: { text: '' },
  // granola left this table (owner, 2026-08-25): its panel is the in-app
  // walkthrough now — open granola.ai, create a key, paste it right here.
  granola: { app: 'com.granola.app', url: 'https://granola.ai', link: 'Granola',
             walkthrough: true, // the DESKTOP app first — the key lives in its settings
             // The ROUTE, not the goal. "create an API key and copy it" (the
             // shared default) describes what you want, which is no help when
             // the thing is four levels into another app's settings — the
             // owner walked it and gave the path (2026-08-26).
             step2: 'settings → API → personal API keys → create new key' },
  // Telegram needs the OWNER's own api_id/api_hash before its bridge will
  // even start (my.telegram.org/apps). Same three-step shape as granola's:
  // open the page, make the thing, paste it back — connectSecret writes it
  // into the bridge config and starts the container.
  //
  // RESTORED (2026-08-26): this entry was collateral damage when the LinkedIn
  // export card was deleted a commit later, and losing it turned Telegram's
  // card back into a "begin login" that hangs forever against a container
  // that will not start. The walkthrough is the only thing on this card that
  // can make that container run.
  telegram: {
    url: 'https://my.telegram.org/apps',
    link: 'my.telegram.org',
    walkthrough: true,
    step2: 'create an app, then copy its api_id and api_hash',
    paste: 'paste api_id:api_hash',
  },
  // ~~linkedin: how to request an export and where to unzip it.~~ Gone with
  // the export itself (owner, 2026-08-25): LinkedIn is a bridge now, so its
  // tile renders the ordinary cookie-login flow like Messenger's.
  //
  // BACK, for the export ROW and not the bridge one (see isHiddenSource). With
  // `bridges` off there is no bridge to log into, and the export connector is
  // still scheduled and still polling ~/.hazlie/imports/linkedin — so this is
  // the only place the owner can be told that the folder is what it wants. The
  // path IS the instruction: nothing else on the shelf can name it, because no
  // other tile is waiting on a file the owner has to put there by hand.
  'linkedin-export': {
    // ~~"put Connections.csv in ~/.hazlie/imports/linkedin"~~ — a raw dotfile
    // path in a tooltip, and an instruction that CONTRADICTED onboarding screen
    // 4, which does the same job with a native file picker. Two ways to do one
    // thing, and the one written here was the one that asks the owner to go
    // digging in a hidden folder. The card carries the picker now (see
    // `pickLinkedInExport` below); the sentence is only how you get the file.
    // ~~"unzip it and choose Connections.csv here."~~ The zip is the only thing
    // LinkedIn ever sends, and the import takes Connections.csv out of it now
    // (Bridge extractConnections) — so this card was still asking the owner to
    // do by hand the job the picker on it had just been taught to do, and
    // contradicting that picker's own message ("choose the zip LinkedIn sent
    // you") on the same install (review finding 9).
    text: 'On LinkedIn: Settings → Data privacy → Get a copy of your data → tick "Connections" → '
      + 'Request archive. It arrives by email, usually in ten minutes — hand me the zip and '
      + 'I will take it from there.',
    url: 'https://www.linkedin.com/mypreferences/d/download-my-data',
    link: 'linkedin.com · get a copy of your data',
    // One export folder per Mac, so no "+ add account" once it is imported.
    local: true,
  },
  // OAuth2 since Oura retired personal access tokens in Dec 2025: the PAT
  // page this used to link is a dead end, and there is no settings page to
  // send anyone to instead, so this one is text-only — the connect page
  // carries the whole flow.
  oura: { text: 'Connect your Oura account on the connect page and approve the scopes in your browser.' },
  notion: { text: 'Create an internal integration, then paste its token on the connect page.',
            url: 'https://www.notion.so/my-integrations', link: 'notion.so/my-integrations' },
};
function hintFor(id) {
  return id.startsWith('mail:') ? HINTS.mail : HINTS[id];
}

// The WHY table — one sentence per connector on what data it reads, shown as a
// subheader under the panel title — was yeeted for every connector (owner,
// 2026-08-25). The hint's how-to and the caveat lines already say what is read
// where it matters, and the subheader had become a second copy that each panel
// paid a line of height for. The privacy line (STAY, below) survives — it is a
// promise, not a description, and nothing else on the panel makes it.

// Connectors finished on the loopback connect page (paste an app password or
// token there). They get an "open the connect page" door in their hint.
const CONNECT_PAGE = new Set(['oura', 'notion']); // granola pastes in-panel now
// One Google account covers both, and both take the same grant — so both tiles
// start the same flow rather than sending the owner somewhere to read about it.
// `mail` left CONNECT_PAGE above when it stopped having anything to paste.
const GOOGLE_AUTH = new Set(['mail', 'calendar']);

// How each social bridge authenticates — it is NOT the same for all of them,
// and the web-cookie-harvest button only fits the cookie ones. The token and
// phone flows drive a guided conversation with the bridge bot instead (begin
// sends the login command; the bot prompts; the input sends what it asked for
// — a token, a phone number, then the code — through the same relay).
// The flow shapes the HELP TEXT (a token and a phone code want different
// wording). It no longer decides whether an embedded login is possible — the
// server does, by returning allowedHosts for the platforms that have a cookie
// flow, and bridgeWebLogin answering `manual` for the ones that do not. This
// table and the native fence used to be two independent copies of that
// decision and they disagreed about X, which had a login button here and no
// matching host in the fence, so the window opened blank.
const BRIDGE_FLOW = {
  twitter: 'cookie', messenger: 'cookie', instagram: 'cookie', linkedin: 'cookie',
  // ~~discord/slack: 'token'~~ — neither pastes a token any more (2026-08-26).
  // `flow` decides two things: whether the cookie login button is offered, and
  // whether the reply box is a textarea. Discord approves a link in its phone
  // app and Slack answers with an email address; both are one short line.
  // ~~slack: 'email'~~ — Slack signs in through the WINDOW again (owner,
  // 2026-08-26: "when someone hits the icon it should open the login window
  // directly"). It is a cookie flow in the sense this map means: the press
  // opens the window, the window collects the session, and there is nothing to
  // type on the card. See bridge.mjs PLATFORMS.slack for what it collects.
  discord: 'link', slack: 'cookie', telegram: 'phone',
};
// ~~Each of these carried a `lead` sentence ("Slack logs in with two tokens
// from your browser (xoxc and xoxd).") and a how-to link into the mautrix
// docs.~~ Yeeted for all three (owner, 2026-08-25), same shape as every other
// explainer this panel has shed: the input's placeholder names exactly what
// to paste, and that is the whole briefing the flow needs.
const BRIDGE_HELP = {
  // What the bot is about to ask for, in the words of the flow it actually
  // runs. ~~"your Discord token" / "your Slack tokens"~~ described a command
  // (`login-token`) these bridges reject outright (2026-08-26).
  discord: { place: 'scan the QR with your Discord phone app' },
  // ~~Slack's own login page will not render in this window, so the tokens
  // come out of a browser already signed in: xoxd from the cookie jar, xoxc
  // from a request header, both dug out of devtools.~~ Gone, and good
  // riddance — that card asked the owner to read two secrets out of devtools
  // and paste them, which is the most alarming thing this app has ever put on
  // screen, and it was only there because of a wrong finding about the login
  // page (see bridge.mjs PLATFORMS.slack for the measurements that reversed
  // it). Slack signs in with an email address now, like Beeper does.
  slack: {
    place: 'your Slack email address',
    // ~~A `why` line: "Slack asks for a quick 'are you human' check before it
    // emails your code — a window opens on Slack's own page for you to answer
    // it."~~ Yeeted (owner, 2026-08-26), and it is the same lesson the `lead`
    // sentences and the walkthrough links were yeeted for: it explained a step
    // that had not happened yet, above a box asking for something else. The
    // check announces itself when it arrives — that is what the button at that
    // step is for — and a card that narrates the whole flow in advance is a
    // card nobody finishes reading.
  },
  // ~~'phone (+1…), then the code'~~ — the owner's wording (2026-08-26). It was
  // trying to teach the whole two-step flow in one line before the first step
  // had happened, and the country-code hint duplicated the bot's own "Include
  // the country code with +" that lands directly above the box anyway.
  telegram: { place: 'phone number' },
};
// The claim the system actually keeps, not the one it doesn't. This line
// renders under EVERY tile including the social bridges, which hold a live
// authenticated session to the platform — so "your data never leaves this
// mac" was false there (the ops/EGRESS.json ledger enumerates the real
// paths). What IS true everywhere: ~~hazlie reasons over it locally and no
// cloud model sees it~~ (stale 2026-08-31: the owner-reviewed frontier
// handoff can send reviewed text to a cloud model) — the rows themselves stay
// local, and no cloud model receives anything the owner did not review and
// approve in chat.
const STAY = "data stored locally";

const kindOf = (id) => (id.startsWith('mail:') ? 'mail' : id);

// The shelf's order, most personal first — the owner's: iMessage, then the
// social places people actually live, then mail, then calendar, then
// everything else. /api/status returns them in ITS order, which is the
// server's business; this is the order a person scans in. Anything the
// server adds that is not listed here falls to the end in server order, so a
// new connector appears rather than disappearing.
const CONNECTOR_ORDER = [
  'imessage',
  'whatsapp', 'messenger', 'instagram', 'twitter', 'telegram', 'discord', 'slack', 'linkedin',
  // The export tile stands beside the bridge tile when both flows are provisioned
  // (visibleSources names them apart then), and in its place when they are not.
  'linkedin-export',
  'mail',
  'calendar',
  'contacts',
  'photos', 'notes', 'files', 'granola', 'oura', 'notion',
];
// ~~TEMPORARILY HIDDEN (owner, front-end only, 2026-08-22 — "bring them back
// later"): const HIDDEN_CONNECTORS = new Set(['oura', 'photos', 'files',
// 'notion', 'notes']).~~ DERIVED from ops/features.json now (see
// ops/FEATURES.md), together with the daemon's DEFAULT_DISABLED_CONNECTORS,
// which used to carry a comment telling whoever edited one list to remember the
// other. Same five ids fall out of the registry today; the difference is that
// nobody has to remember.
//
// The rows come from connect/lib/status.mjs and its `id` is not always a
// connector name, so two rules rather than one:
//
//   * a row whose connector feature is false is hidden;
//   * EVERY BRIDGE TILE is hidden while `bridges` is off — messenger,
//     instagram, twitter, telegram, discord, slack and LinkedIn's bridge row.
//     `isBridge` is the discriminator, not the id, and that matters for
//     LinkedIn specifically: `linkedin` is BOTH a bridge platform and the
//     connector that reads the data export, sharing one hermes source name.
//     The export connector stays on (the card's professional tags come from
//     it); what goes is the login tile for a bridge that is not provisioned.
//     Filtering by id would have switched off the export with it.
//
// The status rows themselves are untouched, exactly as the old hand-written
// version promised: a hidden id still works everywhere else it appears.
let featureSet = null; // filled by the first refresh(); see hzFeatures in bridge.js
// LinkedIn is two flows behind two different flags, and exactly one tile.
//
// The bridge tile goes with `bridges`, above. The EXPORT row (connect/lib/status.mjs
// LINKEDIN_EXPORT_ID) belongs to `connectors.linkedin`, which the card leaves
// ON — connectors/sources/linkedin.mjs keeps polling ~/.hazlie/imports/linkedin
// whatever the bridges flag says. Hiding both left a scheduled connector with
// no surface anywhere telling the owner to drop Connections.csv in. So: show
// the export tile when its connector is on and no bridge tile is carrying
// LinkedIn, and never show the two at once.
const LINKEDIN_EXPORT_ID = 'linkedin-export';
/// THE CONNECTOR A ROW BELONGS TO, which is not always the row's id. `mail:<…>`
/// rows are the mail connector, and the export row is the `linkedin` connector —
/// sources/linkedin.mjs, the thing that polls ~/.hazlie/imports/linkedin. That
/// second mapping used to live inside isHiddenSource only, so isOptionalSource
/// asked the registry about a connector named "linkedin-export" that does not
/// exist and got `undefined`: the tile showed and was never labelled optional
/// while the daemon was waiting for the owner to start it. One mapping, both
/// rules. connect/lib/status.mjs' connectorForStatusRow is its server-side twin.
const connectorOf = (id) => (id === LINKEDIN_EXPORT_ID ? 'linkedin' : kindOf(id));
function isHiddenSource(src) {
  // The export row answers to its own connector and NOTHING ELSE. It used to
  // hide whenever `bridges` came on, which re-created the bug it was brought
  // back to fix, mirrored: connectors.linkedin stays true with bridges on, so
  // the export connector is still scheduled and still polling, and the hint
  // carrying the drop path was the only place that path is written down.
  if (src.id === LINKEDIN_EXPORT_ID) {
    return hzConnectorFeature(featureSet, 'linkedin') === false;
  }
  if (isBridge(src)) return !hzFeatureOn(featureSet, 'bridges');
  // `=== false` and not a falsy test, deliberately: hzConnectorFeature answers
  // `undefined` for a connector the registry does not mention, and the daemon
  // LEAVES SUCH A MODULE ALONE (connectorsDisabledBy). A row whose kind is
  // unknown here is one the daemon is scheduling and ingesting, so hiding it
  // would draw the owner a shelf that disagrees with what the machine is doing.
  return hzConnectorFeature(featureSet, connectorOf(src.id)) === false;
}
/// Offered, but the owner has to ask for it. Labelled on the tile so "not
/// connected" does not read as "broken" for a source nothing auto-starts.
function isOptionalSource(src) {
  return !isBridge(src) && hzConnectorFeature(featureSet, connectorOf(src.id)) === 'optional';
}
// Status returns one real row per authorized mailbox plus a synthetic `mail`
// row for starting another grant. Once a real account exists, its card owns
// "+ add account"; leaving the synthetic grey tile visible makes a successful
// sign-in look unfinished. Carry its client choices onto the real rows before
// hiding it so adding another account keeps the base client-selection logic.
function visibleSources(sources) {
  const addGoogle = sources.find((s) => s.id === 'mail');
  const hasGoogleAccount = sources.some(
    (s) => s.connected && typeof s.id === 'string' && s.id.startsWith('mail:')
  );
  const shown = sources
    .filter((s) => !isHiddenSource(s) && !(hasGoogleAccount && s.id === 'mail'))
    .map((s) => s.id.startsWith('mail:')
      ? { ...s, clients: addGoogle && Array.isArray(addGoogle.clients) ? addGoogle.clients : [] }
      : s);
  // TWO LINKEDIN TILES, WHEN BOTH FLOWS ARE REALLY RUNNING — and then they have
  // to say which is which. With `bridges` on and `connectors.linkedin` true the
  // bridge logs in and the export connector polls the import folder, so both
  // are work the owner can act on and both carry the label "LinkedIn" from
  // connect/lib/status.mjs. Only rename them when both survive the filter: with
  // bridges off there is a single tile and "(export)" is noise on it.
  const bridgeRow = shown.find((s) => s.id === 'linkedin');
  const exportRow = shown.find((s) => s.id === LINKEDIN_EXPORT_ID);
  if (!bridgeRow || !exportRow) return shown;
  return shown.map((s) => {
    if (s.id === 'linkedin') return { ...s, label: `${s.label} (bridge)` };
    if (s.id === LINKEDIN_EXPORT_ID) return { ...s, label: `${s.label} (export)` };
    return s;
  });
}
// Google sign-in is intentionally parked while its authorization path is not
// ready to ship. Keep its normal tile so people can discover it, but mute it
// before the card says "coming soon" — a bright Google mark read as available.
// Only the synthetic `mail` tile is greyed; a previously connected `mail:<…>`
// account remains a normal, usable source.
const SOON_CONNECTORS = new Set(['mail']);
// WHAT NEEDS YOU COMES FIRST. The shelf scrolls, so anything past the fourth
// tile is work to reach — and the tiles that need reaching are exactly the
// ones not yet connected or broken. Those lead; everything healthy follows in
// the scan order below. The consequence is deliberate: connect something and
// it MOVES, out of the way, which is the shelf telling you it is done.
// ~~`|| !!s.caveat` was the third term~~ — dropped (owner, 2026-08-25):
// WhatsApp carries a PERMANENT disclosure caveat ("only as fresh as the last
// time WhatsApp Desktop ran"), so a freshly connected WhatsApp sat pinned at
// the front forever, which is the exact opposite of the move-out-of-the-way
// promise above. A standing disclosure is not a call to action.
const needsYou = (s) => !s.connected || s.pending === true;
function orderSources(sources) {
  const rank = (s) => {
    const i = CONNECTOR_ORDER.indexOf(kindOf(s.id));
    return i === -1 ? CONNECTOR_ORDER.length : i;
  };
  // Stable: equal ranks (the two mail accounts) keep the server's order.
  return sources.map((s, i) => ({ s, i }))
    .sort((a, b) =>
      (needsYou(b.s) - needsYou(a.s))
      || rank(a.s) - rank(b.s)
      || a.i - b.i)
    .map((e) => e.s);
}

// Fixed strings only — the widget reports states, it never invents them.
// THE ENGINE IS STARTING -- SAY SO, AND OFFER NOTHING TO PRESS.
//
// Two rewrites got this here. It first said "open Docker, then: bash
// ops/setup-bridges.sh", which was wrong three ways at once: it named a repo
// path a downloaded install does not have, it told the owner to run a script
// the app ALREADY runs itself (Provision.ensureBridgeRuntime shells the bundled
// copy on any nobridge), and it omitted the only fact that resolved the
// situation -- press the tile again once Docker was up. Then it kept the "open
// Docker" button while native became the default, sending native installs to a
// VM they had no use for.
//
// There is no Docker now, so there is no owner step left to offer. Every
// remedy this notice used to hand over is something the machine does: setup
// runs itself on a nobridge, launchd restarts a bridge that died, and the
// first run has a real download to finish before any of that is true. A
// button that cannot help is worse than no button, so this says what is
// happening and stops.
function hzNobridgeNotice(tip) {
  const line = document.createElement('span');
  // This hardcoded string is the one the card actually renders -- correcting
  // the NOTICES entry alone changed nothing, which is how the Docker wording
  // outlived two attempts to remove it.
  line.textContent = 'social connections are still starting up — this can take a few minutes the first time.';
  tip.append(line);
}

const NOTICES = {
  // Named separately from `down` because the state is different: `down` is
  // "cannot tell", this is "the engine is not up yet". It is not an
  // instruction any more -- ops/setup-bridges-native.sh runs itself and
  // launchd restarts what dies, so there is nothing here for the owner to do
  // but wait out the first-run download.
  nobridge: 'social connections are still starting up.',
  // The site refused to render a security step in an embedded window and the
  // owner pressed the handoff. Not a failure state: the connect page is open
  // in their browser, where that step does render.
  browserLogin: 'this step needs a real browser — the connect page just opened; finish signing in there, then press this again.',

  down: 'checking the local connection…',
  auth: 'token mismatch — status unknown',
  noroute: 'connect service predates /api/status — status unknown',
  error: 'checking connector status…',
  pending: 'finishing the sign-in…',
  // NOT AN EMPTY SHELF. A missing or malformed ops/features.json resolves to
  // everything-off — iMessage, mail, calendar and contacts included — so the
  // grid below renders nothing, which is pixel-for-pixel what a machine that
  // has connected nothing looks like. The one state the owner cannot diagnose
  // is the one where the app is entirely broken, so it gets its own sentence
  // and the alarm colour.
  registry: 'feature registry unreadable — reinstall, then restart the app. '
    + 'nothing can be connected until it is.',
  // A DIFFERENT SITUATION, AND DIFFERENT WORDS. The registry this page reads is
  // fine; the daemon that does the ingesting loaded the broken one at startup
  // and caches it for its whole process life (connectors/daemon.mjs resolves it
  // at module scope). Repairing the file clears the line above while nothing is
  // being scheduled, so the shelf would go quiet about a machine that reads
  // nothing at all. Telling the owner to reinstall here would be wrong — the
  // bundle is fine. The daemon has to go round again.
  registryStale: 'the connector service is still running on the old feature registry — '
    + 'restart the app.',
};

/// WHICH LINE THE OWNER IS OWED, and whether it is an alarm — one decision, so
/// that the colour cannot be left behind by a path that forgot to clear it.
///
/// It was: the registry path painted --status-bad and only the all-clear path
/// reset it, so a repaired registry followed by an ordinary "cannot reach
/// connect" rendered a routine, transient line in the alarm colour. The reset
/// belongs to the same place the set does.
///
/// `null` is "say nothing", which is the ordinary answer.
function noticeFor(data) {
  if (!data || data.state !== 'ok') {
    return { text: (data && NOTICES[data.state]) || NOTICES.error, alarm: false };
  }
  // The registry outage is drawn OVER a normal payload rather than instead of
  // one: the rows are fine, it is the answer about which of them this build
  // offers that is missing.
  if (data.registryState && data.registryState !== 'ok') {
    return { text: NOTICES.registry, alarm: true };
  }
  if (data.daemonRegistryState && data.daemonRegistryState !== 'ok') {
    return { text: NOTICES.registryStale, alarm: true };
  }
  return null;
}

// WKWebView never draws the native title-attribute tooltip, so the tile's
// name needs one of our own: a single shared element, fixed-position and
// moved under whichever tile is hovered or focused. Fixed because the shelf
// scrolls with overflow hidden — a tooltip inside the scroller would clip.
let tileTip = null;
function showTileTip(row, label) {
  // NOT OVER ITS OWN OPEN CARD.
  //
  // The card already names the source in its heading, so a floating label
  // repeating it is redundant -- and it is positioned over the shelf, which puts
  // it on top of the card. The way in is not hovering: `focus` shows this label
  // too (for keyboard use, which is worth keeping), and closing the login WINDOW
  // returns focus to the tile that opened it. So the owner clicked Messenger,
  // opened the login, closed it without signing in, and got a bare "Messenger"
  // label sitting on the Messenger card that was already open.
  //
  // Only this row's card is suppressed. Hovering a DIFFERENT tile while a card is
  // open still names it, which is the case the label exists for.
  const openCard = hintHost && hintHost.querySelector('.hint');
  if (openCard && openCard.dataset.id === row.dataset.id) return;
  if (!tileTip) {
    tileTip = document.createElement('div');
    tileTip.className = 'tile-tip';
    document.body.appendChild(tileTip);
    // Capture-phase so the shelf's own scroll hides a stale tooltip too.
    window.addEventListener('scroll', hideTileTip, true);
  }
  tileTip.textContent = label;
  tileTip.style.left = '0px'; // reset before measuring, or width lies
  tileTip.classList.add('on');
  const r = row.getBoundingClientRect();
  const w = tileTip.offsetWidth;
  const x = Math.min(Math.max(4, r.left + r.width / 2 - w / 2),
    window.innerWidth - w - 4);
  tileTip.style.left = `${x}px`;
  // Above the tile, not below (owner, 2026-08-25): the shelf lives at the
  // bottom of both panels, so a below-the-tile tip landed on the window's
  // bottom edge and clipped to its top half.
  tileTip.style.top = 'auto';
  tileTip.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
}
function hideTileTip() { if (tileTip) tileTip.classList.remove('on'); }

// Sources already refreshed once because the shelf disagreed with their own
// bridge. Module scope, so it survives the card rebuild that refresh() causes.
const staleRefreshed = new Set();
// A native login window can finish before /api/status reflects the new
// account. It can also return focus to Settings, whose refresh rebuilds every
// tile. Keep the transition by source id rather than on one DOM node so that a
// replacement tile still shows the waiting ring until a connected payload is
// actually rendered.
const bridgeWaitingSources = new Set();
function setBridgeWaiting(sourceId, waiting) {
  if (waiting) bridgeWaitingSources.add(sourceId);
  else bridgeWaitingSources.delete(sourceId);
  for (const live of grid.querySelectorAll('.row')) {
    if (live.dataset.id === sourceId) live.classList.toggle('logging-in', waiting);
  }
}
// A card begins its login once. renderBridge repaints on every bot reply and
// begin starts with `cancel`, so an unguarded auto-begin would cancel the
// conversation it opened. Keyed by source id, for the life of the page.
const autoBegun = new Set();
// A CONNECTED BRIDGE IS STILL A BRIDGE. The server sets `action: 'bridge'` only
// while a bridge is NOT connected (connect/lib/status.mjs), so keying the
// widget's routing off `action` sent every connected bridge to the generic
// connector card — the one that knows about local stores and external setup
// pages. That card says "connected" with nothing after it and offers no way to
// add a second account, which is what the owner saw the moment Slack linked
// (2026-08-26). Ask what the source IS, not what it currently needs doing to
// it: a platform this file knows a login flow for is a bridge, connected or
// not. BRIDGE_FLOW is that list.
const isBridge = (src) => src.action === 'bridge' || !!BRIDGE_FLOW[kindOf(src.id)];

function card(src, keep) {
  // Square tiles, four to a row. The old compact rows ruled out a 3-column
  // grid because every connection had to stay visible at once; at four
  // columns nine sources take three rows, so the constraint still holds.
  // The wrapper is display:contents, which lets the tile sit in its cell
  // while its hint spans the whole width on the line below.
  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  // aria-label, NOT title: the tile has no visible label at 40px so it needs
  // an accessible name, but `title` ALSO draws a native macOS tooltip in this
  // WKWebView — which double-showed under the custom .tile-tip (owner saw two
  // "Discord"s). aria-label names the tile for a screen reader and draws
  // nothing; showTileTip owns the visible hover label.
  row.setAttribute('aria-label', src.label);
  // Stamped so a strip and its tile can find each other by id across a
  // refresh() rebuild — refresh() hands a kept strip to the tile that
  // replaced its owner, and toggle() judges ownership by it.
  row.dataset.id = src.id;

  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.innerHTML = hzGlyph(src.id); // trusted static strings only
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = src.label;

  // Three states, not two. `off` is an empty slot — a source the owner has
  // never linked, which is a normal resting state and must stay quiet. `bad` is
  // a source that IS set up and cannot work: a revoked Full Disk Access grant,
  // a token that went unreadable. Drawing those two the same way, which is what
  // this line did until 2026-08-22, means a broken connector is indistinguishable
  // from one you simply never turned on — so nothing on the shelf ever asks for
  // help, and the owner finds out when an answer is quietly missing its source.
  const dot = document.createElement('span');
  dot.className = 'dot' + (src.connected && !src.pending ? ' on' : src.broken ? ' bad' : ' off');
  if (src.connected && !src.pending) bridgeWaitingSources.delete(src.id);
  else if (src.pending || bridgeWaitingSources.has(src.id)) row.classList.add('logging-in');

  // Greyed, and the dot goes with it: an off dot on a tile that cannot be
  // turned on is an invitation, and this tile is declining one.
  const soon = !src.connected && SOON_CONNECTORS.has(kindOf(src.id));
  if (soon) {
    row.classList.add('soon');
    dot.className = 'dot off';
  }

  // 'optional' in ops/features.json: a real participant source, small today,
  // offered but never auto-started — the daemon leaves it to the owner's own
  // Connect press. SAY SO ON THE TILE. Without the word, "not connected" on a
  // source the app will never start by itself reads as something that failed,
  // and the shelf's whole promise is that a tile tells you whose move it is.
  //
  // The label rides the tooltip rather than a new element: these tiles are
  // 4-to-a-row squares with the label already in the hover tip, and a second
  // line of text inside one would cost the grid its shape. dataset.optional is
  // for the tests and for anyone styling it later.
  const optional = isOptionalSource(src);
  if (optional) row.dataset.optional = 'true';
  const tipLabel = optional ? `${src.label} · optional` : src.label;

  row.append(mark, name, dot);

  row.addEventListener('mouseenter', () => showTileTip(row, tipLabel));
  row.addEventListener('mouseleave', hideTileTip);
  row.addEventListener('focus', () => showTileTip(row, tipLabel));
  row.addEventListener('blur', hideTileTip);

  // Every tile opens a hint. It has two sizes: the FIRST press of a kind
  // gets the hand-hold — why this connector matters, the privacy line, then
  // the how — and every press after that gets the compact strip. "First"
  // survives quitting: native remembers which kinds have been walked
  // through, so someone who connects two sources and comes back next week
  // is still hand-held on each of the others' first press.
  const hint = hintFor(src.id);
  // One strip element per tile, but only ever ONE in the document: opening a
  // tile moves its strip into the shared host below the row. Per-tile because
  // each closes over its own src and its own bridge state; shared host
  // because a horizontal shelf has nowhere to put a full-width strip.
  const tip = document.createElement('div');
  tip.className = 'hint';
  tip.dataset.id = src.id;

  // ONE panel, the same every time. There used to be two — a tall
  // first-press hand-hold with a "got it" button, then a compact strip on
  // every later press, with native remembering which kinds were walked
  // through. The owner merged them (2026-08-22): the full story is short
  // enough to always show, and the panel's corner x is the only dismiss.
  // WHERE A CONTROL TAKES YOU, SAID THE SAME WAY EVERY TIME.
//
// Connecting a source is not one flow, and it cannot be: Google refuses OAuth in
// an embedded webview, a QR code has to be big enough for a phone camera, and an
// API key is one text field that belongs right here. Three presentations is the
// honest answer.
//
// What was wrong is that a reader could not tell WHICH they were about to get.
// The same-looking button variously pasted a key in place, threw them into
// Chrome, or opened a second window over the panel. The `↗` marker already
// existed for "this leaves" and was on some of them and not others -- `full disk
// access` opened System Settings with no marker at all, and `log in` opened an
// app window with none either.
//
// So the marker is the contract, applied everywhere:
//
//   ↗   leaves the app: your browser, System Settings, another app
//   ⧉   opens a window belonging to this app, over the panel
//   —   no marker: it happens right here, in this panel
//
// And a busy label says which of the three is in flight rather than inventing a
// new verb per call site: `opening…` for the two that go somewhere,
// `connecting…` for the ones that do not.
// The in-panel walkthrough (owner, 2026-08-25): the whole connect flow
  // lives right here — open the site, make the credential, paste it back —
  // instead of handing the owner to the connect page. Shared, because two
  // connectors reach it by different routes now: granola through the plain
  // hint, telegram from inside its bridge branch (its api keys must exist
  // before its bot can be spoken to at all).
  // The LinkedIn export's own picker, shaped like onboarding's: one press, a
  // native file panel, and the answer said in the card the press came from.
  // Every branch native can return is answered — a cancel is silence, a zip and
  // an unrecognised header both have their own remedy, and "imported" without a
  // count would leave the owner wondering whether anything was read.
  const pickLinkedInExport = (button, tip) => {
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = 'opening…';
    const say = (line) => {
      let out = tip.querySelector('.setup-result');
      if (!out) {
        out = document.createElement('span');
        out.className = 'setup setup-result';
        tip.appendChild(out);
      }
      out.textContent = line;
      fitConnections();
    };
    hzPost('importLinkedIn')
      .then((out) => {
        if (!out || out.state === 'cancelled') return;
        if (out.state === 'ok') {
          const n = Number(out.connections || 0);
          say(n > 0 ? `${n.toLocaleString()} connections imported.` : 'imported.');
          button.textContent = 'replace';
          return;
        }
        // ~~"that's the zip — unzip it and choose Connections.csv from inside
        // it."~~ The zip IS what LinkedIn sends, and sending the owner off to
        // unpack it by hand was the app refusing the only file it had asked
        // for. Native takes Connections.csv out of the archive now (Bridge
        // extractConnections); the two answers left are the two real failures,
        // and only one of them has a remedy in it.
        if (out.reason === 'zip-connections') {
          say(`there is no Connections.csv anywhere in ${out.file || 'that zip'} — tick `
            + '"connections" when you request the export and it will be in the next one.');
          return;
        }
        if (out.reason === 'zip') {
          say("i couldn't open that zip.");
          return;
        }
        if (out.reason === 'columns') {
          say(`i don't recognise this file's columns — the first one is "${out.firstColumn}". `
            + 'i can only read the english export today.');
          return;
        }
        if (out.reason === 'newer') {
          say(`you already have a newer ${out.file} — i kept the one you have.`);
          return;
        }
        if (out.reason === 'duplicate') {
          const [first, second] = out.files || [];
          say(`"${first}" and "${second}" are both ${out.file} — choose one.`);
          return;
        }
        say("i couldn't read that file.");
      })
      .catch(() => say("i couldn't read that file."))
      .finally(() => {
        button.disabled = false;
        if (button.textContent === 'opening…') button.textContent = previous;
      });
  };

  const walkthrough = (hint) => {
    // lives right here — open the site, make a key, paste it — instead of
  // handing the owner to the connect page. hint.url is the door;
  // connectSecret (Bridge → POST /api/secret) is where the paste lands.
  const open = document.createElement('button');
  // PLAIN TEXT, not a pill (owner, 2026-08-26). Step 1 sits directly above
  // steps 2 and 3, which are plain lines — a bordered capsule with an arrow
  // on the first of three made it read as the card's primary control rather
  // than as the first line of a list. It is still a button: it does something,
  // and a span would lose the keyboard and the focus ring.
  open.className = 'step-open';
  open.textContent = `1 · open ${hint.link} ↗`;
  open.addEventListener('click', (e) => {
    e.stopPropagation();
    // The installed app first, the website only if it is not there —
    // openApp answers notInstalled rather than failing silently.
    if (hint.app) {
      hzPost('openApp', { bundleId: hint.app })
        .then((d) => {
          if (!d || d.state !== 'ok') hzPost('openExternal', { url: hint.url }).catch(() => {});
        })
        .catch(() => { hzPost('openExternal', { url: hint.url }).catch(() => {}); });
      return;
    }
    hzPost('openExternal', { url: hint.url }).catch(() => {});
  });
  const step2 = document.createElement('span');
  step2.className = 'setup';
  step2.textContent = `2 · ${hint.step2 || 'create an API key and copy it'}`;
  const paste = document.createElement('textarea');
  paste.className = 'bpaste';
  paste.placeholder = hint.paste || '3 · paste the key here';
  paste.setAttribute('spellcheck', 'false');
  const send = document.createElement('button');
  send.className = 'hold-ok';
  send.textContent = 'connect';
  const said = document.createElement('span');
  said.className = 'setup';
  send.addEventListener('click', (e) => {
    e.stopPropagation();
    const val = paste.value.trim();
    if (!val) return;
    paste.value = ''; // gone from the page before anything else happens
    send.disabled = true; send.textContent = 'connecting…';
    hzPost('connectSecret', { p: kindOf(src.id), value: val })
      .then((d) => {
        if (d && d.state === 'ok') { refresh(); return; }
        send.disabled = false; send.textContent = 'connect';
        said.textContent = (d && d.error) || 'could not save the key';
      })
      .catch(() => {
        send.disabled = false; send.textContent = 'connect';
        said.textContent = 'could not reach the connect service';
      });
  });
  tip.append(open, step2, paste, send, said);
  };

  const renderTip = () => {
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    tip.appendChild(head);
    // The privacy line sits under the NAME, not at the card's foot (owner,
    // 2026-08-25): it is the promise the whole card stands on, and at the
    // bottom it dangled under whatever the flow happened to end with.
    const stay = document.createElement('span');
    stay.className = 'stay';
    stay.textContent = STAY;
    tip.appendChild(stay);
    // A broken source states the problem BEFORE the WHY and the how-to. It is
    // the only thing on this panel the owner has to act on, and burying it
    // under an explanation of what Granola is would be the wrong order.
    if (src.disabled && src.action === 'enable') {
      // No sentence above the button (owner, 2026-08-25): "has not connected
      // this source yet" restated what the button already says.
      const enable = document.createElement('button');
      enable.className = 'hold-ok';
      enable.textContent = 'connect';
      enable.addEventListener('click', (e) => {
        e.stopPropagation();
        enable.disabled = true;
        enable.textContent = 'connecting…';
        hzPost('setConnectorEnabled', { connector: src.id, enabled: true })
          .then(refresh)
          .catch(() => { enable.disabled = false; enable.textContent = 'connect'; });
      });
      tip.appendChild(enable);
    } else if (src.broken && src.fix) {
      // Full Disk Access is not a failure, it is the setup step every local
      // store starts at — so it lost its red block (owner, 2026-08-25): the
      // alarm heading, the tinted panel, the red-outlined button, all of it.
      // Now it reads like every other not-yet-connected source: the steps in
      // plain text, then the same button style the rest of the panel uses.
      if (src.action === 'fda') {
        // ~~The written steps (src.fix) rendered above the button.~~ Yeeted
        // (owner, 2026-08-25): the button IS the walkthrough — it lands on the
        // exact Settings pane — and a paragraph of directions above it made
        // the panel read like homework. The server still sends the text; the
        // connect page still uses it.
        const open = document.createElement('button');
        open.className = 'hold-ok';
        open.textContent = 'full disk access ↗';
        open.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // The primed verb, not the bare pane URL: openFullDiskAccess
          // attempts a protected read first, which is what puts "intaglio
          // labs" in the pane's list ready to switch on (Permissions.swift
          // primeFullDisk carries the reasoning).
          hzPost('openFullDiskAccess').catch(() => {});
        });
        tip.appendChild(open);
      } else {
        // Everything else that is broken stays loud: red is for a thing that
        // worked and stopped, and those still exist.
        const bad = document.createElement('span');
        bad.className = 'broken';
        const what = document.createElement('b');
        what.textContent = src.detail || 'not working';
        bad.append(what, document.createTextNode(' ' + src.fix));
        tip.appendChild(bad);
      }
    } else if (src.connected) {
      // CONNECTED: one line naming what's connected, and a + to add another
      // account (owner). Mail carries the address in its id; the local stores
      // are one-per-Mac, so they just say "connected". "add account" opens
      // the hint's url — the external page where a second account is set
      // up — so the + shows only where the hint HAS a url (mail, granola,
      // notion), never on the one-Mac FDA stores. Oura's whole flow is
      // ops/oura-auth.mjs with no URL to reopen, so it gets no + either.
      const acct = document.createElement('span');
      acct.className = 'acct';
      acct.textContent = src.id.startsWith('mail:') ? src.id.slice(5) : 'connected';
      tip.appendChild(acct);
      // `hint.local` is the test, NOT src.action. action is only 'fda' while the
      // source is BROKEN, so a Messages store that was working showed "+ add
      // account" -- on a one-per-Mac store, wired to open the Full Disk Access
      // pane. The condition the comment above always described is a property of
      // the source, not of its current error state.
      // GOOGLE IS PARKED (owner, 2026-08-27). Sign-in reached a "Which Google
      // account?" picker -- a second small menu inside the panel, where every other
      // tile loads its login straight away -- and an inconsistent flow for a connector
      // that is not finished is not worth keeping wired. Both surfaces say the same
      // thing now. Nothing underneath is removed: startGoogleAuth, showClientChoice and
      // the OAuth path are intact, so this is a handful of conditions to delete when it
      // ships.
      if (GOOGLE_AUTH.has(kindOf(src.id))) {
        const soon = document.createElement('span');
        soon.className = 'setup';
        soon.textContent = 'coming soon. help us build it :)';
        tip.appendChild(soon);
      } else if (hint && hint.url && !hint.local) {
        const add = document.createElement('button');
        add.className = 'hold-ok add-acct';
        add.textContent = '+ add account';
        add.addEventListener('click', (e) => {
          e.stopPropagation();
          hzPost('openExternal', { url: hint.url }).catch(() => {});
        });
        tip.appendChild(add);
      }
    } else if (hint && hint.walkthrough) {
      walkthrough(hint);
    } else if (hint) {
      // Not connected: the one-sentence how-to to set it up.
      if (hint.text || hint.url) {
        const setup = document.createElement('span');
        setup.className = 'setup';
        if (hint.text) setup.append(hint.text + ' ');
        if (hint.url) {
          const a = document.createElement('a');
          a.href = '#';
          a.textContent = hint.link + ' ↗';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            hzPost('openExternal', { url: hint.url });
          });
          setup.appendChild(a);
        }
        tip.appendChild(setup);
      }
      // The cloud connectors are finished on the loopback connect page (paste
      // the token / app password there). Give it a door: the page opens from
      // the tokened link the connect server wrote, read natively — no repo, no
      // terminal, which is what a fresh install needs.
      // GOOGLE SIGNS IN FROM HERE, not from a page and never from a terminal.
      // Mail and Calendar are one Google account, and the grant is taken by
      // ops/gcal-auth.mjs, which opens Google in the browser and listens for
      // the callback itself. Pressing the tile starts exactly that (owner,
      // 2026-08-26: "when i click on the icon it should just open up the login
      // screen"). The connect page stays reachable underneath for the rows
      // that genuinely paste something, but Google is not one of them any more.
      if (GOOGLE_AUTH.has(kindOf(src.id))) {
        const soon = document.createElement('span');
        soon.className = 'setup';
        soon.textContent = 'coming soon. help us build it :)';
        tip.appendChild(soon);
      } else if (src.id === LINKEDIN_EXPORT_ID) {
        // THE SAME PICKER ONBOARDING USES. Native opens the file panel, checks
        // the anchor column before copying, and answers with what it found —
        // so the outcomes here are onboarding's outcomes, said in one line.
        const pick = document.createElement('button');
        pick.className = 'hold-ok';
        pick.textContent = 'choose the file';
        pick.addEventListener('click', (e) => {
          e.stopPropagation();
          pickLinkedInExport(pick, tip);
        });
        tip.appendChild(pick);
      } else if (CONNECT_PAGE.has(kindOf(src.id))) {
        const open = document.createElement('button');
        open.className = 'hold-ok';
        open.textContent = 'open the connect page ↗';
        open.addEventListener('click', (e) => {
          e.stopPropagation();
          hzPost('openConnectLink').catch(() => {});
        });
        tip.appendChild(open);
      }
    }
  };

  // Keep the anchored card visible while the supported system-browser OAuth
  // flow is in progress. The native reply means the browser opened; the token
  // file and the focus refresh remain the source of truth for completion.
  const startGoogleAuth = (button, client) => {
    button.disabled = true;
    button.textContent = 'opening…';
    hzPost('googleAuth', { flow: 'google', client })
      .then((r) => {
        if (r && r.refused) {
          showTileNotice(row, src, r.refused);
          return;
        }
        button.disabled = false;
        button.textContent = r && r.opened
          ? 'finish in your browser…'
          : 'could not start — try again';
      })
      .catch(() => {
        button.disabled = false;
        button.textContent = 'could not start — try again';
      });
  };

  // The social bridges (Messenger/Instagram) log in INSIDE this popup —
  // owner's ask, spec in ops/WIDGET-BRIDGE-LOGIN-SPEC.md. The tap opens a
  // login panel in the tip strip instead of the plain hint: transcript from
  // the local bridge bot, a begin button, and a cookie paste box. The paste
  // goes to the loopback connect server once, is masked out of transcripts
  // server-side, and is never echoed, stored, or logged here — the textarea
  // is cleared the moment it is sent.
  // A successful link has to repaint the SHELF, not just this strip. The
  // login window closing fires the focus-refresh before the cookies POST has
  // finished writing, so that refresh reads connected:false and the dot
  // stays grey while the account is plainly linked — the owner's "why isn't
  // it green". Re-reading status on the success we can actually see closes
  // the race from the only side that knows.
  // ~~A once-only flag, pre-set to true on the adopt path to stop a refresh
  // loop.~~ It stopped the loop by stopping the SECOND refresh too, and the
  // second is the one that matters: a bridge whose login finishes after the
  // shelf last rendered (X, whose PIN step lands minutes later) reported
  // "connected · content_printer" in the panel while its tile kept a grey dot
  // (owner, 2026-08-25).
  //
  // The staleness test replaces it and cannot loop by construction: it fires
  // only when the panel knows connected and the TILE's own row does not, and
  // one refresh makes that false. No flag to get stuck.
  // One automatic login attempt per card. Set by the branch below rather than
  // reset per render, because renderBridge runs several times for one card.
  let autoBegun = false;
  const renderBridge = (data) => {
    // ONCE PER SOURCE, and the bound is the whole design. The bare staleness
    // test loops: refresh() rebuilds the shelf, the rebuilt tile adopts the
    // strip, the strip re-reads "connected", and if the status row still
    // disagrees it refreshes again — 108k times in a harness that held the
    // disagreement still (2026-08-25). The shelf and the bridge read the same
    // database, so one refresh is enough to reconcile them; a second would
    // mean the server is answering differently from itself, and hammering it
    // is not how that gets fixed.
    if (data && data.connected && !src.connected && !staleRefreshed.has(src.id)) {
      staleRefreshed.add(src.id);
      refresh();
    }
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    tip.appendChild(head);
    // The privacy line sits under the NAME, not at the card's foot (owner,
    // 2026-08-25): it is the promise the whole card stands on, and at the
    // bottom it dangled under whatever the flow happened to end with.
    const stay = document.createElement('span');
    stay.className = 'stay';
    stay.textContent = STAY;
    tip.appendChild(stay);

    // The connect service can be alive while its first status request loses a
    // short race with launch or Docker waking up. A one-shot `down` result was
    // rendered as "service unreachable" and stayed there even after Discord
    // had already generated a valid QR. Re-poll the local service while this
    // card remains open; stop after a bounded window and leave an explicit
    // retry rather than asserting that the service is dead.
    const transientStatus = data && !data.transcript
      && (data.state === 'down' || data.state === 'error');
    if (transientStatus) {
      const say = document.createElement('span');
      say.className = 'setup';
      say.textContent = 'checking the local connection…';
      const retry = document.createElement('button');
      retry.className = 'hold-ok';
      retry.textContent = 'retry now';
      const pollStatus = () => {
        hzPost('bridgeStatus', { p: kindOf(src.id) })
          .then((next) => renderBridge(next))
          .catch(() => { say.textContent = 'still starting — retry when ready'; });
      };
      retry.addEventListener('click', (e) => { e.stopPropagation(); pollStatus(); });
      tip.append(say, retry);
      let tries = 0;
      const tick = () => {
        if (!tip.isConnected || ++tries > 10) {
          if (tries > 10) say.textContent = 'still starting — retry when ready';
          return;
        }
        hzPost('bridgeStatus', { p: kindOf(src.id) })
          .then((next) => {
            if (next && !next.transcript && (next.state === 'down' || next.state === 'error')) {
              setTimeout(tick, 2000);
            } else {
              renderBridge(next);
            }
          })
          .catch(() => setTimeout(tick, 2000));
      };
      setTimeout(tick, 2000);
      return;
    }

    // ~~The whole bot transcript rendered as a grey log.~~ Yeeted (owner,
    // 2026-08-25: "don't show that shit on any of the connectors"). It was a
    // machine conversation shown verbatim: the bridge's cookie-format example,
    // its "Login URL:" echo, its cancel acknowledgements — noise that read as
    // an error even while the login was succeeding. What the owner actually
    // needs is the bot's LAST question, which is the only line that ever asks
    // for anything (X's PIN prompt is exactly this). One line, plain, no log.
        // mautrix builds this prompt by gluing "Please enter your " onto the
        // field's own name, so X's arrives as "Please enter your Create your
        // PIN code" — two verbs, one sentence (owner, 2026-08-25). Unglue it,
        // so the card asks one clear thing.
        //
        // ~~and name the platform~~ — the " for <label>" suffix is gone
        // (owner, 2026-08-26). The card's own header is the platform's name in
        // bold two lines up, so "please enter your Phone number for Telegram"
        // said Telegram twice and please once more than anyone needs. It is an
        // instruction on a card that is already about one service.
        //
        // The field keeps mautrix's capitalisation EXCEPT its first word, and
        // only when that word is not an acronym: "Phone number" reads as
        // shouted mid-sentence, while PIN is how the thing is spelled.
        const uncap = (t) => (/^[A-Z]{2,}\b/u.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));
        const tidy = (line) => {
          const m = /^please enter your\s+(.+)$/iu.exec(line);
          if (!m) return line;
          const field = m[1].replace(/\.$/u, '').trim();
          const verb = /^(create|enter|choose|register)\b/iu.exec(field);
          if (verb) {
            const rest = field.slice(verb[0].length).trim();
            return `${verb[0].toLowerCase()} ${uncap(rest)}`;
          }
          return `enter your ${uncap(field)}`;
        };
    // BEGIN'S OWN ECHOES. beginLogin sends set-management-room, cancel and the
    // login verb before anything a person did, so three of the bot's replies
    // are always answers to the machine. They are not news and must not be
    // mistaken for the bot's last word.
    const BOT_NOISE = /^(this room (is already|has been marked)|login cancelled|no ongoing command)/iu;
    // The last thing the bot actually said to the OWNER, question or not.
    const botSaid = () => {
      for (const m of [...((data && data.transcript) || [])].reverse()) {
        if (m.from !== 'bot') continue;
        const body = String(m.body || '').trim();
        if (!body || body.startsWith('Login URL:') || body.includes('`{')) continue;
        if (BOT_NOISE.test(body)) continue;
        return body;
      }
      return null;
    };
    // A REJECTED VALUE IS NOT THE END OF THE STEP. mautrix answers a malformed
    // answer by complaining and waiting for another — the step stays open — so
    // this is the one "not a question" that must keep the box on screen.
    // A test number went in without its country code, the bot said "Invalid
    // value: phone number must start with +", and the card threw that away and
    // offered to start over (2026-08-26). The single most useful line on the
    // screen was the one being discarded.
    const RETRYABLE = /^invalid\b|must start with|not a valid|please try again/iu;
    // The last thing the bot ASKED, wherever it is in the window — which is one
    // message further back when a complaint sits on top of it.
    const lastQuestion = () => {
      for (const m of [...((data && data.transcript) || [])].reverse()) {
        if (m.from !== 'bot') continue;
        const body = String(m.body || '').trim();
        if (!body || body.startsWith('Login URL:') || body.includes('`{')) continue;
        if (BOT_NOISE.test(body)) continue;
        const ask = body.split('\n').map((l) => l.trim()).filter(Boolean)
          .find((l) => l.endsWith('?') || /^(please|enter|register|create|choose)\b/iu.test(l));
        if (ask) return tidy(ask);
      }
      return null;
    };
    const askedFor = () => {
      if (!(data && Array.isArray(data.transcript))) return null;
      for (let i = data.transcript.length - 1; i >= 0; i--) {
        const m = data.transcript[i];
        if (m.from !== 'bot') continue;
        // The example blob and the URL echo are instructions to a machine, not
        // to a person; the last real prompt is behind them.
        const body = String(m.body || '').trim();
        if (!body || body.startsWith('Login URL:') || body.includes('`{')) continue;
        // Keep it to the sentence that asks, not the paragraph around it.
        // A QUESTION, or nothing. ~~Fell back to the bot's first line.~~ That
        // made any chatter look like a pending step: after the engine
        // restarted under a half-finished login, the bot answered the PIN
        // with "Unknown command, use the `help` command" — no login was in
        // progress any more — and the panel dutifully offered a box to answer
        // it with (owner, 2026-08-25). No prompt means no pending step, which
        // is exactly when the log in button should come back.
        const ask = body.split('\n').map((l) => l.trim()).filter(Boolean)
          .find((l) => l.endsWith('?') || /^(please|enter|register|create|choose)\b/iu.test(l));
        return ask ? tidy(ask) : null;
      }
      return null;
    };
    // A rejected answer leaves the bridge on the same step. In that state the
    // newest bot line is the error and the question is one line behind it.
    // Treat both shapes as one pending prompt so closing/reopening the card —
    // or retrying a wrong X Chat passcode — never turns into a fresh login.
    const pendingQuestion = () => {
      // The local service knows which bridge prompts its fenced web login
      // fulfils automatically. In particular LinkedIn's bot asks for cookies
      // or a copied cURL command; that is an implementation detail, never a
      // form the person should see. Preserve the local parser only for an old
      // service during an app update.
      if (data && Object.prototype.hasOwnProperty.call(data, 'pendingQuestion')) {
        return typeof data.pendingQuestion === 'string' && data.pendingQuestion.trim()
          ? data.pendingQuestion.trim()
          : null;
      }
      return askedFor() || (RETRYABLE.test(botSaid() || '') ? lastQuestion() : null);
    };
    const xPasscodeStep = () => kindOf(src.id) === 'twitter'
      && /\b(pin|passcode)\b/iu.test(pendingQuestion() || '');
    const xPasscodeCopy = () => (/\bcreate\b/iu.test(pendingQuestion() || '')
      ? 'create a 4-digit X Chat passcode'
      : 'enter your 4-digit X Chat passcode');
    // A live QR in the transcript: the login is waiting to be scanned.
    const qrIn = (d) => ((d && d.transcript) || []).some(
      (m) => m.from === 'bot' && typeof m.image === 'string' && m.image.startsWith('data:image/')
    );
    // The bridge said the attempt ended. Its QR is redacted by then, so the
    // card must offer a fresh one rather than a conversation that is over.
    const expiredIn = (d) => {
      const last = [...((d && d.transcript) || [])].reverse().find((m) => m.from === 'bot' && m.body);
      return !!last && /error logging in|websocket|timed? out|cancelled/iu.test(last.body);
    };
    const appendTranscript = () => {
      const ask = pendingQuestion();
      if (ask) {
        const line = document.createElement('span');
        line.className = 'setup';
        line.textContent = xPasscodeStep() ? xPasscodeCopy() : ask;
        tip.appendChild(line);
        if (xPasscodeStep()) {
          const why = document.createElement('span');
          why.className = 'why x-passcode-help';
          why.textContent = 'This unlocks your encrypted DMs. It is not your X password or 2FA code.';
          tip.appendChild(why);
        }
      }
      // THE QR IS THE STEP, for Discord. Its login is remote-auth: the bot
      // posts a QR, you scan it with the phone app, and it redacts the image
      // when the attempt ends. The panel showed the words around it and not
      // the one thing to act on, so the websocket timed out unapproved
      // ("Error logging in: websocket: close sent", owner 2026-08-26).
      const shot = [...((data && data.transcript) || [])].reverse()
        .find((m) => m.from === 'bot' && typeof m.image === 'string'
                  && m.image.startsWith('data:image/'));
      if (shot) {
        const img = document.createElement('img');
        img.className = 'bqr';
        img.src = shot.image; // a data URI the server built; never composed here
        img.alt = 'login QR code';
        tip.appendChild(img);
        const how = document.createElement('span');
        how.className = 'setup';
        how.textContent = 'scan this with the app on your phone';
        tip.appendChild(how);
      }
    };
    // THE BOT CAN BE SLOWER THAN THE REQUEST THAT WOKE IT.
    //
    // relay() waits 9s for a reply and then returns whatever it has, which is
    // right for an HTTP handler and wrong for this card: painting that answer
    // unconditionally repaints the SAME question the owner just answered, and
    // reads as the send having done nothing. Telegram's phone step is exactly
    // the case — it goes out to Telegram, which sends a code to the app, and
    // that took longer than the wait; the bot's "Please enter your Code" was
    // sitting in the room while the card still said "please enter your Phone
    // number" (owner, 2026-08-26: "i entered my phone number, nothing
    // happened??").
    //
    // So: repaint only on an actual answer, and otherwise say we are waiting
    // and keep asking. Polling here costs nothing, where holding the request
    // open for 40s would tie up the connect service on every login step.
    // WHAT THE CONVERSATION LOOKED LIKE, not how long it was. The transcript
    // is the last SIXTEEN messages (readTranscript in lib/bridge.mjs), so once
    // it is full its length never changes again: a new bot line pushes an old
    // one off the front and the count stays 16. A `length > had` test is then
    // permanently false, and the card sits on "waiting for Telegram…" through
    // an answer that already arrived (owner, 2026-08-26: "i'm stuck here").
    // A signature of the window changes whenever anything shifts, full or not.
    const signature = (x) => ((x && x.transcript) || [])
      .map((m) => `${m.from}|${m.body || ''}`).join('\u0000');
    const settle = (d, had) => {
      const answered = (x) => !!x && (x.connected === true || signature(x) !== had);
      if (answered(d)) { renderBridge(d); return; }
      // THE WAIT IS THE WHOLE CARD, not a caption on a button. Leaving the
      // question and the filled-in box on screen under "waiting for
      // Telegram…" showed the owner a form to fill in that had already been
      // filled in and sent — an invitation to answer a question that is no
      // longer being asked (owner, 2026-08-26). Nothing here is actionable
      // until the bot speaks, so nothing here should look actionable.
      tip.replaceChildren();
      const head = document.createElement('b');
      head.textContent = src.label;
      const stay = document.createElement('span');
      stay.className = 'stay';
      stay.textContent = STAY;
      const say = document.createElement('span');
      say.className = 'setup';
      say.textContent = `waiting for ${src.label}…`;
      tip.append(head, stay, say);
      let tries = 0;
      const tick = () => {
        // The card was closed or replaced — nothing to paint into.
        if (!tip.isConnected) return;
        // ~30s on top of relay's own 9. Past that the answer is not coming,
        // and a card stuck on "waiting" forever is worse than one showing the
        // last thing that was true: repaint, so it can be retried.
        if (++tries > 15) { renderBridge(d); return; }
        hzPost('bridgeStatus', { p: kindOf(src.id) })
          .then((next) => {
            if (answered(next)) renderBridge(next);
            else setTimeout(tick, 2000);
          })
          .catch(() => setTimeout(tick, 2000));
      };
      setTimeout(tick, 2000);
    };
    // THE PLACEHOLDER FOLLOWS THE QUESTION, the same way the button's verb
    // does. One box serves every step of every bridge — a phone number, then
    // the code, then X's PIN, then Slack's email — so a single fixed string
    // has to be vague enough to fit all of them, and "type your answer" is
    // what that vagueness costs: it tells you nothing at the one moment a
    // FORMAT is the thing you are unsure about (owner, 2026-08-26, on the
    // phone step). The bot's own wording decides; anything it asks for that
    // has no obvious shape falls back to the vague line, which is the right
    // answer there.
    const answerHint = () => {
      const asked = pendingQuestion() || '';
      if (xPasscodeStep()) return '4-digit passcode';
      if (/\bphone\b/iu.test(asked)) return '+1 xxx xxx xxxx';
      // An ADDRESS looks like an address. "type your answer" under "enter your
      // email" is the box describing itself instead of the answer (owner,
      // 2026-08-26) — the same note that put "+1 xxx xxx xxxx" under the phone
      // question. The example is a real, public address on the owner's own
      // domain rather than the sort of example@example.com nobody reads.
      if (/\bemail\b/iu.test(asked)) return 'hi@intaglio.io';
      // A CODE IS A SHAPE, not a value. Telegram's is five digits, and x's
      // say "this many characters" without offering something typeable —
      // an example code would be the one hint a person could paste by
      // mistake (owner, 2026-08-26).
      // NOT X's PIN, which also contains the word "code" ("Please enter your
      // Create your PIN code"). That one is a secret the person CHOOSES, of a
      // length this file has never verified, so it keeps the vague line rather
      // than being told a shape that might be wrong.
      if (/\bcode\b/iu.test(asked) && !/\bpin\b/iu.test(asked)) return 'xxxxx';
      return 'type your answer';
    };
    // A one-line input that relays whatever the bot last asked for (a token,
    // a phone number, then the code) and re-renders with the bot's reply.
    const relayInput = (placeholder, multiline, secretPin = false) => {
      const asked = pendingQuestion() || '';
      const secretAnswer = secretPin || /\bpassword\b/iu.test(asked);
      const phoneAnswer = kindOf(src.id) === 'telegram' && /\bphone\b/iu.test(asked);
      const box = document.createElement(multiline ? 'textarea' : 'input');
      box.className = multiline ? 'bpaste' : 'binput';
      box.placeholder = placeholder;
      box.setAttribute('spellcheck', 'false');
      if (phoneAnswer && !multiline) {
        box.type = 'tel';
        box.inputMode = 'tel';
        box.autocomplete = 'tel';
        // Telegram requires an E.164 number. This audience is US-first, so
        // typing an ordinary local number supplies the country code on the
        // first keystroke. Starting with `+` remains untouched for every
        // other country, and clearing the field really leaves it empty.
        box.addEventListener('input', () => {
          if (box.value && !box.value.startsWith('+')) {
            box.value = `+1 ${box.value.trimStart()}`;
          }
        });
      }
      if (secretAnswer && !multiline) {
        box.type = 'password';
        box.autocomplete = secretPin ? 'off' : 'current-password';
      }
      if (secretPin && !multiline) {
        box.inputMode = 'numeric';
        box.maxLength = 4;
        box.pattern = '[0-9]{4}';
        box.setAttribute('aria-label', '4-digit X Chat passcode');
        box.addEventListener('input', () => {
          box.value = box.value.replace(/\D/gu, '').slice(0, 4);
        });
      }
      const send = document.createElement('button');
      send.className = 'hold-ok';
      // THE VERB FOLLOWS THE QUESTION. "create" is right for X's PIN, which is
      // being made rather than sent (owner, 2026-08-25) — and wrong for Slack's
      // email address, which is being given (owner, 2026-08-26, looking at a
      // card that said "create" under "enter your email"). The bot's own
      // wording decides: it says "please create ..." when something is being
      // made, and anything else is an answer.
      //
      // ~~"send"~~ -> "continue" for that second case (owner, 2026-08-26).
      // "send" described the mechanism — a message going to a bot the owner
      // never asked to talk to — where the person is part-way through a login
      // and wants the next step. Every one of these questions has a step after
      // it, so the button says so.
      send.textContent = /\bcreate\b/iu.test(asked) ? 'create' : 'continue';
      const validation = document.createElement('span');
      validation.className = 'setup field-error';
      const fire = () => {
        const val = box.value.trim();
        if (!val) return;
        if (secretPin && !/^\d{4}$/u.test(val)) {
          validation.textContent = 'enter all 4 digits';
          box.focus();
          return;
        }
        validation.textContent = '';
        const busy = send.textContent === 'create' ? 'creating…' : 'sending…';
        const idle = send.textContent;
        send.disabled = true; send.textContent = busy;
        // What the conversation looked like BEFORE this answer, so the reply
        // can be told apart from the question it is answering.
        const had = signature(data);
        hzPost('bridgeCookies', { p: kindOf(src.id), cookies: val })
          .then((d) => {
            box.value = ''; // remove the secret before repainting the step
            settle(d, had);
          })
          .catch(() => { send.disabled = false; send.textContent = idle; });
      };
      send.addEventListener('click', (e) => { e.stopPropagation(); fire(); });
      if (!multiline) box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); fire(); }
      });
      tip.append(box, send);
      if (secretPin) tip.appendChild(validation);
    };
    const beginButton = (label) => {
      const begin = document.createElement('button');
      begin.className = 'hold-ok';
      begin.textContent = label;
      begin.addEventListener('click', (e) => {
        e.stopPropagation();
        begin.disabled = true; begin.textContent = 'starting…';
        hzPost('bridgeBegin', { p: kindOf(src.id) })
          .then(renderBridge)
          .catch(() => { begin.disabled = false; begin.textContent = label; });
      });
      tip.appendChild(begin);
    };
    const flow = BRIDGE_FLOW[kindOf(src.id)] || 'cookie';

    if (data && data.connected) {
      const acct = document.createElement('span');
      acct.className = 'acct';
      // NAME THE THING THAT IS CONNECTED, not the fact that something is
      // (owner, 2026-08-26). The dot on the tile already says connected; this
      // line is the only place that can say WHICH workspace, and with a second
      // account one press away it is about to be the thing that tells them
      // apart.
      //
      // mautrix hands back "<workspace> - <account email>" for Slack. The
      // address is the owner's own and they know it; the workspace is the
      // answer. Split on the LAST " - " and only when the tail is an address,
      // so a workspace whose own name contains a dash survives intact.
      const whole = String(data.name || '').trim();
      const cut = whole.lastIndexOf(' - ');
      const tail = cut > 0 ? whole.slice(cut + 3) : '';
      if (whole) {
        acct.textContent = (cut > 0 && tail.includes('@')) ? whole.slice(0, cut) : whole;
        tip.appendChild(acct);
      }
      hzAppendDiscordServers(
        tip, data, renderBridge,
        () => hzPost('bridgeStatus', { p: 'discord' }),
        (serverId, enabled) => hzPost('bridgeDiscordServer', { serverId, enabled })
      );
      // + add ANOTHER account: re-run the login. mautrix bridges hold more
      // than one login per user, so a second account lands alongside the
      // first rather than replacing it.
      const add = document.createElement('button');
      add.className = 'hold-ok add-acct';
      add.textContent = '+ add account';
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        openBridgeLogin();
      });
      tip.appendChild(add);
    } else if (data && data.state !== 'ok' && data.state !== 'cancelled'
               && data.state !== 'manual' && !data.transcript) {
      if (data.state === 'nobridge') { hzNobridgeNotice(tip); }
      else { tip.append(NOTICES[data.state] || data.error || NOTICES.error); }
    } else if (flow === 'cookie' && !(data && data.state === 'manual')) {
      // PRIMARY, Beeper-style: one button opens the platform's real login page
      // in a Intaglio Labs-framed window; native harvests the session cookies. No
      // devtools, no paste. See ops/WIDGET-WEBVIEW-LOGIN-SPEC.md.
      const login = document.createElement('button');
      login.className = 'hold-ok';
      login.textContent = 'log in ⧉';
      login.addEventListener('click', (e) => {
        e.stopPropagation();
        login.disabled = true; login.textContent = 'opening…';
        hzPost('bridgeWebLogin', { p: kindOf(src.id) })
          .then((data) => afterLoginAttempt(data, renderBridge))
          .catch(() => { login.disabled = false; login.textContent = 'log in ⧉'; });
      });
      // Only when the bot is NOT mid-question (owner, 2026-08-25): pressing
      // "log in" during the PIN step cancels the login and restarts it, so
      // offering it beside the question is offering to undo the progress the
      // question represents. The answer box below is the only way forward.
      if (!pendingQuestion()) tip.appendChild(login);
      // ~~A 'cancelled' state appended "login window closed — tap to try
      // again."~~ Yeeted (owner, 2026-08-25): the card already shows the same
      // log in button either way, and the sentence squeezed in beside the
      // pill saying what the owner just did themselves.
      appendTranscript();
      // A COOKIE LOGIN CAN HAVE A SECOND STEP, and until now this branch had
      // no way to answer one. X accepted the harvested cookies and advanced to
      // its encrypted-DM PIN (step fi.mau.twitter.login.juicebox_pin, owner
      // hit it 2026-08-25) — the bot asked, nothing on this card could reply,
      // and the login looked like it had failed when it had actually got
      // further than ever. The relay input is the same one the token/phone
      // flows use; it appears only when the bot is mid-conversation and not
      // yet connected, so the ordinary one-shot cookie login is unchanged.
      if (pendingQuestion() && !(data && data.connected)) {
        // The bot's question is already on screen directly above; the box only
        // has to say it is the place to answer it.
        relayInput(answerHint(), false, xPasscodeStep());
      }
      // The manual cookie-paste fallback ("having trouble? paste cookies
      // manually") was yeeted (owner, 2026-08-25): the webview login is the
      // flow, and a devtools-grade escape hatch under every login button made
      // the panel read as if the button were expected to fail. bridgeCookies
      // stays in the bridge for the token/phone conversation below.
    } else {
      // TOKEN (discord/slack) and PHONE (telegram): a guided conversation with
      // the bridge bot, because these do not authenticate by cookie harvest.
      // begin sends the login command; then the input relays whatever the bot
      // asks for (a token, or a phone number and then the code).
      const help = BRIDGE_HELP[kindOf(src.id)];
      const started = data && data.transcript && data.transcript.length;
      // `needsAppCredential` is the SERVER's answer, read off the bridge's own
      // config — not a guess from this file. A build that shipped an app
      // credential has already configured Telegram, and showing the paste
      // walkthrough there would offer to overwrite a working pair with
      // whatever someone typed. Undeclared (every other platform) is
      // undefined, which is falsey, so this only ever gates the one that
      // declares it — granola's walkthrough is a plain hint and unaffected.
      const needsKeys = kindOf(src.id) !== 'telegram' || data?.needsAppCredential === true;
      // AND THE CHALLENGE STEP OPENS THE WINDOW. Slack answers an email address
      // with "complete the embedded challenge to continue" and a Login URL: the
      // one step in this conversation that cannot be typed into a box, because
      // what it wants is the receipt of a challenge a human passed. The button
      // opens the same fenced window every cookie login uses; BridgeLogin polls
      // for the token reCAPTCHA writes when the owner passes it, and sends that
      // as the answer to this pending question.
      //
      // Matched on the bot's own words rather than on policy the card does not
      // hold. Deliberately narrow: two independent markers, so an unrelated
      // sentence mentioning a captcha does not put a login window on screen.
      const wantsChallenge = () => {
        if (!(data && Array.isArray(data.transcript))) return false;
        const bot = data.transcript.filter((m) => m.from === 'bot');
        // THE LAST LINE IS NOT THE ONE THAT ASKS. Slack's bot answers an email
        // address with two messages, in this order:
        //
        //   "Slack requires a CAPTCHA before it can email the confirmation
        //    code. Complete the embedded challenge to continue."
        //   "Login URL: <https://slack.com/signin>"
        //
        // so testing bot[last] for the word never matched, and the card showed
        // no way to answer a question the bridge was actively holding (owner,
        // 2026-08-26: "i'm just waiting for slack?"). Both markers are looked
        // for across the same recent window; still two independent markers, so
        // a stray sentence mentioning a captcha cannot summon a login window.
        const recent = bot.slice(-3).map((m) => String(m.body || '')).join(' ');
        return /captcha|challenge/i.test(recent) && /Login URL:|embedded/i.test(recent);
      };
      if (wantsChallenge() && !(data && data.connected)) {
        const answer = document.createElement('button');
        answer.className = 'hold-ok';
        answer.textContent = 'answer the check ↗';
        answer.addEventListener('click', (e) => {
          e.stopPropagation();
          answer.disabled = true; answer.textContent = 'opening…';
          hzPost('bridgeWebLogin', { p: kindOf(src.id) })
            .then((data) => afterLoginAttempt(data, renderBridge))
            .catch(() => { answer.disabled = false; answer.textContent = 'answer the check ↗'; });
        });
        tip.appendChild(answer);
      }
      if (!started && hint && hint.walkthrough && needsKeys) {
        // Telegram cannot begin at all until the owner's own api_id/api_hash
        // are in its bridge config — the container refuses to start on the
        // example pair mautrix ships, so "begin login" sat on "starting…"
        // with no bot on the other end (owner, 2026-08-25). Its walkthrough
        // comes first; once the keys land the bot answers and this branch
        // gives way to the ordinary phone-code conversation.
        walkthrough(hint);
      } else if (!started) {
        // ONE PRESS, NOT TWO (owner, 2026-08-26: "as soon as i press slack it
        // should automatically open up the login page"). A fresh card offered
        // `begin login`, which is a button whose only meaning is the press that
        // already happened — the tile press IS "log me in". The no-window
        // bridges got this in d88e56c, natively; Slack reaches its card by a
        // different road (its window is a step inside the conversation, not the
        // way in) and arrived at the same dead button.
        //
        // ONCE PER SOURCE PER CARD. renderBridge repaints on every reply, and
        // begin's first act is `cancel` — an unguarded call here would cancel
        // the login it just started, on its own repaint. The flag is the same
        // shape as staleRefreshed above and for the same reason.
        //
        // The button is still built, and it is what a FAILURE falls back to:
        // if begin cannot reach the bot, the card must offer the retry rather
        // than sit blank.
        if (autoBegun.has(src.id)) {
          beginButton('begin login');
        } else {
          autoBegun.add(src.id);
          const starting = document.createElement('span');
          starting.className = 'setup';
          starting.textContent = 'starting…';
          tip.appendChild(starting);
          hzPost('bridgeBegin', { p: kindOf(src.id) })
            .then(renderBridge)
            .catch(() => renderBridge(data));
        }
      } else if (qrIn(data)) {
        // A QR LOGIN ANSWERS WITH A PHONE, NOT A KEYBOARD. Discord posts the
        // code, the phone app scans it, and the bridge completes on its own —
        // so this card shows the image and nothing to type into. Offering a
        // box here produced "enter scan the QR with your Discord phone app"
        // above an empty field, which is an instruction to do the impossible
        // (owner, 2026-08-26).
        appendTranscript();
      } else if (expiredIn(data)) {
        // The QR is REDACTED the moment the attempt ends, so a card reopened
        // after one timed out has the words and not the code. Start over is
        // the only move ~~and saying so beats a stale conversation~~.
        //
        // The saying-so is withdrawn (owner, 2026-08-26). The card printed
        // "that code expired — start again and scan it promptly" above the
        // button, which reads as a reprimand for something that is not the
        // person's doing — Discord's remote-auth code has a short life and
        // reopening the panel after it lapses is ordinary. There is exactly
        // one move available and the button already is it. The BRANCH stays:
        // it is what swaps a dead conversation and its input box for a fresh
        // start, which is the part that was actually load-bearing.
        beginButton('begin login');
      } else if (wantsChallenge()) {
        // ALREADY HANDLED ABOVE, and this branch must not also run. A pending
        // challenge is a live login, so the "no prompt means no pending step"
        // rule below reads it wrong: the bot's last line is a URL and its
        // question is a sentence that does not end in a question mark, so
        // askedFor() returns null and the card offered `begin login` — a button
        // whose first act is `cancel`, beside the step it would cancel.
        appendTranscript();
      } else if (!askedFor() && RETRYABLE.test(botSaid() || '')) {
        // The step is still open: show what was asked, what was wrong with the
        // answer, and a box to answer it again.
        const q = lastQuestion();
        if (q) {
          const say = document.createElement('span');
          say.className = 'setup';
          say.textContent = q;
          tip.appendChild(say);
        }
        const why = document.createElement('span');
        why.className = 'setup';
        why.textContent = botSaid(); // server-masked; text only, never HTML
        tip.appendChild(why);
        relayInput(answerHint(), false);
      } else if (!askedFor()) {
        // NO PROMPT MEANS NO PENDING STEP — askedFor()'s own rule, from
        // 2026-08-25, when a bot answered a half-finished login with "Unknown
        // command" and the panel offered a box to answer it with. A FINISHED
        // conversation still counts as `started`, so without this the card
        // showed an input under a bot that had stopped asking anything.
        //
        // ~~beginButton('begin login')~~ — the card starts the login itself
        // (owner, 2026-08-26: "this page should start on the enter phone
        // number"). A press on an unconnected tile already means "log me in";
        // making the first thing it produces a button that means "log me in"
        // was a press charged for nothing.
        //
        // AND THIS IS WHERE THE DECISION BELONGS, not in Swift. ~~The native
        // side ran begin on every press~~ (d88e56c), which cancels and
        // restarts whatever login is in flight — so pressing the tile to look
        // at a login in progress destroyed it, and each press pushed six
        // command messages into a SIXTEEN-message window, scrolling the
        // owner's own answer out of view. Here the same test that decides
        // whether to show a question decides whether to ask for one, so a
        // conversation that is mid-flight is opened rather than restarted.
        //
        // Once per card, because a bridge that answers begin with no question
        // at all would otherwise loop.
        if (!autoBegun) {
          autoBegun = true;
          const say = document.createElement('span');
          say.className = 'setup';
          say.textContent = 'starting…';
          tip.appendChild(say);
          hzPost('bridgeBegin', { p: kindOf(src.id) })
            .then(renderBridge)
            .catch(() => { say.textContent = NOTICES.down; });
        } else {
          beginButton('begin login');
        }
      } else {
        appendTranscript();
        // The bot is waiting for the next thing. Token pastes want room;
        // a phone number or a code is one short line.
        //
        // The ask goes ABOVE the box, not inside it (owner, 2026-08-25): a
        // placeholder is clipped by the input's own width — "enter phone
        // (+1…), then the code" showed as "enter phone (+1…), t" — and it
        // vanishes the moment typing starts, which is exactly when someone
        // rereads it.
        // OUR line only when the bot has not asked in its own words. Both at
        // once printed the same instruction twice — "please enter your Email
        // for Slack" directly above "enter your Slack email address" (owner,
        // 2026-08-26). The bot's wording wins; ours is the fallback for a
        // step that arrives without a question.
        if (!askedFor() && help && help.place) {
          const say = document.createElement('span');
          say.className = 'setup';
          say.textContent = `enter ${help.place}`;
          tip.appendChild(say);
        }
        // Why a platform is asking for something odd, before it asks. A
        // flow that differs from its neighbours without saying why reads as
        // broken rather than as constrained.
        if (help && help.why) {
          const why = document.createElement('span');
          why.className = 'setup';
          why.textContent = help.why;
          tip.appendChild(why);
        }
        // Where to find them, for the flows whose values live somewhere the
        // owner has to go and look.
        if (help && help.steps) {
          const how = document.createElement('span');
          how.className = 'setup';
          how.textContent = help.steps;
          tip.appendChild(how);
        }
        relayInput(answerHint(), flow === 'token');
      }
    }
  };

  const openBridge = () => {
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    tip.append(head, 'checking…');
    hzPost('bridgeStatus', { p: kindOf(src.id) })
      .then(renderBridge)
      .catch(() => renderBridge({ state: 'down' }));
  };

  // Owner's ask (2026-08-22): opening the login must NOT flash the side panel
  // with a transitional "opening login…". Instead the tile's own status dot
  // spins in place while the native login window opens. The panel opens only
  // once there is a RESULT to show (linked, an error, or the login window
  // closed) — that is the "details" the owner said should still appear.
  const showBridgePanel = (data) => {
    // A RESULT CAN OUTLIVE ITS TILE. The focus-refresh rebuilds the shelf
    // (coming back from copying tokens fires it every time), so by the time a
    // slow login promise lands, this closure's row can be a detached node. It
    // still accepted the append: the card entered the live host anchored to a
    // row no document query can find, hzPlacePop's null-anchor guard skipped
    // placement, and the owner got a clipped card floating over the settings
    // column (owner, 2026-08-26, after pressing x on Slack's card). The live
    // tile re-derives everything in this card from status on its next tap, so
    // a result held by a dead closure is ~~dropped, not re-homed~~ RE-HOMED to
    // the live tile with the same id.
    //
    // Dropping was right about the hazard and wrong about the cost, because a
    // detached row is not evidence of a stale result. The FIRST press into an
    // unfocused panel detaches it every time: that click both focuses the
    // window (which fires refresh, which rebuilds the shelf) and hits the
    // tile, so the reply lands holding a row the rebuild has already replaced.
    // Measured in a harness — one grid rebuild, row.isConnected false, no card
    // — and it is exactly the "first tap does nothing, I have to press it
    // again" the owner reported on 2026-08-26 and had seen "for other icons
    // too": every bridge tile behaves this way.
    //
    // Re-homing keeps the invariant that mattered — never append a card
    // anchored to a node no document query can find, which is what left a
    // clipped card floating over the settings column — while charging nobody a
    // press for it. The id is what identifies a tile across a rebuild;
    // everything this card renders comes from `data`, which is fresh.
    const live = row.isConnected
      ? row
      : grid.querySelector(`.row[data-id="${CSS.escape(src.id)}"]`);
    if (!live) return; // the source really is gone from the payload
    hintHost.replaceChildren();
    for (const r of grid.querySelectorAll('.row')) r.classList.remove('open');
    hintHost.appendChild(tip);
    live.classList.add('open');
    renderBridge(data);
  };
  const openBridgeLogin = () => {
    if (bridgeWaitingSources.has(src.id)) return;
    setBridgeWaiting(src.id, true);
    hzPost('bridgeWebLogin', { p: kindOf(src.id) })
      .then((data) => {
        // Connected → renderBridge refreshes the shelf (dot goes green) and
        // shows the account name. Not connected → the panel shows the
        // result/retry. Cancelled → nothing at all: see afterLoginAttempt. This
        // is the path a TILE PRESS takes, and it was the one still putting the
        // card up after the window was shut.
        settleWebLogin(kindOf(src.id), data, showBridgePanel, (final) => {
          // A connected result retains the ring through refresh(); card() clears
          // it only when the shelf itself renders connected. Every other result
          // is terminal without a green state, so restore the ordinary dot now.
          if (!(final && final.connected)) setBridgeWaiting(src.id, false);
        });
      })
      .catch(() => {
        setBridgeWaiting(src.id, false);
        showBridgePanel({ state: 'down' });
      });
  };
// WHICH GOOGLE CLIENT TO SIGN IN WITH, asked only when there is more than one.
// Built from the same pieces a hint card is, so it closes the same way and
// needs no CSS of its own.
function showClientChoice(row, src) {
  closeHint();
  const tip = document.createElement('div');
  tip.className = 'hint';
  tip.dataset.id = src.id;
  tip.classList.add('hold');
  const head = document.createElement('b');
  head.textContent = 'Which Google account?';
  const why = document.createElement('span');
  why.className = 'why';
  why.textContent = 'A work account keeps its sign-in indefinitely. Any other Google '
    + 'account uses the shared app, which has a limited number of sign-ins.';
  tip.append(head, why);
  for (const c of src.clients) {
    const b = document.createElement('button');
    b.className = 'hold-ok';
    b.textContent = c.label === 'default' ? 'work account ↗' : `${c.label} ↗`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      b.disabled = true;
      b.textContent = 'opening…';
      hzPost('googleAuth', { flow: 'google', client: c.name })
        .then((r) => {
          if (r && r.refused) {
            showTileNotice(row, src, r.refused);
            return;
          }
          b.disabled = false;
          b.textContent = r && r.opened ? 'finish in your browser…' : `${c.label} ↗`;
        })
        .catch(() => { b.disabled = false; b.textContent = `${c.label} ↗`; });
    });
    tip.appendChild(b);
  }
  hintHost.appendChild(tip);
  row.classList.add('open');
}

// A one-line notice in the hint strip, for something that happened OUTSIDE
// this panel and left no other trace — today only a Google sign-in Google
// refused. Built from the same pieces a hint card is so it closes the same way.
function showTileNotice(row, src, text) {
  closeHint();
  const tip = document.createElement('div');
  tip.className = 'hint';
  tip.dataset.id = src.id;
  tip.classList.add('hold');
  // The same pieces a hint card is built from — a bold label and a .why line.
  // Inventing classes for this would mean inventing the CSS too, and a notice
  // that renders unstyled is a notice that reads as a rendering fault.
  const head = document.createElement('b');
  head.textContent = src.label;
  const body = document.createElement('span');
  body.className = 'why';
  body.textContent = text;
  tip.append(head, body);
  hintHost.appendChild(tip);
  row.classList.add('open');
}

  // The whole card for a not-yet-shipping tile. A function because the kept
  // strip at the end of card() re-renders after every refresh() and would
  // otherwise fall through to renderTip and show a walkthrough for a
  // connector the shelf has just said is not available.
  const renderSoon = () => {
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    const say = document.createElement('span');
    say.className = 'setup';
    say.textContent = 'coming soon. help us build it :)';
    tip.append(head, say);
  };

  const toggle = () => {
    // One strip at a time, by construction now: the host holds exactly one
    // child, so opening a tile evicts whatever was there. Ownership is
    // judged by id, not node identity: after a refresh() rebuild the open
    // strip can be an OLD tile's node adopted by this one (end of card()),
    // and the first tap on an open tile must close it, never relaunch it.
    const open = hintHost.querySelector('.hint');
    const wasOpen = open !== null && open.dataset.id === src.id;
    hintHost.replaceChildren();
    for (const r of grid.querySelectorAll('.row')) r.classList.remove('open');
    if (!wasOpen) {
      // BEFORE ANY LOGIN PATH. This tile's whole behaviour is the card, so it
      // must not fall through to openBridgeLogin and start a bridge
      // conversation nobody can finish.
      if (soon) {
        renderSoon();
        hintHost.appendChild(tip);
        row.classList.add('open');
        return;
      }
      // Unconnected social bridge: DON'T open the panel — the login spins the
      // tile dot and the panel opens later, only when there's a result
      // (openBridgeLogin owns that). Everything else opens the panel now:
      // attach BEFORE rendering, because the async bridge/status openers paint
      // into this node when their promise lands.
      // THE WINDOW IS THE ENTRY POINT only where it is the whole login. That
      // is true for a cookie harvest and Discord's remote-auth QR: Discord's
      // first actionable thing is the code, so making a person press "begin
      // login" just to reveal it charges an empty press. Slack remains a
      // conversation flow because it needs an email before its browser step.
      //
      // ~~Every unconnected bridge tile opened the window.~~ That was harmless
      // only because the conversation platforms had no webLogin policy and the
      // window degraded to this card; restoring Slack's made the wrong path
      // reachable for the first time.
      const flow = BRIDGE_FLOW[kindOf(src.id)] || 'cookie';
      if (isBridge(src) && !src.connected && (flow === 'cookie' || kindOf(src.id) === 'discord')) {
        // bridgeWebLogin is the single entry point. Native checks the same GET
        // response for a genuinely current passcode question before it opens
        // anything, so X resumes safely without a preliminary status request
        // that can lose this first press during the focus-refresh rebuild.
        openBridgeLogin();
        return;
      }
      // GOOGLE TILE: one press mounts the anchored status card and starts the
      // supported browser flow. Mounting first means the app still explains
      // what is in progress when focus returns from the browser.
      //
      // NOT the WhatsApp case struck through below. That was reverted because
      // connecting SILENTLY read as a false alarm — a dot turning green with
      // nothing to explain it. This is the opposite: what appears is Google's
      // own sign-in screen, which is unmistakably the thing that was asked for.
      //
      // Only while unconnected. An authorized mailbox row still opens its card,
      // because there the press means "tell me about this", not "sign me in".
      // ONE CLIENT, ONE PRESS. More than one and the press has to ASK, because
      // the choice is not cosmetic: an Internal client reaches only its own
      // Workspace but its grant never expires, while an External one reaches
      // any Google account and spends one of a finite, unresettable hundred.
      // Nothing here can infer which the owner meant — the account they are
      // about to pick is the only thing that decides it, and it does not exist
      // yet at press time.
      // ~~A press started sign-in, or opened the account picker first.~~ Parked
      // with the card branches above: the tile opens the ordinary card, which
      // says "coming soon". The picker and startGoogleAuth stay defined, so this
      // is one block to restore when Google ships.
      // FDA tile (owner, 2026-08-25): the card had exactly one thing on it —
      // the full disk access button — so the tile press IS the button press.
      // openFullDiskAccess rather than the bare pane URL, because it touches a
      // protected path first: that failed read is what makes macOS list
      // "intaglio labs" in the pane, already there with its switch waiting —
      // the closest to highlighting the row that macOS allows.
      if (src.action === 'fda') {
        hzPost('openFullDiskAccess').catch(() => {});
        return;
      }
      // ~~The disabled-connector (WhatsApp) tile press auto-connected for a
      // few hours on 2026-08-25.~~ Reverted the same day: connecting silently
      // read as a false alarm — the dot just turned green with nothing
      // explaining why that was enough — so the card with its connect button
      // is back, and the press is the owner's, on the button.
      hintHost.appendChild(tip);
      row.classList.add('open');
      if (isBridge(src)) openBridge(); // connected → show status
      else renderTip();
      // Scroll the TILE into view, not the strip: the row scrolls sideways
      // and the strip is already below it, so the thing that can be off
      // screen is the tile that was tapped.
      row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  // A strip kept open across refresh() is handed to the tile that replaced
  // its owner. Holding typed login input it is adopted AS-IS — wiping a
  // half-typed cookie paste, token, or phone code is the exact loss the keep
  // exists to prevent — and toggle()'s id check closes it on the next tap.
  // Otherwise it is re-rendered from THIS tile's fresh src, so the panel
  // cannot keep describing a state the dot no longer shows. The shelf was
  // just rebuilt from the same status, so renderBridge's connected-repaint
  // would be a loop here, not news — hence the pre-set flag.
  if (keep) {
    const typed = [...keep.querySelectorAll('textarea, input')].some((b) => b.value.trim());
    if (!typed) {
      hintHost.replaceChildren(tip);
      if (soon) renderSoon();
      else if (isBridge(src)) openBridge();
      else renderTip();
    }
    row.classList.add('open');
  }
  return row;
  // (grid id kept for the container; it renders rows now)
}

// A FIRST CLICK INTO SETTINGS ALSO FOCUSES ITS NON-ACTIVATING PANEL. The focus
// event used to call refresh() immediately; that async response could replace
// the connector row between pointerdown and click, detaching the exact node
// that was meant to open. The visible result was deterministic enough to feel
// like a double-click requirement: first press focused + rebuilt, second press
// finally reached a stable tile.
//
// Hold a focus refresh until the pointer gesture has produced its click. The
// timer still refreshes a panel focused by keyboard or programmatically, and a
// refresh that was already in flight refuses to repaint while a press is down.
let settingsPointerDown = false;
let focusRefreshPending = false;
let focusRefreshTimer = 0;
const flushFocusRefresh = () => {
  if (!focusRefreshPending || settingsPointerDown) return;
  focusRefreshPending = false;
  focusRefreshTimer = 0;
  refresh();
};
const scheduleFocusRefresh = () => {
  focusRefreshPending = true;
  clearTimeout(focusRefreshTimer);
  focusRefreshTimer = setTimeout(flushFocusRefresh, 120);
};
document.addEventListener('pointerdown', () => {
  settingsPointerDown = true;
  if (focusRefreshPending) clearTimeout(focusRefreshTimer);
}, true);
const finishSettingsPointer = () => {
  settingsPointerDown = false;
  if (focusRefreshPending) requestAnimationFrame(flushFocusRefresh);
};
document.addEventListener('pointerup', finishSettingsPointer, true);
document.addEventListener('pointercancel', finishSettingsPointer, true);

/// THE ONLY PLACE THE NOTICE IS WRITTEN. Colour through element.style because
/// these pages ship a CSP with no 'unsafe-inline'
/// (widget/test/csp-inline-style.test.mjs), and cleared on every path rather
/// than on the happy one: the element keeps whatever the last notice painted.
function showNotice(chosen) {
  notice.textContent = chosen ? chosen.text : '';
  notice.style.color = chosen && chosen.alarm ? 'var(--status-bad)' : '';
  notice.hidden = !chosen;
}

async function refresh() {
  try {
    // BEFORE THE FIRST TILE IS BUILT. Cached after the first call (hzFeatures
    // in bridge.js), so every later refresh pays nothing — but the shelf must
    // never render once from an unknown registry and then re-render smaller,
    // which is a visible flash of connectors this build does not offer.
    featureSet = await hzFeatures();
    const data = await hzPost('status');
    showNotice(noticeFor(data));
    if (data.state !== 'ok') return;
    // THE SETTINGS ROW RIDES THIS FETCH. `linkedinExportReady` is a field on
    // connect's linkedin-export row, and this is the only call in the panel
    // that asks for it — so the settings row is told rather than asking again.
    // Read off `data.sources` and not the visible set: the settings row exists
    // whether or not the shelf is showing that tile, and the registry can hide
    // the tile without making the export stop being something the owner is
    // waiting on. A missing row is null, which is the row's "nothing to say".
    if (noteLinkedInReady) {
      const row = (data.sources ?? []).find((s) => s.id === LINKEDIN_EXPORT_ID);
      noteLinkedInReady(row?.linkedinExportReady ?? null);
    }
    // An OPEN strip survives the refresh. The cookie-paste and token/phone
    // login flows require leaving the popup (to copy cookies, a token, or a
    // code), and coming back fires the focus listener below; renderBridge
    // also calls refresh() on a freshly connected status. Wiping the host on
    // either path destroyed the open panel mid-login. The shelf still
    // rebuilds; the kept strip is handed to its rebuilt tile, which adopts
    // it (end of card()): re-rendered from the fresh payload unless it holds
    // typed login input, and re-marked open. A strip whose source left the
    // payload closes with the tiles that could own it.
    const keep = hintHost.querySelector('.hint');
    const shown = visibleSources(data.sources);
    const kept = keep && shown.some((s) => s.id === keep.dataset.id) ? keep : null;
    // A non-focus refresh may already have been in flight when this gesture
    // began. Re-fetch after click instead of replacing its target underneath
    // the pointer.
    if (settingsPointerDown) {
      focusRefreshPending = true;
      return;
    }
    if (!kept) hintHost.replaceChildren(); // strips of old tiles, or of a source now gone
    grid.replaceChildren(...orderSources(shown)
      .map((s) => card(s, kept && kept.dataset.id === s.id ? kept : null)));
  } catch {
    showNotice({ text: NOTICES.error, alarm: false });
  }
}

refresh();
// The panel is hidden and re-shown, not reloaded — without this, a reopened
// popup would show the status from its first open forever.
window.addEventListener('focus', scheduleFocusRefresh);

// The close must SURVIVE the chrome around it: the sound is best-effort (a
// Web Audio throw must never eat the close). The dead-clicks bug itself was
// the :active transform shrinking the hit box mid-press — fixed for every
// pressable at once by the pointer-capture listener in bridge.js, so one
// plain click handler is enough (a pointerup twin here used to double-fire
// the close on every successful press).
const closeSettings = () => {
  try { hzSfx.close(); } catch {}
  hzPost('close').catch(() => {});
};
document.getElementById('close').addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});
