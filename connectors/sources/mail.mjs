// The mail connector: IMAP → hermes.
//
// Egress path 1 in ui/AGENTS.md — IMAP/TLS to the owner's own provider,
// fetching their own mailbox down to this Mac. Content moves provider → Mac;
// nothing is sent anywhere.
//
// TWO THINGS SHAPE THIS FILE.
//
// 1. UIDs are per-folder and only meaningful under a UIDVALIDITY. The spec in
//    ops/CONNECTORS.md is a per-folder UID cursor guarded by UIDVALIDITY: when
//    the server changes UIDVALIDITY, every UID in that folder is meaningless
//    and the cursor must be discarded, not advanced. Ignoring this is how a
//    connector silently stops fetching — the stored cursor stays higher than
//    every renumbered UID, so the search returns nothing, forever, with no
//    error to notice.
//
// 2. Several mailboxes, each with its own app password. Gmail issues app
//    passwords per account, so there is no single credential covering both;
//    an account that fails must not abort the others.
//
// LOG POLICY (connectors/AGENTS.md): counts and folder names only. No
// subjects, no bodies, no addresses — those are corpus, and a log is not.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readSecretLine } from '../lib/secrets.mjs';
import { DEFAULT_MAX_BODY_BYTES, messageToRow } from '../lib/mailRows.mjs';

const DEFAULT_HOST = 'imap.gmail.com';
const DEFAULT_PORT = 993;
const DEFAULT_FOLDERS = ['INBOX'];
const DEFAULT_BACKFILL_DAYS = 30;
// One folder's scan is bounded so a first run against a decade-old mailbox
// cannot become an unbounded fetch loop.
const MAX_MESSAGES_PER_FOLDER = 2000;

export function mailSecretName(address) {
  return `gmail-app-password-${String(address).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}.txt`;
}

export function mailSecretPath(address, home = homedir()) {
  return join(home, '.hazlie', 'secrets', mailSecretName(address));
}

// Accounts inherit the top-level mail defaults; per-account keys win. The
// single-account spelling (mail.user with no accounts[]) still works.
export function resolveAccounts(config) {
  const mail = config?.mail;
  if (!mail) return [];
  const defaults = {
    host: mail.host ?? DEFAULT_HOST,
    port: mail.port ?? DEFAULT_PORT,
    folders: mail.folders ?? DEFAULT_FOLDERS,
    backfillDays: mail.backfillDays ?? DEFAULT_BACKFILL_DAYS,
    maxBodyBytes: mail.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };
  const list = Array.isArray(mail.accounts)
    ? mail.accounts
    : typeof mail.user === 'string' && mail.user
      ? [{ user: mail.user }]
      : [];
  return list
    .filter((a) => typeof a?.user === 'string' && a.user.length > 0)
    .map((a) => ({ ...defaults, ...a }));
}

const uidCursorKey = (account, folder) => `mail:uid:${account}:${folder}`;
const validityCursorKey = (account, folder) => `mail:uidvalidity:${account}:${folder}`;

// Exported for the test: the cursor decision is the part that breaks silently,
// so it is a pure function rather than something buried in the fetch loop.
export function planFolderScan({ storedValidity, serverValidity, storedUid, backfill }) {
  if (backfill) return { fromUid: 1, resetReason: 'backfill' };
  if (storedValidity !== null && String(storedValidity) !== String(serverValidity)) {
    // Every UID under the old validity is meaningless now. Advancing the
    // cursor here is the silent-stall bug; re-scanning is the correct cost.
    return { fromUid: 1, resetReason: 'uidvalidity-changed' };
  }
  const uid = Number(storedUid);
  if (!Number.isFinite(uid) || uid < 1) return { fromUid: 1, resetReason: 'no-cursor' };
  return { fromUid: uid + 1, resetReason: null };
}

