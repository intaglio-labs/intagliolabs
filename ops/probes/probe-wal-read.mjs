// Probe: can we read Apple's live WAL databases coherently, and at what cost?
//
// The connectors and the courier must read stores (chat.db, Calendar) that
// another process is actively writing. Copying db/-wal/-shm as files is not
// atomic and is banned outright; the two sanctioned modes are (a) a
// node:sqlite backup() snapshot — SQLite's Online Backup API, page-coherent
// against a live writer — and (b) a persistent read-only connection, which in
// WAL mode gets snapshot isolation per read transaction. Which mode each
// consumer uses is a cost decision, not a taste decision: the courier polls
// chat.db every ~2 seconds, and re-snapshotting a ~1 GB database on that
// cadence is presumptively unacceptable. Presumption is not measurement, so
// this probe measures, and the per-consumer decision is recorded from its
// output in ops/PROBES.md.
//
// Synthetic part (runs anywhere, no TCC): a throwaway WAL database with a
// writer child inserting continuously while the parent (a) snapshots it five
// times, asserting integrity_check=ok and a monotonic row count on every
// snapshot, and (b) holds one read-only connection, asserting that an open
// read transaction sees a frozen count while the next transaction sees the
// writer's progress.
//
// Real part (needs Full Disk Access): time ONE backup() of the live
// ~/Library/Messages/chat.db into a private path under ~/.hazlie/cache/, then
// quick_check the snapshot. FDA on this machine is granted to
// ~/.hazlie/bin/node and only attributes when launchd is the spawner, so a
// direct terminal run reports BLOCKED for this part. Full run:
//
//   launchctl submit -l com.hazlie.probe-wal-read -o <out> -e <err> \
//     -- ~/.hazlie/bin/node /path/to/ops/probes/probe-wal-read.mjs
//   (poll <out> for the RESULT line, then: launchctl remove com.hazlie.probe-wal-read)
//
// Prints counts, timings, and sizes only — never row text. No TTY assumed.
// Exit: 0 all parts PASS · 2 a part is BLOCKED by launch context · 1 FAIL.

import { backup, DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);

// --- writer child ------------------------------------------------------------
// Spawned as `node probe-wal-read.mjs --writer <dbPath> <durationMs>`. Fully
// synchronous on purpose: Atomics.wait paces inserts without an event loop, so
// the child cannot be starved into an idle WAL by its own timer bookkeeping.
if (process.argv[2] === '--writer') {
  const dbPath = process.argv[3];
  const end = Date.now() + Number(process.argv[4]);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  const ins = db.prepare('INSERT INTO t(v) VALUES (?)');
  const pace = new Int32Array(new SharedArrayBuffer(4));
  let n = 0;
  while (Date.now() < end) {
    ins.run(`synthetic-${n++}`); // synthetic content; nothing personal exists in this database
    Atomics.wait(pace, 0, 0, 4);
  }
  db.close();
  process.exit(0);
}

