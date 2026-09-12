// THE DAEMON LOCK FILE, DEFINED ONCE.
//
// ~~connectors/daemon.mjs held the path, the JSON shape and processIsAlive;
// connect/lib/status.mjs held a byte-for-byte copy of the liveness check and
// its own inline join() for the path.~~ Two packages reading one file with no
// shared definition is a format that drifts on the next field: the lock has
// carried `startedTs` and `token` since the day it was written and the copy in
// connect read neither, which is exactly how a PID-reuse check gets skipped.
// The daemon still OWNS the file — only acquireDaemonLock writes it — but the
// answer "is that daemon still running" is asked from both packages and is
// therefore defined here. connect already imports features.mjs and
// googleAccounts.mjs from this directory; this is the same lane.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultDaemonLockPath(home = homedir()) {
  return join(home, '.hazlie', 'connectors', 'daemon.lock');
}

/// Three answers, not two, because the two callers want different halves.
///
///   'alive'   — this user has a process with that pid.
///   'foreign' — a process exists but belongs to another user (EPERM).
///   'dead'    — no such process (ESRCH), or the pid is not a pid.
///
/// acquireDaemonLock must not STEAL a lock from a foreign process, so it reads
/// 'foreign' as occupied. daemonLockIsLive must not BELIEVE one, because the
/// daemon runs as the owner: a foreign pid holding the recycled number is
/// positive evidence that our daemon is gone, not evidence that it is running.
export function processState(pid) {
  if (!Number.isInteger(pid) || pid < 2) return 'dead';
  try {
    process.kill(pid, 0); // signal 0 tests for the process, it does not signal it
    return 'alive';
  } catch (error) {
    return error?.code === 'EPERM' ? 'foreign' : 'dead';
  }
}

/// Kept for the lock-acquisition side: a foreign process is still a process,
/// and a lock we cannot prove is dead is a lock we leave alone.
export function processIsAlive(pid) {
  return processState(pid) !== 'dead';
}

/// HOW LONG ONE `ps` ANSWER IS GOOD FOR (round-4 finding 12).
///
/// A process's start time never changes while it is running, so the only thing
/// a cache can get wrong is a pid that died and was recycled inside the window
/// -- and the caller has already asked the kernel whether the pid is alive
/// before it gets here. Ten seconds is short against the staleness window this
/// feeds (tens of minutes) and long against connect's poll, which is the point:
/// the cost moves from one fork PER REQUEST to one fork per ten seconds.
const START_CACHE_MS = 10_000;
const startCache = new Map();

/// When the OS says the process with this pid started, in epoch ms, or null if
/// it cannot be determined. `ps -o lstart=` is second-resolution and local
/// time, which is all this needs: the question is whether the pid was recycled
/// (minutes to days later), never a sub-second comparison.
///
/// MEMOISED, because this is a SYNCHRONOUS SUBPROCESS ON A REQUEST PATH.
/// connect's daemonRegistryState calls it through daemonLockIsLive whenever the
/// activity file is stale -- which is precisely the state an owner sits and
/// polls -- and a 2s-timeout `execFileSync` there blocks connect's event loop
/// for every one of those requests. The freshness-first ordering already spares
/// the healthy case; this spares the case that actually polls.
export function processStartedAt(pid, { now = Date.now } = {}) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  const at = now();
  const hit = startCache.get(pid);
  if (hit !== undefined && at - hit.at < START_CACHE_MS) return hit.value;
  // One daemon, one pid: the map is bounded by clearing it rather than by
  // evicting, so a long-lived connect process cannot accumulate dead pids.
  if (startCache.size > 16) startCache.clear();
  let value = null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    const parsed = out ? Date.parse(out) : NaN;
    value = Number.isFinite(parsed) ? parsed : null;
  } catch {
    value = null;
  }
  startCache.set(pid, { at, value });
  return value;
}

/// For tests and for anything that has just killed or started a daemon and
/// needs the next answer to come from the OS rather than from the window above.
export function forgetProcessStart(pid = null) {
  if (pid === null) startCache.clear();
  else startCache.delete(pid);
}

export function readDaemonLock({ home = homedir() } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(defaultDaemonLockPath(home), 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pid = Number(raw.pid);
  return {
    pid: Number.isInteger(pid) ? pid : null,
    token: typeof raw.token === 'string' ? raw.token : null,
    startedTs: Number.isFinite(Number(raw.startedTs)) ? Number(raw.startedTs) : null,
  };
}

// `ps` truncates to the second and the lock is written AFTER the process
// starts, so the honest expectation is procStart <= startedTs. The slack
// absorbs that truncation plus any clock adjustment between the two readings;
// a recycled pid is minutes or days out, never two seconds.
const START_SLACK_MS = 2_000;

/// IS THE DAEMON THAT WROTE THIS LOCK STILL RUNNING?
///
/// A live pid is NOT the answer on its own. A hard-killed daemon leaves the
/// lock behind — it is cleared only by the CLI owner-PID watch or by the next
/// acquireDaemonLock — so once the OS recycles that pid, "the pid is alive"
/// starts asserting that a dead process is running. That assertion had teeth:
/// connect/lib/status.mjs believes a live lock over the activity file's age,
/// so the shelf told the owner to restart the app about a registry state no
/// process was standing behind any more.
///
/// So the pid must ALSO have started no later than the lock claims it did.
/// Undeterminable start time is read as not-live: this answer only ever
/// silences a notice, and going quiet about a daemon we cannot vouch for is
/// the direction that cannot invent an alarm.
export function daemonLockIsLive({
  home = homedir(),
  startedAt = processStartedAt,
  state = processState,
} = {}) {
  const lock = readDaemonLock({ home });
  if (lock === null || lock.pid === null) return false;
  if (state(lock.pid) !== 'alive') return false;
  // An older daemon's lock has no startedTs to check against. It is the same
  // pid-reuse risk, and the same fail-quiet answer: the activity file's own
  // mtime is left to decide.
  if (lock.startedTs === null) return false;
  const began = startedAt(lock.pid);
  if (!Number.isFinite(began)) return false;
  return began <= lock.startedTs + START_SLACK_MS;
}
