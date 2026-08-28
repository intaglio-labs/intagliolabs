// The all-time constellation is dense enough to need inspection at more than
// one scale. Keep both discoverable controls and native trackpad pinch support
// on the same zoom state, while preserving ordinary scroll gestures.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const script = readFileSync(join(UI, 'people-months.js'), 'utf8');
const html = readFileSync(join(UI, 'people-months.html'), 'utf8');
const css = readFileSync(join(UI, 'people-months.css'), 'utf8');
const helper = readFileSync(join(UI, '..', 'helpers', 'AppleData.swift'), 'utf8');

test('the constellation has a fixed top-right zoom bar', () => {
  assert.match(html, /id="sky-zoom-range"/u);
  assert.match(html, /id="sky-zoom-out"/u);
  assert.match(html, /id="sky-zoom-in"/u);
  assert.match(html, /id="sky-pan"/u);
  assert.match(css, /\.pm-sky-zoom \{[\s\S]*?top: 10px;[\s\S]*?right: 10px;/u);
  assert.match(css, /\.pm-sky-stage \{[\s\S]*?zoom: var\(--pm-sky-zoom/u);
  assert.doesNotMatch(css, /transform: scale\(var\(--pm-sky-zoom/u,
    'transform scaling rasterizes the 1x field and makes zoomed UI blurry');
});

test('zoom keeps one fixed scene geometry instead of reflowing clusters into mush', () => {
  assert.match(script, /const stage = \{ w: skyEl\.clientWidth \|\| 400, h: skyEl\.clientHeight \|\| 420 \};/u);
  assert.match(script, /skyStageEl\.style\.width = `\$\{stage\.w\}px`;/u);
  assert.match(script, /el\.style\.left = `\$\{\(stage\.w \/ 2 \+ spot\.x\)\.toFixed\(1\)\}px`;/u);
  assert.doesNotMatch(script, /spot\.x \* 100/u, 'cluster coordinates must not mix percentages with zoomed pixels');
  assert.match(script, /core\.style\.left = `\$\{stage\.w \/ 2\}px`;/u);
  assert.match(helper, /downscaleJPEG\(_ data: Data\?, max: CGFloat = 256\)/u,
    'contact photos need enough source pixels for the maximum camera zoom');
});

test('trackpad pinch zooms the field without hijacking ordinary scrolling', () => {
  assert.match(script, /if \(e\.ctrlKey\) \{/u);
  assert.match(script, /if \(skyZoom <= 1\.001\) return;/u,
    'ordinary two-finger scrolling is untouched when there is no enlarged field to pan');
  assert.match(script, /setSkyZoom\(skyZoom \* Math\.exp\(-e\.deltaY \* 0\.008\), skyPoint/u);
  assert.match(script, /gesturechange/u);
  assert.match(script, /setSkyZoom\(gestureBaseZoom \* \(Number\(e\.scale\) \|\| 1\), gestureAnchor\)/u);
});

test('the constellation pans by two-finger scroll and pointer drag', () => {
  assert.match(script, /setSkyPan\(skyPanX - e\.deltaX, skyPanY - e\.deltaY\)/u);
  assert.match(script, /setPointerCapture\(e\.pointerId\)/u);
  assert.match(script, /setSkyPan\(skyDrag\.panX \+ dx, skyDrag\.panY \+ dy\)/u);
  assert.match(script, /return Math\.max\(min, Math\.min\(max, value\)\)/u,
    'panning must stop at its bounded field edges');
});

test('pointer dragging works at default and zoomed-out scales', () => {
  const pointerDown = script.match(/skyEl\.addEventListener\('pointerdown',[\s\S]*?\n  \}\);/u)?.[0] ?? '';
  assert.ok(pointerDown, 'pointerdown handler must exist');
  assert.doesNotMatch(pointerDown, /skyZoom\s*<=/u,
    'default-scale dragging must not be gated behind zoom > 1');
  assert.match(pointerDown, /e\.preventDefault\(\)/u,
    'WebKit must not claim the press before pointer capture');
  assert.match(script, /SKY_PAN_BLEED_RATIO/u,
    'the 1x camera needs a bounded non-zero drag range');
  assert.match(css, /\.pm-sky \.pm-sky-pan \{ cursor: grab; \}/u,
    'the default-scale canvas must advertise that it is draggable');
});
