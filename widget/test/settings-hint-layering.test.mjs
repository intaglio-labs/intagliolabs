import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const palette = readFileSync(join(WIDGET, 'ui/palette.css'), 'utf8');
const connections = readFileSync(join(WIDGET, 'ui/connections.js'), 'utf8');
const bare = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');

// WAS: "an open settings hint paints above every neighboring hint icon" — the
// pop-over behind a settings row's "?" needed its own stacking level, or a
// later row's icon painted over the box being read.
//
// There are no "?" icons any more (owner, 2026-09-13: "what the fuck are these
// settings??? so much fucking text??"). Every row is one line and its
// explanation is the row's `title` — a NATIVE tooltip, which is not in this
// document's stacking context at all and cannot be painted over by anything on
// the page. The layering bug is gone because the layer is.
//
// This file stays as the pin that it does not come back: a hand-built hover is
// a second mechanism for something the platform already draws, and it costs
// height in a 312px panel that has none to spare.
test('settings explains itself with a native tooltip, not a layer of its own', () => {
  for (const gone of ['setting-hint', 'setting-hint-icon', 'setting-hint-copy']) {
    assert.ok(!bare(palette).includes(gone), `.${gone} must not come back`);
    assert.ok(!bare(connections).includes(gone), `${gone} must not come back`);
  }
  assert.ok(!bare(connections).includes('infoHint'),
    'nor the builder that made them');
  // The rows do explain themselves — just on the hover the platform draws.
  const titles = [...bare(connections).matchAll(/\.title = /gu)];
  assert.ok(titles.length >= 5, 'every settings row still carries its explanation');
});
