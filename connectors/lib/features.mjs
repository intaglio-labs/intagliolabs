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

/// The owner override's path — and the one knob a TEST is allowed to turn.
///
/// HAZLIE_FEATURES_OVERRIDE names another file, or the literal 'none' for "no
/// override at all". Without it, a test that pins what this install ships was
/// really reading the DEVELOPER's ~/.hazlie/features.json: the daemon reads the
/// override at module scope and hermes reads it per request, so a local
/// `{"bridges":true}` turned the policy assertions red on that machine and
/// nowhere else. The variable belongs HERE rather than in each caller, because
/// hermes, the daemon and connect all reach the registry through this function
/// and only one of them is a file a test can edit.
///
/// EMPTY IS NONE, NOT "READ $HOME". `HAZLIE_FEATURES_OVERRIDE=` is the spelling
/// a wrapper produces from a variable that was never set
/// (`HAZLIE_FEATURES_OVERRIDE=$MAYBE node --test …`), and falling through to the
/// owner file there un-hermeticized exactly the tests this knob exists to make
/// hermetic. Setting the variable at all is a decision; setting it to nothing is
/// the decision to use no override, like the literal 'none'.
export function defaultOverridePath(home = homedir(), env = process.env) {
  const configured = env?.HAZLIE_FEATURES_OVERRIDE;
  if (configured === 'none' || configured === '') return null;
  if (typeof configured === 'string') return configured;
  return join(home, '.hazlie', 'features.json');
}

/// Whether the override path was NAMED by somebody rather than being the
/// default owner file. It separates two silences: the owner file is usually
/// absent and that is the normal case, while a path a human typed that is not
/// there is a mis-pointed escape hatch — which used to be indistinguishable
/// from a clean read of a file that was never opened.
export function overrideIsConfigured(env = process.env) {
  const configured = env?.HAZLIE_FEATURES_OVERRIDE;
  return typeof configured === 'string' && configured !== '' && configured !== 'none';
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

/// WHY THE REGISTRY IS ALL_OFF, when it is.
///
/// 'ok'      — it was read and parsed.
/// 'missing' — the file is not there. On a shipped app that means a broken
///             bundle; in a checkout, a deleted ops/features.json.
/// 'invalid' — it is there and unreadable: bad JSON, wrong version, a key or
///             value the loader refuses.
///
/// Both of the last two resolve to ALL_OFF, which is right — "the file that
/// says what is on is unreadable" must never resolve to "everything is on" —
/// and both used to be INDISTINGUISHABLE FROM A CORRECT ALL-OFF INSTALL at
/// every surface that reads them. The connections shelf drew the same empty
/// list it draws for "nothing connected", and the only report was one line on
/// the daemon's stderr. A total product outage deserves a different sentence
/// than a quiet Tuesday, so the state travels with the set.
export const REGISTRY_STATES = Object.freeze(['ok', 'missing', 'invalid']);

/// AND WHAT BECAME OF THE OVERRIDE, which is a separate question with separate
/// consequences.
///
/// 'none'    — there was none to apply: no path, or the owner file is simply
///             not there. The normal case, and silent.
/// 'ok'      — a file was read and merged.
/// 'missing' — a path somebody NAMED is not there. The escape hatch is
///             mis-pointed, which used to look exactly like no override at all.
/// 'invalid' — it is there and was refused: bad JSON, an unknown key, an
///             illegal value. Discarded; the shipped registry still applies.
///
/// None of the last two touch `registryState`. A bad override is not a broken
/// bundle, and reporting it as one would send the owner to reinstall over a
/// typo in a file they are invited to edit.
export const OVERRIDE_STATES = Object.freeze(['none', 'ok', 'missing', 'invalid']);

/// The effective set AND why it is what it is:
/// `{ features, registryState, overrideState }`. `onProblem` is called with a
/// one-line reason for anything that had to be ignored; it never throws out of
/// here.
///
/// `overrideConfigured` says whether the path was named rather than defaulted —
/// see overrideIsConfigured. It is only ever used to decide whether an ABSENT
/// override is worth a word.
export function readFeatureRegistry({
  registryPath = DEFAULT_REGISTRY_PATH,
  overridePath = defaultOverridePath(),
  overrideConfigured = overrideIsConfigured(),
  onProblem = () => {},
} = {}) {
  let features = ALL_OFF;
  try {
    features = parseRegistry(readFileSync(registryPath, 'utf8'));
  } catch (error) {
    // ENOENT is the bundle being incomplete; anything else is the file being
    // wrong. Same ALL_OFF answer, different thing to tell the owner.
    const registryState = error?.code === 'ENOENT' ? 'missing' : 'invalid';
    onProblem(`features registry ${registryState}, everything is off: ${error.message}`);
    return { features: ALL_OFF, registryState, overrideState: 'none' };
  }
  let overrideText = null;
  try {
    // A null path is "no override", not a file at "null": HAZLIE_FEATURES_OVERRIDE=none
    // says so explicitly, and readFileSync(null) throwing into the catch below
    // would have been the right answer for the wrong reason.
    if (overridePath === null || overridePath === undefined) {
      return { features, registryState: 'ok', overrideState: 'none' };
    }
    overrideText = readFileSync(overridePath, 'utf8');
  } catch (error) {
    // THE ONE CASE THAT IS NOT NORMAL. A file that is not there is the usual
    // shape of "this machine has no override" — unless somebody named it, in
    // which case they are acting on a file nothing read. Anything other than
    // ENOENT (a directory, a permission, an unreadable device) is the file
    // existing and refusing, which is worth saying whoever chose the path.
    const overrideState = error?.code === 'ENOENT' ? 'missing' : 'invalid';
    if (overrideState === 'invalid' || overrideConfigured) {
      onProblem(`features override unreadable, ignored: ${error.message}`);
      return { features, registryState: 'ok', overrideState };
    }
    return { features, registryState: 'ok', overrideState: 'none' };
  }
  try {
    return {
      features: mergeFeatures(features, JSON.parse(overrideText)),
      registryState: 'ok',
      overrideState: 'ok',
    };
  } catch (error) {
    onProblem(`features override ignored: ${error.message}`);
    return { features, registryState: 'ok', overrideState: 'invalid' };
  }
}

/// The effective set, for the many callers that only want the answer.
export function readFeatures(options = {}) {
  return readFeatureRegistry(options).features;
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
