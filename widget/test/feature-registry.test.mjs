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
const statusApi = read('connect/lib/statusApi.mjs');
const connectStatus = read('connect/lib/status.mjs');

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
  // The load now answers the set AND why (RegistryState), so the failure return
  // is a tuple. Same promise, one spelling later.
  assert.match(features, /return \(\.allOff, \.(missing|invalid)\)/u,
    'and be what the load returns on failure');
  // Every struct field defaults to false, so allOff is not a second list that
  // could disagree with the first.
  for (const name of ['chat', 'voice', 'bridges', 'timeline', 'constellation',
    'distiller', 'frontierHandoff', 'search']) {
    assert.match(features, new RegExp(`var ${name} = false`, 'u'),
      `FeatureSet.${name} must default to false`);
  }
});

// `{"chat": 1}` IS NOT `{"chat": true}` — AND SWIFT IS WHERE THAT BIT.
//
// JSONSerialization returns NSNumber for both JSON `true` and JSON `1`, and
// `as? Bool` conditionally bridges 1 to true and 0 to false. node's loader
// requires `typeof value === 'boolean'` and throws the WHOLE override away, so
// one override file made the app build the chat panel while hermes and the
// daemon reported chat off — two processes acting on two different registries.
//
// THERE IS NO SWIFT TEST HARNESS IN THIS REPO, so this is a source scan, like
// every other Swift assertion in this file. The behaviour was verified out of
// band by compiling widget/src/Features.swift against a throwaway main and
// feeding it `{"chat": 1}`, `{"chat": 0}`, `{"connectors": {"notes": 1}}` and
// the real booleans; the numeric forms are rejected and the booleans are not.
// connectors/test/features.test.mjs pins the node half of the same rule.
test('a JSON number is not a JSON boolean, in the app loader too', () => {
  assert.match(features, /CFGetTypeID\(value as CFTypeRef\) == CFBooleanGetTypeID\(\)/u,
    'the only check that tells kCFBooleanTrue from __NSCFNumber');
  // And it must be what BOTH merges ask. `as? Bool` anywhere in this file is
  // the bug walking back in.
  assert.match(features, /guard let flag = jsonBool\(value\) else \{/u, 'the feature flags');
  assert.match(features, /\} else if let flag = jsonBool\(state\) \{/u, 'and the connector states');
  const merge = features.slice(features.indexOf('static func merge('));
  assert.doesNotMatch(merge.replace(/\/\/[^\n]*/gu, ''), /as\? Bool/u,
    'a conditional Bool bridge accepts 1 and 0 — that is the whole finding');
});

// AND `{"version": true}` IS NOT `{"version": 1}` — THE SAME BUG, ONE FIELD UP.
//
// jsonBool was applied to every flag and not to the version, and `as? Int` on
// the NSNumber that JSON `true` bridges to yields 1. So a registry shipped with
// `"version": true` parsed in the app — full feature set, chat panel and all —
// while node (`raw?.version !== 1`) threw the file away and answered ALL_OFF:
// the daemon scheduling nothing and the shelf drawing its red line, on the same
// Mac, off the same file.
//
// Verified out of band the way the flags were, by compiling widget/src/
// Features.swift against a throwaway main and feeding it each version value:
// `true` and `false` are refused, `1` and `1.0` are accepted, `"1"` and `2` are
// refused — and the pre-fix file accepts `true`, which is the finding. node
// agrees on every one of those, including 1.0.
test('a JSON boolean is not a version number either', () => {
  assert.match(features, /static func jsonNumber\(_ value: Any\?\) -> NSNumber\? \{/u,
    'the version needs the same CFBoolean discrimination the flags have');
  assert.match(features, /CFGetTypeID\(value as CFTypeRef\) != CFBooleanGetTypeID\(\) else \{ return nil \}/u,
    'a boolean is refused before the NSNumber bridge can launder it into 1');
  assert.match(features, /jsonNumber\(object\["version"\]\)\?\.intValue == 1,/u,
    'and it must be what parseRegistry asks');
  const parse = features.slice(features.indexOf('static func parseRegistry('));
  assert.doesNotMatch(parse.slice(0, parse.indexOf('\n  }')), /as\? Int/u,
    'a conditional Int bridge accepts true — that is the whole finding');
});

test("a bad owner override is discarded, not fatal, and not a reason to fail open", () => {
  assert.match(features, /features override ignored/u,
    'the reason must reach the log');
  assert.match(features, /catch \{[\s\S]{0,200}return \(base, \.ok\)/u,
    'a rejected override must fall back to the SHIPPED registry, not to allOff and not to a throw');
  // And a bad override is NOT an unreadable registry: the state stays 'ok', or
  // the shelf would send the owner to reinstall over a typo in a file they are
  // invited to edit.
  assert.doesNotMatch(features, /catch \{[\s\S]{0,200}return \(base, \.invalid\)/u);
});

// A MISSING REGISTRY IS A TOTAL OUTAGE, AND IT MUST NOT LOOK LIKE A QUIET ONE.
//
// ALL_OFF switches off imessage, mail, calendar and contacts — the card's own
// sources — so the daemon schedules nothing and the shelf draws an empty grid,
// pixel for pixel what a machine with nothing connected draws. The only report
// was one line on the daemon's stderr, outside the structured log the app reads.
test('an unreadable registry is told apart from an empty one, everywhere', () => {
  // Swift: the state exists, travels with the set, and names the two failures.
  assert.match(features, /enum RegistryState: String \{/u);
  for (const state of ['case ok', 'case missing', 'case invalid']) {
    assert.ok(features.includes(state), `RegistryState must carry ${state}`);
  }
  assert.match(features, /static func loadWithState\(/u,
    'the set and the reason must come from ONE read, or they can disagree');
  assert.match(features, /return \(\.allOff, \.missing\)/u, 'no file at all');
  assert.match(features, /return \(\.allOff, \.invalid\)/u, 'a file that will not parse');

  // node: the same three words, from the same loader everything else uses.
  assert.match(daemon, /readFeatureRegistry\(\{/u);
  assert.match(daemon, /export const FEATURES_REGISTRY_STATE/u);
  assert.match(daemon, /log\.error\('features_registry_unreadable'/u,
    'the structured log is where the app looks; stderr is not');
  const event = daemon.slice(daemon.indexOf("log.error('features_registry_unreadable'"));
  const body = event.slice(0, event.indexOf('});') + 3);
  assert.match(body, /registryState: FEATURES_REGISTRY_STATE/u);
  // COUNTS AND NAMES ONLY, like every other line this logger carries.
  assert.doesNotMatch(body, /readFileSync|registryPath|homedir|\$\{/u,
    'no paths and no file contents in a log line');

  // The connect payload carries it to the page...
  assert.match(connectStatus, /export function featureRegistryStatus\(\{ home = homedir\(\) \} = \{\}\)/u,
    'with the home every other reader on that page takes');
  assert.match(statusApi, /featureRegistryStatus\(\{ home \}\)/u);
  // And the daemon's own view beside it: it caches the registry at module scope,
  // so a repair under a running daemon must not read as a recovery.
  assert.match(connectStatus, /export function daemonRegistryState\(\{ home = homedir\(\), now = Date\.now\(\) \} = \{\}\)/u);
  assert.match(statusApi, /daemonRegistryState: daemonRegistryState\(\{ home \}\)/u);
  // SCOPED TO THE CALL, not matched as one line of source. This used to pin the
  // literal `registryState: FEATURES_REGISTRY_STATE, ...`, which is a claim
  // about where the line WRAPS: adding one more key to the snapshot reflowed the
  // object and failed a test about a fact that had not changed. The fact is that
  // the word is written into the activity file beside whatever else the snapshot
  // carries, and that is what is read here.
  const publish = daemon.slice(daemon.indexOf('const publishActivity = (activity) => {'));
  const written = publish.slice(publish.indexOf('writeActivity('), publish.indexOf('activityPath'));
  assert.ok(written.length > 0, 'publishActivity no longer calls writeActivity');
  assert.match(written, /registryState: FEATURES_REGISTRY_STATE/u,
    'published into the activity file the app already reads');
  assert.match(written, /\.\.\.\(total \?\? \{\}\)/u,
    'and beside the rest of the snapshot, not instead of it');
  // ...and the page says it in words, in the alarm colour, instead of drawing
  // the same blank shelf it draws for "nothing connected".
  assert.match(connectionsJs, /registry: 'feature registry unreadable/u);
  assert.match(connectionsJs, /if \(data\.registryState && data\.registryState !== 'ok'\)/u);
  assert.match(connectionsJs, /notice\.style\.color = chosen && chosen\.alarm \? 'var\(--status-bad\)' : '';/u,
    'through element.style (these pages ship a CSP with no unsafe-inline), and '
      + 'CLEARED on every path rather than only on the happy one — see '
      + 'widget/test/registry-notice.test.mjs');
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

// ~~THE PEOPLE REVIEW IS A KEEP, AND THE TIMELINE WAS ITS ONLY DOOR.~~
// It was, and the routing this test used to pin — timeline off, People button
// opens the "Same person?" review instead — was right while find-pairs was a
// keep. The surface review (2026-09-13) settled the other way: the review IS
// the find-pairs window the owner asked to take off the bar, so with `timeline`
// off the button is HIDDEN (widget.js, before the first paint) and the verb it
// used to post returns early. Rewritten rather than deleted, because the pages
// and their grants are still there and the next reader is owed the reason.
test('with the timeline off, the People button is gone and its verb opens nothing', () => {
  const fn = main.slice(main.indexOf('func openMonths()'));
  const head = fn.slice(0, 1600);
  assert.match(head, /guard Features\.shouldBuildTimelinePanel\(Features\.current\) else/u,
    'openMonths must read the same flag that decides whether the panel exists');
  const gateAt = head.indexOf('shouldBuildTimelinePanel');
  const buildAt = head.indexOf('monthsPanel = makePanel');
  assert.ok(gateAt > 0 && (buildAt === -1 || gateAt < buildAt),
    'the gate must sit before the panel is built');
  // The early return must not route anywhere — reaching openPeople() here is
  // exactly the behaviour that was removed.
  const gate = head.slice(gateAt, head.indexOf('\n    }', gateAt));
  assert.match(gate, /\breturn\b/u, 'the gate must return, not fall through');
  assert.doesNotMatch(gate, /openPeople\(\)/u,
    'the People review is not a door the button keeps any more');
  // And the button itself: hidden before the first paint, revealed only by the
  // registry's answer, the same shape as the chat pill beside it.
  assert.match(widgetJs, /monthsBtn\.hidden = true;/u,
    'the People button must be hidden synchronously, not after the bridge answers');
  assert.match(widgetJs, /monthsBtn\.hidden = !timelineFeatureOn;/u,
    "and revealed only when the registry says `timeline` is on");
  assert.match(widgetJs, /if \(!timelineFeatureOn\) return;/u,
    'a press landing before the answer must not open the popup either');
  // .gear sets `display: flex`, so the attribute alone would change nothing on
  // screen. This is the rule that makes `hidden` mean hidden.
  assert.match(palette, /\.gear\[hidden\] \{ display: none; \}/u,
    'a class that sets display beats [hidden] — palette.css must say otherwise');
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
  assert.match(connectionsJs, /hzConnectorFeature\(featureSet, connectorOf\(src\.id\)\) === false/u,
    'by CONNECTOR, not by id: a mail:<address> row is the mail connector and the '
      + 'export row is the linkedin one');
  // LINKEDIN IS BOTH A BRIDGE PLATFORM AND THE EXPORT CONNECTOR, sharing one
  // hermes source name. Filtering by id would have switched the export off with
  // the bridge tile; isBridge is the discriminator.
  assert.match(connectionsJs, /if \(isBridge\(src\)\) return !hzFeatureOn\(featureSet, 'bridges'\);/u);
  assert.match(connectionsJs, /featureSet = await hzFeatures\(\);/u,
    'and it must be resolved before the first tile is built, or the shelf renders twice');
});

// THE TWO LOADERS HAD OPPOSITE RULES FOR AN UNKNOWN CONNECTOR, and the daemon's
// is the one that governs what actually runs. widget/test/connector-visibility
// .test.mjs runs these rules; this pins that they are still written down here.
test('an unrecognised connector is left alone by the page, as it is by the daemon', () => {
  assert.match(bridgeJs, /if \(!table \|\| Object\.keys\(table\)\.length === 0\) return false;/u,
    'no answer at all still fails closed — that is not the same as an unknown name');
  assert.match(bridgeJs, /return value === true \|\| value === false \|\| value === 'optional' \? value : undefined;/u,
    'a name the registry does not mention is undefined, never false');
  assert.match(daemon, /connectorsDisabledBy/u);
});

// LINKEDIN IS TWO FLOWS AND ONE TILE PER FLOW THIS BUILD ACTUALLY RUNS. With
// `bridges` off the bridge tile is correctly hidden while `connectors.linkedin`
// keeps the export connector scheduled — and the owner had no surface anywhere
// telling them where to put Connections.csv for a connector this install is
// actively polling for it. With bridges ON that connector is STILL scheduled, so
// the export tile stays too and the pair is named apart; hiding it there was the
// same defect mirrored. widget/test/connector-visibility.test.mjs runs the rule.
test('the LinkedIn export has a tile of its own, on either side of the bridges flag', () => {
  assert.match(connectStatus, /export const LINKEDIN_EXPORT_ID = 'linkedin-export';/u);
  assert.match(connectStatus, /function linkedinExportRow\(home\)/u);
  assert.match(connectStatus, /'imports', 'linkedin', 'Connections\.csv'/u);
  assert.match(connectStatus, /linkedinExportRow\(home\),/u, 'and it must be in fullStatus');
  // The page's half: its own visibility rule, its own hint, its own place in
  // the scan order, and the drop path spelled out where the owner can read it.
  assert.match(connectionsJs, /if \(src\.id === LINKEDIN_EXPORT_ID\) \{/u);
  assert.match(connectionsJs, /hzConnectorFeature\(featureSet, 'linkedin'\) === false/u);
  assert.match(connectionsJs, /'linkedin-export': \{/u, 'the export card needs its own hint');
  assert.match(connectionsJs, /~\/\.hazlie\/imports\/linkedin/u,
    'the drop path is the one thing only this card can say');
  assert.match(connectionsJs, /Request archive/u, 'and the clicks that produce the file');
  assert.match(bridgeJs, /if \(id === 'linkedin-export'\) return HZ_GLYPHS\.linkedin;/u,
    'two rows for one platform share its mark');
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
  assert.match(hermes, /import \{[^}]*\breadFeatures\b[^}]*\} from '\.\.\/\.\.\/connectors\/lib\/features\.mjs'/u,
    'one shared loader, following the pinnedThread/googleClients precedent');
  const stats = hermes.slice(hermes.indexOf("url.pathname === '/stats'"));
  const body = stats.slice(0, stats.indexOf('const gone = GONE.get'));
  // THE PRODUCER, NOT THE SPELLING. This asserted the literal
  // `features = readFeatures()` and went red the day the read moved behind the
  // same short-TTL cache as the heavy blocks — a caching change that the wire
  // contract (ui/test/hermes.test.mjs) already pins properly, through readAt.
  // What matters here is that hermes' own feature set comes from the shared
  // loader and reaches the response, however it is memoised on the way.
  assert.match(body, /cachedStatus\([^)]*?\(\) => readFeatures\(\)/su,
    'the shared loader must still be what produces the set');
  // The defensive contract moved WITH the read: cachedStatus is what holds the
  // try/catch now, and the route has to survive the null block it hands back.
  // Asserting the old inline `try { readFeatures() } catch` here would be
  // asserting where the try is written, not that /stats stays up.
  const cache = hermes.slice(hermes.indexOf('function cachedStatus('), hermes.indexOf('async function handle('));
  assert.match(cache, /catch \{[\s\S]{0,400}entry\.value = null;/u,
    'a status block that throws must null itself, never take /stats down');
  assert.match(body, /if \(registry !== null\)/u,
    'and the route must survive that null rather than spreading it');
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
