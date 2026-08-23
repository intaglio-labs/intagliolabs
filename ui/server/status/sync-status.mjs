// "am i up to date?" as a live query surface. The iMessage push side that
// once delivered these alerts (courier/watch.mjs) was retired 2026-08-21 —
// Hazlie no longer texts its user — so this PULL surface is now the ONLY way
// freshness reaches the owner: asked through the widget, on demand, and
// rendered as a status.
//
// WHY IT SHARES THE WATCHDOG'S POLICY, not its own copy: staleness thresholds,
// per-source signals (rows vs run), labels and remedies are all defined once in
// ./watchdog.mjs. If this module re-implemented them, the answer the
// owner reads on demand could disagree with the alert they get pushed — the one
// thing a health surface must never do. So it imports that policy and only adds
// the rendering.
//
// All code, no model: reads two SQLite stores read-only, computes ages, formats
// a string. Nothing is sent to a model and no row content is read — only
// timestamps — so this cannot hallucinate a status or leak a message.

import {
  STALE_AFTER_MS,
  SIGNAL,
  LABEL,
  REMEDY,
  collectLastSeen,
  evaluate,
} from './watchdog.mjs';

// question -> true when this is a sync/freshness status question. Narrow on
// purpose: it must not swallow "what's the latest from Dana" (an episodic
// content question) — it fires only on freshness/currency language ABOUT the
// sync itself.
export function detectSyncStatus(question) {
  const q = String(question ?? '').toLowerCase().trim();
  // "up to date", "am i current", "sync status", "is anything stale/behind",
  // "when did you last see", "are my messages syncing", "how fresh is X".
  const freshness =
    /\b(up to date|up-to-date|in sync|syncing|sync status|out of (date|sync)|stale|behind|falling behind|fallen behind|current on|caught up|last (sync|see|seen|update|refresh))\b/u.test(
      q
    );
  if (!freshness) return false;
  // Guard: it should be about the data/sources, not a person's own status
  // ("is Dana up to date on the deal"). Require a sync/data word nearby, or a
  // bare status phrasing with no person object.
  const aboutSync =
    /\b(messages?|whatsapp|imessage|mail|email|linkedin|calendar|data|sources?|connectors?|everything|you|hazlie|sync)\b/u.test(
      q
    ) || /^(are we|am i|is anything|what'?s? (stale|behind)|status)\b/u.test(q);
  return aboutSync;
}

function humanAge(ms) {
  if (ms < 90 * 60 * 1000) return 'just now';
  const h = Math.round(ms / 3600000);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} days ago`;
  return `${Math.round(d / 30)} months ago`;
}

// The word for what the signal measured, so "last new message 66 days ago" reads
// truthfully for a rows-source and "last synced" for a run-source.
function seenPhrase(source) {
  return SIGNAL[source] === 'rows' ? 'last new item' : 'last synced';
}

// A friendlier per-source phrase for the "current" line — the label already
// carries the noun ("your whatsapp"), so this is just the freshness.
function currentLine(source, age, label) {
  return `${label} (${humanAge(age)})`;
}

// The one call the ask route uses. Returns { text, sources, count } or null when
// the question is not a sync-status question (caller falls through).
export function answerSyncStatus(contextDb, stateDb, { now = Date.now() } = {}) {
  const lastSeen = collectLastSeen({ contextDb, stateDb });
  const { state } = evaluate({ lastSeen, now });

  const stale = [];
  const fresh = [];
  for (const source of Object.keys(STALE_AFTER_MS)) {
    const seen = lastSeen[source];
    if (seen == null) continue; // absent — a source not connected is not "behind"
    const age = now - seen;
    if (state[source] === 'stale') stale.push({ source, age });
    else fresh.push({ source, age });
  }

  stale.sort((a, b) => b.age - a.age); // worst (oldest) first
  fresh.sort((a, b) => a.age - b.age); // freshest first

  const freshSummary = fresh
    .map(({ source, age }) => currentLine(source, age, LABEL[source] ?? source))
    .join(', ');

  let text;
  if (stale.length === 0) {
    text = `you're up to date — every connected source is current.\ncurrent: ${freshSummary}.`;
  } else {
    const noun = stale.length === 1 ? 'source is' : 'sources are';
    const bullets = stale
      .map(({ source, age }) => {
        const label = LABEL[source] ?? source;
        const remedy = REMEDY[source];
        return `• ${label} — ${seenPhrase(source)} ${humanAge(age)}.${remedy ? ` ${remedy}.` : ''}`;
      })
      .join('\n');
    const tail = freshSummary ? `\neverything else is current: ${freshSummary}.` : '';
    text = `message sync — ${stale.length} ${noun} behind:\n${bullets}${tail}`;
  }

  return {
    text,
    sources: [...stale, ...fresh].map((s) => s.source).sort(),
    count: stale.length,
    stale: stale.map((s) => s.source),
  };
}
