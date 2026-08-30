// Is this a good moment to spend the owner's battery on background inference?
//
// WHY THIS EXISTS. Opening a People year enqueues every person on the page with
// at least MIN_ROWS messages for a full hierarchical summary — several local
// model calls each, and for one 11,765-message friendship that is 35 chunks
// before the reduce even starts. On 2026-08-30 the owner opened one year and
// reported "my fans are on full blast", with the row still reading
// "reading January · 1/35…".
//
// The summary queue had no notion of power at all. PowerBudget.swift has read
// isLowPowerModeEnabled and thermalState since 2026-08-25 and gates the
// distiller with them, but it lives in the widget; hermes is a separate node
// process and knew none of it. Background work that cannot see the battery is
// background work that flattens it.
//
// PAUSING IS NOT THIS. The summary queue already pauses for /vault/ask — that is
// CONTENTION, keeping a typed question ahead of background work. This is POWER,
// and the two are independent: a machine can be idle and still on battery.
//
// Cheap and cached. `pmset -g batt` is a fork per call, so the answer is held
// for a window; nothing here is on a hot path and a stale answer costs at most
// one queue admission.

import { execFile } from 'node:child_process';

const TTL_MS = 30_000;
let cached = { at: 0, value: null };

function read() {
  return new Promise((resolve) => {
    // -g batt names the source ("AC Power" / "Battery Power") and, on a laptop,
    // the percentage. A machine with no battery reports AC, which is what we
    // want: a desktop should never be throttled by this.
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 4000 }, (err, out) => {
      if (err || typeof out !== 'string') {
        // UNKNOWN IS PERMISSIVE, deliberately. If this cannot be read the app
        // must not silently stop summarising forever; the failure mode of a
        // wrong "yes" is a warm laptop, and of a wrong "no" is a feature that
        // never works and nobody can explain.
        resolve({ onAC: true, percent: null, known: false });
        return;
      }
      const onAC = /AC Power/iu.test(out);
      const m = out.match(/(\d+)%/u);
      resolve({ onAC, percent: m ? Number(m[1]) : null, known: true });
    });
  });
}

export async function powerState({ now = Date.now(), ttlMs = TTL_MS } = {}) {
  if (cached.value && now - cached.at < ttlMs) return cached.value;
  const value = await read();
  cached = { at: now, value };
  return value;
}

/** For tests, and for a caller that has just changed the machine's state. */
export function resetPowerCache() {
  cached = { at: 0, value: null };
}

// May we warm summaries nobody has asked for yet?
//
// On AC: yes. On battery: no — and this is the whole point. A person the owner
// actually opens is FOREGROUND work at priority 2 and is never gated here, so
// the feature keeps working on battery; it just stops speculatively summarising
// everyone else on the page.
export async function mayWarmInBackground(opts = {}) {
  const p = await powerState(opts);
  return p.onAC === true;
}
