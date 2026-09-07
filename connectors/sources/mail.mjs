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
import { DEFAULT_MAX_BODY_BYTES, messageToRow } from '../lib/mailRows.mjs';

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
// Addresses stay as their raw header strings: normalizeAddresses over there
// handles both a string and mailparser's object form, so this does not need to
// grow a parser it would then have to keep correct.
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
      const accounts = accountsForScope(GMAIL_SCOPE, home ? { home } : {});

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      const failures = [];
      const yearly = ctx.history === true && ctx.historyWindow?.year ? ctx.historyWindow : null;
      let historyDone = true;
      let historyHasOlder = false;
      let historyProgressed = false;

      for (const [accountIndex, account] of accounts.entries()) {
        if (yearly && state.getCursor(historyDoneKey(account.email, yearly.year)) === '1') {
          historyHasOlder ||= state.getCursor(historyOlderKey(account.email, yearly.year)) === '1';
          continue;
        }
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
        const q = yearly
          ? `after:${Math.floor(yearly.fromTs / 1000) - 1} before:${Math.ceil(yearly.toTs / 1000)}`
          : `after:${Math.floor(floor / 1000)}`;
        const client = makeClient({ email: account.email, ...(home ? { home } : {}) });

        try {
          let seen = 0;
          let highest = Number.isFinite(stored) ? stored : 0;
          const rows = [];
          let pagesFetched = 0;

          if (yearly) {
            let pageToken = state.getCursor(historyPageKey(account.email, yearly.year)) ?? undefined;
            let yearDone = false;

            // Drain up to historyPagesPerPass pages this pass instead of one.
            // Pacing between gets is unchanged (same getsPerMinute limiter
            // below); this just lets the loop run longer per invocation
            // rather than the daemon invoking the source more often.
            for (let page = 0; page < historyPagesPerPass; page += 1) {
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
                const full = await client.getMessage(stub.id);
                const internal = Number(full?.internalDate);
                // The exact bound the query could only approximate.
                if (!Number.isFinite(internal) || internal < yearly.fromTs || internal >= yearly.toTs) continue;
                const parsed = gmailMessageToParsed(full);
                const row = messageToRow(parsed, {
                  account: account.email,
                  folder: 'INBOX',
                  uid: stub.id,
                  uidValidity: 'gmail',
                  maxBodyBytes,
                });
                if (row !== null) {
                  pageRows.push(row);
                  if (Number.isFinite(internal) && internal > highest) highest = internal;
                }
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
            let pageToken;
            page: do {
              await pace();
              const list = await client.listMessages({ q, pageToken, maxResults: PAGE_SIZE });
              pagesFetched += 1;
              pageToken = list.nextPageToken;
              for (const [stubIndex, stub] of (list.messages ?? []).entries()) {
                if (seen >= MAX_MESSAGES_PER_ACCOUNT) break page;
                if (stubIndex > 0) await sleepImpl(spacingMs);
                seen += 1;
                const full = await client.getMessage(stub.id);
                const internal = Number(full?.internalDate);
                if (Number.isFinite(internal) && internal <= floor && stored > 0) continue;
                const parsed = gmailMessageToParsed(full);
                const row = messageToRow(parsed, {
                  account: account.email,
                  folder: 'INBOX',
                  uid: stub.id,
                  uidValidity: 'gmail',
                  maxBodyBytes,
                });
                if (row !== null) {
                  rows.push(row);
                  if (Number.isFinite(internal) && internal > highest) highest = internal;
                }
              }
            } while (pageToken && seen < MAX_MESSAGES_PER_ACCOUNT);

            if (rows.length > 0) {
              const totals = await ingest(rows);
              inserted += totals?.inserted ?? 0;
              updated += totals?.updated ?? 0;
              unchanged += totals?.unchanged ?? 0;
              // ADVANCED ONLY FROM ROWS THAT LANDED. A cursor moved past
              // messages that were fetched but never ingested is the failure
              // the old UIDVALIDITY comment warned about, wearing different
              // clothes: nothing errors, and that window is never fetched
              // again.
              if (highest > 0) state.setCursor(cursorKey(account.email), String(highest));
            }
          }

          log.info('mail_account_scan', {
            connector: 'mail',
            account: account.email,
            fetched: seen,
            rows: rows.length,
            pages: pagesFetched,
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
