// Lint (step 5½): a scheduled pass that looks for corpus states no other
// pass names -- an accepted claim whose own valid_to has already passed, a
// sweep-accepted sub-role tag that now disagrees with the LinkedIn export
// that produced it, a person a page WOULD be built for who has no page (or
// the reverse: a page that exists for someone who can no longer be anchored
// for a lookup), and a card snapshot whose cited quote row is gone with
// nobody having judged the card. None of these are claims about the world --
// they are claims about THIS DATABASE -- so nothing here is a claim.mjs row,
// nothing here calls a model, and nothing here is auto-fixed: a lint finding
// is surfaced, the owner decides what (if anything) to do about it, exactly
// like every other pending item in this system.
//
// NO MODEL CALL ANYWHERE IN THIS FILE. Every check is SQL, or SQL plus a pure
// JS recomputation (subRolesFor, lookupScope's own anchored flag) -- there is
// no prompt, no engine, no distill_run row, and therefore no cost/battery/
// thermal/quota gate: lintGate's only reason to skip is another model-
// spending pass already running (see its own comment).
//
// NEVER AUTO-FIXED. The only automatic transition a finding ever makes is
// 'gone': the condition that produced it is no longer true, so the row
// closes itself the next time a pass looks and does not see it. Every other
// resolution (dismiss, and the three role_conflict choices) is written by
// resolveLintFinding, on the owner's own click, never by runLintPass.
//
// A finding is a DERIVED INDEX over the corpus, not evidence about it -- so
// it is upserted by key, not appended. See lint_finding's own DDL comment in
// hermes.mjs's SCHEMA for the upsert query and the exact 'gone' semantics
// (not sticky; every other resolution is, until the owner reopens it by hand
// in the desk).

import { subRolesFor } from '../people/subRoles.mjs';
import { markPersonSubRoles } from '../people/owner.mjs';
import { lookupScope } from './lookup.mjs';

// A version tag for this pass, mirroring SWEEP_VERSION/LOOKUP_VERSION's own
// role even though lint has no prompt file to hash: it names the SHAPE of
// what a lint_run row means, so a later change to what a check considers a
// finding has something to bump.
export const LINT_VERSION = 'lint-v1';

// The five check names this file can ever produce -- frozen because
// lint_finding.check_name, /stats.lint's openByCheck, and the desk's grouped
// display all key on these exact strings, and a typo'd sixth name would
// silently split one check's findings into two buckets nothing ever closes.
// C3 and C4 share ONE underlying scan (pageAnchorFindings, over a single
// lookupScope(db) call) but are two distinct checks: a person can be
// anchored-with-no-page and someone else can be paged-with-no-anchors in the
// very same pass, and closing one must never touch the other's rows.
export const LINT_CHECKS = Object.freeze([
  'expired_claim',
  'role_conflict',
  'anchored_no_page',
  'page_no_anchors',
  'orphan_card_quote',
]);

// Per-check cap on how many CANDIDATE rows a single pass examines (the raw
// SQL/scan population, not the count of findings that survive filtering) --
// bounding a pass over a corpus that can hold tens of thousands of accepted
// claims or people. A check that hits this cap sets `truncated` on its own
// result, which runLintPass records on lint_run AND skips that check's own
// auto-close sweep for: a pass that did not look at everything cannot
// conclude that what it didn't see is gone.
export const LINT_MAX_PER_CHECK = 500;

// The lookup tiers (lookupScope's own 'eligible'/'tagged'/'other', see
// lookup.mjs) that count as "would get a page built for them" for C3's own
// purposes. A tagged person without a page is the ordinary case until they
// become eligible -- the card queue and the sweep both build pages for
// eligible people, so "eligible and anchored but no page" is the gap that
// actually matters here; 'tagged' and 'other' are both excluded for the same
// reason, not yet having a page is not a finding.
export const LINT_PAGE_TIERS = Object.freeze(['eligible']);

// The four resolutions an owner may write (never 'gone', which only a pass
// itself may set -- see resolveLintFinding). Kept private to this file;
// hermes.mjs's route validates the same closed set (and the
// role-choices-only-on-role_conflict rule) before ever calling
// resolveLintFinding, the same "route validates shape, module validates and
// applies" split every other admin route in this system uses.
const LINT_RESOLUTIONS = Object.freeze(['dismiss', 'keep-export', 'keep-derived', 'both']);
const ROLE_CHOICE_RESOLUTIONS = new Set(['keep-export', 'keep-derived', 'both']);

