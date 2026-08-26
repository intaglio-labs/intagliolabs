// The connect page server. Loopback only, token in the path, Mac-only by
// design (owner decision: OAuth redirect rules make loopback the only URL
// Google will accept, so the browser doing this has to be on this machine).
//
// THREE THINGS GUARD THIS SERVER, and none of them is "it's on localhost":
//
//   1. The token in the path. 16 bytes, constant-time compared, expiring.
//   2. A Host allowlist. Binding 127.0.0.1 does NOT stop a page you visit
//      from firing requests at 127.0.0.1 — DNS rebinding points an
//      attacker-controlled name at loopback and the browser happily connects.
//      Rejecting any Host that is not localhost/127.0.0.1 is what stops it.
//      (ui/server/hermes.mjs documents the same threat.)
//   3. No CORS headers, ever. A cross-origin page may be able to POST here
//      blind, but it can never read a response it is not granted.
//
// Usage:  node connect/server.mjs [--port 51788] [--print-url]

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderConnectPage, renderHelpPage } from './lib/page.mjs';
import { renderMemoryPage } from './lib/memoryPage.mjs';
import { renderBridgePage } from './lib/bridgePage.mjs';
import { secretResponse } from './lib/secretApi.mjs';
import { PLATFORMS, bridgeStatus, beginCommand, beginLogin, loadPanel, relay } from './lib/bridge.mjs';
import { bridgeApiResponse } from './lib/bridgeApi.mjs';
import { decide, fetchPending } from './lib/memory.mjs';
import { mailAccounts, mailSecretName, readStatus } from './lib/status.mjs';
import { sameOrigin } from './lib/origin.mjs';
import { statusResponse } from './lib/statusApi.mjs';
import { mintToken, validateToken } from './lib/tokens.mjs';

const DEFAULT_PORT = 51788;
const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const PORT = portFlag !== -1 ? Number(argv[portFlag + 1]) : DEFAULT_PORT;

// Only these Hosts are served. Anything else is a rebinding attempt or a
// misconfiguration; either way it does not get a page.
//
// Seeded from the REQUESTED port and re-derived from the BOUND port once the
// socket is up (see server.listen below). With a fixed --port the two are the
// same and nothing changes; with `--port 0` — which is how tests should ask
// for a free port rather than hardcoding one and hoping — the requested port
// is 0 and an allowlist built from it would 403 every request, including the
// ones from the test that just started it.
let ALLOWED_HOSTS = allowedHostsFor(PORT);

function allowedHostsFor(port) {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

function send(res, status, body, type = 'text/html; charset=utf-8', { csp = null } = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // same-origin, not no-referrer: no-referrer makes the browser send
    // `Origin: null` on form navigations. The token is in the path, so the
    // referrer must still never reach a third party — same-origin gives both.
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    // The page is entirely inline and talks to nobody; say so, so a future
    // edit that adds a tracker or a CDN font fails loudly instead of shipping.
    // Per-response, because the review page needs a script and the credential
    // page must never have one. The default stays the strictest thing that
    // renders: no script at all.
    'Content-Security-Policy':
      csp ??
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

// Over the limit this stops BUFFERING but keeps DRAINING to 'end' and rejects
// there, so the 413 the caller writes goes out on a live, reusable socket.
// The obvious `reject + req.destroy()` is wrong: destroy kills the socket
// synchronously while reject only schedules a microtask, so the response was
// written to a socket that was already gone and the client saw ECONNRESET
// instead of a status code (ui/server/hermes.mjs documents the same trap on
// its readJson). Past a hard multiple of the cap the sender is not a form
// that mis-sized, and hanging up is the honest answer.
const HARD_CAP_MULTIPLE = 8;

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    let settled = false;
    let chunks = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (c) => {
      size += c.length;
      if (over) {
        if (size > limit * HARD_CAP_MULTIPLE) {
          finish(reject, new Error('body too large'));
          req.destroy();
        }
        return;
      }
      if (size > limit) {
        over = true;
        chunks = []; // not going to be parsed; stop holding it
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) finish(reject, new Error('body too large'));
      else finish(resolve, Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => finish(reject, error));
  });
}

