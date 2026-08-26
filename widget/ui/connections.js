'use strict';
const grid = document.getElementById('grid');
const hintHost = document.getElementById('hintHost');

// The strip opens as a section BESIDE the shelf, not a band under it. The
// native window grows leftward to make room (placedFrame pins the popup's
// right edge to the widget), so opening a hint never reflows the tiles or
// walks the footer down. One observer catches every open/close path —
// toggle, re-render, eviction — because they all mutate hintHost's children.
// 248 = the .hint-host CSS width (236) plus the .win column gap (12).
//
// On open the host also (1) takes .conn-main's exact height, so with both
// columns bottom-anchored the panel's TOP lines up with the CONNECTIONS
// eyebrow, and (2) grows a corner x — chrome, not content, so it is
// re-added after every replaceChildren() wipe.
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
    let anchor = document.querySelector('#grid .row.open');
    if (!anchor) {
      const cardEl = hintHost.querySelector('.hint');
      const id = cardEl ? cardEl.dataset.id : null;
      anchor = id
        ? [...document.querySelectorAll('#grid .row')].find((r) => r.dataset.id === id) || null
        : null;
      if (anchor) anchor.classList.add('open'); // so the next tap closes, never relaunches
    }
    if (!anchor) { hintHost.replaceChildren(); return; }
    hzPlacePop(hintHost, anchor);
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
const notice = document.getElementById('notice');
const settings = document.getElementById('settings');

// One row per setting: a name, a line of context, and a switch. Generic
// because there are two of them now and they differ only in wording, in which
// bridge message they send, and in whether they are shown at all.
function settingRow({ name, note, on, message }) {
  const el = document.createElement('div');
  el.className = 'setting';

  const text = document.createElement('div');
  text.className = 'setting-text';
  const label = document.createElement('span');
  label.className = 'setting-name';
  label.textContent = name;
  text.appendChild(label);
  // The note is optional now — both switch rows shed theirs (owner,
  // 2026-08-25): "Reduce Motion is on for this Mac" and "presses, sending
  // and replies" explained controls whose names already say it.
  if (note) {
    const sub = document.createElement('span');
    sub.className = 'setting-note';
    sub.textContent = note;
    text.appendChild(sub);
  }

  const sw = document.createElement('button');
  sw.className = 'switch' + (on ? ' on' : '');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(on));
  sw.title = name;
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

  el.append(text, sw);
  return el;
}

// A setting that holds a NUMBER. Stacked rather than in a row — a slider in
// the space a switch occupies has about 30px of travel in a 312px popup.
//
// No end labels under the track: the live read-out in the head already says
// where the thumb is, and two more numbers underneath were saying the same
// thing twice in a 312px popup.
//
// `input` fires continuously while dragging and `change` once on release, and
// both are wired on purpose: the first is what makes the widget resize under
// the thumb so the size can be CHOSEN by looking at it, the second is what
// commits. Only `change` persists, so a drag across the whole range writes
// UserDefaults once instead of forty times.
function rangeRow({ name, note, value, min, max, step, message, format }) {
  const el = document.createElement('div');
  el.className = 'setting setting-col';

  const head = document.createElement('div');
  head.className = 'setting-head';
  const label = document.createElement('span');
  label.className = 'setting-name';
  label.textContent = name;
  const read = document.createElement('span');
  read.className = 'setting-value';
  read.textContent = format(value);
  head.append(label, read);

  const sub = document.createElement('span');
  sub.className = 'setting-note';
  sub.textContent = note;

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'setting-range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.title = name;

  // Applied live but not stored. If the bridge refuses it the read-out would
  // be lying, so it is only trusted once the reply comes back.
  // COALESCED TO ONE PER FRAME. `input` fires as fast as the mouse moves, and
  // each one costs a window resize plus a full relayout of three zoomed
  // pages — dragging the thumb across the range queued dozens of them and the
  // first pull visibly stuttered. The read-out still updates on every event,
  // because that is just text; only the expensive half is throttled. Skipping
  // an unchanged value matters too: a slider held still between steps keeps
  // firing.
  let pending = null;
  let applied = value;
  input.addEventListener('input', () => {
    read.textContent = format(Number(input.value));
    if (pending !== null) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      const v = Number(input.value);
      if (v === applied) return;
      applied = v;
      hzPost(message, { value: v, commit: false }).catch(() => {});
    });
  });
  input.addEventListener('change', () => {
    applied = Number(input.value);
    hzPost(message, { value: Number(input.value) })
      .then((d) => {
        // Native clamps; if it came back different, the control has to say so
        // rather than keep showing a value that was not stored.
        if (d && typeof d.scale === 'number') {
          input.value = String(d.scale);
          read.textContent = format(d.scale);
        }
      })
      .catch(() => {});
  });

  el.append(head, sub, input);
  return el;
}

