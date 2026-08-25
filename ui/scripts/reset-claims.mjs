#!/usr/bin/env node
// Clear every proposed claim and distillation run, so the corpus can be
// re-distilled from scratch.
//
//   node ui/scripts/reset-claims.mjs              # says what it WOULD delete
//   node ui/scripts/reset-claims.mjs --yes        # actually deletes
//
// WHAT IT DOES NOT TOUCH: `context`. The corpus itself is never rewritten by
// this, and neither is the episode index (which is derived from context and
// rebuilt by build-episodes.mjs). Only the model's proposals and the record of
// the passes that produced them.
//
// WHY THIS EXISTS. Claims are cheap and reproducible -- they are one local model
// pass away from being regenerated -- but they are only reproducible from the
// PROMPT AND PATH THAT MADE THEM. When either changes materially, the existing
// claims are the output of software that no longer exists, and re-running over
// a corpus whose old claims are still present just piles near-duplicates into
// the review queue. This is the clean-slate path for that case.
//
// IT REFUSES TO RUN OVER HUMAN WORK. If any claim_decision exists, the owner
// has spent attention on this queue, and deleting the claims underneath those
// decisions destroys the one thing in this system that cannot be regenerated --
// human judgement. That is the whole reason the check is here and not a flag.
//
// BACK UP FIRST. This does not do it for you, on purpose: a script that quietly
// writes a copy of the household corpus somewhere is a worse habit than a
// script that tells you to.
//
//   cp ~/.hazlie/context/context.db ~/somewhere-safe/context.backup.db

import { openDb, defaultDbPath } from '../server/hermes.mjs';

const yes = process.argv.includes('--yes');

let db;
try {
  db = openDb(defaultDbPath());
  const n = (sql) => Number(db.prepare(sql).get().n);

  const before = {
    claims: n('SELECT COUNT(*) n FROM claim'),
    claim_source: n('SELECT COUNT(*) n FROM claim_source'),
    distill_run: n('SELECT COUNT(*) n FROM distill_run'),
    decisions: n('SELECT COUNT(*) n FROM claim_decision'),
    context_rows: n('SELECT COUNT(*) n FROM context'),
    episodes: n('SELECT COUNT(*) n FROM episode'),
  };

  if (before.decisions > 0) {
    process.stderr.write(
      `refusing: ${before.decisions} claim_decision rows exist.\n` +
        'Those are the owner\'s judgements and nothing here can regenerate them.\n' +
        'Deleting the claims underneath them would destroy that work.\n'
    );
    process.exit(2);
  }

  if (!yes) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dry_run: true,
          would_delete: {
            claims: before.claims,
            claim_source: before.claim_source,
            distill_run: before.distill_run,
          },
          untouched: { context_rows: before.context_rows, episodes: before.episodes },
          note: 're-run with --yes to delete. back up context.db first.',
        },
        null,
        2
      )}\n`
    );
    process.exit(0);
  }

  db.exec('BEGIN');
  try {
    // Children first. Both cascade from their parents, but doing it explicitly
    // states the intent rather than relying on trigger order -- and claim_fts
    // is trigger-maintained off claim, so the order it sees matters.
    db.exec('DELETE FROM claim_source');
    db.exec('DELETE FROM claim');
    db.exec('DELETE FROM distill_run');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        deleted: {
          claims: before.claims,
          claim_source: before.claim_source,
          distill_run: before.distill_run,
        },
        now: {
          claims: n('SELECT COUNT(*) n FROM claim'),
          claim_source: n('SELECT COUNT(*) n FROM claim_source'),
          distill_run: n('SELECT COUNT(*) n FROM distill_run'),
          context_rows: n('SELECT COUNT(*) n FROM context'),
          episodes: n('SELECT COUNT(*) n FROM episode'),
        },
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  process.stderr.write(`reset-claims failed: ${error?.message ?? error}\n`);
  process.exit(1);
} finally {
  try {
    db?.close();
  } catch {}
}
