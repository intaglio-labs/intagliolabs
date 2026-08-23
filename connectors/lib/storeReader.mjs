// Sanctioned reads of Apple's live SQLite stores (chat.db, the Calendar and
// AddressBook stores). There are exactly two modes, and file-copying is not
// one of them: copying db/-wal/-shm as three separate files is NOT atomic —
// Messages can checkpoint between the copies and the result is a torn
// database that opens fine and lies. Which consumer uses which mode is a
// measured decision recorded per store in ops/PROBES.md (the Phase 2 perf
// probe); the rule of thumb it encodes is snapshot for infrequent bulk scans,
// persistent reader for tight loops — repeatedly backing up a ~1 GB chat.db
// every 2 s is presumptively unacceptable.
import { chmodSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mode (a): a coherent point-in-time snapshot into our own 0700 cache dir,
// via SQLite's Online Backup API (node:sqlite's module-level backup()). The
// Backup API is coherent against a live writer by design: if the source
// changes mid-copy it restarts the pass rather than mixing epochs, which is
// exactly the property a file copy lacks. The source is opened READ-ONLY so
// a bug here cannot write, lock-escalate on, or create sidecars beside a
// store Apple's own daemons consider theirs.
//
// Retried once: a busy writer can hold the source in a state where the first
// pass fails (locked checkpoint), and one immediate retry after a short wait
// clears the overwhelmingly common case without hiding a real failure behind
// an infinite loop.
//
// Returns the snapshot's path. The snapshot lands via tmp-file + rename so a
// crash mid-backup can never leave a plausible-looking half file at the
// stable name; the previous snapshot stays readable until the new one is
// complete.
export async function snapshotStore(srcPath, cacheDir) {
  statSync(srcPath); // fail with ENOENT now, not inside the backup machinery
  const previousUmask = process.umask(0o077);
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const cacheMode = statSync(cacheDir).mode & 0o777;
    if (cacheMode !== 0o700) {
      throw new Error(
        `snapshot cache directory must have mode 0700: ${cacheDir} is ${cacheMode.toString(8)}`
      );
    }
  } finally {
    process.umask(previousUmask);
  }
  const destPath = join(cacheDir, `${basename(srcPath)}.snapshot`);
  const tmpPath = `${destPath}.tmp-${process.pid}`;

  let src;
  try {
    src = new DatabaseSync(srcPath, { readOnly: true });
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await sleep(250);
      rmSync(tmpPath, { force: true });
      try {
        await backup(src, tmpPath);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError !== undefined) {
      throw Object.assign(
        new Error(`backup of ${srcPath} failed twice: ${lastError.message}`),
        { cause: lastError }
      );
    }
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, destPath);
    return destPath;
  } finally {
    try {
      src?.close();
    } catch {}
    rmSync(tmpPath, { force: true });
  }
}

// Mode (b): a persistent READ-ONLY connection to the live store, for tight
// loops (the courier's 2 s chat.db poll). Under WAL every read statement (or
// explicit BEGIN...COMMIT) gets per-transaction snapshot isolation, so the
// reader sees a coherent database without ever blocking Messages' writer —
// keep multi-statement reads inside one explicit transaction when they must
// agree with each other.
//
// The missing -shm edge: when the owning app is closed and the store has a
// -wal but no -shm, a read-only connection cannot recover the WAL (recovery
// writes the -shm, which read-only refuses), and the open or first read fails
// with SQLITE_CANTOPEN/SQLITE_READONLY_RECOVERY. That is a state of the
// store, not of this code: the caller falls back to snapshotStore() or waits
// for the owner to run — the per-store decision is in ops/PROBES.md.
export function openPersistentReader(srcPath) {
  try {
    return new DatabaseSync(srcPath, { readOnly: true });
  } catch (error) {
    throw Object.assign(
      new Error(
        `cannot open ${srcPath} read-only: ${error.message}. ` +
          'If the owning app is closed, the store may hold a -wal without its -shm, ' +
          'which a read-only connection cannot recover; take a snapshotStore() copy instead ' +
          '(per-store guidance: ops/PROBES.md).'
      ),
      { cause: error }
    );
  }
}
