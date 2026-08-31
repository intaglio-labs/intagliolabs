// Reject claims that are the distill prompt's own worked examples.
//
// WHAT HAPPENED. prompts/distill_claims.md illustrates a well-formed claim with
// concrete sentences -- a penicillin allergy, a Denver flight, a Thursday physio
// appointment. The model copied all three into the corpus as facts about the
// owner, and attached a claim_source receipt to a real message that never
// mentions the subject. Measured 2026-08-31:
//
//     penicillin  2 claims   2 with a receipt that never mentions it
//     Denver      3 claims   3
//     physio      3 claims   3
//
// "The owner is allergic to penicillin." is stored twice at p_claim 0.95, subject
// 'owner', kind 'fact', each citing an iMessage containing neither "penicillin"
// nor "allerg". A false medical fact with provenance that looks verified.
//
// AND IT IS LIVE. The prompt file already carries a paragraph explaining that "a
// placeholder in an example is an instruction" -- written after a placeholder NAME
// leaked the same way -- so the mechanism was known. The fix addressed the name
// and not the content. Meanwhile memory/retrieve.mjs serves any claim with NO
// decision recorded against it, so these eight have been answerable this whole
// time; v_claim_accepted being empty hides nothing.
//
// WHY REJECT AND NOT DELETE. claim is append-only by trigger and that is the
// right design: a corpus you can quietly edit is a corpus with no history. A
// reject decision removes a claim from both read paths -- retrieve.mjs requires
// NOT EXISTS(decision), v_claim_accepted requires the latest to be 'accept' --
// while leaving the row and its receipt readable for exactly this kind of
// forensics. Changing your mind means appending another decision.
//
// Idempotent, and safe to run on every upgrade. Usage:
//   node ops/quarantine-prompt-echo.mjs [--dry-run]

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT = join(HERE, '..', 'prompts', 'distill_claims.md');
const DB = join(homedir(), '.hazlie', 'context', 'context.db');
const dryRun = process.argv.includes('--dry-run');

// READ THE PHRASES OUT OF THE PROMPT, do not hardcode them. A hardcoded list
// goes stale the first time somebody edits an example, and then this script
// reports "nothing to quarantine" about a corpus that has just been freshly
// contaminated by a different sentence. Every double-quoted sentence in the
// prompt that asserts something about the owner is a candidate.
export function exampleClaims(promptText) {
  const quoted = promptText.match(/"The owner [^"]{10,120}"/gu) ?? [];
  return [...new Set(quoted.map((q) => q.slice(1, -1).replace(/\.$/u, '')))];
}

/**
 * The content words that make an example identifiable. Matching whole sentences
 * is too brittle -- the model paraphrases -- and matching common words is too
 * broad. What survives is the specific nouns: penicillin, Denver, physio.
 */
export function distinctiveTerms(sentence) {
  // WEEKDAYS AND MONTHS ARE NOT DISTINCTIVE, and leaving them in made this tool
  // dangerous. The first dry run flagged 42 claims, 33 of them on the word
  // "thursday" alone -- overwhelmingly REAL plans about a real Thursday whose
  // cited message happened to write the day differently ("thurs", or a date).
  // Rejecting those would have deleted true claims to clean up eight false ones.
  // A term only counts as distinctive if it could not plausibly appear in an
  // ordinary message about an ordinary week.
  const STOP = new Set([
    'the', 'owner', 'is', 'are', 'was', 'a', 'an', 'to', 'on', 'in', 'at', 'of',
    'and', 'or', 'they', 'them', 'their', 'cannot', 'can', 'do', 'does', 'have',
    'has', 'weekly', 'tomorrow', 'flies', 'allergic', 'mornings', 'appointment',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
  ]);
  // A bare date is not distinctive either: 2026-03-05 in a claim about a real
  // flight on that date is a correct claim, not an echo.
  const isDate = (w) => /^\d{4}-\d{2}-\d{2}$|^\d+$/u.test(w);
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => w.length >= 5 && !STOP.has(w) && !isDate(w));
}

/**
 * A claim echoes an example when it contains one of the example's distinctive
 * terms AND no context row it cites contains that term. Both halves matter: the
 * first alone would reject a genuine claim about a real Denver trip, and the
 * second is what proves the receipt does not support the sentence.
 */
export function findEchoes(db, examples) {
  const cited = db.prepare(
    'SELECT x.text FROM claim_source cs JOIN context x ON x.id = cs.context_id WHERE cs.claim_id = ?'
  );
  const claims = db.prepare('SELECT id, text, kind, p_claim FROM claim').all();
  const out = [];
  for (const claim of claims) {
    const haystack = String(claim.text ?? '').toLowerCase();
    for (const example of examples) {
      const terms = distinctiveTerms(example);
      if (terms.length === 0) continue;
      const hit = terms.find((t) => haystack.includes(t));
      if (!hit) continue;
      const receipts = cited.all(claim.id).map((r) => String(r.text ?? '').toLowerCase());
      // Supported by its own evidence: leave it entirely alone. A real trip to
      // the same city is a real claim.
      if (receipts.some((r) => r.includes(hit))) continue;
      out.push({ ...claim, term: hit, example });
      break;
    }
  }
  return out;
}

function main() {
  const prompt = readFileSync(PROMPT, 'utf8');
  const examples = exampleClaims(prompt);
  if (examples.length === 0) {
    console.log('no example claims found in the prompt — nothing to match against');
    return 0;
  }
  console.log(`${examples.length} example sentence(s) in ${PROMPT.replace(homedir(), '~')}`);
  for (const e of examples) console.log(`  · ${distinctiveTerms(e).join(', ') || '(no distinctive term)'}`);

  const db = new DatabaseSync(DB, { readOnly: dryRun });
  try {
    const echoes = findEchoes(db, examples);
    const already = db.prepare(
      "SELECT claim_id FROM claim_decision WHERE action = 'reject' AND reason LIKE 'prompt-echo%'"
    ).all().map((r) => r.claim_id);
    const seen = new Set(already);
    const todo = echoes.filter((e) => !seen.has(e.id));

    console.log(`\n${echoes.length} claim(s) echo a prompt example with an unsupporting receipt`);
    console.log(`${already.length} already quarantined, ${todo.length} to do`);
    for (const e of todo) {
      console.log(`  claim ${e.id}  kind=${e.kind}  p=${e.p_claim}  term=${e.term}`);
    }
    if (todo.length === 0) return 0;
    if (dryRun) {
      console.log('\n--dry-run: nothing written');
      return 0;
    }

    const insert = db.prepare(
      'INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = Date.now();
    db.exec('BEGIN');
    try {
      for (const e of todo) {
        // actor 'system', never 'owner'. The owner did not review these, and a
        // decision that claims they did is a worse lie than the claim it retires.
        insert.run(e.id, 'reject', 'system',
          `prompt-echo: matched "${e.term}" from a distill_claims.md example; no cited row contains it`,
          now);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log(`\nquarantined ${todo.length} claim(s) — reject decisions appended, rows preserved`);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
