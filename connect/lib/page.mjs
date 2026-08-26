// The connect page, rendered as a string. Pure: state in, HTML out, so the
// markup is assertable in a test and the server stays a transport.
//
// Everything is inline — no CDN, no external font, no analytics. A page whose
// job is to accept a credential has no business opening a socket to anyone,
// and on a machine whose whole thesis is local-first it would be absurd.
//
// DESIGN: "Terminal Palette v0.2" (Claude Design, imported 2026-08-19).
// Terminal-born, maximum minimalist. One background, one foreground, one
// accent. Dark only — there is deliberately no light theme to match.
//
// THE ONE DEVIATION, and why: the design names IBM Plex Mono as "the only
// typeface", served from Google Fonts. This page sends
// `default-src 'none'` and accepts an app password, so fetching a font would
// both break the no-external-requests property documented above and tell
// Google when the owner opened their credential page. The stack below is the
// system-mono ladder with Plex first, so the design's face is used wherever
// it happens to be installed and nothing is fetched when it is not.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Applied to every interpolation, with ONE exception: HELP `body` paragraphs
// in renderHelpPage are trusted static HTML authored in this file and are
// interpolated raw (see the note on HELP). None of today's values are
// attacker-controlled, but "none of them are, today" is how injection arrives
// — so nothing dynamic may ever join that exception.
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (c) => ESCAPES[c]);
}

// Straight from the palette. Named rather than inlined so a colour can only
// change in one place, and so the roles stay legible: gray-500 is "muted
// labels", not "the grey I picked for that line".
const C = {
  bg: '#141412', // char — soft black, the default base tone
  fg: '#eaeaea', // signal — foreground
  hairline: '#1c1c1c', // gray-900
  disabled: '#3a3a3a', // gray-700
  muted: '#5c5c5c', // gray-500 — muted labels
  secondary: '#8a8a8a', // gray-300 — secondary text
  hazelnut: '#c5a56d', // warm accent — surfaces, marks
  hazelnutLight: '#e5d6bb', // gradient end — highlights
};

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    background: ${C.bg}; color: ${C.fg};
    /* Plex first where installed; nothing is fetched when it is not. */
    font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    display: flex; justify-content: center;
    padding: 56px 20px;
  }
  ::selection { background: ${C.hazelnut}; color: ${C.bg}; }

  .wrap { width: 100%; max-width: 420px; position: relative; }
  /* The single permitted glow, from the design's connect screen. */
  .glow {
    position: absolute; inset: -40px -20px auto -20px; height: 280px;
    background: radial-gradient(ellipse 320px 240px at 82% 8%, rgba(229,214,187,0.14), transparent 65%);
    pointer-events: none;
  }
  .inner { position: relative; display: flex; flex-direction: column; gap: 20px; }

  /* LABEL 11 — caps, tracked. */
  .brand { font-size: 11px; color: ${C.muted}; letter-spacing: 0.08em; margin: 0; }
  h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.25; }
  .sub { margin: 0; font-size: 13px; color: ${C.secondary}; }
  .head { display: flex; flex-direction: column; gap: 10px; }

  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }

  /* Liquid glass: the surface the design uses for every row. */
  li {
    display: flex; align-items: center; gap: 14px;
    background: rgba(234,234,234,0.04);
    backdrop-filter: blur(24px) saturate(1.4);
    -webkit-backdrop-filter: blur(24px) saturate(1.4);
    border: 1px solid rgba(234,234,234,0.12);
    border-radius: 16px;
    box-shadow: inset 0 1px 0 rgba(234,234,234,0.10);
    padding: 16px 18px;
  }
  li.soon { opacity: 0.55; }

  .idx { font-size: 12px; color: ${C.muted}; min-width: 26px; align-self: flex-start; padding-top: 12px; }
  .name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name b { font-size: 15px; font-weight: 500; display: block; }
  .name .note { font-size: 11px; color: ${C.muted}; }

  /* 44px minimum on every control — the design sets it on both the label and
     the button so a row's height does not jump when its state changes. */
  .cta, .ok, .soon-pill {
    min-height: 44px; box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 999px; font-size: 13px;
    font-family: inherit; text-decoration: none; white-space: nowrap;
  }
  /* The one permitted gradient. */
  .cta {
    appearance: none; border: 0; cursor: pointer;
    background: linear-gradient(180deg, ${C.hazelnutLight} 0%, ${C.hazelnut} 100%);
    color: ${C.bg}; font-weight: 600; padding: 11px 24px;
  }
  .cta:hover { filter: brightness(1.06); }
  .cta.secondary {
    background: rgba(197,165,109,0.08);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(197,165,109,0.35);
    color: ${C.hazelnut}; font-weight: 500; padding: 10px 24px;
  }
  .cta.secondary:hover { background: rgba(197,165,109,0.18); color: ${C.hazelnutLight}; filter: none; }
  .soon-pill { border: 1px solid rgba(234,234,234,0.10); color: ${C.muted}; padding: 10px 20px; }
  .ok { color: ${C.hazelnut}; font-size: 12px; letter-spacing: 0.04em; padding: 10px 4px; }

  form { display: flex; flex-direction: column; gap: 10px; width: 100%; margin: 6px 0 0; }
  input {
    width: 100%; padding: 12px 14px; border-radius: 12px;
    background: rgba(10,10,10,0.45);
    border: 1px solid rgba(234,234,234,0.12);
    color: ${C.fg}; font-family: inherit; font-size: 13px;
  }
  input::placeholder { color: ${C.disabled}; }
  input:focus { outline: none; border-color: rgba(197,165,109,0.5); }
  .hint { font-size: 11px; color: ${C.muted}; line-height: 1.7; }

  /* Help pages: the sub paragraphs stack, so they need the leading the
     one-line connect subtitle never did, and a command needs to be
     selectable without wrapping mid-token. */
  .inner > .sub { line-height: 1.7; margin: 0 0 14px; }
  .code {
    margin: 0 0 18px; padding: 12px 14px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(229,214,187,0.18); border-radius: 10px;
    font: inherit; font-size: 12px; color: ${C.hazelnutLight};
    overflow-x: auto; white-space: pre; user-select: all;
  }
  .caveat { font-size: 11px; color: ${C.muted}; line-height: 1.7; margin-top: 6px; }

  /* Intaglio Labs' voice, not a section label — lowercase like the welcome. */
  .foot { font-size: 11px; color: ${C.muted}; letter-spacing: 0.02em; margin: 4px 0 0; }
  .banner {
    padding: 12px 16px; border-radius: 12px; font-size: 12px;
    background: rgba(197,165,109,0.10);
    border: 1px solid rgba(197,165,109,0.30);
    box-shadow: inset 0 1px 0 rgba(229,214,187,0.25);
    color: ${C.hazelnutLight}; letter-spacing: 0.02em;
  }

  /* The row stacks below the glass width where a button beside a form would
     crush both. */
  li.has-form { flex-direction: row; align-items: flex-start; }
  @media (max-width: 380px) {
    li { flex-wrap: wrap; }
    .cta, .soon-pill, .ok { width: 100%; }
  }