// Renders the queue, or an honest failure. A page that cannot reach hermes
// says so; it never renders an empty queue, because "nothing to review" and
// "the store is unreachable" are opposite facts that look identical.
// "12,15,19" → [12, 15, 19]. Anything that is not a positive integer is dropped
// rather than failing the whole decision: one malformed id must not cost the
// owner the reading they just did.
function idList(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);
}

async function memoryPage(token, opts = {}) {
  // A fresh nonce per response. The review page is the ONLY page here that
  // runs script, and it runs exactly the one block below its own nonce --
  // no external source, no eval, and the credential page keeps default-src
  // 'none' with no script-src at all.
  const nonce = randomBytes(16).toString('base64');
  try {
    return { html: renderMemoryPage(await fetchPending(), { token, nonce, ...opts }), nonce };
  } catch (error) {
    return {
      html: renderMemoryPage({}, { token, nonce, ...opts, error: error?.message ?? String(error) }),
      nonce,
    };
  }
}

function memoryCsp(nonce) {
  return (
    "default-src 'none'; style-src 'unsafe-inline'; " +
    `script-src 'nonce-${nonce}'; connect-src 'self'; ` +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

async function sendMemoryPage(res, token, opts = {}) {
  const { html, nonce } = await memoryPage(token, opts);
  send(res, 200, html, 'text/html; charset=utf-8', { csp: memoryCsp(nonce) });
}

// Put the owner's own Telegram api_id/api_hash into that bridge's generated
// config, then start the container that has been refusing to run without them.
// Line replacement, not a YAML round trip: the generated config is ~700 lines
// of comments that a rewrite would flatten, and these two keys appear once.
// The container start is best-effort — docker may not be running, and the
// credentials are still saved either way, so the next setup-bridges run picks
// them up.
function writeBridgeConfig(bridge, { apiId, apiHash }) {
  const path = join(homedir(), '.hazlie', 'matrix', bridge, 'config.yaml');
  const text = readFileSync(path, 'utf8');
  const next = text
    .replace(/^(\s*api_id:).*$/mu, `$1 ${apiId}`)
    .replace(/^(\s*api_hash:).*$/mu, `$1 "${apiHash}"`);
  writeFileSync(path, next, { mode: 0o600 });
  try {
    execFileSync('docker', ['start', `hazlie-${bridge}`], { stdio: 'ignore', timeout: 15000 });
  } catch {
    // Not running, not installed, or already up — the credentials landed.
  }
}

function writeSecret(name, value) {
  const path = join(homedir(), '.hazlie', 'secrets', name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // explicit: writeFileSync mode is filtered by umask
  return path;
}

// Every request runs inside a try/catch, and the reason is specific rather
// than defensive habit: this handler is `async`, so anything it throws becomes
// an unhandled rejection, and an unhandled rejection terminates the process.
// One authenticated GET to /c/<token>/help/constructor did exactly that (see
// renderHelpPage) — and the launchd agent's KeepAlive brought the server back
// with a brand-new token in the log, so the request was a loop.
//
// The prototype bug is fixed at its source. This exists so the NEXT handler
// bug is a 500 for one caller instead of an outage for everyone, because a
// single-user loopback service that dies on a malformed path is a service that
// can be switched off by a mistyped URL.
const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    // No error text to the client: this is the owner's own machine, but the
    // message can carry a path or a token fragment and the page is HTML.
    console.error(`connect: request failed ${req.method} — ${String(error?.message ?? error)}`);
    if (!res.headersSent) send(res, 500, 'Something went wrong.', 'text/plain; charset=utf-8');
    else res.end();
  }
});

