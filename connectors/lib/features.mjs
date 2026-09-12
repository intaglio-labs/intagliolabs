// THE FEATURE REGISTRY — one file, read by everything.
//
// `ops/features.json` says which of this app's surfaces are alive. Stage 1 of
// the "Reconnect, Only" repackaging turns everything the reconnection card
// does not need OFF, without deleting a line of it: the code stays in the
// repository, the feature is behind a flag that defaults off, its provisioning
// step is skipped, and its launch agent is not installed.
//
// WHY A FILE AND NOT A CONSTANT. Three processes have to agree — the Swift app,
// hermes, and the connectors daemon — and they are built and shipped together
// but started apart. A constant in one of them is a fourth opinion. The file is
// copied into the bundle by widget/build.sh (to backend/ops/features.json), so
// the repo layout and the bundle layout resolve it at the SAME relative path
// from here: ../../ops/features.json is repo/ops in a checkout and $BE/ops in
// the app. Do not "tidy" that into an absolute path.
//
// OWNER OVERRIDE. ~/.hazlie/features.json, same shape, partial allowed, merged
// over the shipped file. That is what lets a developer switch chat back on for
// an afternoon without a rebuild, and it is also the escape hatch if a flag
// turns out to have been wrong on a machine that cannot be rebuilt today.
//
// FAIL CLOSED, EXCEPT ON THE OVERRIDE. A missing or malformed registry yields
// ALL_OFF — the card's own connectors included — because "the file that says
// what is on is unreadable" must never resolve to "everything is on". The
// override is the deliberate exception: an unknown key or a bad value there is
// REPORTED and the override is DISCARDED, and the shipped registry still
// applies. A fatal override is how ~/.hazlie/connectors/config.json's closed-key
// assertion once killed the connector daemon on a single typo; this file will
// not repeat that.
//
// CONNECTOR VALUES ARE THREE-STATE, and the third one is not a boolean in
// disguise:
//   true       — the card reads it. Scheduled, tile shown.
//   false      — dormant. Disabled-marker semantics in the daemon (never
//                scheduled, logged as source_hidden), tile hidden.
//   'optional' — a real participant source, small today. Offered on the
//                connections page and labelled as optional, but NOT
//                auto-scheduled until the owner connects it; its own gate
//                (WhatsApp's .disabled marker, Granola's credential check via
//                needs()) is what lets it start. This is exactly what WhatsApp
//                already did, now written down instead of implied.
//
// `health` names no connector module today — Apple Health was replaced by the
// Oura API in 2026-08. It is listed anyway so that re-adding it cannot arrive
// switched on by inheriting a missing key.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/// Same relative path in a checkout and inside the app bundle. See the header.
export const DEFAULT_REGISTRY_PATH = join(here, '..', '..', 'ops', 'features.json');

export function defaultOverridePath(home = homedir()) {
  return join(home, '.hazlie', 'features.json');
}

/// The boolean surfaces. Order is the order they are logged in.
export const FEATURE_NAMES = Object.freeze([
  'chat', 'voice', 'bridges', 'timeline', 'constellation',
  'distiller', 'frontierHandoff', 'search',
]);

/// The connector surfaces. Not the same list as daemon.mjs' CONNECTOR_NAMES,
/// deliberately: `health` is here with no module, and `matrix` is a module with
/// no entry here because Matrix is the BRIDGES feature, not a source somebody
/// connects. connectorsDisabledBy() below is where the two lists meet.
export const CONNECTOR_FEATURE_NAMES = Object.freeze([
  'imessage', 'mail', 'calendar', 'contacts', 'linkedin',
  'whatsapp', 'granola',
  'notes', 'files', 'photos', 'notion', 'oura', 'health',
]);

/// The static default, and the answer whenever the registry cannot be read.
export const ALL_OFF = Object.freeze({
  ...Object.fromEntries(FEATURE_NAMES.map((name) => [name, false])),
  connectors: Object.freeze(
    Object.fromEntries(CONNECTOR_FEATURE_NAMES.map((name) => [name, false]))
  ),
});

function isConnectorValue(value) {
  return value === true || value === false || value === 'optional';
}

