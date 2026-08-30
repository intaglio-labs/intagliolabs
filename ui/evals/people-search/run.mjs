#!/usr/bin/env node

// Deep people-search evaluation pillar.
//
// Default: run privacy-safe invariants plus a real local-model benchmark over
// synthetic connector data with known answers.
// --private: additionally run the three product seed questions against the
// owner's local corpus. That path emits aggregate counts only: never questions,
// names, messages, model prose, person ids, or per-query results.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_DB_PATH,
  DEFAULT_LLAMA_API_KEY_PATH,
  DEFAULT_LLAMA_BASE_URL,
  applyMemoryBatch,
  canonicalLoopbackBase,
  ftsQuery,
  insertRows,
  openDb,
} from '../../server/hermes.mjs';
import {
  answerGeneralPeopleSearch,
  evaluateGeneralPeopleEvidence,
  formatGeneralPeopleResult,
  generalPeopleAnswerCacheInput,
  looksLikeGeneralPeopleQuestion,
  planGeneralPeopleQuestion,
  prepareGeneralPeopleEvidence,
  validateGeneralPeoplePlan,
} from '../../server/people/generalSearch.mjs';
import { detectPersonSearch } from '../../server/people/search.mjs';
import { loadOwner } from '../../server/people/owner.mjs';
import { resolutionsDbPath } from '../../server/people/init.mjs';
import { resolutionState } from '../../server/people/resolve.mjs';
import { openPeopleSearchCache } from '../../server/people/searchCache.mjs';
import { recallClaims } from '../../server/memory/retrieve.mjs';
import { assertAggregatePrivateMetrics } from './privacy.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 29, 12);
const PRIVATE_QUESTIONS = Object.freeze([
  'Find the investors I met in LA about five years ago.',
  'Does anyone from my high school work in tech?',
  'Who should I invite to Italy based on sustained interest in travel?',
]);
const RUN = Object.freeze({
  model: 'people-eval-fixture', prompt_path: 'evals/people-search',
  prompt_sha: 'e'.repeat(64), params: { fixture: true }, rows_in: 1,
});