// A setting that DOES something rather than holding a value — same row, a pill
// instead of a switch — went with its only caller, the onboarding row in
// renderSettings(). Kept in history rather than in the file: the
// `.setting-action` styling it used is still in palette.css, so the next
// action row is a function away.

// The answer model is a Settings choice, not an onboarding gate. Fresh installs
// default to the roughly 5 GB tier; this row keeps the smaller option available
// for a Mac that needs less memory.
function modelRow() {
  const el = document.createElement('div');
  el.className = 'setting setting-col model-setting';
  const head = document.createElement('div');
  head.className = 'setting-head';
  const name = document.createElement('span');
  name.className = 'setting-name';
  name.textContent = 'local model size';
  // The corner GB readout was yeeted (owner, 2026-08-25): the highlighted
  // tier button says the same thing one line lower.
  head.append(name);
  const choices = document.createElement('div');
  choices.className = 'model-pick';
  const status = document.createElement('span');
  status.className = 'setting-note model-status';
  const bar = document.createElement('span');
  bar.className = 'model-progress';
  el.append(head, choices, bar, status);

  // The bar and the status line have nothing to say until a download is in
  // flight, but they still held their height (and their flex gaps) under the
  // tier buttons on every visit to Settings. Route every status write through
  // here so .busy — which is what gives them their height back — can never
  // drift out of sync with whether there is actually text to show.
  const say = (text) => {
    status.textContent = text;
    el.classList.toggle('busy', text !== '');
  };

  let state = null;
  const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
  function paint() {
    if (!state) return;
    const active = state.model || '';
    choices.replaceChildren();
    for (const tier of state.tiers || []) {
      const b = document.createElement('button');
      b.className = 'model-pick-button' + (tier.id === active ? ' on' : '');
      b.textContent = `${tier.label} · ${gb(tier.bytes)}`;
      b.title = tier.detail;
      b.addEventListener('click', () => {
        say(tier.id === active ? 'already selected' : 'starting download…');
        bar.style.width = tier.id === active ? '100%' : '0%';
        hzPost('modelDownload', { tier: tier.id }).catch(() => {
          say('could not start the download');
        });
      });
      choices.appendChild(b);
    }
  }
  window.__hzSetup = (d) => {
    if (!d || typeof d !== 'object') return;
    if (d.phase === 'downloading' && d.total > 0) {
      bar.style.width = `${Math.min(100, (d.got / d.total) * 100)}%`;
      say(`${gb(d.got)} of ${gb(d.total)}`);
    } else if (d.phase === 'installing') {
      bar.style.width = '100%';
      say('starting the local engine…');
    } else if (d.phase === 'ready') {
      say('ready');
      hzPost('setupState').then((next) => { state = next; paint(); }).catch(() => {});
    } else if (d.phase === 'failed') {
      say(d.error || 'download failed');
    }
  };
  hzPost('setupState').then((next) => { state = next; paint(); }).catch(() => {});
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
window.addEventListener('resize', fitConnections);
fitConnections();

async function renderSettings() {
  let p;
  try {
    p = await hzPost('prefs');
  } catch {
    return; // no bridge, nothing to toggle
  }
  const rows = [];
  // The motion row only appears when the system setting it overrides is
  // actually on. With Reduce Motion off it would do nothing, and a control
  // that does nothing is worse than no control.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    rows.push(settingRow({
      name: 'animations',
      on: p && p.motion === true,
      message: 'setMotion',
    }));
  }
  // Sounds always show: there is no system setting behind them, so this is
  // the only place they can be turned off.
  rows.push(settingRow({
    name: 'sounds',
    on: !p || p.sounds !== false,
    message: 'setSounds',
  }));
  // The size slider was yeeted (owner, 2026-08-24): everything runs at 100%.
  // Native's setScale plumbing survives untouched, so a stored non-1 scale
  // from the slider era is snapped back to 1 here — without the control, a
  // leftover 130% would be permanent.
  if (p && typeof p.scale === 'number' && Math.abs(p.scale - 1) > 0.001) {
    hzPost('setScale', { scale: 1 }).catch(() => {});
  }
  rows.push(modelRow());
  // The onboarding row was yeeted (owner, 2026-08-25): ~~a `run` pill that
  // replayed the welcome flow~~. Settings is where you change what the app
  // does, not where you re-watch its introduction, and the one control here
  // that took over the whole screen was the one nobody wanted twice.
  //
  // This page's `openOnboarding` grant and the bridge case behind it went too,
  // because bridge-capabilities.test.mjs holds the map to exactly what the
  // pages call: an ungranted case is an orphan and a granted-but-uncalled verb
  // is a re-widened surface, and it fails on both. main.swift keeps its own
  // openOnboarding, so first run and the two paths that still reach it — a
  // resumed flow, and the `onboarding` URL scheme — are unchanged.
  settings.replaceChildren(...rows);
}
renderSettings();

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
  mail: { text: 'Create a 16-letter Google app password, then paste it on the connect page.',
          url: 'https://myaccount.google.com/apppasswords', link: 'Google app passwords' },
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
const CONNECT_PAGE = new Set(['mail', 'oura', 'notion']); // granola pastes in-panel now

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
  discord: 'link', slack: 'email', telegram: 'phone',
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
    // Slack will not send its code until a challenge is answered, so a window
    // opens on Slack's own page for that one step. Said on the card because a
    // window appearing mid-flow is otherwise a surprise, and because "answer
    // it yourself" is the point rather than an inconvenience.
    why: 'Slack asks for a quick “are you human” check before it emails your '
      + 'code — a window opens on Slack’s own page for you to answer it.',
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
// paths). What IS true everywhere: hazlie reasons over it locally and no
// cloud model sees it.
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
  'mail',
  'calendar',
  'contacts',
  'photos', 'notes', 'files', 'granola', 'oura', 'notion',
];
// TEMPORARILY HIDDEN (owner, front-end only, 2026-08-22 — "bring them back
// later"). The connectors and their status are untouched; the tiles just
// don't render. To restore one, delete it from this set. Nothing else keys
// off it, so a hidden id still works everywhere else it appears.
const HIDDEN_CONNECTORS = new Set(['oura', 'photos', 'files', 'notion', 'notes']);
// NOT YET SHIPPING. A tile that is on the shelf and does not work is worse
// than one that is not there — but so is a tile that vanishes, because the
// owner then wonders whether Telegram is coming at all. So: greyed, present,
// and says so when pressed.
//
// Telegram is here because its login is the only one that sends you to a
// developer portal first. Every install has to register its own app at
// my.telegram.org and paste api_id:api_hash before the bridge will start —
// the flow works, and it is not a flow to hand anyone (owner, 2026-08-26).
// The route out is written down at PLATFORMS.telegram in
// connect/lib/bridge.mjs: one registered app shipped with the product, which
// cannot be committed to this public repo and needs build-time injection.
// Delete from this set when that lands; nothing else keys off it, and the
// connector, its bridge and its walkthrough are all still wired underneath.
const SOON_CONNECTORS = new Set();
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
const needsYou = (s) => !s.connected || s.broken === true;
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
const NOTICES = {
  // The social bridges need their local engine running (ops/setup-bridges.sh
  // starts it). Named separately from `down` because the remedy is different
  // and specific: this is not "unknown", it is "start it".
  nobridge: 'the social bridge engine is not running — open Docker, then: bash ops/setup-bridges.sh',
  down: 'connect service unreachable — status unknown',
  auth: 'token mismatch — status unknown',
  noroute: 'connect service predates /api/status — status unknown',
  error: 'status unavailable',
};