// policy carries the same per-process relationship holder every other
// relationship route reads -- see sweep.mjs's/lookup.mjs's identical
// relFlags, duplicated here rather than imported (neither exports it, and
// importing a private helper across files is not a boundary worth crossing
// for four lines).
function relFlags(policy) {
  const holder = policy?.relationshipHolder ?? policy ?? {};
  return holder.__relationship ?? holder;
}

// Maps a raw SQL row (finding_key/person_key/claim_id/detail, exactly the
// column aliases C1 and C5's own queries produce) into the shape
// runLintPass's upsert wants, applying the cap+1-fetch truncation check
// shared by every SQL-only check.
function capRows(rows, cap) {
  const truncated = rows.length > cap;
  const kept = truncated ? rows.slice(0, cap) : rows;
  const findings = kept.map((r) => ({
    findingKey: r.finding_key,
    personKey: r.person_key ?? null,
    claimId: r.claim_id === null || r.claim_id === undefined ? null : Number(r.claim_id),
    detail: r.detail,
  }));
  return { findings, truncated };
}

// C1 expired_claim: an ACCEPTED claim (v_claim_accepted -- a pending claim
// whose valid_to has passed already sits in the ordinary Claims queue, which
// is where it belongs) whose valid_to has already passed. Advisory, per
// claim.valid_to's own comment in hermes.mjs's SCHEMA -- this never deletes,
// rejects or hides the claim, it only surfaces that nobody has looked since
// it expired. person_key is nullable: an owner-subject claim (subject_person_key
// NULL) can expire too, and this check does not exclude it.
export function expiredClaims(db, { now = Date.now(), cap = LINT_MAX_PER_CHECK } = {}) {
  const rows = db.prepare(
    `SELECT 'expired_claim:'||c.id AS finding_key, c.subject_person_key AS person_key, c.id AS claim_id,
            json_object('kind', c.kind, 'validTo', c.valid_to, 'observedAt', c.observed_at) AS detail
     FROM v_claim_accepted c
     WHERE c.valid_to IS NOT NULL AND c.valid_to < ?
     ORDER BY c.valid_to
     LIMIT ?`
  ).all(now, cap + 1);
  return capRows(rows, cap);
}

// C2 role_conflict: an ACCEPTED sweep sub_role proposal (the owner already
// said yes to this tag once) whose person has a LinkedIn export, where
// RECOMPUTING sub-roles straight from that export (subRolesFor, never
// people.sub_roles) disagrees with the accepted tag. people.sub_roles is not
// read here on purpose -- applySweepDecision (sweep.mjs) UNIONS an accepted
// tag into it, so a stale tag that conflicts with a since-updated LinkedIn
// export would otherwise be invisible forever (the union made the two look
// like they always agreed). This check exists precisely to catch that.
//
// The SQL is the candidate scan (bounded at `cap`+1 so truncation is
// detectable); the recomputation and the "does it actually disagree" test
// are JS, over each candidate's own linkedin JSON -- there is no SQL
// equivalent of subRolesFor, and there must not be a second one.
export function roleConflicts(db, { cap = LINT_MAX_PER_CHECK } = {}) {
  const rows = db.prepare(
    `SELECT psp.claim_id AS claim_id, psp.value AS tag, c.subject_person_key AS person_key, p.linkedin AS linkedin
     FROM person_sweep_proposal psp
     JOIN claim c ON c.id = psp.claim_id
     JOIN people p ON p.person_key = c.subject_person_key
     WHERE psp.kind = 'sub_role' AND p.linkedin IS NOT NULL
       AND (SELECT d.action FROM claim_decision d WHERE d.claim_id = psp.claim_id ORDER BY d.id DESC LIMIT 1) = 'accept'
     ORDER BY psp.claim_id
     LIMIT ?`
  ).all(cap + 1);

  const truncated = rows.length > cap;
  const kept = truncated ? rows.slice(0, cap) : rows;
  const findings = [];
  for (const row of kept) {
    let linkedin;
    try {
      linkedin = JSON.parse(row.linkedin);
    } catch {
      continue; // unparseable linkedin JSON: nothing to recompute against
    }
    const exportRoles = subRolesFor({ linkedin }, {});
    if (exportRoles.length > 0 && !exportRoles.includes(row.tag)) {
      findings.push({
        findingKey: `role_conflict:${row.claim_id}`,
        personKey: row.person_key,
        claimId: Number(row.claim_id),
        detail: JSON.stringify({
          tag: row.tag,
          exportRoles,
          exportTitle: linkedin?.position ?? null,
          exportCompany: linkedin?.company ?? null,
        }),
      });
    }
  }
  return { findings, truncated };
}

