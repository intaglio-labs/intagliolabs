// storeReader against a synthetic WAL database with a REAL concurrent writer
// in a child process — the scenario the module exists for is "Messages is
// writing while we read", and an in-process writer would not exercise the
// cross-process locking that makes file-copying unsafe in the first place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPersistentReader, snapshotStore } from '../lib/storeReader.mjs';

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'connectors-store-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createWalDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE pairs(a INTEGER NOT NULL, b INTEGER NOT NULL)');
  db.close();
}

// The child writes rows (i, i*2) in individual transactions, continuously,
// until the stop file appears — so the snapshot below is guaranteed to run
// against an ACTIVE writer rather than a quiescent file.
const WRITER_SCRIPT = `
import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
const [, , dbPath, stopPath, readyPath] = process.argv;
const db = new DatabaseSync(dbPath);
const ins = db.prepare('INSERT INTO pairs(a, b) VALUES (?, ?)');
let i = 0;
for (; !existsSync(stopPath) && i < 500000; i += 1) {
  db.exec('BEGIN');
  ins.run(i, i * 2);
  db.exec('COMMIT');
  if (i === 200) writeFileSync(readyPath, 'ready');
}
db.close();
process.stdout.write(String(i));
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('snapshotStore takes a coherent snapshot while a child process is writing', async (t) => {
  const dir = sandbox(t);
  const srcPath = join(dir, 'chat.db');
  const stopPath = join(dir, 'stop');
  const readyPath = join(dir, 'ready');
  const writerPath = join(dir, 'writer.mjs');
  const cacheDir = join(dir, 'cache');
  createWalDb(srcPath);
  writeFileSync(writerPath, WRITER_SCRIPT);

  const child = spawn(process.execPath, [writerPath, srcPath, stopPath, readyPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let written = '';
  child.stdout.on('data', (d) => (written += d));
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
  });

  try {
    // Wait for the writer to be demonstrably mid-stream before snapshotting.
    for (let i = 0; i < 200 && !statSafe(readyPath); i += 1) await sleep(25);
    assert.ok(statSafe(readyPath), 'writer never reached 200 rows');

    const snapshotPath = await snapshotStore(srcPath, cacheDir);

    // Let the writer demonstrably outrun the snapshot before stopping it, so
    // the point-in-time assertion below has room to bite.
    await sleep(75);
    writeFileSync(stopPath, 'stop');
    await exited;

    assert.equal(snapshotPath, join(cacheDir, 'chat.db.snapshot'));
    assert.equal(statSync(cacheDir).mode & 0o777, 0o700);
    assert.equal(statSync(snapshotPath).mode & 0o777, 0o600);

    const snap = new DatabaseSync(snapshotPath, { readOnly: true });
    t.after(() => snap.close());
    // Coherent means: structurally sound, every row intact, and the row set
    // is an exact prefix of the writer's sequence — no torn row, no gap, no
    // mixed epochs. A file-copy under a live writer fails these.
    assert.equal(snap.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const { n, maxA, broken } = snap
      .prepare(
        'SELECT count(*) AS n, max(a) AS maxA, ' +
          'sum(CASE WHEN b != a * 2 THEN 1 ELSE 0 END) AS broken FROM pairs'
      )
      .get();
    assert.ok(Number(n) >= 200, `snapshot holds ${n} rows`);
    assert.equal(Number(broken), 0);
    assert.equal(Number(n), Number(maxA) + 1); // contiguous prefix of 0..maxA
    // ...and it is a point-in-time copy, not a view: the writer went on past it.
    assert.ok(Number(written) > Number(n), `writer wrote ${written}, snapshot froze at ${n}`);
  } finally {
    writeFileSync(stopPath, 'stop');
    await exited.catch(() => {});
  }
});

function statSafe(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

test('snapshotStore refuses a missing source instead of minting an empty database', async (t) => {
  const dir = sandbox(t);
  await assert.rejects(snapshotStore(join(dir, 'no-such.db'), join(dir, 'cache')), /ENOENT/);
});

test('openPersistentReader gives per-transaction snapshot isolation under WAL', (t) => {
  const dir = sandbox(t);
  const srcPath = join(dir, 'live.db');
  createWalDb(srcPath);
  const writer = new DatabaseSync(srcPath);
  t.after(() => writer.close());
  const ins = writer.prepare('INSERT INTO pairs(a, b) VALUES (?, ?)');
  for (let i = 0; i < 10; i += 1) ins.run(i, i * 2);

  const reader = openPersistentReader(srcPath);
  t.after(() => reader.close());
  const count = () => Number(reader.prepare('SELECT count(*) AS n FROM pairs').get().n);

  // Inside one explicit read transaction the view is frozen even while the
  // writer commits — this is the property that makes a 2 s polling loop safe
  // without ever blocking the store's owner.
  reader.exec('BEGIN');
  const before = count();
  assert.equal(before, 10);
  for (let i = 10; i < 15; i += 1) ins.run(i, i * 2);
  assert.equal(count(), before);
  reader.exec('COMMIT');
  // A NEW transaction sees the writer's commits.
  assert.equal(count(), 15);
});

test('the persistent reader is genuinely read-only', (t) => {
  const dir = sandbox(t);
  const srcPath = join(dir, 'ro.db');
  createWalDb(srcPath);
  const reader = openPersistentReader(srcPath);
  t.after(() => reader.close());
  assert.throws(() => reader.exec('INSERT INTO pairs(a, b) VALUES (1, 2)'), /readonly/i);
});

test('a store that cannot be opened read-only names the snapshot fallback', (t) => {
  const dir = sandbox(t);
  assert.throws(
    () => openPersistentReader(join(dir, 'absent.db')),
    (error) => {
      assert.match(error.message, /read-only/);
      assert.match(error.message, /snapshotStore/);
      assert.match(error.message, /PROBES\.md/);
      return true;
    }
  );
});