function norm(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function owner(overrides = {}) {
  return {
    addresses: new Set(['owner@eval.invalid']), names: ['Eval Owner'], keys: new Set(),
    roles: new Map(), rolesByYear: new Map(), schools: [], highSchools: [],
    ...overrides,
  };
}

function stateDb(rows = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE contact_ids(' +
      'identifier TEXT PRIMARY KEY, display_name TEXT, kind TEXT, person_ref TEXT, source TEXT, updated_ts INTEGER)'
  );
  const insert = db.prepare('INSERT INTO contact_ids VALUES(?,?,?,?,?,?)');
  for (const row of rows) {
    insert.run(row.id, row.name, row.kind ?? (row.id.includes('@') ? 'email' : 'phone'),
      row.ref ?? null, 'contacts', NOW);
  }
  return db;
}

function llamaConfig() {
  const baseUrl = canonicalLoopbackBase(
    process.env.PEOPLE_EVAL_LLAMA_URL ?? DEFAULT_LLAMA_BASE_URL,
    'PEOPLE_EVAL_LLAMA_URL'
  );
  const keyPath = process.env.PEOPLE_EVAL_LLAMA_KEY_PATH ?? DEFAULT_LLAMA_API_KEY_PATH;
  const key = readFileSync(keyPath, 'utf8').trim();
  if (key.length < 32) throw new Error('people eval llama key is missing or malformed');
  return { baseUrl, apiKey: () => key };
}

function plan(overrides = {}) {
  const value = {
    kind: 'people_search', interpretation: 'people with evidence for the requested condition',
    facets: [{ label: 'requested condition', terms: ['travel'], required: true }],
    scope: ['messages'], attribution: 'person', from: null, to: null,
    minimumEvidence: 1, preferRepeated: false, requireReachable: true, ranking: 'relevance',
    ...overrides,
  };
  value.terms = [...new Set(value.facets.flatMap((facet) => facet.terms))];
  return value;
}

function verified(match, supported = true, confidence = match.confidence) {
  return {
    person_id: match.person_id, supported, confidence, evidence_ids: match.evidence_ids,
  };
}

function passRecord(passed, detail = null) {
  return { passed: Boolean(passed), ...(detail === null ? {} : { detail }) };
}

async function invariantChecks() {
  const checks = {};
  checks.broad_question_activation = passRecord(
    looksLikeGeneralPeopleQuestion('Show me friends who match a condition.')
      && looksLikeGeneralPeopleQuestion('List everyone I know in an industry.')
  );
  checks.evidence_first_routing = passRecord(
    detectPersonSearch('Who should I invite to Italy?') === null
      && detectPersonSearch('Who do I know in a city?') === null
  );
  const compound = validateGeneralPeoplePlan({
    kind: 'people_search', interpretation: 'people matching both conditions',
    facets: [
      { label: 'role', terms: ['investor'], required: true },
      { label: 'place', terms: ['Los Angeles'], required: true },
    ],
    scope: ['messages', 'calendar'], attribution: 'participant', from: '', to: '',
    minimum_evidence: 2, prefer_repeated: false, require_reachable: false, ranking: 'relevance',
  });
  checks.compound_required_conditions = passRecord(
    compound?.facets.filter((facet) => facet.required).length === 2
  );
  const durable = validateGeneralPeoplePlan({
    kind: 'people_search', interpretation: 'people with durable affinity',
    facets: [{ label: 'durable affinity', terms: ['travel'], required: true }],
    scope: ['messages'], attribution: 'person', from: '', to: '', minimum_evidence: 1,
    prefer_repeated: true, require_reachable: true, ranking: 'relevance',
  });
  checks.durable_interest_threshold = passRecord(durable?.minimumEvidence === 2);

  const ctx = openDb(':memory:');
  const spine = stateDb([{ id: '+15550000001', name: 'Invariant Person' }]);
  insertRows(ctx, {
    ts: NOW - DAY, source: 'imessage', entity_id: 'eval:invariant', text: 'I avoid hiking.',
    meta: { chat_handle: '+15550000001', chat_guid: 'eval-invariant', is_from_me: false },
  });
  const basePlan = plan({
    interpretation: 'people who enjoy hiking',
    facets: [{ label: 'hiking interest', terms: ['hiking'], required: true }],
  });
  const judgment = {
    person_id: 'p1', confidence: 0.99, signal: 'enjoys hiking', evidence_ids: ['e1'],
  };
  const contradicted = await answerGeneralPeopleSearch(ctx, spine, 'Who enjoys hiking?', {
    owner: owner(), now: NOW, plan: basePlan, judgments: [judgment],
    verifications: [verified(judgment, false)],
  });
  checks.independent_support_verification = passRecord(contradicted.count === 0);

  const safeJudgment = {
    person_id: 'p1', confidence: 0.95, signal: 'avoids outdoor hiking', evidence_ids: ['e1'],
  };
  const safe = await answerGeneralPeopleSearch(ctx, spine, 'Who avoids hiking?', {
    owner: owner(), now: NOW,
    plan: plan({
      interpretation: 'people who avoid hiking',
      facets: [{ label: 'hiking avoidance', terms: ['hiking'], required: true }],
    }),
    judgments: [safeJudgment], verifications: [verified(safeJudgment)],
  });
  const serialized = JSON.stringify(safe);
  checks.safe_browser_summary = passRecord(
    safe.count === 1 && !serialized.includes('I avoid hiking') && !serialized.includes(safeJudgment.signal)
  );
  checks.identity_confidence_cap = passRecord(safe.evidence?.[0]?.confidence === 0.7);
  spine.close();
  ctx.close();

  const memoryCtx = openDb(':memory:');
  const memorySpine = stateDb([{ id: '+15550000002', name: 'Boundary Person', ref: 'boundary' }]);
  insertRows(memoryCtx, [
    {
      ts: NOW - 2 * DAY, source: 'imessage', entity_id: 'eval:owner-travel', text: 'I enjoy planning trips.',
      meta: { chat_handle: '+15550000002', chat_guid: 'eval-boundary', is_from_me: true },
    },
    {
      ts: NOW - DAY, source: 'imessage', entity_id: 'eval:boundary-reply', text: 'Okay.',
      meta: { chat_handle: '+15550000002', chat_guid: 'eval-boundary', is_from_me: false },
    },
  ]);
  const ownerRow = memoryCtx.prepare("SELECT * FROM context WHERE entity_id = 'eval:owner-travel'").get();
  const applied = applyMemoryBatch(memoryCtx, {
    run: RUN,
    claims: [{
      kind: 'preference', text: 'Eval Owner enjoys planning trips.',
      source: { context_id: Number(ownerRow.id), quote: 'I enjoy planning trips.', content_hash: ownerRow.content_hash },
    }],
  });
  const claimId = Number(memoryCtx.prepare('SELECT max(id) AS id FROM claim WHERE run_id = ?').get(applied.run_id).id);
  memoryCtx.prepare(
    'INSERT INTO claim_decision(claim_id, action, actor, created_at) VALUES (?, ?, ?, ?)'
  ).run(claimId, 'accept', 'owner', NOW);
  const memoryRecall = recallClaims(memoryCtx, { match: ftsQuery('planning trips'), now: NOW });
  const boundaryOut = await answerGeneralPeopleSearch(memoryCtx, memorySpine, 'Who enjoys planning trips?', {
    owner: owner(), now: NOW,
    plan: plan({
      interpretation: 'people who enjoy planning trips',
      facets: [{ label: 'travel interest', terms: ['planning trips', 'trips'], required: true }],
      minimumEvidence: 2, preferRepeated: true,
    }),
    judgments: [], verifications: [],
  });
  checks.memory_authorship_boundary = passRecord(
    memoryRecall.claims.length > 0 && boundaryOut.count === 0
  );
  memorySpine.close();
  memoryCtx.close();

  // The existing regression is itself a product invariant: multiple identifiers
  // on one card must aggregate rather than become duplicate results.
  const regression = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap',
    '--test-name-pattern', 'aggregates evidence across connectors and multiple identifiers',
    'test/people-general-search.test.mjs',
  ], { cwd: join(import.meta.dirname, '..', '..'), encoding: 'utf8' });
  checks.cross_connector_identity = passRecord(regression.status === 0);
  return checks;
}

