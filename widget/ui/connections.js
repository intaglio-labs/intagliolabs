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
  document.body.classList.toggle('hint-open', open);
  if (open) {
    const main = document.querySelector('.conn-main');
    if (main) hintHost.style.height = `${Math.round(main.getBoundingClientRect().height)}px`;
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
    hintHost.style.height = '';
  }
  hzPost('fitContent', { height: 0, extraWidth: open ? 248 : 0 }).catch(() => {});
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
  const sub = document.createElement('span');
  sub.className = 'setting-note';
  sub.textContent = note;
  text.append(label, sub);

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

// A setting that DOES something rather than holding a value: same row, a pill
// instead of a switch.
function actionRow({ name, note, action, message }) {
  const el = document.createElement('div');
  el.className = 'setting';

  const text = document.createElement('div');
  text.className = 'setting-text';
  const label = document.createElement('span');
  label.className = 'setting-name';
  label.textContent = name;
  const sub = document.createElement('span');
  sub.className = 'setting-note';
  sub.textContent = note;
  text.append(label, sub);

  const btn = document.createElement('button');
  btn.className = 'setting-action';
  btn.textContent = action;
  btn.addEventListener('click', () => {
    hzPost(message).catch(() => {});
    // The flow takes over the screen; leaving this popup open behind it just
    // means finding it again afterwards.
    hzPost('close').catch(() => {});
  });

  el.append(text, btn);
  return el;
}

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
  name.textContent = 'model';
  const value = document.createElement('span');
  value.className = 'setting-value';
  head.append(name, value);
  const note = document.createElement('span');
  note.className = 'setting-note';
  note.textContent = 'the local model that answers your questions';
  const choices = document.createElement('div');
  choices.className = 'model-pick';
  const status = document.createElement('span');
  status.className = 'setting-note model-status';
  const bar = document.createElement('span');
  bar.className = 'model-progress';
  el.append(head, note, choices, bar, status);

  let state = null;
  const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
  function paint() {
    if (!state) return;
    const active = state.model || '';
    value.textContent = active ? (active === '8b' ? '5.0 GB' : '2.5 GB') : 'not installed';
    choices.replaceChildren();
    for (const tier of state.tiers || []) {
      const b = document.createElement('button');
      b.className = 'model-pick-button' + (tier.id === active ? ' on' : '');
      b.textContent = `${tier.label} · ${gb(tier.bytes)}`;
      b.title = tier.detail;
      b.addEventListener('click', () => {
        status.textContent = tier.id === active ? 'already selected' : 'starting download…';
        bar.style.width = tier.id === active ? '100%' : '0%';
        hzPost('modelDownload', { tier: tier.id }).catch(() => {
          status.textContent = 'could not start the download';
        });
      });
      choices.appendChild(b);
    }
  }
  window.__hzSetup = (d) => {
    if (!d || typeof d !== 'object') return;
    if (d.phase === 'downloading' && d.total > 0) {
      bar.style.width = `${Math.min(100, (d.got / d.total) * 100)}%`;
      status.textContent = `${gb(d.got)} of ${gb(d.total)}`;
    } else if (d.phase === 'installing') {
      bar.style.width = '100%';
      status.textContent = 'starting the local engine…';
    } else if (d.phase === 'ready') {
      status.textContent = 'ready';
      hzPost('setupState').then((next) => { state = next; paint(); }).catch(() => {});
    } else if (d.phase === 'failed') {
      status.textContent = d.error || 'download failed';
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
    const host = document.querySelector('.hint-host');
    if (!main) return;
    const pad = 28; // .win vertical padding, 14 top + 14 bottom
    const mh = main.scrollHeight;
    const hh = host && host.childElementCount ? host.scrollHeight : 0;
    const h = Math.ceil(Math.max(mh, hh) + pad);
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
      note: 'Reduce Motion is on for this Mac',
      on: p && p.motion === true,
      message: 'setMotion',
    }));
  }
  // Sounds always show: there is no system setting behind them, so this is
  // the only place they can be turned off.
  rows.push(settingRow({
    name: 'sounds',
    note: 'presses, sending and replies',
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
  rows.push(actionRow({
    name: 'onboarding',
    note: 'replay the welcome flow',
    action: 'run',
    message: 'openOnboarding',
  }));
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
  text: 'Switch on intaglio labs under System Settings → Privacy & Security → Full Disk Access.',
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
  granola: { text: 'Copy your API key from Granola settings, then paste it on the connect page.',
             url: 'https://granola.ai', link: 'granola.ai' },
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

// Why each connector is worth connecting — one or two sentences, shown the
// FIRST time its tile is pressed, with the privacy line under it. Keyed by
// kind (both mail accounts are one "mail"); the fallback keeps an unknown
// future source from arriving with no story at all.
// One sentence, factual: WHAT DATA this source gives access to. Not a pitch —
// the owner wants the subheader to say plainly what is read.
const WHY = {
  imessage: "your text messages and who they're with.",
  photos: "photo dates, places, and the people your library has tagged.",
  notes: "the notes you've written.",
  files: "pdfs, docs, and downloads on this Mac.",
  calendar: "your events — titles, times, and who's invited.",
  mail: "your email — senders, subjects, and message text.",
  granola: "your meeting notes and transcripts.",
  oura: "your sleep, readiness, and activity data.",
  notion: "the pages you share with the integration.",
  linkedin: "your connections and their details, from your export.",
  whatsapp: "your WhatsApp chats and who they're with.",
  messenger: "your Messenger DMs.",
  instagram: "your Instagram DMs.",
  twitter: "your X DMs.",
  telegram: "your Telegram chats and channels.",
  discord: "your Discord DMs and servers.",
  slack: "your Slack messages and channels.",
  contacts: "names, phone numbers, and email addresses.",
};
const WHY_FALLBACK = "the data from this source, read on your Mac.";

// Connectors finished on the loopback connect page (paste an app password or
// token there). They get an "open the connect page" door in their hint.
const CONNECT_PAGE = new Set(['mail', 'oura', 'notion', 'granola']);

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
  twitter: 'cookie', messenger: 'cookie', instagram: 'cookie',
  discord: 'token', slack: 'token', telegram: 'phone',
};
const BRIDGE_HELP = {
  discord: {
    lead: "Discord logs in with your account token, not a password.",
    place: 'your Discord token',
    url: 'https://docs.mau.fi/bridges/go/discord/authentication.html',
    link: 'how to find your token',
  },
  slack: {
    lead: "Slack logs in with two tokens from your browser (xoxc and xoxd).",
    place: 'your Slack tokens',
    url: 'https://docs.mau.fi/bridges/go/slack/authentication.html',
    link: 'how to find your tokens',
  },
  telegram: {
    lead: "Telegram texts a code to your app. Send your phone number first, then the code.",
    place: 'phone (+1…), then the code',
  },
};
// The claim the system actually keeps, not the one it doesn't. This line
// renders under EVERY tile including the social bridges, which hold a live
// authenticated session to the platform — so "your data never leaves this
// mac" was false there (the ops/EGRESS.json ledger enumerates the real
// paths). What IS true everywhere: hazlie reasons over it locally and no
// cloud model sees it.
const STAY = "no cloud model ever sees it";

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
// WHAT NEEDS YOU COMES FIRST. The shelf scrolls, so anything past the fourth
// tile is work to reach — and the tiles that need reaching are exactly the
// ones not yet connected, or connected with a caveat (a stale sync, a
// permission that lapsed). Those lead; everything healthy follows in the
// scan order below. The consequence is deliberate: connect something and it
// MOVES, out of the way, which is the shelf telling you it is done.
const needsYou = (s) => !s.connected || !!s.caveat;
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
  tileTip.style.top = `${r.bottom + 6}px`;
}
function hideTileTip() { if (tileTip) tileTip.classList.remove('on'); }

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
  const renderTip = () => {
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    tip.appendChild(head);
    {
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = WHY[kindOf(src.id)] || WHY_FALLBACK;
      tip.appendChild(why);
    }
    // A broken source states the problem BEFORE the WHY and the how-to. It is
    // the only thing on this panel the owner has to act on, and burying it
    // under an explanation of what Granola is would be the wrong order.
    if (src.broken && src.fix) {
      const bad = document.createElement('span');
      bad.className = 'broken';
      const what = document.createElement('b');
      what.textContent = src.detail || 'not working';
      bad.append(what, document.createTextNode(' ' + src.fix));

      // Full Disk Access is the one failure with a place to send them, so it
      // gets a button rather than a paragraph to follow by hand.
      if (src.action === 'fda') {
        const open = document.createElement('button');
        open.className = 'broken-fix';
        open.textContent = 'Open Full Disk Access';
        open.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Degrades on purpose: until this URL is in Bridge.swift's
          // allowedExternal the bridge answers "url not in allowlist", and the
          // written steps above are already on screen — so the worst case is a
          // button that does nothing visible, never a dead end.
          hzPost('openExternal', {
            url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
          }).catch(() => {});
        });
        bad.appendChild(open);
      }
      tip.appendChild(bad);
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
    {
      const stay = document.createElement('span');
      stay.className = 'stay';
      stay.textContent = STAY;
      tip.appendChild(stay);
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
  let refreshedOnConnect = false;
  const renderBridge = (data) => {
    if (data && data.connected && !refreshedOnConnect) {
      refreshedOnConnect = true;
      refresh();
    }
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    tip.appendChild(head);
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = WHY[kindOf(src.id)] || WHY_FALLBACK;
    tip.appendChild(why);

    // Any bot chatter shows so the owner sees what the bridge said/asked.
    const appendTranscript = () => {
      if (!(data && data.transcript && data.transcript.length)) return;
      const log = document.createElement('div');
      log.className = 'blog';
      for (const m of data.transcript) {
        const line = document.createElement('div');
        line.className = 'bline' + (m.from === 'you' ? ' you' : '');
        line.textContent = m.body; // server-masked; text only, never HTML
        log.appendChild(line);
      }
      tip.appendChild(log);
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
      send.textContent = 'send';
      const fire = () => {
        const val = box.value.trim();
        if (!val) return;
        box.value = ''; // gone from the page before anything else happens
        send.disabled = true; send.textContent = 'sending…';
        hzPost('bridgeCookies', { p: kindOf(src.id), cookies: val })
          .then(renderBridge)
          .catch(() => { send.disabled = false; send.textContent = 'send'; });
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
      login.textContent = `log in to ${src.label}`;
      login.addEventListener('click', (e) => {
        e.stopPropagation();
        login.disabled = true; login.textContent = 'opening login…';
        hzPost('bridgeWebLogin', { p: kindOf(src.id) })
          .then(renderBridge)
          .catch(() => { login.disabled = false; login.textContent = `log in to ${src.label}`; });
      });
      tip.appendChild(login);
      if (data && data.state === 'cancelled') {
        const note = document.createElement('span');
        note.className = 'why';
        note.textContent = 'login window closed — tap to try again.';
        tip.appendChild(note);
      }
      appendTranscript();
      // Advanced fallback, tucked away: paste cookies by hand (the old flow).
      const adv = document.createElement('details');
      const sum = document.createElement('summary');
      sum.className = 'why';
      sum.textContent = 'having trouble? paste cookies manually';
      sum.addEventListener('click', (e) => e.stopPropagation());
      adv.appendChild(sum);
      const begin = document.createElement('button');
      begin.className = 'hold-ok';
      begin.textContent = 'begin manual login';
      begin.addEventListener('click', (e) => {
        e.stopPropagation();
        begin.disabled = true; begin.textContent = 'starting…';
        hzPost('bridgeBegin', { p: kindOf(src.id) })
          .then(renderBridge)
          .catch(() => { begin.disabled = false; begin.textContent = 'begin manual login'; });
      });
      const paste = document.createElement('textarea');
      paste.className = 'bpaste';
      paste.placeholder = 'paste cookies (JSON or Copy-as-cURL)';
      paste.setAttribute('spellcheck', 'false');
      const send = document.createElement('button');
      send.className = 'hold-ok';
      send.textContent = 'send';
      send.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = paste.value.trim();
        if (!val) return;
        paste.value = '';
        send.disabled = true; send.textContent = 'sending…';
        hzPost('bridgeCookies', { p: kindOf(src.id), cookies: val })
          .then(renderBridge)
          .catch(() => { send.disabled = false; send.textContent = 'send'; });
      });
      adv.append(begin, paste, send);
      tip.appendChild(adv);
    } else {
      // TOKEN (discord/slack) and PHONE (telegram): a guided conversation with
      // the bridge bot, because these do not authenticate by cookie harvest.
      // begin sends the login command; then the input relays whatever the bot
      // asks for (a token, or a phone number and then the code).
      const help = BRIDGE_HELP[kindOf(src.id)];
      if (help) {
        const lead = document.createElement('span');
        lead.className = 'why';
        lead.textContent = help.lead;
        tip.appendChild(lead);
        if (help.url) {
          const a = document.createElement('a');
          a.href = '#';
          a.textContent = help.link + ' ↗';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            hzPost('openExternal', { url: help.url });
          });
          tip.appendChild(a);
        }
      }
      const started = data && data.transcript && data.transcript.length;
      if (!started) {
        beginButton(`begin ${src.label} login`);
      } else {
        appendTranscript();
        // The bot is waiting for the next thing. Token pastes want room;
        // a phone number or a code is one short line.
        relayInput(`enter ${help ? help.place : 'your reply'}`, flow === 'token');
      }
    }
    const stay = document.createElement('span');
    stay.className = 'stay';
    stay.textContent = STAY;
    tip.appendChild(stay);
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
    hintHost.replaceChildren();
    for (const r of grid.querySelectorAll('.row')) r.classList.remove('open');
    hintHost.appendChild(tip);
    row.classList.add('open');
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
      // Unconnected social bridge: DON'T open the panel — the login spins the
      // tile dot and the panel opens later, only when there's a result
      // (openBridgeLogin owns that). Everything else opens the panel now:
      // attach BEFORE rendering, because the async bridge/status openers paint
      // into this node when their promise lands.
      if (src.action === 'bridge' && !src.connected) {
        openBridgeLogin();
        return;
      }
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
      if (src.action === 'bridge') { refreshedOnConnect = true; openBridge(); }
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
