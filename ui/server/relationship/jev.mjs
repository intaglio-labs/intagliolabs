// The judgment engine: TypeSafe's Jev, a decision model that answers typed
// questions (a choice among options, a score on ordered levels, a yes/no
// probability) and never generates text. It sits BESIDE the engines in
// engines.mjs, not among them: those complete prose (person pages, drafts,
// sweep lines) and Jev cannot; Jev grades, classifies and picks among lines
// code already extracted, which is the judgment layer of the reconnect card.
//
// OWNER DECISION 2026-09-20, recorded verbatim in the session that built this:
// "fuck the privacy promise bullshit, this is about bringing value ... do a
// full overhaul with jev". Judgments are ON whenever a key is present. No
// consent toggle gates them. The Claude toggle in engines.mjs is unchanged and
// its sentences about the CLI engine stay true; the GLOBAL reading -- "any
// feature sending message excerpts to a model outside the Mac is off until the
// owner turns it on" -- is struck through where it appears (engines.mjs header,
// site/privacy) and ops/EGRESS.json names this host with that decision.
//
// WHAT LEAVES. The state a caller builds (personState.mjs, the quote
// candidates, the last exchange) -- text derived from the owner's own messages
// and the other person's -- and the questions. WHAT COMES BACK is numbers and
// closed enums only: this module drops the response's `legend` echo and never
// builds a string from state or from an answer. NEVER LOG PROMPT OR RESULT
// TEXT; counts, ids, token usage and probabilities only, the same rule as
// engines.mjs and ui/AGENTS.md.
//
// ONE HOST, HARD-CODED. There is no base-URL config key and no env override
// for it, so connectors/test/egress.test.mjs's literal-host scan sees the
// destination here and nothing in config can redirect message text elsewhere.
// Tests inject `transport` instead.
//
// JAGGEDNESS, HANDLED IN CODE (docs.typesafe.ai/model-jaggedness/jev-1.13).
// Jev reads digits and dates as text and cannot count, so callers turn
// numbers into words before they reach the state; every threshold, median and
// ordering stays in JS. Option ORDER moves answers, so questions are built
// through the three helpers below from frozen literal arrays and each carries a
// sha of its instructions and ordered criteria -- the sha rides every cached
// judgment, so a reorder invalidates the cache instead of silently moving
// answers. Never derive P(not x) as 1 - P(x): read the option you want.
//
// FAILURE RULES. 429/529: three jittered retries, capped at 4 s. 401: latched
// `rejected` for the process until the key file changes -- a wrong key is not
// something to retry every 45 seconds. 422 is our bug: counted, not retried.
// A network error means offline: straight to the caller's fallback. Five
// consecutive failures of any kind open a 15-minute circuit, so the distiller's
// loop cannot make eighty failed calls an hour on a plane. Every path a caller
// sees is "null, fall back" -- nothing here throws into a producer.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSecretLine } from '../../../connectors/lib/secrets.mjs';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
// Published price 2026-09-20: $0.042 per million input tokens, output free.
// Derived at read time, never stored, so a price change is one constant.
export const USD_PER_MTOK = 0.042;
export const MAX_STATE_TOKENS = 24_000;
export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_RETRIES = 3;
export const CIRCUIT_FAILURES = 5;
export const CIRCUIT_OPEN_MS = 15 * 60_000;
export const DEFAULT_DAILY_TOKEN_BUDGET = 25_000_000;
export const JEV_STATES = Object.freeze(['unconfigured', 'ok', 'rejected', 'paused']);

export function defaultKeyPath(home = homedir()) {
  return join(home, '.hazlie', 'secrets', 'typesafe-api-key.txt');
}

// sweep.mjs's estimator: four characters a token is generous for English and
// safe for CJK, where the ratio is lower and the true count is smaller.
export function estimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function questionSha(type, instructions, criteria) {
  return createHash('sha256').update(canonical({ type, instructions, criteria })).digest('hex').slice(0, 16);
}

function assertOrderedLiteral(list, what) {
  if (!Array.isArray(list)) throw new TypeError(`${what} must be an array (a Set or object has no order Jev can be pinned to)`);
  if (!Object.isFrozen(list)) throw new TypeError(`${what} must be a frozen literal array: option order is part of the question`);
}