function goldCases() {
  return [
    {
      category: 'compound_constraints',
      question: 'Find the investors I met in LA about five years ago.',
      setup() {
        const ctx = openDb(':memory:');
        const contacts = Array.from({ length: 26 }, (_, index) => ({
          id: `noise${index}@eval.invalid`, name: `Noise Contact ${index}`, ref: `noise-${index}`,
        }));
        contacts.push({ id: 'target@eval.invalid', name: 'Gold Target', ref: 'gold-target' });
        const spine = stateDb(contacts);
        insertRows(ctx, [
          ...contacts.slice(0, 26).flatMap((contact, index) => Array.from({ length: 4 }, (_, hit) => ({
            ts: NOW - (5 * 365 + index + hit) * DAY, source: 'mail',
            entity_id: `eval:noise:${index}:${hit}`,
            text: 'I invest in seed-stage companies and work with founders.',
            meta: { from: [contact.id], to: ['owner@eval.invalid'], thread_id: `noise-${index}-${hit}` },
          }))),
          {
            ts: NOW - 5 * 365 * DAY, source: 'mail', entity_id: 'eval:target-role',
            text: 'I invest in early-stage companies.',
            meta: { from: ['target@eval.invalid'], to: ['owner@eval.invalid'], thread_id: 'target-role' },
          },
          {
            ts: NOW - 5 * 365 * DAY, source: 'granola', entity_id: 'eval:target-place',
            text: 'Meeting at the Los Angeles office.',
            meta: { participants: [{ email: 'target@eval.invalid', name: 'Gold Target' }], title: 'LA meeting' },
          },
        ]);
        return { ctx, spine, owner: owner(), expected: ['Gold Target'], excludedPrefix: 'Noise Contact' };
      },
    },
    {
      category: 'durable_affinity',
      question: 'Who should I invite to Italy based on sustained interest in travel?',
      setup() {
        const ctx = openDb(':memory:');
        const spine = stateDb([
          { id: '+15550000101', name: 'Gold Traveler', ref: 'gold-traveler' },
          { id: '+15550000102', name: 'One Off', ref: 'one-off' },
        ]);
        insertRows(ctx, [
          { ts: NOW - 180 * DAY, source: 'imessage', entity_id: 'eval:travel:1', text: 'I keep planning trips around Europe.', meta: { chat_handle: '+15550000101', chat_guid: 'gold-travel', is_from_me: false } },
          { ts: NOW - 30 * DAY, source: 'imessage', entity_id: 'eval:travel:2', text: 'Travel is still my favorite way to spend time.', meta: { chat_handle: '+15550000101', chat_guid: 'gold-travel-2', is_from_me: false } },
          { ts: NOW - 20 * DAY, source: 'imessage', entity_id: 'eval:travel:one', text: 'I traveled once for work.', meta: { chat_handle: '+15550000102', chat_guid: 'one-off', is_from_me: false } },
        ]);
        return { ctx, spine, owner: owner(), expected: ['Gold Traveler'], excluded: ['One Off'] };
      },
    },
    {
      category: 'profile_affiliation',
      question: 'Does anyone from my high school work in tech?',
      setup() {
        const ctx = openDb(':memory:');
        const spine = stateDb([
          { id: 'gold-tech@eval.invalid', name: 'Gold Technologist', ref: 'gold-tech' },
          { id: 'school-only@eval.invalid', name: 'School Only', ref: 'school-only' },
        ]);
        insertRows(ctx, [
          { ts: NOW - DAY, source: 'linkedin', entity_id: 'linkedin:eval:gold-tech', text: 'Gold Technologist', meta: { kind: 'connection', name: 'Gold Technologist', email: 'gold-tech@eval.invalid', position: 'Engineer', industry: 'Software', education: [{ school: 'Northstar Academy' }] } },
          { ts: NOW - DAY, source: 'linkedin', entity_id: 'linkedin:eval:school-only', text: 'School Only', meta: { kind: 'connection', name: 'School Only', email: 'school-only@eval.invalid', position: 'Chef', industry: 'Hospitality', education: [{ school: 'Northstar Academy' }] } },
        ]);
        return {
          ctx, spine,
          owner: owner({ schools: ['Northstar Academy'], highSchools: ['Northstar Academy'] }),
          expected: ['Gold Technologist'], excluded: ['School Only'],
        };
      },
    },
    {
      category: 'contradiction_abstention',
      question: 'Who enjoys hiking?',
      setup() {
        const ctx = openDb(':memory:');
        const spine = stateDb([{ id: '+15550000103', name: 'Negative Control', ref: 'negative' }]);
        insertRows(ctx, { ts: NOW - DAY, source: 'imessage', entity_id: 'eval:negative', text: 'I dislike hiking and avoid trails.', meta: { chat_handle: '+15550000103', chat_guid: 'negative', is_from_me: false } });
        return { ctx, spine, owner: owner(), expected: [], excluded: ['Negative Control'] };
      },
    },
    {
      category: 'cross_connector_aggregation',
      question: 'Who has a sustained interest in climate work?',
      setup() {
        const ctx = openDb(':memory:');
        const spine = stateDb([
          { id: '+15550000104', name: 'Gold Aggregate', ref: 'aggregate' },
          { id: 'aggregate@eval.invalid', name: 'Gold Aggregate', ref: 'aggregate' },
        ]);
        insertRows(ctx, [
          { ts: NOW - 100 * DAY, source: 'mail', entity_id: 'eval:aggregate:mail', text: 'Climate work remains important to me.', meta: { from: ['aggregate@eval.invalid'], to: ['owner@eval.invalid'], thread_id: 'aggregate-mail' } },
          { ts: NOW - 10 * DAY, source: 'imessage', entity_id: 'eval:aggregate:message', text: 'I continue making time for climate work.', meta: { chat_handle: '+15550000104', chat_guid: 'aggregate-message', is_from_me: false } },
        ]);
        return { ctx, spine, owner: owner(), expected: ['Gold Aggregate'], exactCount: 1 };
      },
    },
  ];
}