// C3 anchored_no_page / C4 page_no_anchors: ONE lookupScope(db) call --
// its `anchored` flag is the single definition of anchoredness this check
// (or anything else in this system) uses, never a second derivation.
//
// pageKeys: every person with a person_page_item row (a built page section)
// whose claim has not been rejected -- pending and accepted both count as
// "has a page", same "latest decision wins, absence is pending" rule
// readPersonPage and alreadyStored already use.
//
// C3 fires for someone anchored (a lookup could actually run for them) in a
// tier worth building a page for (LINT_PAGE_TIERS) who has no page at all --
// the page-build backlog a person page's own eligibility rules do not
// surface anywhere else. C4 is the mirror: someone who already HAS a page
// but can no longer be anchored (their firm/handle/profile URL evaporated,
// or was never real) -- a page that public lookup can never refresh again.
export function pageAnchorFindings(db, { now = Date.now(), cap = LINT_MAX_PER_CHECK } = {}) {
  const scope = lookupScope(db, { now });
  const pageRows = db.prepare(
    `SELECT DISTINCT c.subject_person_key AS person_key
     FROM person_page_item ppi
     JOIN claim c ON c.id = ppi.claim_id
     WHERE c.subject = 'person'
       AND COALESCE(
         (SELECT d.action FROM claim_decision d WHERE d.claim_id = c.id ORDER BY d.id DESC LIMIT 1),
         'pending'
       ) <> 'reject'`
  ).all();
  const pageKeys = new Set(pageRows.map((r) => r.person_key));

  const anchoredNoPage = [];
  const pageNoAnchors = [];
  for (const c of scope) {
    if (c.anchored && LINT_PAGE_TIERS.includes(c.tier) && !pageKeys.has(c.personKey)) {
      anchoredNoPage.push({
        findingKey: `anchored_no_page:${c.personKey}`,
        personKey: c.personKey,
        claimId: null,
        detail: JSON.stringify({ tier: c.tier }),
      });
    }
    if (pageKeys.has(c.personKey) && !c.anchored) {
      pageNoAnchors.push({
        findingKey: `page_no_anchors:${c.personKey}`,
        personKey: c.personKey,
        claimId: null,
        detail: JSON.stringify({ tier: c.tier }),
      });
    }
  }

  const anchoredTruncated = anchoredNoPage.length > cap;
  const pageTruncated = pageNoAnchors.length > cap;
  return {
    anchored_no_page: {
      findings: anchoredTruncated ? anchoredNoPage.slice(0, cap) : anchoredNoPage,
      truncated: anchoredTruncated,
    },
    page_no_anchors: {
      findings: pageTruncated ? pageNoAnchors.slice(0, cap) : pageNoAnchors,
      truncated: pageTruncated,
    },
  };
}

// C5 orphan_card_quote: a candidate snapshot whose evidence cites a quote
// context row (quote_context_id) that is now gone (deleted, or its source
// retained/purged out), where nobody has ever judged the card (no accepted
// or dismissed rm_card_event for this snapshot). rm_candidate_snapshot has
// no-update/no-delete triggers -- a snapshot is immutable by design -- so
// this finding can ONLY ever be closed by an owner dismiss; it is never
// 'gone' on its own, because the condition it names (the quote is missing)
// cannot un-happen. A snapshot the owner already judged is excluded on
// purpose: the judged card's own verdict is the outcome that matters, not
// whether its quote later disappeared.
export function orphanCardQuotes(db, { cap = LINT_MAX_PER_CHECK } = {}) {
  const rows = db.prepare(
    `SELECT 'orphan_card_quote:'||s.id AS finding_key, NULL AS person_key, NULL AS claim_id,
            json_object('snapshotId', s.id, 'batchId', s.batch_id, 'kind', s.kind,
                        'quoteContextId', json_extract(s.evidence, '$.quote_context_id')) AS detail
     FROM rm_candidate_snapshot s
     WHERE json_extract(s.evidence, '$.quote_context_id') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM context ctx WHERE ctx.id = json_extract(s.evidence, '$.quote_context_id'))
       AND NOT EXISTS (
         SELECT 1 FROM rm_card_event e WHERE e.snapshot_id = s.id AND e.event IN ('accepted', 'dismissed')
       )
     ORDER BY s.id
     LIMIT ?`
  ).all(cap + 1);
  return capRows(rows, cap);
}

