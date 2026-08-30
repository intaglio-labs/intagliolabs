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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifySender, eventToRow } from '../lib/matrixRows.mjs';

const CURSOR_KEY = 'matrix:since';
const TIMELINE_LIMIT = 500;
const HISTORY_QUEUE_KEY = 'matrix:history-rooms';
const HISTORY_ALL_ROOMS_KEY = 'matrix:history-all-rooms';
const HISTORY_EXHAUSTED_ROOMS_KEY = 'matrix:history-exhausted-rooms';
const HISTORY_YEAR_KEY = 'matrix:history-year';
const HISTORY_YEAR_QUEUE_KEY = 'matrix:history-year-rooms';
const HISTORY_DONE_KEY = 'matrix:history-done';
const HISTORY_BOOTSTRAP_KEY = 'matrix:history-bootstrap-v1';
const PENDING_INVITES_KEY = 'matrix:pending-portal-invites';
const INVITE_RECOVERY_KEY = 'matrix:invite-recovery-v1';
// Portal joins are local Synapse requests, not upstream platform fetches. A
// migrated install can legitimately have hundreds waiting after the old sync
// bug, so one pass must be able to repair the whole known backlog. The 429
// branch below remains the real pressure valve: it stops immediately and
// keeps every unattempted room durable for the next run.
const INVITES_PER_PASS = 1_000;

const roomCursorKey = (roomId) => `matrix:room:${roomId}`;
const historyCursorKey = (roomId) => `matrix:history:${roomId}`;

function decodeHistoryQueue(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((roomId) => typeof roomId === 'string' && roomId.length > 0))]
      : [];
  } catch {
    return [];
  }
}

function saveHistoryQueue(state, queue) {
  state.setCursor(HISTORY_QUEUE_KEY, JSON.stringify(queue));
}

function retryAfterMs(response, now = Date.now()) {
  const raw = response?.headers?.get?.('retry-after');
  const seconds = Number(raw);
  if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1_000, seconds * 1_000);
  }
  const date = Date.parse(String(raw ?? ''));
  if (Number.isFinite(date)) return Math.max(1_000, date - now);
  return 15_000;
}

export function pendingPortalInvites(saved, body) {
  return [...new Set([
    ...decodeHistoryQueue(saved),
    ...invitesToJoin(body),
  ])];
}

// Count-only operator receipt. Room ids remain inside the owner-only state DB;
// the coverage command can show whether replay is draining without printing a
// single portal identifier.
export function pendingPortalInviteCount(saved) {
  return decodeHistoryQueue(saved).length;
}

function clearHistoryDone(state) {
  // Older test contexts and installations may not expose the precise cursor
  // deletion helper yet. They have no completed marker to clear; production
  // state does, so new portal rooms restart the walker correctly.
  state.deleteCursor?.(HISTORY_DONE_KEY);
}

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

// WHICH ENGINE PROVISIONED THIS MACHINE.
//
// Native bridges keep ~/.hazlie/matrix; the Docker fallback moved to
// ~/.hazlie/matrix-docker so the two provisioners cannot overwrite each other's
// homeserver.yaml (they disagree about whether a path is host-absolute or the
// container's /data view). That split is invisible from here, so resolve it by
// looking for the artifact only a completed setup writes.
//
// Native wins a tie deliberately: it is the default engine, and when neither
// root is provisioned this still returns the native path, so every "set up the
// bridges" message keeps naming the directory the docs name.
const matrixRoot = (home) => {
  const native = join(home, '.hazlie', 'matrix');
  const docker = join(home, '.hazlie', 'matrix-docker');
  if (existsSync(join(native, 'owner-credentials.json'))) return native;
  if (existsSync(join(docker, 'owner-credentials.json'))) return docker;
  return native;
};

