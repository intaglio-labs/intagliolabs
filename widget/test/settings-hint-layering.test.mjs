import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const palette = readFileSync(join(WIDGET, 'ui/palette.css'), 'utf8');

test('an open settings hint paints above every neighboring hint icon', () => {
  assert.match(
    palette,
    /\.setting-hint:hover,\s*\.setting-hint:focus-within,\s*\.setting-hint\.open\s*\{\s*z-index:\s*30;/u,
    'the active hint needs its own higher stacking level or later-row icons paint over its text box'
  );
});
