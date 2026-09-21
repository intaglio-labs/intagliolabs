#!/usr/bin/env node
// THE JUDGMENT EVAL: replay the owner's judged cards through the live judgment
// call and report separation and calibration. Numbers only -- no name, no
// quote, no line ever reaches stdout or a file. Run by hand:
//
//   node ui/scripts/eval-jev.mjs                 # every judged card, live
//   node ui/scripts/eval-jev.mjs --dry-run       # token and dollar estimate, no call
//   node ui/scripts/eval-jev.mjs --drop=professional,last_exchange   # ablation
//
// WHY THIS EXISTS. Every change to a question's wording or option order is a
// new sha and a cache miss (jev.mjs); this is how the change is measured
// before it ships, against the growing set of the owner's own verdicts. The
// number is a tripwire, not a score to optimise: at n=54 (2026-09-20) a
// difference under about 0.07 in AUC was noise. Record the run in the commit
// that changes a question.
//
// Baselines, 2026-09-20, 54 cards (27 accepted / 27 dismissed or muted):
//   worth AUC 0.72 (raw twelve lines: 0.58); calibration by bucket
//   [0,.2) 0% · [.2,.4) 33% · [.4,.6) 45% · [.6,.8) 73%; closeness AUC 0.68.
//   Dropping the words: 0.66 and kind flips friend->business for 40 of 54.
//   Dropping the professional block: 0.68. Everything else within noise.
//
// READ-ONLY. Opens the database read-only, writes nothing to it, records no
// judgment and no usage: an eval is not the product's cache.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJev, estimateTokens, USD_PER_MTOK } from '../server/relationship/jev.mjs';
import { buildJudgmentCall, deriveKind } from '../server/relationship/judgments.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const DROP = (args.find((a) => a.startsWith('--drop=')) ?? '').slice(7).split(',').filter(Boolean);
const dbPath = process.env.HAZLIE_DB ?? join(homedir(), '.hazlie', 'context', 'context.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
const jev = createJev({});
if (!DRY && jev.state !== 'ok') {
  console.error(`judgment engine is ${jev.state}; nothing to run`);
  process.exit(2);
}

const events = db.prepare(`
  SELECT e.event, e.person_key AS personKey FROM rm_card_event e
  JOIN rm_candidate_snapshot s ON s.id = e.snapshot_id
  WHERE e.event IN ('accepted','dismissed','muted') ORDER BY e.created_at`).all();

const rows = [];
let tokens = 0; let calls = 0; let declined = 0;
const t0 = Date.now();
for (const ev of events) {
  const call = buildJudgmentCall(db, ev.personKey, { now: Date.now() });
  if (!call) { declined += 1; continue; }
  for (const d of DROP) delete call.state[d];
  if (DRY) { tokens += estimateTokens({ state: call.state, questions: call.questions }); calls += 1; continue; }
  const out = await jev.ask({ state: call.state, questions: call.questions });
  if (!out) { declined += 1; continue; }
  calls += 1; tokens += out.usage.input_tokens;
  const a = out.answers;
  const role = db.prepare('SELECT role FROM people WHERE person_key = ?').get(ev.personKey)?.role ?? null;
  rows.push({
    event: ev.event, role,
    worth: a.worth?.noul ?? null,
    closeness: a.closeness?.score ?? null,
    axis: a.professional_axis?.score ?? null,
    kind: deriveKind({ relatives: a.relatives?.noul ?? null, romantic: a.romantic?.noul ?? null, professionalAxis: a.professional_axis?.score ?? null }),
    ended: a.ended?.choice ?? null,
    endedConf: a.ended?.confidence ?? null,
    bestQuote: Math.max(-1, ...Object.entries(a).filter(([k]) => k.startsWith('quote_')).map(([, v]) => v.score ?? -1)),
  });
}

const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const acc = rows.filter((r) => r.event === 'accepted');
const rej = rows.filter((r) => r.event !== 'accepted');
const auc = (g) => {
  let w = 0; let n = 0;
  for (const a of acc) for (const b of rej) { const x = g(a); const y = g(b); if (x === null || y === null) continue; n += 1; w += x > y ? 1 : x === y ? 0.5 : 0; }
  return n ? w / n : NaN;
};
const out = [];
out.push(`# judgment eval ${new Date().toISOString().slice(0, 10)}${DRY ? ' (dry run)' : ''}${DROP.length ? ` drop=${DROP.join(',')}` : ''}`);
out.push(`cards ${events.length} · calls ${calls} · declined ${declined} · input tokens ${tokens} · $${((tokens / 1e6) * USD_PER_MTOK).toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!DRY) {
  out.push(`accepted ${acc.length} · rejected ${rej.length}`);
  out.push(`worth: acc mean ${f(mean(acc.map((r) => r.worth).filter((x) => x !== null)))} · rej mean ${f(mean(rej.map((r) => r.worth).filter((x) => x !== null)))} · AUC ${f(auc((r) => r.worth))}`);
  for (let b = 0; b < 5; b += 1) {
    const lo = b / 5; const hi = (b + 1) / 5;
    const inb = rows.filter((r) => r.worth !== null && r.worth >= lo && (b === 4 ? r.worth <= hi : r.worth < hi));
    out.push(`  [${lo.toFixed(1)},${hi.toFixed(1)}${b === 4 ? ']' : ')'} n=${inb.length} accept=${inb.length ? (inb.filter((r) => r.event === 'accepted').length / inb.length).toFixed(2) : '—'}`);
  }
  out.push(`closeness AUC ${f(auc((r) => r.closeness))} · best-quote score AUC ${f(auc((r) => r.bestQuote))} · axis AUC ${f(auc((r) => r.axis))}`);
  const kinds = ['business', 'friend', 'family', 'romantic'];
  out.push('kind (derived) × static role: ' + kinds.map((k) => `${k}=${rows.filter((r) => r.kind === k).length}(static-business ${rows.filter((r) => r.kind === k && r.role === 'business').length})`).join(' · '));
  out.push('kind × outcome: ' + kinds.map((k) => `${k} acc=${acc.filter((r) => r.kind === k).length}/rej=${rej.filter((r) => r.kind === k).length}`).join(' · '));
  out.push('ended: ' + ['warm', 'neutral', 'bad'].map((o) => `${o} acc=${acc.filter((r) => r.ended === o).length}/rej=${rej.filter((r) => r.ended === o).length}`).join(' · ') + ` · confidence ≥0.6: ${rows.filter((r) => (r.endedConf ?? 0) >= 0.6).length}/${rows.length}`);
}
console.log(out.join('\n'));
