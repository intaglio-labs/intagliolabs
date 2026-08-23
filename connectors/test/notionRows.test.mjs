import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockText, composeText, notionToRow, pageTitle, plainText } from '../lib/notionRows.mjs';

const page = {
  id: 'abc-123',
  object: 'page',
  url: 'https://notion.so/abc123',
  created_time: '2026-01-02T03:04:05.000Z',
  last_edited_time: '2026-08-01T10:00:00.000Z',
  parent: { type: 'workspace' },
  properties: {
    // Deliberately NOT called "Name" — see the test below.
    Untitled: { type: 'title', title: [{ plain_text: 'Q3 planning' }] },
    Status: { type: 'select', select: { name: 'Done' } },
  },
};

test('rich text is joined from plain_text, and non-arrays are empty', () => {
  assert.equal(plainText([{ plain_text: 'a' }, { plain_text: 'b' }]), 'ab');
  assert.equal(plainText(null), '');
  assert.equal(plainText([{}]), '');
});

// The title property's NAME is user-chosen; only its type is 'title'. Looking
// it up by the key "Name" works until someone renames the column, and then
// shows up as a corpus of untitled pages weeks later.
test('the title is found by property type, never by property name', () => {
  assert.equal(pageTitle(page), 'Q3 planning');
  assert.equal(pageTitle({ title: [{ plain_text: 'A database' }] }), 'A database');
  assert.equal(pageTitle({ properties: { Status: { type: 'select' } } }), '');
});

test('block markers keep a flat dump legible', () => {
  assert.equal(blockText({ type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'H' }] } }), '# H');
  assert.equal(
    blockText({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'x' }] } }),
    '- x'
  );
  assert.equal(
    blockText({ type: 'to_do', to_do: { checked: true, rich_text: [{ plain_text: 'ship' }] } }),
    '[x] ship'
  );
});

// An unknown block type must contribute nothing rather than contribute
// garbage — the whole reason this walks rich_text instead of scraping.
test('an unknown or empty block contributes nothing', () => {
  assert.equal(blockText({ type: 'unsupported_widget', unsupported_widget: {} }), '');
  assert.equal(blockText({ type: 'divider', divider: {} }), '');
  assert.equal(blockText(null), '');
});

test('the title is not repeated when the body already leads with it', () => {
  assert.equal(composeText('T', []), 'T');
  assert.equal(composeText('', [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'b' }] } }]), 'b');
});

test('a page becomes a row keyed on its id, timestamped by last edit', () => {
  const row = notionToRow(page, [
    { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'hire two' }] } },
  ]);
  assert.equal(row.entity_id, 'notion:abc-123');
  assert.equal(row.source, 'notion');
  assert.equal(row.speaker, null);
  assert.equal(row.ts, Date.parse('2026-08-01T10:00:00.000Z'));
  assert.equal(row.meta.created_ms, Date.parse('2026-01-02T03:04:05.000Z'));
  assert.equal(row.text, 'Q3 planning\n\nhire two');
  assert.equal(row.meta.blocks, 1);
});

test('a page with no title and no readable blocks is dropped, not stored empty', () => {
  assert.equal(notionToRow({ id: 'x', last_edited_time: '2026-01-01T00:00:00Z' }, []), null);
  assert.equal(notionToRow({ last_edited_time: '2026-01-01T00:00:00Z' }, []), null, 'no id');
  assert.equal(notionToRow({ id: 'x' }, []), null, 'no usable timestamp');
});

// A short row must not be mistakable for a short page.
test('truncation is recorded in meta', () => {
  const long = [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'x'.repeat(50) }] } }];
  const row = notionToRow(page, long, { maxChars: 20 });
  assert.equal(row.text.length, 20);
  assert.equal(row.meta.truncated, true);
  assert.equal(notionToRow(page, long).meta.truncated, undefined);
});
