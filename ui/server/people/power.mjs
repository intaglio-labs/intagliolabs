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
