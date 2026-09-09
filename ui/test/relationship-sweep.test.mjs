// Discovery sweep (L5 step 5, relationship/sweep.mjs): tests follow the same
// shape relationship-pages.test.mjs uses -- pure grounding first (no DB, no
// model), then openDb on a mkdtempSync path, then routes via start() with a
// policy.relationshipMemoryEngine fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start, openDb } from '../server/hermes.mjs';
import { eligiblePool } from '../server/relationship/producer.mjs';
import { ownerConfigPath, markPersonSubRoles } from '../server/people/owner.mjs';
import {
  groundSweep, newRowsFor, sweepScope, storeSweep, sweepGate, runSweepPass, applySweepDecision,
  sweepCallCap, sweepStatus, SWEEP_DAILY_CALL_CAP_DEFAULT,
  SWEEP_MAX_CHARS, SWEEP_MAX_EPISODES, SWEEP_MIN_ROW_CHARS, tokensEstFor,
} from '../server/relationship/sweep.mjs';

// A context row from a non-message source (e.g. an imported LinkedIn
// connection, linked authored=1 room=0 the way people/graph.mjs's
// PERSON_SOURCE_POLICY treats it as a 'participant' identity signal), which
// buildEpisodes (memory/episodes.mjs) can never turn into a quotable
// excerpt -- exactly the row shape that used to make a person a permanent,
// zero-call sweep candidate (audit, 2026-09).
function insertLinkedinAuthoredRow(db, personKey, { ts }) {
  const id = Number(
    db
      .prepare("INSERT INTO context(ts, source, text, meta) VALUES (?, 'linkedin', ?, ?)")
      .run(ts, 'Imported LinkedIn connection', JSON.stringify({})).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'linkedin', 'counterparty', 1, 0, 0, 1, ?)`
  ).run(personKey, id, `linkedin:${personKey}`);
  return id;
}

const NOW = Date.parse('2026-09-01T12:00:00Z');
const DAY = 86_400_000;
const day = (offsetDays) => new Date(NOW - offsetDays * DAY).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// (1-5) GROUNDING: pure, no DB, no model. Mirrors relationship-pages.test.mjs's
// fakeGathered exactly -- findQuoteContextId only ever resolves a THEM line.
// ---------------------------------------------------------------------------

function fakeGathered(themLines, meLines = []) {
  const excerpts = [
    ...themLines.map((text, i) => ({ contextId: 100 + i, speaker: 'THEM', text })),
    ...meLines.map((text, i) => ({ contextId: 200 + i, speaker: 'ME', text })),
  ];
  return {
    excerpts,
    meetingTitles: [],
    findQuoteContextId(quote) {
      if (typeof quote !== 'string' || quote.length === 0) return null;
      for (const e of excerpts) {
        if (e.speaker === 'THEM' && e.text.includes(quote)) return e.contextId;
      }
      return null;
    },
  };
}

test('groundSweep keeps a tag whose evidence quote is a verbatim THEM substring', () => {
  const gathered = fakeGathered(['I am raising a fund right now, closing next month']);
  const proposal = { tags: [{ tag: 'investor', text: 'They are raising a fund.', quote: 'raising a fund' }], firm: null, page_lines: [] };
  const { kept, dropped } = groundSweep(proposal, gathered);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
  assert.equal(kept[0].kind, 'sub_role');
  assert.equal(kept[0].value, 'investor');
  assert.equal(kept[0].contextId, 100);
});

test('groundSweep drops a tag outside the closed sub-role set', () => {
  const gathered = fakeGathered(['I am a wealth advisor these days']);
  const proposal = { tags: [{ tag: 'advisor', text: 'They are an advisor.', quote: 'wealth advisor' }], firm: null, page_lines: [] };
  const { kept, dropped } = groundSweep(proposal, gathered);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /closed sub-role set/);
});

test("groundSweep drops a firm whose name is not inside its own quote", () => {
  const gathered = fakeGathered(['I lead investing at the firm now']);
  const proposal = { tags: [], firm: { name: 'Example Capital', text: 'They work at Example Capital.', quote: 'lead investing at the firm now' }, page_lines: [] };
  const { kept, dropped } = groundSweep(proposal, gathered);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].kind, 'firm');
  assert.match(dropped[0].reason, /verbatim substring of its own quote/);
});

test('groundSweep drops an item quoting an ME line, even verbatim', () => {
  const gathered = fakeGathered(['sounds good'], ['sure I will introduce you to the fund next week']);
  const proposal = {
    tags: [], firm: null,
    page_lines: [{ section: 'how_left', text: 'The owner offered an introduction.', quote: 'sure I will introduce you to the fund next week' }],
  };
  const { kept, dropped } = groundSweep(proposal, gathered);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].kind, 'page_line');
  // MUTATION CHECK: with the ME excerpt relabeled 'THEM' in this fixture,
  // this assertion flips to kept.length === 1 -- confirmed by hand by
  // relabeling the fixture above and re-running before restoring it.
});

test('groundSweep caps tags at 2 and page_lines at 3', () => {
  const gathered = fakeGathered(['a', 'b', 'c', 'd', 'e']);
  const proposal = {
    tags: [
      { tag: 'investor', text: '1', quote: 'a' },
      { tag: 'founder', text: '2', quote: 'b' },
      { tag: 'operator', text: '3', quote: 'c' },
    ],
    firm: null,
    page_lines: [
      { section: 'who', text: '1', quote: 'a' },
      { section: 'ask', text: '2', quote: 'b' },
      { section: 'objection', text: '3', quote: 'c' },
      { section: 'how_left', text: '4', quote: 'd' },
    ],
  };
  const { kept } = groundSweep(proposal, gathered);
  assert.equal(kept.filter((k) => k.kind === 'sub_role').length, 2);
  assert.equal(kept.filter((k) => k.kind === 'page_line').length, 3);
});

// ---------------------------------------------------------------------------
// (6-7) newRowsFor: DB fixtures.
// ---------------------------------------------------------------------------

function insertPerson(db, { key, name, role = 'business', subRoles = [], sent = 10, received = 10, met = 0 }) {
  db.prepare(
    `INSERT INTO people(person_key, display_name, first_seen, last_seen, last_from_them, last_from_owner,
       sent, received, met_in_person, room_messages, direct_messages, meeting_notes, role, roles_by_year,
       linkedin, built_at, sub_roles)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(key, name, NOW - 400 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY,
    sent, received, met, 0, sent + received, 0, role, '{}', null, NOW, JSON.stringify(subRoles));
}

function insertActiveDay(db, key, activeDay) {
  db.prepare('INSERT OR IGNORE INTO person_active_days(person_key, day) VALUES (?, ?)').run(key, activeDay);
}

function insertThread(db, personKey, { chatGuid = `chat:${personKey}`, ts, them, me }) {
  const themId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(ts, them, JSON.stringify({ chat_guid: chatGuid, is_from_me: false })).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, ?)`
  ).run(personKey, themId, chatGuid);

  const meId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(ts + 60_000, me, JSON.stringify({ chat_guid: chatGuid, is_from_me: true })).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 0, 1, 0, 1, ?)`
  ).run(personKey, meId, chatGuid);

  return { themId, meId };
}

