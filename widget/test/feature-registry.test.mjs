// The feature registry is WIRED, not merely present.
//
// A source scan, like distiller-gate and native-bridge-runtime. It exists
// because stage 1's whole value is negative — a build that installs no bridge
// agent, downloads nothing, shows no chat button — and negative behaviour is
// exactly the kind that rots silently. Nothing on screen goes wrong when a gate
// is dropped; the app simply goes back to doing the expensive thing.
//
// These assert the wiring. connectors/test/features.test.mjs asserts the
// registry's own semantics, and pins the defaults.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const buildSh = read('widget/build.sh');
const features = read('widget/src/Features.swift');
const provision = read('widget/src/Provision.swift');
const main = read('widget/src/main.swift');
const distiller = read('widget/src/Distiller.swift');
const bridgeSwift = read('widget/src/Bridge.swift');
const widgetJs = read('widget/ui/widget.js');
const bridgeJs = read('widget/ui/bridge.js');
const connectionsJs = read('widget/ui/connections.js');
const palette = read('widget/ui/palette.css');
const hermes = read('ui/server/hermes.mjs');
const daemon = read('connectors/daemon.mjs');

test('the registry ships inside the bundle, where Features.swift looks for it', () => {
  assert.match(buildSh, /cp \.\.\/ops\/features\.json "\$BE\/ops\/"/u,
    'build.sh must copy ops/features.json into the bundle');
  // The two halves of one path. If either moves without the other, the app
  // silently runs with everything off and nothing says why.
  assert.match(features, /backend\/ops\/features\.json/u,
    'Features.swift must read it at the path build.sh writes');
});

