// The shared connector tile — the ONE element every surface uses to draw a
// connector (the settings shelf, the People bar, and anything later). Factored
// out so the tile, its status dot, and its hover label are identical everywhere
// and a change lands in all of them at once.
//
// SOURCE OF TRUTH: the settings shelf (connections.js). This is that tile's
// markup and its custom hover tooltip, lifted verbatim so behaviour matches.
// What differs by surface — what a CLICK does — is passed in as onOpen, because
// settings opens an inline hint strip while other surfaces hand off elsewhere.
//
// Depends only on hzGlyph (bridge.js). No network. Load this BEFORE the page
// script that calls hzConnectorTile.
'use strict';

// WKWebView never draws the native title-attribute tooltip reliably (and
// `title` double-draws), so the tile carries a custom one: a single shared
// element, fixed-position, moved under whichever tile is hovered or focused.
// Fixed because the shelf scrolls with overflow hidden — a tooltip inside the
// scroller would clip.
let hzTileTip = null;
function hzShowTileTip(row, label) {
  if (!hzTileTip) {
    hzTileTip = document.createElement('div');
    hzTileTip.className = 'tile-tip';
    document.body.appendChild(hzTileTip);
    window.addEventListener('scroll', hzHideTileTip, true); // scroll hides a stale tip
  }
  hzTileTip.textContent = label;
  hzTileTip.style.left = '0px'; // reset before measuring, or width lies
  hzTileTip.classList.add('on');
  const r = row.getBoundingClientRect();
  const w = hzTileTip.offsetWidth;
  const x = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4);
  hzTileTip.style.left = `${x}px`;
  hzTileTip.style.top = `${r.bottom + 6}px`;
}
function hzHideTileTip() {
  if (hzTileTip) hzTileTip.classList.remove('on');
}

// Build one connector tile from a /api/status source. Returns the .row element;
// the caller places it (settings wraps it in a display:contents .rowwrap so its
// hint can span the row below; the People bar just appends it to a .list).
// `onOpen(src, row)` runs on click / Enter / Space.
function hzConnectorTile(src, { onOpen } = {}) {
  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  // aria-label, NOT title: the tile has no visible label at 40px so it needs an
  // accessible name, but `title` also draws a native tooltip here that would
  // double under the custom .tile-tip. aria-label names it for a screen reader
  // and draws nothing; hzShowTileTip owns the visible hover label.
  row.setAttribute('aria-label', src.label);

  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.innerHTML = hzGlyph(src.id); // trusted static glyph strings

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = src.label; // hidden at 40px, kept for a11y/reflow

  const dot = document.createElement('span');
  // Three states, same as the settings shelf: on (green), bad (set up but
  // failing — src.broken), off (never linked). A plain !connected would make a
  // broken connector indistinguishable from one that was never connected.
  dot.className = 'dot' + (src.connected ? ' on' : src.broken ? ' bad' : ' off');

  row.append(mark, name, dot);

  row.addEventListener('mouseenter', () => hzShowTileTip(row, src.label));
  row.addEventListener('mouseleave', hzHideTileTip);
  row.addEventListener('focus', () => hzShowTileTip(row, src.label));
  row.addEventListener('blur', hzHideTileTip);

  if (typeof onOpen === 'function') {
    const fire = () => onOpen(src, row);
    row.addEventListener('click', fire);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fire();
      }
    });
  }
  return row;
}

// ---------------- the connector's flow (its "designated pop-up") ----------------
// Also source-of-truth from connections.js: what opens when a tile is clicked —
// the why line, the how-to (with an external link), and for the social bridges
// the in-popup login. Shared so a connector opens the SAME flow on every surface
// (settings shelf, People bar) instead of each reinventing or bouncing to
// settings. Renders a .hint strip into `host`; call refresh() to repaint the
// surface after a successful link.
const HZ_KIND = (id) => (id.startsWith('mail:') ? 'mail' : id);