// Seeds one person with more new history than a single SWEEP_MAX_CHARS
// budget: three long-message filler episodes (together well over budget on
// their own), then a newest episode where the owner speaks FIRST and the
// person's newest authored row follows -- so that row (not a later ME
// reply) is the highest context id in the table, matching the person's true
// newest authored row. Shared by the budget-overflow newRowsFor test and the
// budget-truncated-then-second-pass runSweepPass test below.
function seedBudgetOverflowPerson(db, key, name) {
  insertPerson(db, { key, name });
  for (let i = 0; i < 3; i++) {
    insertThread(db, key, {
      chatGuid: `chat:filler${i}`,
      ts: NOW - (6 - i * 2) * DAY,
      them: `filler message ${i} `.padEnd(2500, 'x'),
      me: 'ok',
    });
  }

  const chatGuid = 'chat:final';
  db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(NOW - 1 * DAY, 'checking in', JSON.stringify({ chat_guid: chatGuid, is_from_me: true }));
  const meId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 0, 1, 0, 1, ?)`
  ).run(key, meId, chatGuid);
  const themId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(NOW - 1 * DAY + 60_000, 'all set, thanks', JSON.stringify({ chat_guid: chatGuid, is_from_me: false })).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, ?)`
  ).run(key, themId, chatGuid);

  const maxAuthored = Number(
    db.prepare(
      `SELECT MAX(context_id) AS maxId FROM person_event_links WHERE person_key = ? AND authored = 1 AND room = 0`
    ).get(key).maxId
  );
  return { themId, maxAuthored };
}

test('a person whose new rows exceed the char budget still advances the cursor to their newest authored row', () => {
  const db = openDb(':memory:');
  const key = 'name:budget overflow';
  const { themId, maxAuthored } = seedBudgetOverflowPerson(db, key, 'Budget Overflow');
  assert.equal(maxAuthored, themId, 'sanity: the final episode holds the true newest authored row');

  const gathered = newRowsFor(db, key, 0);
  assert.equal(gathered.maxContextId, maxAuthored, 'maxContextId reaches the newest authored row despite budget overflow');
  const contextIds = gathered.excerpts.map((e) => e.contextId);
  assert.ok(contextIds.includes(themId), 'the newest authored row is included, not starved out by an older, longer episode');
});

test('newRowsFor returns only episodes containing an authored row past the cursor', () => {
  const db = openDb(':memory:');
  const key = 'name:old and new';
  insertPerson(db, { key, name: 'Old And New' });
  // Old episode, well before the cursor -- one hour, own chat_guid so it is
  // its own episode under the 60-minute gap rule.
  const old = insertThread(db, key, { chatGuid: 'chat:old', ts: NOW - 10 * DAY, them: 'old message', me: 'ok' });
  // New episode, after the cursor.
  const fresh = insertThread(db, key, { chatGuid: 'chat:new', ts: NOW - 1 * DAY, them: 'new message', me: 'got it' });

  const gathered = newRowsFor(db, key, old.themId);
  const contextIds = gathered.excerpts.map((e) => e.contextId);
  assert.ok(contextIds.includes(fresh.themId), 'the new episode is included');
  assert.ok(!contextIds.includes(old.themId), 'the old, already-swept episode is excluded');
  assert.equal(gathered.episodeCount, 1);
  // ~~"maxContextId is the max over every row actually SHOWN, including the
  // owner's own ME reply -- never just the THEM row."~~ CHANGED 2026-09, and
  // this assertion was the old contract written down. Letting a ME row move
  // the cursor is what allowed an owner reply to carry the cursor past the
  // person's own unshown lines (see the ME-eats-the-budget test below).
  // maxContextId is now the max over SHOWN **THEM** ROWS ONLY: the cursor
  // records what the person said that a model has actually been given, and
  // the owner's own replies are tone, not evidence to mark as read on the
  // person's behalf.
  assert.equal(gathered.maxContextId, fresh.themId);
  assert.ok(fresh.meId > fresh.themId, 'sanity: the ME reply really is the newer row here');
});

test('newRowsFor takes at most 8 episodes, most recent first, under the char budget', () => {
  const db = openDb(':memory:');
  const key = 'name:many episodes';
  insertPerson(db, { key, name: 'Many Episodes' });
  // 10 separate episodes (distinct chat_guids), each two days apart, all
  // after the cursor (0) so every one of them qualifies as "new".
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const { themId } = insertThread(db, key, {
      chatGuid: `chat:${i}`, ts: NOW - (10 - i) * 2 * DAY,
      them: `message number ${i}`, me: 'ok',
    });
    ids.push(themId);
  }

  const gathered = newRowsFor(db, key, 0);
  assert.ok(gathered.episodeCount <= SWEEP_MAX_EPISODES, 'never more than SWEEP_MAX_EPISODES episodes');
  assert.equal(gathered.episodeCount, SWEEP_MAX_EPISODES);
  // The two OLDEST episodes (index 0 and 1) were dropped in favor of the 8
  // most recent.
  const contextIds = new Set(gathered.excerpts.map((e) => e.contextId));
  assert.ok(!contextIds.has(ids[0]));
  assert.ok(!contextIds.has(ids[1]));
  assert.ok(contextIds.has(ids[9]));

  const totalChars = gathered.excerpts.reduce((n, e) => n + e.text.length, 0);
  assert.ok(totalChars <= SWEEP_MAX_CHARS, 'stays under the char budget');
  assert.ok(tokensEstFor('x'.repeat(totalChars)) <= 2000, 'tokensEst stays at or under 2000');
});

// ---------------------------------------------------------------------------
// (8-9) sweepScope: its own SQL, deliberately not eligiblePool.
// ---------------------------------------------------------------------------

test('sweepScope includes an actively-talking business contact that eligiblePool excludes', () => {
  const db = openDb(':memory:');
  const key = 'name:active business contact';
  insertPerson(db, { key, name: 'Active Business Contact', role: 'business', sent: 30, received: 30 });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'talking to you right now', me: 'yep' });
  insertActiveDay(db, key, day(0)); // active TODAY -- nowhere near eligiblePool's 180-day quiet floor

  const pool = eligiblePool(db, { mode: 'any', now: NOW });
  assert.ok(!pool.map((p) => p.personKey).includes(key), 'eligiblePool excludes an actively-talking contact (not quiet)');

  const scope = sweepScope(db, { now: NOW });
  const entry = scope.find((c) => c.personKey === key);
  assert.ok(entry, 'sweepScope includes the same actively-talking business contact');
  assert.equal(entry.cursor, 0, 'a never-swept person starts at cursor 0');
  assert.ok(entry.maxAuthoredContextId > 0);
});

test('sweepScope excludes a suppressed person and an anonymous contact', () => {
  const db = openDb(':memory:');

  const suppressedKey = 'name:suppressed business contact';
  insertPerson(db, { key: suppressedKey, name: 'Suppressed Business Contact', role: 'business', sent: 30, received: 30 });
  insertThread(db, suppressedKey, { ts: NOW - 1 * DAY, them: 'hello', me: 'hi' });
  db.prepare('INSERT INTO rm_suppression(person_key, created_at) VALUES (?, ?)').run(suppressedKey, NOW);

  const anonKey = 'id:anon@example.test';
  insertPerson(db, { key: anonKey, name: 'anon@example.test', role: 'business', sent: 30, received: 30 });
  insertThread(db, anonKey, { ts: NOW - 1 * DAY, them: 'hello', me: 'hi' });

  const scope = sweepScope(db, { now: NOW });
  const keys = scope.map((c) => c.personKey);
  assert.ok(!keys.includes(suppressedKey), 'a suppressed person is excluded');
  assert.ok(!keys.includes(anonKey), 'an anonymous (bare-address) contact is excluded');
});

test('an authored row from a non-message source does not make a person a sweep candidate', async () => {
  const db = openDb(':memory:');
  const key = 'name:linkedin only';
  insertPerson(db, { key, name: 'Linkedin Only', role: 'business', sent: 0, received: 0 });
  // The only row this person ever authored (past the cursor, which starts at
  // 0 for a never-swept person) is a LinkedIn import -- never a message.
  insertLinkedinAuthoredRow(db, key, { ts: NOW - 1 * DAY });

  const scope = sweepScope(db, { now: NOW });
  assert.ok(
    !scope.map((c) => c.personKey).includes(key),
    'sweepScope excludes a person whose only authored row is a non-message source'
  );

  const engine = fakeSweepEngine(() => JSON.stringify({ tags: [], firm: null, page_lines: [] }));
  const pass = await runSweepPass(db, engine, {}, { powerMode: 'trickle', now: NOW });
  assert.equal(engine.counters.calls, 0, 'no engine call is ever made for a linkedin-only authored row');
  assert.equal(pass.status, 'skipped');
  assert.equal(pass.skip_reason, 'no-scope');
});