`;

// Absolute, and it must stay absolute. The page is served at /c/<token> with
// NO trailing slash, so a relative action like "gmail" resolves against the
// directory /c/ and posts to /c/gmail — dropping the token and 404ing. This
// bit once; the test below pins it.
function row(item, index, formBase) {
  const n = `[${index + 1}]`;
  const idx = `<span class="idx">${n}</span>`;

  if (item.soon) {
    return `<li class="soon">${idx}<span class="name"><b>${escapeHtml(
      item.label
    )}</b><span class="note">${escapeHtml(
      item.detail
    )}</span></span><span class="soon-pill">Soon</span></li>`;
  }
  if (item.connected) {
    return `<li>${idx}<span class="name"><b>${escapeHtml(
      item.label
    )}</b><span class="note">${escapeHtml(
      item.detail
    )}</span></span><span class="ok">connected</span></li>`;
  }

  const caveat = item.caveat ? `<div class="caveat">${escapeHtml(item.caveat)}</div>` : '';

  // ~~Two form branches here: an address field that POSTed to /mailbox, and an
  // app-password field that POSTed to /gmail.~~ Both deleted with the app
  // password (2026-08-26). Mail is a Google grant now, so its row is an
  // ordinary Connect button like Calendar's — same account, same consent
  // screen, nothing to type on this page. The forms' routes are gone from
  // server.mjs in the same commit.

  // Outline, not the gradient. This row is `optional` — it is a standing
  // invitation rather than outstanding work — so it is excluded from
  // firstActionable above, and a filled button here would put two accents on a
  // page whose stated rule is one. (The app-password form below keeps its
  // filled button: by the time it renders, an address has been added and
  // finishing it IS the outstanding work.)

  // Primary gradient for the first actionable row, hazelnut outline after it:
  // the design permits one filled button per view.
  const primary = item.primary === true;
  const label = item.action === 'fda' ? 'How' : 'Connect';
  // The social bridges open Intaglio Labs' OWN login panel (/bridge?p=…), not a help
  // page — the whole point is that linking happens in this surface. Everything
  // else links to its help topic at /help/<id>.
  const href =
    item.action === 'bridge'
      ? `${escapeHtml(formBase)}/bridge?p=${escapeHtml(item.id)}`
      : `${escapeHtml(formBase)}/help/${escapeHtml(item.id)}`;
  return `<li>${idx}<span class="name"><b>${escapeHtml(item.label)}</b><span class="note">${escapeHtml(
    item.detail
  )}</span>${caveat}</span>
    <a class="cta${primary ? '' : ' secondary'}" href="${href}">${label}</a></li>`;
}

export function renderConnectPage(items, { banner = null, token = null } = {}) {
  // `optional` rows are standing invitations rather than outstanding work —
  // "add another mailbox" is never finished, and counting it would mean this
  // number never reaches zero and the page never says "all set".
  const remaining = items.filter((i) => !i.connected && !i.soon && !i.optional).length;
  const formBase = token === null ? '' : `/c/${token}`;
  // One filled button per view, per the palette's "one accent" rule: the
  // first row that needs an action gets it, the rest are outlines.
  const firstActionable = items.findIndex((i) => !i.connected && !i.soon && !i.optional);
  const decorated = items.map((item, i) => ({ ...item, primary: i === firstActionable }));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Connect · intaglio labs</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="${C.bg}">
<style>${STYLE}</style></head>
<body><div class="wrap"><div class="glow"></div><div class="inner">
  <p class="brand">INTAGLIO LABS / CONNECT</p>
  ${banner ? `<div class="banner">${escapeHtml(banner)}</div>` : ''}
  <div class="head">
    <h1>Connect your accounts</h1>
    <p class="sub">private &amp; personalized AI</p>
  </div>
  <ul>${decorated.map((item, i) => row(item, i, formBase)).join('')}</ul>
  <p class="foot">${
    remaining === 0
      ? '&rsaquo; all set — progress lands back in your texts'
      : `&rsaquo; ${remaining} left · progress lands back in your texts`
  }</p>
      <!-- The review queue. It has always been served at /c/&lt;token&gt;/memory and
           nothing has ever linked to it, so distilled claims piled up in a page
           nobody could find — and every question kept answering "nothing in what
           i've got covers that " while they sat there. -->
      ${token === null ? '' : `<p class="foot"><a href="${escapeHtml(formBase)}/memory">&rsaquo; review what i have learned</a></p>`}
</div></div></body></html>`;
}

