// Talking to the social bridge bots from Hazlie's own connect page — so the
// owner links Messenger/Instagram inside a surface they trust, never a
// third-party Matrix client.
//
// The bridge login is a short conversation with a bot in a Matrix room: send
// `login <flow>`, the bot asks for cookies, you paste them, it reports success.
// This module is a thin, honest RELAY of that conversation: it does not
// hardcode the bot's state machine, it just carries messages both ways and
// hands back the transcript. That makes it robust to whatever the bridge asks
// (a flow list, a 2FA prompt, an error) — the page shows the bot's own words.
//
// Everything is loopback: the bridge homeserver is 127.0.0.1:8008, and the
// owner's Meta cookies go browser → this page → the local bot → Meta, never
// off the machine except the bridge's own authenticated link to Meta (which is
// the point). All reads of the bridge's own database are read-only.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const matrixDir = (home) => join(home, '.hazlie', 'matrix');

// THE WEB-LOGIN POLICY LIVES HERE AND ONLY HERE (added 2026-08-23).
//
// `webLogin` says whether a platform can be linked by driving its real login
// page in an embedded webview and harvesting session cookies -- and, when it
// can, which hosts that flow may navigate to and which cookie means "logged
// in". BridgeLogin.swift ENFORCES this; it no longer authors it.
//
// It used to author it: allowedSuffixes was hardcoded to Meta's four hosts in
// Swift while this table advertised a loginUrl for six platforms, and
// connector-tile.js fired the web login for any bridge tile without checking.
// So X, Discord, Slack and Telegram opened a branded window, had their first
// navigation cancelled by a fence that had never heard of them, and sat blank
// until the owner closed it -- no error, and a cookie poll that could never
// fire. Two copies of one decision, four platforms out of date.
//
// Note WHY the four are absent rather than merely unlisted: Discord and Slack
// are token logins (`login-token` -- you paste the account token the bot asks
// for) and Telegram logs in by phone. None of the three can consume harvested
// cookies at all, so the right answer is not a wider fence, it is not offering
// the flow. Their `loginUrl` stays as the page a person opens themselves.
//
// The platforms this page can link, and everything that differs between
// them. `initial` is the first command that starts login: Messenger lists four
// flows so we pick `facebook` (cookies from an existing session — the low-risk
// path); Instagram has a single flow; X names its cookie flow `cookies`.
export const PLATFORMS = Object.freeze({
  messenger: {
    id: 'messenger',
    label: 'Messenger',
    bot: '@facebookbot:hazlie.local',
    dir: 'meta',
    db: 'meta/mautrix-meta.db',
    // The bare login command. `facebook` = cookies from an existing session,
    // the low-risk flow. Prefixed with the bridge's command_prefix at send
    // time so it works in any room, not only the bot's management room.
    initial: 'login facebook',
    prefix: '!fb', // fallback if config can't be read
    site: 'facebook.com',
    // For the widget's in-app (Beeper-style) login: the page to load in the
    // embedded webview, and the cookie domain to harvest once the user is in.
    // The bot also emits a "Login URL:" line we prefer at runtime; these are
    // the stable defaults.
    loginUrl: 'https://www.facebook.com/login/',
    cookieDomain: 'facebook.com',
    // Meta's login bounces across its own properties (account center, 2FA),
    // so the flow needs all three; `c_user` appearing means the session is up.
    webLogin: { allowedHosts: ['facebook.com', 'messenger.com', 'meta.com'], sessionCookie: 'c_user' },
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    bot: '@instagrambot:hazlie.local',
    dir: 'instagram',
    db: 'instagram/mautrix-instagram.db',
    initial: 'login',
    prefix: '!ig',
    site: 'instagram.com',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    cookieDomain: 'instagram.com',
    // Instagram's login can hand off to Meta's account center mid-flow.
    webLogin: { allowedHosts: ['instagram.com', 'facebook.com', 'meta.com'], sessionCookie: 'sessionid' },
  },
  // Owner-gated in SOCIAL-BRIDGES-PLAN.md ("accept the account risk");
  // Owner said go, 2026-08-22. mautrix-twitter, same megabridge family —
  // the cookie flow wants auth_token + ct0 from a logged-in x.com session.
  twitter: {
    id: 'twitter',
    label: 'X',
    bot: '@twitterbot:hazlie.local',
    dir: 'twitter',
    db: 'twitter/mautrix-twitter.db',
    initial: 'login cookies',
    prefix: '!tw',
    site: 'x.com',
    loginUrl: 'https://x.com/login',
    cookieDomain: 'x.com',
    // twitter.com still redirects to x.com and some flows land there first.
    // ~~auth_token is the session cookie; the bridge also wants ct0, which the
    // whole-domain harvest picks up alongside it.~~ It did not, reliably: X
    // sets auth_token at login completion and ct0 (its CSRF token) on its own
    // schedule, so a harvest triggered by auth_token alone could snapshot
    // before ct0 existed — the bot then answered "Missing some keys: [ct0]"
    // (owner hit this 2026-08-25, first live login after the runtime rebuild).
    // requiredCookies is the fix: the login window finishes only when every
    // listed cookie is present, not when the first one is.
    webLogin: { allowedHosts: ['x.com', 'twitter.com'], sessionCookie: 'auth_token',
                requiredCookies: ['auth_token', 'ct0'] },
  },
  // Telegram, Discord, Slack (owner asked, 2026-08-22). Telegram logs in by
  // PHONE (the bot sends a code to the Telegram app), not cookies — so it
  // carries no cookieDomain, and it additionally needs an api_id/api_hash in
  // ~/.hazlie/matrix/telegram/config.yaml (my.telegram.org/apps) before its
  // container will even start. Discord and Slack are token logins: paste the
  // account token the bot asks for.
  telegram: {
    id: 'telegram',
    label: 'Telegram',
    bot: '@telegrambot:hazlie.local',
    dir: 'telegram',
    db: 'telegram/mautrix-telegram.db',
    initial: 'login',
    prefix: '!tg',
    site: 'telegram.org',
    loginUrl: 'https://web.telegram.org/',
    cookieDomain: null,
    // Phone login: the bot sends a code to the Telegram app. No cookie flow.
    webLogin: null,
  },
  discord: {
    id: 'discord',
    label: 'Discord',
    bot: '@discordbot:hazlie.local',
    dir: 'discord',
    db: 'discord/mautrix-discord.db',
    initial: 'login-token',
    prefix: '!discord',
    site: 'discord.com',
    loginUrl: 'https://discord.com/login',
    cookieDomain: 'discord.com',
    // Token login (`login-token`). Cookies are not what this bridge wants.
    webLogin: null,
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    bot: '@slackbot:hazlie.local',
    dir: 'slack',
    db: 'slack/mautrix-slack.db',
    initial: 'login-token',
    prefix: '!slack',
    site: 'slack.com',
    loginUrl: 'https://slack.com/signin',
    cookieDomain: 'slack.com',
    // Token login (`login-token`). Cookies are not what this bridge wants.
    webLogin: null,
  },
});