const HZ_FDA_HINT = {
  text: 'Switch on intaglio labs under System Settings → Privacy & Security → Full Disk Access.',
  url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  link: 'Open System Settings',
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
const HZ_HINTS = {
  imessage: HZ_FDA_HINT, photos: HZ_FDA_HINT, notes: HZ_FDA_HINT, contacts: HZ_FDA_HINT,
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
const HZ_HINT_FOR = (id) => (id.startsWith('mail:') ? HZ_HINTS.mail : HZ_HINTS[id]);
const HZ_WHY = {
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
const HZ_WHY_FALLBACK = "the data from this source, read on your Mac.";
const HZ_STAY = "no cloud model ever sees it";
const HZ_NOTICES = {
  down: 'connect service unreachable — status unknown',
  auth: 'token mismatch — status unknown',
  noroute: 'connect service predates /api/status — status unknown',
  error: 'status unavailable',
  // The server said this platform has no cookie flow, so there is no embedded
  // login to open — its bridge wants a pasted token or a phone code instead.
  manual: 'this one links with a token, not a browser login — use the steps below.',
};

function hzConnectorHint(src, host, { refresh = () => {} } = {}) {
  const tip = document.createElement('div');
  tip.className = 'hint';
  const hint = HZ_HINT_FOR(src.id);
  let refreshedOnConnect = false;

  // Non-bridge (and connected) connectors: why it matters, its status, the how.
  const renderTip = () => {
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    tip.appendChild(head);
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = HZ_WHY[HZ_KIND(src.id)] || HZ_WHY_FALLBACK;
    tip.appendChild(why);
    if (hint) {
      tip.append(hint.text + ' ');
      if (hint.url) {
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = hint.link + ' ↗';
        a.addEventListener('click', (e) => { e.preventDefault(); hzPost('openExternal', { url: hint.url }); });
        tip.appendChild(a);
      }
    }
    const stay = document.createElement('span');
    stay.className = 'stay';
    stay.textContent = HZ_STAY;
    tip.appendChild(stay);
  };

  // Social bridges: the in-popup login (Beeper-style window) + a manual paste
  // fallback. On a successful link, repaint the surface once.
  const renderBridge = (data) => {
    if (data && data.connected && !refreshedOnConnect) { refreshedOnConnect = true; refresh(); }
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    tip.appendChild(head);
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = HZ_WHY[HZ_KIND(src.id)] || HZ_WHY_FALLBACK;
    tip.appendChild(why);

    // WHETHER THERE IS AN EMBEDDED LOGIN AT ALL IS THE SERVER'S CALL.
    //
    // `manual` means the platform's bridge takes a pasted token (Discord, Slack)
    // or a phone code (Telegram) rather than cookies, so there is nothing for a
    // webview to do. This tile used to fire bridgeWebLogin for EVERY bridge
    // connector with no gate — connections.js had a BRIDGE_FLOW table and this
    // file had nothing, despite the comment above claiming a connector opens the
    // same flow on every surface — and the native fence then cancelled the
    // navigation, leaving a blank branded window with no error. Reading the
    // server's answer means the decision lives in one place instead of three.
    const manual = data && data.state === 'manual';
    if (data && data.connected) {
      tip.append(`linked as ${data.name || 'you'}`);
    } else if (data && data.state !== 'ok' && data.state !== 'cancelled' && !manual && !data.transcript) {
      tip.append(HZ_NOTICES[data.state] || data.error || HZ_NOTICES.error);
    } else {
      if (manual) {
        const note = document.createElement('span');
        note.className = 'why';
        note.textContent = HZ_NOTICES.manual;
        tip.appendChild(note);
      } else {
      const login = document.createElement('button');
      login.className = 'hold-ok';
      login.textContent = `log in to ${src.label}`;
      login.addEventListener('click', (e) => {
        e.stopPropagation();
        login.disabled = true; login.textContent = 'opening login…';
        hzPost('bridgeWebLogin', { p: HZ_KIND(src.id) })
          .then(renderBridge)
          .catch(() => { login.disabled = false; login.textContent = `log in to ${src.label}`; });
      });
      tip.appendChild(login);
      }

      if (data && data.state === 'cancelled') {
        const note = document.createElement('span');
        note.className = 'why';
        note.textContent = 'login window closed — tap to try again.';
        tip.appendChild(note);
      }
      if (data && data.transcript && data.transcript.length) {
        const log = document.createElement('div');
        log.className = 'blog';
        for (const m of data.transcript) {
          const line = document.createElement('div');
          line.className = 'bline' + (m.from === 'you' ? ' you' : '');
          line.textContent = m.body;
          log.appendChild(line);
        }
        tip.appendChild(log);
      }
      const adv = document.createElement('details');
      // Not "advanced" when it is the only way in — open it and say so.
      if (manual) adv.open = true;
      const sum = document.createElement('summary');
      sum.className = 'why';
      sum.textContent = manual
        ? `link ${src.label} step by step`
        : 'having trouble? paste cookies manually';
      sum.addEventListener('click', (e) => e.stopPropagation());
      adv.appendChild(sum);
      const begin = document.createElement('button');
      begin.className = 'hold-ok';
      begin.textContent = 'begin manual login';
      begin.addEventListener('click', (e) => {
        e.stopPropagation();
        begin.disabled = true; begin.textContent = 'starting…';
        hzPost('bridgeBegin', { p: HZ_KIND(src.id) })
          .then(renderBridge)
          .catch(() => { begin.disabled = false; begin.textContent = 'begin manual login'; });
      });
      const paste = document.createElement('textarea');
      paste.className = 'bpaste';
      paste.placeholder = manual
        ? 'paste what the bot asks for'
        : 'paste cookies (JSON or Copy-as-cURL)';
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
        hzPost('bridgeCookies', { p: HZ_KIND(src.id), cookies: val })
          .then(renderBridge)
          .catch(() => { send.disabled = false; send.textContent = 'send'; });
      });
      adv.append(begin, paste, send);
      tip.appendChild(adv);
    }
    const stay = document.createElement('span');
    stay.className = 'stay';
    stay.textContent = HZ_STAY;
    tip.appendChild(stay);
  };

  const openBridge = () => {
    tip.replaceChildren(); tip.classList.add('hold');
    const head = document.createElement('b'); head.textContent = src.label;
    tip.append(head, 'checking…');
    hzPost('bridgeStatus', { p: HZ_KIND(src.id) }).then(renderBridge).catch(() => renderBridge({ state: 'down' }));
  };
  const openBridgeLogin = () => {
    tip.replaceChildren(); tip.classList.add('hold');
    const head = document.createElement('b'); head.textContent = src.label;
    tip.append(head, ' — opening login…');
    hzPost('bridgeWebLogin', { p: HZ_KIND(src.id) }).then(renderBridge).catch(() => renderBridge({ state: 'down' }));
  };

  // Attach BEFORE rendering — the bridge openers finish async and paint into
  // this node, so it has to already be in the document.
  host.appendChild(tip);
  if (src.action === 'bridge') {
    if (src.connected) openBridge(); else openBridgeLogin();
  } else {
    renderTip();
  }
  return tip;
}
