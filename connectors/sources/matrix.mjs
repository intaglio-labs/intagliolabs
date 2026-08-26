// The matrix connector: the social bridges' DMs → hermes.
//
// THE MISSING HALF OF THE BRIDGE STACK, and it had been missing the whole
// time. bridges/ has run Synapse and six mautrix bridges since 2026-08; the
// connect page could log Facebook and Instagram in; and not one message ever
// reached the corpus, because nothing read Matrix. bridges/README listed this
// under "Next (not yet built)" and the context store proved it: 324k iMessage
// rows, 1.8k WhatsApp, zero from any bridged platform (owner, 2026-08-25).
//
//   entity messenger:<event_id>   one DM, one platform per row
//
// WHY /sync AND NOT PER-ROOM PAGING. Matrix's own incremental primitive is a
// sync token: hand back `next_batch` and the server returns exactly what has
// happened since. One request covers every portal room of every bridge, new
// rooms included, with no per-room cursor bookkeeping and no way to miss a
// room that appeared between runs. The token is the cursor.
//
// FIRST RUN IS A FULL SYNC, deliberately: `since` absent means Synapse returns
// the current state plus a timeline tail per room, which is the backfilled
// history the bridges pulled in (backfill is ON by owner decision, 2026-08-22).
//
// LOG POLICY (connectors/AGENTS.md): counts, room counts and cursors only —
// never message text, never a handle, never a display name.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifySender, eventToRow } from '../lib/matrixRows.mjs';

const CURSOR_KEY = 'matrix:since';
// One page is plenty per tick: the daemon comes back every few minutes, and a
// bigger page on first run just means a longer single request against a
// loopback server.
const TIMELINE_LIMIT = 500;

export function credentialsPath(home) {
  return join(home, '.hazlie', 'matrix', 'owner-credentials.json');
}

/** The owner's homeserver + token, or null when the stack was never set up. */
export function readCredentials(home) {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(home), 'utf8'));
    if (!raw?.access_token || !raw?.homeserver || !raw?.user_id) return null;
    const base = String(raw.homeserver).replace(/\/$/u, '');
    // Loopback only, the same refusal lib/bridge.mjs makes: this token is the
    // owner's Matrix account, and a homeserver value that had wandered off
    // this machine would be a token leak wearing a config's clothes.
    const host = new URL(base).hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return null;
    return { base, token: raw.access_token, userId: raw.user_id };
  } catch {
    return null;
  }
}

/**
 * Who is on the other side of each room, and what everyone is called.
 *
 * A portal room's ghost IS the conversation partner, so this both classifies
 * the room (a room with no ghost is a bridge management room — login
 * transcripts, never ingested) and supplies the names rows carry.
 */
export function readRoomMembers(state) {
  const names = new Map();
  let partner = null;
  let ghosts = 0;
  for (const ev of state ?? []) {
    if (ev?.type !== 'm.room.member') continue;
    const mxid = ev.state_key;
    const display = ev.content?.displayname;
    if (typeof mxid === 'string' && typeof display === 'string' && display) {
      names.set(mxid, display);
    }
    const who = classifySender(mxid);
    if (who?.kind === 'ghost') {
      ghosts += 1;
      // First ghost wins as "the partner"; a group's rows carry is_group and
      // the graph treats them accordingly.
      if (!partner) partner = { mxid, source: who.source, handle: who.handle };
    }
  }
  return { names, partner, isGroup: ghosts > 1 };
}

/**
 * Portal rooms the bridges have INVITED the owner to but nobody accepted.
 *
 * This is the step the whole stack was missing. mautrix creates one room per
 * conversation and invites the owner; until that invite is accepted the room
 * is not in `rooms.join`, so a sync returns six management rooms and nothing
 * else — which is exactly what this machine looked like with Facebook and
 * Instagram both "connected" (owner, 2026-08-25). A bridge client is expected
 * to accept its own bridges' invites; there was no client.
 *
 * ONLY OUR OWN BRIDGES. The inviter must be a bot or ghost in a namespace
 * declared by a bridge in this stack — auto-joining anything else would make
 * the owner's account joinable by any stranger who learned its id.
 */
export function invitesToJoin(body) {
  const out = [];
  for (const [roomId, room] of Object.entries(body?.rooms?.invite ?? {})) {
    const events = room?.invite_state?.events ?? [];
    const invite = events.find(
      (e) => e?.type === 'm.room.member' && e?.content?.membership === 'invite'
    ) ?? events.find((e) => e?.type === 'm.room.member');
    const who = classifySender(invite?.sender);
    if (who && (who.kind === 'bot' || who.kind === 'ghost')) out.push(roomId);
  }
  return out;
}