// Skip order: the ONLY reason a lint pass ever skips is another model-
// spending pass already running (a page build, a sweep, a lookup, or lint
// itself, re-entrantly). No battery/thermal/quota check -- there is no model
// call and no cost to ration -- and no empty-scope check either: lint always
// has something to ask (even an empty corpus answers "no findings" from
// every check), so there is no 'no-scope' skip reason the way sweep/lookup
// have one.
export function lintGate(db, policy) {
  void db;
  const rel = relFlags(policy);
  if (rel?.pagesBuildingActive || rel?.sweepActive || rel?.lookupActive || rel?.lintActive) {
    return { ok: false, reason: 'busy-model' };
  }
  return { ok: true, reason: null };
}

function insertSkippedLintRun(db, { now, checksRun, reason }) {
  const id = Number(
    db.prepare(
      `INSERT INTO lint_run(started_at, ended_at, checks_run, counts, findings_open, findings_new, findings_closed,
         skip_reason, status)
       VALUES (?, ?, ?, '{}', 0, 0, 0, ?, 'skipped')`
    ).run(now, now, JSON.stringify(checksRun), reason).lastInsertRowid
  );
  return db.prepare('SELECT * FROM lint_run WHERE id = ?').get(id);
}

// One pass: gate -> run every requested check -> upsert every finding it saw
// (last_seen_at = this pass's start) -> per check that ran AND was not
// truncated, close ('gone') every OTHER open finding of that check whose
// last_seen_at is still behind this pass (it was not seen -- the condition
// that produced it is no longer true) -> one lint_run row.
//
// `checks`, when given, narrows which of LINT_CHECKS run this pass (an
// unrecognized name is silently dropped, same "the route validates, this
// assumes" split as onlyPersonKey in lookup.mjs); omitted, every check runs.
// C3 and C4 still cost only ONE lookupScope(db) call between them even when
// both are requested, via pageAnchorFindings's own single-scan shape.
//
// rel.lintActive is owned by THIS pass, set only now that lintGate's own
// busy-model read of the same flag has already passed -- identical reasoning
// to rel.sweepActive/rel.lookupActive in sweep.mjs/lookup.mjs. Cleared in the
// finally below no matter how the pass ends.
export function runLintPass(db, policy, { now = Date.now(), checks } = {}) {
  const checksRun = Array.isArray(checks) && checks.length > 0
    ? checks.filter((c) => LINT_CHECKS.includes(c))
    : LINT_CHECKS.slice();

  const gate = lintGate(db, policy);
  if (!gate.ok) {
    return insertSkippedLintRun(db, { now, checksRun, reason: gate.reason });
  }

  const rel = relFlags(policy);
  rel.lintActive = true;
  try {
    const startedAt = now;
    const perCheck = {};
    let anchorResult = null;
    for (const name of checksRun) {
      if (name === 'expired_claim') {
        perCheck[name] = expiredClaims(db, { now, cap: LINT_MAX_PER_CHECK });
      } else if (name === 'role_conflict') {
        perCheck[name] = roleConflicts(db, { cap: LINT_MAX_PER_CHECK });
      } else if (name === 'anchored_no_page' || name === 'page_no_anchors') {
        if (!anchorResult) anchorResult = pageAnchorFindings(db, { now, cap: LINT_MAX_PER_CHECK });
        perCheck[name] = anchorResult[name];
      } else if (name === 'orphan_card_quote') {
        perCheck[name] = orphanCardQuotes(db, { cap: LINT_MAX_PER_CHECK });
      }
    }

    // Upsert-by-key, not append: a finding is a derived index over the
    // corpus, not evidence about it (see this file's own header and
    // lint_finding's DDL comment). ON CONFLICT reopens a 'gone' row the
    // condition returned for, but a row an owner already resolved (dismiss,
    // or a role_conflict choice) is untouched -- the CASE only fires when
    // the CURRENT resolution is exactly 'gone'.
    const upsert = db.prepare(
      `INSERT INTO lint_finding(finding_key, check_name, person_key, claim_id, detail, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(finding_key) DO UPDATE SET
         detail = excluded.detail,
         last_seen_at = excluded.last_seen_at,
         resolved_at = CASE WHEN lint_finding.resolution = 'gone' THEN NULL ELSE lint_finding.resolved_at END,
         resolution = CASE WHEN lint_finding.resolution = 'gone' THEN NULL ELSE lint_finding.resolution END`
    );
    const existingStmt = db.prepare('SELECT 1 AS ok FROM lint_finding WHERE finding_key = ?');
    const closeStmt = db.prepare(
      `UPDATE lint_finding SET resolved_at = ?, resolution = 'gone'
       WHERE check_name = ? AND resolved_at IS NULL AND last_seen_at < ?`
    );

    const counts = {};
    let findingsNew = 0;
    let findingsClosed = 0;

    db.exec('BEGIN');
    try {
      for (const name of checksRun) {
        const result = perCheck[name];
        let newCount = 0;
        for (const f of result.findings) {
          if (existingStmt.get(f.findingKey) === undefined) newCount += 1;
          upsert.run(f.findingKey, name, f.personKey ?? null, f.claimId ?? null, f.detail, startedAt, startedAt);
        }
        // A truncated check skips its own auto-close sweep: it did not look
        // at everything, so it cannot conclude that an unseen row is gone.
        const closedCount = result.truncated ? 0 : Number(closeStmt.run(startedAt, name, startedAt).changes);
        findingsNew += newCount;
        findingsClosed += closedCount;
        counts[name] = { found: result.findings.length, new: newCount, closed: closedCount, truncated: result.truncated };
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const findingsOpen = Number(
      db.prepare('SELECT COUNT(*) AS n FROM lint_finding WHERE resolved_at IS NULL').get().n
    );

    const id = Number(
      db.prepare(
        `INSERT INTO lint_run(started_at, ended_at, checks_run, counts, findings_open, findings_new, findings_closed,
           skip_reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'complete')`
      ).run(
        startedAt, Date.now(), JSON.stringify(checksRun), JSON.stringify(counts),
        findingsOpen, findingsNew, findingsClosed
      ).lastInsertRowid
    );
    return db.prepare('SELECT * FROM lint_run WHERE id = ?').get(id);
  } finally {
    rel.lintActive = false;
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// The desk's findings list: `check` narrows to one check_name, `open` (a
// tri-state: true/false/omitted) narrows to unresolved/resolved/either,
// `limit` bounds the read. Newest-seen-within-its-check first.
export function lintFindings(db, { check = null, open = null, limit = 200 } = {}) {
  const clauses = [];
  const params = [];
  if (typeof check === 'string' && check.length > 0) {
    clauses.push('check_name = ?');
    params.push(check);
  }
  if (open === true) clauses.push('resolved_at IS NULL');
  else if (open === false) clauses.push('resolved_at IS NOT NULL');
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const lim = Number.isInteger(limit) && limit > 0 ? limit : 200;

  const rows = db.prepare(
    `SELECT finding_key AS findingKey, check_name AS checkName, person_key AS personKey, claim_id AS claimId,
            detail, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, resolved_at AS resolvedAt, resolution
     FROM lint_finding ${where}
     ORDER BY check_name, last_seen_at DESC
     LIMIT ?`
  ).all(...params, lim);

  return rows.map((r) => ({ ...r, detail: safeParseJson(r.detail) }));
}

// The owner's resolution for one finding: 'dismiss' works on any check;
// 'keep-export'/'keep-derived'/'both' are role_conflict's own three choices
// (see this file's header and the design's own comment on why each writes
// what it writes) and are refused (a no-op, applied:false) on any other
// check_name -- the route already refuses the request with a 400 before
// this is ever called for that case, but this stays defensive since it is
// also called directly (tests, and any future caller).
//
// Owner resolution written ONCE (WHERE resolved_at IS NULL): a finding
// already resolved -- by an earlier owner click, OR by a pass's own 'gone'
// that a later pass has not yet reopened -- is left alone. Re-resolving a
// 'gone' row would be silently overriding a state the owner never chose;
// the correct path for that is to wait for the pass that reopens it, or (the
// desk does not offer this) delete the row entirely, which nothing here does.
//
// role_conflict resolutions all call markPersonSubRoles, which REPLACES
// people.sub_roles wholesale -- so each branch below passes the FULL
// intended list, never a delta -- and all three therefore set rebuildNeeded:
// true. people.linkedin is never written by any of them: the export itself
// is not being corrected, only which of its derived roles/its accepted tag
// wins is being decided.
//
// DEVIATION: keep-export's "retract the sweep claim" is written directly as
// a claim_decision row here rather than by calling hermes.mjs's own
// decideClaim -- decideClaim is exported from the very file that will import
// this one (hermes.mjs), and importing it back would be the same circular
// import applySweepDecision's own comment (sweep.mjs) already ruled out for
// rebuildPeopleCore. The insert below is decideClaim's own insert, verbatim
// (action='retract', actor='owner'): the two can never drift because there
// is nothing decideClaim does beyond this one INSERT that a retract needs.
export function resolveLintFinding(db, { findingKey, resolution, configPath } = {}) {
  if (typeof findingKey !== 'string' || findingKey.length === 0) {
    return { applied: false, findingKey: findingKey ?? null, resolution: resolution ?? null, rebuildNeeded: false };
  }
  if (!LINT_RESOLUTIONS.includes(resolution)) {
    return { applied: false, findingKey, resolution: resolution ?? null, rebuildNeeded: false };
  }

  const row = db.prepare(
    'SELECT check_name AS checkName, person_key AS personKey, claim_id AS claimId, detail, resolved_at AS resolvedAt ' +
      'FROM lint_finding WHERE finding_key = ?'
  ).get(findingKey);
  if (!row) return { applied: false, findingKey, resolution, rebuildNeeded: false };
  if (row.resolvedAt !== null && row.resolvedAt !== undefined) {
    return { applied: false, findingKey, resolution, rebuildNeeded: false };
  }

  const isRoleChoice = ROLE_CHOICE_RESOLUTIONS.has(resolution);
  if (isRoleChoice && row.checkName !== 'role_conflict') {
    return { applied: false, findingKey, resolution, rebuildNeeded: false };
  }

  let rebuildNeeded = false;
  if (isRoleChoice) {
    const detail = safeParseJson(row.detail);
    const tag = detail.tag;
    const exportRoles = Array.isArray(detail.exportRoles) ? detail.exportRoles : [];

    let subRoles;
    if (resolution === 'keep-export') {
      subRoles = exportRoles;
    } else if (resolution === 'keep-derived') {
      subRoles = [tag];
    } else {
      subRoles = [...new Set([...exportRoles, tag])].sort();
    }
    markPersonSubRoles({ key: row.personKey, subRoles, ...(configPath ? { configPath } : {}) });
    rebuildNeeded = true;

    if (resolution === 'keep-export' && Number.isInteger(row.claimId)) {
      db.prepare(
        'INSERT INTO claim_decision(claim_id, action, actor, reason, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        row.claimId, 'retract', 'owner',
        'lint: role_conflict resolved keep-export (the LinkedIn export overrides an accepted sweep tag)',
        Date.now()
      );
    }
  }

  db.prepare(
    'UPDATE lint_finding SET resolved_at = ?, resolution = ? WHERE finding_key = ? AND resolved_at IS NULL'
  ).run(Date.now(), resolution, findingKey);

  return { applied: true, findingKey, resolution, rebuildNeeded };
}

// For /stats' `lint` key (hermes.mjs) and the desk's status line. Every
// number here is a plain aggregate over lint_run/lint_finding -- NO
// lookupScope call (unlike pageAnchorFindings, which a real pass needs):
// lookupScope is a full-corpus scan, and /stats is read on every poll, so
// paying its cost here would make checking status as expensive as running
// C3/C4 themselves.
export function lintStatus(db) {
  const lastRun = db.prepare('SELECT * FROM lint_run ORDER BY id DESC LIMIT 1').get();

  const openRows = db.prepare(
    'SELECT check_name AS checkName, COUNT(*) AS n FROM lint_finding WHERE resolved_at IS NULL GROUP BY check_name'
  ).all();
  const openByCheck = {};
  let open = 0;
  for (const r of openRows) {
    openByCheck[r.checkName] = Number(r.n);
    open += Number(r.n);
  }

  const dismissed = Number(
    db.prepare(
      "SELECT COUNT(*) AS n FROM lint_finding WHERE resolved_at IS NOT NULL AND resolution <> 'gone'"
    ).get().n
  );

  const counts = lastRun ? safeParseJson(lastRun.counts) : {};
  const parsedChecksRun = lastRun ? safeParseJson(lastRun.checks_run) : [];
  const checksRun = Array.isArray(parsedChecksRun) ? parsedChecksRun : [];
  const truncated = checksRun.filter((name) => counts?.[name]?.truncated === true);

  return {
    lastPassAt: lastRun?.started_at ?? null,
    lastPassStatus: lastRun?.status ?? null,
    lastSkipReason: lastRun?.skip_reason ?? null,
    open,
    openByCheck,
    dismissed,
    newLastPass: Number(lastRun?.findings_new ?? 0),
    closedLastPass: Number(lastRun?.findings_closed ?? 0),
    truncated,
    checks: checksRun,
  };
}
