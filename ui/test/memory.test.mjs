// Tests for the memory layer: the claim tables, the trusted apply path, and
// the deletion story that ties a model's conclusion to the row it came from.
//
// The property under test throughout is NOT "claims can be stored". It is that
// a claim cannot outlive, out-drift, or out-scope its receipt:
//
//   * it lands only if its quote is really in the cited row, right now;
//   * it disappears the moment that row is edited out from under it;
//   * it disappears with the row when the row is deleted, and its text stops
//     being findable in the FTS index at the same instant;
//   * nobody can quietly rewrite it afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDb,
  insertRows,
  applyMemoryBatch,
  orphanClaimCount,
  pendingClaims,
  start,
} from '../server/hermes.mjs';

const TOKEN = 'e'.repeat(64);

const RUN = Object.freeze({
  model: 'qwen3-8b',
  prompt_path: 'prompts/extract_claims.md',
  prompt_sha: 'a'.repeat(64),
  params: { temperature: 0 },
});

// One owner-sent message, the shape v1 actually distills.
function seed(db, text = 'i am vegetarian and i do not eat fish either') {
  insertRows(db, {
    ts: 1_700_000_000_000,
    source: 'imessage',
    entity_id: 'imessage:m1',
    text,
  });
  return db.prepare("SELECT * FROM context WHERE entity_id = 'imessage:m1'").get();
}

function claimFor(row, { quote = 'i am vegetarian', kind = 'preference' } = {}) {
  return {
    kind,
    text: 'Austin is vegetarian.',
    source: { context_id: Number(row.id), quote, content_hash: row.content_hash },
  };
}

function ftsHits(db, needle) {
  return Number(
    db.prepare('SELECT count(*) AS n FROM claim_fts WHERE claim_fts MATCH ?').get(needle).n
  );
}

test('foreign keys are enforced, not merely declared', () => {
  const db = openDb(':memory:');
  assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
  // A claim_source pointing at no context row must be refused by the engine,
  // not just by the applier's own validation.
  db.prepare(
    "INSERT INTO distill_run(model, prompt_path, prompt_sha, params, status, started_at) " +
      "VALUES ('m', 'p', 's', '{}', 'complete', 1)"
  ).run();
  db.prepare(
    "INSERT INTO claim(run_id, subject, kind, text, created_at) VALUES (1, 'owner', 'fact', 't', 1)"
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO claim_source(claim_id, context_id, source, quote) VALUES (1, 999999, 'imessage', 'q')"
        )
        .run(),
    /FOREIGN KEY/iu
  );
  db.close();
});

test('apply lands a claim with its receipt, and derives what the model must not supply', () => {
  const db = openDb(':memory:');
  const row = seed(db);
  const result = applyMemoryBatch(db, { run: { ...RUN, rows_in: 1 }, claims: [claimFor(row)] });

  assert.equal(result.applied, 1);
  assert.deepEqual(result.rejected, []);
  assert.equal(orphanClaimCount(db, result.run_id), 0);

  const claim = db.prepare('SELECT * FROM claim').get();
  assert.equal(claim.subject, 'owner', 'subject is closed to owner by the schema');
  // observed_at is the ROW's event time, never the model's opinion of when
  // the thing happened, and never "now".
  assert.equal(Number(claim.observed_at), 1_700_000_000_000);
  assert.equal(claim.p_claim, null);

  const src = db.prepare('SELECT * FROM claim_source').get();
  assert.equal(Number(src.context_id), Number(row.id));
  assert.equal(src.source, 'imessage', 'source is copied off the row, not the payload');
  assert.equal(src.entity_id, 'imessage:m1');
  assert.equal(src.content_hash, row.content_hash);
  assert.equal(src.quote, 'i am vegetarian');

  const run = db.prepare('SELECT * FROM distill_run').get();
  assert.equal(run.status, 'complete');
  assert.equal(Number(run.claims_out), 1);
  assert.equal(Number(run.rows_in), 1);
  db.close();
});

