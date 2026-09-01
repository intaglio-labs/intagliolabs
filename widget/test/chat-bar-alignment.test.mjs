import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const widget = readFileSync(join(WIDGET, 'ui/widget.js'), 'utf8');
const palette = readFileSync(join(WIDGET, 'ui/palette.css'), 'utf8');
const bridge = readFileSync(join(WIDGET, 'src/Bridge.swift'), 'utf8');
const main = readFileSync(join(WIDGET, 'src/main.swift'), 'utf8');

test('assistant messages meet the existing bar edge while user messages stay right-aligned', () => {
  assert.match(widget, /hzPost\('chatBarOpen', \{ open \}\)/u,
    'the page must still tell native when collapsing should hide messages');
  assert.match(bridge, /case "chatBarOpen":[\s\S]{0,180}chatBarOpenChanged/u,
    'the collapse state must reach the window owner');
  assert.match(main, /func chatBarOpenChanged\(_ open: Bool\)[\s\S]{0,700}if !open \{[\s\S]{0,180}chatPanel\?\.orderOut\(nil\)/u,
    'collapsing the input must hide the messages that belong to it');
  assert.doesNotMatch(main, /pinnedFrame\(widgetWindow, Bridge\.scale, width:/u,
    'opening chat must not make the message bar or widget wider');
  assert.match(palette, /\.wbar input\.open \{[\s\S]{0,520}margin-left: 12px;/u,
    'the bar keeps its original compact geometry');
  assert.match(palette, /\.msg\.user \{[\s\S]{0,160}align-self: flex-end;/u,
    'the user bubble must keep its original right-side layout');
  assert.match(palette, /\.msg\.assistant \{[\s\S]{0,520}align-self: stretch;[\s\S]{0,160}margin-left: 106px;[\s\S]{0,160}margin-right: 28px;/u,
    'the assistant bubble moves to the bar’s existing left edge');
});