export function credentialsPath(home) {
  return join(matrixRoot(home), 'owner-credentials.json');
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
    walksHistory: true,

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
        return {
          inserted: 0, updated: 0, unchanged: 0, skipped: 0,
          ...(ctx.historyWindow?.year ? { historyDone: true, historyHasOlder: false } : {}),
        };
      }

      // History deliberately avoids /sync: a history slice is one bounded
      // `/messages` page from one room's private continuation token. That
      // keeps it resumable, lets the daemon time-slice it, and leaves the
      // forward sync free to prioritise newly arrived messages.
      if (ctx.history) {
        const yearly = ctx.historyWindow?.year ? ctx.historyWindow : null;
        const allRooms = decodeHistoryQueue(
          ctx.state.getCursor(HISTORY_ALL_ROOMS_KEY) ?? ctx.state.getCursor(HISTORY_QUEUE_KEY)
        );
        const exhaustedRooms = new Set(
          decodeHistoryQueue(ctx.state.getCursor(HISTORY_EXHAUSTED_ROOMS_KEY))
        );
        if (yearly && ctx.state.getCursor(HISTORY_YEAR_KEY) !== String(yearly.year)) {
          ctx.state.setCursor(HISTORY_YEAR_KEY, String(yearly.year));
          ctx.state.setCursor(
            HISTORY_YEAR_QUEUE_KEY,
            JSON.stringify(allRooms.filter((roomId) => !exhaustedRooms.has(roomId)))
          );
        }
        const queue = decodeHistoryQueue(ctx.state.getCursor(
          yearly ? HISTORY_YEAR_QUEUE_KEY : HISTORY_QUEUE_KEY
        ));
        if (queue.length === 0) {
          if (!yearly) ctx.state.setCursor(HISTORY_DONE_KEY, '1');
          return {
            inserted: 0, updated: 0, unchanged: 0, skipped: 0,
            ...(yearly ? {
              historyDone: true,
              historyHasOlder: allRooms.some((roomId) => !exhaustedRooms.has(roomId)),
            } : {}),
          };
        }

        const roomId = queue[0];
        const from = ctx.state.getCursor(historyCursorKey(roomId));
        if (!from) {
          const remaining = queue.slice(1);
          exhaustedRooms.add(roomId);
          ctx.state.setCursor(HISTORY_EXHAUSTED_ROOMS_KEY, JSON.stringify([...exhaustedRooms]));
          ctx.state.setCursor(
            yearly ? HISTORY_YEAR_QUEUE_KEY : HISTORY_QUEUE_KEY,
            JSON.stringify(remaining)
          );
          return {
            inserted: 0, updated: 0, unchanged: 0, skipped: 0,
            ...(yearly ? {
              historyDone: remaining.length === 0,
              historyHasOlder: allRooms.some((id) => !exhaustedRooms.has(id)),
              historyProgressed: true,
            } : {}),
          };
        }

        const pageUrl = new URL(
          `${creds.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`
        );
        pageUrl.searchParams.set('dir', 'b');
        pageUrl.searchParams.set('from', from);
        pageUrl.searchParams.set('limit', String(TIMELINE_LIMIT));
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
            `matrix: history page failed (${error?.message ?? 'error'})`,
            { cause: error }
          );
        }

        const members = decodeRoomMembers(ctx.state.getCursor(roomCursorKey(roomId)));
        const resolved = readRoomMembers([], members);
        const events = Array.isArray(page?.chunk) ? page.chunk : [];
        const rows = [];
        if (resolved.partner) {
          for (const ev of events) {
            const row = eventToRow(
              { ...ev, __partner: resolved.partner, __isGroup: resolved.isGroup },
              { roomId, names: resolved.names, selfName: ctx.config?.selfName ?? 'me' }
            );
            if (
              row
              && (!yearly || (row.ts >= yearly.fromTs && row.ts < yearly.toTs))
            ) rows.push(row);
          }
        }
        const totals = rows.length
          ? await ingestAll(ctx, rows)
          : { inserted: 0, updated: 0, unchanged: 0 };

        // Commit the page only after its rows reach Hermes. Rotate the room to
        // the back of the queue so one enormous chat cannot keep every other
        // bridge waiting behind it.
        const end = typeof page?.end === 'string' && page.end && page.end !== from
          ? page.end
          : null;
        const crossedYear = Boolean(yearly) && events.some(
          (event) => Number(event?.origin_server_ts) < yearly.fromTs
        );
        let remaining;
        if (crossedYear) {
          // Keep `from`, not `end`: the page straddles the year boundary. The
          // next year replays this one page and keeps the older rows that were
          // deliberately filtered out above. No message is stranded between
          // opaque Matrix tokens just to preserve the year barrier.
          remaining = queue.slice(1);
        } else if (end && events.length > 0) {
          ctx.state.setCursor(historyCursorKey(roomId), end);
          remaining = [...queue.slice(1), roomId];
        } else {
          remaining = queue.slice(1);
          exhaustedRooms.add(roomId);
          ctx.state.setCursor(HISTORY_EXHAUSTED_ROOMS_KEY, JSON.stringify([...exhaustedRooms]));
        }
        ctx.state.setCursor(
          yearly ? HISTORY_YEAR_QUEUE_KEY : HISTORY_QUEUE_KEY,
          JSON.stringify(remaining)
        );
        if (!yearly && remaining.length === 0) ctx.state.setCursor(HISTORY_DONE_KEY, '1');
        return {
          ...totals,
          skipped: 0,
          ...(yearly ? {
            historyDone: remaining.length === 0,
            historyHasOlder: allRooms.some((id) => !exhaustedRooms.has(id)),
            historyProgressed: true,
          } : {}),
        };
      }

      // Existing installs may have the old 10k initial import and a forward
      // sync token but no per-room history continuation. One full-state sync
      // gives us each portal's prev_batch so those installs pick up exactly
      // where the old cap left off rather than remaining capped forever.
      const needsHistoryBootstrap = !ctx.state.getCursor(HISTORY_BOOTSTRAP_KEY);
      // v1 recovery is deliberately a since-less snapshot. Before pending
      // invites were durable, a failed/rate-limited join was forgotten as soon
      // as the sync token advanced. Existing installs can therefore have
      // hundreds of portal rooms still sitting at `invite`, invisible to every
      // later incremental /sync. One full snapshot re-discovers them; after
      // that, the private queue below makes incremental delivery safe.
      //
      // MEASURED on a real install before either fix existed (2026-08-29):
      // 25 portal rooms sat at `invite` against 19 joined, so Discord and
      // LinkedIn had bridge databases full of messages and ZERO rows in the
      // corpus, indefinitely. A branch fix ran this snapshot on EVERY pass;
      // this replaced it and is better, because setCursor(PENDING_INVITES_KEY)
      // happens before setCursor(CURSOR_KEY) — the queue is durable before the
      // token moves, so the hole cannot reopen, and no pass after the first
      // pays for a full-state sync.
      const needsInviteRecovery = !ctx.state.getCursor(INVITE_RECOVERY_KEY);
      const since = (ctx.backfill || needsHistoryBootstrap || needsInviteRecovery)
        ? null
        : ctx.state.getCursor(CURSOR_KEY);
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

      // A FAILED RUN IS RECORDED AS A FAILED RUN.
      //
      // Both of these used to warn and return zeros, on the reasoning that a
      // dead homeserver is the ordinary state whenever Docker is not running and
      // the other connectors have nothing to do with it. The second half is
      // right and is why this throws rather than aborting the pass: daemon.mjs
      // records ok:false for THIS connector alone and the others are untouched.
      // The first half is what went wrong -- returning zeros made runSource
      // write ok:true, so run_log showed an unbroken line of successful empty
      // runs while the entire bridge stack was down, and nothing anywhere said
      // otherwise. The never-set-up install is already covered by the `!creds`
      // return above, so this only fires when the bridges ARE provisioned.
      //
      // The fetch is hoisted out of the try on purpose: leaving the !res.ok
      // throw inside it would land in the same catch and re-label a decisive
      // HTTP status as "unreachable".
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${creds.token}` },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        throw new Error(`matrix: homeserver unreachable (${e?.name ?? 'error'})`, { cause: e });
      }
      if (!res.ok) throw new Error(`matrix: homeserver answered ${res.status}`);
      const body = await res.json();

      // Accept the bridges' portal invites BEFORE mapping this page. The queue
      // is durable because Matrix offers an invite only once on an incremental
      // sync: advancing `since` after a rate limit used to strand that room
      // forever. Keep failures and unattempted rooms for the next bounded pass;
      // log counts only because room ids are household-private.
      let pendingInvites = pendingPortalInvites(
        ctx.state.getCursor(PENDING_INVITES_KEY),
        body
      );
      let joined = 0;
      let joinFailed = 0;
      let attempted = 0;
      let inviteRetryMs = null;
      const remainingInvites = [];
      for (let i = 0; i < pendingInvites.length; i += 1) {
        const roomId = pendingInvites[i];
        if (attempted >= INVITES_PER_PASS) {
          remainingInvites.push(...pendingInvites.slice(i));
          break;
        }
        attempted += 1;
        try {
          const r = await fetchImpl(
            `${creds.base}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
            { method: 'POST',
              headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
              body: '{}',
              signal: AbortSignal.timeout(15_000) }
          );
          if (r.ok) {
            joined += 1;
          } else if (r.status === 403 || r.status === 404) {
            // No longer invited / room gone: terminal, and another full sync
            // is the authority if it ever becomes actionable again.
            joinFailed += 1;
          } else {
            joinFailed += 1;
            remainingInvites.push(roomId);
            if (r.status === 429) {
              inviteRetryMs = retryAfterMs(r);
              remainingInvites.push(...pendingInvites.slice(i + 1));
              break;
            }
          }
        } catch {
          joinFailed += 1;
          remainingInvites.push(roomId);
        }
      }
      pendingInvites = [...new Set(remainingInvites)];
      ctx.state.setCursor(PENDING_INVITES_KEY, JSON.stringify(pendingInvites));
      if (attempted > 0) {
        ctx.log?.info?.('matrix_portal_invites', {
          attempted,
          joined,
          failed: joinFailed,
          pending: pendingInvites.length,
        });
      }

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
      const rowCount = mapped.rows.length;

      ctx.log?.info?.(`matrix: ${rowCount} rows from ${mapped.rooms} room(s)`);

      // Every cursor advances only after all ingestion and initial paging
      // succeeds. A partial failure therefore retries idempotent entity IDs
      // instead of forgetting either history or room attribution state.
      for (const [roomId, members] of mapped.roomState) {
        ctx.state.setCursor(roomCursorKey(roomId), encodeRoomMembers(members));
      }
      // A since-less response gives every joined portal a token just before
      // its visible tail. Queue those continuations; the daemon consumes them
      // in short round-robin pages after this urgent forward pass finishes.
      let queue = decodeHistoryQueue(ctx.state.getCursor(HISTORY_QUEUE_KEY));
      let allRooms = decodeHistoryQueue(
        ctx.state.getCursor(HISTORY_ALL_ROOMS_KEY) ?? ctx.state.getCursor(HISTORY_QUEUE_KEY)
      );
      let addedHistoryRoom = false;
      for (const [roomId, room] of Object.entries(joinedRooms)) {
        const resolved = readRoomMembers([], mapped.roomState.get(roomId) ?? new Map());
        const prevBatch = room?.timeline?.prev_batch;
        if (!resolved.partner || typeof prevBatch !== 'string' || !prevBatch) continue;
        if (ctx.state.getCursor(historyCursorKey(roomId))) continue;
        ctx.state.setCursor(historyCursorKey(roomId), prevBatch);
        if (!queue.includes(roomId)) queue.push(roomId);
        if (!allRooms.includes(roomId)) allRooms.push(roomId);
        addedHistoryRoom = true;
      }
      if (addedHistoryRoom) {
        saveHistoryQueue(ctx.state, queue);
        ctx.state.setCursor(HISTORY_ALL_ROOMS_KEY, JSON.stringify(allRooms));
        ctx.state.deleteCursor?.(HISTORY_YEAR_KEY);
        ctx.state.deleteCursor?.(HISTORY_YEAR_QUEUE_KEY);
        clearHistoryDone(ctx.state);
      }
      if (needsHistoryBootstrap) ctx.state.setCursor(HISTORY_BOOTSTRAP_KEY, '1');
      if (needsInviteRecovery) ctx.state.setCursor(INVITE_RECOVERY_KEY, '1');
      if (mapped.next) ctx.state.setCursor(CURSOR_KEY, mapped.next);
      return {
        ...totals,
        skipped: 0,
        historyReopened: addedHistoryRoom,
        ...(pendingInvites.length > 0 ? { retryAfterMs: inviteRetryMs ?? 15_000 } : {}),
      };
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
