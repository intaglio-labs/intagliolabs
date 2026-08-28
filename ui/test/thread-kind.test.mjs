// Is this a room or a conversation? Every fixture invented; the repo is public.
//
// These exist because the thing they pin was wrong in a way nothing could
// catch: the branch that asked "is this a group" read a field only one
// connector writes, so it was dead across 99% of the corpus and no test
// noticed, because no fixture ever carried a real iMessage chat_guid.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGED_SOCIAL_SOURCES,
  threadKind,
  isRoom,
  counterpartyFromThread,
  GROUP,
  DIRECT,
  UNKNOWN,
} from '../server/memory/threadKind.mjs';

const im = (guid) => [{ source: 'imessage' }, { chat_guid: guid }];
const wa = (meta) => [{ source: 'whatsapp' }, meta];

// THE BUG THAT STARTED THIS. The service token is the literal 'any', not
// 'iMessage' -- so a prefix match compiles, reads correctly, and matches
// nothing. Field 1 is the marker, and only field 1.
test('the marker is field 1, and the service token is not what you expect', () => {
  assert.equal(threadKind(...im('any;+;chat123456789')), GROUP);
  assert.equal(threadKind(...im('any;-;+15550100')), DIRECT);
  // Both spellings resolve, because the guid's own service token is not the
  // thing being tested and must never be.
  assert.equal(threadKind(...im('iMessage;+;chat9')), GROUP);
  assert.equal(threadKind(...im('SMS;+;chat9')), GROUP, 'an SMS group is still a group');
  assert.equal(threadKind(...im('SMS;-;+15550100')), DIRECT);
});

// Three-valued on purpose: 656 live rows carry no chat_guid, and a boolean
// would silently pick a side for them.
test('a row with no thread is unknown, not a guess', () => {
  assert.equal(threadKind(...im(undefined)), UNKNOWN);
  assert.equal(threadKind(...im(null)), UNKNOWN);
  assert.equal(threadKind(...im('')), UNKNOWN);
  assert.equal(threadKind(...im('garbage-with-no-semicolons')), UNKNOWN);
  assert.equal(threadKind({ source: 'imessage' }, null), UNKNOWN);
  assert.equal(threadKind({ source: 'imessage' }, {}), UNKNOWN);
});

// The asymmetry that is the whole reason for a third value. An unknown row is
// credited as it always was, so no count moves -- but it can never be used to
// assert that something happened in a room.
test('unknown never satisfies "this happened in a room"', () => {
  assert.equal(isRoom(...im('')), false);
  assert.equal(isRoom(...im('garbage')), false);
  assert.equal(isRoom(...im('any;+;chat9')), true);
  assert.equal(isRoom(...im('any;-;+15550100')), false);
});

test('whatsapp uses its own written flag, and falls back to the jid suffix', () => {
  assert.equal(threadKind(...wa({ is_group: true })), GROUP);
  assert.equal(threadKind(...wa({ is_group: false })), DIRECT);
  assert.equal(threadKind(...wa({ is_group: 1 })), GROUP, 'sqlite gives 1/0, not true/false');
  assert.equal(threadKind(...wa({ is_group: 0 })), DIRECT);
  // No flag written: the group jid suffix is the fallback.
  assert.equal(threadKind(...wa({ chat_handle: '120363000000000000@g.us' })), GROUP);
  assert.equal(threadKind(...wa({ chat_handle: '15550100@s.whatsapp.net' })), DIRECT);
  assert.equal(threadKind(...wa({})), UNKNOWN);
});

test('every Matrix social bridge uses the same direct/group contract', () => {
  for (const source of BRIDGED_SOCIAL_SOURCES) {
    assert.equal(threadKind({ source }, { is_group: true }), GROUP, source);
    assert.equal(threadKind({ source }, { is_group: false }), DIRECT, source);
    assert.equal(threadKind({ source }, { is_group: 1 }), GROUP, `${source} sqlite true`);
    assert.equal(threadKind({ source }, { is_group: 0 }), DIRECT, `${source} sqlite false`);
    assert.equal(threadKind({ source }, {}), UNKNOWN, `${source} missing flag`);
  }
  // The old LinkedIn export is a flat connection/message dataset, not Matrix.
  assert.equal(threadKind({ source: 'linkedin' }, { kind: 'connection' }), DIRECT);
  assert.equal(threadKind({ source: 'linkedin' }, { kind: 'message' }), DIRECT);
});

test('a source with no threads is never a room', () => {
  for (const source of ['mail', 'calendar', 'notes', 'files', 'photos']) {
    assert.equal(threadKind({ source }, {}), DIRECT, source);
    assert.equal(isRoom({ source }, {}), false, source);
  }
});

test('junk does not throw', () => {
  assert.equal(threadKind(null, null), DIRECT);
  assert.equal(threadKind(undefined, undefined), DIRECT);
  assert.equal(isRoom(null, null), false);
});

// ---- who an outbound message was sent to ----
//
// Apple leaves message.handle_id NULL on most outbound rows, so 109,380 of the
// owner's own one-to-one messages carry no handle and were dropped entirely.
// The recipient is the guid's third field the whole time.
test('a one-to-one thread names its counterparty', () => {
  assert.equal(counterpartyFromThread(...im('any;-;+15550100')), '+15550100');
  assert.equal(counterpartyFromThread(...im('any;-;sam@example.com')), 'sam@example.com');
  assert.equal(counterpartyFromThread(...im('SMS;-;+15550100')), '+15550100');
});

// THE TRAP, and the reason this lives behind the group test. A group guid's
// third field is an opaque room id; deriving from it would mint rooms as people
// with message counts, indistinguishable from real contacts. 21,644 live group
// rows have no handle and would each have taken the bait.
test('a room NEVER yields a counterparty', () => {
  assert.equal(counterpartyFromThread(...im('any;+;chat488392016936725110')), null);
  assert.equal(counterpartyFromThread(...im('iMessage;+;chat9')), null);
});

test('an unknown thread yields nothing rather than a guess', () => {
  assert.equal(counterpartyFromThread(...im('')), null);
  assert.equal(counterpartyFromThread(...im('garbage')), null);
  assert.equal(counterpartyFromThread(...im('any;-;')), null, 'an empty id is not an identity');
  assert.equal(counterpartyFromThread({ source: 'imessage' }, {}), null);
});

test('only iMessage guids are read this way', () => {
  assert.equal(counterpartyFromThread({ source: 'whatsapp' }, { chat_guid: 'any;-;x' }), null);
  assert.equal(counterpartyFromThread({ source: 'mail' }, { chat_guid: 'any;-;x' }), null);
});

test('an id containing a semicolon is not silently truncated', () => {
  // Nothing in practice does, but a truncated identity is a wrong one, not a
  // shorter one.
  assert.equal(counterpartyFromThread(...im('any;-;odd;id')), 'odd;id');
});
