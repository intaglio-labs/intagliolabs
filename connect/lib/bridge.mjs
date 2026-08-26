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
// Note WHY the four are absent rather than merely unlisted: none of them
// authenticates by cookie harvest, so the right answer is not a wider fence,
// it is not offering that flow. What they DO take was wrong here for months
// and is corrected in place (2026-08-26, after the owner pointed out Beeper
// asks Slack for credentials, not a token):
//
//   Discord  `login` -> a discordapp.com/ra/ link, approved in the phone app.
//   Slack    `login email` -> sign in with the Slack email address.
//   Telegram `login` -> phone number, then the code.
//
// ~~"Discord and Slack are token logins (`login-token`)"~~ — that command is
// not even valid on these bridges; they answer "Unknown command" and always
// did. The token flow exists on Slack as one of three, and was simply the
// only one this table knew about.
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
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    bot: '@linkedinbot:hazlie.local',
    dir: 'linkedin',
    db: 'linkedin/mautrix-linkedin.db',
    initial: 'login',
    prefix: '!linkedin', // verified against the container's own config.yaml
    site: 'linkedin.com',
    loginUrl: 'https://www.linkedin.com/login',
    cookieDomain: 'linkedin.com',
    // li_at is the session cookie; JSESSIONID is the CSRF token the API calls
    // need, and it lands separately — the same pair problem X has, solved the
    // same way (requiredCookies, not a single signal).
    // COOKIE HEADER, not the JSON every other platform takes. mautrix-linkedin's
    // login step is a single field, `fi.mau.linkedin.login.cookie_header`, whose
    // own regex demands `\bJSESSIONID=[^;]+` — a raw Cookie header. The Meta and
    // X bridges instead name each cookie as its own field, so a JSON object
    // keyed by cookie name lands correctly there and arrives EMPTY here: the bot
    // looks for its field id, finds nothing, and rejects the blank (owner hit
    // this on the first real LinkedIn login, 2026-08-25).
    // LINKEDIN WANTS REQUEST HEADERS, NOT COOKIES — three of them, and the
    // bridge's own login step says so: every field is type "request_header"
    // sourced from the platform's own API requests. Learned one refusal
    // at a time (2026-08-25): JSON keyed by cookie name left cookie_header
    // empty, a bare header failed "parse input as JSON", and the wrapped
    // header then got as far as "x_li_track: `` doesn't match clientVersion".
    //
    // X-LI-Track and X-LI-Page-Instance are set by LinkedIn's own JavaScript
    // on its XHRs, so no cookie jar contains them — which is exactly why the
    // bot suggests pasting a cURL command. The login window captures them
    // from the live page instead; `fields` is the whole contract, and Swift
    // fills it in without knowing what any of it means.
    webLogin: {
      allowedHosts: ['linkedin.com', 'www.linkedin.com'],
      sessionCookie: 'li_at',
      requiredCookies: ['li_at', 'JSESSIONID'],
      fields: [
        { id: 'fi.mau.linkedin.login.cookie_header', from: 'cookies' },
        { id: 'fi.mau.linkedin.login.x_li_track', from: 'header', header: 'X-LI-Track' },
        { id: 'fi.mau.linkedin.login.x_li_page_instance', from: 'header', header: 'X-LI-Page-Instance' },
      ],
    },
  },
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
    noWebLogin: 'signs in by phone number and a code sent to the Telegram app',
    // WHAT THE OWNER WANTS HERE, and what it would cost. Documented rather
    // than built (owner, 2026-08-26) — the first step is not ours to take.
    //
    // Today every install registers its OWN app at my.telegram.org and pastes
    // api_id:api_hash into the connect card (connectSecret → secretApi SINKS →
    // config.yaml → docker start). That is three steps and a developer portal
    // in front of a connector whose actual login is a phone number and a code.
    // The owner wants Telegram to feel like Instagram: press the tile, log in,
    // done.
    //
    // THE SHAPE OF THE FIX. One api_id registered once — Beeper does exactly
    // this — shipped with the product, so the bridge starts configured and the
    // card drops straight to the phone-and-code conversation it already has.
    // Concretely: the pair is injected at BUILD time from a repository secret
    // (the same shape as FIREBASE_SERVICE_ACCOUNT, which this tree already
    // keeps out of itself), ops/setup-bridges.sh writes it into config.yaml
    // when one is present instead of stopping the container on the example
    // 12345, and the paste path stays as an OVERRIDE — HINTS.telegram's
    // walkthrough rendering only when no default is configured.
    //
    // WHY THE PAIR MUST NOT LAND IN THIS TREE, which is the whole reason this
    // is a note and not a commit. Telegram flags api_ids that appear in public
    // code and refuses logins made with them — API_ID_PUBLISHED_FLOOD, the
    // named error that killed the sample credentials in Telegram's own docs
    // (core.telegram.org/api/obtaining_api_id, read 2026-08-26). THIS
    // REPOSITORY IS PUBLIC. Committing the pair does not degrade Telegram
    // slowly; it breaks every install at once, on Telegram's schedule.
    //
    // WHAT ANYONE BUILDING IT SHOULD WEIGH FIRST:
    //   • A binary is not a hiding place. `strings` reads it, so a shipped
    //     api_id is published eventually — build-time injection buys exposure
    //     time, not secrecy. Keep the per-user paste so a flagged default
    //     degrades to today's behaviour instead of bricking the connector.
    //   • The failure becomes SHARED. Per-user credentials fail one user at a
    //     time; one default fails everyone simultaneously, and rotating it
    //     means shipping a build.
    //   • One api_id per phone number (same page). The credential is tied to
    //     the registering person's own Telegram account, and inherits whatever
    //     happens to it.
    //   • Accounts on unofficial clients are put under automatic observation.
    //     True of the per-user path too, so it is not an argument either way —
    //     but under a shared id, every user is under it together.
  },
  discord: {
    id: 'discord',
    label: 'Discord',
    bot: '@discordbot:hazlie.local',
    dir: 'discord',
    db: 'discord/mautrix-discord.db',
    // ~~login-token~~ — this bridge answers "Unknown command" to that, and has
    // for as long as the entry has been wrong. Its real command is `login`
    // [flow], and asked plainly it hands back a discordapp.com/ra/ URL: the
    // QR REMOTE-AUTH flow, approved from the Discord app on a phone. No token
    // to dig out of devtools at all (verified against the running bridge,
    // 2026-08-26, after the owner pointed out Beeper does not ask for one).
    initial: 'login',
    prefix: '!discord',
    site: 'discord.com',
    loginUrl: 'https://discord.com/login',
    cookieDomain: 'discord.com',
    // ~~An approval window onto discord.com.~~ Withdrawn the same day it was
    // added (owner, 2026-08-26): opening Discord in a fresh webview shows the
    // Discord app, which is not the same thing as approving THIS login — the
    // owner ended up logged in on the web with the bridge still waiting, and
    // the remote-auth socket timed out unapproved. The approval belongs to
    // the QR. ~~and the QR belongs on the card~~ — it belongs in a WINDOW
    // (owner, 2026-08-26): "a separate pop-up like how instagram login is".
    // On the card the QR was 168px of code standing over the settings and the
    // shelf; in its own window it is the whole window, which is what a thing
    // you have to point a phone camera at wants to be.
    webLogin: null,
    // NOT a webLogin, and the distinction is the whole point of that field:
    // webLogin means "this platform can be linked by DRIVING ITS REAL LOGIN
    // PAGE in a webview", which Discord cannot. qrLogin means the window shows
    // an image the bridge posted and waits — no navigation, no cookie jar, no
    // third-party page at all. The widget enforces this; it does not decide
    // it, the same rule allowedHosts follows.
    qrLogin: true,
    noWebLogin: 'a QR posted by the bot, shown in its own window and scanned '
      + 'with the Discord phone app',
    // THE LEGACY SCHEMA. mautrix-discord predates bridgev2 and has no
    // user_login table — its session is a `user` row carrying dcid and a
    // token, and the human-readable name lives in `puppet`, keyed by that
    // dcid. The default query threw here and was read as "not connected" for
    // as long as this entry has existed.
    //
    // username, not global_name: the bot's own success line says
    // "Successfully logged in as @<username>", and the card saying something
    // else than the bridge said is how you end up unsure which one to trust.
    statusSql: 'SELECT COALESCE(NULLIF(p.username, \'\'), NULLIF(p.global_name, \'\'),'
      + ' NULLIF(p.name, \'\')) AS remote_name'
      + ' FROM "user" u LEFT JOIN puppet p ON p.id = u.dcid'
      + " WHERE u.dcid IS NOT NULL AND u.dcid != '' LIMIT 1",
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    bot: '@slackbot:hazlie.local',
    dir: 'slack',
    db: 'slack/mautrix-slack.db',
    // ~~login-token~~ — rejected as "Unknown command" by this bridge, which
    // takes `login <flow>` and offers three: `email` (sign in with your Slack
    // email address), `token`, and `app`. EMAIL is the one a person wants and
    // the one Beeper uses; the token flow was never the only option, it was
    // just the one this table knew about.
    // ~~login email~~ — the flow a person wants, and the one this app cannot
    // finish. Slack will not email its code until a CAPTCHA is answered, and
    // slack.com/signin refuses to render in the login window at all: it draws
    // "your browser is not supported" over every user agent tried, including
    // ones a plain fetch of the same page accepts (verified 2026-08-26). The
    // check is client-side feature detection, so no browser string fixes it —
    // Beeper gets away with the same flow because Electron IS Chromium, and
    // this window is WKWebView. `token` is the flow that works here: a person
    // already signed in to Slack in their own browser copies two values out
    // of it, and no challenge is involved because they already passed one.
    initial: 'login token',
    prefix: '!slack',
    site: 'slack.com',
    loginUrl: 'https://slack.com/signin',
    cookieDomain: 'slack.com',
    // A WINDOW, but not for a password. After the email address, Slack refuses
    // to send its confirmation code until a CAPTCHA is solved — the bot says so
    // in as many words and hands back a Login URL. Its next step then asks for
    // one field, `captcha_token`, which is the value the challenge produces.
    //
    // THE PERSON SOLVES IT. The window shows Slack's own page and carries the
    // token their solution produced; nothing here answers a challenge, and
    // nothing may. That is also the only reason this is a legitimate flow: the
    // point of the challenge is a human proving they are human, and one is.
    // ~~A CAPTCHA window.~~ It could never open: see the note on `initial`.
    webLogin: null,
    noWebLogin: 'two tokens copied from a browser already signed in to Slack',
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
    // A BARE URL ON ITS OWN IS ALSO THE ANSWER. mautrix-discord's login
    // replies with nothing but its remote-auth link — no "Login URL:" label to
    // match — so the labelled pattern above fell through to the static page,
    // and the window opened somewhere that could not finish the login the bot
    // had already started (2026-08-26). Fenced twice over: the whole message
    // must be the URL, and the caller checks it against allowedHosts before
    // loading it, because this is content from a container.
    const bare = m.body.trim().match(/^<?(https?:\/\/[^\s>]+)>?$/u);
    if (bare) return bare[1];
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

// The bridgev2 answer, and the DEFAULT rather than the only one. A row in
// user_login is a live session and remote_name is the account it linked.
//
// WHICH IS NOT A UNIVERSAL SCHEMA, and believing it was cost Discord its
// entire status (owner, 2026-08-26: "i went through the scan QR code process
// on my phone but doesn't seem like it actually worked"). It had worked —
// the bot said "Successfully logged in", the user row was written, portals
// were backfilling — but mautrix-discord is the pre-bridgev2 generation and
// has no user_login table at all, so this query threw, the catch below read
// the exception as "not connected", and the tile stayed grey through a
// perfectly good login. ops/setup-bridges.sh has always said Discord is the
// legacy one; nothing here asked.
//
// An override must return a column named remote_name, and the row's existence
// is what "connected" means.
const LOGIN_SQL = 'SELECT remote_name FROM user_login LIMIT 1';

// Is this platform logged in? Read straight from the bridge's own DB.
// Read-only and best-effort: any error (DB missing, locked) reads as "not
// connected", never a crash, because the page has other rows to render.
//
// THAT CATCH IS ALSO THE TRAP. It cannot distinguish "no session" from "this
// query does not belong to this schema", and the second is silent forever.
// If a bridge reports disconnected while its bot says otherwise, run the
// query by hand against its .db before believing this function.
export function bridgeStatus(platformId, { home = homedir() } = {}) {
  const p = PLATFORMS[platformId];
  if (!p) return { connected: false };
  let db;
  try {
    db = new DatabaseSync(join(matrixDir(home), p.db), { readOnly: true });
    const row = db.prepare(p.statusSql ?? LOGIN_SQL).get();
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
  if (Array.isArray(existing) && existing.length > 0) {
    // A REMEMBERED ROOM THE BOT NEVER JOINED IS A DEAD ROOM, and it looks
    // exactly like a working one from here. If the bridge was not registered
    // with synapse when the room was made — the window a newly added bridge
    // sits in while its as_token is still being rejected — it never saw the
    // invite, and synapse then rightly considers it uninterested in every
    // event there. Commands go in, nothing comes out, forever (LinkedIn spent
    // an evening like this, 2026-08-25). Checking membership costs one call
    // and turns a permanent silence into a fresh room.
    const roomId = existing[existing.length - 1];
    try {
      const members = await mx(creds, 'GET', `/rooms/${encodeURIComponent(roomId)}/joined_members`);
      if (members?.joined && Object.hasOwn(members.joined, botMxid)) return roomId;
    } catch {
      return roomId; // cannot tell — the remembered room is still the best guess
    }
    // Fall through: forget it and make one the bot can actually accept.
    try {
      await mx(creds, 'POST', `/rooms/${encodeURIComponent(roomId)}/leave`, {});
      await mx(creds, 'POST', `/rooms/${encodeURIComponent(roomId)}/forget`, {});
    } catch {
      // Leaving is best-effort; a fresh room is created either way.
    }
  }

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
    const entry = {
      from: e.sender === creds.userId ? 'you' : 'bot',
      body: String(e.content?.body ?? ''),
      ts: Number(e.origin_server_ts ?? 0),
    };
    // A QR CODE IS A MESSAGE TOO. Discord's login is remote-auth: the bot
    // posts a QR image, you scan it with the phone app, and it redacts the
    // image once the attempt ends. Dropping non-text left the panel showing an
    // empty line where the only actionable thing in the whole flow was, and
    // then "websocket: close sent" when nobody approved in time (owner,
    // 2026-08-26). Inlined as a data URI rather than a URL: these pages hold
    // no bearer and cannot fetch the homeserver themselves.
    if (e.content?.msgtype === 'm.image' && typeof e.content?.url === 'string') {
      const inline = await inlineMedia(creds, e.content.url);
      if (inline) entry.image = inline;
    }
    out.push(entry);
  }
  return out.reverse();
}

// One mxc:// → a data URI, or null. Bounded hard: a login QR is a few KB, and
// anything large enough to be worth streaming is not a thing this panel shows.
const MAX_INLINE_BYTES = 512 * 1024;
async function inlineMedia(creds, mxc) {
  const m = /^mxc:\/\/([^/]+)\/(.+)$/u.exec(mxc);
  if (!m) return null;
  try {
    const res = await fetch(
      `${creds.base}/_matrix/client/v1/media/download/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`,
      { headers: { Authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/^image\//u.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_INLINE_BYTES) return null;
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch {
    return null; // a QR we cannot fetch is a panel without one, not an error
  }
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
