import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const power = readFileSync(join(WIDGET, 'src/PowerBudget.swift'), 'utf8');
const bridge = readFileSync(join(WIDGET, 'src/Bridge.swift'), 'utf8');
const connectors = readFileSync(join(WIDGET, 'src/Connectors.swift'), 'utf8');
const distiller = readFileSync(join(WIDGET, 'src/Distiller.swift'), 'utf8');
const settings = readFileSync(join(WIDGET, 'ui/connections.js'), 'utf8');

test('performance is explicit and never pauses for battery or heat', () => {
  const code = power.split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');
  assert.match(code, /case godMode = "god_mode"/u);
  assert.match(code, /case batterySaver = "battery_saver"/u);
  assert.doesNotMatch(code, /thermalState|isLowPowerModeEnabled|IOPSCopyPowerSourcesInfo/u);
  assert.doesNotMatch(code, /case paused/u);
  assert.match(distiller, /PowerBudget\.current == \.trickle \? trickleBatch : batch/u);
  assert.match(connectors, /PowerBudget\.current == \.full \? \.userInitiated : \.utility/u);
});

test('Settings exposes the owner language and validates the bridge value', () => {
  assert.match(settings, /name\.textContent = 'performance'/u);
  assert.match(settings, /modeLabel\.textContent = godMode \? 'god mode' : 'battery saver'/u);
  assert.match(settings, /sw\.setAttribute\('role', 'switch'\)/u);
  assert.match(settings, /const requested = active === 'god_mode' \? 'battery_saver' : 'god_mode'/u);
  assert.doesNotMatch(settings, /performance-pick/u);
  assert.match(settings, /name: 'keep mac awake'/u);
  assert.match(settings, /function settingHint\(label, copy\)/u);
  assert.match(settings, /Why leave \$\{label\} on\?/u);
  assert.match(settings, /God Mode uses this Mac’s safe maximum/u);
  assert.match(settings, /It still allows manual sleep and lid-close/u);
  assert.match(bridge, /PerformanceMode\(rawValue: raw\)/u);
  assert.match(bridge, /"performance": PowerBudget\.mode\.rawValue/u);
  assert.match(bridge, /"keepAwake": KeepMacAwake\.enabled/u);
});

test('Settings orders everyday controls before performance tuning', () => {
  const block = /async function renderSettings\(\) \{([\s\S]*?)settings\.replaceChildren/u.exec(settings)?.[1];
  assert.ok(block, 'renderSettings block not found');
  const positions = [
    block.indexOf("name: 'animations'"),
    block.indexOf("name: 'sounds'"),
    block.indexOf("name: 'keep mac awake'"),
    block.indexOf('rows.push(performanceRow'),
  ];
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('keep awake is scoped to processing and uses a safe idle-sleep assertion', () => {
  const code = power.split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');
  assert.match(power, /if enabled && processing/u);
  assert.match(power, /kIOPMAssertionTypeNoIdleSleep/u);
  assert.match(power, /IOPMAssertionRelease/u);
  assert.doesNotMatch(code, /caffeinate|PreventSystemSleep/u);
  assert.match(bridge, /KeepMacAwake\.update\(processing: true\)/u);
  assert.match(bridge, /KeepMacAwake\.update\(processing: false\)/u);
});
