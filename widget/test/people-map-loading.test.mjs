// The all-years map has a persistent shell (pan plane, stage and zoom controls).
// Loading and failure states must live inside that shell: replacing it leaves
// the renderer holding a detached stage and the loading screen never clears.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(WIDGET, 'ui', 'people-months.js'), 'utf8');
const css = readFileSync(join(WIDGET, 'ui', 'people-months.css'), 'utf8');

test('map status paints into the stage without deleting the globe shell', () => {
  assert.match(page, /const target = view === 'sky' \? skyStageEl : listEl;/u);
  assert.doesNotMatch(page, /surface\(\)\.innerHTML\s*=/u);
  assert.doesNotMatch(page, /skyEl\.innerHTML\s*=/u);
  assert.match(page, /setSurfaceHtml\(mapLoadingHtml\(\)\)/u);
});

test('cold map load shows three bare animated typing dots', () => {
  const dot = '<span aria-hidden="true"></span>';
  assert.equal(page.split(dot).length - 1, 3);
  assert.doesNotMatch(page, />reading every year…</u);
  assert.match(css, /@keyframes pm-typing-dot/u);
  assert.match(css, /\.pm-typing span:nth-child\(3\)/u);
});