async function runGold(llama, { debug = false } = {}) {
  const categoryScores = {};
  const diagnostics = {};
  let passed = 0;
  for (const testCase of goldCases()) {
    const fixture = testCase.setup();
    let ok = false;
    const diagnostic = { planned: false, candidates: 0, verified_matches: 0, execution_error: false };
    try {
      const searchPlan = await planGeneralPeopleQuestion(testCase.question, {
        owner: fixture.owner, now: NOW, llama,
      });
      diagnostic.planned = searchPlan?.kind === 'people_search';
      if (!diagnostic.planned) throw new Error('planner abstained');
      if (debug) {
        diagnostic.plan = {
          facets: searchPlan.facets,
          scope: searchPlan.scope,
          attribution: searchPlan.attribution,
          from: searchPlan.from,
          to: searchPlan.to,
          minimum_evidence: searchPlan.minimumEvidence,
          prefer_repeated: searchPlan.preferRepeated,
        };
      }
      const prepared = prepareGeneralPeopleEvidence(fixture.ctx, fixture.spine, searchPlan, {
        owner: fixture.owner, now: NOW,
      });
      diagnostic.candidates = prepared.candidates.length;
      if (debug) {
        diagnostic.linked_rows = fixture.ctx.prepare(
          'SELECT count(*) AS total, count(DISTINCT person_key) AS people FROM person_event_links'
        ).get();
      }
      const matches = await evaluateGeneralPeopleEvidence(testCase.question, prepared, { llama, limit: 10 });
      diagnostic.verified_matches = matches.length;
      const out = formatGeneralPeopleResult(matches, prepared);
      const text = String(out?.text ?? '');
      ok = out !== null
        && fixture.expected.every((name) => text.includes(name))
        && (fixture.excluded ?? []).every((name) => !text.includes(name))
        && (!fixture.excludedPrefix || !text.includes(fixture.excludedPrefix))
        && (fixture.exactCount === undefined || out.count === fixture.exactCount)
        && !JSON.stringify(out).includes('eval:');
    } catch (error) {
      diagnostic.execution_error = true;
      if (debug) diagnostic.error_type = String(error?.message ?? 'unknown').slice(0, 120);
      ok = false;
    } finally {
      fixture.spine.close();
      fixture.ctx.close();
    }
    categoryScores[testCase.category] = ok;
    diagnostics[testCase.category] = diagnostic;
    if (ok) passed += 1;
  }
  return {
    passed, total: goldCases().length, categories: categoryScores,
    ...(debug ? { diagnostics } : {}),
  };
}

