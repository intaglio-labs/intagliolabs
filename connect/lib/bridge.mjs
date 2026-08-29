// Talking to the social bridge bots from Intaglio Labs' own connect page — so the
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
    // WIDTH, because Facebook's login page declares no viewport meta at all.
    // WebKit therefore lays it out at the desktop default, and in the login
    // window's usual 480pt it rendered as the top-left corner of a ~980px page --
    // the Meta mark, a broken image and a horizontal scrollbar, with the form
    // off-screen to the right (owner, 2026-08-29). Instagram's page carries
    // width=device-width and fits at 480, which is why the same window worked
    // there and not here. Policy, not a Swift constant, like every other
    // per-platform difference in this table.
    webLogin: {
      allowedHosts: ['facebook.com', 'messenger.com', 'meta.com'],
      sessionCookie: 'c_user',
      windowWidth: 1000,
    },
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
    // ~~`login`~~ — the bot answers that with a MENU: "Please specify a login
    // flow, e.g. `login phone`", offering phone, qr and bot. So the card
    // relayed into a conversation waiting for a word it never sends, and the
    // login could not complete (verified against the running bridge,
    // 2026-08-26 — the first day it ran at all; it had crash-looped on the
    // example api_id since it was provisioned).
    //
    // FOURTH TIME FOR THE SAME MISTAKE: `login-token` on Discord, `login-token`
    // on Slack, `login token` on Slack as the retreat from a wrong finding,
    // and this. Every one was a verb written into this table against a bridge
    // nobody could talk to. THE RULE: mautrix login verbs take a flow
    // argument, and the only way to know which is to ask a running bot.
    //
    // `phone` because the owner asked for a credential login. `qr` is also on
    // that menu and the QR window from e2d5c65 would drive it unchanged
    // (qrLogin: true; the poll's connected check is platform-agnostic) — worth
    // knowing if phone auth turns out worse than it looks, not a proposal.
    initial: 'login phone',
    // WHETHER THE WALKTHROUGH IS STILL NEEDED, read off the bridge's own
    // config rather than assumed. mautrix ships api_id 12345 as its example
    // and the bridge refuses to start on it, so that value IS the "nobody has
    // configured this" signal — an empty key never appears. When a build ships
    // an app credential (widget/build.sh → ops/setup-bridges.sh) this is
    // already real by the time anyone opens the card, and the card must not
    // ask for a paste that would overwrite a working pair.
    appCredential: { file: 'telegram/config.yaml', unset: /^\s*api_id:\s*12345\s*$/mu },
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
    // BACK TO `login token`, and this time nobody types one. The owner signs
    // in to Slack in the login window — email code, Google, Apple, whichever —
    // and the window takes the session it just created: the `d` cookie from the
    // jar, the client token out of the page's own storage.
    //
    // ~~login email~~ — the flow Beeper uses and the one this app restored on
    // 2026-08-26 once the "browser not supported" gate turned out to be a stale
    // user agent. It works: the bot asks for an address, sends the CAPTCHA
    // step, and Slack emails a code. What it is NOT is what the owner asked
    // for, twice, looking at a card that was talking to him instead of a
    // window: "i thought this was a separate login pop-up like instagram" and
    // "when someone hits the icon it should open the login window directly".
    // A conversation is a worse login than a window when the window is
    // available — and it is available, which he proved by signing all the way
    // into a workspace inside it while the bridge sat waiting for a captcha
    // token it was never going to get.
    //
    // ~~login-token~~ (the original) was rejected as "Unknown command": the
    // command is `login token`, and this table had the hyphen. That mistake is
    // what sent this entry round the houses in the first place.
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
    //
    // ~~WITHDRAWN 2026-08-26: "slack.com/signin will not render in this app at
    // all. It answers 'your browser is not supported' under every user agent
    // tried — and a plain fetch of the same URL with those same agents is
    // served the real page, so the check is client-side feature detection, not
    // the string. No browser string fixes that. Beeper runs the identical flow
    // because Electron IS Chromium; this window is WKWebView."~~
    //
    // WRONG, and restored the same day it was withdrawn. Every clause of that
    // paragraph was a reasonable reading of two measurements and none of it
    // survived a third. The gate is SERVER-SIDE and keyed on the User-Agent;
    // what is client-side is only the mounting of the real form, which is why
    // it looked like feature detection. From slack.com/signin's own boot_data:
    //
    //     Version/17.4  is_deprecated_webclient_browser: true   39 KB, gate
    //     Version/18.5  is_deprecated_webclient_browser: true   39 KB, gate
    //     Chrome/126    is_deprecated_webclient_browser: true   39 KB, gate
    //     Version/26.0  flag absent                             64 KB, no gate
    //     Version/27.0  flag absent                             64 KB, no gate
    //     WKWebView's own default UA  is_unsupported...: true
    //
    // Both agents the withdrawal tested had aged onto Slack's deprecated list,
    // which is exactly what makes "no browser string fixes it" look proven.
    // The "not supported" block ships inside the HTML as the no-JS fallback
    // and the real form is mounted over it, so a deprecated browser sees the
    // fallback with no error in the console — a decision, not a crash. In a
    // real WKWebView with a current Safari string: gate false, form present,
    // 21 scripts, "Enter your email to sign in". The window works. It is the
    // version we were claiming to be that did not.
    //
    // WHAT IS STILL UNPROVEN, said plainly because the next reader will want
    // to know: nobody has watched Slack's challenge widget actually run in
    // this window. It is lazy-loaded — with the form on screen and nothing
    // submitted there is no grecaptcha global and no challenge frame, only the
    // word "captcha" inside the bundles — and seeing it mount means submitting
    // an address, which is the owner's login to start, not ours. So this entry
    // restores a flow whose FIRST wall is measured gone; if the challenge
    // itself cannot run here, the wall moved one step rather than fell, and
    // the honest thing then is another strike-through under this one.
    webLogin: {
      // SLACK'S OWN SIGN-IN OPTIONS ARE PART OF SLACK'S SIGN-IN. The page
      // offers email, Google and Apple, and a fence of ['slack.com'] alone
      // silently cancelled the second and third: the button worked, the flow
      // reached slack.com/signin/oauth/google/start, and the very next hop was
      // killed with no error anywhere (owner, 2026-08-26: "clicking on sign in
      // w google doesn't work"). A cancelled navigation looks exactly like a
      // dead button.
      //
      // MEASURED, not guessed at — a fenceless probe clicked each button and
      // logged every main-frame host the flow touched:
      //
      //   Google  slack.com -> accounts.google.com -> accounts.youtube.com
      //   Apple   slack.com -> appleid.apple.com
      //
      // accounts.youtube.com is Google's cross-domain session sync and is part
      // of their sign-in, not a detour. The return leg lands on
      // oauth2.slack.com, which the slack.com suffix already covers.
      //
      // THIS IS THE WHOLE LIST AND IT IS A CEILING, NOT A GUESS. Only the
      // identity providers Slack itself offers, named exactly; the fence still
      // cancels everything else, which on this page includes the doubleclick
      // and contentsquare trackers Slack's own marketing page loads.
      //
      // NOT ENUMERATED PAST THE FIRST STEP: the probe stops at Google's
      // "Email or phone" screen, because going further means typing an address
      // and a password, which is the owner's to do and not ours. If a 2FA
      // challenge bounces through a host not on this list it will die the same
      // silent way — the fix is to measure the hop and add it here, never to
      // widen this to google.com.
      allowedHosts: ['slack.com', 'accounts.google.com', 'accounts.youtube.com', 'appleid.apple.com'],
      // THE CHALLENGE IS MADE OF IFRAMES. Slack's is reCAPTCHA (their boot_data
      // carries recaptcha_enterprise_migration and spam_email_recaptcha_v3,
      // both on), and a live reCAPTCHA loads two subframes:
      //
      //     www.google.com/recaptcha/api2/anchor   the checkbox
      //     www.google.com/recaptcha/api2/bframe   the image challenge
      //
      // Measured on Google's own demo page inside a fenced WKWebView, so no
      // Slack account was involved. www.gstatic.com is deliberately absent: the
      // script is a subresource and the fence does not gate those, so listing
      // it would be cargo.
      //
      // SUBFRAME ONLY, and that is the whole point of it being its own field.
      // Putting www.google.com in allowedHosts above would let this window
      // navigate ITSELF to Google, and this is the one webview in the app where
      // a password gets typed. A challenge needs to render inside the page, not
      // to replace it.
      //
      // TWO HOSTS, AND THEY ARE NOT EQUALLY EVIDENCED — labelled rather than
      // blended, because the difference is the whole lesson of this entry:
      //   www.google.com    MEASURED, as above.
      //   www.recaptcha.net NOT observed here. It is Google's documented
      //     alternate domain for the identical widget, chosen by whichever
      //     script URL the site loads, and Slack loads that script lazily out
      //     of a bundle this file's author could not cheaply reach. Listed
      //     because the failure it prevents is invisible and would not
      //     reproduce on the machine that shipped it — an empty box where the
      //     puzzle should be, on someone else's network. It serves reCAPTCHA
      //     and nothing else, so the cost of being wrong is one unused row.
      allowedFrameHosts: ['www.google.com', 'www.recaptcha.net'],
      // `d` IS THE SIGNAL AND HALF THE ANSWER. It appears when the sign-in
      // completes, whichever way the owner signed in, so it is what the window
      // waits on — and its value is the cookie_token the bridge asks for.
      sessionCookie: 'd',
      requiredCookies: ['d'],
      // THE TWO HALVES OF A SLACK SESSION, in the shape the bot asked for in
      // its own words: {"auth_token":"xoxc-…","cookie_token":"xoxd-…"}.
      //
      // They come from two different places and that is the whole reason this
      // entry needed new machinery. `d` is a cookie and native reads it from
      // the jar. The xoxc token is NOT a cookie — Slack's web client keeps it
      // in localStorage — so it is read from inside the page by a poller that
      // matches this one pattern and reports nothing else.
      //
      // This is the same pair the card used to ask the owner to copy out of
      // devtools by hand. Taking them here is less exposure, not more: neither
      // is displayed, neither goes through the clipboard, and both go straight
      // to the bridge on this machine.
      fields: [
        { id: 'auth_token', from: 'storage', match: 'xoxc-' },
        { id: 'cookie_token', from: 'cookie', cookie: 'd' },
      ],
      // SIGNING IN DOES NOT LAND ON THE TOKEN. Slack finishes on an
      // interstitial — "Click Open Slack to launch the desktop app… or use
      // Slack in your browser" — and that page has no token in it, because the
      // token belongs to the web client its own link points at. The owner sat
      // on that page with nothing to press (2026-08-26). The window walks here
      // itself, once, after the cookies prove the sign-in worked.
      storageUrl: 'https://app.slack.com/client',
      // No userAgent override. ~~Slack's sniffer rejects Safari~~ — it rejects
      // a STALE Safari, and the window now presents the version of Safari that
      // is actually installed (BridgeLogin.systemSafariUserAgent). A literal
      // here would be the same dated assertion one file further away.
    },
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

