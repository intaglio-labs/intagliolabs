// One policy shared with the native widget.
//
// Processing no longer pauses because the Mac is unplugged, hot, or in Low
// Power Mode. The owner chooses the workload intensity in Settings, and native
// mirrors that allow-listed value into this owner-only file. Reading one tiny
// local file at queue admission is cheaper and more truthful than forking
// `pmset`, and it lets a mode change take effect without restarting Hermes.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PERFORMANCE_FILE = join(homedir(), '.hazlie', 'performance-mode');
const MODES = new Set(['god_mode', 'battery_saver']);

export function performanceMode({ file = PERFORMANCE_FILE } = {}) {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return MODES.has(raw) ? raw : 'god_mode';
  } catch {
    // Preserve the adaptive high-performance behaviour that existed before the
    // setting. A missing/corrupt preference must not stop processing.
    return 'god_mode';
  }
}

// Retained as the admission seam used by year completion and speculative
// warming. Both modes now admit work on every power source; SummaryQueue owns
// the intensity difference through its dynamic concurrency provider.
export async function mayWarmInBackground() {
  return true;
}

// HOW LONG TO REST BETWEEN JOBS, and the reason this exists.
//
// Concurrency was the only lever battery saver had, and on most Macs it is not a
// lever at all. ops/inference-profiles.json gives summaryConcurrency 1 to both
// `compact` and `balanced`; only `performance` (24 GB, 8 cores) gets 2. So on an
// 18 GB / 12-core machine the provider resolves `battery_saver ? 1 : 1` and the
// setting does nothing whatsoever -- measured on the owner's Mac, which is
// exactly the machine the toggle was added for. PowerBudget.swift's own
// description promises "small passes, utility priority" as well; neither is
// implemented anywhere in the tree.
//
// A duty cycle works at concurrency 1, which is the point. A summary pass is
// ~90s of sustained GPU, so resting between passes is the only thing that
// lowers SUSTAINED load once you cannot run fewer of them at once. Work still
// completes -- #36 removed pausing-on-battery deliberately, because a long
// import that silently stops when someone unplugs is worse than a slow one, and
// this does not reintroduce that. It finishes; it just stops holding the machine
// at full tilt the entire time.
//
// 60s against a ~90s pass is roughly a 60% duty cycle. Not tuned against a
// thermal measurement, because nothing in this process can read one: no node
// service reads power or thermal state any more, and PowerBudget's reader lives
// in the widget. It is a deliberate, adjustable constant, not a derived value.
export const BATTERY_SAVER_REST_MS = 60_000;

export function jobRestMs({ mode = performanceMode() } = {}) {
  return mode === 'battery_saver' ? BATTERY_SAVER_REST_MS : 0;
}