// ---------------------------------------------------------------------------
// (10, 13) storeSweep: the trusted apply path, re-checked against the LIVE
// row. storeSweep itself does not create the distill_run/person_sweep_run
// rows (conflict #7 -- one distill_run per PASS, written by runSweepPass, a
// later commit) so these tests create them by hand first, exactly as
// runSweepPass will.
// ---------------------------------------------------------------------------

function insertSweepRun(db, { now = NOW } = {}) {
  const distillRunId = Number(db.prepare(
    `INSERT INTO distill_run(model, prompt_path, prompt_sha, params, episode_context, rows_in, claims_out, status, started_at, ended_at)
     VALUES ('fake:fake-model', '/prompts/sweep.md', ?, '{}', 'on', 1, 0, 'running', ?, NULL)`
  ).run('f'.repeat(64), now).lastInsertRowid);
  const sweepRunId = Number(db.prepare(
    `INSERT INTO person_sweep_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
       candidates, swept, model_calls, proposed, dropped, tokens_est, skip_reason, status)
     VALUES (?, ?, NULL, 'trickle', 'fake', 3, 1, 1, 0, 0, 0, 0, 0, NULL, 'running')`
  ).run(distillRunId, now).lastInsertRowid);
  return { distillRunId, sweepRunId };
}

test('storeSweep stores grounded proposals as pending person claims with receipts', () => {
  const db = openDb(':memory:');
  const key = 'name:jane investor';
  insertPerson(db, { key, name: 'Jane Investor', role: 'business', sent: 30, received: 30 });
  const { themId } = insertThread(db, key, {
    ts: NOW - 1 * DAY,
    them: 'I am now raising a fund at Acme Capital, closing next quarter',
    me: 'exciting!',
  });

  const gathered = newRowsFor(db, key, 0);
  const proposal = {
    tags: [{ tag: 'investor', text: 'Jane is raising a fund.', quote: 'raising a fund' }],
    firm: { name: 'Acme Capital', text: 'Jane is at Acme Capital.', quote: 'raising a fund at Acme Capital' },
    page_lines: [{ section: 'who', text: 'Jane is raising a fund at Acme Capital.', quote: 'raising a fund at Acme Capital' }],
  };
  const { kept } = groundSweep(proposal, gathered);
  assert.equal(kept.length, 3);

  const { distillRunId, sweepRunId } = insertSweepRun(db);
  const result = storeSweep(db, {
    personKey: key, engineName: 'fake', model: 'fake-model', kept, sweepRunId, distillRunId, now: NOW,
  });
  assert.equal(result.stored, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.rejected, 0);

  const claims = db.prepare(
    `SELECT c.id, c.subject, c.subject_person_key, c.kind, c.p_claim FROM claim c WHERE c.subject_person_key = ?`
  ).all(key);
  assert.equal(claims.length, 3);
  for (const c of claims) {
    assert.equal(c.subject, 'person');
    assert.equal(c.p_claim, null);
  }

  const sources = db.prepare(
    `SELECT context_id FROM claim_source WHERE claim_id IN (${claims.map(() => '?').join(',')})`
  ).all(...claims.map((c) => c.id));
  for (const s of sources) assert.equal(s.context_id, themId);

  const proposals = db.prepare('SELECT kind, value, applied_at FROM person_sweep_proposal').all();
  assert.equal(proposals.length, 3);
  assert.ok(proposals.every((p) => p.applied_at === null), 'nothing is applied at store time -- the owner decides');
  const byKind = Object.fromEntries(proposals.map((p) => [p.kind, p.value]));
  assert.equal(byKind.sub_role, 'investor');
  assert.equal(byKind.firm, 'Acme Capital');
  assert.equal(byKind.page_line, null);

  const decisions = db.prepare('SELECT COUNT(*) AS n FROM claim_decision').get();
  assert.equal(decisions.n, 0);

  const pageItems = db.prepare('SELECT section FROM person_page_item').all();
  assert.equal(pageItems.length, 1);
  assert.equal(pageItems[0].section, 'who');
});

test('storeSweep rejects a firm whose name vanished from the live row between gather and store', () => {
  const db = openDb(':memory:');
  const key = 'name:vanishing firm';
  insertPerson(db, { key, name: 'Vanishing Firm', role: 'business', sent: 30, received: 30 });
  const { themId } = insertThread(db, key, {
    ts: NOW - 1 * DAY,
    them: 'I lead investing at Acme Capital these days',
    me: 'got it',
  });

  const gathered = newRowsFor(db, key, 0);
  const proposal = {
    tags: [], page_lines: [],
    firm: { name: 'Acme Capital', text: 'They lead investing at Acme Capital.', quote: 'lead investing at Acme Capital' },
  };
  const { kept } = groundSweep(proposal, gathered);
  assert.equal(kept.length, 1);

  // The row is edited between gather and store -- the firm name (and the
  // whole quote) is no longer present in the LIVE row.
  db.prepare('UPDATE context SET text = ? WHERE id = ?').run('redacted', themId);

  const { distillRunId, sweepRunId } = insertSweepRun(db);
  const result = storeSweep(db, {
    personKey: key, engineName: 'fake', model: 'fake-model', kept, sweepRunId, distillRunId, now: NOW,
  });
  assert.equal(result.stored, 0);
  assert.equal(result.rejected, 1);
  const n = db.prepare('SELECT COUNT(*) AS n FROM claim WHERE subject_person_key = ?').get(key);
  assert.equal(n.n, 0);
});

// ---------------------------------------------------------------------------
// (11-12) runSweepPass: the no-new-rows checkpoint, and per-person hold/
// advance on failure vs. a grounded-empty answer.
// ---------------------------------------------------------------------------

function fakeSweepEngine(respond) {
  const engine = {
    name: 'fake', model: 'fake-model', counters: { calls: 0, totalCostUsd: 0, totalDurationMs: 0 },
    async complete(args) {
      engine.counters.calls += 1;
      return respond(args);
    },
  };
  return engine;
}

test('a second runSweepPass makes zero model calls once nothing is new -- THE CHECKPOINT', async () => {
  const db = openDb(':memory:');
  const key = 'name:checkpoint person';
  insertPerson(db, { key, name: 'Checkpoint Person', role: 'business', sent: 10, received: 10 });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'just checking in, nothing new to report', me: 'sounds good' });

  const engine = fakeSweepEngine(() => JSON.stringify({ tags: [], firm: null, page_lines: [] }));

  const first = await runSweepPass(db, engine, {}, { powerMode: 'trickle', now: NOW });
  assert.equal(first.status, 'complete');
  assert.equal(Number(first.model_calls), 1);
  assert.equal(Number(first.swept), 1);
  assert.equal(engine.counters.calls, 1);

  const second = await runSweepPass(db, engine, {}, { powerMode: 'trickle', now: NOW + 1000 });
  assert.equal(second.status, 'skipped');
  assert.equal(second.skip_reason, 'no-new-rows');
  assert.equal(engine.counters.calls, 1, 'no new model call was made on the second pass');
});

test('the second pass after a budget-truncated first pass makes zero model calls', async () => {
  const db = openDb(':memory:');
  const key = 'name:budget overflow sweep';
  const { themId, maxAuthored } = seedBudgetOverflowPerson(db, key, 'Budget Overflow Sweep');
  assert.equal(maxAuthored, themId, 'sanity: the final episode holds the true newest authored row');

  const engine = fakeSweepEngine(() => JSON.stringify({ tags: [], firm: null, page_lines: [] }));

  const first = await runSweepPass(db, engine, {}, { powerMode: 'trickle', now: NOW });
  assert.equal(first.status, 'complete');
  assert.equal(engine.counters.calls, 1);

  const cursor = db.prepare('SELECT * FROM person_sweep_cursor WHERE person_key = ?').get(key);
  assert.equal(Number(cursor.swept_through_context_id), maxAuthored, 'the cursor lands on the newest authored row despite the overflow');

  const second = await runSweepPass(db, engine, {}, { powerMode: 'trickle', now: NOW + 1000 });
  assert.equal(second.status, 'skipped');
  assert.equal(second.skip_reason, 'no-new-rows');
  assert.equal(engine.counters.calls, 1, 'no new model call was made on the second pass -- the budget-truncated first pass still advanced the cursor to the newest authored row');
});

