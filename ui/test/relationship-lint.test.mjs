// Lint (step 5½, relationship/lint.mjs): tests follow the same shape
// relationship-sweep.test.mjs and relationship-lookup.test.mjs use -- pure/DB
// checks first (no model anywhere in this file, so there is no engine fake
// to build), then runLintPass over openDb(':memory:') fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/hermes.mjs';
import { ownerConfigPath } from '../server/people/owner.mjs';
import {
  expiredClaims, roleConflicts, pageAnchorFindings, orphanCardQuotes, runLintPass,
  resolveLintFinding, lintGate, LINT_MAX_PER_CHECK,
} from '../server/relationship/lint.mjs';

const NOW = Date.parse('2026-09-01T12:00:00Z');
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Fixture helpers, shared across the checks below.
// ---------------------------------------------------------------------------

function insertDistillRun(db, { now = NOW } = {}) {
  return Number(
    db.prepare(
      `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at)
       VALUES ('fake:fake-model', '/prompts/none.md', ?, '{}', 'off', 0, 0, 'complete', ?, ?)`
    ).run('f'.repeat(64), now, now).lastInsertRowid
  );
}

function insertClaim(db, { runId, subject = 'person', personKey = null, kind = 'fact', text = 'x', observedAt = NOW, validTo = null, now = NOW }) {
  return Number(
    db.prepare(
      `INSERT INTO claim(run_id, subject, subject_person_key, kind, text, observed_at, valid_to, p_claim, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(runId, subject, personKey, kind, text, observedAt, validTo, now).lastInsertRowid
  );
}

function decide(db, claimId, action, { now = NOW } = {}) {
  db.prepare(
    "INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, ?, 'owner', NULL, ?)"
  ).run(claimId, action, now);
}

function insertSweepRun(db, { distillRunId, now = NOW } = {}) {
  return Number(
    db.prepare(
      `INSERT INTO person_sweep_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
         candidates, swept, model_calls, proposed, dropped, tokens_est, skip_reason, status)
       VALUES (?, ?, NULL, 'trickle', 'fake', 3, 1, 1, 0, 0, 0, 0, 0, NULL, 'running')`
    ).run(distillRunId, now).lastInsertRowid
  );
}

// Mirrors relationship-sweep.test.mjs's own insertPerson, with `linkedin`
// exposed directly (an object to store as JSON, or null) instead of always
// building it from a display name -- role_conflict and the page-anchor
// checks both need to control exactly what a LinkedIn export says.
function insertPersonWithLinkedin(db, { key, name, linkedin = null, subRoles = [] }) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    key, name, NOW - 400 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY,
    10, 10, 0, 0, 20, 0, 'business', '{}',
    linkedin === null ? null : JSON.stringify(linkedin), NOW, JSON.stringify(subRoles)
  );
}

function insertBatch(db, { now = NOW } = {}) {
  return Number(
    db.prepare('INSERT INTO rm_candidate_batch(created_at, candidate_count, gate, cap_config) VALUES (?, ?, ?, ?)')
      .run(now, 1, 'open', null).lastInsertRowid
  );
}

function insertSnapshot(db, { batchId, personKey, quoteContextId, now = NOW }) {
  const evidence = JSON.stringify({ quote_context_id: quoteContextId });
  return Number(
    db.prepare(
      `INSERT INTO rm_candidate_snapshot(batch_id, person_key, kind, summary, evidence, producer_version, rank_strategy, created_at)
       VALUES (?, ?, 'reconnect', 'summary', ?, 'eligibility-v1', 'depth-change-quiet', ?)`
    ).run(batchId, personKey, evidence, now).lastInsertRowid
  );
}

// ---------------------------------------------------------------------------
// (1) C1 expired_claim
// ---------------------------------------------------------------------------

test('expiredClaims finds an accepted claim past its own valid_to, ignores a pending one and one with no valid_to', () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);

  const expiredAccepted = insertClaim(db, { runId, personKey: 'name:c1 a', kind: 'plan', validTo: NOW - DAY });
  decide(db, expiredAccepted, 'accept');

  const expiredPending = insertClaim(db, { runId, personKey: 'name:c1 b', validTo: NOW - DAY });
  void expiredPending; // deliberately never decided

  const acceptedNoValidTo = insertClaim(db, { runId, personKey: 'name:c1 c', validTo: null });
  decide(db, acceptedNoValidTo, 'accept');

  const { findings, truncated } = expiredClaims(db, { now: NOW });
  assert.equal(truncated, false);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingKey, `expired_claim:${expiredAccepted}`);
  assert.equal(findings[0].personKey, 'name:c1 a');
  assert.equal(findings[0].claimId, expiredAccepted);
  const detail = JSON.parse(findings[0].detail);
  assert.equal(detail.kind, 'plan');
  assert.equal(detail.validTo, NOW - DAY);
});

// ---------------------------------------------------------------------------
// (2) C2 role_conflict
// ---------------------------------------------------------------------------

function acceptedSweepProposal(db, { key, tag, linkedin }) {
  const distillRunId = insertDistillRun(db);
  const sweepRunId = insertSweepRun(db, { distillRunId });
  insertPersonWithLinkedin(db, { key, name: key, linkedin });
  const claimId = insertClaim(db, { runId: distillRunId, personKey: key, text: 'tag' });
  decide(db, claimId, 'accept');
  db.prepare('INSERT INTO person_sweep_proposal(claim_id, run_id, kind, value, applied_at) VALUES (?, ?, ?, ?, NULL)')
    .run(claimId, sweepRunId, 'sub_role', tag);
  return claimId;
}

test('roleConflicts fires for an export-derived operator vs. an accepted investor tag', () => {
  const db = openDb(':memory:');
  const key = 'name:c2 conflict';
  const claimId = acceptedSweepProposal(db, {
    key, tag: 'investor', linkedin: { position: 'Chief Operating Officer', company: 'Acme Manufacturing' },
  });

  const { findings, truncated } = roleConflicts(db, {});
  assert.equal(truncated, false);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingKey, `role_conflict:${claimId}`);
  assert.equal(findings[0].personKey, key);
  const detail = JSON.parse(findings[0].detail);
  assert.equal(detail.tag, 'investor');
  assert.deepEqual(detail.exportRoles, ['operator']);
  assert.equal(detail.exportTitle, 'Chief Operating Officer');
  assert.equal(detail.exportCompany, 'Acme Manufacturing');
});

test('roleConflicts is silent when the export derives no roles at all', () => {
  const db = openDb(':memory:');
  acceptedSweepProposal(db, {
    key: 'name:c2 empty export', tag: 'investor',
    linkedin: { position: 'Software Engineer', company: 'Acme Manufacturing' },
  });
  const { findings } = roleConflicts(db, {});
  assert.equal(findings.length, 0);
});

test('roleConflicts is silent when the accepted tag is already among the export-derived roles', () => {
  const db = openDb(':memory:');
  acceptedSweepProposal(db, {
    key: 'name:c2 agrees', tag: 'investor',
    linkedin: { position: 'General Partner', company: 'Acme Capital' },
  });
  const { findings } = roleConflicts(db, {});
  assert.equal(findings.length, 0);
});

test('roleConflicts recomputes from the LinkedIn export, not people.sub_roles -- fires even after the tag was unioned into that column', () => {
  const db = openDb(':memory:');
  const key = 'name:c2 unioned';
  const claimId = acceptedSweepProposal(db, {
    key, tag: 'investor', linkedin: { position: 'Chief Operating Officer', company: 'Acme Manufacturing' },
  });
  // Simulate applySweepDecision's own effect on people.sub_roles once a
  // projection rebuild has run: the accepted tag is unioned into the column.
  db.prepare('UPDATE people SET sub_roles = ? WHERE person_key = ?')
    .run(JSON.stringify(['investor', 'operator']), key);

  const { findings } = roleConflicts(db, {});
  assert.equal(findings.length, 1, 'the conflict still fires -- people.sub_roles is never read');
  assert.equal(findings[0].findingKey, `role_conflict:${claimId}`);
});

// ---------------------------------------------------------------------------
// (3) C3 anchored_no_page / C4 page_no_anchors
// ---------------------------------------------------------------------------

test('pageAnchorFindings: C3 honours LINT_PAGE_TIERS and the rejected-page-item exclusion; C4 fires for a built page with only one anchor', () => {
  const db = openDb(':memory:');
  const distillRunId = insertDistillRun(db);

  // P1: anchored (name + firm), tagged tier (founder), no page at all.
  const p1 = 'name:c3 anchored no page';
  insertPersonWithLinkedin(db, { key: p1, name: 'Anchored No Page', linkedin: { company: 'Acme Capital' }, subRoles: ['founder'] });

  // P2: anchored, tagged tier, but its only person_page_item sits on a
  // REJECTED claim -- still counts as "no page".
  const p2 = 'name:c3 rejected page';
  insertPersonWithLinkedin(db, { key: p2, name: 'Rejected Page', linkedin: { company: 'Acme Capital' }, subRoles: ['founder'] });
  const rejectedClaim = insertClaim(db, { runId: distillRunId, personKey: p2, text: 'who line' });
  decide(db, rejectedClaim, 'reject');
  db.prepare('INSERT INTO person_page_item(claim_id, section, built_at) VALUES (?, ?, ?)').run(rejectedClaim, 'who', NOW);

  // P3: a real (pending) page item, but only ONE anchor (name only).
  const p3 = 'name:c3 page no anchors';
  insertPersonWithLinkedin(db, { key: p3, name: 'Page No Anchors', linkedin: null });
  const pageClaim = insertClaim(db, { runId: distillRunId, personKey: p3, text: 'who line' });
  db.prepare('INSERT INTO person_page_item(claim_id, section, built_at) VALUES (?, ?, ?)').run(pageClaim, 'who', NOW);

  // P4: anchored, but tier 'other' (no tags, not eligible) -- must NOT fire
  // C3 despite having no page: LINT_PAGE_TIERS excludes 'other'.
  const p4 = 'name:c3 other tier';
  insertPersonWithLinkedin(db, { key: p4, name: 'Other Tier', linkedin: { company: 'Acme Capital' } });

  const result = pageAnchorFindings(db, { now: NOW });
  const anchoredKeys = result.anchored_no_page.findings.map((f) => f.personKey);
  const pageKeys = result.page_no_anchors.findings.map((f) => f.personKey);

  assert.ok(anchoredKeys.includes(p1), 'anchored, tagged, no page at all -> fires');
  assert.ok(anchoredKeys.includes(p2), 'a rejected-only page item still counts as no page -> fires');
  assert.ok(!anchoredKeys.includes(p4), "tier 'other' is excluded by LINT_PAGE_TIERS");
  assert.ok(pageKeys.includes(p3), 'a built (non-rejected) page for a one-anchor (unanchored) person -> fires C4');
  assert.equal(result.anchored_no_page.truncated, false);
  assert.equal(result.page_no_anchors.truncated, false);
});

// ---------------------------------------------------------------------------
// (4) C5 orphan_card_quote
// ---------------------------------------------------------------------------

test('orphanCardQuotes fires for a missing quote row, not for a present one, and not for an already-judged snapshot', () => {
  const db = openDb(':memory:');
  const batchId = insertBatch(db);

  const missingId = 999_999; // never inserted into context
  const a = insertSnapshot(db, { batchId, personKey: 'name:c5 a', quoteContextId: missingId });

  const presentCtxId = Number(
    db.prepare("INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)")
      .run(NOW, 'still here', JSON.stringify({})).lastInsertRowid
  );
  const b = insertSnapshot(db, { batchId, personKey: 'name:c5 b', quoteContextId: presentCtxId });

  const c = insertSnapshot(db, { batchId, personKey: 'name:c5 c', quoteContextId: missingId + 1 });
  db.prepare(
    `INSERT INTO rm_card_event(person_key, kind, snapshot_id, event, reason, note, rule_version, time_band, created_at)
     VALUES (?, 'reconnect', ?, 'dismissed', NULL, NULL, 'v1', 'morning', ?)`
  ).run('name:c5 c', c, NOW);

  const { findings, truncated } = orphanCardQuotes(db, {});
  assert.equal(truncated, false);
  const keys = findings.map((f) => f.findingKey);
  assert.ok(keys.includes(`orphan_card_quote:${a}`), 'a missing quote row with no verdict fires');
  assert.ok(!keys.includes(`orphan_card_quote:${b}`), 'a present quote row never fires');
  assert.ok(!keys.includes(`orphan_card_quote:${c}`), 'an already-judged snapshot never fires');

  const detail = JSON.parse(findings.find((f) => f.findingKey === `orphan_card_quote:${a}`).detail);
  assert.equal(detail.snapshotId, a);
  assert.equal(detail.batchId, batchId);
  assert.equal(detail.quoteContextId, missingId);
});

// ---------------------------------------------------------------------------
// (5) idempotence
// ---------------------------------------------------------------------------

test('runLintPass is idempotent: two passes over an unchanged corpus produce the same rows, first_seen_at frozen, last_seen_at advanced', () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);
  const claimId = insertClaim(db, { runId, personKey: 'name:idempotent', validTo: NOW - DAY });
  decide(db, claimId, 'accept');

  const first = runLintPass(db, {}, { now: NOW, checks: ['expired_claim'] });
  assert.equal(first.status, 'complete');
  const key = `expired_claim:${claimId}`;
  const row1 = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(key);
  assert.equal(row1.first_seen_at, NOW);
  assert.equal(row1.last_seen_at, NOW);

  const second = runLintPass(db, {}, { now: NOW + 1000, checks: ['expired_claim'] });
  assert.equal(second.status, 'complete');
  const row2 = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(key);
  assert.equal(row2.first_seen_at, NOW, 'first_seen_at unchanged across passes');
  assert.equal(row2.last_seen_at, NOW + 1000, 'last_seen_at advanced');

  const all = db.prepare('SELECT finding_key FROM lint_finding').all();
  assert.equal(all.length, 1, 'the same single row, not a second one');
});

// ---------------------------------------------------------------------------
// (6) auto-close 'gone', then reopen when the condition returns
// ---------------------------------------------------------------------------

test("a finding auto-closes as 'gone' once a pass no longer sees it, then reopens when the condition returns", () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);
  const claimId = insertClaim(db, { runId, personKey: 'name:reopen', validTo: NOW - DAY });
  decide(db, claimId, 'accept');
  const key = `expired_claim:${claimId}`;

  runLintPass(db, {}, { now: NOW, checks: ['expired_claim'] });
  let row = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(key);
  assert.equal(row.resolved_at, null);

  // Retracted: v_claim_accepted no longer includes it, so the next pass does
  // not see this finding.
  decide(db, claimId, 'retract');
  runLintPass(db, {}, { now: NOW + 1000, checks: ['expired_claim'] });
  row = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(key);
  assert.equal(row.resolution, 'gone');
  assert.ok(row.resolved_at !== null);

  // The condition returns (re-accepted) -- the next pass reopens it.
  decide(db, claimId, 'accept');
  runLintPass(db, {}, { now: NOW + 2000, checks: ['expired_claim'] });
  row = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(key);
  assert.equal(row.resolution, null);
  assert.equal(row.resolved_at, null);
});

// ---------------------------------------------------------------------------
// (7) a dismissal survives being re-seen, and a disappear-then-reappear cycle
// ---------------------------------------------------------------------------

test("an owner dismissal survives a pass that still sees the same finding, and a disappear-then-reappear cycle -- 'gone' is not sticky, an owner resolution is", () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);
  const claimId = insertClaim(db, { runId, personKey: 'name:dismissed', validTo: NOW - DAY });
  decide(db, claimId, 'accept');
  const key = `expired_claim:${claimId}`;

  runLintPass(db, {}, { now: NOW, checks: ['expired_claim'] });
  // resolveLintFinding itself lands in a later commit -- simulate its one
  // write directly, exercising runLintPass's own upsert CASE logic.
  db.prepare("UPDATE lint_finding SET resolved_at = ?, resolution = 'dismiss' WHERE finding_key = ?").run(NOW, key);

  // Still seen next pass: must not be touched.
  runLintPass(db, {}, { now: NOW + 1000, checks: ['expired_claim'] });
  let row = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(key);
  assert.equal(row.resolution, 'dismiss');
  assert.ok(row.resolved_at !== null);

  // Disappears (retracted): a dismissed row is not auto-closed a second time
  // (resolved_at is already set, so the auto-close WHERE resolved_at IS NULL
  // clause never reaches it).
  decide(db, claimId, 'retract');
  runLintPass(db, {}, { now: NOW + 2000, checks: ['expired_claim'] });
  row = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(key);
  assert.equal(row.resolution, 'dismiss', 'still dismissed, not gone');

  // ...then reappears: still dismissed, never reopened -- the upsert's CASE
  // only resets a resolution that is exactly 'gone'.
  decide(db, claimId, 'accept');
  runLintPass(db, {}, { now: NOW + 3000, checks: ['expired_claim'] });
  row = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(key);
  assert.equal(row.resolution, 'dismiss', 'a dismissal survives disappearing and reappearing');
});

// ---------------------------------------------------------------------------
// (8) truncation
// ---------------------------------------------------------------------------

test('a check that hits its cap sets truncated and skips its own auto-close sweep', () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);

  const staleKey = 'name:trunc stale';
  const staleClaim = insertClaim(db, { runId, personKey: staleKey, validTo: NOW - DAY, text: 'stale' });
  decide(db, staleClaim, 'accept');
  const staleFindingKey = `expired_claim:${staleClaim}`;

  const first = runLintPass(db, {}, { now: NOW, checks: ['expired_claim'] });
  assert.equal(first.status, 'complete');
  let staleRow = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(staleFindingKey);
  assert.equal(staleRow.resolved_at, null);

  // The stale finding's own condition disappears -- an ordinary (untruncated)
  // pass would auto-close it as 'gone'.
  decide(db, staleClaim, 'retract');

  // Flood the check past its cap with brand-new accepted, expired claims.
  for (let i = 0; i < LINT_MAX_PER_CHECK + 1; i++) {
    const id = insertClaim(db, { runId, personKey: `name:trunc flood ${i}`, validTo: NOW - DAY, text: `flood ${i}` });
    decide(db, id, 'accept');
  }

  const second = runLintPass(db, {}, { now: NOW + 1000, checks: ['expired_claim'] });
  assert.equal(second.status, 'complete');
  const counts = JSON.parse(second.counts);
  assert.equal(counts.expired_claim.truncated, true);
  assert.equal(Number(second.findings_closed), 0, 'the truncated check closed nothing');

  staleRow = db.prepare('SELECT * FROM lint_finding WHERE finding_key = ?').get(staleFindingKey);
  assert.equal(staleRow.resolved_at, null,
    "a truncated check skips its own auto-close, even for a finding whose condition is now gone");
});

// ---------------------------------------------------------------------------
// (9) resolveLintFinding's three role_conflict resolutions.
// ---------------------------------------------------------------------------

// Stores a role_conflict finding exactly as runLintPass would have (via
// roleConflicts + the upsert), so resolveLintFinding reads its detail (tag,
// exportRoles) the same way a real pass would have written it.
function seedRoleConflictFinding(db, { key, tag, linkedin }) {
  const claimId = acceptedSweepProposal(db, { key, tag, linkedin });
  const { findings } = roleConflicts(db, {});
  const finding = findings.find((f) => f.claimId === claimId);
  assert.ok(finding, 'sanity: roleConflicts actually detected this conflict');
  db.prepare(
    `INSERT INTO lint_finding(finding_key, check_name, person_key, claim_id, detail, first_seen_at, last_seen_at)
     VALUES (?, 'role_conflict', ?, ?, ?, ?, ?)`
  ).run(finding.findingKey, finding.personKey, finding.claimId, finding.detail, NOW, NOW);
  return { claimId, findingKey: finding.findingKey };
}

test('resolveLintFinding keep-export writes the export roles and retracts the accepted sweep claim', () => {
  const db = openDb(':memory:');
  const key = 'name:resolve keep export';
  const { claimId, findingKey } = seedRoleConflictFinding(db, {
    key, tag: 'investor', linkedin: { position: 'Chief Operating Officer', company: 'Acme Manufacturing' },
  });
  const configPath = ownerConfigPath(mkdtempSync(join(tmpdir(), 'lint-config-')));

  const result = resolveLintFinding(db, { findingKey, resolution: 'keep-export', configPath });
  assert.equal(result.applied, true);
  assert.equal(result.rebuildNeeded, true);

  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(raw.personSubRoles[key], ['operator']);

  const decisions = db.prepare('SELECT action FROM claim_decision WHERE claim_id = ? ORDER BY id').all(claimId)
    .map((d) => d.action);
  assert.deepEqual(decisions, ['accept', 'retract'], 'keep-export appends a retract onto the accepted sweep claim');

  const row = db.prepare('SELECT resolved_at, resolution FROM lint_finding WHERE finding_key = ?').get(findingKey);
  assert.equal(row.resolution, 'keep-export');
  assert.ok(row.resolved_at !== null);

  // A second resolve of the same, now-resolved finding is a no-op.
  const again = resolveLintFinding(db, { findingKey, resolution: 'dismiss', configPath });
  assert.equal(again.applied, false);
});

test('resolveLintFinding keep-derived writes only the accepted tag, with no retract', () => {
  const db = openDb(':memory:');
  const key = 'name:resolve keep derived';
  const { claimId, findingKey } = seedRoleConflictFinding(db, {
    key, tag: 'investor', linkedin: { position: 'Chief Operating Officer', company: 'Acme Manufacturing' },
  });
  const configPath = ownerConfigPath(mkdtempSync(join(tmpdir(), 'lint-config-')));

  const result = resolveLintFinding(db, { findingKey, resolution: 'keep-derived', configPath });
  assert.equal(result.applied, true);
  assert.equal(result.rebuildNeeded, true);
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(raw.personSubRoles[key], ['investor']);

  const decisions = db.prepare('SELECT action FROM claim_decision WHERE claim_id = ?').all(claimId)
    .map((d) => d.action);
  assert.deepEqual(decisions, ['accept'], 'keep-derived writes no retract');
});

test('resolveLintFinding both writes the sorted union of the export roles and the accepted tag', () => {
  const db = openDb(':memory:');
  const key = 'name:resolve both';
  const { findingKey } = seedRoleConflictFinding(db, {
    key, tag: 'investor', linkedin: { position: 'Chief Operating Officer', company: 'Acme Manufacturing' },
  });
  const configPath = ownerConfigPath(mkdtempSync(join(tmpdir(), 'lint-config-')));

  const result = resolveLintFinding(db, { findingKey, resolution: 'both', configPath });
  assert.equal(result.applied, true);
  assert.equal(result.rebuildNeeded, true);
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(raw.personSubRoles[key], ['investor', 'operator']);
});

test('resolveLintFinding refuses a role choice on any check other than role_conflict', () => {
  const db = openDb(':memory:');
  const runId = insertDistillRun(db);
  const claimId = insertClaim(db, { runId, personKey: 'name:not a role conflict', validTo: NOW - DAY });
  decide(db, claimId, 'accept');
  runLintPass(db, {}, { now: NOW, checks: ['expired_claim'] });
  const findingKey = `expired_claim:${claimId}`;

  const result = resolveLintFinding(db, { findingKey, resolution: 'keep-export' });
  assert.equal(result.applied, false);
  const row = db.prepare('SELECT resolved_at FROM lint_finding WHERE finding_key = ?').get(findingKey);
  assert.equal(row.resolved_at, null, 'the finding is untouched, not silently dismissed instead');
});

// ---------------------------------------------------------------------------
// (10) lintGate.
// ---------------------------------------------------------------------------

test('lintGate refuses busy-model when a page build, sweep, lookup, or lint pass is already active', () => {
  const db = openDb(':memory:');
  assert.equal(lintGate(db, {}).ok, true);
  assert.equal(lintGate(db, { sweepActive: true }).reason, 'busy-model');
  assert.equal(lintGate(db, { lookupActive: true }).reason, 'busy-model');
  assert.equal(lintGate(db, { pagesBuildingActive: true }).reason, 'busy-model');
  assert.equal(lintGate(db, { lintActive: true }).reason, 'busy-model');
});
