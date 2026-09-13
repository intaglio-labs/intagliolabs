// The mail connector: Gmail REST → hermes.
//
// Egress path 1 in ui/AGENTS.md — the owner's own mailbox fetched down to this
// Mac. Content moves provider → Mac; nothing is sent anywhere.
//
// ~~IMAP/TLS with a 16-character app password per mailbox.~~ Replaced
// 2026-08-26 on the owner's ask: an app password is minted by hand in a
// browser, and it carries the WHOLE account rather than a scope. The move was
// to OAuth — and the transport had to change with it, which is the part worth
// writing down. Google does not accept `gmail.readonly` over IMAP; IMAP
// demands the full-mailbox scope, which is read, write, delete and send.
// Keeping IMAP would have meant buying read access with the power to destroy
// the mailbox, against CLAUDE.md rule 5. So this reads the REST API, where
// read-only is genuinely read-only.
//
// WHAT THAT CHANGED, AND WHAT IT DID NOT.
//
// 1. THE CURSOR. ~~A per-folder UID cursor guarded by UIDVALIDITY.~~ Gmail's
//    API has neither: there are no folders (labels are not folders) and no
//    UIDs. What it has is `internalDate`, monotonic per message and stable, so
//    the cursor is now the newest internalDate ingested per ACCOUNT. The trap
//    that comment warned about does not go away, it changes shape: a cursor
//    stored ahead of every message means nothing is ever fetched again, so the
//    cursor advances only from rows that actually ingested.
//
//    ~~"ADVANCED ONLY FROM ROWS THAT LANDED" IS NOT THE WHOLE INVARIANT.~~
//    Corrected 2026-09. It is true, and it names the wrong thing. Gmail lists
//    NEWEST-FIRST, so when MAX_MESSAGES_PER_ACCOUNT cut a window short the
//    rows that landed were the NEWEST ones, and moving the cursor to the
//    newest landed row declared every older message the cap cut off as
//    handled. Nothing errored; that window was simply never queried again.
//    What a newest-first scan needs is a record of the OLDEST unfetched
//    boundary, not the newest landed one -- so a truncated window now leaves
//    behind an explicit backfill gap ([gap-from, gap-until], two more durable
//    cursors) that later passes drain from the top down with whatever budget
//    the fresh window leaves. The forward cursor still advances to the newest
//    row the pass READ, because everything above the gap ceiling really is
//    drained; it is the part BELOW it that used to disappear.
//
//    The exact semantics of those three values — which side of each bound is
//    inclusive and why, how ties on internalDate are handled, and what a
//    killed pass may lose — are stated once, in the comment block over the
//    forward scan below. Read that before changing a bound here: "advanced
//    only from rows that landed" is refined there (READ, not landed), and
//    the refinement is load-bearing.
//
// 2. SEVERAL MAILBOXES, still, and now the reason is cleaner. One OAuth grant
//    authorizes one account, so several mailboxes means several grants — see
//    connectors/lib/googleAccounts.mjs. An account that fails must not abort
//    the others, exactly as before.
//
// 3. THE ROW BUILDER IS UNCHANGED. connectors/lib/mailRows.mjs takes parsed
//    fields, not IMAP objects, so it did not care what fetched them. This file
//    adapts Gmail's payload into that shape and nothing downstream moved.
//
// LOG POLICY (connectors/AGENTS.md): counts and account ordinals only. No
// addresses, provider response text, subjects, bodies or recipients — those
// are private data, and a log is not a second corpus.

import { homedir } from 'node:os';
import { createGmailClient } from '../lib/gmailClient.mjs';
import { GMAIL_SCOPE, accountsWithScope } from '../lib/googleAccounts.mjs';
import { DEFAULT_MAX_BODY_BYTES, messageToRow, parseAddressHeader } from '../lib/mailRows.mjs';
import { EXPORT_READY_MAX_AGE_MS, noteExportReady } from '../lib/linkedinExport.mjs';

const DEFAULT_BACKFILL_DAYS = 30;
// Forward scans stay bounded so a first run cannot monopolize the daemon.
// Historical scans are bounded by `historyPagesPerPass` API pages per pass
// instead (default below); their durable page token eventually drains the
// whole year without imposing a data cap. MEASURED (2026-09): one page per
// 12-minute daemon cycle gained ~1,000 messages/hour across 3 accounts, well
// under the ~90 gets/min pacing budget this file already enforces — the
// cadence was the bottleneck, not the quota, so a pass now drains several
// pages instead of running the daemon more often.
const MAX_MESSAGES_PER_ACCOUNT = 2000;
const PAGE_SIZE = 100;
// The smallest turn a mailbox may be handed when the run's forward budget is
// already spent. See the slice arithmetic in run(): an equal share of what is
// LEFT is zero for the last mailbox on every pass, and zero is not a turn.
const MIN_ACCOUNT_SLICE_MS = 10_000;
const DEFAULT_HISTORY_PAGES_PER_PASS = 5;

