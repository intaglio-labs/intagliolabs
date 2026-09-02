// Privacy contract for the optional local -> frontier-model handoff.
//
// This is intentionally a source contract. The boundary crosses JavaScript,
// Swift and two installed provider clients; a mock response would prove almost
// nothing. These checks pin the pieces that matter: the reviewed textarea is
// the wire value, native accepts no hidden context fields, prompts use stdin,
// provider credentials stay with their official clients, and both clients run
// without a useful tool/file surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const chat = readFileSync(join(WIDGET, 'ui', 'chat.js'), 'utf8');
const widget = readFileSync(join(WIDGET, 'ui', 'widget.js'), 'utf8');
const bridge = readFileSync(join(WIDGET, 'src', 'Bridge.swift'), 'utf8');
const runner = readFileSync(join(WIDGET, 'src', 'FrontierRunner.swift'), 'utf8');

function between(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  assert.ok(start >= 0, `missing ${startNeedle}`);
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `missing ${endNeedle} after ${startNeedle}`);
  return text.slice(start, end);
}

test('the exact editable textarea value is the only frontier payload', () => {
  const review = between(chat, 'function openFrontierReview(', '// The point-of-use confirmation card.');
  assert.match(review, /document\.createElement\('textarea'\)/u);
  assert.match(review, /textarea\.value\s*=\s*frontierPrompt\(context\)/u);
  assert.match(review, /const prompt\s*=\s*textarea\.value\.trim\(\)\.slice/u);
  assert.match(review, /hzPost\('frontierSend',\s*\{\s*provider,\s*prompt\s*\}\)/u);
  assert.match(review, /review\.textContent\s*=\s*prompt/u,
    'the sent text must remain visible as an immutable receipt');
  assert.match(review, /send to \$\{name\}/u, 'approval must name the receiving provider');
});

