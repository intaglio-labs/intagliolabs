// The Matrix → rows mapping. Pure, so this needs no homeserver and no Docker.
//
// The assertion that matters most is the negative one: a bridge's MANAGEMENT
// room is where the login conversation happens, so its "messages" include the
// bot's prompts and — once — the owner's pasted session cookies. Those must
// never become corpus rows. Everything else here is join-key plumbing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySender, eventToRow } from '../lib/matrixRows.mjs';
import { invitesToJoin, readRoomMembers, syncToRows } from '../sources/matrix.mjs';

const msg = (sender, body, id, ts = 1_700_000_000_000) => ({
  type: 'm.room.message', sender, event_id: id, origin_server_ts: ts,
  content: { msgtype: 'm.text', body },
});

test('senders classify as owner, ghost or bot — bots are never people', () => {
  assert.deepEqual(classifySender('@you:hazlie.local'), { kind: 'owner' });
  assert.deepEqual(classifySender('@facebook_1234:hazlie.local'),
    { kind: 'ghost', source: 'messenger', handle: 'facebook_1234' });
  assert.deepEqual(classifySender('@twitter_99:hazlie.local'),
    { kind: 'ghost', source: 'twitter', handle: 'twitter_99' });
  // `slackbot` must not read as a ghost of a platform called "slackbot".
  assert.equal(classifySender('@slackbot:hazlie.local').kind, 'bot');
  assert.equal(classifySender('@instagrambot:hazlie.local').kind, 'bot');
  // Not ours: a plain Matrix user on this homeserver is not a bridged person.
  assert.equal(classifySender('@someone:hazlie.local'), null);
  assert.equal(classifySender('nonsense'), null);
});

test('a bridge login transcript never becomes a row', () => {
  // Exactly the shape of a real management room: the bot asks, the owner
  // pastes cookies. Both sides must be refused — one as a bot, the other
  // because the room has no ghost to attribute it to.
  const body = {
    next_batch: 's2',
    rooms: { join: { '!mgmt:hazlie.local': {
      state: { events: [] },
      timeline: { events: [
        msg('@twitterbot:hazlie.local', 'Please enter your Create your PIN code', '$a'),
        msg('@you:hazlie.local', '{"auth_token":"SECRET","ct0":"SECRET"}', '$b'),
      ] },
    } } },
  };
  const { rows, rooms } = syncToRows(body);
  assert.deepEqual(rows, []);
  assert.equal(rooms, 0);
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
});

test('a portal room yields rows on both sides, named and attributed', () => {
  const body = {
    next_batch: 's3',
    rooms: { join: { '!dm:hazlie.local': {
      state: { events: [
        { type: 'm.room.member', state_key: '@facebook_77:hazlie.local',
          content: { displayname: 'Dana' } },
        { type: 'm.room.member', state_key: '@you:hazlie.local',
          content: { displayname: 'me' } },
      ] },
      timeline: { events: [
        msg('@facebook_77:hazlie.local', 'dinner thursday?', '$1', 1_700_000_000_001),
        msg('@you:hazlie.local', 'yes', '$2', 1_700_000_000_002),
      ] },
    } } },
  };
  const { rows, rooms, next } = syncToRows(body, { selfName: 'owner' });
  assert.equal(rooms, 1);
  assert.equal(next, 's3');
  assert.equal(rows.length, 2);

  const [theirs, mine] = rows;
  assert.equal(theirs.source, 'messenger'); // the ghost prefix is `facebook`
  assert.equal(theirs.entity_id, 'messenger:$1');
  assert.equal(theirs.speaker, 'Dana');
  assert.equal(theirs.meta.is_from_me, false);
  assert.equal(theirs.meta.chat_handle, 'facebook_77');

  // The owner's own message carries the platform of the ROOM, not the sender —
  // there is nothing in "@you" that says which bridge this was.
  assert.equal(mine.source, 'messenger');
  assert.equal(mine.speaker, 'owner');
  assert.equal(mine.meta.is_from_me, true);
  assert.equal(mine.meta.chat_handle, 'facebook_77', 'both sides join on the partner');
  assert.equal(mine.meta.chat_name, 'Dana');
});

test('non-text events are skipped rather than ingested as filenames', () => {
  const partner = { mxid: '@slack_1:hazlie.local', source: 'slack', handle: 'slack_1' };
  const image = { type: 'm.room.message', sender: '@slack_1:hazlie.local',
    event_id: '$i', origin_server_ts: 1, content: { msgtype: 'm.image', body: 'IMG_2044.jpg' } };
  assert.equal(eventToRow({ ...image, __partner: partner }, { roomId: '!r' }), null);
  const notice = { type: 'm.room.message', sender: '@slack_1:hazlie.local',
    event_id: '$n', origin_server_ts: 1, content: { msgtype: 'm.notice', body: 'hi' } };
  assert.equal(eventToRow({ ...notice, __partner: partner }, { roomId: '!r' }), null);
  // And a reaction/state event is not a message at all.
  assert.equal(eventToRow({ type: 'm.reaction', sender: '@slack_1:hazlie.local' }, {}), null);
});

test('members resolve the partner and flag groups', () => {
  const one = readRoomMembers([
    { type: 'm.room.member', state_key: '@discord_5:hazlie.local', content: { displayname: 'Ari' } },
  ]);
  assert.equal(one.partner.source, 'discord');
  assert.equal(one.isGroup, false);
  assert.equal(one.names.get('@discord_5:hazlie.local'), 'Ari');

  const many = readRoomMembers([
    { type: 'm.room.member', state_key: '@discord_5:hazlie.local', content: { displayname: 'Ari' } },
    { type: 'm.room.member', state_key: '@discord_6:hazlie.local', content: { displayname: 'Bo' } },
  ]);
  assert.equal(many.isGroup, true);
});

test('only our own bridges\' invites are auto-joined', () => {
  const body = { rooms: { invite: {
    '!ours:hazlie.local': { invite_state: { events: [
      { type: 'm.room.member', state_key: '@you:hazlie.local',
        sender: '@instagrambot:hazlie.local', content: { membership: 'invite' } },
    ] } },
    '!ghost:hazlie.local': { invite_state: { events: [
      { type: 'm.room.member', state_key: '@you:hazlie.local',
        sender: '@facebook_9:hazlie.local', content: { membership: 'invite' } },
    ] } },
    // A stranger on this homeserver must never pull the owner into a room.
    '!stranger:hazlie.local': { invite_state: { events: [
      { type: 'm.room.member', state_key: '@you:hazlie.local',
        sender: '@mallory:hazlie.local', content: { membership: 'invite' } },
    ] } },
  } } };
  assert.deepEqual(invitesToJoin(body).sort(), ['!ghost:hazlie.local', '!ours:hazlie.local']);
  assert.deepEqual(invitesToJoin({}), []);
});
