// THE DISTILLER'S PREFILTER: before the local llama reads an episode for
// claims (ui/scripts/distill-episodes.mjs, every 45 seconds while catching
// up, the biggest steady compute draw on the owner's Mac), ask Jev two yes/no
// questions per episode -- did the owner commit to something, did the other
// person ask something left hanging -- and hand the llama only the episodes
// where either is plausible.
//
// WHY IT LIVES BEHIND A ROUTE. The distill script opens the database
// read-only and is respawned every pass, so it cannot hold a budget counter
// or the credential; it posts episode ids, hermes reads the lines itself.
//
// FAIL OPEN, ALWAYS. Budget spent, engine unconfigured, paused or rejected, a
// concurrent request, an oversize batch, a network error: the answer is
// "distill every id", which is today's behaviour. A false negative here skips
// an episode for good (the script records a 'read, found nothing' run for it);
// a false positive costs one local llama call. So the threshold is low
// (0.35) and every doubt resolves to distill. Trickle power raises the
// threshold to 0.5, because trickle wants LESS local work, not more.
import { noulQuestion, estimateTokens, recordUsage, usageToday, MAX_STATE_TOKENS, DEFAULT_DAILY_TOKEN_BUDGET } from './jev.mjs';
import { clip } from './personState.mjs';

export const PREFILTER_THRESHOLD = 0.35;
export const PREFILTER_THRESHOLD_TRICKLE = 0.5;
export const EPISODES_PER_CALL = 20;
export const LINES_PER_EPISODE = 20;

export const COMMIT = noulQuestion('In this episode, does the owner (lines marked `you`) commit to something specific for the other person: to send, share, look at, introduce, schedule, or follow up?');
export const ASK = noulQuestion('In this episode, does the other person (lines marked `them`) ask a direct question or make a request that no later line in the same episode answers?');

// One episode as Jev sees it: the last twenty lines, speaker-tagged, clipped.
// `lines` is episodeLines' shape. In the episode store `quotable` means "the
// owner wrote it" (episodes.mjs isQuotable is fromMe), so it is the speaker
// tag here, not a filter: the other person's lines are exactly what the ASK
// question reads.
export function episodeState(lines) {
  const kept = lines.filter((l) => typeof l.text === 'string' && l.text.trim()).slice(-LINES_PER_EPISODE);
  return kept.map((l) => ({ who: Number(l.quotable) === 1 ? 'you' : 'them', text: clip(l.text) }));
}

// Decide for a set of episodes. `readLines(id)` returns episodeLines rows.
// Returns { distill: [ids], skip: [ids], reason, asked, inputTokens }.
export async function prefilterEpisodes(db, jev, episodeIds, {
  readLines, threshold = PREFILTER_THRESHOLD,
  dailyTokenBudget = DEFAULT_DAILY_TOKEN_BUDGET, now = Date.now(), lock = null,
} = {}) {
  const ids = [...new Set((episodeIds ?? []).map(Number).filter(Number.isInteger))];
  const all = (reason) => ({ distill: ids, skip: [], reason, asked: 0, inputTokens: 0 });
  if (ids.length === 0) return { distill: [], skip: [], reason: 'nothing', asked: 0, inputTokens: 0 };
  if (!jev || jev.state !== 'ok') return all(jev ? jev.state : 'unconfigured');
  if (lock && lock.active) return all('busy');
  const spent = usageToday(db, now).inputTokens;
  if (dailyTokenBudget > 0 && spent >= dailyTokenBudget) return all('budget');
  if (lock) lock.active = true;
  try {
    const distill = [];
    const skip = [];
    let asked = 0;
    let inputTokens = 0;
    for (let i = 0; i < ids.length; i += EPISODES_PER_CALL) {
      const batch = ids.slice(i, i + EPISODES_PER_CALL);
      const state = {};
      const questions = {};
      for (const id of batch) {
        const lines = episodeState(readLines(id) ?? []);
        if (lines.length === 0) { distill.push(id); continue; }
        state[`e${id}`] = lines;
        questions[`commit_${id}`] = { question: { ...COMMIT.question, instructions: `${COMMIT.question.instructions} Judge only \`e${id}\`.` }, sha: COMMIT.sha };
        questions[`ask_${id}`] = { question: { ...ASK.question, instructions: `${ASK.question.instructions} Judge only \`e${id}\`.` }, sha: ASK.sha };
      }
      const judged = Object.keys(state).map((k) => Number(k.slice(1)));
      if (judged.length === 0) continue;
      if (estimateTokens({ state, questions }) > MAX_STATE_TOKENS) { distill.push(...judged); continue; }
      const out = await jev.ask({ state, questions });
      if (!out) { distill.push(...judged); continue; }
      asked += 1;
      inputTokens += out.usage.input_tokens;
      recordUsage(db, { inputTokens: out.usage.input_tokens, now });
      for (const id of judged) {
        const c = out.answers[`commit_${id}`]?.noul ?? null;
        const a = out.answers[`ask_${id}`]?.noul ?? null;
        // No answer for an episode is a doubt, and doubts distill.
        if (c === null && a === null) { distill.push(id); continue; }
        if (Math.max(c ?? 0, a ?? 0) >= threshold) distill.push(id); else skip.push(id);
      }
    }
    return { distill, skip, reason: 'judged', asked, inputTokens };
  } catch {
    return all('error');
  } finally {
    if (lock) lock.active = false;
  }
}