test('a quote that is not really in the row is rejected by index, not silently dropped', () => {
  const db = openDb(':memory:');
  const row = seed(db);
  const result = applyMemoryBatch(db, {
    run: RUN,
    claims: [
      claimFor(row),
      claimFor(row, { quote: 'i am vegan' }), // plausible, absent, and therefore not a receipt
    ],
  });
  assert.equal(result.applied, 1);
  assert.deepEqual(result.rejected, [
    { index: 1, reason: 'quote is not an exact substring of the cited row' },
  ]);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM claim').get().n), 1);
  db.close();
});

test('a receipt whose row moved under the distiller is rejected', () => {
  const db = openDb(':memory:');
  const row = seed(db);
  // The row is edited after the distiller read it but before apply.
  insertRows(db, {
    ts: 1_700_000_000_000,
    source: 'imessage',
    entity_id: 'imessage:m1',
    text: 'i am vegetarian, mostly',
  });
  const result = applyMemoryBatch(db, { run: RUN, claims: [claimFor(row)] });
  assert.equal(result.applied, 0);
  assert.deepEqual(result.rejected, [{ index: 0, reason: 'cited row changed since it was read' }]);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM claim').get().n), 0);
  db.close();
});

test('the apply schema is closed at every level', () => {
  const db = openDb(':memory:');
  const row = seed(db);
  const cases = [
    [{ run: RUN, claims: [claimFor(row)], extra: 1 }, /unknown field "extra"/u],
    [{ run: { ...RUN, nope: 1 }, claims: [claimFor(row)] }, /unknown field "nope"/u],
    [
      { run: RUN, claims: [{ ...claimFor(row), observed_at: 5 }] },
      /unknown field "observed_at"/u,
    ],
    [
      { run: RUN, claims: [{ ...claimFor(row), subject: 'someone' }] },
      /unknown field "subject"/u,
    ],
    [{ run: RUN, claims: [{ ...claimFor(row), kind: 'vibe' }] }, /"kind" must be one of/u],
    [{ run: RUN, claims: [{ ...claimFor(row), p_claim: 2 }] }, /"p_claim" must be a number/u],
    [{ run: RUN, claims: [{ kind: 'fact', text: 'x' }] }, /"source" must be an object/u],
    [{ run: RUN, claims: [] }, /"claims" must be an array/u],
  ];
  for (const [body, pattern] of cases) {
    assert.throws(() => applyMemoryBatch(db, body), pattern, JSON.stringify(body).slice(0, 80));
  }
  // A rejected batch leaves NOTHING behind -- not even the run row, which is
  // written first and would otherwise accumulate one orphan per bad request.
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM distill_run').get().n), 0);
  db.close();
});

test('an orphan claim cannot commit', () => {
  const db = openDb(':memory:');
  const row = seed(db);
  const ok = applyMemoryBatch(db, { run: RUN, claims: [claimFor(row)] });
  assert.equal(orphanClaimCount(db, ok.run_id), 0);

  // The applier cannot currently produce an orphan -- v1 validates exactly one
  // source per claim before the transaction opens -- so this exercises the
  // guard against the shape a future edit would introduce: a claim written
  // without its receipt. It is the SAME function the applier calls, and the
  // point is that the batch is still rollback-able when it fires.
  db.exec('BEGIN');
  db.prepare(
    "INSERT INTO distill_run(model, prompt_path, prompt_sha, params, status, started_at) " +
      "VALUES ('m', 'p', 's', '{}', 'complete', 1)"
  ).run();
  const runId = Number(db.prepare('SELECT max(id) AS id FROM distill_run').get().id);
  db.prepare(
    "INSERT INTO claim(run_id, subject, kind, text, created_at) VALUES (?, 'owner', 'fact', 'no receipt', 1)"
  ).run(runId);
  assert.equal(orphanClaimCount(db, runId), 1, 'the guard sees the orphan while it can still roll back');
  db.exec('ROLLBACK');
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM claim').get().n), 1, 'only the good claim survives');
  db.close();
});