test('the assembled context package has only question, local answer and source labels', () => {
  const assembly = between(chat, 'function frontierPrompt(', 'function frontierActions(');
  assert.match(assembly, /utterance/u);
  assert.match(assembly, /localAnswer/u);
  assert.match(assembly, /sources/u);
  for (const forbidden of ['row', 'quote', 'snippet', 'database', 'contextSnippets', 'identifier']) {
    // Comments explain the forbidden fields; only executable identifiers and
    // object keys matter here, so strip line comments before scanning.
    const executable = assembly.replace(/\/\/.*$/gmu, '');
    assert.doesNotMatch(executable, new RegExp(`\\b${forbidden}\\b`, 'u'));
  }

  const nativeCase = between(bridge, 'case "frontierSend":', 'case "frontierCancel":');
  assert.match(nativeCase, /payload\["provider"\]/u);
  assert.match(nativeCase, /payload\["prompt"\]/u);
  assert.match(nativeCase, /prefix\(12_000\)/u, 'native must independently cap reviewed text');
  assert.match(nativeCase, /FrontierProvider\(rawValue:/u, 'native must reject unknown providers');

  // Pin the WHOLE key set, not a denylist of names. The earlier denylist
  // (rows/quotes/snippets/context/sources) was proven bypassable in review
  // (2026-08-31): a field named "notes", prepended into the outbound prompt,
  // left every test green. Two guards close that: the native case may read
  // exactly {provider, prompt}, and must refuse any payload whose key set
  // holds anything else.
  const payloadKeys = [...nativeCase.matchAll(/payload\["([A-Za-z]+)"\]/gu)].map((m) => m[1]);
  assert.deepEqual([...new Set(payloadKeys)].sort(), ['prompt', 'provider'],
    'frontierSend must read exactly payload["provider"] and payload["prompt"]');
  assert.match(nativeCase,
    /payload\.keys\.allSatisfy\(\{\s*\$0 == "provider" \|\| \$0 == "prompt"\s*\}\)/u,
    'native must refuse a payload carrying any key beyond provider and prompt');
});

test('cancelling one job cannot kill the other', () => {
  // One shared 'cancel' verb briefly cancelled BOTH the local ask and the
  // frontier job, so cancelling a slow local question silently discarded a
  // frontier answer that was already sent and billed — and vice versa
  // (review 2026-08-31). The verbs are separate and must stay separate.
  const askCancel = between(bridge, 'case "cancel":', 'case "openExternal":');
  assert.match(askCancel, /askTask\?\.cancel\(\)/u);
  assert.doesNotMatch(askCancel, /FrontierRunner/u,
    'the local-ask cancel must not touch the frontier job');
  const frontierCancel = between(bridge, 'case "frontierCancel":', 'case "cancel":');
  assert.match(frontierCancel, /FrontierRunner\.shared\.cancel\(\)/u);
  assert.doesNotMatch(frontierCancel, /askTask/u,
    'the frontier cancel must not touch the local ask');

  const caps = between(bridge, 'static let pageCapabilities', 'private var pageOf:');
  assert.match(caps, /"chat":\s*\[[^\]]*"frontierCancel"/su);

  const fp = between(chat, 'function frontierPending(', 'function openFrontierReview(');
  assert.match(fp, /hzPost\('frontierCancel'\)/u);
  assert.doesNotMatch(fp, /hzPost\('cancel'\)/u,
    'the frontier pending bubble must cancel only its own job');
});

test('the receipt cannot claim a send that did not happen', () => {
  // "sent to X" was stamped before hzPost resolved, so a provider that was
  // not even installed still left a permanent "sent" line in the transcript
  // (review 2026-08-31). The receipt is the audit trail of the privacy
  // boundary: it settles from the reply, and the states where the prompt
  // provably never reached the provider say so.
  const review = between(chat, 'function openFrontierReview(', '// The point-of-use confirmation card.');
  const posted = review.indexOf("await hzPost('frontierSend'");
  assert.ok(posted >= 0, 'missing the frontierSend dispatch');
  const sent = review.indexOf('lifecycle.sent()');
  assert.ok(sent > posted, 'lifecycle.sent() must run after the dispatch, not before');
  const sentReceipt = review.indexOf('`sent to ${name}`');
  assert.ok(sentReceipt > posted, 'the "sent to" receipt must be written after the reply');
  assert.match(review,
    /data\.state === 'missing' \|\| data\.state === 'auth' \|\| data\.state === 'busy'/u);
  assert.match(review, /not sent — nothing left this Mac/u);
});

test('provider output is parsed at pipe EOF, never at bare process exit', () => {
  // The termination callback has no ordering against the pipe's final chunk;
  // parsing there read a truncated tail and threw away real, already-billed
  // answers (review 2026-08-31). EOF hops are enqueued behind every data hop
  // on the same serial queue, so the closed flags are the ordering guarantee.
  const claude = between(runner, 'private final class ClaudeFrontierJob', 'private final class CodexFrontierJob');
  assert.match(claude, /guard !settled, let status = exitStatus, stdoutClosed, stderrClosed/u);
  assert.doesNotMatch(claude, /func terminated\(/u,
    'the exit-time parse path must stay deleted');
  const codex = runner.slice(runner.indexOf('private final class CodexFrontierJob'));
  assert.match(codex, /guard !settled, let status = exitStatus, stderrClosed/u);
  assert.doesNotMatch(codex, /func terminated\(/u);
  // A handler left armed spins on an exhausted pipe; both jobs clear theirs
  // at EOF and on settle.
  for (const job of [claude, codex]) {
    assert.match(job, /handle\.readabilityHandler = nil/u);
    assert.match(job, /stdoutHandle\?\.readabilityHandler = nil/u);
    assert.match(job, /stderrHandle\?\.readabilityHandler = nil/u);
  }
});

test('the official clients receive prompts over stdin without inherited API credentials', () => {
  assert.match(runner, /Process\(\)/u);
  assert.match(runner, /process\.executableURL\s*=\s*binary/u);
  assert.doesNotMatch(runner, /\/bin\/(?:ba|z|fi)?sh|shell\s*-c/u,
    'the handoff must not interpolate reviewed text into a shell');
  assert.match(runner, /write\(contentsOf:\s*Data\(self\.prompt\.utf8\)\)/u,
    'Claude prompt must go to stdin');
  assert.match(runner, /"input":\s*\[\["type":\s*"text",\s*"text":\s*frontierSystemPrompt\s*\+\s*"\\n\\n"\s*\+\s*prompt\]\]/u,
    'Codex prompt must go through app-server stdin');
  assert.match(runner, /let allowed = \["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "SHELL", "LANG", "LC_ALL"\]/u);
  assert.match(runner, /environment\["CODEX_HOME"\]\s*=\s*try isolatedCodexHome\(\)\.path/u);
  assert.match(runner, /appendingPathComponent\("work",\s*isDirectory:\s*true\)/u);
  assert.match(runner, /appendingPathComponent\("codex-home",\s*isDirectory:\s*true\)/u,
    'the auth link and model-visible working directory must be siblings');
  assert.match(runner, /createSymbolicLink\(at:\s*link,\s*withDestinationURL:\s*source\)/u);
  assert.doesNotMatch(runner, /copyItem\([^\n]*auth\.json/u,
    'the provider credential must never be copied by Intaglio');

  // Wiped per run, not created once (owner decision 2026-08-31): the client
  // treats this directory as home and accumulates its own databases and logs,
  // so a reused home let state from earlier handoffs linger on disk.
  const codexHome = between(runner, 'private func isolatedCodexHome', 'private func frontierEnvironment');
  assert.match(codexHome, /removeItem\(at:\s*directory\)/u,
    'the isolated CODEX_HOME must be deleted and rebuilt before every run');
  const wipe = codexHome.indexOf('removeItem(at: directory)');
  const relink = codexHome.indexOf('createSymbolicLink(at: link');
  assert.ok(wipe >= 0 && relink > wipe, 'the auth symlink must be recreated after the wipe');
  assert.doesNotMatch(runner, /process\.environment\s*=\s*ProcessInfo/u,
    'the subprocess environment must be copied through an allowlist');
});

test('Claude is stateless, tool-less and unable to ask for permission', () => {
  const claude = between(runner, 'private final class ClaudeFrontierJob', 'private final class CodexFrontierJob');
  for (const flag of [
    '--safe-mode', '--tools', 'dontAsk', '--strict-mcp-config',
    '--no-session-persistence', '--no-chrome', '--disable-slash-commands',
    '--settings', '--setting-sources',
  ]) assert.ok(claude.includes(flag), `Claude runner is missing ${flag}`);
  assert.doesNotMatch(claude, /"--bare"/u,
    '--bare bypasses the subscription login/keychain and must not be used');
});

test('ChatGPT uses app-server in a restricted read-only ephemeral thread', () => {
  const codex = runner.slice(runner.indexOf('private final class CodexFrontierJob'));
  assert.match(codex, /"app-server",\s*"--stdio"/u);
  for (const feature of ['plugins', 'hooks', 'apps', 'shell_tool', 'multi_agent']) {
    assert.match(codex, new RegExp(`"--disable", "${feature}"`, 'u'));
  }
  assert.match(codex, /"capabilities":\s*\["experimentalApi":\s*true\]/u);
  assert.match(codex, /"approvalPolicy":\s*"never"/u);
  assert.match(codex, /"sandbox":\s*"read-only"/u);
  assert.match(codex, /"type":\s*"readOnly"/u);
  assert.match(codex, /"networkAccess":\s*false/u);
  assert.match(codex, /"runtimeWorkspaceRoots":\s*\[cwd\]/u);
  assert.ok((codex.match(/"environments":\s*\[\]/gu) || []).length >= 2,
    'thread and turn must both disable external environments');
  assert.match(codex, /"dynamicTools":\s*\[\]/u);
  assert.match(codex, /"ephemeral":\s*true/u);
  assert.doesNotMatch(codex, /"method":\s*"thread\/delete"/u,
    'app-server refuses deletion for an ephemeral thread because it was never persisted');
  assert.match(codex, /tools are disabled for this handoff/u,
    'unexpected app-server requests must fail closed');
});

test('chat is reachable and the bridge grants frontierSend only to chat', () => {
  assert.match(widget, /const CHAT_TEASE = false;/u);
  const caps = between(bridge, 'static let pageCapabilities', 'private var pageOf:');
  assert.match(caps, /"chat":\s*\[[^\]]*"frontierSend"/su);
  const otherCaps = caps.replace(/"chat":\s*\[[^\]]*\]/su, '');
  assert.doesNotMatch(otherCaps, /"frontierSend"/u);
});