// --- probe harness -----------------------------------------------------------
let failures = 0;
let blocks = 0;
const pass = (part, evidence) => console.log(`PASS ${part}: ${evidence}`);
const fail = (part, evidence) => { failures += 1; console.log(`FAIL ${part}: ${evidence}`); };
const block = (part, evidence) => { blocks += 1; console.log(`BLOCKED ${part}: ${evidence}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secondsSince = (t0) => Number(process.hrtime.bigint() - t0) / 1e9;

async function syntheticPart() {
  // launchctl remove SIGKILLs a job launchd chose to re-run, and a killed run
  // never reaches its finally — observed once during the first probe run. The
  // leak is synthetic rows only, but a probe that litters is a probe nobody
  // trusts, so sweep stale siblings before creating our own. Concurrent runs
  // are not a scenario: probes are one-shot and operator-invoked.
  for (const entry of readdirSync(tmpdir())) {
    if (entry.startsWith('hazlie-probe-wal-')) {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'hazlie-probe-wal-'));
  let writer;
  let ro;
  try {
    {
      const db = new DatabaseSync(join(dir, 'src.db'));
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
      db.close();
    }
    // 20 s of writing outlives every assertion below with margin; the parent
    // kills the child the moment it is done rather than waiting it out.
    writer = spawn(process.execPath, [self, '--writer', join(dir, 'src.db'), '20000'], {
      stdio: 'ignore',
    });

    // The read-only connection cannot create WAL's -shm sidecar itself, so wait
    // until the writer's first commit has materialized it before opening.
    for (let attempt = 0; ; attempt += 1) {
      try {
        ro = new DatabaseSync(join(dir, 'src.db'), { readOnly: true });
        ro.exec('PRAGMA busy_timeout = 5000');
        if (Number(ro.prepare('SELECT count(*) AS n FROM t').get().n) > 0) break;
        ro.close();
        ro = undefined;
      } catch {
        // not ready yet
      }
      if (attempt >= 100) throw new Error('writer child produced no rows within ~5 s');
      await sleep(50);
    }
    const count = () => Number(ro.prepare('SELECT count(*) AS n FROM t').get().n);

    // (a) repeated backup() against the live writer: every snapshot must be a
    // structurally sound database, and their row counts must be monotonic —
    // a torn or stale snapshot shows up as either a failed integrity_check or
    // a count that goes backwards.
    const counts = [];
    for (let i = 0; i < 5; i += 1) {
      const snap = join(dir, `snap-${i}.db`);
      await backup(ro, snap);
      const sdb = new DatabaseSync(snap);
      const check = String(sdb.prepare('PRAGMA integrity_check').get().integrity_check);
      const n = Number(sdb.prepare('SELECT count(*) AS n FROM t').get().n);
      sdb.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(snap + suffix, { force: true });
      if (check !== 'ok') {
        fail('synthetic backup coherence', `snapshot ${i} integrity_check=${check}`);
        return;
      }
      counts.push(n);
      await sleep(150);
    }
    const monotonic = counts.every((n, i) => i === 0 || n >= counts[i - 1]);
    const advancing = counts[counts.length - 1] > counts[0];
    if (monotonic && advancing) {
      pass(
        'synthetic backup coherence',
        `5/5 snapshots integrity_check=ok under a live writer; row counts monotonic: ${counts.join(', ')}`
      );
    } else {
      fail('synthetic backup coherence', `snapshot row counts not monotonic/advancing: ${counts.join(', ')}`);
    }

    // (b) snapshot isolation on the persistent read-only connection: inside an
    // open read transaction the count must freeze even though the writer keeps
    // committing; the next transaction must see the progress.
    ro.exec('BEGIN');
    const inTxn1 = count(); // pins the snapshot (deferred BEGIN takes it at first read)
    await sleep(400);
    const inTxn2 = count();
    ro.exec('COMMIT');
    await sleep(200);
    const after = count();
    if (inTxn1 === inTxn2 && after > inTxn2) {
      pass(
        'synthetic snapshot isolation',
        `count frozen at ${inTxn1} across 400 ms inside one read txn; next txn saw ${after}`
      );
    } else {
      fail(
        'synthetic snapshot isolation',
        `in-txn counts ${inTxn1}/${inTxn2}, post-txn ${after} (expected frozen then advanced)`
      );
    }
  } finally {
    try { ro?.close(); } catch {}
    if (writer && writer.exitCode === null) {
      writer.kill('SIGKILL');
      await new Promise((r) => writer.once('exit', r));
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function realPart() {
  const chatDb = join(homedir(), 'Library', 'Messages', 'chat.db');
  let src;
  try {
    src = new DatabaseSync(chatDb, { readOnly: true });
  } catch (error) {
    block(
      'real chat.db backup timing',
      `cannot open ${chatDb} read-only (${error.message}); Full Disk Access attributes per ` +
        'responsible binary, so run this probe via launchd with ~/.hazlie/bin/node (see header)'
    );
    return;
  }
  // The snapshot transiently holds the whole message store, so it goes under
  // 0700 ~/.hazlie/cache, never a shared temp directory, and is deleted in
  // finally even when an assertion throws.
  const cacheDir = join(homedir(), '.hazlie', 'cache');
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const snap = join(cacheDir, `probe-chatdb-snapshot-${process.pid}.db`);
  try {
    const srcMb = Math.round(statSync(chatDb).size / 1048576);
    const t0 = process.hrtime.bigint();
    await backup(src, snap);
    const backupSecs = secondsSince(t0);
    const snapMb = Math.round(statSync(snap).size / 1048576);
    const sdb = new DatabaseSync(snap);
    const t1 = process.hrtime.bigint();
    const check = String(sdb.prepare('PRAGMA quick_check').get().quick_check);
    const checkSecs = secondsSince(t1);
    const chats = Number(sdb.prepare('SELECT count(*) AS n FROM chat').get().n);
    const messages = Number(sdb.prepare('SELECT count(*) AS n FROM message').get().n);
    sdb.close();
    if (check !== 'ok') {
      fail('real chat.db backup timing', `snapshot quick_check=${check}`);
      return;
    }
    pass(
      'real chat.db backup timing',
      `backup() of ${srcMb} MB took ${backupSecs.toFixed(1)} s (snapshot ${snapMb} MB, ` +
        `quick_check=ok in ${checkSecs.toFixed(1)} s, ${chats} chats, ${messages} messages)`
    );
    // The decision itself is recorded in ops/PROBES.md; this line is the input.
    console.log(
      `  decision input: ${backupSecs.toFixed(1)} s per snapshot vs a 2 s courier loop ` +
        'vs a ~2 min connector scan'
    );
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(snap + suffix, { force: true });
    try { src.close(); } catch {}
  }
}

try {
  await syntheticPart();
  await realPart();
} catch (error) {
  fail('probe-wal-read', `unexpected error: ${error.message}`);
}
const status = failures ? 'FAIL' : blocks ? 'BLOCKED' : 'PASS';
console.log(`RESULT probe-wal-read: ${status}`);
process.exit(failures ? 1 : blocks ? 2 : 0);