// WKWebView never draws the native title-attribute tooltip, so the tile's
// name needs one of our own: a single shared element, fixed-position and
// moved under whichever tile is hovered or focused. Fixed because the shelf
// scrolls with overflow hidden — a tooltip inside the scroller would clip.
let tileTip = null;
function showTileTip(row, label) {
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
// A card begins its login once. renderBridge repaints on every bot reply and
// begin starts with `cancel`, so an unguarded auto-begin would cancel the
// conversation it opened. Keyed by source id, for the life of the page.
const autoBegun = new Set();

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
  dot.className = 'dot' + (src.connected ? ' on' : src.broken ? ' bad' : ' off');

  // Greyed, and the dot goes with it: an off dot on a tile that cannot be
  // turned on is an invitation, and this tile is declining one.
  const soon = SOON_CONNECTORS.has(kindOf(src.id));
  if (soon) {
    row.classList.add('soon');
    dot.className = 'dot off';
  }

  row.append(mark, name, dot);

  row.addEventListener('mouseenter', () => showTileTip(row, src.label));
  row.addEventListener('mouseleave', hideTileTip);
  row.addEventListener('focus', () => showTileTip(row, src.label));
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
  // The in-panel walkthrough (owner, 2026-08-25): the whole connect flow
  // lives right here — open the site, make the credential, paste it back —
  // instead of handing the owner to the connect page. Shared, because two
  // connectors reach it by different routes now: granola through the plain
  // hint, telegram from inside its bridge branch (its api keys must exist
  // before its bot can be spoken to at all).
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
  open.textContent = `1 · open ${hint.link}`;
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
        open.textContent = 'full disk access';
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
      acct.textContent = src.id.startsWith('mail:')
        ? `connected · ${src.id.slice(5)}`
        : 'connected';
      tip.appendChild(acct);
      // `hint.local` is the test, NOT src.action. action is only 'fda' while the
      // source is BROKEN, so a Messages store that was working showed "+ add
      // account" -- on a one-per-Mac store, wired to open the Full Disk Access
      // pane. The condition the comment above always described is a property of
      // the source, not of its current error state.
      if (hint && hint.url && !hint.local) {
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
      const setup = document.createElement('span');
      setup.className = 'setup';
      setup.append(hint.text + ' ');
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
      // The cloud connectors are finished on the loopback connect page (paste
      // the token / app password there). Give it a door: the page opens from
      // the tokened link the connect server wrote, read natively — no repo, no
      // terminal, which is what a fresh install needs.
      if (CONNECT_PAGE.has(kindOf(src.id))) {
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
      const ask = askedFor();
      if (ask) {
        const line = document.createElement('span');
        line.className = 'setup';
        line.textContent = ask; // server-masked; text only, never HTML
        tip.appendChild(line);
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
    const settle = (d, had, send) => {
      const answered = (x) => !!x && (x.connected === true
        || (((x.transcript) || []).length > had));
      if (answered(d)) { renderBridge(d); return; }
      send.textContent = `waiting for ${src.label}…`;
      let tries = 0;
      const tick = () => {
        // The card was closed or replaced — nothing to paint into.
        if (!tip.isConnected) return;
        // ~30s on top of relay's own 9. Past that the answer is not coming,
        // and a card stuck on "waiting" with a dead button is worse than one
        // showing the last thing that was true: repaint so it can be retried.
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
      const asked = askedFor() || '';
      if (/\bphone\b/iu.test(asked)) return '+1 xxx xxx xxxx';
      return 'type your answer';
    };
    // A one-line input that relays whatever the bot last asked for (a token,
    // a phone number, then the code) and re-renders with the bot's reply.
    const relayInput = (placeholder, multiline) => {
      const box = document.createElement(multiline ? 'textarea' : 'input');
      box.className = multiline ? 'bpaste' : 'binput';
      box.placeholder = placeholder;
      box.setAttribute('spellcheck', 'false');
      const send = document.createElement('button');
      send.className = 'hold-ok';
      // THE VERB FOLLOWS THE QUESTION. "create" is right for X's PIN, which is
      // being made rather than sent (owner, 2026-08-25) — and wrong for Slack's
      // email address, which is being given (owner, 2026-08-26, looking at a
      // card that said "create" under "enter your email"). The bot's own
      // wording decides: it says "please create ..." when something is being
      // made, and anything else is an answer.
      const asked = askedFor() || '';
      send.textContent = /\bcreate\b/iu.test(asked) ? 'create' : 'send';
      const fire = () => {
        const val = box.value.trim();
        if (!val) return;
        box.value = ''; // gone from the page before anything else happens
        const busy = send.textContent === 'create' ? 'creating…' : 'sending…';
        const idle = send.textContent;
        send.disabled = true; send.textContent = busy;
        // What the conversation looked like BEFORE this answer, so the reply
        // can be told apart from the question it is answering.
        const had = ((data && data.transcript) || []).length;
        hzPost('bridgeCookies', { p: kindOf(src.id), cookies: val })
          .then((d) => settle(d, had, send))
          .catch(() => { send.disabled = false; send.textContent = idle; });
      };
      send.addEventListener('click', (e) => { e.stopPropagation(); fire(); });
      if (!multiline) box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); fire(); }
      });
      tip.append(box, send);
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
      acct.textContent = `connected · ${data.name || 'your account'}`;
      tip.appendChild(acct);
      // + add ANOTHER account: re-run the login. mautrix bridges hold more
      // than one login per user, so a second account lands alongside the
      // first rather than replacing it.
      const add = document.createElement('button');
      add.className = 'hold-ok add-acct';
      add.textContent = '+ add another account';
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        openBridgeLogin();
      });
      tip.appendChild(add);
    } else if (data && data.state !== 'ok' && data.state !== 'cancelled'
               && data.state !== 'manual' && !data.transcript) {
      tip.append(NOTICES[data.state] || data.error || NOTICES.error);
    } else if (flow === 'cookie' && !(data && data.state === 'manual')) {
      // PRIMARY, Beeper-style: one button opens the platform's real login page
      // in a Hazlie-framed window; native harvests the session cookies. No
      // devtools, no paste. See ops/WIDGET-WEBVIEW-LOGIN-SPEC.md.
      const login = document.createElement('button');
      login.className = 'hold-ok';
      login.textContent = 'log in';
      login.addEventListener('click', (e) => {
        e.stopPropagation();
        login.disabled = true; login.textContent = 'opening login…';
        hzPost('bridgeWebLogin', { p: kindOf(src.id) })
          .then(renderBridge)
          .catch(() => { login.disabled = false; login.textContent = 'log in'; });
      });
      // Only when the bot is NOT mid-question (owner, 2026-08-25): pressing
      // "log in" during the PIN step cancels the login and restarts it, so
      // offering it beside the question is offering to undo the progress the
      // question represents. The answer box below is the only way forward.
      if (!askedFor()) tip.appendChild(login);
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
      if (askedFor() && !(data && data.connected)) {
        // The bot's question is already on screen directly above; the box only
        // has to say it is the place to answer it.
        relayInput(answerHint(), false);
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
        const last = bot.length ? String(bot[bot.length - 1].body || '') : '';
        const recent = bot.slice(-3).map((m) => String(m.body || '')).join(' ');
        return /captcha|challenge/i.test(last) && /Login URL:|embedded/i.test(recent);
      };
      if (wantsChallenge() && !(data && data.connected)) {
        const answer = document.createElement('button');
        answer.className = 'hold-ok';
        answer.textContent = 'answer the check ↗';
        answer.addEventListener('click', (e) => {
          e.stopPropagation();
          answer.disabled = true; answer.textContent = 'opening…';
          hzPost('bridgeWebLogin', { p: kindOf(src.id) })
            .then(renderBridge)
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
      } else if (!askedFor()) {
        // NO PROMPT MEANS NO PENDING STEP, and the log in button is what comes
        // back. That rule is askedFor()'s own — written 2026-08-25 when the
        // bot answered a half-finished login with "Unknown command" and the
        // panel offered a box to answer it with — but it was only ever applied
        // in the cookie branch. Here a FINISHED conversation still counts as
        // `started`, so the card kept showing an answer box under a bot that
        // had stopped asking anything: after a logout it read "Logged out" and
        // then "type your answer", with nothing on the card able to begin a
        // new login (owner, 2026-08-26, re-running the flow as a new user).
        //
        // A genuinely new install never saw this — its transcript is empty, so
        // it gets the begin button from the branch above. It takes a
        // conversation that ENDED to reach here, which is exactly the state a
        // second run starts from.
        beginButton('begin login');
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
    if (row.classList.contains('logging-in')) return;
    row.classList.add('logging-in');
    hzPost('bridgeWebLogin', { p: kindOf(src.id) })
      .then((data) => {
        row.classList.remove('logging-in');
        // Connected → renderBridge refreshes the shelf (dot goes green) and
        // shows "linked as". Not connected → the panel shows the result/retry.
        showBridgePanel(data);
      })
      .catch(() => {
        row.classList.remove('logging-in');
        showBridgePanel({ state: 'down' });
      });
  };

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
    say.textContent = 'coming soon';
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
      // THE WINDOW IS THE ENTRY POINT ONLY WHERE IT IS THE WHOLE LOGIN. For a
      // cookie harvest it is: the owner signs in on the platform's page and the
      // session IS the answer. For a conversation flow it is a STEP INSIDE the
      // login, and opening it first skips the conversation entirely — Slack's
      // bot has to be given an email address before it will ask for anything
      // else, and a window opened ahead of that is the owner signing into
      // Slack's website while no part of this app is waiting on it (owner,
      // 2026-08-26, three screenshots deep into exactly that).
      //
      // ~~Every unconnected bridge tile opened the window.~~ That was harmless
      // only because the conversation platforms had no webLogin policy and the
      // window degraded to this card; restoring Slack's made the wrong path
      // reachable for the first time.
      if (src.action === 'bridge' && !src.connected
          && (BRIDGE_FLOW[kindOf(src.id)] || 'cookie') === 'cookie') {
        openBridgeLogin();
        return;
      }
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
      if (src.action === 'bridge') openBridge(); // connected → show status
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
      else if (src.action === 'bridge') openBridge();
      else renderTip();
    }
    row.classList.add('open');
  }
  return row;
  // (grid id kept for the container; it renders rows now)
}

async function refresh() {
  try {
    const data = await hzPost('status');
    if (data.state !== 'ok') {
      notice.textContent = NOTICES[data.state] || NOTICES.error;
      notice.hidden = false;
      return;
    }
    notice.hidden = true;
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
    const shown = data.sources.filter((s) => !HIDDEN_CONNECTORS.has(kindOf(s.id)));
    const kept = keep && shown.some((s) => s.id === keep.dataset.id) ? keep : null;
    if (!kept) hintHost.replaceChildren(); // strips of old tiles, or of a source now gone
    grid.replaceChildren(...orderSources(shown)
      .map((s) => card(s, kept && kept.dataset.id === s.id ? kept : null)));
  } catch {
    notice.textContent = NOTICES.error;
    notice.hidden = false;
  }
}

refresh();
// The panel is hidden and re-shown, not reloaded — without this, a reopened
// popup would show the status from its first open forever.
window.addEventListener('focus', refresh);

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