function copiedFromRows(output, rows) {
  const rendered = norm(output);
  if (!rendered) return false;
  for (const row of rows) {
    const source = norm(row.text);
    if (source.length >= 6 && rendered.includes(source)) return true;
    const words = source.split(' ').filter(Boolean);
    for (let index = 0; index <= words.length - 3; index += 1) {
      if (rendered.includes(words.slice(index, index + 3).join(' '))) return true;
    }
  }
  return false;
}

async function runPrivateShadow(llama) {
  const startedAt = Date.now();
  const metrics = {
    queries: PRIVATE_QUESTIONS.length, planned: 0, answered: 0, abstained: 0,
    execution_errors: 0, candidates: 0, verified_matches: 0,
    memory_errors: 0, planning_errors: 0, retrieval_errors: 0, verification_errors: 0,
    elapsed_ms: 0,
    judgment_batches: 0, verification_batches: 0, batch_errors: 0,
    planning_ms: 0, judgment_ms: 0, verification_ms: 0,
    model_calls: 0, prompt_tokens: 0, completion_tokens: 0,
    cache_hits: 0, cache_misses: 0, warm_cache_hits: 0,
    warm_model_calls: 0, warm_cache_ms: 0, cache_consistency_violations: 0,
    privacy_violations: 0, identity_confidence_violations: 0,
    person_attribution_owner_evidence_violations: 0,
    memory_queries_with_lexical_hits: 0, memory_store_available: false,
  };
  const contextDb = openDb(DEFAULT_DB_PATH);
  const statePath = join(homedir(), '.hazlie', 'connectors', 'state.db');
  const state = existsSync(statePath) ? new DatabaseSync(statePath, { readOnly: true }) : null;
  const resolutionPath = resolutionsDbPath();
  const resolutions = existsSync(resolutionPath)
    ? new DatabaseSync(resolutionPath, { readOnly: true })
    : null;
  const aliases = resolutions ? resolutionState(resolutions).aliases : null;
  const profile = loadOwner();
  const cache = openPeopleSearchCache(':memory:');
  const recordStage = (event, { warm = false } = {}) => {
    if (event.event === 'cache_hit') {
      if (warm) metrics.warm_cache_hits += 1;
      else metrics.cache_hits += 1;
    } else if (event.event === 'cache_miss' && !warm) {
      metrics.cache_misses += 1;
    } else if (event.event === 'model_complete') {
      if (warm) metrics.warm_model_calls += 1;
      else {
        metrics.model_calls += 1;
        metrics.prompt_tokens += Number(event.promptTokens ?? 0);
        metrics.completion_tokens += Number(event.completionTokens ?? 0);
      }
    } else if (!warm && event.stage === 'planning' && event.event === 'complete') {
      metrics.planning_ms += Number(event.elapsedMs ?? 0);
    } else if (!warm && event.stage === 'judgment' && event.event === 'complete') {
      metrics.judgment_batches += 1;
      metrics.judgment_ms += Number(event.elapsedMs ?? 0);
    } else if (!warm && event.stage === 'verification' && event.event === 'complete') {
      metrics.verification_batches += 1;
      metrics.verification_ms += Number(event.elapsedMs ?? 0);
    } else if (!warm && event.event === 'error') {
      metrics.batch_errors += 1;
    }
  };
  metrics.memory_store_available = Number(
    contextDb.prepare('SELECT count(*) AS n FROM v_claim_accepted').get().n
  ) > 0;
  try {
    for (const question of PRIVATE_QUESTIONS) {
      let stage = 'memory';
      try {
        const queryNow = Date.now();
        const recalled = recallClaims(contextDb, { match: ftsQuery(question), now: Date.now() });
        if (recalled.matched > 0) metrics.memory_queries_with_lexical_hits += 1;
        stage = 'planning';
        const searchPlan = await planGeneralPeopleQuestion(question, {
          llama, now: queryNow, owner: profile, cache,
          onStage: (event) => recordStage(event),
        });
        if (!searchPlan || searchPlan.kind !== 'people_search') {
          metrics.abstained += 1;
          continue;
        }
        metrics.planned += 1;
        stage = 'retrieval';
        const prepared = prepareGeneralPeopleEvidence(contextDb, state, searchPlan, {
          owner: profile, aliases, now: queryNow,
        });
        metrics.candidates += prepared.candidates.length;
        if (prepared.candidates.length === 0) {
          metrics.abstained += 1;
          continue;
        }
        stage = 'verification';
        const matches = await evaluateGeneralPeopleEvidence(question, prepared, {
          llama, limit: 10, cache, onStage: (event) => recordStage(event),
        });
        metrics.verified_matches += matches.length;
        if (matches.length === 0) metrics.abstained += 1;
        else metrics.answered += 1;
        const result = formatGeneralPeopleResult(matches, prepared);
        for (const match of matches) {
          if (searchPlan.attribution === 'person' && match.cited.some((row) => row.ownerAuthored)) {
            metrics.person_attribution_owner_evidence_violations += 1;
          }
          const identityFloor = Math.min(...match.cited.map((row) => Number(row.confidence)));
          if (match.confidence > identityFloor) metrics.identity_confidence_violations += 1;
          if (copiedFromRows(JSON.stringify(result), match.cited)) metrics.privacy_violations += 1;
        }

        // The low-level eval path has just produced the same validated result
        // the production wrapper stores. Seed that final derived entry, then
        // replay the complete production wrapper. Only aggregate latency/hit
        // counts and output cardinality survive.
        cache.put('answer', generalPeopleAnswerCacheInput(
          contextDb, state, question, searchPlan,
          { owner: profile, aliases, now: queryNow, limit: 10, model: llama.model ?? llama.baseUrl }
        ), result);
        const warmStartedAt = Date.now();
        const warmResult = await answerGeneralPeopleSearch(contextDb, state, question, {
          llama, limit: 10, cache, owner: profile, aliases, now: queryNow,
          onStage: (event) => recordStage(event, { warm: true }),
        });
        metrics.warm_cache_ms += Date.now() - warmStartedAt;
        if (warmResult?.count !== result.count) metrics.cache_consistency_violations += 1;
      } catch {
        metrics.execution_errors += 1;
        metrics[`${stage}_errors`] += 1;
      }
    }
  } finally {
    cache?.close();
    try { resolutions?.close(); } catch {}
    try { state?.close(); } catch {}
    contextDb.close();
  }
  metrics.elapsed_ms = Date.now() - startedAt;
  return metrics;
}