// Pacing between Gmail API calls. A 52k-message backfill answered with
// `Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per
// minute per user' of service 'gmail.googleapis.com'` — gmailClient.mjs
// retries that, but pacing exists so a normal run stays under the quota
// instead of leaning on the retry. MEASURED (2026-09, daemon paused, two
// separate Google accounts, each in a fresh minute at 250ms spacing): both
// accounts hit the 403 after exactly ~102 `messages.get` calls (~37s), i.e.
// an effective budget of ~100 gets (~500 units) per user per minute —
// regardless of what the console displays (it shows 6,000). The old fixed
// 50ms delay saturates that budget in five seconds; this default keeps a
// little under the measured ceiling instead.
const DEFAULT_MAIL_GETS_PER_MINUTE = 90;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Coarse, type-only classification for logging (connectors/AGENTS.md: counts
// and error types, never provider text). `error.message` may echo the
// provider's own body, so it is inspected here to pick a bucket and never
// itself logged.
function classifyMailError(error) {
  const status = Number.isFinite(error?.status) ? error.status : null;
  if (status === null) return { status, kind: 'network' };
  if (status === 401) return { status, kind: 'auth' };
  if (status === 429) return { status, kind: 'quota' };
  if (status === 403) {
    return {
      status,
      kind: /quota exceeded|rateLimitExceeded|userRateLimitExceeded|quotaExceeded/iu.test(String(error?.message ?? ''))
        ? 'quota'
        : 'auth',
    };
  }
  return { status, kind: 'other' };
}

const cursorKey = (email) => `mail:${String(email).toLowerCase()}:internalDate`;
// WHICH MAILBOX GOES FIRST NEXT FORWARD PASS (round-4 finding 4).
//
// The forward budget is sliced across the mailboxes that still have to run, so
// position in the pass decides how much time a mailbox gets: the first one is
// handed a real share and the last one is handed MIN_ACCOUNT_SLICE_MS. Fixed
// order made that permanent -- the last mailbox was the last mailbox on every
// pass forever, which is the starvation this cursor removes. One small integer,
// no addresses: an index into the account list, advanced once per forward pass.
const FORWARD_START_KEY = 'mail:forward-start';
// The backfill gap left behind when the per-account cap cuts a newest-first
// forward window: messages with internalDate in [from, until] — INCLUSIVE on
// both ends, see the forward-scan comment on ties — have NOT been read, and
// `until` is at or below the forward cursor. Both keys are present or both are
// absent; either one alone is treated as no gap, and so is `until < from`
// (a drained gap whose keys outlived it). `until === from` is a real hole:
// the cap can cut a run of same-millisecond messages in half.
const gapFromKey = (email) => `mail:${String(email).toLowerCase()}:forward-gap-from`;
const gapUntilKey = (email) => `mail:${String(email).toLowerCase()}:forward-gap-until`;
// THE DRAIN IS OWED A TURN, per mailbox.
//
// The time gate is right about the ordinary case and wrong about one shape of
// mailbox: a fresh window that FITS IN ONE PAGE and still spends the whole slice
// doing it. At defaults a page is ~66 s against a 40 s share at three mailboxes,
// so `accountOutOfTime()` is true by the time the drain is reached, every pass,
// in every rotation position -- the rotation answers ORDERING starvation and
// this is slice-versus-page starvation. The gap below the cursor then never
// moves and those messages are never read at all.
//
// So a drain the gate turned away once is let through once. Written when the
// gate refuses it, spent when it runs, and cleared the moment there is no hole
// left. The cost is the second exempt page the gate exists to prevent, on
// ALTERNATE passes rather than every pass -- an amortised half page per mailbox
// against a hole that otherwise stays open forever.
const drainOwedKey = (email) => `mail:${String(email).toLowerCase()}:forward-drain-owed`;
// The most an owed drain may spend before the fresh window has had its turn.
// Half, so a hole bigger than the whole cap can never leave new mail with
// nothing: see the owed-drain call site.
const OWED_DRAIN_GETS = Math.floor(MAX_MESSAGES_PER_ACCOUNT / 2);
// WHICH MAILBOXES THIS INSTALL HAD LAST PASS, so the per-address cursors of one
// it no longer has can be dropped. Addresses only, in the cursor store this
// connector already owns -- the same place the per-account cursors themselves
// live, and never a log line.
const ACCOUNTS_SEEN_KEY = 'mail:accounts-seen';
// WHEN THIS INSTALL FIRST READ ANY MAIL AT ALL, and the only thing it is used
// for is the export-ready nudge (review finding 7). A first pass reads
// DEFAULT_BACKFILL_DAYS behind now, so without a floor a brand-new install
// would badge "your export is ready -- open the email" off a four-week-old mail
// whose download LinkedIn expired weeks ago. Mail from before this install
// existed is mail the owner already dealt with, one way or another; only what
// arrives from here on is news. Written once, never moved, and read by nothing
// else -- the corpus cursors above are what decide what gets FETCHED.
const FIRST_PASS_KEY = 'mail:first-pass-at';
function previousAccounts(state) {
  try {
    const parsed = JSON.parse(state.getCursor(ACCOUNTS_SEEN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((email) => typeof email === 'string') : [];
  } catch {
    return [];
  }
}
function rememberAccounts(state, emails) {
  state.setCursor(ACCOUNTS_SEEN_KEY, JSON.stringify([...emails].sort()));
}
const historyPageKey = (email, year) =>
  `mail:${String(email).toLowerCase()}:history-year:${year}:page`;
const historyDoneKey = (email, year) =>
  `mail:${String(email).toLowerCase()}:history-year:${year}:done`;
const historyOlderKey = (email, year) =>
  `mail:${String(email).toLowerCase()}:history-year:${year}:has-older`;

// Gmail returns headers as a [{name, value}] list, case-insensitively named.
function header(payload, want) {
  const hit = (payload?.headers ?? []).find(
    (h) => typeof h?.name === 'string' && h.name.toLowerCase() === want
  );
  return hit?.value ?? null;
}

// base64url, and Gmail uses the URL-safe alphabet with the padding stripped.
function decodeBody(data) {
  if (typeof data !== 'string' || data.length === 0) return '';
  return Buffer.from(data.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8');
}

// THE TEXT PART, PREFERRED OVER HTML, walking the MIME tree depth-first.
// A multipart/alternative carries both; mailRows already strips tags from an
// HTML fallback, so handing it text/plain when one exists is strictly better
// input rather than a different result.
function extractBody(payload) {
  let text = '';
  let html = '';
  const walk = (part) => {
    if (!part || (text && html)) return;
    const mime = part.mimeType ?? '';
    if (mime === 'text/plain' && !text) text = decodeBody(part.body?.data);
    else if (mime === 'text/html' && !html) html = decodeBody(part.body?.data);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return { text, html };
}

// Gmail's payload -> the shape connectors/lib/mailRows.mjs already speaks.
//
// Addresses stay as their raw header strings, and ~~normalizeAddresses over
// there handles both a string and mailparser's object form, so this does not
// need to grow a parser it would then have to keep correct~~ THAT WAS FALSE
// FROM THE DAY IT WAS WRITTEN (corrected 2026-09-12). normalizeAddresses took
// an array or mailparser's `{value:[{address}]}` and nothing else; a string
// fell through to the empty list. So every row this adapter produced since the
// 2026-08-26 REST switch carried meta.from/to/cc = [] and a null speaker --
// 81,725 of them in the corpus, not one linked to a person, which is why the
// reconnection card had never shown a Gmail contact. The comment was the only
// thing holding the seam together and nothing tested the join.
//
// The premise still stands: the parser belongs over there, next to the
// consumer, so a comment here cannot contradict it again. It is now
// mailRows.mjs's exported parseAddressHeader, and connectors/test/
// mailSource.test.mjs runs a real full-format payload through messageToRow so
// this join is asserted rather than asserted-about.
export function gmailMessageToParsed(message) {
  const p = message?.payload;
  const { text, html } = extractBody(p);
  const internal = Number(message?.internalDate);
  return {
    messageId: header(p, 'message-id'),
    // internalDate is what Gmail sorts and filters by, so it is also what the
    // cursor compares. Falling back to the Date header would let a message
    // with a wrong clock reorder the corpus.
    date: Number.isFinite(internal) ? new Date(internal) : header(p, 'date'),
    from: header(p, 'from'),
    to: header(p, 'to'),
    cc: header(p, 'cc'),
    subject: header(p, 'subject'),
    text,
    textAsHtml: html,
  };
}

// "YOUR EXPORT IS READY" -- THE ONE MAIL THIS CONNECTOR READS AS AN EVENT.
//
// The LinkedIn export is the only source in this system the owner has to go and
// FETCH: request it, wait hours, and come back for a mail with a download in
// it. Nothing was watching for that mail, so the archive sat in an inbox while
// the setup screen went on saying the export was missing. Recognising it costs
// one header test on mail this connector is fetching anyway, and what it buys
// is a sentence the owner can act on.
//
// A MATCH IS A NUDGE, NOT A ROW. Nothing here writes to the corpus, changes an
// ingest, or follows a link. The mail lands in `context` exactly as it would
// have; this is a second, smaller reading of the same message.
//
// THE SENDER IS THE HALF THAT IS TIGHT, and it is checked first for that
// reason: the ADDRESS's domain must be `linkedin.com` itself or a subdomain of
// it (`e.linkedin.com`, `bounce.linkedin.com` -- the notification traffic moves
// between them), never a domain that merely ends in the string, which is what
// an anchored suffix keeps out of `notlinkedin.com`.
//
// THE ADDRESS, NOT THE DISPLAY NAME: parseAddressHeader treats angle brackets
// as authoritative, so `"LinkedIn <noreply@linkedin.com>" <x@attacker.com>`
// reads as x@attacker.com, which is what it is.
//
// AND EXACTLY ONE OF THEM (review finding 16). This used to ask whether ANY
// address in `From` was LinkedIn's, and `From: <a@attacker.com>,
// <b@linkedin.com>` is a legal header that passes such a test. A real `From`
// carries one address; a mail that carries two is not the one this is looking
// for, whichever order they are in.
const LINKEDIN_SENDER = /^(?:[a-z0-9-]+\.)*linkedin\.com$/u;
function fromLinkedin(raw) {
  const addresses = parseAddressHeader(raw);
  if (addresses.length !== 1) return false;
  const address = String(addresses[0]).toLowerCase();
  const at = address.lastIndexOf('@');
  return at !== -1 && LINKEDIN_SENDER.test(address.slice(at + 1));
}

// THE SUBJECT IS THE HALF THAT CANNOT BE TIGHT, because LinkedIn writes it
// several ways and has changed it before: "Your LinkedIn data is ready",
// "Your download is ready".
//
// ~~`ready` AND (`data` OR `download`), in any order~~ WAS ALSO TRUE OF
// LINKEDIN'S MARKETING (review finding 8). "Ready to grow your network?
// Download the app", from e.linkedin.com, satisfied every clause of it -- and
// the cost model that version wrote down ("a badge the owner dismisses by
// looking at their mail") was wrong, because nothing dismisses the marker
// except installing an export.
//
// ORDER IS WHAT SEPARATES THEM. LinkedIn's own sentence is about a thing that
// belongs to the owner and is now finished -- YOUR (data|download) ... is
// READY -- and the marketing sentence puts the availability word first and the
// possessive after it. So the three words must appear in that order, which the
// two known subjects do and "Ready to grow your network? Download the app"
// does not. Word-bounded, so "already" is not "ready" and "metadata" is not
// "data".
//
// Plus a short blocklist for the recurring mail that could still stumble into
// the shape ("your weekly ... is ready"), because a false positive is a badge
// nothing can clear and a false negative is one mail this pass did not act on.
const READY_SHAPE = /\byour\b[\s\S]*?\b(?:data|downloads?)\b[\s\S]*?\bready\b/u;
const NOT_THE_EXPORT = /\b(?:explore|insights?|weekly|newsletter)\b/u;
function subjectSaysReady(subject) {
  const text = typeof subject === 'string' ? subject.toLowerCase() : '';
  return READY_SHAPE.test(text) && !NOT_THE_EXPORT.test(text);
}

// `{ at }` for a mail that says the export is downloadable, else null.
// Exported for the fixture test: this is a rule about wording, and a rule about
// wording that nothing pins is a rule that drifts.
//
// The timestamp is Gmail's internalDate where the caller has one -- the same
// value every cursor in this file compares -- and the parsed date otherwise.
// NOTHING ELSE TRAVELS: not the subject, not the body, not the sender. See
// lib/linkedinExport.mjs for why the marker holds one number.
export function linkedinExportReadyNote(parsed, ts) {
  if (!fromLinkedin(parsed?.from) || !subjectSaysReady(parsed?.subject)) return null;
  const at = Number.isFinite(ts) ? Number(ts)
    : parsed?.date instanceof Date ? parsed.date.getTime()
    : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return { at };
}

// Per-account settings still come from the connectors config, but the config
// no longer names the ACCOUNTS — the grants do. `mail.accounts[]` was the list
// of mailboxes to read when a mailbox meant "an address plus an app password";
// now an authorized account is one by definition, and a config entry could
// only ever disagree with the grants on disk.
export function accountSettings(config, email) {
  const mail = config?.mail ?? {};
  const per = (Array.isArray(mail.accounts) ? mail.accounts : [])
    .find((a) => typeof a?.user === 'string' && a.user.toLowerCase() === String(email).toLowerCase());
  return {
    backfillDays: per?.backfillDays ?? mail.backfillDays ?? DEFAULT_BACKFILL_DAYS,
    maxBodyBytes: per?.maxBodyBytes ?? mail.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    getsPerMinute: per?.getsPerMinute ?? mail.getsPerMinute ?? DEFAULT_MAIL_GETS_PER_MINUTE,
    historyPagesPerPass: per?.historyPagesPerPass ?? mail.historyPagesPerPass ?? DEFAULT_HISTORY_PAGES_PER_PASS,
  };
}

export function createMailSource({
  accountsForScope = accountsWithScope,
  makeClient = createGmailClient,
  sleep: sleepImpl = sleep,
  // A SEAM FOR ONE OTHERWISE-UNTESTABLE BRANCH, and worth saying why rather
  // than leaving a reader to wonder. Both scan loops below have a `row !==
  // null` branch, and the cursor's soundness depends on what happens when it
  // is taken -- but through the real messageToRow that branch is currently
  // UNREACHABLE from here: mailEntityId always has account/folder/uid to fall
  // back on, and a message with a finite internalDate always has a finite
  // parsed.date, so any in-window message this file counts toward its
  // boundaries also produces a row. (A message with neither internalDate nor
  // a usable Date header does drop, but it moves no boundary and so cannot
  // move the cursor either.) The guard is kept because it is the invariant
  // the cursor rests on rather than a coincidence of today's mailRows, and
  // this seam is how it is held to a test instead of being unrun code.
  toRow = messageToRow,
} = {}) {
  return {
    name: 'mail',
    walksHistory: true,

    // Blocks only when NO account is authorized for mail. One grant is enough
    // to run — the same call the IMAP version made about one provisioned
    // mailbox, for the same reason: gating everything on the least-ready
    // account would mean adding a second mailbox silently switches the
    // connector off while its consent screen is open.
    needs({ home } = {}) {
      const opts = home ? { home } : {};
      if (accountsForScope(GMAIL_SCOPE, opts).length > 0) return [];
      return ['no Google account is authorized for mail: run `node ops/gcal-auth.mjs`, or open the connect page'];
    },

    async run(ctx) {
      const { state, ingest, config, log, now, home } = ctx;
      // The daemon's history time budget (HISTORY_BUDGET_MS), when it hands
      // one over. Absent => no deadline, which is what every forward pass and
      // every older daemon does.
      const deadline = Number.isFinite(ctx.deadline) ? Number(ctx.deadline) : null;
      const outOfTime = () => deadline !== null && now() >= deadline;
      const accounts = accountsForScope(GMAIL_SCOPE, home ? { home } : {});

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      // The newest "your export is ready" mail this pass read, across every
      // mailbox, and how many it saw. Run-scoped rather than per-account: the
      // owner may have requested the export from one address and read it in
      // another, and the marker names one event whoever received it.
      let exportReady = null;
      let exportReadySeen = 0;
      // The two bounds on what may become a nudge, resolved once: nothing from
      // before this install started reading, and nothing the reader would have
      // stopped answering for anyway (EXPORT_READY_MAX_AGE_MS). See
      // FIRST_PASS_KEY, and lib/linkedinExport.mjs for the age bound's other
      // half, which is the load-bearing one.
      const firstPassRaw = Number(state.getCursor(FIRST_PASS_KEY));
      const firstPassAt = Number.isFinite(firstPassRaw) && firstPassRaw > 0 ? firstPassRaw : now();
      if (firstPassAt !== firstPassRaw) state.setCursor(FIRST_PASS_KEY, String(firstPassAt));
      const exportReadyFloor = Math.max(firstPassAt, now() - EXPORT_READY_MAX_AGE_MS);
      const failures = [];
      const yearly = ctx.history === true && ctx.historyWindow?.year ? ctx.historyWindow : null;
      let historyDone = true;
      let historyHasOlder = false;
      let historyProgressed = false;

      // THE PASS ORDER. The backwards walk is not rotated: it hands every
      // account the same year and the same whole deadline, so position buys
      // nothing there. `accountIndex` stays the account's TRUE index whatever
      // the order, because it is what the logs and the failure list identify a
      // mailbox by; only the slicing below reads the pass position.
      // AND ONLY WHEN THERE IS A DEADLINE TO SLICE. `accountDeadline` is null
      // without one, so every mailbox has the whole pass however it is ordered
      // and the position buys nothing -- one cursor write per pass for no
      // effect, moving a stored index that means nothing until a deadline
      // arrives and then starts from wherever the drift left it.
      // CURSORS FOR MAILBOXES THIS INSTALL NO LONGER HAS. `drainOwedKey` is keyed
      // by address and cleared only from inside the account loop, so a mailbox
      // whose grant is revoked leaves its mark behind -- and the same address
      // re-authorised later starts life owing a drain against a gap that no
      // longer exists, spending one exempt page on an empty query. Durable state
      // keyed by an identifier nothing collects.
      //
      // The address never reaches a log line; this is a cursor delete, and the
      // key it deletes was written by this same connector.
      //
      // AND NEVER ON AN EMPTY LIST (round-7 finding 16). `accountsForScope` is
      // stricter than the stale-tolerant reader needs() uses, so a pass that
      // lands inside a token refresh can see zero accounts -- and wiping every
      // remembered address there deletes the cursors of mailboxes this install
      // very much still has. An empty roster says the app could not ask, not
      // that the owner has no mail.
      //
      // AND THE WHOLE NAMESPACE, not just the owed flag (round-7 finding 17).
      // The gap, the forward cursor and the per-year history receipts are keyed
      // by the same address; leaving them meant a re-authorised mailbox came
      // back owing a drain against a gap that was ALSO still there. The prefix
      // delete is this connector's own namespace and nobody else's.
      if (accounts.length > 0) {
        const live = new Set(accounts.map((account) => String(account.email).toLowerCase()));
        for (const email of previousAccounts(state)) {
          if (live.has(email)) continue;
          if (typeof state.deleteCursors === 'function') {
            // `{ reopenYearly: false }`, because this is a CONNECTOR-scoped verb
            // being used as a prefix delete. It is correct today only because
            // nothing writes a per-address yearly receipt: the day something
            // does, dropping one stale mailbox would call reopenYearlyWalk()
            // and reset the shared walk for every source on the machine.
            state.deleteCursors(`mail:${email}`, { reopenYearly: false });
          } else {
            state.deleteCursor(drainOwedKey(email));
          }
        }
        rememberAccounts(state, [...live]);
      }
      const rotating = yearly === null && accounts.length > 1 && deadline !== null;
      const start = rotating
        ? (((Number(state.getCursor(FORWARD_START_KEY)) || 0) % accounts.length) + accounts.length)
          % accounts.length
        : 0;
      const passOrder = [...accounts.entries()];
      const pass = [...passOrder.slice(start), ...passOrder.slice(0, start)];
      // Advanced up front, so a pass that throws partway still moves the turn
      // on: a mailbox whose scan fails must not hold first place forever.
      if (rotating) state.setCursor(FORWARD_START_KEY, String((start + 1) % accounts.length));

      for (const [passIndex, [accountIndex, account]] of pass.entries()) {
        if (yearly && state.getCursor(historyDoneKey(account.email, yearly.year)) === '1') {
          historyHasOlder ||= state.getCursor(historyOlderKey(account.email, yearly.year)) === '1';
          continue;
        }
        // THE FORWARD BUDGET, SHARED ACROSS THE MAILBOXES THAT STILL HAVE TO
        // RUN THIS PASS.
        //
        // The backwards walk takes the run's deadline whole, because it is a
        // year at a time and every account is walking the same year. The
        // forward scan cannot: its cap is PER ACCOUNT (2,000 gets), so one
        // deadline for the whole pass is one deadline the first mailbox spends
        // in full, every pass, forever — the second and third would never make
        // a single call on a cold window. An equal slice of whatever is LEFT
        // gives each account a turn and still returns inside the run's budget.
        //
        // A slice bounds pages after the first, not the first: scanWindow's
        // do-while checks it at page boundaries, so every account gets at least
        // one page out of every pass however small its slice is. That is
        // deliberate — it is what makes the walk monotone for EVERY mailbox
        // rather than only the first — and it is why the pass may exceed the
        // run's budget by at most ONE page per account. A page is bounded work
        // (PAGE_SIZE gets at the pacer's rate); an unbounded pass was the bug.
        //
        // ONE PAGE PER ACCOUNT, AND THE DRAIN IS INSIDE IT (round-4 finding 4).
        // Briefly the gap drain ran with no time gate at all, which let each
        // mailbox spend an exempt page in the fresh window AND another in the
        // drain: at defaults (PAGE_SIZE 100 gets, 90 gets/minute → ~66s a page)
        // that doubled the worst case from ~200s to ~400s at three mailboxes
        // and from ~400s to ~790s at six, against a 120s budget. The gate is
        // back; the starvation it used to cause is answered by rotating which
        // mailbox goes first (FORWARD_START_KEY) instead.
        //
        // THE WORST CASE THAT LEAVES, in numbers. Every account can spend one
        // full page beyond its slice, in whichever window was in flight when
        // the slice ran out, and nothing after it:
        //
        //   mailboxes | worst-case pass | budget
        //   3         | ~200 s          | 120 s
        //   6         | ~400 s          | 120 s
        //
        // i.e. accounts × one page, or accounts × PAGE_SIZE ÷ getsPerMinute.
        // It exceeds FORWARD_BUDGET_MS and, at six mailboxes, the 60s interval
        // floor — a long pass reschedules from its own finish, so this costs
        // cadence rather than correctness, and it is the shape the budget was
        // sized against.
        //
        // AND THE SLICE HAS A FLOOR, because ~~an equal slice of whatever is
        // LEFT~~ is zero once the budget is gone. A page is exempt from the
        // slice but not from arithmetic: with three mailboxes at defaults a
        // full page is ~66s against a 40s share, so the first two mailboxes
        // overran the whole 120s and the third was handed `now()` on every
        // pass, forever — a deadline already in the past is not a turn, it is a
        // mailbox that can do nothing but its one exempt page. The floor makes
        // the last mailbox's turn real; the cost is that a pass may exceed the
        // run's budget by accounts × this floor — every remaining mailbox, not
        // all but one (round-4 finding 19): once the budget is spent,
        // `floor(negative / remaining)` is negative for the FIRST of them too,
        // so each takes the floor. Bounded, and an order of magnitude inside
        // the polling interval.
        const remaining = accounts.length - passIndex;
        const accountDeadline = deadline === null || yearly
          ? deadline
          : now() + Math.max(MIN_ACCOUNT_SLICE_MS, Math.floor((deadline - now()) / remaining));
        const accountOutOfTime = () => accountDeadline !== null && now() >= accountDeadline;
        const { backfillDays, maxBodyBytes, getsPerMinute, historyPagesPerPass } = accountSettings(config, account.email);
        const spacingMs = 60_000 / getsPerMinute;
        // A minimum spacing enforced between every Gmail API call this
        // account makes this run, list calls included (the measurement above
        // was taken with one list call per page, so it counts against the
        // same per-minute budget). The very first call of the account's run
        // never waits — there is nothing before it to space from.
        let firstApiCall = true;
        const pace = async () => {
          if (!firstApiCall) await sleepImpl(spacingMs);
          firstApiCall = false;
        };
        const stored = Number(state.getCursor(cursorKey(account.email)));
        const rollingFloor = now() - backfillDays * 86_400_000;
        const freshFloor = Math.max(
          rollingFloor,
          new Date(new Date(now()).getFullYear(), 0, 1).getTime()
        );
        const floor = yearly
          ? yearly.fromTs
          : (Number.isFinite(stored) && stored > 0
              ? stored
              : freshFloor);
        // Gmail's `after:` takes whole seconds and is inclusive to the day on
        // some paths, so the query is deliberately a little wider than the
        // cursor and the exact bound is enforced below. Fetching a handful of
        // already-seen messages costs a dedupe; missing one costs it forever.
        // The fresh window is widened by the SAME second the yearly and drain
        // queries are (`- 1`), which it was not: its JS bound is inclusive at
        // the cursor, so a query that starts exactly at floor(cursor/1000) can
        // land inside the second the bound still accepts and drop the ties
        // there. Wider costs a dedupe; narrower costs the message forever.
        const q = yearly
          ? `after:${Math.floor(yearly.fromTs / 1000) - 1} before:${Math.ceil(yearly.toTs / 1000)}`
          : `after:${Math.floor(floor / 1000) - 1}`;
        const client = makeClient({ email: account.email, ...(home ? { home } : {}) });

        try {
          let seen = 0;
          let skipped = 0;
          const rows = [];
          let pagesFetched = 0;

          // A message listed and then gone by the time we ask for it has been
          // DELETED between the two calls: Gmail answers 404 and there is
          // nothing to ingest, ever. Skipped and counted rather than thrown —
          // one deleted message must not fail an entire account's pass, and
          // before per-page ingest it discarded every message fetched before
          // it too. Every other status still throws: a 401, a quota 403 or a
          // 5xx is a condition the caller has to see.
          const getMessageOrNull = async (id) => {
            try {
              return await client.getMessage(id);
            } catch (error) {
              if (Number(error?.status) === 404) return null;
              throw error;
            }
          };

          if (yearly) {
            let pageToken = state.getCursor(historyPageKey(account.email, yearly.year)) ?? undefined;
            let yearDone = false;

            // Drain up to historyPagesPerPass pages this pass instead of one.
            // Pacing between gets is unchanged (same getsPerMinute limiter
            // below); this just lets the loop run longer per invocation
            // rather than the daemon invoking the source more often.
            for (let page = 0; page < historyPagesPerPass; page += 1) {
              // BUDGET CHECKED BETWEEN PAGES, not only between passes. The
              // daemon's 20s history budget was measured around source.run(),
              // so once a pass drained several pages the budget was exceeded
              // by one to two orders of magnitude and the daemon had no way
              // to notice until the call returned. Checked before the page's
              // first API call so the pass stops cleanly on a page boundary,
              // with this year's durable token already persisted (below) --
              // the next pass picks up exactly where this one stopped.
              if (page > 0 && outOfTime()) break;
              await pace();
              const list = await client.listMessages({ q, pageToken, maxResults: PAGE_SIZE });
              historyProgressed = true;
              pagesFetched += 1;
              pageToken = list.nextPageToken;
              const stubs = list.messages ?? [];
              const pageRows = [];
              for (const [stubIndex, stub] of stubs.entries()) {
                if (stubIndex > 0) await sleepImpl(spacingMs);
                seen += 1;
                const full = await getMessageOrNull(stub.id);
                if (full === null) {
                  skipped += 1;
                  continue;
                }
                const internal = Number(full?.internalDate);
                // The exact bound the query could only approximate.
                if (!Number.isFinite(internal) || internal < yearly.fromTs || internal >= yearly.toTs) continue;
                const parsed = gmailMessageToParsed(full);
                const row = toRow(parsed, {
                  account: account.email,
                  folder: 'INBOX',
                  uid: stub.id,
                  uidValidity: 'gmail',
                  maxBodyBytes,
                });
                // No `highest` here: the yearly walk's progress is its durable
                // page token, and the forward cursor belongs to the forward
                // window alone. The variable this used to feed was written by
                // this branch and read by nobody.
                if (row !== null) pageRows.push(row);
              }

              // Ingest and persist THIS PAGE's token before moving on, so a
              // failure on a later page in the same pass never leaves the
              // durable token ahead of rows that were fetched but never
              // ingested — the same invariant the old single-page pass kept.
              if (pageRows.length > 0) {
                const totals = await ingest(pageRows);
                inserted += totals?.inserted ?? 0;
                updated += totals?.updated ?? 0;
                unchanged += totals?.unchanged ?? 0;
                rows.push(...pageRows);
              }

              if (pageToken) {
                state.setCursor(historyPageKey(account.email, yearly.year), pageToken);
              } else {
                state.deleteCursor(historyPageKey(account.email, yearly.year));
                await pace();
                const older = await client.listMessages({
                  q: `before:${Math.floor(yearly.fromTs / 1000)}`,
                  maxResults: 1,
                });
                const hasOlder = (older.messages?.length ?? 0) > 0;
                state.setCursor(historyDoneKey(account.email, yearly.year), '1');
                state.setCursor(historyOlderKey(account.email, yearly.year), hasOlder ? '1' : '0');
                historyHasOlder ||= hasOlder;
                yearDone = true;
              }

              // Stop early: the year finished, or this page had nothing left
              // to give — draining further pages this pass would just spend
              // the budget on empty list calls.
              if (yearDone || stubs.length === 0) break;
            }

            if (!yearDone) historyDone = false;
          } else {
            // ===================================================================
            // THE FORWARD SCAN — CURSOR SEMANTICS AND FAILURE MODEL
            //
            // Gmail lists NEWEST-FIRST and one pass is capped, so the durable
            // state has to describe a PARTIALLY read range rather than a
            // single high-water mark. Three values per account:
            //
            //   cursor    mail:<a>:internalDate      every message with
            //             internalDate >= cursor has been read by some pass,
            //             EXCEPT what the gap carves out.
            //   gap.from  mail:<a>:forward-gap-from  INCLUSIVE floor of the
            //             hole: accept internalDate >= from.
            //   gap.until mail:<a>:forward-gap-until INCLUSIVE ceiling of the
            //             hole: accept internalDate <= until. until <= cursor
            //             always. Both keys exist or neither does.
            //
            // TIES ON internalDate, which is the whole reason each bound is
            // inclusive on the side it is. internalDate is milliseconds and
            // Gmail orders equal timestamps ARBITRARILY, so a boundary read
            // off one message says nothing about its twins: the cap can cut a
            // run of same-millisecond messages in half, and which half is
            // luck. So every boundary here is inclusive on the side that
            // would otherwise exclude them — the fresh window accepts
            // internalDate >= cursor, a drain accepts from <= internalDate <=
            // until — and the resulting re-read is absorbed downstream, where
            // hermes dedupes on (source, entity_id). Exclusive bounds are
            // cheaper by at most one page and drop those twins from EVERY
            // future window: the fresh one rejects <= cursor, the drain
            // rejects >= until, and nothing else ever looks there. That was
            // the bug (2026-09 review, finding 1); the old tests spaced their
            // fixtures 60s apart and could not see it.
            //
            // `until === from` is therefore a real one-millisecond hole (ties
            // at the floor, cut by the cap) and is drained like any other;
            // only `until < from` means "no gap", and it is written by
            // nothing — a drained gap has both keys DELETED, so a stored
            // until === from is not misread as absence (finding 7).
            //
            // WHAT THE CURSOR MAY ADVANCE OVER. ~~"rows that actually
            // ingested"~~ (this file's header): messages this pass FETCHED
            // and found inside the window — ingested, or deliberately dropped
            // by mailRows for want of a usable date. NOT messages the cap
            // never listed; those are exactly what the gap is for.
            // Fetched-and-dropped has to count, or a truncated window whose
            // 2,000 gets all produced no row moves nothing at all and the
            // identical no-op pass repeats every cycle at 2,000 gets
            // (finding 3).
            //
            // AMENDED 2026-09 (review G finding 3), because "has to count"
            // was doing two jobs and only one of them held. Advancing over
            // fetched-and-dropped messages is right — otherwise, livelock —
            // but advancing over them WITHOUT RECORDING ANYTHING was not: a
            // page whose every in-window message yielded null, on a window
            // that was not truncated, moved the cursor past all of them with
            // no hole written, and nothing ever looked there again. The rule
            // is now: the cursor never advances over a page that landed
            // nothing unless the page was empty (or held only deletions and
            // out-of-window stubs, which is the same thing) — and when it
            // does advance over one, that page's own [lowest, highest] goes
            // in as a gap first, under the same gap-then-cursor order as
            // everything else here.
            //
            // QUERY WIDTH. Gmail's `after:`/`before:` take whole seconds, so
            // every query is widened by a second on each side and the exact
            // bound is enforced in JS against internalDate. Wider costs a
            // dedupe; narrower costs the message forever.
            //
            // FAILURE MODEL: A KILLED OR FAILED PASS LOSES AT MOST ONE PAGE.
            // Each page is ingested and then has its progress persisted
            // before the next list call, so the durable state after any page
            // is TRUE rather than optimistic: the fresh window writes the
            // hole it WOULD leave if the pass ended right here (gap = old gap
            // ∪ [floor, lowest read]) and retracts it only on the page that
            // proves the window ran to the bottom. A throw from messages.get
            // therefore costs the page in flight, never the up-to-2,000
            // messages fetched before it, and a deterministically failing get
            // cannot livelock the account because every pass gets further
            // (finding 2). A 404 from messages.get is a message deleted
            // between list and get: skipped, counted, never thrown.
            //
            // WRITE ORDER: GAP FIRST, CURSOR SECOND — because they CANNOT
            // share a transaction. The state API a source is handed is
            // getCursor/setCursor/deleteCursor, three single statements;
            // openStateDb keeps BEGIN/COMMIT for its own multi-row writes and
            // exposes no transaction to callers, and the daemon hands sources
            // no db handle. So the writes are ordered so that a kill between
            // them UNDER-claims coverage: widening the gap (which takes
            // coverage AWAY) precedes raising the cursor (which claims it).
            // Every interleaving leaves state that re-reads something already
            // read; none leaves state claiming a message was read when it was
            // not (finding 6).
            //
            // A SECOND TRUNCATION CANNOT NARROW THE HOLE. A drain only ever
            // lowers its own ceiling (min with what is stored), so
            // consecutive truncated drains walk downward and overlap by at
            // most the tie-inclusive boundary page. The one widening left is
            // deliberate: a FRESH window truncating while a gap is already
            // open leaves two disjoint holes, two keys hold one interval, so
            // they hold the union [old from, new lowest] and the next drain
            // re-reads the stretch between the old ceiling and the old cursor
            // (finding 5). The alternatives are worse — a list is a schema
            // this connector has no migration for, and not advancing the
            // cursor livelocks forever on the newest 2,000.
            // ===================================================================

            const gapFromName = gapFromKey(account.email);
            const gapUntilName = gapUntilKey(account.email);

            const readGap = () => {
              const from = Number(state.getCursor(gapFromName));
              const until = Number(state.getCursor(gapUntilName));
              if (!Number.isFinite(from) || !Number.isFinite(until) || from <= 0) return null;
              return until >= from ? { from, until } : null;
            };
            // Gap first, cursor second — and the deletes are both-or-neither,
            // so a half-present gap can never be read back as a hole with an
            // invented bound.
            const writeGap = (next) => {
              if (next === null || !(next.until >= next.from)) {
                state.deleteCursor(gapFromName);
                state.deleteCursor(gapUntilName);
                return;
              }
              state.setCursor(gapFromName, String(next.from));
              state.setCursor(gapUntilName, String(next.until));
            };

            // ONE newest-first window, INGESTED AND PERSISTED PER PAGE.
            // `onPage` is handed the window's cumulative highest and lowest
            // in-window internalDate, how many rows have landed so far, and
            // whether anything is known to remain BELOW what has been read
            // (the cap cut a page, or a page token is still in hand). It runs
            // after that page's ingest resolves and before the next list
            // call, which is what bounds a killed pass to one page.
            // `gets` BOUNDS ONE CALL, on top of the per-account cap.
            //
            // Round-7 finding 1: the owed drain runs BEFORE the fresh window, and
            // `seen` is one closure variable for the whole account. A hole
            // holding more than MAX_MESSAGES_PER_ACCOUNT therefore spent the
            // entire cap at the top of the pass -- the fresh window then entered
            // with nothing left, landed no rows, and truncated, which re-owed the
            // drain and made the next pass byte-identical. New mail stopped
            // landing on that account for as many passes as the hole took to
            // drain, which is hours, and inverts this file's own rule that new
            // mail matters more than an old hole.
            //
            // So the owed drain gets a page and the fresh window keeps the rest.
            const scanWindow = async ({ q: query, minTs, maxTs, onPage, gets = null }) => {
              // Computed at entry against whatever `seen` already is, so it is a
              // ceiling on THIS call and still respects the account's cap.
              const ceiling = gets === null
                ? MAX_MESSAGES_PER_ACCOUNT
                : Math.min(MAX_MESSAGES_PER_ACCOUNT, seen + gets);
              let pageToken;
              let highestIn = 0;
              let lowestIn = Number.POSITIVE_INFINITY;
              let landed = 0;
              let capHit = false;
              // Set when a fetched message lands BELOW this window's floor.
              // The listing is newest-first, so from there on every remaining
              // stub is older still: the window has been read to the bottom
              // and nothing above the floor is missing. It is the difference
              // between a truncation and a finish -- without it, a query whose
              // widened second happens to hold thousands of below-floor
              // messages spends the entire per-account cap on messages it then
              // discards, records nothing (there is no hole ABOVE the floor to
              // record), and repeats the identical pass every cycle
              // (finding 3). A `continue` cannot know it is safe to stop; the
              // ordering can.
              let belowFloor = false;
              do {
                await pace();
                const list = await client.listMessages({ q: query, pageToken, maxResults: PAGE_SIZE });
                pagesFetched += 1;
                pageToken = list.nextPageToken;
                const pageRows = [];
                // PER-PAGE bounds, alongside the window-cumulative ones: the
                // cursor is written per page, so whether THIS page justifies
                // the advance has to be answerable per page (finding 3).
                // Only messages that were fetched and placed inside the
                // window move these -- a 404, a stub above maxTs, and a
                // message with no usable internalDate all leave them alone,
                // which is what keeps a page of nothing but deletions from
                // being recorded as a hole.
                let pageHighest = 0;
                let pageLowest = Number.POSITIVE_INFINITY;
                let pageInWindow = 0;
                for (const [stubIndex, stub] of (list.messages ?? []).entries()) {
                  if (seen >= ceiling) {
                    capHit = true;
                    break;
                  }
                  if (stubIndex > 0) await sleepImpl(spacingMs);
                  seen += 1;
                  const full = await getMessageOrNull(stub.id);
                  if (full === null) {
                    skipped += 1;
                    continue;
                  }
                  const internal = Number(full?.internalDate);
                  // The exact bounds the whole-second query only approximated,
                  // inclusive on both ends. A message with NO usable
                  // internalDate cannot be placed either side of a bound, so
                  // it is not judged by one: mailRows keeps it if its Date
                  // header is usable and drops it otherwise, and either way it
                  // contributes nothing to the boundaries below.
                  if (Number.isFinite(internal)) {
                    if (minTs !== null && internal < minTs) {
                      belowFloor = true;
                      break;
                    }
                    if (maxTs !== null && internal > maxTs) continue;
                    // Tracked over messages FETCHED in-window, not only over
                    // rows that landed: see "WHAT THE CURSOR MAY ADVANCE
                    // OVER" above.
                    if (internal > highestIn) highestIn = internal;
                    if (internal < lowestIn) lowestIn = internal;
                    if (internal > pageHighest) pageHighest = internal;
                    if (internal < pageLowest) pageLowest = internal;
                    pageInWindow += 1;
                  }
                  const parsed = gmailMessageToParsed(full);
                  // IN THE FORWARD SCAN ONLY, and that is the point rather than
                  // an oversight. This window is new mail (and, on a first run,
                  // the backfill days behind it); the backwards yearly walk is
                  // months and years old by construction, and a download link
                  // from last spring is not news -- badging it would send the
                  // owner to a mail whose archive LinkedIn has long since
                  // expired. Every forward path comes through here: the fresh
                  // window and both gap drains all run this same loop.
                  const note = linkedinExportReadyNote(parsed, internal);
                  if (note !== null && note.at >= exportReadyFloor) {
                    exportReadySeen += 1;
                    if (exportReady === null || note.at > exportReady.at) exportReady = note;
                  }
                  const row = toRow(parsed, {
                    account: account.email,
                    folder: 'INBOX',
                    uid: stub.id,
                    uidValidity: 'gmail',
                    maxBodyBytes,
                  });
                  if (row !== null) pageRows.push(row);
                }

                if (pageRows.length > 0) {
                  const totals = await ingest(pageRows);
                  inserted += totals?.inserted ?? 0;
                  updated += totals?.updated ?? 0;
                  unchanged += totals?.unchanged ?? 0;
                  rows.push(...pageRows);
                  landed += pageRows.length;
                }
                const truncated = capHit || (!belowFloor && Boolean(pageToken));
                onPage({
                  highest: highestIn,
                  lowest: Number.isFinite(lowestIn) ? lowestIn : 0,
                  landed,
                  truncated,
                  // A page whose every in-window message yielded no row: its
                  // own bounds, so the caller can record the hole it is about
                  // to advance over. Zero when the page landed something, or
                  // had nothing in-window to land.
                  nullPage: pageInWindow > 0 && pageRows.length === 0
                    ? { from: pageLowest, until: pageHighest }
                    : null,
                });
                // THE BUDGET, CHECKED ON A PAGE BOUNDARY — the same place the
                // backwards walk checks its own, and for the same reason: the
                // page's ingest, gap and cursor are already persisted, and
                // `truncated` above has already recorded the hole this stop
                // leaves behind. Every interleaving still under-claims
                // coverage, so stopping here costs a re-read at worst.
              } while (
                !capHit && !belowFloor && pageToken
                && seen < ceiling && !accountOutOfTime()
              );

              return { landed, truncated: capHit || (!belowFloor && Boolean(pageToken)) };
            };

            // ONE DRAIN, CALLABLE FROM EITHER SIDE OF THE FRESH WINDOW.
            //
            // Ordinarily it runs after: new mail outranks an old hole. But an
            // owed turn that can never be taken is not a turn, and a mailbox
            // whose fresh window fills MAX_MESSAGES_PER_ACCOUNT on every pass
            // arrives at the drain with the cap already spent every time -- so
            // the turn it was owed is re-owed for ever and the hole is never
            // read, which is the starvation the owing was added to end. When one
            // is owed it therefore goes FIRST, before the cap and the slice are
            // spent. The cost is that the fresh window starts a page down on
            // alternate passes; nothing is lost, because the forward cursor
            // never moves backwards, it only advances a little later.
            const drainGap = async (gap, { gets = null } = {}) => {
              await scanWindow({
                gets,
                // `floor(until/1000) + 1` covers every tie inside `until`'s own
                // second without widening a second further than that: above
                // the ceiling there is no early exit to bound the waste (a
                // message above `until` says nothing about the hole), so this
                // side is kept as tight as the tie rule allows.
                q: `after:${Math.floor(gap.from / 1000) - 1} before:${Math.floor(gap.until / 1000) + 1}`,
                minTs: gap.from,
                maxTs: gap.until,
                onPage: ({ lowest, truncated }) => {
                  // A drain that read to the bottom has read the whole
                  // remaining hole: BOTH keys go, including the case where its
                  // lowest row sits exactly on gap.from. Otherwise the ceiling
                  // only ever comes DOWN. The cursor is never touched here —
                  // the gap lives entirely below it.
                  if (!truncated) {
                    writeGap(null);
                    return;
                  }
                  if (lowest > 0) writeGap({ from: gap.from, until: Math.min(gap.until, lowest) });
                },
              });
            };
            // The turn this mailbox was owed, taken before anything else can
            // spend the budget it needs.
            const owedGap = state.getCursor(drainOwedKey(account.email)) === '1'
              ? readGap()
              : null;
            if (owedGap !== null) {
              state.deleteCursor(drainOwedKey(account.email));
              // HALF THE CAP, and the other half is the reserve.
              //
              // Not a page: after any truncation the owed drain IS the ordinary
              // path, and a hole of a few hundred messages should close in one
              // pass rather than five. Not the whole cap either, which is the
              // starvation -- what matters is that the fresh window can never
              // arrive with nothing left, so new mail keeps landing however deep
              // the hole is.
              await drainGap(owedGap, { gets: OWED_DRAIN_GETS });
            }
            const priorGap = readGap();
            // Set when the fresh window records a hole for a page it just
            // fetched (see nullPage below). It suppresses THIS pass's drain,
            // because re-reading, in the same pass, the exact page whose gets
            // have just been spent is pure waste -- and because the drain
            // clears a hole it reads to the bottom whether or not anything
            // landed, which would wipe the record before it ever survived a
            // cycle. Next cycle's drain gets a genuine second attempt, and if
            // that one lands nothing either the hole is released rather than
            // re-read forever.
            let nullPageSeen = false;

            // (a) THE FRESH WINDOW, first and always: new mail matters more
            // than an old hole, and after the first pass this window is a
            // handful of messages.
            const fresh = await scanWindow({
              q,
              minTs: floor,
              maxTs: null,
              onPage: ({ highest, lowest, truncated, nullPage }) => {
                // The truthful state if the pass ended on this page. While
                // anything remains below, that is a hole from the window's
                // floor up to the lowest row read; the page that proves the
                // window reached the bottom puts back whatever gap was there
                // before (which the fresh window never covers, since its
                // ceiling is at or below this window's floor).
                //
                // A PAGE THAT LANDED NOTHING IS A HOLE, NOT PROGRESS
                // (finding 3). The cursor still advances -- holding it would
                // livelock the account on the same 2,000 gets every cycle,
                // which is what "fetched-and-dropped has to count" above was
                // protecting against -- but the page's own [lowest, highest]
                // is recorded as a gap first, so the messages it skipped over
                // stay reachable instead of falling silently below the
                // cursor. The `!truncated` single-page case is the one the
                // old code lost outright: nothing remained below, so no hole
                // was recorded, and the cursor jumped the whole page.
                //
                // The DRAIN deliberately does NOT do this. It has already
                // re-read those messages once by the time it sees them, and a
                // hole nothing can ever fill (mailRows drops them
                // deterministically) has to be released or the connector
                // re-reads it every cycle forever.
                const holes = [];
                if (priorGap) holes.push(priorGap);
                if (truncated && lowest > 0) holes.push({ from: floor, until: lowest });
                if (nullPage !== null) {
                  holes.push(nullPage);
                  nullPageSeen = true;
                }
                writeGap(holes.length === 0 ? null : {
                  // Two keys, one interval: same union rule as a fresh
                  // truncation over an already-open gap, and the same cost --
                  // the next drain re-reads the stretch between them.
                  from: Math.min(...holes.map((h) => h.from)),
                  until: Math.max(...holes.map((h) => h.until)),
                });
                if (highest > 0) state.setCursor(cursorKey(account.email), String(highest));
              },
            });

            // (b) DRAIN THE GAP with whatever budget the fresh window left,
            // newest-first from the ceiling down. Re-read rather than trusted
            // from `priorGap`: the fresh window's own per-page writes are the
            // authority on what is still missing.
            // THE HOLE ITSELF, asked for unconditionally. `suppressed` below is a
            // statement about whether re-reading it THIS pass is worth the gets,
            // not about whether it exists -- and conflating the two is what left
            // a cap-filled pass with no hole to owe a turn against.
            const heldGap = readGap();
            const suppressed = fresh.truncated || nullPageSeen;
            // THE TIME GATE, AND WHY IT IS BACK (round-4 finding 4).
            //
            // Dropping it was meant to stop the drain starving. It did, at the
            // cost of the one guarantee the slice arithmetic rests on: without
            // it a mailbox spends an exempt page in the fresh window and a
            // second exempt page here, so "at most one page per account beyond
            // the budget" became two and the worst-case pass doubled (the table
            // above). The starvation it was answering had a cheaper fix — the
            // last mailbox was starving because it was ALWAYS the last mailbox,
            // and the pass now rotates.
            //
            // With the gate, the drain runs whenever the account still has
            // slice left, and its own do-while then stops on the next page
            // boundary exactly like the fresh window's. So the drain either
            // does not start or costs one bounded page, and the account's total
            // overrun stays one page either way.
            //
            // AND A GATE THAT REFUSES THE SAME MAILBOX EVERY TIME IS NOT A GATE
            // (round-5 finding 6). See drainOwedKey: a fresh window that fits in
            // one page and still spends the whole slice leaves the drain gated
            // out in every rotation position, forever. The turn it is owed is
            // spent here.
            // THE CAP STARVES IT THE SAME WAY THE CLOCK DOES (round-6 finding 9),
            // AND SO DOES THE SUPPRESSION.
            //
            // The first version only owed a turn when the DEADLINE blocked the
            // drain. A mailbox whose fresh window fills MAX_MESSAGES_PER_ACCOUNT
            // truncates, which zeroes the gap and fails every condition at once:
            // the drain does not run, and nothing records that one is due -- so
            // the next pass starts from the same place with the same outcome. A
            // high-volume mailbox never reads its hole at all, which is the
            // starvation this mechanism was added to end, one class over.
            //
            // THREE WAYS TO BE BLOCKED, ONE RULE. Out of slice, gets already
            // spent this pass, or the cap reached -- each one owes a turn, and an
            // owed turn overrides the first two on the pass after. It does NOT
            // override the cap: `seen` cannot be spent past, so a drain launched
            // there would burn a list call to fetch nothing. That turn stays
            // owed for the next pass, where `seen` starts at zero.
            const capSpent = seen >= MAX_MESSAGES_PER_ACCOUNT;
            const blocked = capSpent || suppressed || accountOutOfTime();
            // OWED AGAIN IF THERE IS STILL A HOLE, even where a turn was already
            // spent at the top of this pass. A mailbox that fills the cap every
            // time records a FRESH hole on every truncation, so "it already had
            // its turn" would hand it exactly one drain in the life of the
            // install and then starve it again -- the same bug wearing the fix.
            if (heldGap !== null && blocked) {
              state.setCursor(drainOwedKey(account.email), '1');
            } else if (heldGap !== null && owedGap === null) {
              // ONE DRAIN PER PASS. An owed drain that narrowed the hole without
              // closing it leaves heldGap non-null, and running the ordinary one
              // on top doubles the cost of the very pass the owing exists to
              // bound (round-7 finding 18). What is left is owed, not taken now.
              await drainGap(heldGap);
            } else if (heldGap !== null) {
              state.setCursor(drainOwedKey(account.email), '1');
            }
            // No hole, nothing owed. Kept out of the branches above because the
            // drain can close the gap from inside its own onPage, and a turn
            // owed against a hole that no longer exists would spend a page on
            // an empty query the next time the slice ran short.
            if (readGap() === null) state.deleteCursor(drainOwedKey(account.email));
          }

          // accountIndex, NEVER account.email. This file's own LOG POLICY
          // header says "No addresses", connectors/lib/log.mjs writes every
          // line to a persistent ~/.hazlie/logs/connectors.log, and
          // FORBIDDEN_FIELDS there is a blocklist of content field NAMES that
          // cannot see a value that happens to be personal data. The failure
          // path below always did this correctly; the success path did not.
          log.info('mail_account_scan', {
            connector: 'mail',
            accountIndex,
            fetched: seen,
            rows: rows.length,
            pages: pagesFetched,
            // Messages Gmail listed and then 404'd: deleted between the two
            // calls. A count, never an id — and worth having, because a
            // rising one means something else is deleting mail.
            skipped,
            ...(yearly ? { historyYear: yearly.year } : {}),
          });
        } catch (error) {
          // One mailbox failing must not cost the others theirs — separate
          // grants, separate tokens, separate fates.
          failures.push(accountIndex);
          const { status, kind } = classifyMailError(error);
          log.warn('mail_account_failed', { connector: 'mail', accountIndex, status, kind });
        }
      }

      // THE NOTE, WRITTEN ONCE PER PASS AND ONLY DOWNWARD-SAFE. noteExportReady
      // refuses while Connections.csv is already in place (the nudge has been
      // answered) and refuses a mail no newer than the marker on disk, so a
      // backfill re-reading the same message -- or a second mailbox holding a
      // copy of it -- rewrites nothing.
      //
      // COUNTS ONLY IN THE LOG (connectors/AGENTS.md): how many such mails this
      // pass saw and whether the marker moved. Neither the subject nor the
      // sender goes anywhere -- not into the log, and not into the marker,
      // which holds the timestamp alone.
      if (exportReady !== null) {
        // THE PASS'S OWN CLOCK, not the wall clock: every other bound in this
        // run is measured against ctx.now, and the age gate inside
        // noteExportReady has to agree with the floor computed above.
        const noted = noteExportReady(home, exportReady, { now });
        log.info('mail_linkedin_export_ready', {
          connector: 'mail', seen: exportReadySeen, noted: noted ? 1 : 0,
        });
      }

      if (accounts.length > 0 && failures.length === accounts.length) {
        throw new Error(`all ${accounts.length} mail account(s) failed`);
      }
      if (yearly) {
        for (const account of accounts) {
          historyDone &&= state.getCursor(historyDoneKey(account.email, yearly.year)) === '1';
          historyHasOlder ||= state.getCursor(historyOlderKey(account.email, yearly.year)) === '1';
        }
      }
      return {
        inserted,
        updated,
        unchanged,
        failures: failures.length,
        accounts: accounts.length,
        ...(yearly ? {
          historyDone,
          historyHasOlder,
          historyProgressed,
        } : {}),
      };
    },
  };
}

export default createMailSource();
