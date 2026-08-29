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
// Historical scans are bounded by ONE API page per pass instead; their durable
// page token eventually drains the whole year without imposing a data cap.
const MAX_MESSAGES_PER_ACCOUNT = 2000;
const PAGE_SIZE = 100;

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
  };
}

export function createMailSource({
  accountsForScope = accountsWithScope,
  makeClient = createGmailClient,
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
        const { backfillDays, maxBodyBytes } = accountSettings(config, account.email);
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
          let pageToken = yearly
            ? (state.getCursor(historyPageKey(account.email, yearly.year)) ?? undefined)
            : undefined;
          let seen = 0;
          let highest = Number.isFinite(stored) ? stored : 0;
          const rows = [];

          page: do {
            const list = await client.listMessages({ q, pageToken, maxResults: PAGE_SIZE });
            if (yearly) historyProgressed = true;
            pageToken = list.nextPageToken;
            for (const stub of list.messages ?? []) {
              if (!yearly && seen >= MAX_MESSAGES_PER_ACCOUNT) break page;
              seen += 1;
              const full = await client.getMessage(stub.id);
              const internal = Number(full?.internalDate);
              // The exact bound the query could only approximate.
              if (yearly) {
                if (!Number.isFinite(internal) || internal < yearly.fromTs || internal >= yearly.toTs) continue;
              } else if (Number.isFinite(internal) && internal <= floor && stored > 0) continue;
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
            // One historical page per source invocation. The daemon's time
            // budget can immediately invoke the source again, while the saved
            // token makes every completed page crash-safe and removes the old
            // 2,000-message-per-year ceiling.
            if (yearly) break page;
          } while (pageToken && seen < MAX_MESSAGES_PER_ACCOUNT);

          if (rows.length > 0) {
            const totals = await ingest(rows);
            inserted += totals?.inserted ?? 0;
            updated += totals?.updated ?? 0;
            unchanged += totals?.unchanged ?? 0;
            // ADVANCED ONLY FROM ROWS THAT LANDED. A cursor moved past
            // messages that were fetched but never ingested is the failure the
            // old UIDVALIDITY comment warned about, wearing different clothes:
            // nothing errors, and that window is never fetched again.
            if (!yearly && highest > 0) state.setCursor(cursorKey(account.email), String(highest));
          }
          if (yearly) {
            if (pageToken) {
              state.setCursor(historyPageKey(account.email, yearly.year), pageToken);
              historyDone = false;
            } else {
              state.deleteCursor(historyPageKey(account.email, yearly.year));
              const older = await client.listMessages({
                q: `before:${Math.floor(yearly.fromTs / 1000)}`,
                maxResults: 1,
              });
              const hasOlder = (older.messages?.length ?? 0) > 0;
              state.setCursor(historyDoneKey(account.email, yearly.year), '1');
              state.setCursor(historyOlderKey(account.email, yearly.year), hasOlder ? '1' : '0');
              historyHasOlder ||= hasOlder;
            }
          }
          log.info('mail_account_scan', {
            connector: 'mail',
            account: account.email,
            fetched: seen,
            rows: rows.length,
            ...(yearly ? { historyYear: yearly.year } : {}),
          });
        } catch (error) {
          // One mailbox failing must not cost the others theirs — separate
          // grants, separate tokens, separate fates.
          failures.push(accountIndex);
          log.warn('mail_account_failed', { connector: 'mail', accountIndex });
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
