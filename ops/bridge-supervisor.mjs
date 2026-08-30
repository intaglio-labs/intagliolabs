// Keep Synapse and the mautrix bridges running, as ONE background item.
//
// WHY THIS EXISTS RATHER THAN EIGHT LAUNCHD AGENTS.
//
// Supervising them with launchd directly worked and was wrong in a way that
// only showed up on the owner's screen: macOS Login Items grew eight entries
// reading "mautrix-discord-darwin-arm64 can run in the background", "python can
// run in the background", and so on -- eight programs the owner never installed
// by name, listed separately from the app that installed them.
//
// AssociatedBundleIdentifiers is the key that groups a background item under an
// app, and every one of those plists carried it. macOS ignored it, because it
// only honours that key when the job's program is signed with the SAME TEAM as
// the bundle it names. Measured: ~/.hazlie/bin/node is TeamIdentifier
// 5K43Q6FF67 and its agents (hermes, connect) group silently under intaglio
// labs; the mautrix binaries and Synapse's CPython are ad-hoc with no team at
// all, so macOS falls back to naming the executable.
//
// Three ways out, and why this one:
//
//   Ship and sign the binaries.  Legitimate -- they would genuinely be ours --
//     but it is 305 MB of bridges plus a 272 MB Synapse runtime on top of a
//     456 MB installer, and conveying the AGPL binaries rather than fetching
//     them changes our source-offer obligations. A big decision to buy a label.
//
//   A signed shim that execs the real binary.  Rejected. The team check exists
//     precisely so an app cannot present someone else's unsigned binary as its
//     own; defeating it with a wrapper is circumventing a disclosure control,
//     not fixing anything.
//
//   THIS: one launchd agent running the node we already ship and already sign,
//     which starts the eight processes as its own children. The background item
//     is honestly ours, because it is our code. The children are ordinary child
//     processes -- exactly what they were before launchd supervised them, when
//     they were children of the setup script and produced no Login Items at all.
//
// What is NOT given up is the reason launchd was reached for: a crashed bridge
// still comes back, and the stack still survives a reboot, because this process
// is itself a KeepAlive+RunAtLoad agent. It re-implements the small part of
// launchd that was actually load-bearing (restart with a floor on the rate) and
// nothing else.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const M = join(HOME, '.hazlie', 'matrix');
const BIN = join(HOME, '.hazlie', 'bridges', 'bin');
const SYN = join(HOME, '.hazlie', 'bridges', 'synapse');
const RUN = join(HOME, '.hazlie', 'bridges', 'run');

// THE SAME TABLE ops/setup-bridges-native.sh PROVISIONS FROM. Duplicated rather
// than imported because that file is POSIX sh and this is node; the setup
// script is the one that writes configs, so if these ever disagree the symptom
// is a bridge that never starts and says why in its own log.
const BRIDGES = [
  ['meta', 'mautrix-meta-darwin-arm64'],
  ['instagram', 'mautrix-instagram-darwin-arm64'],
  ['twitter', 'mautrix-twitter-darwin-arm64'],
  ['telegram', 'mautrix-telegram-darwin-arm64'],
  ['slack', 'mautrix-slack-darwin-arm64'],
  ['linkedin', 'mautrix-linkedin-darwin-arm64'],
  ['discord', 'mautrix-discord-darwin-arm64'],
];

// The floor launchd enforces on its own ThrottleInterval, kept for the same
// reason: a process that cannot start -- a bad config, a port already held --
// would otherwise respawn as fast as the loop allows, burning CPU and filling
// its log while looking, from outside, like a running service.
const RESTART_FLOOR_MS = 60_000;

const children = new Map();
let stopping = false;

const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

/**
 * Where a child's own output goes. Each keeps the per-bridge log path the setup
 * script already points people at, so `tail -f ~/.hazlie/bridges/run/meta.log`
 * keeps working across this change.
 */
function logFd(name) {
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  return openSync(join(RUN, `${name}.log`), 'a', 0o600);
}

function start(name, program, args, cwd) {
  if (stopping) return;
  if (!existsSync(program)) {
    log(`${name}: ${program} is missing — not started`);
    return;
  }
  let fd;
  try {
    fd = logFd(name);
  } catch (err) {
    log(`${name}: cannot open its log (${err.message}) — not started`);
    return;
  }
  // cwd MATTERS, and finding that out cost a release. mautrix's generated
  // config has a file-logger writer with a RELATIVE path; a process with no
  // working directory of its own inherits one it has no right to write to, and
  // every bridge exits with "mkdir logs: read-only file system". Its own state
  // directory is where that path was always meant to resolve.
  const child = spawn(program, args, {
    cwd,
    stdio: ['ignore', fd, fd],
    detached: false,
  });
  const startedAt = Date.now();
  children.set(name, child);
  log(`${name}: started (pid ${child.pid})`);

  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    const ran = Date.now() - startedAt;
    const wait = ran >= RESTART_FLOOR_MS ? 0 : RESTART_FLOOR_MS - ran;
    log(`${name}: exited (${signal ?? `code ${code}`}) after ${Math.round(ran / 1000)}s;`
      + ` restarting in ${Math.round(wait / 1000)}s`);
    setTimeout(() => start(name, program, args, cwd), wait).unref?.();
  });
  child.on('error', (err) => log(`${name}: could not spawn (${err.message})`));
}

/**
 * A bridge whose config still holds mautrix's example api_id has no credential
 * the owner has supplied yet. Starting it achieves nothing a restart can fix,
 * so it is left alone until setup or the widget's walkthrough writes one --
 * the same rule setup-bridges-native.sh applies when it declines to load that
 * agent.
 */
function telegramUnconfigured() {
  try {
    const cfg = join(M, 'telegram', 'config.yaml');
    if (!existsSync(cfg)) return true;
    const text = readFileSync(cfg, 'utf8');
    return /^\s*api_id:\s*12345\s*$/mu.test(text);
  } catch {
    return false;
  }
}

function startAll() {
  const py = join(SYN, 'venv', 'bin', 'python');
  start('synapse', py,
    ['-m', 'synapse.app.homeserver', '--config-path', join(M, 'synapse', 'homeserver.yaml')],
    join(M, 'synapse'));

  for (const [name, binary] of BRIDGES) {
    if (name === 'telegram' && telegramUnconfigured()) {
      log('telegram: no api_id yet — not started');
      continue;
    }
    start(name, join(BIN, binary),
      ['-c', join(M, name, 'config.yaml'), '-r', join(M, name, 'registration.yaml'), '-n'],
      join(M, name));
  }
}

// SIGTERM is how launchd stops this, and how `setup-bridges-native.sh --stop`
// stops it. Children are not in their own process group, so they do not receive
// it automatically: pass it on, or a stop leaves eight orphans holding the
// ports and the next start fails on every one of them.
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`supervisor: ${signal} — stopping ${children.size} children`);
  for (const [name, child] of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      log(`${name}: could not signal it`);
    }
  }
  const deadline = Date.now() + 15_000;
  const check = setInterval(() => {
    if (children.size === 0 || Date.now() > deadline) {
      clearInterval(check);
      for (const [, child] of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      log('supervisor: stopped');
      process.exit(0);
    }
  }, 500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log('supervisor: starting the local Matrix stack');
startAll();