test('claim, claim_source and claim_decision are append-only in fact', () => {
  const db = openDb(':memory:');
  const row = seed(db);
  const { run_id } = applyMemoryBatch(db, { run: RUN, claims: [claimFor(row)] });
  const claimId = Number(db.prepare('SELECT id FROM claim').get().id);

  assert.throws(() => db.prepare("UPDATE claim SET text = 'rewritten' WHERE id = ?").run(claimId), /append-only/u);
  assert.throws(
    () => db.prepare("UPDATE claim_source SET quote = 'x' WHERE claim_id = ?").run(claimId),
    /snapshot/u
  );
  // REPLACE in disguise: an explicit id colliding with a live row. BEFORE
  // INSERT is the only moment the original still exists to be protected,
  // because REPLACE fires DELETE triggers only under recursive_triggers.
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT OR REPLACE INTO claim(id, run_id, subject, kind, text, created_at) " +
            "VALUES (?, ?, 'owner', 'fact', 'smuggled', 1)"
        )
        .run(claimId, run_id),
    /REPLACE in disguise/u
  );
  assert.equal(db.prepare('SELECT text FROM claim WHERE id = ?').get(claimId).text, 'Austin is vegetarian.');

  db.prepare(
    "INSERT INTO claim_decision(claim_id, action, actor, created_at) VALUES (?, 'accept', 'owner', 1)"
  ).run(claimId);
  assert.throws(
    () => db.prepare("UPDATE claim_decision SET action = 'reject' WHERE claim_id = ?").run(claimId),
    /append-only/u
  );
  // distill_run is deliberately NOT append-only: status and ended_at move.
  db.prepare("UPDATE distill_run SET status = 'failed' WHERE id = ?").run(run_id);
  db.close();
});

test('v_claim_accepted follows the LATEST decision, not any decision', () => {
  const db = openDb(':memory:');
  const row = seed(db);
  applyMemoryBatch(db, { run: RUN, claims: [claimFor(row)] });
  const claimId = Number(db.prepare('SELECT id FROM claim').get().id);
  const accepted = () => Number(db.prepare('SELECT count(*) AS n FROM v_claim_accepted').get().n);

  assert.equal(accepted(), 0, 'a proposed claim is inert until the owner acts');

  const decide = (action, at) =>
    db
      .prepare('INSERT INTO claim_decision(claim_id, action, actor, created_at) VALUES (?, ?, ?, ?)')
      .run(claimId, action, 'owner', at);

  decide('accept', 1000);
  assert.equal(accepted(), 1);
  decide('retract', 2000);
  assert.equal(accepted(), 0, 'a retraction is the latest word');
  decide('accept', 3000);
  assert.equal(accepted(), 1, 'and the owner may change their mind back');
  db.close();
});

test('editing a source row invalidates only the claims whose snapshot it broke', () => {
  const db = openDb(':memory:');
  const row = seed(db);
  applyMemoryBatch(db, { run: RUN, claims: [claimFor(row)] });
  assert.equal(ftsHits(db, 'vegetarian'), 1);
  const before = Number(db.prepare('SELECT store_changed_at FROM context WHERE id = ?').get(row.id).store_changed_at);

  // A redelivery of the SAME content must not disturb anything -- this is the
  // hourly case, and a connector re-shipping its window must not re-propose
  // the whole corpus.
  insertRows(db, { ts: 1_700_000_000_000, source: 'imessage', entity_id: 'imessage:m1', text: row.text });
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM claim').get().n), 1);
  assert.equal(
    Number(db.prepare('SELECT store_changed_at FROM context WHERE id = ?').get(row.id).store_changed_at),
    before,
    'an unchanged redelivery does not move the cursor'
  );

  // A real edit does: the claim's receipt no longer describes the row.
  insertRows(db, {
    ts: 1_700_000_000_000,
    source: 'imessage',
    entity_id: 'imessage:m1',
    text: 'actually i eat fish now',
  });
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM claim').get().n), 0);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM claim_source').get().n), 0);
  assert.equal(ftsHits(db, 'vegetarian'), 0, 'and the claim text is gone from the index too');
  assert.ok(
    Number(db.prepare('SELECT store_changed_at FROM context WHERE id = ?').get(row.id).store_changed_at) > before,
    'the row is left eligible for redistillation'
  );
  db.close();
});

