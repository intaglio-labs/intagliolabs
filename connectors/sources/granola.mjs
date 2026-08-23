// The granola connector: polls Granola's REST API for meeting notes and
// delivers them to hermes as entity rows (registry: ops/CONNECTORS.md).
//
//   entity granola:<note_id>          title + attendees line + summary
//   entity granola:<note_id>:t<n>     transcript chunks (≤16 KiB each),
//                                     only when config.granola.includeTranscripts
//
// Cursor (ops/CONNECTORS.md): an `updated_after` timestamp, set to the max
// updated_at seen minus a 60 s skew guard — the rewind absorbs clock drift
// between Granola's servers and this machine, and entity upsert makes the
// overlapping redelivery free (it lands as `unchanged`).
//
// KNOWN API LIMITATION, logged once per run: the API returns only notes that
// have a generated AI summary. A meeting Granola recorded but never
// summarized is invisible to this connector — the corpus can under-represent
// meetings, and nothing here can detect that.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createGranolaClient, defaultGranolaKeyPath } from '../lib/granolaClient.mjs';

// The cursor lives in the `granola:` namespace (not `granola.…`) so
// state.deleteCursors('granola') — the run.mjs --purge path — actually wipes
// it: a purged source must re-observe from scratch, not resume past its own
// absence.
export const UPDATED_AFTER_CURSOR = 'granola:updated_after';
const chunkCountCursor = (noteId) => `granola:chunks:${noteId}`;

export const TRANSCRIPT_CHUNK_BYTES = 16 * 1024;
const SKEW_GUARD_MS = 60_000;

// --- pure transforms (exported for tests) --------------------------------------

// Split transcript text into ≤maxBytes chunks, preferring newline boundaries
// so an utterance is not sliced mid-sentence; a single oversize line is
// hard-split at code-point boundaries (never mid-code-point, which would
// corrupt the UTF-8 hermes stores and FTS indexes).
export function chunkTranscript(text, maxBytes = TRANSCRIPT_CHUNK_BYTES) {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const chunks = [];
  let lines = [];
  let bytes = 0;
  const flush = () => {
    if (lines.length) {
      chunks.push(lines.join('\n'));
      lines = [];
      bytes = 0;
    }
  };
  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > maxBytes) {
      flush();
      let piece = '';
      let pieceBytes = 0;
      for (const ch of line) {
        const b = Buffer.byteLength(ch, 'utf8');
        if (pieceBytes + b > maxBytes) {
          chunks.push(piece);
          piece = '';
          pieceBytes = 0;
        }
        piece += ch;
        pieceBytes += b;
      }
      if (piece) {
        lines = [piece];
        bytes = pieceBytes;
      }
      continue;
    }
    const extra = lines.length ? lineBytes + 1 : lineBytes; // +1 for the joining \n
    if (bytes + extra > maxBytes) flush();
    lines.push(line);
    bytes += lines.length === 1 ? lineBytes : lineBytes + 1;
  }
  flush();
  return chunks;
}

const nonEmptyString = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

// Attendees, tolerantly extracted (strings, or objects carrying name/email)
// and SORTED: attendee order is semantically meaningless, arrays keep their
// order in hermes' content hash, and an unsorted list would read as an edit
// on every delivery (ops/INGESTION.md). The same sorted list feeds both the
// row text and meta so the two can never disagree.
export function extractAttendees(detail) {
  const raw = detail?.attendees ?? detail?.people ?? [];
  if (!Array.isArray(raw)) return [];
  const names = [];
  for (const a of raw) {
    const name =
      typeof a === 'string' ? a : (nonEmptyString(a?.name) ?? nonEmptyString(a?.email) ?? null);
    if (name) names.push(name);
  }
  return names.sort();
}

// The note detail's field names beyond {summary_markdown, attendees} are not
// live-verified (the one approved probe covered the /notes list envelope
// only), so every extraction here is tolerant across the plausible shapes
// and honestly null when nothing matches — never a guess presented as data.
function calendarEventOf(detail) {
  const ev = detail?.calendar_event ?? detail?.event;
  return ev && typeof ev === 'object' ? ev : null;
}

export function extractCalendarEventId(detail) {
  return nonEmptyString(calendarEventOf(detail)?.id) ?? nonEmptyString(detail?.calendar_event_id);
}

export function extractFolder(detail) {
  const one = (f) => nonEmptyString(f) ?? nonEmptyString(f?.name);
  const direct = one(detail?.folder);
  if (direct) return direct;
  const list = Array.isArray(detail?.folders) ? detail.folders.map(one).filter(Boolean).sort() : [];
  // A note can sit in several folders but meta.folder is singular (registry);
  // sorted-first keeps the pick deterministic so the content hash is stable.
  return list[0] ?? null;
}