// The help topics behind the "How" / "Connect" buttons.
//
// These existed as dead links until 2026-08-20: the server's route matched
// `help/<id>` and then fell through to re-rendering the connect page, so the
// button appeared to do nothing. That was survivable while Calendar was the
// only row that could ask for Full Disk Access; a `full` install has three.
//
// Every step here is the runbook in ops/CONNECTORS.md, not a paraphrase — if
// the two drift, the runbook is right and this is the bug.
//
// `body` and `after` paragraphs are interpolated as RAW HTML — help prose
// deliberately carries inline markup like <em> and pre-encoded entities —
// while `code` goes through escapeHtml, because shell text is full of `>` and
// `&&` that HTML would swallow. The rule is about provenance, not the field:
// every string here must stay static text authored in this file, and a
// runtime value (an account name, a path from config) must never be spliced
// into one.
const HELP = {
  fda: {
    title: 'Give intaglio labs permission to read',
    body: [
      'macOS keeps Messages, Photos and Notes behind Full Disk Access. Switch on intaglio labs and everything it reads on this Mac is covered by that one grant.',
      'Open System Settings → Privacy &amp; Security → Full Disk Access. Press +, then ⌘⇧G, and paste this path:',
    ],
    code: 'intaglio labs',
    after: [
      'Toggle it on. That is the whole grant — one file, once.',
      'If this page still shows a cross afterwards, that is expected and not a failure: macOS ties the permission to whatever started the program, so a page you launched from a terminal will be refused even when the grant is real. The background service that does the actual reading has it.',
    ],
  },
  calendar: {
    title: 'Connect Google Calendar',
    body: ['Run this in a terminal in the repo. It opens Google in your browser and writes the tokens to this Mac only.'],
    code: 'node ops/gcal-auth.mjs',
    after: ['Nothing is stored anywhere but ~/.hazlie/secrets on this machine.'],
  },
  oura: {
    title: 'Connect Oura',
    body: ['Run this in a terminal in the repo, then approve the scopes in your browser.'],
    code: 'node ops/oura-auth.mjs',
    after: ['Sleep, readiness and activity land locally. Nothing is sent onward.'],
  },
  notion: {
    title: 'Connect Notion',
    body: [
      'Notion integrations start with access to <em>nothing</em>. You create one, then share individual pages or databases with it — so intaglio labs sees exactly what you hand it and not a page more.',
      'Create an internal integration at notion.so/my-integrations, copy its token, then save it to this Mac:',
    ],
    code: '(umask 077; pbpaste > ~/.hazlie/secrets/notion-api-key.txt)',
    after: [
      'Then open a page in Notion, and use its ••• menu → Connections → your integration. Nothing is read until you do; an empty first run is normal, not a failure.',
    ],
  },
  whatsapp: {
    title: 'Connect WhatsApp',
    body: [
      'No bridge and no login here — WhatsApp Desktop already keeps your history on this Mac. Install WhatsApp from the Mac App Store, open it, and link it to your phone (WhatsApp on your phone → Settings → Linked Devices → Link a Device, then scan the code).',
      'That is all. intaglio labs reads the local store the app keeps; nothing new leaves this machine.',
    ],
    code: null,
    after: [
      'One thing to know: the desktop app only syncs while it is open, so leave it running (or open it now and then) to keep WhatsApp fresh. Everything stays on this Mac.',
    ],
  },
  // ~~linkedin: request the export, unzip Connections.csv into
  // ~/.hazlie/imports/linkedin.~~ Gone with the export (owner, 2026-08-25):
  // LinkedIn logs in through the bridge now, like every other social source.
  files: {
    title: 'Your cloud folders',
    body: [
      'intaglio labs reads the iCloud Drive, Box and Dropbox folders this Mac already syncs. There is no account to connect and nothing leaves the machine — if the folders are there, it can read them.',
      'It records what your files are called and where they live. It does <em>not</em> download files that are stored online-only: on this Mac that would pull tens of gigabytes through your iCloud account, so it never opens them.',
    ],
    code: null,
    after: [
      'Files in folders named for keys or secrets, and files that look like credentials, are <em>skipped entirely</em>.',
    ],
  },
  granola: {
    title: 'Connect Granola',
    body: ['Granola issues a personal API key from its settings. Save it to this Mac by writing it to the file the connector reads — the umask keeps it owner-only, which the connector checks before it will use it:'],
    code: '(umask 077; pbpaste > ~/.hazlie/secrets/granola-api-key.txt)',
    after: ['Copy the key first; that command reads it from the clipboard so it never lands in your shell history.'],
  },
};