test('an engine error keeps the cursor and a grounded-empty answer advances it', async () => {
  const db = openDb(':memory:');
  const errKey = 'name:error case';
  const okKey = 'name:ok case';
  insertPerson(db, { key: errKey, name: 'Error Case', role: 'business', sent: 10, received: 10 });
  insertThread(db, errKey, { ts: NOW - 1 * DAY, them: 'hello there', me: 'hi' });
  insertPerson(db, { key: okKey, name: 'Ok Case', role: 'business', sent: 10, received: 10 });
  insertThread(db, okKey, { ts: NOW - 1 * DAY, them: 'hello there too', me: 'hi' });

  const engine = fakeSweepEngine(({ user }) => {
    if (user.includes('Person: Error Case')) throw new Error('synthetic engine failure');
    return JSON.stringify({ tags: [], firm: null, page_lines: [] });
  });

  await runSweepPass(db, engine, {}, { powerMode: 'trickle', budget: 2, now: NOW });

  const errCursor = db.prepare('SELECT * FROM person_sweep_cursor WHERE person_key = ?').get(errKey);
  assert.equal(errCursor.last_status, 'engine-error');
  assert.equal(Number(errCursor.swept_through_context_id), 0, 'the cursor is held, not advanced, on an engine error');

  const okCursor = db.prepare('SELECT * FROM person_sweep_cursor WHERE person_key = ?').get(okKey);
  assert.equal(okCursor.last_status, 'empty');
  assert.ok(Number(okCursor.swept_through_context_id) > 0, 'a grounded-empty answer still advances the cursor');
});

