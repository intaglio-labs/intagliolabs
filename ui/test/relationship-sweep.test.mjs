// Discovery sweep (L5 step 5, relationship/sweep.mjs): tests follow the same
// shape relationship-pages.test.mjs uses -- pure grounding first (no DB, no
// model), then openDb on a mkdtempSync path, then routes via start() with a
// policy.relationshipMemoryEngine fake.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/hermes.mjs';
import { eligiblePool } from '../server/relationship/producer.mjs';
import {
  groundSweep, newRowsFor, sweepScope, storeSweep, SWEEP_MAX_CHARS, SWEEP_MAX_EPISODES, tokensEstFor,
} from '../server/relationship/sweep.mjs';

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
  // maxContextId is the max over every row actually SHOWN (post-budget),
  // including the owner's own ME reply inside the same new episode -- never
  // just the THEM row.
  assert.equal(gathered.maxContextId, fresh.meId);
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
