// THE BUNDLE DIET (stage 2 of the "Reconnect, Only" repackaging).
//
// Two promises, both negative, both invisible when they break:
//
//   1. A dormant feature costs nothing to SHIP. Stage 1 stopped provisioning
//      voice; the 496 MB of speech models were still inside every download.
//   2. A first launch downloads nothing the owner did not ask for.
//
// Nothing on screen goes wrong when either regresses. The app simply gets big
// again, or starts helping itself to 4 GB sixty seconds after launch, and the
// only witness is a stopwatch and a disk. So these are pinned the way
// feature-registry.test.mjs pins stage 1: by reading the source that decides.
//
// The paths that carry these promises live in files other stages own
// (Bridge.swift is not this stage's to edit), so where a guard could only be
// written here, the test says which file the OTHER lock is in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const build = read('widget/build.sh');
const main = read('widget/src/main.swift');
const provision = read('widget/src/Provision.swift');
const modelSetup = read('widget/src/ModelSetup.swift');
const bridgeSwift = read('widget/src/Bridge.swift');
const registry = JSON.parse(read('ops/features.json'));

// Comments explain the gates at length, and prose that quotes a call would
// otherwise satisfy a test looking for the call. Every "is this wired" check
// below runs against code with the comments stripped.
const decomment = (s) => s.replace(/^\s*(?:\/\/|#)[^\n]*$/gmu, '');
const buildCode = decomment(build);
const mainCode = decomment(main);
const modelSetupCode = decomment(modelSetup);

// --- the bundle ----------------------------------------------------------

test('build.sh reads the feature registry, and a broken one stops the build', () => {
  assert.match(buildCode, /FEATURES_JSON="\.\.\/ops\/features\.json"/u,
    'the build must read the same one file Features.swift and features.mjs read');
  assert.match(buildCode, /FEATURE_VOICE="\$\(read_feature voice\)"/u);
  // FATAL, not "off". Features.swift answers an unreadable registry with
  // everything off because a broken bundle must not provision a homeserver; a
  // build must not quietly ship a stripped app for the same reason in reverse.
  assert.match(buildCode, /throw new Error/u,
    'read_feature must throw on a malformed registry rather than default to off');
  assert.match(buildCode, /reg\.version !== 1/u, 'and check the version it was written against');
});

test('the voice models are gated on the registry, not merely on the build machine', () => {
  const at = buildCode.indexOf('VOICE_SRC="$HOME/.hazlie/models/voice"');
  assert.ok(at > 0, 'the voice model source path must still exist for when voice is on');
  const gateAt = buildCode.lastIndexOf('if [ "$FEATURE_VOICE" = on ]; then', at);
  assert.ok(gateAt > 0 && gateAt < at,
    'the copy must sit INSIDE a $FEATURE_VOICE gate, not beside it');
  // The copy path is a KEEP. Stage 2 is dormancy, not deletion: flipping the
  // flag and rebuilding has to put the models back with no other edit.
  const block = buildCode.slice(gateAt, buildCode.indexOf('\nfi\n', at));
  assert.match(block, /cp -c -R "\$VOICE_SRC" "\$BE\/voice-models"/u,
    'turning voice back on must restore the bundle by flag alone');
  assert.match(block, /else/u, 'and the off arm must say what it skipped');
});

test('the bundle budget is a constant, measured, and enforced before the install', () => {
  assert.match(buildCode, /^BUNDLE_BUDGET_MB=250$/mu,
    'the plan\'s stage 2 checkpoint is "bundle under 250 MB"');
  assert.match(buildCode, /BUNDLE_MB="\$\(du -sm "\$APP" \| cut -f1\)"/u,
    'measure the assembled bundle, in the same unit as the budget');
  assert.match(buildCode, /du -sh "\$APP"/u, 'and print a number a person reads');
  assert.match(buildCode, /\[ "\$BUNDLE_MB" -gt "\$BUNDLE_BUDGET_MB" \]/u);
  const at = buildCode.indexOf('BUNDLE_MB="$(du -sm');
  const fail = buildCode.slice(at, at + 900);
  assert.match(fail, /exit 1/u, 'over budget must fail the build, not warn');
  assert.match(fail, /if \[ "\$FEATURE_VOICE" = on \]/u,
    'unless voice is on — that build is deliberately 500 MB heavier');
  // TEETH. A budget checked after `ditto "$APP" "$DEST"` reports the number
  // once the over-budget app is already the installed one.
  const installAt = buildCode.indexOf('ditto --norsrc --noextattr "$APP" "$DEST"');
  assert.ok(installAt > 0, 'could not find the install step');
  assert.ok(at < installAt,
    'the budget check must run BEFORE /Applications is written, or it only reports');
});

test('the connectors tree ships without the parts node never opens', () => {
  assert.match(buildCode, /rsync -a --exclude node_modules --exclude '\/test' --exclude '\*\.md' \\/u,
    'the source copy must drop the test tree and the markdown');
  const at = buildCode.indexOf('$BE/connectors/node_modules" -type d');
  assert.ok(at > 0, 'the cloned node_modules must be pruned too — it is 23 of the 24 MB');
  const prune = buildCode.slice(at - 200, at + 800);
  for (const name of ['test', 'docs', 'examples', 'coverage', '.github']) {
    assert.match(prune, new RegExp(`-name ${name.replace('.', '\\.')}\\b`, 'u'),
      `the prune must cover ${name}/`);
  }
  for (const ext of ['\\*\\.md', '\\*\\.d\\.ts', '\\*\\.map']) {
    assert.match(prune, new RegExp(`-name '${ext}'`, 'u'),
      `the prune must cover ${ext} (sourcemaps alone are 7.6 MB)`);
  }
});

// prompts/*.md IS THE RUNTIME. ui/server/relationship/draft.mjs and friends
// resolve ../../../prompts/*.md, so a markdown sweep over "$BE" produces a
// bundle that installs, launches, and answers nothing. This is the one mistake
// this prune is a hair away from, so it gets its own test.
test('the markdown prune cannot reach the prompts, which hermes reads at runtime', () => {
  for (const m of buildCode.matchAll(/find ("[^"]+")[\s\S]{0,400}?-name '\*\.md'/gu)) {
    assert.match(m[1], /connectors\/node_modules/u,
      `a *.md sweep is rooted at ${m[1]}; only connectors/node_modules may be swept`);
  }
  // And the prompts must still be copied whole.
  assert.match(buildCode, /clone_tree \.\.\/prompts "\$BE\/prompts"/u);
});

test('yq ships only when the stack that calls it does', () => {
  const at = buildCode.indexOf('YQ_SRC="$(command -v yq');
  assert.ok(at > 0, 'the yq copy must stay for when bridges are on');
  const gateAt = buildCode.lastIndexOf('if [ "$FEATURE_BRIDGES" = on ]; then', at);
  assert.ok(gateAt > 0 && gateAt < at,
    'yq is 12 MB whose only caller is ops/setup-bridges-native.sh; gate it on bridges');
  // The signing block must tolerate an absent tools/, or a bridges-off build
  // dies at codesign instead.
  assert.match(buildCode, /if \[ -f "\$BE\/tools\/yq" \]; then/u,
    'signing must ask whether yq is there before signing it');
});

// The whole diet is conditional on what the shipped registry actually says.
// A build under budget because someone turned voice on and the test still
// passed would be the least useful green in this file.
test('the shipped registry is the one these gates were measured against', () => {
  assert.equal(registry.features.voice, false, 'voice off is what stage 2 measured');
  assert.equal(registry.features.bridges, false, 'bridges off is what stage 2 measured');
});

// --- first launch downloads nothing --------------------------------------

test('nothing in the launch sequence calls the model download', () => {
  // ModelSetup.download is THE entry point: every byte of the 2.5-4.7 GB fetch
  // goes through it. Neither the launch sequence nor provisioning may name it.
  for (const [name, code] of [['main.swift', mainCode], ['Provision.swift', decomment(provision)]]) {
    assert.doesNotMatch(code, /ModelSetup\.download\(/u,
      `${name} must not start a model download; only an owner action may`);
  }
  // And inside ModelSetup itself, the only caller of startDownload is
  // download(), which is only reachable from the bridge verb.
  const callers = [...modelSetupCode.matchAll(/startDownload\(/gu)];
  assert.equal(callers.length, 3,
    'startDownload should be one definition and two calls, both inside download()');
});

test('an automatic model target requires a model that is already installed', () => {
  const at = modelSetupCode.indexOf('static func automaticTarget(');
  assert.ok(at > 0, 'automaticTarget must still exist — it is the upgrade path');
  const body = modelSetupCode.slice(at, at + 400);
  assert.match(body, /guard let current = installed else \{\s*(?:_ = allowFreshInstall\s*)?\s*return unfinishedDownload\?\.id/u,
    'with nothing installed and nothing asked for it must answer nil — never `recommended`');
  assert.doesNotMatch(body, /allowFreshInstall \? recommended/u,
    'the fresh-install arm is what began a 4 GB download on a launch nobody asked');
  // The resume arm is not the fresh-install arm wearing a hat: it may only ever
  // name the tier the interrupted REQUEST was for. Answering `recommended`
  // there would fetch weights nobody picked on a machine that has none.
  assert.doesNotMatch(body, /unfinishedDownload[^\n]*recommended/u);
});

// A DANGLING LINK IS NOT AN INSTALLED MODEL, and both of stage 2's locks open
// if it counts as one. destinationOfSymbolicLink reads the link, not what it
// points at, so `~/.hazlie/models/model.gguf -> Qwen3-8B-Q4_K_M.gguf` with the
// .gguf deleted answered "installed". That arms the launch reconciliation
// (isInstalled) and clears automaticTarget's `guard let current`, so a Mac with
// no weights at all could be handed a 2.5-4.7 GB fetch — the case the
// fresh-install arm was removed to close, reached by a different door.
test('a link with nothing behind it is not an installed model', () => {
  const at = modelSetupCode.indexOf('static var installed: ModelTier? {');
  assert.ok(at > 0, 'installed must still exist — it is what both locks read');
  const body = modelSetupCode.slice(at, modelSetupCode.indexOf('\n  }', at));
  assert.doesNotMatch(body, /return tiers\.first \{ \$0\.file == \(dest as NSString\)\.lastPathComponent \}/u,
    'the tier may not be decided by the link text alone — that is the dangling-link bug');
  assert.match(body, /fm\.fileExists\(atPath: target\.path, isDirectory: &isDir\)/u,
    'the link target must be shown to exist');
  assert.match(body, /!isDir\.boolValue/u, 'and to be a file rather than a directory');
  assert.match(body, /\$0\.bytes == size/u,
    'and to weigh what that tier weighs — the same standard the real-file branch already held');
  assert.match(body, /reportBrokenLink\(dest\)/u, 'a broken link is worth exactly one log line');
});

// AN INTERRUPTED DOWNLOAD IS NOT A FRESH INSTALL. Quitting thirty seconds into
// onboarding's fetch stranded it: onboardingDone is posted whether or not the
// weights landed, so nothing was installed, the timer was never armed, and the
// only recovery was replaying the whole gear-menu flow. The request is recorded
// before the first byte moves and cleared on every ending download() reaches,
// so the file surviving means the process went away mid-fetch and nothing else.
test('a download the app did not survive is picked up again, and only that', () => {
  assert.match(modelSetupCode, /try\? tier\.id\.write\(to: pendingMarker, atomically: true, encoding: \.utf8\)/u,
    'the request must be on disk before the fetch starts');
  const finishAt = modelSetupCode.indexOf('let finish: (String?) -> Void = { reason in');
  assert.ok(finishAt > 0, 'download() must still funnel every ending through finish');
  assert.match(modelSetupCode.slice(finishAt, finishAt + 400), /try\? fm\.removeItem\(at: pendingMarker\)/u,
    'every ending — success, cancel, failure — must clear it, or a finished download resumes forever');
  const at = modelSetupCode.indexOf('static var unfinishedDownload: ModelTier? {');
  assert.ok(at > 0, 'the resume path must be readable in one place');
  const body = modelSetupCode.slice(at, modelSetupCode.indexOf('\n  }', at));
  assert.match(body, /pendingMarker/u, 'the recorded request is the evidence');
  assert.match(body, /partialPath\(for: \$0\)/u,
    'and so is the staged .part file, which is the only other thing an interrupted fetch leaves');
  assert.doesNotMatch(body, /recommended/u, 'it answers what was asked for, never what fits today');
});

test('the launch-time reconciliation is not even armed without a model', () => {
  const at = mainCode.indexOf('reconcileAutomaticModelWhenSafe()');
  assert.ok(at > 0, 'launch must still reconcile an INSTALLED model after an upgrade');
  const near = mainCode.slice(Math.max(0, at - 500), at);
  assert.match(near, /guard ModelSetup\.isInstalled else \{/u,
    'the launch call must be guarded on an installed model, in the launch sequence '
    + 'where a reader looks for what a first launch does');
});

// SCREEN 5 STILL HAS WHAT IT NEEDS. Closing the automatic path is only correct
// if the owner-initiated one is untouched: onboarding's engine screen picks the
// tier with ModelSetup.recommended and starts the fetch with the modelDownload
// verb. Asserted against Bridge.swift, which this stage does not edit — if a
// later stage moves the verb, this says so instead of silently passing.
test('the owner-initiated download is intact for onboarding screen 5', () => {
  assert.match(modelSetupCode, /static var recommended: String/u,
    'screen 5 sizes the model to the Mac with this');
  const at = bridgeSwift.indexOf('case "modelDownload":');
  assert.ok(at > 0, 'the modelDownload verb is the one owner action that may fetch weights');
  const verb = bridgeSwift.slice(at, at + 2600);
  assert.match(verb, /let tier = ModelSetup\.recommended/u);
  assert.match(verb, /ModelSetup\.download\(\s*tierId: tier,/u,
    'and it must still reach the download');
});

// THE RUNTIME STAYS BUNDLED, so the fallback screen 5 offers is one click and
// not a toolchain. 56 MB is inside the budget on purpose.
test('the llama runtime still ships, and its weights still do not', () => {
  assert.match(buildCode, /python3 bundle-llama\.py "\$BE\/llama"/u,
    'the runtime is bundled — a downloaded app has no Homebrew');
  assert.doesNotMatch(buildCode, /cp[^\n]*\.gguf/u, 'the weights are never bundled');
});

// --- nothing is created for a dormant feature ----------------------------

test('a fresh launch creates nothing under ~/.hazlie/models/voice when voice is off', () => {
  const code = decomment(provision);
  const declAt = code.indexOf('let voiceDst = hazlie.appendingPathComponent("models/voice")');
  assert.ok(declAt > 0, 'the destination path must still be named, for when voice is on');
  const gateAt = code.indexOf('if Features.shouldCloneVoiceModels(Features.current) {');
  assert.ok(gateAt > declAt, "stage 1's gate must still be there, and after the declaration");
  const cloneAt = code.indexOf('cloneTree(voiceSrc, voiceDst)', gateAt);
  assert.ok(cloneAt > gateAt, 'the clone must be INSIDE the gate, not beside it');
  const gateEnd = code.indexOf('\n    }', cloneAt) + 6;

  // ~/.hazlie/models itself is provisioned unconditionally and must stay — the
  // .gguf lives there. models/voice is the 496 MB one, and the only line in
  // this file allowed to mention it outside the gate is the `let` that names
  // it. Anything else is a directory a dormant feature would create.
  for (const m of code.matchAll(/voiceDst|models\/voice/gu)) {
    assert.ok(m.index >= declAt && m.index <= gateEnd,
      `"${code.slice(m.index - 40, m.index + 40).trim()}" touches the voice model tree `
      + 'outside the voice gate');
  }
  const outside = code.slice(0, declAt) + code.slice(gateEnd);
  assert.doesNotMatch(outside, /(?:mkdir|createDirectory|cloneTree)\([^\n]*voice/u,
    'nothing outside the gate may create the voice model directory');
});