async function scanFolder({ client, account, folder, state, backfill, log, since }) {
  const lock = await client.getMailboxLock(folder);
  const rows = [];
  let highestUid = 0;
  try {
    const serverValidity = String(client.mailbox.uidValidity);
    const plan = planFolderScan({
      storedValidity: state.getCursor(validityCursorKey(account.user, folder)) ?? null,
      serverValidity,
      storedUid: state.getCursor(uidCursorKey(account.user, folder)),
      backfill,
    });
    if (plan.resetReason === 'uidvalidity-changed') {
      log.warn('mail_uidvalidity_reset', { connector: 'mail', folder });
    }

    // Bound the first scan by date as well as UID: `fromUid: 1` on a mailbox
    // with 100k messages would otherwise try to fetch all of them.
    const range = `${plan.fromUid}:*`;
    const query = plan.fromUid === 1 ? { uid: range, since } : { uid: range };

    let seen = 0;
    for await (const message of client.fetch(query, { uid: true, source: true }, { uid: true })) {
      // `uid: "N:*"` always returns at least the last message even when
      // nothing is newer than N — the server clamps the range. Skipping
      // anything at or below the cursor is what keeps a no-op scan a no-op.
      if (message.uid < plan.fromUid) continue;
      if (seen >= MAX_MESSAGES_PER_FOLDER) {
        log.warn('mail_folder_cap_reached', {
          connector: 'mail',
          folder,
          cap: MAX_MESSAGES_PER_FOLDER,
        });
        break;
      }
      seen += 1;
      highestUid = Math.max(highestUid, message.uid);
      const parsed = await simpleParser(message.source);
      const row = messageToRow(parsed, {
        account: account.user,
        folder,
        uid: message.uid,
        uidValidity: serverValidity,
        maxBodyBytes: account.maxBodyBytes,
      });
      if (row !== null) rows.push(row);
    }
    return { rows, highestUid, serverValidity, skipped: seen - rows.length };
  } finally {
    lock.release();
  }
}

export function createMailSource() {
  return {
    name: 'mail',

    // Blocks only when NO mailbox is usable. One provisioned account is enough
    // to run: this mirrors what run() already does with an account that fails
    // mid-flight, and a missing password is the same situation as a refused
    // login. Gating everything on the least-ready mailbox would mean adding a
    // second account silently switches the connector off.
    // `home` is a test seam; the daemon and run.mjs never pass it.
    needs({ config, home } = {}) {
      const accounts = resolveAccounts(config);
      if (accounts.length === 0) {
        return ['no mail accounts configured: add mail.accounts[] to ~/.hazlie/connectors/config.json'];
      }
      const pathFor = (a) => (home ? mailSecretPath(a.user, home) : mailSecretPath(a.user));
      if (accounts.some((a) => existsSync(pathFor(a)))) return [];
      return accounts.map(
        (a) =>
          `app password for ${a.user} missing at ${pathFor(a)}: open the connect page, or see ops/CONNECTORS.md`
      );
    },

    async run(ctx) {
      const { state, ingest, config, log, now, backfill } = ctx;
      const accounts = resolveAccounts(config);
      const since = new Date(now() - (accounts[0]?.backfillDays ?? DEFAULT_BACKFILL_DAYS) * 86_400_000);

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let skippedAccounts = 0;
      const failures = [];

      for (const account of accounts) {
        // Skipped, not failed: needs() let the run start because at least one
        // mailbox is provisioned, and an unprovisioned one is a state the
        // owner is mid-way through fixing, not an error.
        if (!existsSync(mailSecretPath(account.user))) {
          log.warn('mail_account_unprovisioned', { connector: 'mail', account: account.user });
          skippedAccounts += 1;
          continue;
        }
        const client = new ImapFlow({
          host: account.host,
          port: account.port,
          secure: true,
          auth: { user: account.user, pass: readSecretLine(mailSecretPath(account.user), {
            label: `app password for ${account.user}`,
          }) },
          // imapflow logs at info by default and its payloads can carry
          // envelope data. Corpus content does not go to logs.
          logger: false,
        });

        try {
          await client.connect();
          for (const folder of account.folders) {
            const { rows, highestUid, serverValidity } = await scanFolder({
              client,
              account,
              folder,
              state,
              backfill,
              log,
              since,
            });
            if (rows.length > 0) {
              const totals = await ingest(rows);
              inserted += totals.inserted ?? totals.ingested ?? 0;
              updated += totals.updated ?? 0;
              unchanged += totals.unchanged ?? 0;
            }
            // Cursors advance ONLY after the batch is safely in hermes. A
            // cursor written first would skip everything an ingest failure
            // dropped, permanently and invisibly.
            if (highestUid > 0) {
              state.setCursor(uidCursorKey(account.user, folder), String(highestUid));
            }
            state.setCursor(validityCursorKey(account.user, folder), serverValidity);
            log.info('mail_folder_scan', {
              connector: 'mail',
              folder,
              rows: rows.length,
              highestUid,
            });
          }
        } catch (error) {
          // One mailbox failing must not cost the others theirs — separate
          // credentials, separate connections, separate fates.
          failures.push({ account: account.user, message: error?.message ?? String(error) });
          log.warn('mail_account_failed', { connector: 'mail', account: account.user });
        } finally {
          try {
            await client.logout();
          } catch {
            // already closed, or the socket died with the error above
          }
        }
      }

      if (failures.length > 0 && failures.length + skippedAccounts === accounts.length) {
        throw new Error(
          `all ${accounts.length} mail account(s) failed: ` +
            failures.map((f) => `${f.account}: ${f.message}`).join('; ')
        );
      }
      return { inserted, updated, unchanged, failures: failures.length, skippedAccounts };
    },
  };
}

export default createMailSource();