// THE STATIC DEFAULT IS OFF, IN SWIFT TOO. The node loader's ALL_OFF is pinned
// by its own test; this is the app's copy of the same promise, and the app is
// the process that would otherwise install a Matrix homeserver.
test('an unreadable registry is everything off, in Swift', () => {
  assert.match(features, /static let allOff = FeatureSet\(/u, 'the static default must exist');
  assert.match(features, /return \.allOff/u, 'and be what load\\(\\) returns on failure');
  // Every struct field defaults to false, so allOff is not a second list that
  // could disagree with the first.
  for (const name of ['chat', 'voice', 'bridges', 'timeline', 'constellation',
    'distiller', 'frontierHandoff', 'search']) {
    assert.match(features, new RegExp(`var ${name} = false`, 'u'),
      `FeatureSet.${name} must default to false`);
  }
});

test("a bad owner override is discarded, not fatal, and not a reason to fail open", () => {
  assert.match(features, /features override ignored/u,
    'the reason must reach the log');
  assert.match(features, /catch \{[\s\S]{0,200}return base\b/u,
    'a rejected override must fall back to the SHIPPED registry, not to allOff and not to a throw');
});

// --- provisioning --------------------------------------------------------

test('the bridge runtime is not warmed, provisioned, or left running when bridges are off', () => {
  const prefetch = provision.slice(provision.indexOf('static func prefetchBridgeRuntime'));
  assert.match(prefetch.slice(0, 700), /guard Features\.shouldPrefetchBridgeRuntime/u,
    'the prefetch must ask the registry first');

  const ensure = provision.slice(provision.indexOf('static func ensureBridgeRuntime'));
  assert.match(ensure.slice(0, 700), /guard Features\.shouldEnsureBridgeRuntime/u,
    'ensureBridgeRuntime is what runs setup-bridges-native.sh — which is what installs '
    + 'io.intaglio.bridges. Refusing only in the prefetch leaves the Connect-press path open.');
  assert.match(ensure.slice(0, 700), /completion\(false\)/u,
    'a refused setup must still answer its caller, or a Connect press hangs forever');
});

// SKIPPING THE INSTALL IS NOT ENOUGH ON AN UPGRADE. launchd already holds the
// job, the plist is RunAtLoad + KeepAlive, and it comes back every login.
test('an already-installed bridges agent is retired on the next launch', () => {
  assert.match(provision, /static func retireBridgesAgent\(\)/u);
  const fn = provision.slice(provision.indexOf('static func retireBridgesAgent'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 5);
  assert.match(body, /"io\.intaglio\.bridges"/u, 'it must name the label');
  assert.match(body, /"bootout", "gui\/\\\(getuid\(\)\)\/\\\(label\)"/u,
    'bootout, the way retireConnectorsAgent does it');
  assert.match(body, /removeItem\(at: plist\)/u,
    'and the plist goes, or launchd re-bootstraps it at the next login');
  // IT MUST NOT DELETE DATA. Stage 1 is dormancy; a re-enable should be a flag
  // flip, not a re-download and seven re-logins. Matched against the CODE, not
  // the prose — the log line says "matrix" and "bridges" on purpose, to tell the
  // reader what survived.
  const code = body.replace(/\/\/[^\n]*/gu, '').replace(/NSLog\([\s\S]*?\)\n/u, '');
  assert.doesNotMatch(code, /removeItem\(at: hazlie|matrix|bridges\//u,
    'retiring the agent must not touch ~/.hazlie/matrix or ~/.hazlie/bridges');
  // And it has to be REACHED. prefetchBridgeRuntime runs on every launch from
  // main.swift, which is the only hook an upgraded machine reliably reaches.
  //
  // Scoped to the bridges-off arm of the guard rather than to the first 700
  // bytes of the function. Same promise, said properly: the byte count was a
  // stand-in for "in the early-return arm", and it went red the day that arm
  // grew a comment explaining why the call is dispatched rather than made.
  const prefetch = provision.slice(provision.indexOf('static func prefetchBridgeRuntime'));
  const guardAt = prefetch.indexOf('guard Features.shouldPrefetchBridgeRuntime');
  assert.ok(guardAt > 0, 'the prefetch must still ask the registry first');
  const offArm = prefetch.slice(guardAt, prefetch.indexOf('\n    }\n', guardAt));
  assert.match(offArm, /retireBridgesAgent\(\)/u,
    'nothing would call it otherwise');
  assert.match(main, /Provision\.prefetchBridgeRuntime\(\)/u,
    'and launch must still call the prefetch, which is now also the retirement hook');
});

// RETIRING IS NOT FREE, AND LAUNCH IS THE WORST PLACE TO PAY FOR IT.
// prefetchBridgeRuntime() is called synchronously from
// applicationDidFinishLaunching, and retireBridgesAgent() does p.run() +
// waitUntilExit() on `launchctl bootout` of a KeepAlive supervisor owning
// Synapse and seven mautrix children. Bare on that thread, the first launch
// after upgrading a machine that HAD bridges beachballs for the length of the
// teardown — the cost landing on exactly the install this stage makes lighter.
test('the bridges agent is retired off the main thread', () => {
  const prefetch = provision.slice(provision.indexOf('static func prefetchBridgeRuntime'));
  const head = prefetch.slice(0, 1800).replace(/\/\/[^\n]*/gu, '');
  const calls = [...head.matchAll(/retireBridgesAgent\(\)/gu)];
  assert.ok(calls.length > 0, 'the prefetch must still be the retirement hook');
  for (const call of calls) {
    assert.match(head.slice(Math.max(0, call.index - 80), call.index),
      /DispatchQueue\.global\(qos: \.utility\)\.async \{\s*$/u,
      'retireBridgesAgent must be dispatched to the utility queue, never called '
      + 'on the thread that is trying to finish launching');
  }
  // The precedent it follows, named here so retiring THAT one says so too.
  assert.match(
    main,
    /DispatchQueue\.global\(qos: \.utility\)\.async \{\s*\n\s*Provision\.retireConnectorsAgent\(\)/u,
    'main.swift does the same for the connectors agent, and for the same reason');
});

test('the voice models are not cloned into ~/.hazlie when voice is off', () => {
  assert.match(provision, /if Features\.shouldCloneVoiceModels\(Features\.current\) \{/u);
  const at = provision.indexOf('shouldCloneVoiceModels');
  const near = provision.slice(at, at + 400);
  assert.match(near, /cloneTree\(voiceSrc, voiceDst\)/u,
    'the clone must be INSIDE the gate, not beside it');
});

// --- the app's surfaces --------------------------------------------------

test('the dormant panels are never built', () => {
  assert.match(main, /if Features\.shouldBuildEarWebView\(Features\.current\) \{/u,
    'the ear webview is a live WKWebView in the widget window; dormant must cost nothing');
  const ensureChat = main.slice(main.indexOf('private func ensureChatPanel'));
  assert.match(ensureChat.slice(0, 400), /guard Features\.shouldBuildChatPanel/u,
    'every chat entry point goes through ensureChatPanel, so the gate belongs there');
  assert.match(ensureChat.slice(0, 400), /NSLog/u, 'and it must say so');
});

// SURVIVING chatPanel == nil IS NOT THE SAME AS HANDLING IT. voiceNote's else
// arm set pendingVoiceNote and called ensureChatPanel(), which with `chat` off
// builds nothing — so takePendingVoiceNote(), reached only by the chat page's
// ready handshake, is never called and the note sits in a property for the life
// of the process. Not shown, not delivered, not dropped, not logged. Dead only
// because the ear is not built without `voice`; live the moment an override
// says voice:true without chat:true, which it explicitly allows.
test('a voice note with chat off is dropped and counted, never queued', () => {
  const at = main.indexOf('func voiceNote(');
  assert.ok(at > 0, 'could not find voiceNote');
  const rest = main.slice(at);
  const body = rest.slice(0, rest.indexOf('\n  }\n') + 5).replace(/\/\/[^\n]*/gu, '');
  const gateAt = body.indexOf('guard Features.shouldBuildChatPanel(Features.current) else {');
  const queueAt = body.indexOf('pendingVoiceNote = message');
  assert.ok(gateAt >= 0, 'voiceNote must ask whether a panel can exist at all');
  assert.ok(queueAt > gateAt,
    'the queue must be unreachable with chat off — a pending note nothing drains '
    + 'is worse than a dropped one, because nothing ever says it happened');
  // The guard's OWN block, not everything up to the queue — the chat-on path
  // between them legitimately passes the message to the page, and a slice that
  // swallowed it would make the privacy assertion below pass for the wrong
  // reason and then fail for the wrong reason.
  const drop = body.slice(gateAt, body.indexOf('\n    }', gateAt));
  assert.match(drop, /\breturn\b/u, 'the gate must return, not fall through');
  assert.match(drop, /NSLog\([^\n]*message\.count/u, 'and it must say so as a COUNT');
  // A voice note is the owner talking. Names and counts, never the words —
  // the same rule Features.logEnabled holds to.
  assert.doesNotMatch(drop, /jsString\(message\)|\\\(message\)(?!\.count)/u,
    'the log must never carry the text of the note');
});

// EVERY CHAT CALLER HAS TO SURVIVE chatPanel STAYING NIL. A gate that turns a
// missing panel into a crash is worse than no gate.
test('nothing force-unwraps the chat panel', () => {
  // Scoped to each function's own body — `\n  }` is this file's closing brace
  // for a method — so a force-unwrap in the NEXT method cannot fail this test
  // and, more to the point, cannot pass it either.
  for (const fn of ['func openChat()', 'func openChat(with utterance: String)', 'func voiceNote(']) {
    const at = main.indexOf(fn);
    assert.ok(at > 0, `could not find ${fn}`);
    const rest = main.slice(at);
    const whole = rest.slice(0, rest.indexOf('\n  }\n') + 5);
    assert.ok(whole.length > 40 && whole.length < 2000, `suspicious body extracted for ${fn}`);
    // Comments stripped: one of these explains why the force-unwrap went, and
    // matching prose would make the test permanently red for saying so.
    const body = whole.replace(/\/\/[^\n]*/gu, '');
    assert.doesNotMatch(body, /chatPanel!/u, `${fn} force-unwraps chatPanel`);
    assert.doesNotMatch(body, /chatWeb!/u, `${fn} force-unwraps chatWeb`);
  }
});

test('voice verbs are inert and say why', () => {
  const arm = main.slice(main.indexOf('func armVoice()'));
  assert.match(arm.slice(0, 300), /guard Features\.on\("voice"\)/u);
  assert.match(arm.slice(0, 300), /NSLog/u, 'a tap that does nothing must not also say nothing');
  const speak = main.slice(main.indexOf('func speakAnswer('));
  assert.match(speak.slice(0, 200), /guard Features\.on\("voice"\)/u);
});

// THE PEOPLE REVIEW IS A KEEP, AND THE TIMELINE WAS ITS ONLY DOOR.
// openPeople is in the `people-months` capability list and nowhere else the
// widget can reach, so returning early here would have made "Same person?"
// unreachable — and a wrong merge is a wrong card.
test('with the timeline off, the People button opens the People review instead', () => {
  const fn = main.slice(main.indexOf('func openMonths()'));
  const head = fn.slice(0, 1400);
  assert.match(head, /Features\.peopleButtonOpensPeopleDirectly/u);
  assert.match(head, /openPeople\(\)/u,
    'the button must still reach the review, not return into nothing');
  const gateAt = head.indexOf('peopleButtonOpensPeopleDirectly');
  const buildAt = head.indexOf('monthsPanel = makePanel');
  assert.ok(gateAt > 0 && (buildAt === -1 || gateAt < buildAt),
    'the gate must sit before the panel is built');
});

// A hidden page posting nothing needs no grant change, and the lists are
// asserted against the pages' own hzPost calls by bridge-capabilities.test.mjs
// — trimming them would fail THAT. They stay, describing pages that are not
// built. Stated as a test so the decision is not re-litigated by inspection.
test('the bridge capability allowlists are unchanged by this stage', () => {
  for (const page of ['"chat":', '"ear":', '"people-months":']) {
    assert.ok(bridgeSwift.includes(page),
      `${page} must keep its capability entry — a page that is never loaded posts nothing`);
  }
});

// --- the widget page -----------------------------------------------------

test('the registry reaches the pages on prefs, which every page may already ask', () => {
  assert.match(bridgeSwift, /"features": Dictionary\(uniqueKeysWithValues:/u);
  assert.match(bridgeSwift, /"connectorFeatures": Dictionary\(uniqueKeysWithValues:/u);
  // FLATTENING 'optional' AT THIS BOUNDARY is how the connections page would
  // lose the distinction it exists to show.
  assert.match(bridgeSwift, /case \.optional: return \(name, "optional"\)/u);
  assert.match(bridgeJs, /function hzFeatures\(\)/u);
  assert.match(bridgeJs, /catch\(\(\) => \(\{ features: \{\}, connectors: \{\} \}\)\)/u,
    'no bridge, nothing on — the page loader fails closed too');
});

test('the chat pill is hidden before the first paint, not after the answer', () => {
  const at = widgetJs.indexOf('chatBtn.hidden = true;');
  assert.ok(at > 0, 'the pill must start hidden');
  const revealAt = widgetJs.indexOf("hzFeatureOn(set, 'chat')");
  assert.ok(revealAt > at,
    'hiding must come BEFORE the async reveal, or every launch flashes a door that does not open');
  assert.match(widgetJs, /winput\.hidden = true;/u,
    'the glyph is the collapsed pill\'s only visible part; hiding one without the other '
    + 'leaves an invisible strip that swallows clicks');
  // [hidden] loses to a class that sets display — palette.css records that
  // lesson. Belt and braces, stated in CSS.
  assert.match(palette, /\.wchat\[hidden\], \.wbar input\[hidden\] \{ display: none; \}/u);
});

test('the orb still answers the finger, and promises nothing, when voice is off', () => {
  const tap = widgetJs.slice(widgetJs.indexOf('function orbTap()'));
  const body = tap.slice(0, tap.indexOf('orbBtn.addEventListener'));
  const wakeAt = body.indexOf('wakeOrb();\n    // VOICE OFF');
  const gateAt = body.indexOf('if (!voiceFeatureOn) return;');
  assert.ok(wakeAt > 0, 'the wake must stay outside the gate — an orb that does not blink reads as broken');
  assert.ok(gateAt > wakeAt, 'and the gate must come after it');
  const teaseAt = body.indexOf('if (VOICE_TEASE) { showTease(); return; }');
  assert.ok(teaseAt > gateAt,
    'VOICE_TEASE keeps its exact meaning for when voice is ON, and sits behind the feature');
  assert.match(widgetJs, /let voiceFeatureOn = false;/u,
    'it must start false, or a tap in the first frames of a launch promises what the build lacks');
});

// --- the connections shelf ----------------------------------------------

test('the tile list is derived from the registry, not hand-maintained', () => {
  assert.doesNotMatch(connectionsJs, /^const HIDDEN_CONNECTORS = new Set\(\[/mu,
    'the hardcoded set must be gone, not shadowed');
  assert.match(connectionsJs, /function isHiddenSource\(src\)/u);
  assert.match(connectionsJs, /hzConnectorFeature\(featureSet, kindOf\(src\.id\)\) === false/u);
  // LINKEDIN IS BOTH A BRIDGE PLATFORM AND THE EXPORT CONNECTOR, sharing one
  // hermes source name. Filtering by id would have switched the export off with
  // the bridge tile; isBridge is the discriminator.
  assert.match(connectionsJs, /if \(isBridge\(src\)\) return !hzFeatureOn\(featureSet, 'bridges'\);/u);
  assert.match(connectionsJs, /featureSet = await hzFeatures\(\);/u,
    'and it must be resolved before the first tile is built, or the shelf renders twice');
});

test("'optional' is a label on the tile, not a silent third state", () => {
  assert.match(connectionsJs, /function isOptionalSource\(src\)/u);
  assert.match(connectionsJs, /\$\{src\.label\} · optional/u,
    'without the word, "not connected" on a source nothing auto-starts reads as broken');
  assert.match(connectionsJs, /row\.dataset\.optional = 'true'/u);
});

// --- the daemon and hermes ----------------------------------------------

test('the daemon derives its disabled set instead of keeping a second list', () => {
  assert.doesNotMatch(daemon, /DEFAULT_DISABLED_CONNECTORS = Object\.freeze\(\[\s*'oura'/u,
    'the hardcoded list must be gone');
  assert.match(daemon, /connectorsDisabledBy\(FEATURES, CONNECTOR_NAMES\)/u);
  assert.match(daemon, /features: enabledFeatureNames\(FEATURES\)/u,
    'and it must log which features are on — names only');
});

test('hermes echoes the effective set on /stats', () => {
  assert.match(hermes, /import \{ readFeatures \} from '\.\.\/\.\.\/connectors\/lib\/features\.mjs'/u,
    'one shared loader, following the pinnedThread/googleClients precedent');
  const stats = hermes.slice(hermes.indexOf("url.pathname === '/stats'"));
  const body = stats.slice(0, stats.indexOf('const gone = GONE.get'));
  assert.match(body, /features = readFeatures\(\)/u);
  assert.match(body, /try \{[\s\S]{0,120}readFeatures\(\)[\s\S]{0,80}catch/u,
    'an unreadable registry must never take /stats down');
  assert.match(body, /\n        features,\n/u, 'and it must actually be sent');
});

// --- the distiller -------------------------------------------------------

test('the distill gate is the marker AND the feature, and the card keeps its own', () => {
  assert.match(distiller, /Features\.shouldDistill\(Features\.current,/u);
  assert.match(distiller, /markerPresent: fm\.fileExists\(atPath: enableMarker\.path\)/u,
    'ANDed with the existing marker, never replacing it');
  assert.match(features, /f\.distiller && markerPresent/u, 'and the helper must AND, not OR');
  // SWEEP, LOOKUP AND LINT ARE THE CARD. Gate those and the product stops.
  for (const marker of ['sweepEnableMarker', 'lookupEnableMarker', 'lintEnableMarker']) {
    const at = distiller.indexOf(`private var ${marker}`);
    assert.ok(at > 0, `${marker} must still exist`);
    const decl = distiller.slice(at, distiller.indexOf('\n', at + 120));
    assert.doesNotMatch(decl, /Features\./u, `${marker} must NOT be gated on a feature flag`);
  }
  const enabledLine = distiller.slice(distiller.indexOf('private var sweepEnabled'), 200 + distiller.indexOf('private var sweepEnabled'));
  assert.doesNotMatch(enabledLine, /Features\./u, 'the sweep is the card\'s ingest');
});