test('a person with nothing showable is advanced past all their rows and not re-selected', async () => {
  const db = openDb(':memory:');
  const key = 'name:nothing showable';
  insertPerson(db, { key, name: 'Nothing Showable', role: 'business', sent: 0, received: 0 });
  // A message-source (imessage) authored row with NO owner reply anywhere in
  // its thread -- buildEpisodes' makeEpisode requires at least one quotable
  // (owner) row before it will yield an episode at all (memory/episodes.mjs),
  // so this row is a genuine sweep candidate (it clears the SWEEP_SOURCES
  // gate) that newRowsFor still comes back with zero excerpts for -- the
  // belt path in sweepPerson, not the SWEEP_SOURCES gate.
  const themId = Number(
    db
      .prepare("INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)")
      .run(NOW - 1 * DAY, 'a lone message with no owner reply', JSON.stringify({ chat_guid: 'chat:lonely', is_from_me: false }))
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, 'chat:lonely')`
  ).run(key, themId);

  const engine = fakeSweepEngine(() => JSON.stringify({ tags: [], firm: null, page_lines: [] }));

  const first = await runSweepPass(db, engine, {}, { powerMode: 'trickle', now: NOW });
  assert.equal(first.status, 'complete');
  assert.equal(engine.counters.calls, 0, 'nothing showable means no engine call at all');

  const cursor = db.prepare('SELECT * FROM person_sweep_cursor WHERE person_key = ?').get(key);
  assert.equal(cursor.last_status, 'empty');
  assert.equal(Number(cursor.swept_through_context_id), themId, 'the cursor advances past the unshowable row, over all sources');

  const second = await runSweepPass(db, engine, {}, { powerMode: 'trickle', now: NOW + 1000 });
  assert.equal(second.status, 'skipped');
  assert.equal(second.skip_reason, 'no-new-rows');
  assert.equal(engine.counters.calls, 0, 'a second pass makes zero calls -- the person is not re-selected');
});

// ---------------------------------------------------------------------------
// (14-16) sweepGate.
// ---------------------------------------------------------------------------

test('sweepGate skips on battery under 40% while off AC, not while on AC', () => {
  const db = openDb(':memory:');
  const key = 'name:battery test';
  insertPerson(db, { key, name: 'Battery Test', role: 'business', sent: 10, received: 10 });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'hello', me: 'hi' });

  const offAc = sweepGate(db, {}, { onAc: false, battery: 20, engine: 'fake' });
  assert.equal(offAc.ok, false);
  assert.equal(offAc.reason, 'battery');

  const onAc = sweepGate(db, {}, { onAc: true, battery: 20, engine: 'fake' });
  assert.equal(onAc.ok, true, 'battery is never a reason to skip while on AC power');
});

test('sweepGate skips when a page build is running', () => {
  const db = openDb(':memory:');
  const key = 'name:busy test';
  insertPerson(db, { key, name: 'Busy Test', role: 'business', sent: 10, received: 10 });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'hello', me: 'hi' });

  const gate = sweepGate(db, { pagesBuildingActive: true }, { engine: 'fake' });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'busy-model');
});

test('sweepGate skips at 90% of the daily call cap, never for llama', () => {
  const db = openDb(':memory:');
  const key = 'name:quota test';
  insertPerson(db, { key, name: 'Quota Test', role: 'business', sent: 10, received: 10 });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'hello', me: 'hi' });

  const cap = 200;
  const used = Math.ceil(cap * 0.9);
  db.prepare(
    `INSERT INTO person_sweep_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
       candidates, swept, model_calls, proposed, dropped, tokens_est, skip_reason, status)
     VALUES (NULL, ?, ?, 'trickle', 'fake', 3, 1, 1, 1, ?, 0, 0, 0, NULL, 'complete')`
  ).run(Date.now(), Date.now(), used);

  const claude = sweepGate(db, {}, { engine: 'claude-cli' });
  assert.equal(claude.ok, false);
  assert.equal(claude.reason, 'quota');

  const llama = sweepGate(db, {}, { engine: 'llama' });
  assert.equal(llama.ok, true, 'llama is exempt from the local call cap');
});

// ---------------------------------------------------------------------------
// (17-19) applySweepDecision.
// ---------------------------------------------------------------------------

function storedProposalClaimId(db, personKey, kind) {
  const row = db.prepare(
    `SELECT psp.claim_id AS claimId FROM person_sweep_proposal psp
     JOIN claim c ON c.id = psp.claim_id
     WHERE c.subject_person_key = ? AND psp.kind = ?`
  ).get(personKey, kind);
  return row.claimId;
}

test('accepting a sub_role proposal unions the tag via markPersonSubRoles; a second accept is a no-op', () => {
  const db = openDb(':memory:');
  const key = 'name:union test';
  insertPerson(db, { key, name: 'Union Test', role: 'business', subRoles: ['founder'] });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'I am raising a fund now', me: 'nice' });

  const gathered = newRowsFor(db, key, 0);
  const proposal = { tags: [{ tag: 'investor', text: 'raising a fund', quote: 'raising a fund' }], firm: null, page_lines: [] };
  const { kept } = groundSweep(proposal, gathered);
  const { distillRunId, sweepRunId } = insertSweepRun(db);
  storeSweep(db, { personKey: key, engineName: 'fake', model: 'fake-model', kept, sweepRunId, distillRunId, now: NOW });
  const claimId = storedProposalClaimId(db, key, 'sub_role');

  const home = mkdtempSync(join(tmpdir(), 'sweep-config-'));
  const configPath = ownerConfigPath(home);

  const result = applySweepDecision(db, {}, { claimId, action: 'accept', configPath });
  assert.equal(result.applied, true);
  assert.equal(result.kind, 'sub_role');
  assert.equal(result.rebuildNeeded, true);

  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(raw.personSubRoles[key], ['founder', 'investor'], "the LinkedIn-derived 'founder' tag survives the union");

  const proposalRow = db.prepare('SELECT applied_at FROM person_sweep_proposal WHERE claim_id = ?').get(claimId);
  assert.ok(proposalRow.applied_at !== null);

  const second = applySweepDecision(db, {}, { claimId, action: 'accept', configPath });
  assert.equal(second.applied, false, 'a second accept of the same proposal is a no-op');
  const rawAfter = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(rawAfter.personSubRoles[key], ['founder', 'investor']);
});

test('rejecting a sub_role proposal writes no override', () => {
  const db = openDb(':memory:');
  const key = 'name:reject test';
  insertPerson(db, { key, name: 'Reject Test', role: 'business' });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'I am raising a fund now', me: 'nice' });

  const gathered = newRowsFor(db, key, 0);
  const proposal = { tags: [{ tag: 'investor', text: 'raising a fund', quote: 'raising a fund' }], firm: null, page_lines: [] };
  const { kept } = groundSweep(proposal, gathered);
  const { distillRunId, sweepRunId } = insertSweepRun(db);
  storeSweep(db, { personKey: key, engineName: 'fake', model: 'fake-model', kept, sweepRunId, distillRunId, now: NOW });
  const claimId = storedProposalClaimId(db, key, 'sub_role');

  const home = mkdtempSync(join(tmpdir(), 'sweep-config-reject-'));
  const configPath = ownerConfigPath(home);

  const result = applySweepDecision(db, {}, { claimId, action: 'reject', configPath });
  assert.equal(result.applied, false);
  assert.equal(result.rebuildNeeded, false);
  assert.ok(!existsSync(configPath), 'a reject never writes an owner-config override');
});

test('accepting a firm proposal stamps applied_at with no projection write', () => {
  const db = openDb(':memory:');
  const key = 'name:firm accept test';
  insertPerson(db, { key, name: 'Firm Accept Test', role: 'business' });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'I lead investing at Acme Capital', me: 'cool' });

  const gathered = newRowsFor(db, key, 0);
  const proposal = { tags: [], page_lines: [], firm: { name: 'Acme Capital', text: 'at Acme Capital', quote: 'lead investing at Acme Capital' } };
  const { kept } = groundSweep(proposal, gathered);
  const { distillRunId, sweepRunId } = insertSweepRun(db);
  storeSweep(db, { personKey: key, engineName: 'fake', model: 'fake-model', kept, sweepRunId, distillRunId, now: NOW });
  const claimId = storedProposalClaimId(db, key, 'firm');

  const before = db.prepare('SELECT sub_roles FROM people WHERE person_key = ?').get(key);

  const result = applySweepDecision(db, {}, { claimId, action: 'accept' });
  assert.equal(result.applied, true);
  assert.equal(result.kind, 'firm');
  assert.equal(result.rebuildNeeded, false, 'a firm accept never touches the sub-roles projection');

  const proposalRow = db.prepare('SELECT applied_at FROM person_sweep_proposal WHERE claim_id = ?').get(claimId);
  assert.ok(proposalRow.applied_at !== null);

  const after = db.prepare('SELECT sub_roles FROM people WHERE person_key = ?').get(key);
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------
// (20-21) routes: /stats carries sweep, /health is untouched, and a sweep
// proposal appears in /admin/memory/pending like any other pending claim.
// ---------------------------------------------------------------------------

const TOKEN = 'f'.repeat(64);

test('/stats carries a sweep key and /health is still exactly {"ok":true}, and a stored proposal appears in /admin/memory/pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-sweep-'));
  const engine = {
    name: 'fake', model: 'fake-model', counters: { calls: 0, totalCostUsd: 0.02, totalDurationMs: 5 },
    async complete() {
      engine.counters.calls += 1;
      return JSON.stringify({ tags: [{ tag: 'investor', text: 'raising a fund', quote: 'raising a fund' }], firm: null, page_lines: [] });
    },
  };
  const server = await start({
    port: 0, dbPath: join(dir, 'context.db'), llamaApiKey: 'd'.repeat(64), bearerToken: TOKEN,
    relationshipMemoryEngine: engine, peopleProjectionAutoRebuild: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const db = server.db;
    const key = 'name:stats sweep person';
    insertPerson(db, { key, name: 'Stats Sweep Person', role: 'business', sent: 10, received: 10 });
    insertThread(db, key, { ts: NOW - 1 * DAY, them: 'I am raising a fund right now', me: 'nice' });

    const health = await (await call('GET', '/health')).json();
    assert.deepEqual(health, { ok: true });

    const sweepResult = await (await call('POST', '/admin/relationship/sweep', { power: 'trickle' })).json();
    assert.equal(sweepResult.status, 'complete');
    assert.equal(sweepResult.proposed, 1);

    const health2 = await (await call('GET', '/health')).json();
    assert.deepEqual(health2, { ok: true }, '/health stays exactly {"ok":true} after the sweep route runs');

    const stats = await (await call('GET', '/stats')).json();
    assert.ok(stats.sweep, '/stats carries a sweep key');
    assert.equal(stats.sweep.swept, 1);
    assert.equal(stats.sweep.pending, 1);
    assert.equal(stats.sweep.lastPassStatus, 'complete');
    assert.equal(typeof stats.sweep.callCap, 'number');

    const pending = await (await call('GET', '/admin/memory/pending')).json();
    const claim = pending.claims.find((c) => c.subject_person_key === key);
    assert.ok(claim, 'the sweep-stored proposal appears in /admin/memory/pending like any other pending claim');
    assert.equal(claim.text, 'raising a fund');
    assert.equal(claim.quote, 'raising a fund');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// THE ME ROW THAT ATE THE BUDGET. newRowsFor pooled THEM and ME rows into one
// newest-first queue, so an owner reply newer than the person's own newest
// line took the char budget in front of it. The person's line then did not
// fit, the excerpt list held zero THEM rows, sweepPerson returned 'empty'
// WITHOUT CALLING A MODEL, and the cursor was written past the row anyway --
// unshown, unrecoverable, and it was the evidence.
//
// The fixture is the audit's own: one episode, ctx 500 = a 5,500-char THEM
// line, ctx 501 = a 1,000-char ME reply, cursor 0, against SWEEP_MAX_CHARS.
// ---------------------------------------------------------------------------

// One episode where the person's long line comes FIRST and the owner's reply
// is the newer row. Returns both ids so a test can name them.
function seedMeReplyAfterLongThemLine(db, key, name, { themChars, meChars }) {
  insertPerson(db, { key, name });
  const chatGuid = 'chat:me-eats-budget';
  const themId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(NOW - 1 * DAY, 'so anyway '.padEnd(themChars, 'x'),
    JSON.stringify({ chat_guid: chatGuid, is_from_me: false })).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, ?)`
  ).run(key, themId, chatGuid);

  const meId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(NOW - 1 * DAY + 60_000, 'right, '.padEnd(meChars, 'y'),
    JSON.stringify({ chat_guid: chatGuid, is_from_me: true })).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 0, 1, 0, 1, ?)`
  ).run(key, meId, chatGuid);

  return { themId, meId };
}

test("an owner reply never takes the budget in front of the person's own line", () => {
  const db = openDb(':memory:');
  const key = 'name:me eats budget';
  // 5,500 + 1,000 > SWEEP_MAX_CHARS (6,000): exactly one of the two fits
  // alongside the other, and which one it is decides whether a model is ever
  // shown this person's words.
  const { themId, meId } = seedMeReplyAfterLongThemLine(db, key, 'Me Eats Budget', {
    themChars: 5500, meChars: 1000,
  });
  assert.ok(5500 + 1000 > SWEEP_MAX_CHARS, 'the fixture must actually overflow the budget');
  assert.ok(meId > themId, 'the ME reply is the newer row, which is what triggered the bug');

  const gathered = newRowsFor(db, key, 0);
  const shown = gathered.excerpts.map((e) => ({ id: e.contextId, who: e.speaker }));

  assert.deepEqual(
    shown.filter((s) => s.who === 'THEM').map((s) => s.id),
    [themId],
    "the person's own line must be shown -- it is the evidence, and the ME row is tone"
  );
  assert.ok(
    !shown.some((s) => s.id === meId),
    'the ME reply does not fit alongside it and is dropped, which costs nothing'
  );

  // The cursor reaches 501 only because 500 was shown. Under the old
  // admission order the cursor also reached 501 -- with 500 never shown.
  assert.equal(gathered.maxContextId, themId, 'the cursor stops at the newest SHOWN THEM row');
  assert.ok(gathered.maxContextId >= themId, 'and never sits behind the row a model just read');
});

test('a single THEM row larger than the whole budget is truncated in, not skipped', () => {
  const db = openDb(':memory:');
  const key = 'name:oversized them';
  const { themId } = seedMeReplyAfterLongThemLine(db, key, 'Oversized Them', {
    themChars: SWEEP_MAX_CHARS + 2000, meChars: 50,
  });

  const gathered = newRowsFor(db, key, 0);
  const them = gathered.excerpts.filter((e) => e.speaker === 'THEM');
  assert.equal(them.length, 1, 'the oversized row is shown rather than skipped');
  assert.equal(them[0].contextId, themId);
  assert.equal(them[0].text.length, SWEEP_MAX_CHARS, 'truncated to the budget');
  assert.equal(gathered.maxContextId, themId, 'and the cursor may pass it, because it WAS shown');
});

test('a pass over the ME-eats-budget fixture calls the model instead of reporting empty', async () => {
  const db = openDb(':memory:');
  const key = 'name:me eats budget pass';
  seedMeReplyAfterLongThemLine(db, key, 'Me Eats Budget Pass', { themChars: 5500, meChars: 1000 });
  insertActiveDay(db, key, day(1));

  const asked = [];
  const engine = fakeSweepEngine(({ user }) => {
    asked.push(user);
    return JSON.stringify({ tags: [], firm: null, page_lines: [] });
  });

  const run = await runSweepPass(db, engine, {}, { powerMode: 'full', now: NOW });
  assert.equal(run.status, 'complete');
  // THE POINT: one real model call. The old order produced zero THEM excerpts
  // for this person, so sweepPerson short-circuited to 'empty' with calls: 0
  // and wrote the cursor past the row regardless.
  assert.equal(run.model_calls, 1, 'the person must actually be asked about');
  assert.match(asked[0] ?? '', /THEM:/u, "and the prompt must carry the person's own line");
});

// ---------------------------------------------------------------------------
// THE CALL CAP, which failed open in two independent ways.
// ---------------------------------------------------------------------------

test('a non-numeric sweepDailyCallCap falls back to the default rather than disabling the cap', () => {
  const db = openDb(':memory:');
  const key = 'name:nan cap';
  insertPerson(db, { key, name: 'Nan Cap', role: 'business' });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'hello', me: 'hi' });

  const used = Math.ceil(SWEEP_DAILY_CALL_CAP_DEFAULT * 0.9);
  db.prepare(
    `INSERT INTO person_sweep_run(distill_run_id, started_at, ended_at, power_mode, engine, budget, scope_size,
       candidates, swept, model_calls, proposed, dropped, tokens_est, skip_reason, status)
     VALUES (NULL, ?, ?, 'trickle', 'fake', 3, 1, 1, 1, ?, 0, 0, 0, NULL, 'complete')`
  ).run(Date.now(), Date.now(), used);

  // `Number('lots')`, `Number(null)`, `Number({})` -- the old cast made `cap`
  // NaN, and `used >= 0.9 * NaN` is false for every `used`, so the gate that
  // rations the owner's subscription passed unconditionally.
  for (const bad of ['lots', {}, [], true, -5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const gate = sweepGate(db, { relationshipMemory: { sweepDailyCallCap: bad } }, { engine: 'claude-cli' });
    assert.equal(gate.ok, false, `cap ${JSON.stringify(bad)} must not disable the gate`);
    assert.equal(gate.reason, 'quota');
  }

  // A real, larger cap still raises the ceiling -- the fallback is a fallback,
  // not a hard-coded constant.
  const raised = sweepGate(db, { relationshipMemory: { sweepDailyCallCap: 10_000 } }, { engine: 'claude-cli' });
  assert.equal(raised.ok, true);
});

test('sweepCallCap resolves the configured cap, and sweepStatus reports what is enforced', () => {
  const db = openDb(':memory:');
  assert.equal(sweepCallCap({}), SWEEP_DAILY_CALL_CAP_DEFAULT);
  assert.equal(sweepCallCap({ relationshipMemory: { sweepDailyCallCap: 50 } }), 50);
  assert.equal(sweepCallCap({ relationshipMemory: { sweepDailyCallCap: 'nope' } }), SWEEP_DAILY_CALL_CAP_DEFAULT);

  // /stats printed SWEEP_DAILY_CALL_CAP_DEFAULT unconditionally: a config
  // override was invisible, and even at the default the number shown (200)
  // was never the number enforced (0.9 * 200).
  const withConfig = sweepStatus(db, { relationshipMemory: { sweepDailyCallCap: 50 } });
  assert.equal(withConfig.callCap, 50, 'the config override must reach the dashboard');
  assert.equal(withConfig.callCapEnforced, 45, 'and the threshold the gate actually refuses at');

  const plain = sweepStatus(db);
  assert.equal(plain.callCap, SWEEP_DAILY_CALL_CAP_DEFAULT);
  assert.equal(plain.callCapEnforced, Math.floor(0.9 * SWEEP_DAILY_CALL_CAP_DEFAULT));
});

test('a pass killed mid-loop still counts the calls it made against the cap', async () => {
  const db = openDb(':memory:');
  for (const n of [1, 2, 3]) {
    const key = `name:interrupted ${n}`;
    insertPerson(db, { key, name: `Interrupted ${n}`, role: 'business' });
    insertThread(db, key, { ts: NOW - n * DAY, them: `hello ${n}`, me: 'hi' });
    insertActiveDay(db, key, day(n));
  }

  // A killed process, a machine that slept, a SIGTERM: whatever is COMMITTED
  // at that instant is all the next pass's cap can ever see. So the property
  // to pin is that the counters are live mid-pass, which is read here from
  // inside the engine -- exactly the vantage point a kill would have.
  // model_calls used to be written ONLY by the terminal UPDATE, so this
  // snapshot was 0 on every call and an interrupted pass's calls were free.
  const snapshots = [];
  let answered = 0;
  const engine = fakeSweepEngine(() => {
    // Read the run row as it stands right now -- before this call's own
    // person has been committed, so it reflects the people already done.
    snapshots.push(Number(
      db.prepare('SELECT COALESCE(SUM(model_calls), 0) AS n FROM person_sweep_run WHERE started_at >= ?')
        .get(0).n
    ));
    answered += 1;
    return JSON.stringify({ tags: [], firm: null, page_lines: [] });
  });

  const run = await runSweepPass(db, engine, {}, { powerMode: 'full', budget: 3, now: NOW });
  assert.equal(answered, 3, 'sanity: all three people were asked about');

  // What a kill after person N would have left behind, per N.
  assert.deepEqual(
    snapshots,
    [0, 1, 2],
    'the cap must be able to see each committed call as it happens, not only at the end'
  );
  assert.equal(run.model_calls, 3, 'and the finished row still holds the whole pass');
  assert.equal(run.swept, 3);
});

// ---------------------------------------------------------------------------
// applySweepDecision and the people PROJECTION. people.sub_roles is derived
// state -- rebuildPeopleCore and clearPeopleProjection both DELETE FROM people
// and rebuild -- so a read that lands mid-rebuild sees no row, `current` was
// [], and the union degenerated to [value]: one accepted tag, every other tag
// on that person wiped out of the owner's own config.
// ---------------------------------------------------------------------------

function seedAcceptableTag(db, key, name, { subRoles = [], linkedin = null } = {}) {
  insertPerson(db, { key, name, role: 'business', subRoles });
  if (linkedin !== null) {
    db.prepare('UPDATE people SET linkedin = ? WHERE person_key = ?').run(JSON.stringify(linkedin), key);
  }
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'I am raising a fund now', me: 'nice' });
  const gathered = newRowsFor(db, key, 0);
  const { kept } = groundSweep(
    { tags: [{ tag: 'investor', text: 'raising a fund', quote: 'raising a fund' }], firm: null, page_lines: [] },
    gathered
  );
  const { distillRunId, sweepRunId } = insertSweepRun(db);
  storeSweep(db, { personKey: key, engineName: 'fake', model: 'fake-model', kept, sweepRunId, distillRunId, now: NOW });
  return storedProposalClaimId(db, key, 'sub_role');
}

test('accepting a tag while the people projection is missing refuses instead of wiping the override', () => {
  const db = openDb(':memory:');
  const key = 'name:mid rebuild';
  const claimId = seedAcceptableTag(db, key, 'Mid Rebuild', { subRoles: ['founder', 'operator'] });

  const home = mkdtempSync(join(tmpdir(), 'sweep-midrebuild-'));
  const configPath = ownerConfigPath(home);
  // An override the owner already has, which is the thing that used to be
  // destroyed. Written through the same function the accept path uses.
  markPersonSubRoles({ key, subRoles: ['founder', 'operator'], configPath });

  // The projection rebuild's own first statement.
  db.prepare('DELETE FROM people').run();

  const result = applySweepDecision(db, {}, { claimId, action: 'accept', configPath });
  assert.equal(result.applied, false, 'a decision that cannot be applied safely must not claim it was');
  assert.equal(result.rebuildNeeded, false, 'and must not ask for a rebuild it did not earn');
  assert.equal(result.reason, 'people-row-missing', 'the caller is told to retry, not left guessing');

  assert.deepEqual(
    JSON.parse(readFileSync(configPath, 'utf8')).personSubRoles[key],
    ['founder', 'operator'],
    "the owner's existing tags survive -- the old code left exactly ['investor'] here"
  );
  const proposalRow = db.prepare('SELECT applied_at FROM person_sweep_proposal WHERE claim_id = ?').get(claimId);
  assert.equal(proposalRow.applied_at, null, 'and the proposal is still applicable once the projection is back');
});

test('an accept unions the config override too, not only the projection', () => {
  const db = openDb(':memory:');
  const key = 'name:override union';
  const claimId = seedAcceptableTag(db, key, 'Override Union', { subRoles: [] });

  const home = mkdtempSync(join(tmpdir(), 'sweep-override-'));
  const configPath = ownerConfigPath(home);
  // The durable half is ahead of the projection here: the config says
  // 'operator' and people.sub_roles has not caught up. Reading only the
  // projection would drop it.
  markPersonSubRoles({ key, subRoles: ['operator'], configPath });

  const result = applySweepDecision(db, {}, { claimId, action: 'accept', configPath });
  assert.equal(result.applied, true);
  assert.deepEqual(
    JSON.parse(readFileSync(configPath, 'utf8')).personSubRoles[key],
    ['investor', 'operator']
  );
});

test('rejecting an accepted tag takes it back out of the override and re-arms the proposal', () => {
  const db = openDb(':memory:');
  const key = 'name:accept then reject';
  const claimId = seedAcceptableTag(db, key, 'Accept Then Reject', { subRoles: ['founder'] });

  const home = mkdtempSync(join(tmpdir(), 'sweep-unaccept-'));
  const configPath = ownerConfigPath(home);

  applySweepDecision(db, {}, { claimId, action: 'accept', configPath });
  assert.deepEqual(
    JSON.parse(readFileSync(configPath, 'utf8')).personSubRoles[key],
    ['founder', 'investor']
  );

  // Before this, a reject was a no-op: the tag stayed in the config forever
  // AND applied_at stayed stamped, so a later accept was blocked too. The
  // owner's rejection had no effect on the person's tags in either direction.
  const undo = applySweepDecision(db, {}, { claimId, action: 'reject', configPath });
  assert.equal(undo.applied, true);
  assert.equal(undo.rebuildNeeded, true);
  assert.equal(undo.reason, 'tag-removed');
  assert.deepEqual(
    JSON.parse(readFileSync(configPath, 'utf8')).personSubRoles[key],
    ['founder'],
    'only the rejected tag goes; the LinkedIn-derived one is not this decision to remove'
  );
  const proposalRow = db.prepare('SELECT applied_at FROM person_sweep_proposal WHERE claim_id = ?').get(claimId);
  assert.equal(proposalRow.applied_at, null, 'the owner may change their mind again');
});

test('a reject leaves a tag the LinkedIn export derives on its own', () => {
  const db = openDb(':memory:');
  const key = 'name:export derived';
  // A title subRolesFor reads as 'investor' by itself, so the tag's
  // provenance is not this proposal.
  const claimId = seedAcceptableTag(db, key, 'Export Derived', {
    subRoles: [],
    linkedin: { position: 'General Partner', company: 'Example Capital' },
  });

  const home = mkdtempSync(join(tmpdir(), 'sweep-exportderived-'));
  const configPath = ownerConfigPath(home);
  applySweepDecision(db, {}, { claimId, action: 'accept', configPath });
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).personSubRoles[key], ['investor']);

  const undo = applySweepDecision(db, {}, { claimId, action: 'reject', configPath });
  assert.equal(undo.applied, false);
  assert.equal(undo.reason, 'tag-is-export-derived');
  assert.deepEqual(
    JSON.parse(readFileSync(configPath, 'utf8')).personSubRoles[key],
    ['investor'],
    'removing it would be overriding the export, which this decision never spoke to'
  );
});

test('sweepScope is ordered least-recently-swept first, and deterministically', () => {
  const db = openDb(':memory:');
  const keys = ['name:cccc', 'name:aaaa', 'name:bbbb'];
  for (const key of keys) {
    insertPerson(db, { key, name: key.slice(5).toUpperCase(), role: 'business' });
    insertThread(db, key, { ts: NOW - 1 * DAY, them: 'hello', me: 'hi' });
  }
  // aaaa was swept most recently, bbbb before that, cccc never.
  db.prepare(
    `INSERT INTO person_sweep_cursor(person_key, swept_through_context_id, last_swept_at, last_status, proposals)
     VALUES (?, 0, ?, 'empty', 0)`
  ).run('name:aaaa', NOW);
  db.prepare(
    `INSERT INTO person_sweep_cursor(person_key, swept_through_context_id, last_swept_at, last_status, proposals)
     VALUES (?, 0, ?, 'empty', 0)`
  ).run('name:bbbb', NOW - 5 * DAY);

  const scope = sweepScope(db, { now: NOW });
  assert.deepEqual(
    scope.map((c) => c.personKey),
    ['name:cccc', 'name:bbbb', 'name:aaaa'],
    'never-swept first, then oldest -- runSweepPass slices the budget off the front of this list'
  );
  // Deterministic, because the budget slice has to be reproducible across a
  // projection rebuild: without an ORDER BY the order came back however
  // SQLite felt like returning it.
  assert.deepEqual(sweepScope(db, { now: NOW }).map((c) => c.personKey), scope.map((c) => c.personKey));
});

test('storeSweep leaves no receiptless claim behind when a later insert fails', () => {
  const db = openDb(':memory:');
  const key = 'name:atomic store';
  insertPerson(db, { key, name: 'Atomic Store', role: 'business' });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'I am raising a fund now', me: 'nice' });
  const gathered = newRowsFor(db, key, 0);
  const contextId = gathered.findQuoteContextId('raising a fund');
  const { distillRunId, sweepRunId } = insertSweepRun(db);

  const claimsBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM claim').get().n);

  // A claim, its claim_source receipt and its person_sweep_proposal row are
  // ONE fact in three tables. Untransacted, a failure between them left a
  // claim in the owner's pending queue with no receipt, rendering
  // `quote: null` -- an evidence-free claim, which every grounding rule in
  // sweep.mjs exists to make impossible. 'bogus' violates
  // person_sweep_proposal.kind's CHECK, so the third insert is the one that
  // throws; the first two must go with it.
  assert.throws(() => storeSweep(db, {
    personKey: key, engineName: 'fake', model: 'fake-model', sweepRunId, distillRunId, now: NOW,
    kept: [{ kind: 'bogus', value: 'investor', text: 'raising a fund', quote: 'raising a fund', contextId }],
  }));

  assert.equal(
    Number(db.prepare('SELECT COUNT(*) AS n FROM claim').get().n),
    claimsBefore,
    'the claim row must not survive its own proposal insert failing'
  );
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM claim_source').get().n), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM person_sweep_proposal').get().n), 0);
});

// ---------------------------------------------------------------------------
// Review F finding 11: THE ROWS BEHIND THE OVERSIZED ONE. The THEM loop
// `break`d on the first row that did not fit the remaining budget. Because
// admission is newest-first, everything it broke past was OLDER -- and
// maxContextId had already moved to the oversized row that WAS shown, so
// those older rows ended up below the cursor: never offered again, never
// read by a model, gone.
// ---------------------------------------------------------------------------

// Several THEM rows in ONE episode (one chat_guid, minutes apart), with one
// owner line so buildEpisodes keeps the run. `themChars` is read oldest-first.
function seedThemRun(db, key, name, themChars) {
  insertPerson(db, { key, name });
  const chatGuid = 'chat:them-run';
  const base = NOW - 2 * DAY;
  db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', 'go on', ?)"
  ).run(base, JSON.stringify({ chat_guid: chatGuid, is_from_me: true }));
  const meId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 0, 1, 0, 1, ?)`
  ).run(key, meId, chatGuid);

  const ids = [];
  themChars.forEach((chars, i) => {
    const id = Number(db.prepare(
      "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
    ).run(base + (i + 1) * 60_000, `line ${i} `.padEnd(chars, 'x'),
      JSON.stringify({ chat_guid: chatGuid, is_from_me: false })).lastInsertRowid);
    db.prepare(
      `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
       VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, ?)`
    ).run(key, id, chatGuid);
    ids.push(id);
  });
  return ids;
}