// The bot prints "Login URL: <https://…>" when a cookie login starts. Prefer
// that (it's what the bridge actually wants) over the hardcoded default, so the
// webview always lands on the right page even if mautrix changes it.
export function loginUrlFrom(transcript, platform) {
  for (const m of [...(transcript ?? [])].reverse()) {
    if (m.from !== 'bot') continue;
    const hit = m.body.match(/Login URL:\s*<?(https?:\/\/[^\s>]+)>?/iu);
    if (hit) return hit[1];
  }
  return platform.loginUrl;
}

// The bridge's actual command prefix, read from its config.yaml. A bare command
// like `login facebook` is only obeyed in the bot's management room; prefixing
// it (`!fb login facebook`) makes it work in whatever DM we're using. Read with
// a line match rather than a YAML dependency — connect/ is node-builtins only,
// and command_prefix is always a simple scalar.
function commandPrefix(platform, home) {
  try {
    const cfg = readFileSync(join(matrixDir(home), platform.dir, 'config.yaml'), 'utf8');
    const m = cfg.match(/^\s{2,}command_prefix:\s*["']?([^"'\n]+)["']?\s*$/mu);
    return m ? m[1].trim() : platform.prefix;
  } catch {
    return platform.prefix;
  }
}

// The full command that starts login, prefix included — what the panel's
// "Begin login" button sends.
export function beginCommand(platformId, { home = homedir() } = {}) {
  const p = PLATFORMS[platformId];
  if (!p) throw new Error('unknown platform');
  return `${commandPrefix(p, home)} ${p.initial}`;
}