function assertInstructions(instructions) {
  if (typeof instructions !== 'string' || instructions.trim().length === 0) {
    throw new TypeError('question instructions must be a non-empty string');
  }
}

// Choice: pick one of 2..255 options. `orderedPairs` is [[option, description], ...].
export function choiceQuestion(instructions, orderedPairs) {
  assertInstructions(instructions);
  assertOrderedLiteral(orderedPairs, 'choice options');
  if (orderedPairs.length < 2 || orderedPairs.length > 255) throw new RangeError('a choice needs 2..255 options');
  const criteria = {};
  const options = [];
  for (const pair of orderedPairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      throw new TypeError('each choice option is [name, description]');
    }
    if (pair[0] in criteria) throw new TypeError(`duplicate choice option ${JSON.stringify(pair[0])}`);
    criteria[pair[0]] = pair[1];
    options.push(pair[0]);
  }
  return {
    question: { type: 'choice', instructions, criteria },
    options: Object.freeze(options),
    sha: questionSha('choice', instructions, orderedPairs),
  };
}

// Score: 2..10 ordered level descriptions, low to high. The answer is a
// probability-weighted position, so 1.43 means "between level 1 and 2".
export function scoreQuestion(instructions, orderedLevels) {
  assertInstructions(instructions);
  assertOrderedLiteral(orderedLevels, 'score levels');
  if (orderedLevels.length < 2 || orderedLevels.length > 10) throw new RangeError('a score needs 2..10 levels');
  if (!orderedLevels.every((l) => typeof l === 'string' && l.length > 0)) throw new TypeError('each score level is a description string');
  return {
    question: { type: 'score', instructions, criteria: [...orderedLevels] },
    levels: orderedLevels.length,
    sha: questionSha('score', instructions, orderedLevels),
  };
}

// Noul: the probability the answer is yes. `criteria` optionally describes the
// two sides.
export function noulQuestion(instructions, criteria = null) {
  assertInstructions(instructions);
  const question = { type: 'noul', instructions };
  if (criteria) {
    if (typeof criteria.true !== 'string' || typeof criteria.false !== 'string') {
      throw new TypeError('noul criteria are {true, false} descriptions');
    }
    question.criteria = { true: criteria.true, false: criteria.false };
  }
  return { question, sha: questionSha('noul', instructions, criteria ? [criteria.true, criteria.false] : null) };
}

export class JevError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'JevError';
    this.kind = kind; // unconfigured | rejected | paused | oversize | http | timeout | network | shape
  }
}

// Numbers and closed enums only. Anything else in the response -- `legend`,
// unknown fields, an option we did not offer -- is dropped here so no caller
// can accidentally store or log it.
function sanitizeAnswer(raw, question) {
  if (!raw || typeof raw !== 'object') return null;
  if (question.type === 'noul') {
    const p = Number(raw.noul);
    return Number.isFinite(p) && p >= 0 && p <= 1 ? { type: 'noul', noul: p } : null;
  }
  const confidence = Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null;
  if (question.type === 'choice') {
    const offered = Object.keys(question.criteria);
    const choice = typeof raw.choice === 'string' && offered.includes(raw.choice) ? raw.choice : null;
    const probabilities = {};
    for (const opt of offered) {
      const p = Number(raw.probabilities?.[opt]);
      if (Number.isFinite(p)) probabilities[opt] = p;
    }
    if (choice === null) return null;
    return { type: 'choice', choice, probabilities, confidence };
  }
  if (question.type === 'score') {
    const top = question.criteria.length - 1;
    const score = Number(raw.score);
    if (!Number.isFinite(score) || score < 0 || score > top) return null;
    const probabilities = {};
    for (let i = 0; i <= top; i += 1) {
      const p = Number(raw.probabilities?.[String(i)]);
      if (Number.isFinite(p)) probabilities[String(i)] = p;
    }
    return { type: 'score', score, probabilities, confidence };
  }
  return null;
}