test('older, smaller THEM rows behind an oversized newest one are still shown, not stranded below the cursor', () => {
  const db = openDb(':memory:');
  const key = 'name:rows behind';
  // Oldest first: two small lines, then a newest line bigger than the whole
  // budget. Newest-first admission reaches the big one first, and the old
  // loop stopped there -- with the cursor already past all three.
  const [oldest, middle, newest] = seedThemRun(db, key, 'Rows Behind', [500, 700, SWEEP_MAX_CHARS + 3000]);

  const gathered = newRowsFor(db, key, 0);
  const themIds = gathered.excerpts.filter((e) => e.speaker === 'THEM').map((e) => e.contextId).sort((a, b) => a - b);
  assert.deepEqual(themIds, [oldest, middle, newest],
    'every THEM row the cursor is about to move past was actually shown');
  assert.equal(gathered.maxContextId, newest);

  // Each row is truncated to its fair share, so the oversized one no longer
  // eats the rows behind it.
  const byId = new Map(gathered.excerpts.map((e) => [e.contextId, e]));
  assert.equal(byId.get(newest).text.length, Math.floor(SWEEP_MAX_CHARS / 3));
  assert.equal(byId.get(oldest).text.length, 500, 'a row that fits its share is untouched');
  assert.equal(byId.get(middle).text.length, 700);
});