/// Merge a partial override over a full base. Throws — with a message naming
/// the offending key and NOTHING ELSE — on anything that is not a known key
/// with a legal value. The message carries no context prefix on purpose: this
/// is called both for the shipped registry and for the owner override, and each
/// caller says which one it was reading. Callers that must not die on a typo
/// catch it; see readFeatures.
export function mergeFeatures(base, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    throw new Error('must be a JSON object');
  }
  const merged = { ...base, connectors: { ...base.connectors } };
  for (const [key, value] of Object.entries(override)) {
    if (key === 'version') continue; // informational; the override is partial by design
    if (key === 'connectors') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('"connectors" must be an object');
      }
      for (const [name, state] of Object.entries(value)) {
        if (!CONNECTOR_FEATURE_NAMES.includes(name)) {
          throw new Error(`unknown connector "${name}"`);
        }
        if (!isConnectorValue(state)) {
          throw new Error(`connector "${name}" must be true, false or "optional"`);
        }
        merged.connectors[name] = state;
      }
      continue;
    }
    if (!FEATURE_NAMES.includes(key)) {
      throw new Error(`unknown feature "${key}"`);
    }
    if (typeof value !== 'boolean') {
      throw new Error(`feature "${key}" must be true or false`);
    }
    merged[key] = value;
  }
  return merged;
}

/// Parse a full registry file. Unknown keys here are the SHIPPED file's
/// problem, not a developer's, so this is strict and the caller falls back to
/// ALL_OFF rather than to a half-read registry.
export function parseRegistry(text) {
  const raw = JSON.parse(text);
  if (raw?.version !== 1) throw new Error('features registry: version must be 1');
  if (raw.features === null || typeof raw.features !== 'object' || Array.isArray(raw.features)) {
    throw new Error('features registry: "features" must be an object');
  }
  // Start from ALL_OFF so a key the shipped file forgot is OFF, not undefined.
  return mergeFeatures(ALL_OFF, raw.features);
}

/// The effective set: shipped registry, then the owner override merged over it.
/// `onProblem` is called with a one-line reason for anything that had to be
/// ignored; it never throws out of here.
export function readFeatures({
  registryPath = DEFAULT_REGISTRY_PATH,
  overridePath = defaultOverridePath(),
  onProblem = () => {},
} = {}) {
  let features = ALL_OFF;
  try {
    features = parseRegistry(readFileSync(registryPath, 'utf8'));
  } catch (error) {
    onProblem(`features registry unreadable, everything is off: ${error.message}`);
    return ALL_OFF;
  }
  let overrideText = null;
  try {
    overrideText = readFileSync(overridePath, 'utf8');
  } catch {
    return features; // no override is the normal case, not a problem
  }
  try {
    return mergeFeatures(features, JSON.parse(overrideText));
  } catch (error) {
    onProblem(`features override ignored: ${error.message}`);
    return features;
  }
}

/// Names only — never the file, never a count that would let a reader guess at
/// owner data. This is what every process logs at startup.
export function enabledFeatureNames(features) {
  return [
    ...FEATURE_NAMES.filter((name) => features[name] === true),
    ...CONNECTOR_FEATURE_NAMES
      .filter((name) => features.connectors?.[name] === true)
      .map((name) => `connector:${name}`),
    ...CONNECTOR_FEATURE_NAMES
      .filter((name) => features.connectors?.[name] === 'optional')
      .map((name) => `connector:${name}?`),
  ];
}

/// Which of the daemon's connector modules must never be scheduled.
///
/// Two rules, and the second one is the one that is easy to forget: a connector
/// whose feature is `false` is disabled, AND `matrix` is disabled whenever
/// `bridges` is off, because the Matrix bus IS the bridges feature. A module
/// with no entry in the registry at all is left alone rather than disabled —
/// silently switching off a source somebody added is worse than listing it.
export function connectorsDisabledBy(features, connectorNames) {
  return connectorNames.filter((name) => {
    if (name === 'matrix') return features.bridges !== true;
    const state = features.connectors?.[name];
    return state === false;
  });
}

/// Which connectors are offered but not auto-started.
export function optionalConnectors(features, connectorNames) {
  return connectorNames.filter((name) => features.connectors?.[name] === 'optional');
}
