#!/usr/bin/env node
// Report how much of the mail corpus was ingested without participants, and
// print the only sequence that can repair it.
//
//   node ui/scripts/repair-mail-participants.mjs
//
// IT DELETES NOTHING AND WRITES NOTHING. It opens context.db READ-ONLY and
// prints counts. Every destructive step below is a command the owner runs
// deliberately, because the repair is a purge and a re-download of the whole
// mailbox, not a migration.
//
// WHAT HAPPENED. From the 2026-08-26 move off IMAP until 2026-09-12,
// connectors/sources/mail.mjs handed connectors/lib/mailRows.mjs the RAW
// header strings Gmail's REST API returns, while normalizeAddresses over
// there accepted only an array or mailparser's `{value:[{address}]}`. A
// string fell through to the empty list, silently. So every mail row the
// backfill wrote carries meta.from = [], meta.to = [], meta.cc = [] and a
// null speaker, no person_event_links row was ever created for a mail
// message, and the reconnection card has never once surfaced a Gmail
// contact. The parser landed in mailRows.mjs as parseAddressHeader; this
// script is about the rows written before it existed.
//
// WHY THERE IS NO IN-PLACE FIX. The addresses are not anywhere in the
// database to re-parse. meta holds the empty lists the bug produced, and
// `text` is `"<subject>"\n\n<body>` — the From/To/Cc headers were dropped in
// the adapter and never stored. Nothing local can reconstruct them. The only
// source of truth is Gmail, so the repair is: purge the source, re-backfill
// through the fixed adapter.
//
// THE ONE THING THAT CAN BE LOST. /admin/purge deletes every claim resting on
// any mail row (hermes' deleteClaimsForContextWhere), and deleting a claim
// deletes its claim_decision rows with it — the owner's own judgements, the
// one thing in this system that cannot be regenerated. A claim supported by
// BOTH a mail row and, say, an iMessage row goes too. This script counts all
// three before anyone types the purge, and says so loudly when the count is
// not zero.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH = process.env.HERMES_DB ?? join(homedir(), '.hazlie', 'context', 'context.db');
// <repo>/ui/scripts/this-file -> <repo>, so the printed commands are runnable
// wherever the checkout lives and whatever the caller's cwd is.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const MAIL_CLAIM_IDS = `
  SELECT cs.claim_id FROM claim_source cs
  JOIN context c ON c.id = cs.context_id
  WHERE c.source = 'mail'`;

let db;
try {
  db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch (error) {
  process.stderr.write(`cannot open ${DB_PATH} read-only: ${error.message}\n`);
  process.exit(2);
}

const n = (sql) => Number(db.prepare(sql).get().n);

// json_array_length is NULL for a missing key and for a non-array, so the
// COALESCE makes "no from at all" and "an empty from" the same answer — which
// is what the defect produced and what a repaired row must not have.
const EMPTY_FROM = `
  SELECT COUNT(*) n FROM context
  WHERE source = 'mail'
    AND COALESCE(json_array_length(json_extract(meta, '$.from')), 0) = 0`;

const report = {
  db: DB_PATH,
  mail_rows: n("SELECT COUNT(*) n FROM context WHERE source = 'mail'"),
  mail_rows_without_from: n(EMPTY_FROM),
  mail_rows_with_participants: n(`
    SELECT COUNT(*) n FROM context
    WHERE source = 'mail'
      AND COALESCE(json_array_length(json_extract(meta, '$.from')), 0) > 0`),
  mail_rows_with_speaker: n("SELECT COUNT(*) n FROM context WHERE source = 'mail' AND speaker IS NOT NULL"),
  people_links_on_mail: n("SELECT COUNT(*) n FROM person_event_links WHERE source = 'mail'"),
  claims_resting_on_mail: n(`SELECT COUNT(DISTINCT cs.claim_id) n FROM claim_source cs
    JOIN context c ON c.id = cs.context_id WHERE c.source = 'mail'`),
  owner_decisions_at_risk: n(`SELECT COUNT(*) n FROM claim_decision
    WHERE claim_id IN (${MAIL_CLAIM_IDS})`),
  claims_also_resting_elsewhere: n(`SELECT COUNT(DISTINCT cs.claim_id) n FROM claim_source cs
    JOIN context c ON c.id = cs.context_id
    WHERE c.source != 'mail' AND cs.claim_id IN (${MAIL_CLAIM_IDS})`),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n\n`);

if (report.mail_rows_without_from === 0) {
  process.stdout.write(
    report.mail_rows === 0
      ? 'No mail rows at all: nothing to repair, and nothing to purge.\n'
      : 'Every mail row carries at least one From address. Nothing to repair.\n'
  );
  process.exit(0);
}

if (report.owner_decisions_at_risk > 0) {
  process.stdout.write(
    `STOP AND READ FIRST: ${report.owner_decisions_at_risk} claim_decision row(s) rest on ` +
      `${report.claims_resting_on_mail} mail-sourced claim(s), ` +
      `${report.claims_also_resting_elsewhere} of which are also supported by a non-mail row. ` +
      'The purge below deletes those claims AND those decisions. They are human judgements ' +
      'and nothing can regenerate them. Export or re-decide them before purging.\n\n'
  );
}

process.stdout.write(`Repair sequence (each line is run by hand, in this order):

  # 1. Back this up first. This script will not do it for you: a script that
  #    quietly writes a second copy of the household corpus somewhere is a
  #    worse habit than one that tells you to.
  cp ${DB_PATH} ~/context.backup-before-mail-repair.db

  # 2. Stop the connectors daemon so a mail pass cannot race the purge and
  #    re-ingest under the cursor you are about to wipe.
  launchctl bootout gui/$UID/io.intaglio.connectors

  # 3. Purge the hermes 'mail' source and wipe the connector's local cursors
  #    in one step (run.mjs --purge does hermes first, local second, so a
  #    failed request leaves nothing forgotten). Deletes ${report.mail_rows} context
  #    row(s), ${report.claims_resting_on_mail} claim(s), and runs the FTS rebuild + VACUUM inline.
  cd ${REPO}/connectors && node run.mjs mail --purge

  # 4. Re-read the mailbox through the fixed adapter. The first pass takes the
  #    backfill window; the daemon's history walk drains the rest year by year
  #    once it is running again.
  node run.mjs mail --backfill

  # 5. Bring the daemon back and let it walk history.
  launchctl kickstart gui/$UID/io.intaglio.connectors

  # 6. Confirm. mail_rows_without_from must be 0 and people_links_on_mail
  #    must be greater than 0 once the projection has rebuilt.
  node ${REPO}/ui/scripts/repair-mail-participants.mjs
`);