async function handleRequest(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    send(res, 403, 'Forbidden host.', 'text/plain; charset=utf-8');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /api/status — the desktop widget's read of the connector truth.
  // Dispatched here, ABOVE the /c/<token> regex: that gate 404s everything
  // it doesn't match, so a handler placed below it would be unreachable and
  // the 404 would read like a routing typo. Bearer-only (the widget's native
  // channel; see lib/statusApi.mjs), and no CORS header is ever emitted.
  //
  // CORRECTED 2026-08-22: this used to end "so a browser can neither send this
  // request nor read its response", and the first half is false. A page can
  // absolutely SEND it — a no-cors GET subresource (an <img>, a <script>, a
  // fetch with mode:'no-cors') carries no Origin header at all, so it sails
  // past the Origin tripwire rather than being caught by it. What a browser
  // cannot do is READ the response, because no CORS header is emitted, and it
  // cannot supply the bearer.
  //
  // THE BEARER IS WHAT MAKES THIS SAFE, not the absence of CORS. That
  // distinction matters because the sentence as written invites exactly one
  // wrong edit: relaxing the bearer on GET "since browsers can't reach it
  // anyway".
  if (url.pathname === '/api/status') {
    if (req.method !== 'GET') {
      send(res, 405, 'Method not allowed.', 'text/plain; charset=utf-8');
      return;
    }
    const { status, body } = statusResponse({
      origin: req.headers.origin,
      authorization: req.headers.authorization,
    });
    send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
    return;
  }

  // /api/secret — the widget's NATIVE channel for pasting a connector's API
  // key (the in-panel walkthrough; lib/secretApi.mjs carries the allowlist and
  // the rules). Above the /c/<token> gate like its siblings: that gate 404s
  // everything it doesn't match.
  if (url.pathname === '/api/secret') {
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      try {
        raw = await readBody(req, 16 * 1024);
      } catch {
        send(res, 413, JSON.stringify({ error: 'too large' }), 'application/json; charset=utf-8');
        return;
      }
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        send(res, 400, JSON.stringify({ error: 'bad json' }), 'application/json; charset=utf-8');
        return;
      }
    }
    const { status, body: out } = secretResponse({
      method: req.method,
      origin: req.headers.origin,
      authorization: req.headers.authorization,
      body,
      write: writeSecret,
      writeConfig: writeBridgeConfig,
    });
    send(res, status, JSON.stringify(out), 'application/json; charset=utf-8');
    return;
  }

  // /api/bridge[/begin|/cookies] — the widget's NATIVE channel for social-bridge
  // login (same bearer + Origin-less rules as /api/status). Above the /c/<token>
  // gate for the same reason: that gate 404s everything it doesn't match. Lets
  // the widget host the whole login flow in its own window, no browser.
  if (url.pathname === '/api/bridge' || url.pathname.startsWith('/api/bridge/')) {
    const subpath = url.pathname === '/api/bridge' ? '' : url.pathname.slice('/api/bridge/'.length);
    let body = {};
    if (req.method === 'POST') {
      // Size and parse failures answered apart, like /c/<token>/memory below:
      // one try around both used to diagnose an over-limit cookie paste as
      // "bad json". The 413 body is JSON because this channel's errors all are.
      let raw = '';
      try {
        raw = await readBody(req, 64 * 1024);
      } catch {
        send(res, 413, JSON.stringify({ error: 'too large' }), 'application/json; charset=utf-8');
        return;
      }
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        send(res, 400, JSON.stringify({ error: 'bad json' }), 'application/json; charset=utf-8');
        return;
      }
    }
    const { status, body: out } = await bridgeApiResponse({
      method: req.method,
      subpath,
      origin: req.headers.origin,
      authorization: req.headers.authorization,
      query: url.searchParams,
      body,
    });
    // Debug aid (removable): record every /api/bridge hit so we can see whether
    // the widget's native call is reaching us and how it resolved. Origin/auth
    // are reduced to booleans — never log the token or any cookie. Best-effort;
    // a logging failure must never break the request.
    if (process.env.HAZLIE_BRIDGE_LOG === '1') {
      try {
        const line =
          `${new Date().toISOString()} ${req.method} /api/bridge/${subpath || '(root)'}` +
          ` p=${url.searchParams.get('p') ?? (body && body.p) ?? '-'}` +
          ` origin=${req.headers.origin !== undefined} auth=${!!req.headers.authorization}` +
          ` -> ${status}\n`;
        appendFileSync(join(homedir(), '.hazlie', 'logs', 'connect-bridge.log'), line, { mode: 0o600 });
      } catch {}
    }
    send(res, status, JSON.stringify(out), 'application/json; charset=utf-8');
    return;
  }
  // /c/<token>            → the page
  // /c/<token>/gmail      → POST the app password
  // /c/<token>/memory     → GET the review queue, POST one decision
  const match = /^\/c\/([A-Za-z0-9_-]{1,64})(?:\/(gmail|memory|bridge|help\/[a-z]+))?\/?$/u.exec(
    url.pathname
  );
  if (!match) {
    send(res, 404, 'Not found.', 'text/plain; charset=utf-8');
    return;
  }

  const [, token, action] = match;
  if (!validateToken(token)) {
    // Same response for wrong, expired and revoked — a probe learns nothing
    // about which tokens ever existed.
    send(res, 404, 'This link is not valid. Open the app and ask for a new one.', 'text/plain; charset=utf-8');
    return;
  }

  // One decision per POST, by form navigation, so the page needs no JavaScript
  // at all — which keeps `default-src 'none'` intact and means the review
  // surface works with scripting off entirely.
  if (req.method === 'POST' && action === 'memory') {
    if (!sameOrigin(req.headers)) {
      send(res, 403, 'Cross-origin form post refused.', 'text/plain; charset=utf-8');
      return;
    }
    let claimId = NaN;
    let choice = '';
    // A GROUP decision. The queue merges claims that say the same thing, so one
    // reading answers for all of them — see ui/server/memory/group.mjs. Empty
    // for a single card, which is still the common case.
    let ids = [];
    // Two callers, one handler: the page's fetch (fast, no reload) and the
    // plain <form> that still works with scripting off. The form path is not
    // dead weight -- it is what makes the review surface survive a CSP change
    // or a browser that refuses the nonce.
    const wantsJson = /application\/json/u.test(req.headers['content-type'] ?? '');
    let raw = '';
    try {
      raw = await readBody(req);
    } catch {
      send(res, 413, 'Too large.', 'text/plain; charset=utf-8');
      return;
    }
    try {
      if (wantsJson) {
        const parsed = JSON.parse(raw);
        claimId = Number(parsed?.claim_id);
        choice = typeof parsed?.action === 'string' ? parsed.action : '';
        ids = idList(parsed?.claim_ids);
      } else {
        const form = new URLSearchParams(raw);
        claimId = Number(form.get('claim_id'));
        choice = form.get('action') ?? '';
        ids = idList(form.get('claim_ids'));
      }
    } catch {
      // Malformed JSON from the page's fetch — the caller's bug, not a size
      // problem. Leave the fields invalid so the "bad decision" 400 below
      // answers; this used to share the readBody catch and mislabel a parse
      // failure 413 "Too large.".
    }
    // Only the two the page offers. `retract` exists in the schema for an
    // accepted claim the owner later changes their mind about, and it is not
    // reachable from this queue -- everything here is undecided by definition.
    if (!Number.isInteger(claimId) || !['accept', 'reject'].includes(choice)) {
      if (wantsJson) {
        send(res, 400, JSON.stringify({ error: 'bad decision' }), 'application/json; charset=utf-8');
        return;
      }
      await sendMemoryPage(res, token, { banner: 'That decision made no sense. Nothing was recorded.' });
      return;
    }
    try {
      // The group's ids if the card carried any, else the one it names. Each
      // decision is its own row in claim_decision — grouping is a reading
      // convenience, and the record still says what was decided about every
      // individual claim.
      const targets = ids.length > 0 ? ids : [claimId];
      for (const target of targets) await decide(target, choice);
      if (wantsJson) {
        send(res, 200, JSON.stringify({ ok: true, claim_id: claimId, action: choice }), 'application/json; charset=utf-8');
        return;
      }
      await sendMemoryPage(res, token, { banner: `Claim ${claimId} ${choice}ed.` });
    } catch (error) {
      const message = error?.message ?? String(error);
      if (wantsJson) {
        send(res, 502, JSON.stringify({ error: message }), 'application/json; charset=utf-8');
        return;
      }
      await sendMemoryPage(res, token, { banner: `Nothing was recorded: ${message}` });
    }
    return;
  }

  if (req.method === 'POST' && action === 'gmail') {
    if (!sameOrigin(req.headers)) {
      send(res, 403, 'Cross-origin form post refused.', 'text/plain; charset=utf-8');
      return;
    }
    let value = '';
    let account = '';
    try {
      const form = new URLSearchParams(await readBody(req));
      value = form.get('appPassword') ?? '';
      account = form.get('account') ?? '';
    } catch {
      send(res, 413, 'Too large.', 'text/plain; charset=utf-8');
      return;
    }
    // The address must be one this machine is configured for. Accepting an
    // arbitrary string would let a form post choose the filename a secret is
    // written under, which is a path-traversal primitive dressed as a feature.
    const known = mailAccounts().some((a) => a.user === account);
    if (!known) {
      send(
        res,
        200,
        renderConnectPage(readStatus(), { token,
          banner: 'Unknown mailbox. Nothing was saved.',
        })
      );
      return;
    }
    // Google app passwords are 16 letters, usually shown in four groups.
    const normalized = value.replace(/\s+/gu, '');
    if (!/^[a-z]{16}$/iu.test(normalized)) {
      send(
        res,
        200,
        renderConnectPage(readStatus(), { token,
          banner: 'That does not look like a 16-letter Google app password. Nothing was saved.',
        })
      );
      return;
    }
    writeSecret(mailSecretName(account), normalized);
    send(res, 200, renderConnectPage(readStatus(), { token, banner: `${account} connected.` }));
    return;
  }

  // Social bridge login, relayed to the local bot. The message may be a cookie
  // blob (several KB), so the body limit is raised from the credential-form
  // default. Same-origin only, like every POST here — the cookies never leave
  // this machine, but a cross-origin page must not be able to drive the bridge.
  if (req.method === 'POST' && action === 'bridge') {
    if (!sameOrigin(req.headers)) {
      send(res, 403, 'Cross-origin form post refused.', 'text/plain; charset=utf-8');
      return;
    }
    let platformId = '';
    let msg = '';
    let begin = false;
    try {
      const form = new URLSearchParams(await readBody(req, 64 * 1024));
      platformId = form.get('p') ?? '';
      msg = form.get('msg') ?? '';
      begin = form.get('begin') === '1';
    } catch {
      send(res, 413, 'Too large.', 'text/plain; charset=utf-8');
      return;
    }
    const platform = PLATFORMS[platformId];
    if (!platform) {
      send(res, 404, 'Unknown platform.', 'text/plain; charset=utf-8');
      return;
    }
    let transcript = [];
    let banner = null;
    let error = false;
    if (begin) {
      // The "Begin login" button: cancel any stale login, then start fresh.
      try {
        ({ transcript } = await beginLogin(platformId));
      } catch (e) {
        banner = `bridge error: ${e?.message ?? e}`;
        error = true;
      }
    } else if (msg.trim().length === 0) {
      // Nothing to send — just re-show the panel rather than poking the bot.
      try {
        ({ transcript } = await loadPanel(platformId));
      } catch (e) {
        banner = `can't reach the bridge: ${e?.message ?? e}`;
        error = true;
      }
    } else {
      // A free-form message: the pasted cookies, or an answer to the bot.
      try {
        ({ transcript } = await relay(platformId, msg));
      } catch (e) {
        banner = `bridge error: ${e?.message ?? e}`;
        error = true;
      }
    }
    const status = bridgeStatus(platformId);
    if (status.connected && !error) {
      banner = `${platform.label} linked${status.name ? ` as ${status.name}` : ''}.`;
    }
    send(
      res,
      200,
      renderBridgePage(platform, { token, transcript, status, banner, error, begin: beginCommand(platformId) })
    );
    return;
  }

  if (req.method !== 'GET') {
    send(res, 405, 'Method not allowed.', 'text/plain; charset=utf-8');
    return;
  }

  // help/<id>. Before this existed the route matched and then fell through to
  // the page below, so every "How" button silently re-rendered the same page.
  // An unknown topic 404s rather than falling through, so a dead button fails
  // loudly here instead of looking like it worked.
  if (action === 'memory') {
    await sendMemoryPage(res, token);
    return;
  }

  // The social bridge login panel. Platform in the query (?p=messenger). When
  // already linked, the panel just says so; otherwise it loads the current
  // bot conversation so the owner can begin or continue login.
  if (action === 'bridge') {
    const platformId = url.searchParams.get('p') ?? '';
    const platform = PLATFORMS[platformId];
    if (!platform) {
      send(res, 404, 'Unknown platform.', 'text/plain; charset=utf-8');
      return;
    }
    const status = bridgeStatus(platformId);
    let transcript = [];
    let banner = null;
    let error = false;
    if (!status.connected) {
      try {
        ({ transcript } = await loadPanel(platformId));
      } catch (e) {
        banner = `can't reach the bridge: ${e?.message ?? e}`;
        error = true;
      }
    }
    send(
      res,
      200,
      renderBridgePage(platform, { token, transcript, status, banner, error, begin: beginCommand(platformId) })
    );
    return;
  }

  if (action?.startsWith('help/')) {
    const html = renderHelpPage(action.slice('help/'.length), { token });
    if (html === null) {
      send(res, 404, 'No help for that.', 'text/plain; charset=utf-8');
      return;
    }
    send(res, 200, html);
    return;
  }

  send(res, 200, renderConnectPage(readStatus(), { token }));
}