async function main() {
  const includePrivate = process.argv.includes('--private');
  const debug = process.argv.includes('--debug');
  const baselinePath = new URL('./baseline.json', import.meta.url);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const checks = await invariantChecks();
  const invariantPassed = Object.values(checks).filter((item) => item.passed).length;
  const llama = llamaConfig();
  const gold = await runGold(llama, { debug });
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    privacy: 'aggregate-only; no corpus rows, identities, questions, or model prose',
    comparison: {
      baseline_label: baseline.label,
      baseline_invariants: baseline.invariants,
      current_invariants: {
        passed: invariantPassed, total: Object.keys(checks).length,
        categories: Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, value.passed])),
      },
    },
    local_model_gold: gold,
  };
  if (includePrivate) {
    report.private_shadow = assertAggregatePrivateMetrics(await runPrivateShadow(llama));
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const invariantsOk = invariantPassed === Object.keys(checks).length;
  if (!invariantsOk || gold.passed !== gold.total
      || report.private_shadow?.execution_errors > 0 || report.private_shadow?.batch_errors > 0
      || report.private_shadow?.warm_model_calls > 0
      || report.private_shadow?.cache_consistency_violations > 0) {
    process.exitCode = 1;
  }
}

main().catch(() => {
  process.stderr.write('people-search eval could not complete; no private details were emitted\n');
  process.exitCode = 1;
});