test('the cursor is strictly monotonic, so an in-place edit can never sort below it', () => {
  const db = openDb(':memory:');
  // Everything here happens well inside one millisecond, which is exactly the
  // case a bare Date.now() stamp gets wrong: the edit would tie with the
  // insert, and a cursor resuming on (store_changed_at, id) > (T, higher_id)
  // would step straight over the edited row and never come back to it.
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    insertRows(db, { ts: 1_700_000_000_000 + i, source: 'imessage', entity_id: `imessage:m${i}`, text: `row ${i}` });
    seen.push(Number(db.prepare('SELECT MAX(store_changed_at) AS m FROM context').get().m));
  }
  // Edit the FIRST row -- the lowest id, the one a tie would strand.
  insertRows(db, { ts: 1_700_000_000_000, source: 'imessage', entity_id: 'imessage:m0', text: 'edited' });
  const edited = Number(
    db.prepare("SELECT store_changed_at FROM context WHERE entity_id = 'imessage:m0'").get().store_changed_at
  );

  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] > seen[i - 1], `write ${i} must sort strictly after write ${i - 1}`);
  }
  assert.ok(edited > seen[seen.length - 1], 'the edit sorts after every write that preceded it');
  db.close();
});

// --- through the real routes -------------------------------------------------
//
// The deletion story only counts if it holds on the path the owner's tooling
// actually calls. These drive a live server over the bearer channel.

