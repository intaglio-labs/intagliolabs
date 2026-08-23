// A Notion page → a hermes context row. Pure: no I/O, no clock.

// Every Notion block that carries text carries it as a rich_text array under
// the block's own type key. Walking that array is the whole extraction — no
// guessing, no scraping, and an unknown block type contributes nothing
// rather than contributing garbage.
export function plainText(richText) {
  if (!Array.isArray(richText)) return '';
  return richText.map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : '')).join('');
}

// Notion's title lives in a property whose NAME is user-chosen; only its
// `type` is reliably 'title'. Looking it up by the key "Name" works until
// someone renames the column, which is exactly the kind of bug that shows up
// as a corpus of untitled pages six weeks later.
export function pageTitle(page) {
  const props = page?.properties;
  if (props && typeof props === 'object') {
    for (const value of Object.values(props)) {
      if (value?.type === 'title') return plainText(value.title).trim();
    }
  }
  // A database has a top-level title array instead of a title property.
  if (Array.isArray(page?.title)) return plainText(page.title).trim();
  return '';
}

// Markers that keep a flat text dump legible: without them a to-do list and
// a paragraph are indistinguishable once the block structure is gone.
const PREFIX = Object.freeze({
  heading_1: '# ',
  heading_2: '## ',
  heading_3: '### ',
  bulleted_list_item: '- ',
  numbered_list_item: '- ',
  quote: '> ',
  code: '',
  to_do: '',
});

export function blockText(block) {
  const type = block?.type;
  if (typeof type !== 'string') return '';
  const payload = block[type];
  const text = plainText(payload?.rich_text).trim();
  if (!text) return '';
  if (type === 'to_do') return `${payload?.checked ? '[x] ' : '[ ] '}${text}`;
  return `${PREFIX[type] ?? ''}${text}`;
}

export function composeText(title, blocks) {
  const body = blocks
    .map(blockText)
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (!title) return body;
  if (!body) return title;
  return `${title}\n\n${body}`;
}

export function notionToRow(page, blocks = [], { maxChars = 20000 } = {}) {
  const id = typeof page?.id === 'string' ? page.id.trim() : '';
  if (!id) return null;

  // ts is last_edited_time: a page's place in the timeline is when the owner
  // last worked on it. Created is kept in meta so the original date survives.
  const edited = Date.parse(page?.last_edited_time ?? '');
  const created = Date.parse(page?.created_time ?? '');
  const ts = Number.isFinite(edited) ? edited : created;
  if (!Number.isFinite(ts)) return null;

  const title = pageTitle(page);
  const full = composeText(title, blocks);
  const text = full.length > maxChars ? full.slice(0, maxChars) : full;
  // A page with no title and no readable blocks carries nothing to search.
  if (!text) return null;

  return {
    ts,
    source: 'notion',
    speaker: null,
    entity_id: `notion:${id}`,
    text,
    meta: {
      notion_id: id,
      object: page?.object === 'database' ? 'database' : 'page',
      ...(title ? { title } : {}),
      ...(typeof page?.url === 'string' ? { url: page.url } : {}),
      ...(page?.parent?.type ? { parent_type: page.parent.type } : {}),
      ...(Number.isFinite(created) ? { created_ms: created } : {}),
      blocks: blocks.length,
      // Says outright when the body was cut, so a short row is not mistaken
      // for a short page.
      ...(full.length > maxChars ? { truncated: true } : {}),
    },
  };
}
