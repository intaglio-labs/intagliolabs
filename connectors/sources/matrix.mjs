// The matrix connector: the social bridges' DMs → hermes.
//
// THE MISSING HALF OF THE BRIDGE STACK, and it had been missing the whole
// time. bridges/ has run Synapse and seven mautrix bridges since 2026-08; the
// connect page could log Facebook and Instagram in; and not one message ever
// reached the corpus, because nothing read Matrix. bridges/README listed this
// under "Next (not yet built)" and the context store proved it: 324k iMessage
// rows, 1.8k WhatsApp, zero from any bridged platform (owner, 2026-08-25).
//
//   entity messenger:<event_id>   one DM, one platform per row
//
// WHY /sync. Matrix's own incremental primitive is a sync token: hand back
// `next_batch` and the server returns exactly what has happened since. One
// request covers every portal room of every bridge, new rooms included, with
// no way to miss a room that appeared between runs. Per-room /messages paging
// is used only on the first run, to walk beyond /sync's bounded timeline tail.
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
const TIMELINE_LIMIT = 500;
const INITIAL_HISTORY_LIMIT = 10_000;

const roomCursorKey = (roomId) => `matrix:room:${roomId}`;

function decodeRoomMembers(value) {
  if (!value) return new Map();
  try {
    const entries = JSON.parse(value);
    if (!Array.isArray(entries)) return new Map();
    return new Map(entries.filter(
      (entry) => Array.isArray(entry) && entry.length === 2
        && typeof entry[0] === 'string' && typeof entry[1] === 'string'
    ));
  } catch {
    return new Map();
  }
}

function encodeRoomMembers(members) {
  return JSON.stringify([...members.entries()]);
}

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
export function readRoomMembers(state, previousMembers = new Map()) {
  const members = new Map(previousMembers);
  for (const ev of state ?? []) {
    if (ev?.type !== 'm.room.member' || typeof ev.state_key !== 'string') continue;
    const membership = ev.content?.membership;
    if (membership !== undefined && membership !== 'join') {
      members.delete(ev.state_key);
      continue;
    }
    const display = ev.content?.displayname;
    members.set(
      ev.state_key,
      typeof display === 'string' && display ? display : (members.get(ev.state_key) ?? '')
    );
  }

  const names = new Map();
  let partner = null;
  let ghosts = 0;
  for (const [mxid, display] of members) {
    if (display) names.set(mxid, display);
    const who = classifySender(mxid);
    if (who?.kind === 'ghost') {
      ghosts += 1;
      // First ghost wins as "the partner"; a group's rows carry is_group and
      // the graph treats them accordingly.
      if (!partner) partner = { mxid, source: who.source, handle: who.handle };
    }
  }
  return { names, partner, isGroup: ghosts > 1, members };
}

