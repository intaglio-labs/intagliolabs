// Is this a room or a conversation? Every fixture invented; the repo is public.
//
// These exist because the thing they pin was wrong in a way nothing could
// catch: the branch that asked "is this a group" read a field only one
// connector writes, so it was dead across 99% of the corpus and no test
// noticed, because no fixture ever carried a real iMessage chat_guid.
import test from 'node:test';
import assert from 'node:assert/strict';

import { threadKind, isRoom, GROUP, DIRECT, UNKNOWN } from '../server/memory/threadKind.mjs';

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

test('a source with no threads is never a room', () => {
  for (const source of ['mail', 'calendar', 'notes', 'linkedin', 'files', 'photos']) {
    assert.equal(threadKind({ source }, {}), DIRECT, source);
    assert.equal(isRoom({ source }, {}), false, source);
  }
});

test('junk does not throw', () => {
  assert.equal(threadKind(null, null), DIRECT);
  assert.equal(threadKind(undefined, undefined), DIRECT);
  assert.equal(isRoom(null, null), false);
});