export function createJev(config = {}) {
  const cfg = config?.relationshipMemory?.jev ?? {};
  const model = typeof cfg.model === 'string' && cfg.model ? cfg.model : JEV_DEFAULT_MODEL;
  const keyPath = typeof cfg.keyPath === 'string' && cfg.keyPath ? cfg.keyPath : defaultKeyPath();
  const timeoutMs = Number.isInteger(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxRetries = Number.isInteger(cfg.maxRetries) && cfg.maxRetries >= 0 ? cfg.maxRetries : DEFAULT_MAX_RETRIES;
  const transport = cfg.transport ?? globalThis.fetch;
  const onUsage = typeof cfg.onUsage === 'function' ? cfg.onUsage : null;
  const now = typeof cfg.now === 'function' ? cfg.now : Date.now;
  const sleep = typeof cfg.sleep === 'function' ? cfg.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const env = cfg.env ?? process.env;
  const enabled = cfg.enabled !== false;

  const counters = { calls: 0, inputTokens: 0, errors: 0, oversize: 0, retries: 0, skipped: 0 };
  let key = null;
  let keyStamp = null;
  let rejectedStamp = null; // the key file stamp a 401 was latched against
  let consecutiveFailures = 0;
  let pausedUntil = 0;

  function fileStamp() {
    try {
      const st = statSync(keyPath, { bigint: true });
      return `${st.mtimeNs}:${st.size}:${st.ino}:${st.dev}`;
    } catch {
      return null;
    }
  }

  // Lazily, memoised on the file's stamp (the same stamp hermes uses for the
  // owner config), so a key placed after launch is picked up without a
  // restart and a rotated key clears a latched rejection.
  function resolveKey() {
    if (typeof env.TYPESAFE_API_KEY === 'string' && env.TYPESAFE_API_KEY.trim()) {
      return { key: env.TYPESAFE_API_KEY.trim(), stamp: 'env' };
    }
    const stamp = fileStamp();
    if (stamp === null) { key = null; keyStamp = null; return null; }
    if (stamp === keyStamp && key) return { key, stamp };
    try {
      key = readSecretLine(keyPath, { label: 'TypeSafe API key', setupHint: 'see ops/EGRESS.json (judgment-model)' });
      keyStamp = stamp;
      return { key, stamp };
    } catch {
      key = null; keyStamp = null;
      return null;
    }
  }

  function state() {
    if (!enabled) return 'unconfigured';
    const resolved = resolveKey();
    if (!resolved) return 'unconfigured';
    if (rejectedStamp !== null && rejectedStamp === resolved.stamp) return 'rejected';
    if (pausedUntil > now()) return 'paused';
    return 'ok';
  }

  function noteFailure() {
    counters.errors += 1;
    consecutiveFailures += 1;
    if (consecutiveFailures >= CIRCUIT_FAILURES) {
      pausedUntil = now() + CIRCUIT_OPEN_MS;
      consecutiveFailures = 0;
    }
  }

  // ask({ state, questions }) -> { answers: {id: sanitized}, usage: {input_tokens} } | null.
  // `questions` is {id: {question, sha}} from the helpers, or bare question
  // objects; the sha is the caller's to store. Returns null on every failure
  // and sets `lastError` (a JevError with a coarse kind) for callers that log.
  let lastError = null;
  async function ask({ state: body, questions }) {
    lastError = null;
    const st = state();
    if (st !== 'ok') { counters.skipped += 1; lastError = new JevError(`jev ${st}`, st); return null; }
    const resolved = resolveKey();
    const qmap = {};
    for (const [id, q] of Object.entries(questions ?? {})) qmap[id] = q?.question ?? q;
    if (Object.keys(qmap).length === 0) throw new TypeError('ask needs at least one question');
    const payload = { model, state: body, questions: qmap };
    if (estimateTokens(payload) > MAX_STATE_TOKENS) {
      counters.oversize += 1;
      lastError = new JevError('state over the token cap; the caller trims, this module refuses', 'oversize');
      return null;
    }
    const text = JSON.stringify(payload);
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let res;
      try {
        counters.calls += 1;
        res = await transport(JEV_ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${resolved.key}`, 'Content-Type': 'application/json' },
          body: text,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        noteFailure();
        lastError = new JevError(timedOut ? 'jev timed out' : 'jev unreachable', timedOut ? 'timeout' : 'network');
        return null;
      }
      if (res.status === 429 || res.status === 529) {
        if (attempt < maxRetries) {
          counters.retries += 1;
          const base = Math.min(4_000, 250 * 2 ** attempt);
          await sleep(Math.round(base * (0.75 + Math.random() * 0.5)));
          continue;
        }
        noteFailure();
        lastError = new JevError(`jev ${res.status} after ${maxRetries} retries`, 'http');
        return null;
      }
      if (res.status === 401) {
        rejectedStamp = resolved.stamp;
        counters.errors += 1;
        lastError = new JevError('jev rejected the key', 'rejected');
        return null;
      }
      if (!res.ok) {
        noteFailure();
        lastError = new JevError(`jev http ${res.status}`, 'http');
        return null;
      }
      let json;
      try { json = await res.json(); } catch { noteFailure(); lastError = new JevError('jev returned a non-JSON body', 'shape'); return null; }
      const answers = {};
      for (const [id, q] of Object.entries(qmap)) {
        const clean = sanitizeAnswer(json?.answers?.[id], q);
        if (clean) answers[id] = clean;
      }
      const inputTokens = Number.isInteger(json?.usage?.input_tokens) ? json.usage.input_tokens : estimateTokens(payload);
      counters.inputTokens += inputTokens;
      consecutiveFailures = 0;
      if (onUsage) { try { onUsage({ inputTokens, calls: 1 }); } catch { /* usage is bookkeeping, never a failure */ } }
      return { answers, usage: { input_tokens: inputTokens }, model: typeof json?.model === 'string' ? json.model : model };
    }
    return null;
  }

  return {
    name: 'jev',
    model,
    get disabled() { return state() !== 'ok'; },
    get state() { return state(); },
    get lastError() { return lastError; },
    counters,
    ask,
    costUsd(tokens = counters.inputTokens) { return (tokens / 1e6) * USD_PER_MTOK; },
  };
}

// ---- the cache (rm_judgment) and the usage ledger (rm_jev_usage) ----------
//
// A judgment is a CACHE, not a record of what the owner saw: it can be
// deleted, and retention deletes it after 90 days. No text columns -- ids,
// enums and numbers only, the rule rm_candidate_snapshot states.
export const JUDGMENT_KINDS = Object.freeze([
  'quote', 'ending', 'relationship_kind', 'kind',
  'professional_axis', 'closeness', 'relatives', 'romantic', 'worth',
  'page_who', 'page_ask', 'page_objection', 'page_how_left', 'page_notable',
  'sweep_sub_role', 'sweep_firm', 'distill_commit', 'distill_ask',
]);
export const JUDGMENT_RETENTION_MS = 90 * 86_400_000;
export const USAGE_RETENTION_DAYS = 400;

export const JUDGMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS rm_judgment(
  id           INTEGER PRIMARY KEY,
  person_key   TEXT,
  kind         TEXT NOT NULL CHECK (kind IN (${JUDGMENT_KINDS.map((k) => `'${k}'`).join(',')})),
  subject_id   INTEGER,
  subject_hash TEXT,
  answer       TEXT,
  score        REAL,
  probability  REAL,
  confidence   REAL,
  model        TEXT NOT NULL,
  question_sha TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rm_judgment_lookup ON rm_judgment(person_key, kind, created_at);
CREATE INDEX IF NOT EXISTS rm_judgment_kind_person ON rm_judgment(kind, person_key, id);
CREATE UNIQUE INDEX IF NOT EXISTS rm_judgment_cache
  ON rm_judgment(kind, subject_id, subject_hash, question_sha) WHERE subject_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS rm_jev_usage(
  day          TEXT PRIMARY KEY,
  calls        INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0
);
`;

// Insert or replace one judgment. `answer` must be a short closed token (an
// option name or derived label), never free text -- anything with whitespace
// is refused here so a caller cannot store a quote by accident.
const TEXTY = /\s/u;
export function recordJudgment(db, {
  personKey = null, kind, subjectId = null, subjectHash = null,
  answer = null, score = null, probability = null, confidence = null, model, questionSha, now = Date.now(),
}) {
  if (!JUDGMENT_KINDS.includes(kind)) throw new TypeError(`unknown judgment kind ${JSON.stringify(kind)}`);
  if (answer !== null && (typeof answer !== 'string' || answer.length > 40 || TEXTY.test(answer))) {
    throw new TypeError('a judgment answer is a closed token, never text');
  }
  if (typeof model !== 'string' || !model) throw new TypeError('model is required');
  if (typeof questionSha !== 'string' || !questionSha) throw new TypeError('questionSha is required');
  if (subjectId !== null) {
    db.prepare(`DELETE FROM rm_judgment WHERE kind = ? AND subject_id = ? AND subject_hash IS ? AND question_sha = ?`)
      .run(kind, subjectId, subjectHash, questionSha);
  } else if (personKey !== null) {
    // A person-scoped judgment is the newest one only: it is a cache, and a
    // row per pass would grow without bound and make every newest-per-person
    // read a correlated scan (review finding 12).
    db.prepare(`DELETE FROM rm_judgment WHERE kind = ? AND person_key = ? AND subject_id IS NULL`).run(kind, personKey);
  }
  const info = db.prepare(`INSERT INTO rm_judgment(person_key, kind, subject_id, subject_hash, answer, score, probability,
      confidence, model, question_sha, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(personKey, kind, subjectId, subjectHash, answer, score, probability, confidence, model, questionSha, now);
  return Number(info.lastInsertRowid);
}

// The newest judgment of a kind for a person (or for a subject), or null.
export function judgmentFor(db, { personKey = null, kind, subjectId = null, subjectHash = null, questionSha = null }) {
  const where = ['kind = ?'];
  const args = [kind];
  if (subjectId !== null) { where.push('subject_id = ?'); args.push(subjectId); }
  else if (personKey !== null) { where.push('person_key = ?'); args.push(personKey); }
  if (subjectHash !== null) { where.push('subject_hash = ?'); args.push(subjectHash); }
  if (questionSha !== null) { where.push('question_sha = ?'); args.push(questionSha); }
  const row = db.prepare(`SELECT * FROM rm_judgment WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 1`).get(...args);
  return row ? { ...row } : null;
}

// Bounded, so a first prune on a long-lived database is not one giant
// transaction on hermes' single thread.
export function pruneJudgments(db, { now = Date.now(), limit = 5_000 } = {}) {
  const cutoff = now - JUDGMENT_RETENTION_MS;
  const info = db.prepare(`DELETE FROM rm_judgment WHERE id IN (SELECT id FROM rm_judgment WHERE created_at < ? LIMIT ?)`).run(cutoff, limit);
  const day = localDay(now - USAGE_RETENTION_DAYS * 86_400_000);
  db.prepare(`DELETE FROM rm_jev_usage WHERE day < ?`).run(day);
  return Number(info.changes);
}

export function localDay(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function recordUsage(db, { inputTokens = 0, calls = 1, errors = 0, now = Date.now() } = {}) {
  db.prepare(`INSERT INTO rm_jev_usage(day, calls, input_tokens, errors) VALUES (?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET calls = calls + excluded.calls,
      input_tokens = input_tokens + excluded.input_tokens, errors = errors + excluded.errors`)
    .run(localDay(now), calls, inputTokens, errors);
}

export function usageToday(db, now = Date.now()) {
  const row = db.prepare(`SELECT calls, input_tokens, errors FROM rm_jev_usage WHERE day = ?`).get(localDay(now));
  const inputTokens = Number(row?.input_tokens ?? 0);
  return {
    calls: Number(row?.calls ?? 0),
    inputTokens,
    errors: Number(row?.errors ?? 0),
    costUsd: (inputTokens / 1e6) * USD_PER_MTOK,
  };
}

// The status block GET /admin/config/card reports. Absent config is
// `unconfigured`, never a default: the row in settings says "off".
export function jevStatus(db, jev, now = Date.now()) {
  const usage = db ? usageToday(db, now) : { calls: 0, inputTokens: 0, costUsd: 0 };
  return {
    state: jev ? jev.state : 'unconfigured',
    enabled: jev ? jev.state === 'ok' : false,
    callsToday: usage.calls,
    inputTokensToday: usage.inputTokens,
    costUsdToday: Number(usage.costUsd.toFixed(4)),
  };
}
