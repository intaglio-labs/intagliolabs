// WHICH TILES THE SHELF DRAWS — run, not read.
//
// The rest of widget/test scans source because the behaviour is in Swift or in
// a page that needs a window. These four functions need neither: they are pure
// decisions over a feature set and a status row, and the two bugs they carry
// are exactly the kind a source scan cannot see — a rule that reads correctly
// and answers the opposite of the daemon's.
//
// So the declarations are lifted out of the pages and evaluated. That is
// brittle by design: it fails loudly if somebody renames one, which is cheaper
// than a test that quietly stops covering the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const bridgeJs = readFileSync(join(UI, 'bridge.js'), 'utf8');
const connectionsJs = readFileSync(join(UI, 'connections.js'), 'utf8');

/// From `start` up to and including the first line that is exactly `end`.
function block(source, start, end, what) {
  const at = source.indexOf(start);
  assert.ok(at > 0, `could not find ${what} — has it been renamed?`);
  const close = source.indexOf(`\n${end}`, at);
  assert.ok(close > at, `could not find the end of ${what}`);
  return source.slice(at, close + end.length + 1);
}

function line(source, start, what) {
  const at = source.indexOf(start);
  assert.ok(at > 0, `could not find ${what} — has it been renamed?`);
  return source.slice(at, source.indexOf('\n', at));
}

const context = createContext({});
runInContext([
  block(bridgeJs, 'function hzFeatureOn(set, name) {', '}', 'hzFeatureOn'),
  block(bridgeJs, 'function hzConnectorFeature(set, name) {', '}', 'hzConnectorFeature'),
  line(connectionsJs, 'const kindOf =', 'kindOf'),
  block(connectionsJs, 'const BRIDGE_FLOW = {', '};', 'BRIDGE_FLOW'),
  line(connectionsJs, 'const isBridge =', 'isBridge'),
  line(connectionsJs, "const LINKEDIN_EXPORT_ID =", 'LINKEDIN_EXPORT_ID'),
  block(connectionsJs, 'function isHiddenSource(src) {', '}', 'isHiddenSource'),
  block(connectionsJs, 'function isOptionalSource(src) {', '}', 'isOptionalSource'),
  'let featureSet = null;',
  'this.setFeatures = (f) => { featureSet = f; };',
  'this.hidden = (src) => isHiddenSource(src);',
  'this.optional = (src) => isOptionalSource(src);',
  'this.bridge = (src) => isBridge(src);',
  'this.connectorFeature = (set, name) => hzConnectorFeature(set, name);',
  'this.exportId = LINKEDIN_EXPORT_ID;',
].join('\n'), context);

// The registry as the native side sends it: the FULL connector table, always.
const registry = (over = {}, features = {}) => ({
  features: { bridges: false, ...features },
  connectors: {
    imessage: true, mail: true, calendar: true, contacts: true, linkedin: true,
    whatsapp: 'optional', granola: 'optional',
    notes: false, files: false, photos: false, notion: false, oura: false, health: false,
    ...over,
  },
});
const row = (id, extra = {}) => ({ id, label: id, connected: false, ...extra });

test('a connector the registry never mentions is left alone, exactly as the daemon leaves it', () => {
  context.setFeatures(registry());
  // connectorsDisabledBy (connectors/lib/features.mjs) disables a module whose
  // feature is `false` and leaves one with NO ENTRY alone. This page used to do
  // the opposite — unknown read as false — so a status row of a kind the
  // registry has never heard of was ingested by the daemon and drawn by nobody.
  assert.equal(context.connectorFeature(registry(), 'signal'), undefined,
    'unknown is its own answer, not false');
  assert.equal(context.hidden(row('signal')), false,
    'the daemon schedules it; the shelf must show it');
  // And the promise CONNECTOR_ORDER makes out loud, for the same row.
  assert.equal(context.hidden(row('somethingNewNextYear')), false);
});

test('false hides, optional shows with its label, true shows', () => {
  context.setFeatures(registry());
  assert.equal(context.hidden(row('notes')), true, 'dormant in the registry');
  assert.equal(context.hidden(row('whatsapp')), false);
  assert.equal(context.optional(row('whatsapp')), true, "'optional' is a label, not a hide");
  assert.equal(context.hidden(row('imessage')), false);
  assert.equal(context.hidden(row('mail:someone@example.test')), false, 'a mail account is a mail row');
});

test('no answer from the bridge is still nothing on', () => {
  // hzFeatures' own catch returns an EMPTY table. Reading "unknown" out of that
  // would draw the whole shelf on a page whose bridge is dead — every tile
  // unpressable. An empty table is no answer, and no answer fails closed.
  context.setFeatures({ features: {}, connectors: {} });
  assert.equal(context.connectorFeature({ features: {}, connectors: {} }, 'imessage'), false);
  assert.equal(context.hidden(row('imessage')), true);
  assert.equal(context.hidden(row('signal')), true);
  assert.equal(context.hidden(row(context.exportId)), true);
});

// LINKEDIN IS TWO FLOWS BEHIND TWO FLAGS AND MUST ALWAYS BE EXACTLY ONE TILE.
test('with bridges off, LinkedIn is its export tile — the one the connector waits on', () => {
  context.setFeatures(registry());
  assert.equal(context.bridge(row(context.exportId)), false,
    'the export row must not be mistaken for the bridge row, or it hides with it');
  assert.equal(context.hidden(row(context.exportId)), false,
    'connectors.linkedin is on and the connector is polling ~/.hazlie/imports/linkedin');
  assert.equal(context.hidden(row('linkedin', { action: 'bridge' })), true,
    'the bridge tile stays behind the bridges feature');
});

test('with bridges on, LinkedIn is its bridge tile and only that', () => {
  context.setFeatures(registry({}, { bridges: true }));
  assert.equal(context.hidden(row('linkedin', { action: 'bridge' })), false);
  assert.equal(context.hidden(row(context.exportId)), true,
    'two LinkedIn tiles is worse than either one of them');
});

test('switching the linkedin connector off takes its export tile with it', () => {
  context.setFeatures(registry({ linkedin: false }));
  assert.equal(context.hidden(row(context.exportId)), true);
  assert.equal(context.hidden(row('linkedin', { action: 'bridge' })), true);
});