// Does this bridge still need the owner to register an app of their own?
// True only for a platform that declares `appCredential` AND whose config
// still carries the placeholder. Everything else — no declaration, no config,
// an unreadable file — is false, because the question only has a useful answer
// when we can actually see the placeholder: guessing "yes" would put a paste
// box in front of a bridge that is already working.
export function bridgeNeedsAppCredential(platformId, { home = homedir() } = {}) {
  const p = PLATFORMS[platformId];
  if (!p?.appCredential) return false;
  try {
    const text = readFileSync(join(matrixDir(home), p.appCredential.file), 'utf8');
    return p.appCredential.unset.test(text);
  } catch {
    return false;
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
    // The status rides along. Without it every caller's catch has to treat
    // "you are not in that room" (a decisive 403) the same as "the homeserver
    // did not answer" (unknowable), and ensureBotRoom below did exactly that
    // for as long as it has existed.
    const err = new Error(json?.error ?? `homeserver returned ${res.status}`);
    err.status = res.status;
    throw err;
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
    } catch (err) {
      // ~~Cannot tell — the remembered room is still the best guess.~~ Only
      // when the homeserver failed to answer. A 403 or 404 from joined_members
      // IS the answer: you are not in that room, so nothing you send there
      // will ever be read. Returning it anyway turned a recoverable state into
      // a permanent 502 — Telegram's begin failed on "User @you not in room
      // …, and room previews are disabled" every time, and would have kept
      // failing forever (owner, 2026-08-26).
      if (err?.status !== 403 && err?.status !== 404) return roomId;
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
      // REPLACE, don't append. ~~[...(existing ?? []), roomId]~~ grew this
      // list by one every time a room had to be remade, and only the LAST
      // entry is ever read — so the rest were pure sediment. A bridge that is
      // down remakes a room per attempt: Telegram's list had reached TEN dead
      // rooms while its container crash-looped on the example api_id, and the
      // one at the end was the one nobody could join (owner, 2026-08-26).
      // Everything being dropped here is a room we just left and forgot, or a
      // pointer we already judged unusable.
      [botMxid]: [roomId],
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