test('a quote from an oversized row\'s discarded tail still cannot ground', () => {
  const db = openDb(':memory:');
  const key = 'name:tail quote';
  const chatGuid = 'chat:tail';
  insertPerson(db, { key, name: 'Tail Quote' });
  db.prepare("INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', 'go on', ?)")
    .run(NOW - 2 * DAY, JSON.stringify({ chat_guid: chatGuid, is_from_me: true }));
  const meId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 0, 1, 0, 1, ?)`
  ).run(key, meId, chatGuid);
  const text = `${'head '.padEnd(4000, 'x')}TAIL-ONLY-PHRASE`;
  const themId = Number(db.prepare(
    "INSERT INTO context(ts, source, text, meta) VALUES (?, 'imessage', ?, ?)"
  ).run(NOW - 2 * DAY + 60_000, text, JSON.stringify({ chat_guid: chatGuid, is_from_me: false })).lastInsertRowid);
  db.prepare(
    `INSERT INTO person_event_links(person_key, context_id, source, role, authored, owner_authored, room, confidence, conversation_key)
     VALUES (?, ?, 'imessage', 'counterparty', 1, 0, 0, 1, ?)`
  ).run(key, themId, chatGuid);

  const gathered = newRowsFor(db, key, 0, { maxChars: 1000 });
  assert.equal(gathered.findQuoteContextId('TAIL-ONLY-PHRASE'), null,
    'the model was never shown the tail, so nothing in it can be a receipt');
  assert.ok(gathered.findQuoteContextId('head') !== null, 'what it WAS shown still grounds');
});

test('many THEM rows shrink to the per-row floor rather than dropping any of them', () => {
  const db = openDb(':memory:');
  const key = 'name:many them rows';
  const ids = seedThemRun(db, key, 'Many Them Rows', Array.from({ length: 60 }, () => 400));

  const gathered = newRowsFor(db, key, 0);
  const them = gathered.excerpts.filter((e) => e.speaker === 'THEM');
  assert.equal(them.length, ids.length, 'sixty rows, sixty excerpts: none skipped');
  for (const e of them) {
    assert.equal(e.text.length, SWEEP_MIN_ROW_CHARS,
      'the share is below the floor, so the floor is what each row gets');
  }
  assert.equal(gathered.maxContextId, Math.max(...ids));
});

// ---------------------------------------------------------------------------
// Review F finding 6: A SPENT MODEL CALL IS SPENT. bumpRun sat inside the
// per-person transaction, so the catch path's ROLLBACK discarded the call
// count -- and sweepGate's daily cap SUMS model_calls, so the cap
// under-counted in exactly the case the incremental bump exists for.
// ---------------------------------------------------------------------------

test('a model call already made is counted even when the cursor write fails', async () => {
  const db = openDb(':memory:');
  const key = 'name:cursor write fails';
  insertPerson(db, { key, name: 'Cursor Write Fails', role: 'business', sent: 10, received: 10 });
  insertThread(db, key, { ts: NOW - 1 * DAY, them: 'something new to sweep', me: 'ok' });
  // Reads still work (sweepScope), writes abort: the cursor upsert throws
  // AFTER the engine has already answered and been paid for.
  db.exec(`CREATE TRIGGER no_cursor_writes BEFORE INSERT ON person_sweep_cursor
           BEGIN SELECT RAISE(ABORT, 'cursor write refused'); END;`);

  const engine = fakeSweepEngine(() => JSON.stringify({ tags: [], firm: null, page_lines: [] }));
  await assert.rejects(() => runSweepPass(db, engine, {}, { powerMode: 'trickle', now: NOW }));
  assert.equal(engine.counters.calls, 1, 'the call really was made');

  const run = db.prepare('SELECT * FROM person_sweep_run ORDER BY id DESC LIMIT 1').get();
  assert.equal(Number(run.model_calls), 1,
    'the daily cap sums this column: a call the rollback forgot is a call the cap cannot see');
  assert.equal(Number(run.swept), 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM person_sweep_cursor').get().n), 0,
    'and the cursor did NOT move -- those rows are offered again next pass');
});