server.listen(PORT, '127.0.0.1', () => {
  // The port the kernel actually gave us, which differs from PORT only when
  // PORT was 0. Everything downstream — the Host allowlist, the printed URL —
  // uses this rather than the request, so `--port 0` produces a server that is
  // genuinely reachable instead of one that 403s itself.
  const bound = server.address().port;
  ALLOWED_HOSTS = allowedHostsFor(bound);
  console.log(`connect: listening on http://127.0.0.1:${bound} (loopback only)`);
  if (argv.includes('--print-url')) {
    // THE LINK GOES TO AN OWNER-ONLY FILE, NOT TO STDOUT.
    //
    // The token in that URL is the entire auth story for this server, and
    // stdout here is the launchd agent's StandardOutPath — a file that is
    // never rotated. Every restart appended another live credential in
    // cleartext; the log held fourteen of them when this was found.
    //
    // The audit's suggested fix was to drop --print-url from the plist. That
    // would have locked the owner out: this is the ONLY call site of
    // mintToken in the whole server, so the flag is not a convenience, it is
    // the sole way a link is ever created. Checked before changing it.
    //
    // So the channel stays and the credential moves to a 0600 file under
    // ~/.hazlie, which is where every other secret in this system lives. The
    // log keeps what is safe to keep: that a link was written, and when it
    // expires.
    const { token, expiresAt, superseded } = mintToken();
    const linkPath = join(homedir(), '.hazlie', 'connect-link.txt');
    mkdirSync(dirname(linkPath), { recursive: true, mode: 0o700 });
    writeFileSync(linkPath, `http://localhost:${bound}/c/${token}\n`, { mode: 0o600 });
    chmodSync(linkPath, 0o600);
    console.log(
      `connect: link written to ${linkPath} (expires ${new Date(expiresAt).toISOString()}` +
        `${superseded > 0 ? `, ${superseded} earlier link(s) revoked` : ''})`
    );
  }
});
