#!/usr/bin/env node
// THE ASK EVAL, run by the owner by hand on their own Mac:
//
//   node ui/scripts/eval-ask.mjs "a seed investor in health tech I've met"          # judge the first 60 candidates, print top 20
//   node ui/scripts/eval-ask.mjs "..." --limit 200 --labels ~/.hazlie/experiments/ask1.json
//
// With --labels (a JSON object {person_key: 1|0}, kept under ~/.hazlie/experiments,
// never in the repo) it reports precision at 10 and 20 and how often the
// evidence pick landed on a labelled-positive. Without labels it prints the
// ranked list so the owner can label it. This is the owner's desk: it prints
// names and the evidence line to the owner's own terminal and stores nothing
// in the database except the judgment cache rows the product would store
// anyway.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJev, USD_PER_MTOK } from '../server/relationship/jev.mjs';
import { ASK_SCHEMA, createAsk, askJudgmentOrder, runAskPass, askMatches, deleteAsk } from '../server/relationship/ask.mjs';

const args = process.argv.slice(2);
const text = args.find((a) => !a.startsWith('--'));
if (!text) { console.error('usage: eval-ask.mjs "<ask>" [--limit N] [--labels file.json] [--keep]'); process.exit(2); }
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const limit = Number(opt('--limit', '60'));
const labelsPath = opt('--labels', null);
const keep = args.includes('--keep');
const dbPath = process.env.HAZLIE_DB ?? join(homedir(), '.hazlie', 'context', 'context.db');
const db = new DatabaseSync(dbPath);
db.exec(ASK_SCHEMA);
const jev = createJev({});
if (jev.state !== 'ok') { console.error(`judgment engine is ${jev.state}`); process.exit(2); }

const ask = createAsk(db, text);
const keys = askJudgmentOrder(db, ask, { limit });
const t0 = Date.now();
const totals = await runAskPass(db, jev, ask, keys);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`ask #${ask.id} · candidates judged ${totals.asked} (cached ${totals.cached}, declined ${totals.declined}) · ${totals.inputTokens} tokens · $${((totals.inputTokens / 1e6) * USD_PER_MTOK).toFixed(4)} · ${secs}s`);
const matches = askMatches(db, ask, { limit: 20, all: true });
let labels = null;
if (labelsPath) { try { labels = JSON.parse(readFileSync(labelsPath, 'utf8')); } catch { labels = null; } }
for (const [i, m] of matches.entries()) {
  const tag = labels ? (labels[m.personKey] === 1 ? ' ✓' : labels[m.personKey] === 0 ? ' ✗' : ' ?') : '';
  console.log(`${String(i + 1).padStart(2)}. ${m.name}${tag}  fit ${m.fit?.toFixed(2) ?? '—'}  level ${m.fitLevel?.toFixed(1) ?? '—'}  ${m.title ?? ''}${m.company ? ` · ${m.company}` : ''}`);
  if (m.fitsBecause) console.log(`     because: ${m.fitsBecause}`);
}
if (labels) {
  const pos = (n) => matches.slice(0, n).filter((m) => labels[m.personKey] === 1).length;
  console.log(`\nprecision@10 ${(pos(10) / Math.min(10, matches.length)).toFixed(2)} · precision@20 ${(pos(20) / Math.min(20, matches.length)).toFixed(2)} · labelled ${Object.keys(labels).length}`);
}
if (!keep) deleteAsk(db, ask.id);
else console.log(`\nask #${ask.id} kept; GET /admin/relationship/ask/matches?id=${ask.id}`);