/**
 * Portal rooms the bridges have INVITED the owner to but nobody accepted.
 *
 * This is the step the whole stack was missing. mautrix creates one room per
 * conversation and invites the owner; until that invite is accepted the room
 * is not in `rooms.join`, so a sync returns bridge management rooms and nothing
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
export function syncToRows(body, { selfName = 'me', roomState = new Map() } = {}) {
  const rows = [];
  let rooms = 0;
  const joined = body?.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(joined)) {
    const events = room?.timeline?.events ?? [];
    // State comes from the sync page when present; on an incremental sync the
    // membership is usually absent, so member events in the timeline carry it.
    const resolved = readRoomMembers(
      [...(room?.state?.events ?? []), ...events],
      roomState.get(roomId)
    );
    roomState.set(roomId, resolved.members);
    if (events.length === 0) continue;
    const { names, partner, isGroup } = resolved;
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
  return {
    rows,
    rooms,
    roomState,
    next: typeof body?.next_batch === 'string' ? body.next_batch : null,
  };
}

export function createMatrixSource({ home, fetchImpl = fetch } = {}) {
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
      // since-less sync returned only management rooms while /joined_rooms
      // listed more, because Synapse serves a room's state in
      // an initial sync only when it has something new to report for it —
      // rooms joined moments earlier came back empty and were skipped as
      // "no partner". With full_state the same call returned them all and
      // the portal rooms mapped (verified 2026-08-25: 5 rooms, 9 rows).
      // Incremental syncs carry their own deltas and must NOT ask for it.
      else url.searchParams.set('full_state', 'true');

      let body;
      try {
        const res = await fetchImpl(url, {
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
          const r = await fetchImpl(
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

      // Matrix omits unchanged membership state from incremental syncs. Keep a
      // private per-room member snapshot so a message-only page can still be
      // attributed to its bridge and conversation partner.
      const joinedRooms = body?.rooms?.join ?? {};
      const roomState = new Map();
      for (const roomId of Object.keys(joinedRooms)) {
        roomState.set(roomId, decodeRoomMembers(ctx.state.getCursor(roomCursorKey(roomId))));
      }
      const mapped = syncToRows(body, {
        selfName: ctx.config?.selfName ?? 'me',
        roomState,
      });
      const totals = mapped.rows.length
        ? await ingestAll(ctx, mapped.rows)
        : { inserted: 0, updated: 0, unchanged: 0 };
      let rowCount = mapped.rows.length;

      // A since-less /sync includes at most TIMELINE_LIMIT events per room.
      // Walk backwards from prev_batch on that first run so older bridge
      // history is not silently capped at 500 messages. Bound each room to
      // keep a first launch finite; a --purge/--backfill safely repeats it.
      if (!since) {
        for (const [roomId, room] of Object.entries(joinedRooms)) {
          const members = mapped.roomState.get(roomId) ?? new Map();
          const resolved = readRoomMembers([], members);
          let from = room?.timeline?.prev_batch;
          let observed = room?.timeline?.events?.length ?? 0;
          if (!resolved.partner || typeof from !== 'string' || !from) continue;

          while (observed < INITIAL_HISTORY_LIMIT) {
            const pageUrl = new URL(
              `${creds.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`
            );
            pageUrl.searchParams.set('dir', 'b');
            pageUrl.searchParams.set('from', from);
            pageUrl.searchParams.set(
              'limit',
              String(Math.min(TIMELINE_LIMIT, INITIAL_HISTORY_LIMIT - observed))
            );
            let page;
            try {
              const res = await fetchImpl(pageUrl, {
                headers: { Authorization: `Bearer ${creds.token}` },
                signal: AbortSignal.timeout(60_000),
              });
              if (!res.ok) throw new Error(`homeserver answered ${res.status}`);
              page = await res.json();
            } catch (error) {
              throw new Error(
                `matrix: initial history failed for one portal room (${error?.message ?? 'error'})`,
                { cause: error }
              );
            }

            const events = Array.isArray(page?.chunk)
              ? page.chunk.slice(0, INITIAL_HISTORY_LIMIT - observed)
              : [];
            if (events.length === 0) break;
            const rows = [];
            for (const ev of events) {
              const row = eventToRow(
                { ...ev, __partner: resolved.partner, __isGroup: resolved.isGroup },
                { roomId, names: resolved.names, selfName: ctx.config?.selfName ?? 'me' }
              );
              if (row) rows.push(row);
            }
            if (rows.length) mergeTotals(totals, await ingestAll(ctx, rows));
            rowCount += rows.length;
            observed += events.length;
            if (typeof page.end !== 'string' || !page.end || page.end === from) break;
            from = page.end;
          }
        }
      }

      ctx.log?.info?.(`matrix: ${rowCount} rows from ${mapped.rooms} room(s)`);

      // Every cursor advances only after all ingestion and initial paging
      // succeeds. A partial failure therefore retries idempotent entity IDs
      // instead of forgetting either history or room attribution state.
      for (const [roomId, members] of mapped.roomState) {
        ctx.state.setCursor(roomCursorKey(roomId), encodeRoomMembers(members));
      }
      if (mapped.next) ctx.state.setCursor(CURSOR_KEY, mapped.next);
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

function mergeTotals(into, add) {
  into.inserted += add.inserted ?? 0;
  into.updated += add.updated ?? 0;
  into.unchanged += add.unchanged ?? 0;
  return into;
}

export default createMatrixSource();