/** A /sync response → rows, newest-token included. */
export function syncToRows(body, { selfName = 'me' } = {}) {
  const rows = [];
  let rooms = 0;
  const joined = body?.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(joined)) {
    const events = room?.timeline?.events ?? [];
    if (events.length === 0) continue;
    // State comes from the sync page when present; on an incremental sync the
    // membership is usually absent, so member events in the timeline carry it.
    const { names, partner, isGroup } = readRoomMembers([
      ...(room?.state?.events ?? []),
      ...events,
    ]);
    if (!partner) continue; // management room, or a room with no bridged human
    rooms += 1;
    for (const ev of events) {
      const row = eventToRow(
        { ...ev, __partner: partner, __isGroup: isGroup },
        { roomId, names, selfName }
      );
      if (row) rows.push(row);
    }
  }
  return { rows, rooms, next: typeof body?.next_batch === 'string' ? body.next_batch : null };
}

export function createMatrixSource({ home } = {}) {
  return {
    name: 'matrix',

    needs() {
      // Nothing to declare: the credentials file IS the provisioning, and its
      // absence is reported as a clean no-op below rather than a failure —
      // an install that never set up the bridges is not broken.
      return [];
    },

    async run(ctx) {
      const resolvedHome = home ?? ctx.home ?? homedir();
      const creds = readCredentials(resolvedHome);
      if (!creds) {
        ctx.log?.info?.('matrix: no bridge credentials — skipping');
        return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      }

      const since = ctx.backfill ? null : ctx.state.getCursor(CURSOR_KEY);
      const url = new URL(`${creds.base}/_matrix/client/v3/sync`);
      url.searchParams.set('timeout', '0');
      // Room timelines only. The filter keeps presence, typing and receipts
      // off the wire entirely — this connector reads messages, and a sync
      // that also streams every read receipt is bandwidth spent to discard.
      url.searchParams.set('filter', JSON.stringify({
        presence: { types: [] },
        room: { ephemeral: { types: [] }, timeline: { limit: TIMELINE_LIMIT } },
      }));
      if (since) url.searchParams.set('since', since);
      // FULL STATE ON THE FIRST SYNC, and this is not belt-and-braces: a
      // since-less sync returned only the six management rooms while
      // /joined_rooms listed twelve, because Synapse serves a room's state in
      // an initial sync only when it has something new to report for it —
      // rooms joined moments earlier came back empty and were skipped as
      // "no partner". With full_state the same call returned all twelve and
      // the portal rooms mapped (verified 2026-08-25: 5 rooms, 9 rows).
      // Incremental syncs carry their own deltas and must NOT ask for it.
      else url.searchParams.set('full_state', 'true');

      let body;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${creds.token}` },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          // A dead homeserver is the ordinary state of this machine whenever
          // Docker is not running. Reported, not thrown: the other connectors
          // have nothing to do with it.
          ctx.log?.warn?.(`matrix: homeserver answered ${res.status}`);
          return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
        }
        body = await res.json();
      } catch (e) {
        ctx.log?.warn?.(`matrix: homeserver unreachable (${e?.name ?? 'error'})`);
        return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      }

      // Accept the bridges' portal invites BEFORE mapping this page. A newly
      // joined room's history arrives on the next sync, which the daemon runs
      // minutes later — so a first run after a login joins, and the run after
      // it ingests. Joining is idempotent; an already-joined room is a no-op.
      let joined = 0;
      for (const roomId of invitesToJoin(body)) {
        try {
          const r = await fetch(
            `${creds.base}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
            { method: 'POST',
              headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
              body: '{}',
              signal: AbortSignal.timeout(15_000) }
          );
          if (r.ok) joined += 1;
        } catch {
          // A room that will not join this tick is offered again next sync.
        }
      }
      if (joined) ctx.log?.info?.(`matrix: joined ${joined} portal room(s)`);

      const { rows, rooms, next } = syncToRows(body, { selfName: ctx.config?.selfName ?? 'me' });
      const totals = rows.length ? await ingestAll(ctx, rows) : { inserted: 0, updated: 0, unchanged: 0 };
      ctx.log?.info?.(`matrix: ${rows.length} rows from ${rooms} room(s)`);

      // The token advances only after a successful ingest, so a failed ship
      // is retried rather than skipped — the same rule every cursor here
      // follows, and the reason this one is written last.
      if (next) ctx.state.setCursor(CURSOR_KEY, next);
      return { ...totals, skipped: 0 };
    },
  };
}

async function ingestAll(ctx, rows, batchSize = 500) {
  const totals = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += batchSize) {
    const t = await ctx.ingest(rows.slice(i, i + batchSize));
    totals.inserted += t.inserted ?? t.ingested ?? 0;
    totals.updated += t.updated ?? 0;
    totals.unchanged += t.unchanged ?? 0;
  }
  return totals;
}

export default createMatrixSource();