// ts is the MEETING's start (the moment the household would remember), not
// the note's edit time: calendar event start when present, else the note's
// created time. A note with no parseable time at all is refused loudly —
// a server-defaulted ts would churn the content hash on every delivery.
export function noteStartMs(detail, listNote) {
  const ev = calendarEventOf(detail);
  const start = ev?.start;
  const candidates = [
    typeof start === 'string' ? start : null,
    nonEmptyString(start?.dateTime),
    nonEmptyString(start?.date),
    nonEmptyString(ev?.start_time),
    nonEmptyString(detail?.created_at),
    nonEmptyString(listNote?.created_at),
  ];
  for (const c of candidates) {
    if (c === null) continue;
    const ms = Date.parse(c);
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error(`granola note ${listNote?.id ?? '(unknown id)'} has no parseable start or created time`);
}

export function buildNoteRow(detail, listNote) {
  const id = listNote.id;
  const title = nonEmptyString(detail?.title) ?? nonEmptyString(listNote?.title);
  const attendees = extractAttendees(detail);
  const summary = nonEmptyString(detail?.summary_markdown) ?? nonEmptyString(detail?.summary) ?? '';
  const parts = [];
  if (title) parts.push(title);
  if (attendees.length) parts.push(`Attendees: ${attendees.join(', ')}`);
  if (summary) parts.push('', summary);
  const text = parts.join('\n').trim();
  if (!text) throw new Error(`granola note ${id} produced an empty row (no title, attendees, or summary)`);
  return {
    ts: noteStartMs(detail, listNote),
    source: 'granola',
    entity_id: `granola:${id}`,
    speaker: null, // nothing here attributes a voice; the BIPA line binds ingest too
    text,
    meta: {
      note_id: id,
      updated_at: nonEmptyString(detail?.updated_at) ?? nonEmptyString(listNote?.updated_at),
      folder: extractFolder(detail),
      attendees,
      calendar_event_id: extractCalendarEventId(detail),
    },
  };
}

// Transcript payload shapes are not live-verified either; accept a bare
// string, {transcript}, or an array of segments under the plausible keys,
// rendering "speaker: text" lines when a speaker label is present. (Speaker
// labels here are Granola's own text attribution arriving with the data —
// the sanctioned side of the no-voiceprints line.)
export function extractTranscriptText(body) {
  if (typeof body === 'string') return body;
  if (body === null || typeof body !== 'object') return '';
  if (typeof body?.transcript === 'string') return body.transcript;
  const segments = Array.isArray(body)
    ? body
    : (Array.isArray(body?.transcript) && body.transcript) ||
      (Array.isArray(body?.segments) && body.segments) ||
      (Array.isArray(body?.utterances) && body.utterances) ||
      (Array.isArray(body?.entries) && body.entries) ||
      [];
  const lines = [];
  for (const seg of segments) {
    const text =
      typeof seg === 'string'
        ? seg
        : (nonEmptyString(seg?.text) ?? nonEmptyString(seg?.content) ?? nonEmptyString(seg?.transcript));
    if (!text) continue;
    const speaker = typeof seg === 'object' ? nonEmptyString(seg?.speaker) : null;
    lines.push(speaker ? `${speaker}: ${text}` : text);
  }
  return lines.join('\n');
}

// --- the source -----------------------------------------------------------------

// Factory so tests can inject fetchImpl and a fake clock; the daemon imports
// the default export, which is the factory with everything real.
export function createGranolaSource(overrides = {}) {
  const { keyFile = defaultGranolaKeyPath(), fetchImpl, now, sleep, timeoutMs } = overrides;

  return {
    name: 'granola',

    async needs() {
      // existsSync only — the full permission gauntlet runs at read time in
      // the client; needs() answers "provisioned?", not "valid?".
      return existsSync(keyFile)
        ? []
        : [`granola API key missing: put it at ${keyFile} (0600, dir 0700)`];
    },

    async run(ctx) {
      const { state, ingest, admin, config, log, backfill } = ctx;
      const client = createGranolaClient({
        keyFile,
        cacheDir: join(ctx.cacheDir, 'granola'),
        ...(fetchImpl ? { fetchImpl } : {}),
        now: now ?? ctx.now ?? Date.now,
        ...(sleep ? { sleep } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      const includeTranscripts = config?.granola?.includeTranscripts ?? false;

      // The documented blind spot, on the record once per run.
      log.info('granola_summary_only', {
        detail: 'Granola API returns only notes with a generated AI summary; unsummarized meetings are invisible to this connector',
      });

      // Backfill paginates EVERYTHING; steady runs filter by the cursor. A
      // steady run with no cursor yet (first ever run) is also a full scan —
      // there is no high-water mark to pin to, and unlike chat.db the note
      // corpus is small and bounded.
      const updatedAfter = backfill ? null : state.getCursor(UPDATED_AFTER_CURSOR);

      const listed = [];
      let cursor;
      const seenCursors = new Set();
      for (;;) {
        const page = await client.listNotes({ updatedAfter: updatedAfter ?? undefined, cursor });
        if (!Array.isArray(page?.notes)) {
          throw new Error('granola /notes response is missing the notes array');
        }
        listed.push(...page.notes);
        if (page.hasMore !== true) break;
        // Both guards refuse loudly instead of looping forever against a
        // paid, rate-limited API: hasMore without a cursor cannot advance,
        // and a repeated cursor would re-fetch the same page until the
        // process dies.
        if (!nonEmptyString(page.cursor)) {
          throw new Error('granola /notes claims hasMore but sent no cursor');
        }
        if (seenCursors.has(page.cursor)) {
          throw new Error('granola /notes pagination repeated a cursor; refusing to loop');
        }
        seenCursors.add(page.cursor);
        cursor = page.cursor;
      }
      log.info('granola_listed', { count: listed.length, backfill: Boolean(backfill) });

      const rows = [];
      // Per-note transcript bookkeeping, applied only AFTER the ingest
      // succeeds: deleting stale chunks or advancing chunk counts for rows
      // hermes never received would lie about what the corpus holds.
      const chunkPlans = [];
      let maxUpdatedMs = null;

      for (const item of listed) {
        if (!nonEmptyString(item?.id)) throw new Error('granola /notes returned an item without an id');
        const detail = await client.getNote(item.id);
        const row = buildNoteRow(detail, item);
        rows.push(row);
        const updatedMs = Date.parse(row.meta.updated_at ?? '');
        if (Number.isFinite(updatedMs)) {
          maxUpdatedMs = maxUpdatedMs === null ? updatedMs : Math.max(maxUpdatedMs, updatedMs);
        }

        if (includeTranscripts) {
          let transcriptBody = null;
          try {
            transcriptBody = await client.getTranscript(item.id);
          } catch (error) {
            // A note without a transcript is a fact, not a failure — but it
            // still means "zero chunks", so stale ones from an earlier, longer
            // transcript must go.
            if (error?.status !== 404) throw error;
          }
          const chunks = chunkTranscript(extractTranscriptText(transcriptBody));
          chunks.forEach((text, n) => {
            rows.push({
              ts: row.ts,
              source: 'granola',
              entity_id: `granola:${item.id}:t${n}`,
              speaker: null,
              text,
              meta: { note_id: item.id, chunk: n, chunks: chunks.length, updated_at: row.meta.updated_at },
            });
          });
          chunkPlans.push({ noteId: item.id, count: chunks.length });
        }
      }

      const totals = rows.length > 0 ? await ingest(rows) : { inserted: 0, updated: 0, unchanged: 0 };

      // Stale-chunk reconciliation: upsert cannot express "the transcript got
      // shorter", so when this delivery produced fewer chunks than the last
      // one, the tail entities are deleted through hermes' admin route.
      // (Idempotent: re-deleting an absent id deletes zero rows, so a crash
      // between ingest and here just repeats harmlessly next run.)
      let deleted = 0;
      for (const { noteId, count } of chunkPlans) {
        const previous = Number(state.getCursor(chunkCountCursor(noteId)) ?? '0');
        const previousCount = Number.isFinite(previous) ? previous : 0;
        if (count < previousCount) {
          const staleIds = [];
          for (let n = count; n < previousCount; n += 1) staleIds.push(`granola:${noteId}:t${n}`);
          deleted += (await admin.deleteEntities({ source: 'granola', entityIds: staleIds })).deleted;
        }
        state.setCursor(chunkCountCursor(noteId), String(count));
      }

      // Advance the cursor LAST, and only off timestamps hermes has actually
      // accepted — a run that failed above resumes from the old mark and the
      // overlap redelivers as `unchanged`. The 60 s rewind is the skew guard.
      if (maxUpdatedMs !== null) {
        state.setCursor(UPDATED_AFTER_CURSOR, new Date(maxUpdatedMs - SKEW_GUARD_MS).toISOString());
      }

      return {
        ingested: totals.inserted,
        updated: totals.updated,
        unchanged: totals.unchanged,
        deleted,
      };
    },
  };
}

export default createGranolaSource();
