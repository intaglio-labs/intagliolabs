// The shared connector tile — the ONE element every surface uses to draw a
// connector (the settings shelf, the People bar, and anything later). Factored
// out so the tile, its status dot, and its hover label are identical everywhere
// and a change lands in all of them at once.
//
// SOURCE OF TRUTH: the settings shelf (connections.js). This is that tile's
// markup and its custom hover tooltip, lifted verbatim so behaviour matches.
// What differs by surface — what a CLICK does — is passed in as onOpen, because
// settings opens an anchored hint pop-over while other surfaces hand off elsewhere.
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
// Closing the login window without signing in returns you to the shelf; only a
// login that FAILED leaves something on screen. Same rule as connections.js --
// see afterLoginAttempt there for why it is a helper rather than a check written
// out at each call site.
function hzAfterLoginAttempt(data, show, close) {
  if (data && data.state === 'cancelled') { if (close) close(); return; }
  show(data);
}

function hzShowTileTip(row, label) {
  // NOT OVER ITS OWN OPEN CARD. The card names the source in its heading, so a
  // floating label repeating it is redundant, and it is positioned over the
  // shelf, which puts it on top of the card. `focus` shows this label as well as
  // hover, and closing a login WINDOW returns focus to the tile that opened it —
  // which is how a bare label ends up sitting on an already-open card without
  // the pointer having moved. Same fix as connections.js.
  const openCard = document.querySelector('.hint[data-id]');
  if (openCard && openCard.dataset.id === row.dataset.id) return;
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
  // Above the tile, not below (owner, 2026-08-25): the shelf lives at the
  // bottom of both panels, so a below-the-tile tip landed on the window's
  // bottom edge and clipped to its top half.
  hzTileTip.style.top = 'auto';
  hzTileTip.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
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
  // Stamped so the hover label can tell whether THIS tile's card is already open
  // — connections.js stamps the same pair for the same reason.
  row.dataset.id = src.id;

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
// `action` describes what needs doing now, not what a source is. Once a social
// bridge connects, /api/status clears action; routing on action alone then
// falls into the generic connector card and loses the account/workspace name.
const HZ_BRIDGES = new Set([
  'twitter', 'messenger', 'instagram', 'linkedin', 'discord', 'slack', 'telegram',
]);
// Markers follow the same contract as connections.js -- see the comment there:
//   ↗ leaves the app, ⧉ opens a window of this app, no marker = right here.
const HZ_IS_BRIDGE = (src) => src.action === 'bridge' || HZ_BRIDGES.has(HZ_KIND(src.id));
// Same grant the Settings shelf starts directly. Keeping this set beside the
// shared kind normalizer lets every surface make the same first-press decision.
const HZ_GOOGLE_AUTH = new Set(['mail', 'calendar']);

const HZ_FDA_HINT = {
  // ~~text: the sentence walking through the grant.~~ Yeeted (owner,
  // 2026-08-25), same call as the broken-branch steps: the link IS the
  // walkthrough — it opens the exact pane with the right row to switch on.
  text: '',
  url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  link: 'Open System Settings',
  local: true, // one per Mac; see connections.js
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
  imessage: HZ_FDA_HINT, photos: HZ_FDA_HINT, notes: HZ_FDA_HINT,
  // Contacts left the disk grant on 2026-08-24: it reads through the Contacts
  // framework now, on its own switch, so sending someone to Full Disk Access
  // for it points at the wrong pane entirely.
  contacts: { text: 'Allow Contacts for intaglio labs when it asks, or in System Settings → Privacy & Security → Contacts.' },
  files: { text: 'Sign in to iCloud Drive, Box, or Dropbox on this Mac — any one of them counts.' },
  calendar: { text: 'Connect your Google account on the connect page and approve read-only calendar access.' },
  // ~~"Create a 16-letter Google app password, then paste it on the connect
  // page", linking myaccount.google.com/apppasswords.~~ False since the
  // connector moved to OAuth (2026-08-26): there is no app password to make,
  // the page it pointed at no longer leads anywhere useful, and the form on
  // the connect page that would have accepted one is deleted. A hint that
  // describes a flow the product no longer has is worse than no hint — it
  // sends the owner off to do work that cannot succeed.
  mail: { text: '' },
  // granola left the sentence behind (owner, 2026-08-25): its panel is the
  // in-app walkthrough — open granola.ai, create a key, paste it right here.
  granola: { app: 'com.granola.app', url: 'https://granola.ai', link: 'Granola',
             walkthrough: true }, // the DESKTOP app first — the key lives in its settings
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
const HZ_HINT_FOR = (id) => (id.startsWith('mail:') ? HZ_HINTS.mail : HZ_HINTS[id]);
// HZ_WHY — the one-line what-this-reads subheader — was yeeted with its twin
// in connections.js (owner, 2026-08-25); the note there carries the reasoning.
const HZ_STAY = "data stored locally";
const HZ_NOTICES = {
  // See connections.js NOTICES.nobridge — the engine, not the connection.
  nobridge: 'the social bridge engine is not running — open Docker, then: bash ops/setup-bridges.sh',
  down: 'connect service unreachable — status unknown',
  auth: 'token mismatch — status unknown',
  noroute: 'connect service predates /api/status — status unknown',
  error: 'status unavailable',
  // The server said this platform has no cookie flow, so there is no embedded
  // login to open — its bridge wants a pasted token or a phone code instead.
  manual: 'this one links with a token, not a browser login — use the steps below.',
};

// See connections.js staleRefreshed — bounded, and module scope so it survives
// the rebuild a refresh causes.
const hzStaleRefreshed = new Set();

// `onClose` is how the CARD tells its HOST to close, and it matters because the
// two surfaces close differently: Settings drops one hint host, the People ring
// also clears the open row, the open id and the ring's own state. Emptying this
// node was enough for Settings and left the People panel holding an open,
// half-empty card -- the same close, done twice, disagreeing.
function hzConnectorHint(src, host, { refresh = () => {}, onClose = null, onBusy = null } = {}) {
  const tip = document.createElement('div');
  tip.className = 'hint';
  tip.dataset.id = src.id;
  const hint = HZ_HINT_FOR(src.id);

  // GOOGLE IS PARKED, and the shared card is where both surfaces read it from --
  // Settings says the same (owner, 2026-08-27). The OAuth path underneath is
  // untouched; this is one condition to delete when it ships.
  if (HZ_GOOGLE_AUTH.has(HZ_KIND(src.id)) && !src.connected) {
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    const soon = document.createElement('span');
    soon.className = 'setup';
    soon.textContent = 'coming soon';
    tip.append(head, soon);
    host.appendChild(tip);
    return tip;
  }

  // Non-bridge (and connected) connectors: why it matters, its status, the how.
  const renderTip = () => {
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    tip.appendChild(head);
    // Under the NAME, not the card's foot — same move as connections.js.
    const stay = document.createElement('span');
    stay.className = 'stay';
    stay.textContent = HZ_STAY;
    tip.appendChild(stay);
    if (src.disabled && src.action !== 'enable') {
      // TURNED OFF BY HAND, and not re-enablable from here: the marker belongs
      // to run.mjs --disable and the native action is deliberately not
      // authorized to remove it. Say so, rather than drawing the tile as a
      // source waiting to be connected and offering a sign-in that would change
      // nothing. The connect page has said "turned off" since 2026-08-26; this
      // shelf renders from the row's shape and could not tell.
      const off = document.createElement('span');
      off.className = 'stay';
      off.textContent = src.fix || 'turned off';
      tip.appendChild(off);
    } else if (src.disabled && src.action === 'enable') {
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
    } else if (hint && hint.walkthrough) {
      // The in-panel walkthrough — the same three steps as connections.js
      // (both copies corrected together, per the note on these tables).
      const open = document.createElement('button');
      open.className = 'hold-ok';
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
      step2.textContent = '2 · create an API key and copy it';
      const paste = document.createElement('textarea');
      paste.className = 'bpaste';
      paste.placeholder = '3 · paste the key here';
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
        hzPost('connectSecret', { p: HZ_KIND(src.id), value: val })
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
    } else if (hint) {
      if (hint.text) tip.append(hint.text + ' ');
      if (hint.url) {
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = hint.link + ' ↗';
        a.addEventListener('click', (e) => { e.preventDefault(); hzPost('openExternal', { url: hint.url }); });
        tip.appendChild(a);
      }
    }
  };

  // Social bridges: the in-popup login (Beeper-style window) + a manual paste
  // fallback. On a successful link, repaint the surface once.
  const renderBridge = (data) => {
    // Staleness, bounded to once per source — see connections.js renderBridge
    // for why the unbounded version loops.
    if (data && data.connected && !src.connected && !hzStaleRefreshed.has(src.id)) {
      hzStaleRefreshed.add(src.id);
      refresh();
    }
    tip.replaceChildren();
    tip.classList.add('hold');
    const head = document.createElement('b');
    head.textContent = src.label;
    tip.appendChild(head);
    // Under the NAME, not the card's foot — same move as connections.js.
    const stay = document.createElement('span');
    stay.className = 'stay';
    stay.textContent = HZ_STAY;
    tip.appendChild(stay);

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
      const acct = document.createElement('span');
      acct.className = 'acct';
      // The green dot already says connected. Use this line to name the actual
      // account/workspace, matching the Settings connector card.
      const whole = String(data.name || '').trim();
      const cut = whole.lastIndexOf(' - ');
      const tail = cut > 0 ? whole.slice(cut + 3) : '';
      if (whole) {
        acct.textContent = (cut > 0 && tail.includes('@')) ? whole.slice(0, cut) : whole;
        tip.appendChild(acct);
      }
    } else if (data && data.state !== 'ok' && data.state !== 'cancelled' && !manual && !data.transcript) {
      tip.append(HZ_NOTICES[data.state] || data.error || HZ_NOTICES.error);
    } else {
      // The bot's pending QUESTION, computed first because the log in button
      // below is hidden while one is outstanding (owner, 2026-08-25).
      // connections.js askedFor()/tidy() carries the full reasoning.
      const askText = (() => {
        const t = (data && Array.isArray(data.transcript)) ? data.transcript : [];
        for (let i = t.length - 1; i >= 0; i--) {
          if (t[i].from !== 'bot') continue;
          const body = String(t[i].body || '').trim();
          if (!body || body.startsWith('Login URL:') || body.includes('`{')) continue;
          const line = body.split('\n').map((l) => l.trim()).filter(Boolean)
            .find((l) => l.endsWith('?') || /^(please|enter|register|create|choose)\b/iu.test(l));
          if (!line) return null; // chatter, not a step: no question pending
          const m = /^please enter your\s+(.+)$/iu.exec(line);
          if (!m) return line;
          const field = m[1].replace(/\.$/u, '').trim();
          const verb = /^(create|enter|choose|register)\b/iu.exec(field);
          return verb
            ? `please ${verb[0].toLowerCase()} ${field.slice(verb[0].length).trim()} for ${src.label}`
            : `please enter your ${field} for ${src.label}`;
        }
        return null;
      })();
      if (manual) {
        const note = document.createElement('span');
        note.className = 'why';
        note.textContent = HZ_NOTICES.manual;
        tip.appendChild(note);
      } else {
      const login = document.createElement('button');
      login.className = 'hold-ok';
      login.textContent = 'log in ⧉';
      login.addEventListener('click', (e) => {
        e.stopPropagation();
        login.disabled = true; login.textContent = 'opening…';
        hzPost('bridgeWebLogin', { p: HZ_KIND(src.id) })
          .then((data) => hzAfterLoginAttempt(data, renderBridge, () => {
            // The HOST closes it. Emptying this node alone leaves the panel
            // around it open, which is what the People ring was doing.
            if (onClose) { onClose(); return; }
            tip.replaceChildren();
            tip.classList.remove('hold');
          }))
          .catch(() => { login.disabled = false; login.textContent = 'log in ⧉'; });
      });
      // Hidden while the bot is mid-question — see connections.js: pressing
      // it would cancel the login the question belongs to.
      if (!askText) tip.appendChild(login);
      }

      // ~~A 'cancelled' state appended "login window closed — tap to try
      // again."~~ Yeeted (owner, 2026-08-25): the card already shows the same
      // log in button either way, and the sentence squeezed in beside the
      // pill saying what the owner just did themselves.
      if (askText) {
        const line = document.createElement('span');
        line.className = 'setup';
        line.textContent = askText;
        tip.appendChild(line);
      }
      // Token (discord/slack) and phone (telegram) connectors keep the guided
      // conversation — it is their only way in. The cookie-paste fallback the
      // other platforms carried here ("having trouble? paste cookies
      // manually") was yeeted (owner, 2026-08-25), same call as in
      // connections.js: the webview login is the flow, not one of two.
      if (manual) {
        const adv = document.createElement('details');
        adv.open = true; // not "advanced" when it is the only way in
        const sum = document.createElement('summary');
        sum.className = 'why';
        sum.textContent = `link ${src.label} step by step`;
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
        paste.placeholder = 'paste what the bot asks for';
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
    }
  };

  const openBridge = () => {
    tip.replaceChildren(); tip.classList.add('hold');
    const head = document.createElement('b'); head.textContent = src.label;
    tip.append(head, 'checking…');
    hzPost('bridgeStatus', { p: HZ_KIND(src.id) }).then(renderBridge).catch(() => renderBridge({ state: 'down' }));
  };
  // ~~openBridgeLogin: put up a card reading "— opening login…", then started the
  // login.~~ Gone with the card (owner, 2026-08-27, third time of asking). The
  // press goes straight to the login now and the tile spins; see the block at
  // the bottom of this function.

  if (HZ_IS_BRIDGE(src) && !src.connected) {
    // NO CARD WHILE THE LOGIN OPENS.
    //
    // Pressing a bridge tile started the login AND put up a card saying
    // "— opening login…". The card was never the point: the login WINDOW is what
    // the press is for, and the card only described the wait. When the bridge
    // stack is unreachable that wait is the 22s bridgeCall timeout, so the panel
    // sat on a sentence about something that was not happening -- which is the
    // popup the owner asked three times to be rid of.
    //
    // So the press goes straight to the login. The tile carries the waiting
    // (onBusy), the way it already did in Settings, and a card is materialised
    // only when there is something to SAY: a failure. Cancelled says nothing,
    // because closing a window you opened needs no reply.
    if (onBusy) onBusy(true);
    const speak = (data) => {
      if (onBusy) onBusy(false);
      host.appendChild(tip);
      renderBridge(data);
    };
    hzPost('bridgeWebLogin', { p: HZ_KIND(src.id) })
      .then((data) => hzAfterLoginAttempt(data, speak, () => {
        if (onBusy) onBusy(false);
        if (onClose) onClose();
      }))
      .catch(() => speak({ state: 'down' }));
    return tip;
  }

  // Attach BEFORE rendering — the bridge openers finish async and paint into
  // this node, so it has to already be in the document.
  host.appendChild(tip);
  if (HZ_IS_BRIDGE(src)) {
    openBridge();
  } else {
    renderTip();
  }
  return tip;
}