// Rows share a topic: the three Apple stores all want the same one grant, so
// they get the same page rather than three near-identical ones.
export function helpTopicFor(id) {
  if (id === 'imessage' || id === 'photos' || id === 'notes') return 'fda';
  return id;
}

export function renderHelpPage(id, { token = null } = {}) {
  // Object.hasOwn, not a truthiness check on the lookup.
  //
  // `HELP[...]` walks the prototype chain, so /help/constructor returned
  // Object.prototype.constructor — a function, therefore truthy, therefore
  // past the `!topic` guard — and then `topic.body.map(...)` threw on
  // undefined. Same for toString, valueOf, hasOwnProperty and __proto__.
  //
  // Thrown inside connect's async request handler, with no uncaughtException
  // handler, that KILLED THE SERVER. Under the launchd agent's KeepAlive it
  // came straight back, and because the agent passed --print-url it minted a
  // fresh 24-hour token into the log on every start. So one authenticated GET
  // was a loop that took the service down and produced a new live credential
  // in cleartext each time round.
  const key = helpTopicFor(id);
  const topic = typeof key === 'string' && Object.hasOwn(HELP, key) ? HELP[key] : null;
  if (!topic) return null;
  const back = token === null ? '/' : `/c/${token}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(topic.title)} · intaglio labs</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="${C.bg}">
<style>${STYLE}</style></head>
<body><div class="wrap"><div class="glow"></div><div class="inner">
  <p class="brand">INTAGLIO LABS / CONNECT</p>
  <div class="head">
    <h1>${escapeHtml(topic.title)}</h1>
  </div>
  ${topic.body.map((p) => `<p class="sub">${p}</p>`).join('')}
  ${topic.code ? `<pre class="code">${escapeHtml(topic.code)}</pre>` : ''}
  ${(topic.after ?? []).map((p) => `<p class="sub">${p}</p>`).join('')}
  <p class="foot"><a class="cta secondary" href="${escapeHtml(back)}">Back</a></p>
</div></div></body></html>`;
}
