import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const widget = readFileSync(join(WIDGET, 'ui/widget.js'), 'utf8');
const chat = readFileSync(join(WIDGET, 'ui/chat.js'), 'utf8');
const native = readFileSync(join(WIDGET, 'src/main.swift'), 'utf8');

test('expanding the message bar surfaces and unfolds recent chat history', () => {
  assert.match(widget, /if \(open && !barWasOpen\) \{[\s\S]{0,240}hzPost\('openChat'\)/u,
    'the collapsed-to-open transition must surface the chat panel');
  assert.match(chat, /window\.__hzShowHistory = \(\) => \{[\s\S]{0,240}setFolded\(false\)/u,
    'reopening chat must unfold a history the owner previously collapsed');
  assert.match(native, /func openChat\(\) \{[\s\S]{0,2200}__hzShowHistory/u,
    'native must ask the reused chat page to reveal its retained messages');
});