test('purge and delete-entities take the derived memory with them, in one operation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-memory-test-'));
  const server = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: 'd'.repeat(64),
    bearerToken: TOKEN,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path, body) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (
        await post('/ingest', [
          { ts: 1_700_000_000_000, source: 'imessage', entity_id: 'imessage:a', text: 'i am vegetarian' },
          { ts: 1_700_000_000_001, source: 'notes', entity_id: 'notes:b', text: 'remember to call mum' },
        ])
      ).status,
      200
    );

    const rows = await (await fetch(`${base}/admin/entities?source=imessage`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json();
    assert.equal(rows.entities.length, 1);

    // Distil against both rows, then accept one, so there is a decision row to
    // clean up as well as a claim.
    const applied = await (async () => {
      const res = await post('/admin/memory/apply', {
        run: RUN,
        claims: [
          { kind: 'preference', text: 'Austin is vegetarian.', source: { context_id: 1, quote: 'i am vegetarian' } },
          { kind: 'plan', text: 'Austin plans to call his mother.', source: { context_id: 2, quote: 'call mum' } },
        ],
      });
      assert.equal(res.status, 200);
      return res.json();
    })();
    assert.equal(applied.applied, 2);
    assert.deepEqual(applied.rejected, []);

    // A purge of one source must remove that source's claim and leave the
    // other alone -- deletion is scoped to what was deleted, not to memory.
    const purged = await (await post('/admin/purge', { source: 'imessage' })).json();
    assert.equal(purged.deleted, 1);
    assert.equal(purged.claims_deleted, 1, 'the derived claim went with its row');
    assert.equal(purged.maintained, true);

    const deleted = await (await post('/admin/delete-entities', {
      source: 'notes',
      entity_ids: ['notes:b'],
    })).json();
    assert.equal(deleted.deleted, 1);
    assert.equal(deleted.claims_deleted, 1);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the compose path sends a REAL bearer key to llama, not the getter', async () => {
  // THIS TEST EXISTS BECAUSE THE BUG SHIPPED. policy.llama.apiKey is a
  // function -- deliberately, so a rotated key file takes effect without a
  // restart -- and /vault/ask interpolated it into the header instead of
  // calling it. Hermes sent the function's SOURCE as the bearer token,
  // llama-server answered 401, and the widget showed "something went wrong on
  // the vault side".
  //
  // Nothing caught it. The abstain test above passes without ever reaching
  // llama, and the widget's own live contract test passed too -- because at
  // the time there were zero accepted claims, so it also abstained. The
  // compose path had no test at all, and a path with no test is a path that
  // works until somebody uses it.
  //
  // So this stands up a fake llama, seeds an ACCEPTED claim so the route must
  // compose, and asserts on the header the route actually sent.
  const seen = [];
  const llama = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'you take the 7am train.' } }] }));
    });
  });
  await new Promise((r) => llama.listen(0, '127.0.0.1', r));
  const llamaPort = llama.address().port;

  const dir = mkdtempSync(join(tmpdir(), 'hermes-compose-test-'));
  const dbPath = join(dir, 'context.db');
  const LLAMA_KEY = 'd'.repeat(64);

  // Seed an accepted claim directly, so recall returns something and the route
  // has no choice but to compose.
  const seedDb = openDb(dbPath);
  insertRows(seedDb, {
    ts: 1_700_000_000_000,
    source: 'imessage',
    entity_id: 'imessage:train',
    text: 'i always take the 7am train on weekdays',
  });
  const row = seedDb.prepare("SELECT id FROM context WHERE entity_id = 'imessage:train'").get();
  applyMemoryBatch(seedDb, {
    run: RUN,
    claims: [
      {
        kind: 'fact',
        text: 'Austin takes the 7am train on weekdays.',
        source: { context_id: Number(row.id), quote: 'take the 7am train' },
      },
    ],
  });
  const claimId = Number(seedDb.prepare('SELECT max(id) AS id FROM claim').get().id);
  seedDb
    .prepare("INSERT INTO claim_decision(claim_id, action, actor, created_at) VALUES (?, 'accept', 'owner', ?)")
    .run(claimId, 1_700_000_000_000);
  seedDb.close();

  const server = await start({
    port: 0,
    dbPath,
    llamaApiKey: LLAMA_KEY,
    llamaBaseUrl: `http://127.0.0.1:${llamaPort}`,
    bearerToken: TOKEN,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/vault/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ utterance: 'how do you get to work?' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      text: 'you take the 7am train.',
      sources: ['imessage'],
      usedRows: 1,
    });

    assert.equal(seen.length, 1, 'the model was called exactly once');
    assert.equal(seen[0], `Bearer ${LLAMA_KEY}`, 'the header carries the key, not the getter');
    // Belt and braces on the exact failure mode: a stringified function.
    assert.ok(!/=>/u.test(seen[0]), 'a function was interpolated into the header');
  } finally {
    await server.close();
    await new Promise((r) => llama.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

// Seed one accepted claim into a fresh file-backed db so /vault/ask must
// compose — an empty corpus abstains before ever reaching llama. Used by the
// upstream-failure tests below; the compose test above seeds inline because
// it also asserts on the claim it builds.
function seedAcceptedClaim(dbPath) {
  const db = openDb(dbPath);
  insertRows(db, {
    ts: 1_700_000_000_000,
    source: 'imessage',
    entity_id: 'imessage:train',
    text: 'i always take the 7am train on weekdays',
  });
  const row = db.prepare("SELECT id FROM context WHERE entity_id = 'imessage:train'").get();
  applyMemoryBatch(db, {
    run: RUN,
    claims: [
      {
        kind: 'fact',
        text: 'Austin takes the 7am train on weekdays.',
        source: { context_id: Number(row.id), quote: 'take the 7am train' },
      },
    ],
  });
  const claimId = Number(db.prepare('SELECT max(id) AS id FROM claim').get().id);
  db.prepare("INSERT INTO claim_decision(claim_id, action, actor, created_at) VALUES (?, 'accept', 'owner', ?)")
    .run(claimId, 1_700_000_000_000);
  db.close();
}

test('a client cancel aborts the in-flight llama call, not just the reply', async () => {
  // The widget's Cancel is a socket teardown, and the route must turn it into
  // an abort on the llama call. The regression this pins: the abort listener
  // was once attached to req 'close' — which has ALREADY fired by the time
  // readJson() has consumed the body — so the abort never ran and the
  // single-slot llama-server kept generating into a socket nobody read, with
  // the next question queued behind it.
  let sawAsk;
  const asked = new Promise((r) => { sawAsk = r; });
  let sawTeardown;
  const upstreamTornDown = new Promise((r) => { sawTeardown = r; });
  const llama = createServer((req, res) => {
    req.resume();
    sawAsk();
    // Never answer. If hermes aborts the call, this connection is destroyed
    // and 'close' fires; if it does not, the race below times out.
    res.on('close', () => sawTeardown());
  });
  await new Promise((r) => llama.listen(0, '127.0.0.1', r));

  const dir = mkdtempSync(join(tmpdir(), 'hermes-cancel-test-'));
  const dbPath = join(dir, 'context.db');
  seedAcceptedClaim(dbPath);
  const server = await start({
    port: 0,
    dbPath,
    llamaApiKey: 'd'.repeat(64),
    llamaBaseUrl: `http://127.0.0.1:${llama.address().port}`,
    bearerToken: TOKEN,
  });
  try {
    const cancel = new AbortController();
    const asking = fetch(`http://127.0.0.1:${server.port}/vault/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ utterance: 'how do you get to work?' }),
      signal: cancel.signal,
    }).catch(() => null);
    await asked;
    cancel.abort();
    await asking;
    const outcome = await Promise.race([
      upstreamTornDown.then(() => 'aborted'),
      new Promise((r) => setTimeout(r, 3000, 'still generating')),
    ]);
    assert.equal(outcome, 'aborted', 'client teardown must abort the upstream llama call');
  } finally {
    llama.closeAllConnections?.();
    await new Promise((r) => llama.close(r));
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an upstream llama error answers 502 and releases the pinned connection', async () => {
  // Two properties, and the second is the one that could regress silently:
  // the !ok branch must cancel the unread error body BEFORE answering (same
  // reason as proxyLlama: undici cannot release a keep-alive connection to
  // the single-slot llama-server while a body sits unconsumed). The error
  // body here is padded past undici's buffering, because a body small enough
  // to buffer whole is released even unread and would hide the regression.
  // The wire contract is the 502 with the status named; the discriminator is
  // the first upstream socket's fate — with the cancel it is freed (torn
  // down, or drained and reused for the second ask); without it, it sits
  // pinned to the unread body and neither happens.
  let llamaConnections = 0;
  let firstSocket = null;
  let firstSocketRequests = 0;
  let sawFreed;
  const firstSocketFreed = new Promise((r) => { sawFreed = r; });
  const llama = createServer((req, res) => {
    if (req.socket === firstSocket) {
      firstSocketRequests += 1;
      if (firstSocketRequests === 2) sawFreed('reused');
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(`{"error":"loading model","padding":"${'x'.repeat(1 << 20)}"}`);
    });
  });
  llama.on('connection', (socket) => {
    llamaConnections += 1;
    if (llamaConnections === 1) {
      firstSocket = socket;
      socket.on('close', () => sawFreed('closed'));
    }
  });
  await new Promise((r) => llama.listen(0, '127.0.0.1', r));

  const dir = mkdtempSync(join(tmpdir(), 'hermes-upstream-error-test-'));
  const dbPath = join(dir, 'context.db');
  seedAcceptedClaim(dbPath);
  const server = await start({
    port: 0,
    dbPath,
    llamaApiKey: 'd'.repeat(64),
    llamaBaseUrl: `http://127.0.0.1:${llama.address().port}`,
    bearerToken: TOKEN,
  });
  try {
    for (const attempt of [1, 2]) {
      const res = await fetch(`http://127.0.0.1:${server.port}/vault/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ utterance: 'how do you get to work?' }),
      });
      assert.equal(res.status, 502, `ask ${attempt}`);
      assert.match((await res.json()).error, /llama-server returned 503/u, `ask ${attempt}`);
    }
    const outcome = await Promise.race([
      firstSocketFreed,
      new Promise((r) => setTimeout(r, 3000, 'pinned')),
    ]);
    assert.notEqual(outcome, 'pinned', 'the unread error body must not pin the keep-alive socket');
  } finally {
    llama.closeAllConnections?.();
    await server.close();
    await new Promise((r) => llama.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the abstain path never reaches llama, pinned by pointing it at a dead port', async () => {
  // The spend-nothing property, pinned against regression rather than trusted
  // to stay true. llama is aimed at a closed port: if the route called it at
  // all the request would fail, so a 200 with the abstain text is proof the
  // call never happened. Suggested by the widget session, which had it in its
  // own (now dropped) implementation -- a good catch, and cheap.
  const dir = mkdtempSync(join(tmpdir(), 'hermes-abstain-test-'));
  const server = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: 'd'.repeat(64),
    // Port 1 is reserved and nothing listens there.
    llamaBaseUrl: 'http://127.0.0.1:1',
    bearerToken: TOKEN,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const ask = (body) =>
    fetch(`${base}/vault/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
  try {
    // Nothing accepted, so retrieval abstains and the model is never asked.
    const res = await ask({ utterance: 'what do i eat?' });
    assert.equal(res.status, 200, 'a dead llama must not matter when we abstain');
    assert.deepEqual(await res.json(), {
      text: "nothing in what i've got covers that",
      sources: [],
      usedRows: 0,
    });

    // And a bad utterance is refused BEFORE retrieval, let alone the model.
    // 4xx rather than a 200 abstain, deliberately: the widget's own contract
    // requires it, and an empty question is a caller bug, not a memory gap.
    for (const body of [{}, { utterance: '' }, { utterance: '   ' }, { utterance: 42 }]) {
      const bad = await ask(body);
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
    assert.equal((await ask({ utterance: 'x'.repeat(2001) })).status, 400, 'capped, not truncated');
    assert.equal((await ask({ utterance: 'hi', extra: 1 })).status, 400, 'closed fields');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('files and notion are admissible sources, as their corpus rows always implied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-sources-test-'));
  const server = await start({
    port: 0,
    dbPath: join(dir, 'context.db'),
    llamaApiKey: 'd'.repeat(64),
    bearerToken: TOKEN,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const source of ['files', 'notion']) {
      const res = await fetch(`${base}/admin/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ source }),
      });
      assert.equal(res.status, 200, `${source} must be a known source`);
    }
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


// THE REVIEW QUEUE'S ORDER, which is the entire reason prompt v2 asks the model
// for a confidence. It used to be arrival order (c.id DESC) -- fine at a hundred
// claims and useless against a corpus this size, where the reader's attention
// runs out long before the queue does.
test('the pending queue is ordered by confidence, then newest', () => {
  const db = openDb(':memory:');
  const rows = insertRows(db, Array.from({ length: 5 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 1000,
    source: 'notes',
    entity_id: `n:${i}`,
    text: `row ${i} says i am allergic to penicillin`,
  }))) && db.prepare('SELECT id, content_hash FROM context ORDER BY id').all();

  // Inserted in an order that is neither the id order nor the p order, so a
  // passing test cannot be an accident of insertion sequence.
  const ps = [0.55, null, 0.95, 0.7, null];
  applyMemoryBatch(db, {
    run: { ...RUN, rows_in: rows.length },
    claims: rows.map((row, i) => ({
      kind: 'fact',
      text: `claim ${i}`,
      p_claim: ps[i],
      source: { context_id: Number(row.id), quote: 'allergic to penicillin', content_hash: row.content_hash },
    })),
  });

  const { claims } = pendingClaims(db, { limit: 10 });
  assert.deepEqual(
    claims.map((c) => c.text),
    ['claim 2', 'claim 3', 'claim 0', 'claim 4', 'claim 1'],
    'confidence descending, then newest-first among the unranked'
  );

  // The unranked rows sort last but are NOT lost -- they are UNKNOWN, not low.
  // Pre-v2 claims carry NULL and must still be reviewable.
  assert.deepEqual(
    claims.filter((c) => c.p_claim === null).map((c) => c.text),
    ['claim 4', 'claim 1'],
    'NULLs sink below every ranked claim, in newest-first order'
  );
  assert.equal(claims.length, 5, 'nothing is dropped for lacking a confidence');
  db.close();
});

// A MODEL THAT IS NOT RUNNING IS NOT AN APP BUG.
//
// The companion to the abstain test above. There, a dead llama does not matter
// because retrieval never calls it. Here retrieval succeeds, so the model IS
// called, and the question is what the owner is told when nothing answers.
//
// It used to be `500 {"error":"fetch failed"}`: the catch rethrew the raw
// TypeError and the generic handler shaped it. Bridge's `default:` arm turned
// every unrecognised status into "something went wrong on this app's side" --
// the app-bug string -- for a model that was merely restarting. build.sh
// kickstarts llama-server on every deploy, so this is a state owners hit.
test('a question with an answer to give reports the model as down, not as a bug', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-llamadown-test-'));
  const dbPath = join(dir, 'context.db');
  seedAcceptedClaim(dbPath);
  const server = await start({
    port: 0,
    dbPath,
    llamaApiKey: 'd'.repeat(64),
    // Port 1 is reserved and nothing listens there: a refused connection, which
    // is exactly the shape of a model mid-restart.
    llamaBaseUrl: 'http://127.0.0.1:1',
    bearerToken: TOKEN,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/vault/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ utterance: 'how do you get to work?' }),
    });
    // 503, because Bridge maps 502 and 503 to the one state whose copy says the
    // model is restarting. A 500 here is the regression.
    assert.equal(res.status, 503, 'a missing model must not read as an app bug');
    const body = await res.json();
    assert.match(body.error, /llama-server is unreachable/);
    assert.ok(!/fetch failed/.test(body.error), 'and must not leak the transport message');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The other half of the pair above: a model that ACCEPTS and never answers.
// hermes must answer before the widget's own 120s does, with a status the widget
// can render — not a 500 that reads as an app bug.
test('a model that accepts and never answers is reported as slow, not as a bug', async () => {
  const stalled = createServer((req, res) => { req.resume(); }); // never responds
  await new Promise((r) => stalled.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'hermes-llamaslow-test-'));
  const dbPath = join(dir, 'context.db');
  seedAcceptedClaim(dbPath);
  const server = await start({
    port: 0,
    dbPath,
    llamaApiKey: 'd'.repeat(64),
    llamaBaseUrl: `http://127.0.0.1:${stalled.address().port}`,
    bearerToken: TOKEN,
    // The production ceiling is 110s; the suite cannot wait that long, so the
    // route reads it from here. Same code path, a hundredth of the patience.
    askTimeoutMs: 250,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/vault/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ utterance: 'how do you get to work?' }),
    });
    assert.equal(res.status, 504, 'a silent model must not read as an app bug');
    const body = await res.json();
    assert.match(body.error, /did not answer in time/);
  } finally {
    await server.close();
    stalled.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
