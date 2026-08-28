// The bridge-login panel, rendered as a string — Intaglio Labs' own surface for
// linking Messenger/Instagram, in place of a third-party Matrix client. Same
// "Terminal Palette v0.2" as the connect page, self-contained (no external
// requests), no script: every action is a same-origin form POST that reloads
// the panel, which keeps the strict CSP (`default-src 'none'`) intact.
//
// The transcript shows the bot's own words so the owner follows the real
// conversation. Their OWN messages are masked when they look like a cookie
// blob, so pasted Meta cookies are never echoed back into the page.

import { escapeHtml } from './page.mjs';

const C = {
  bg: '#141412',
  fg: '#eaeaea',
  muted: '#5c5c5c',
  secondary: '#8a8a8a',
  hazelnut: '#c5a56d',
  hazelnutLight: '#e5d6bb',
};

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: ${C.bg}; color: ${C.fg};
    font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    display: flex; justify-content: center; padding: 56px 20px;
  }
  ::selection { background: ${C.hazelnut}; color: ${C.bg}; }
  .wrap { width: 100%; max-width: 480px; position: relative; }
  .glow {
    position: absolute; inset: -40px -20px auto -20px; height: 240px;
    background: radial-gradient(ellipse 320px 220px at 82% 8%, rgba(229,214,187,0.14), transparent 65%);
    pointer-events: none;
  }
  .inner { position: relative; display: flex; flex-direction: column; gap: 18px; }
  .brand { font-size: 11px; color: ${C.muted}; letter-spacing: 0.08em; margin: 0; }
  a.brand { text-decoration: none; }
  a.brand:hover { color: ${C.secondary}; }
  h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { margin: 0; font-size: 13px; color: ${C.secondary}; line-height: 1.6; }
  .banner {
    padding: 12px 16px; border-radius: 12px; font-size: 12px;
    background: rgba(197,165,109,0.10); border: 1px solid rgba(197,165,109,0.30);
    box-shadow: inset 0 1px 0 rgba(229,214,187,0.25); color: ${C.hazelnutLight}; letter-spacing: 0.02em;
  }
  .banner.err { background: rgba(200,90,70,0.12); border-color: rgba(200,90,70,0.4); color: #e7b3a6; }
  .connected {
    padding: 16px 18px; border-radius: 16px; font-size: 13px;
    background: rgba(197,165,109,0.10); border: 1px solid rgba(197,165,109,0.30); color: ${C.hazelnutLight};
  }
  .log { display: flex; flex-direction: column; gap: 8px; margin: 0; }
  .msg {
    padding: 10px 13px; border-radius: 12px; font-size: 12.5px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word; max-width: 92%;
  }
  .msg.bot {
    align-self: flex-start; background: rgba(234,234,234,0.05);
    border: 1px solid rgba(234,234,234,0.12);
  }
  .msg.you {
    align-self: flex-end; background: rgba(197,165,109,0.12);
    border: 1px solid rgba(197,165,109,0.28); color: ${C.hazelnutLight};
  }
  .who { font-size: 10px; color: ${C.muted}; letter-spacing: 0.06em; margin-bottom: 3px; }
  form { display: flex; flex-direction: column; gap: 10px; margin: 0; }
  textarea {
    width: 100%; min-height: 92px; resize: vertical; padding: 12px 14px; border-radius: 12px;
    background: rgba(10,10,10,0.45); border: 1px solid rgba(234,234,234,0.12);
    color: ${C.fg}; font-family: inherit; font-size: 12.5px; line-height: 1.5;
  }
  textarea::placeholder { color: #3a3a3a; }
  textarea:focus { outline: none; border-color: rgba(197,165,109,0.5); }
  .cta {
    min-height: 44px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 999px; font-size: 13px; font-family: inherit; appearance: none; border: 0; cursor: pointer;
    background: linear-gradient(180deg, ${C.hazelnutLight} 0%, ${C.hazelnut} 100%);
    color: ${C.bg}; font-weight: 600; padding: 11px 24px; text-decoration: none;
  }
  .cta:hover { filter: brightness(1.06); }
  .cta.secondary {
    background: rgba(197,165,109,0.08); border: 1px solid rgba(197,165,109,0.35);
    color: ${C.hazelnut}; font-weight: 500;
  }
  .cta.secondary:hover { background: rgba(197,165,109,0.18); }
  .steps { font-size: 11px; color: ${C.muted}; line-height: 1.8; margin: 0; padding-left: 18px; }
  .steps code { color: ${C.hazelnutLight}; }
  .divider { border: 0; border-top: 1px solid rgba(234,234,234,0.08); margin: 2px 0; }
  .foot { font-size: 11px; color: ${C.muted}; letter-spacing: 0.02em; margin: 2px 0 0; }
`;

// INVERTED, on purpose (2026-08-22). Everything the owner SENDS during a
// bridge login is treated as a secret and masked — EXCEPT the short list of
// non-secret bot commands. The old version masked only what it recognised (a
// Meta-only cookie-name list), which meant every platform added after it
// leaked verbatim: X's `auth_token=…; ct0=…`, Slack's `xoxc-…; xoxd-…`, a bare
// Discord token, a Telegram login code — none matched, all rendered in
// plaintext in the transcript. A closed allow-list of secrets is wrong the
// same way twice; defaulting to masked covers a platform added next year on
// the day it lands, and it fails in the harmless direction (the worst case is
// a masked `help`). Bot messages are never passed here — only `from: 'you'`.
const SAFE_COMMANDS =
  /^(?:![a-z]+\s+)?(?:login(?:[\s-][a-z]+)?|logout|cancel|help|ping|reconnect|set-management-room|logins?|list-logins)\s*$/iu;
export function maskOwn(body) {
  const trimmed = String(body ?? '').trim();
  if (trimmed === '') return body;
  // A plain bot command (login / login cookies / login-token / cancel / help
  // / set-management-room …), optionally prefixed like `!fb`. Anything else
  // the owner typed is a credential, a phone number, or a code — masked.
  if (SAFE_COMMANDS.test(trimmed)) return body;
  return '‹sent — hidden here on purpose›';
}

function renderLog(transcript) {
  if (!transcript || transcript.length === 0) return '';
  const rows = transcript
    .map((m) => {
      const body = m.from === 'you' ? maskOwn(m.body) : m.body;
      return `<div class="msg ${m.from}"><div class="who">${m.from === 'you' ? 'you' : 'bridge'}</div>${escapeHtml(
        body
      ).slice(0, 2000)}</div>`;
    })
    .join('');
  return `<div class="log">${rows}</div>`;
}

// state.connected → the linked account view. Otherwise the login conversation:
// a Begin/restart button, the transcript, a paste box, and the cookie steps.
export function renderBridgePage(
  platform,
  { token, transcript = [], banner = null, error = false, status = {}, begin = platform.initial } = {}
) {
  const base = `/c/${token}`;
  const action = `${base}/bridge`;

  const bannerHtml = banner
    ? `<div class="banner${error ? ' err' : ''}">${escapeHtml(banner)}</div>`
    : '';

  const body = status.connected
    ? `<div class="connected">✓ ${escapeHtml(platform.label)} is linked${
        status.name ? ` as <b>${escapeHtml(status.name)}</b>` : ''
      }.<br>your DMs are syncing in.</div>
       <a class="cta secondary" href="${escapeHtml(base)}">← back to connect</a>`
    : `<p class="sub">this happens entirely on your Mac — your cookies go to the local bridge and nowhere else.</p>
       ${renderLog(transcript)}
       <form method="post" action="${escapeHtml(action)}">
         <input type="hidden" name="p" value="${escapeHtml(platform.id)}">
         <input type="hidden" name="begin" value="1">
         <input type="hidden" name="msg" value="${escapeHtml(begin)}">
         <button class="cta secondary" type="submit">${
           transcript.length ? 'Restart login' : 'Begin login'
         }</button>
       </form>
       <hr class="divider">
       <ol class="steps">
         <li>Click <b>Begin login</b> above — the bridge will ask for cookies.</li>
         <li>In a browser tab on <code>${escapeHtml(platform.site)}</code> (logged in), open devtools
             (⌥⌘I) → <b>Network</b> → type <code>graphql</code> in the filter → click a request →
             <b>right-click → Copy → Copy as cURL</b>.</li>
         <li>Paste it below and send.</li>
       </ol>
       <form method="post" action="${escapeHtml(action)}">
         <input type="hidden" name="p" value="${escapeHtml(platform.id)}">
         <textarea name="msg" placeholder="paste your Copy-as-cURL here (or type an answer to the bridge)…"
                   autocomplete="off" spellcheck="false" required></textarea>
         <button class="cta" type="submit">Send to bridge</button>
       </form>
       <a class="foot" href="${escapeHtml(base)}" style="text-decoration:none">← back to connect</a>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Connect ${escapeHtml(platform.label)} · intaglio labs</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="${C.bg}">
<style>${STYLE}</style></head>
<body><div class="wrap"><div class="glow"></div><div class="inner">
  <a class="brand" href="${escapeHtml(base)}">INTAGLIO LABS / CONNECT</a>
  ${bannerHtml}
  <h1>Connect ${escapeHtml(platform.label)}</h1>
  ${body}
</div></div></body></html>`;
}
