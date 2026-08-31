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
  // ~~godMode / batterySaver~~ renamed to say what they do. "God Mode" told the
  // owner nothing about the machine and "Battery Saver" implied it was about the
  // charger, which it is not -- the assertion two lines down is precisely that
  // neither setting reads a power source.
  assert.match(code, /case fullSpeed = "full_speed"/u);
  assert.match(code, /case lessPower = "less_power"/u);
  // Old preferences must still resolve, or the rename silently flips somebody's
  // setting to the other one.
  assert.match(code, /case "god_mode": return \.fullSpeed/u);
  assert.match(code, /case "battery_saver": return \.lessPower/u);
  // AND THE DEFAULT IS THE GENTLE ONE. Defaulting to maximum was more aggressive
  // than anything that shipped before the setting existed, and a fresh install
  // is the run with the most work to do.
  assert.match(code, /return \.lessPower/u);
  assert.doesNotMatch(code, /thermalState|isLowPowerModeEnabled|IOPSCopyPowerSourcesInfo/u);
  assert.doesNotMatch(code, /case paused/u);
  assert.match(distiller, /PowerBudget\.current == \.trickle \? trickleBatch : batch/u);
  assert.match(connectors, /PowerBudget\.current == \.full \? \.userInitiated : \.utility/u);
});

test('Settings exposes the owner language and validates the bridge value', () => {
  assert.match(settings, /name\.textContent = 'performance'/u);
  assert.match(settings, /modeLabel\.textContent = full \? 'full speed' : 'use less power'/u);
  assert.match(settings, /sw\.setAttribute\('role', 'switch'\)/u);
  assert.match(settings, /const requested = active === FULL \? LESS : FULL/u);
  // A stored pre-rename value must not read as the opposite setting.
  assert.match(settings, /v === 'god_mode' \? FULL : LESS/u);
  assert.doesNotMatch(settings, /performance-pick/u);
  assert.match(settings, /name: 'keep mac awake'/u);
  assert.match(settings, /function settingHint\(label, copy\)/u);
  assert.match(settings, /Why leave \$\{label\} on\?/u);
  // The hint states the difference instead of recommending a side.
  assert.match(settings, /Full speed does more work in each pass/u);
  assert.match(settings, /Both keep running on battery; neither one stops/u);
  assert.match(settings, /It still allows manual sleep and lid-close/u);
  assert.match(bridge, /PerformanceMode\.migrate\(raw\)/u);
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
