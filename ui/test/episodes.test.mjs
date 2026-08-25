// The episode rule. Every fixture here is synthetic: the repo is public, and
// the one thing this module is built to read is the household's own messages.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEpisodes,
  threadKeyFor,
  isQuotable,
  memberHash,
  DEFAULT_GAP_MS,
} from '../server/memory/episodes.mjs';

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 2, 4, 12, 0, 0);

const msg = (id, minutes, { me = false, guid = 'A', text = `line ${id}` } = {}) => ({
  id,
  ts: T0 + minutes * MIN,
  source: 'imessage',
  speaker: me ? 'Owner' : 'Someone',
  text,
  meta: JSON.stringify({ is_from_me: me ? 1 : 0, chat_guid: guid }),
  content_hash: `h${id}`,
});

// The rule itself: a gap larger than the threshold ends the conversation.
test('a quiet hour ends the episode, a quiet minute does not', () => {
  const eps = buildEpisodes(
    [msg(1, 0, { me: true }), msg(2, 5, { me: true }), msg(3, 90, { me: true })],
    { now: T0 + 1000 * MIN }
  );
  assert.equal(eps.length, 2, '5 minutes joins, 85 minutes cuts');
  assert.deepEqual(eps[0].members.map((m) => m.context_id), [1, 2]);
  assert.deepEqual(eps[1].members.map((m) => m.context_id), [3]);
});

test('separate threads never merge, however close in time', () => {
  const eps = buildEpisodes(
    [msg(1, 0, { me: true, guid: 'A' }), msg(2, 1, { me: true, guid: 'B' })],
    { now: T0 + 1000 * MIN }
  );
  assert.equal(eps.length, 2, 'one minute apart, but two conversations');
});

// THE POINT OF THE WHOLE DESIGN: received messages come along as context, and
// are marked unquotable so they can never become a receipt.
test('received messages join the episode but are not quotable', () => {
  const [ep] = buildEpisodes(
    [msg(1, 0, { me: false, text: 'want chick-fil-a?' }), msg(2, 1, { me: true, text: 'ok' })],
    { now: T0 + 1000 * MIN }
  );
  assert.equal(ep.row_count, 2, 'the question is present, which is the point');
  assert.equal(ep.owner_row_count, 1);
  assert.deepEqual(
    ep.members.map((m) => m.quotable),
    [0, 1],
    'the received line may inform, never be cited'
  );
});

// The bound on the widening: a thread the owner never spoke in contributes
// nothing, so its received text never reaches a model at all.
test('an episode with no owner message is dropped entirely', () => {
  const eps = buildEpisodes([msg(1, 0), msg(2, 2), msg(3, 4)], { now: T0 + 1000 * MIN });
  assert.deepEqual(eps, [], 'nothing quotable means nothing citable means nothing to send');
});

test('line numbers are dense, 1-based and in time order', () => {
  const [ep] = buildEpisodes(
    [msg(3, 2, { me: true }), msg(1, 0, { me: false }), msg(2, 1, { me: true })],
    { now: T0 + 1000 * MIN }
  );
  assert.deepEqual(ep.members.map((m) => m.line_no), [1, 2, 3]);
  assert.deepEqual(ep.members.map((m) => m.context_id), [1, 2, 3], 'sorted by ts, not input order');
});

// An unsettled episode is one a new message can still join. Distilling it would
// append claims that the next pass appends again, because claim is append-only.
test('an episode is unsettled until a full gap has passed since its last message', () => {
  const rows = [msg(1, 0, { me: true })];
  const justAfter = buildEpisodes(rows, { now: T0 + 10 * MIN });
  assert.equal(justAfter[0].settled, false, 'ten minutes later, another message could still join');
  const later = buildEpisodes(rows, { now: T0 + DEFAULT_GAP_MS + MIN });
  assert.equal(later[0].settled, true);
  assert.equal(later[0].settled_at, later[0].ended_at + DEFAULT_GAP_MS);
});

test('a row with no chat is its own episode, not piled in with other orphans', () => {
  const orphan = (id, minutes) => ({ ...msg(id, minutes, { me: true }), meta: JSON.stringify({ is_from_me: 1 }) });
  const eps = buildEpisodes([orphan(1, 0), orphan(2, 1)], { now: T0 + 1000 * MIN });
  assert.equal(eps.length, 2, 'sharing no chat_guid is not a conversation');
  assert.ok(eps.every((e) => e.thread_key.startsWith('solo:')));
});

test('notes are one episode per note, and an undecoded body is not quotable', () => {
  const note = (id, undecoded) => ({
    id,
    ts: T0,
    source: 'notes',
    text: 'a note',
    entity_id: `notes:${id}`,
    meta: JSON.stringify(undecoded ? { body_undecoded: 1 } : {}),
    content_hash: `h${id}`,
  });
  assert.equal(threadKeyFor(note(1, false)), 'note:notes:1');
  assert.equal(isQuotable(note(1, false)), true);
  assert.equal(isQuotable(note(2, true)), false);
  assert.deepEqual(buildEpisodes([note(2, true)], { now: T0 + 1000 * MIN }), [], 'undecoded: nothing to quote');
});

// The hash is the distiller's cache key and its change detector.
test('member_hash tracks content, not rebuild time', () => {
  const rows = [msg(1, 0, { me: false }), msg(2, 1, { me: true })];
  const a = buildEpisodes(rows, { now: T0 + 1000 * MIN })[0];
  const b = buildEpisodes(rows, { now: T0 + 9999 * MIN })[0];
  assert.equal(a.member_hash, b.member_hash, 'rebuilding changes nothing');

  const edited = [rows[0], { ...rows[1], content_hash: 'CHANGED' }];
  const c = buildEpisodes(edited, { now: T0 + 1000 * MIN })[0];
  assert.notEqual(a.member_hash, c.member_hash, 'an edited row must re-distil');
});

test('quotability is part of the hash, so a reclassified line re-distils', () => {
  const base = [{ context_id: 1, quotable: 1, row: { content_hash: 'x' } }];
  const flipped = [{ context_id: 1, quotable: 0, row: { content_hash: 'x' } }];
  assert.notEqual(memberHash(base), memberHash(flipped));
});

test('junk in the row list does not take the build down', () => {
  assert.deepEqual(buildEpisodes(null), []);
  const eps = buildEpisodes([null, 'nope', msg(1, 0, { me: true }), undefined], { now: T0 + 1000 * MIN });
  assert.equal(eps.length, 1);
});

// No model may ever write a boundary; the column is CHECKed in SQL and the
// builder is arithmetic. This pins the value the CHECK allows.
test('every episode records the rule that made it', () => {
  const [ep] = buildEpisodes([msg(1, 0, { me: true })], { now: T0 + 1000 * MIN });
  assert.equal(ep.built_by, 'gap-rule');
  assert.equal(ep.gap_ms, DEFAULT_GAP_MS);
});