// The header's "everything is loopback" is enforced here, not just asserted:
// the base is where mx() sends the Matrix access token (a real credential),
// so a homeserver value that resolves off-box would leak it. owner-
// credentials.json is 0600 and owner-written, so this is defence in depth —
// but the token is exactly the thing the loopback posture exists to keep on
// this machine, and a one-line refusal is cheaper than trusting the file.
function assertLoopbackBase(base) {
  let host;
  try {
    ({ hostname: host } = new URL(base));
  } catch {
    throw new Error(`matrix homeserver is not a valid URL: ${base}`);
  }
  const ok = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    || host === 'synapse'; // the compose-internal name, used when run in-network
  if (!ok) {
    throw new Error(`matrix homeserver must be loopback, refusing ${host}`);
  }
}

export function loadCreds({ home = homedir() } = {}) {
  const raw = JSON.parse(readFileSync(join(matrixDir(home), 'owner-credentials.json'), 'utf8'));
  if (!raw.access_token || !raw.homeserver || !raw.user_id) {
    throw new Error('matrix credentials incomplete — is the bridge stack set up?');
  }
  const base = String(raw.homeserver).replace(/\/$/u, '');
  assertLoopbackBase(base);
  return { base, token: raw.access_token, userId: raw.user_id };
}

// Is this platform logged in? Read straight from the bridge's own DB — a row in
// user_login means a live session, and remote_name is the account it linked.
// Read-only and best-effort: any error (DB missing, locked) reads as "not
// connected", never a crash, because the page has other rows to render.
export function bridgeStatus(platformId, { home = homedir() } = {}) {
  const p = PLATFORMS[platformId];
  if (!p) return { connected: false };
  let db;
  try {
    db = new DatabaseSync(join(matrixDir(home), p.db), { readOnly: true });
    const row = db.prepare('SELECT remote_name FROM user_login LIMIT 1').get();
    return row ? { connected: true, name: row.remote_name ?? null } : { connected: false };
  } catch {
    return { connected: false };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mx(creds, method, path, body) {
  const res = await fetch(`${creds.base}/_matrix/client/v3${path}`, {
    method,
    headers: {
      authorization: `Bearer ${creds.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(json?.error ?? `homeserver returned ${res.status}`);
  }
  return json ?? {};
}

// The management DM with a bot, reused if it exists (via m.direct) so we don't
// litter a new room per login attempt.
async function ensureBotRoom(creds, botMxid) {
  let direct = {};
  try {
    direct = await mx(creds, 'GET', `/user/${encodeURIComponent(creds.userId)}/account_data/m.direct`);
  } catch {
    direct = {};
  }
  const existing = direct?.[botMxid];
  if (Array.isArray(existing) && existing.length > 0) return existing[existing.length - 1];

  const created = await mx(creds, 'POST', '/createRoom', {
    is_direct: true,
    invite: [botMxid],
    preset: 'trusted_private_chat',
  });
  const roomId = created.room_id;
  try {
    await mx(creds, 'PUT', `/user/${encodeURIComponent(creds.userId)}/account_data/m.direct`, {
      ...(direct ?? {}),
      [botMxid]: [...(existing ?? []), roomId],
    });
  } catch {
    // Non-fatal: the room still works this session; worst case we make another
    // next time. Not worth failing the login over.
  }
  return roomId;
}

// The room's recent messages as {from:'you'|'bot', body, ts}, oldest first.
async function readTranscript(creds, roomId, limit = 16) {
  const data = await mx(creds, 'GET', `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`);
  const out = [];
  for (const e of data.chunk ?? []) {
    if (e.type !== 'm.room.message') continue;
    out.push({
      from: e.sender === creds.userId ? 'you' : 'bot',
      body: String(e.content?.body ?? ''),
      ts: Number(e.origin_server_ts ?? 0),
    });
  }
  return out.reverse();
}

// GET side: ensure the room and return its current transcript, without sending
// anything. Used to render the panel on load.
export async function loadPanel(platformId, { home = homedir() } = {}) {
  const p = PLATFORMS[platformId];
  if (!p) throw new Error('unknown platform');
  const creds = loadCreds({ home });
  const roomId = await ensureBotRoom(creds, p.bot);
  return { transcript: await readTranscript(creds, roomId, 16) };
}

// Begin (or restart) login: cancel any login already in progress, then send the
// prefixed begin command. Login state is per-account, not per-room, so a stale
// half-finished login (e.g. from a previous attempt) would otherwise block a
// fresh one with "you already have an ongoing login". Cancelling first is safe
// and idempotent — with nothing in progress it is a harmless no-op. Returns the
// transcript after the begin command, so the panel shows the cookie prompt.
export async function beginLogin(platformId, { home = homedir() } = {}) {
  const p = PLATFORMS[platformId];
  if (!p) throw new Error('unknown platform');
  const prefix = commandPrefix(p, home);
  // Claim THIS room as the management room first. Otherwise the bot rejects
  // bare input with "this is not your management room" and demands the command
  // prefix on everything — including the pasted cookies, which is miserable to
  // do to a multi-line cURL. Once this room is the management room, the login
  // prompt and the cookie paste both work bare. Idempotent (re-marking is a
  // no-op) and prefixed so it works even before the room is management.
  await relay(platformId, `${prefix} set-management-room`, { home, waitMs: 4000 });
  await relay(platformId, `${prefix} cancel`, { home, waitMs: 4000 });
  return relay(platformId, `${prefix} ${p.initial}`, { home });
}

// POST side: send one message to the bot and wait briefly for its reply, so the
// re-rendered page shows the bot's response rather than a blank round-trip.
// Returns the updated transcript. The bot normally answers within 1-4s; if it
// is slow we return what we have and the next page load catches up.
export async function relay(platformId, text, { home = homedir(), waitMs = 9000 } = {}) {
  const p = PLATFORMS[platformId];
  if (!p) throw new Error('unknown platform');
  const creds = loadCreds({ home });
  const roomId = await ensureBotRoom(creds, p.bot);

  const before = await readTranscript(creds, roomId, 1);
  const sinceTs = before.length ? before[before.length - 1].ts : 0;

  // Unique per send, not just per millisecond: Matrix treats a repeated
  // txnId as a retransmission and silently drops the second message, and two
  // relays can overlap here (the widget's /api/bridge channel and the form
  // POST hit this same module).
  const txn = `hz${Date.now()}-${randomBytes(4).toString('hex')}`;
  await mx(creds, 'PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, {
    msgtype: 'm.text',
    body: text,
  });

  const deadline = Date.now() + waitMs;
  let transcript = await readTranscript(creds, roomId, 16);
  while (Date.now() < deadline) {
    await sleep(1200);
    transcript = await readTranscript(creds, roomId, 16);
    if (transcript.some((m) => m.from === 'bot' && m.ts > sinceTs)) break;
  }
  return { transcript };
}
