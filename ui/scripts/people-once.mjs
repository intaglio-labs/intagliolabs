// Dump the people graph once, read-only, for eyeballing and for the mentor
// experiment's Arm A to build on. Counts, names, channels and dormancy — the
// owner's own graph, printed locally, never sent anywhere.
//
//   node ui/scripts/people-once.mjs                 top 40 by relationship depth
//   node ui/scripts/people-once.mjs --dormant       longest-dormant real bonds
//   node ui/scripts/people-once.mjs --json          the whole graph as JSON
//   node ui/scripts/people-once.mjs --limit 100

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildGraph } from '../server/people/graph.mjs';
import { loadOwner } from '../server/people/owner.mjs';

const CONTEXT = process.env.HERMES_DB ?? join(homedir(), '.hazlie', 'context', 'context.db');
const STATE = join(homedir(), '.hazlie', 'connectors', 'state.db');

function fail(m) {
  console.error(m);
  process.exit(1);
}
if (!existsSync(CONTEXT)) fail(`no context store at ${CONTEXT}`);

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const dormant = argv.includes('--dormant');
const li = argv.indexOf('--limit');
const limit = li === -1 ? 40 : Math.max(1, Number(argv[li + 1]) || 40);

const context = new DatabaseSync(`file:${CONTEXT}?mode=ro`, { readOnly: true });
const state = existsSync(STATE) ? new DatabaseSync(`file:${STATE}?mode=ro`, { readOnly: true }) : null;
const graph = buildGraph(context, state, { now: Date.now(), owner: loadOwner() });
context.close();
state?.close();

if (json) {
  process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
  process.exit(0);
}

// A relationship-depth heuristic for the default view: breadth of channels,
// message volume (log-damped so a chatty friend does not bury everyone), real
// two-way-ness, and having met in person. This is a VIEW, not the mentor
// score — that lives in the experiment with its need-card.
const depth = (p) =>
  p.channelCount * 2 +
  Math.log10(p.messages + 1) * 3 +
  p.reciprocity * 4 +
  Math.min(p.metInPerson, 10) +
  (p.linkedin ? 1 : 0);

const ranked = [...graph];
if (dormant) {
  // Long-dormant but real: a genuine bond (depth) the owner has not heard
  // from in a while. The reconnection shortlist.
  ranked.sort(
    (a, b) => (b.dormancyDays ?? -1) * (depth(b) > 6 ? 1 : 0) - (a.dormancyDays ?? -1) * (depth(a) > 6 ? 1 : 0)
  );
} else {
  ranked.sort((a, b) => depth(b) - depth(a));
}

const fmtDorm = (d) => (d === null ? '—' : d > 365 ? `${(d / 365).toFixed(1)}y` : `${d}d`);
process.stdout.write(
  `people graph: ${graph.length} resolved persons${dormant ? ' (dormant real bonds first)' : ' (by relationship depth)'}\n\n`
);
for (const p of ranked.slice(0, limit)) {
  const bits = [
    p.channels.join('+'),
    `${p.messages} msgs`,
    p.metInPerson ? `met ${p.metInPerson}×` : null,
    `recip ${p.reciprocity}`,
    `quiet ${fmtDorm(p.dormancyDays)}`,
    p.linkedin?.position ? `[${p.linkedin.position}${p.linkedin.company ? ' @ ' + p.linkedin.company : ''}]` : null,
  ].filter(Boolean);
  process.stdout.write(`${p.name.padEnd(28).slice(0, 28)}  ${bits.join(' · ')}\n`);
}
