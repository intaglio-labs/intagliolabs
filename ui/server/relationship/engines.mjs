// Model engines for the person-page builder (L5 step 4). One small interface,
// two implementations: an installed `claude` CLI (the owner's own
// subscription, invoked headless with the same hardened flag set
// FrontierRunner.swift already uses for the owner-reviewed handoff) and the
// existing loopback llama-server used everywhere else in this repo.
//
// `createEngine(config)` returns `{ name, complete({ system, user, maxTokens }) }`.
// `complete` resolves to the model's raw text; callers parse and validate it
// themselves (pages.mjs), the same split distill.mjs keeps between "get the
// model's answer" and "hold it to the rules".
//
// NEVER LOG PROMPT OR RESULT TEXT. Both engines carry conversation excerpts
// between the owner and a real person; ui/AGENTS.md's discipline for the
// distiller scripts ("it never logs source text... counts, ids and reasons
// only") applies here without exception.
//
// THE CLI ENGINE IS OPT-IN, AND THAT IS A PRIVACY GUARANTEE, NOT A DEFAULT.
// `createEngine` and `createLookupEngine` select the installed `claude`
// client ONLY when the owner's config says so outright --
// relationshipMemory.engine === 'claude-cli' (pages, sweep, drafts) or
// relationshipMemory.lookupEngine === 'claude-cli' (public lookup). With the
// key ABSENT, createEngine falls back to the loopback llama engine (nothing
// leaves the Mac) and createLookupEngine returns null (lookup declines to
// run at all; lookupGate reads that as 'no-engine').
//
// It used to be the other way round: whichever engine was selected, the CLI
// won whenever its binary happened to resolve on PATH. That made a page
// build after an ordinary refill send message excerpts to a model off this
// machine with no explicit act of consent anywhere -- and the privacy page
// now states that any feature sending message excerpts to a model outside
// the Mac is OFF until the owner turns it on. A default that depends on
// whether a binary is installed is not "off"; it is "on, if you happen to
// have the client". Resolvability decides only whether an OPTED-IN engine
// can actually run, never whether it is chosen.

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';

const CLAUDE_TIMEOUT_MS = 120_000;
const CLAUDE_OUTPUT_LIMIT = 5_000_000;

// Resolve the installed `claude` binary via PATH, falling back to the
// well-known install location `~/.local/bin/claude` the same way the Swift
// side's `executable(named:)` does for FrontierRunner. Returns null rather
// than throwing: "no binary" is a fact the caller (engine selection) uses to
// fall back to llama, not a startup failure.
export function resolveClaudeBinary({ env = process.env, home = homedir() } = {}) {
  const dirs = String(env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, 'claude');
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here; keep looking
    }
  }
  const fallback = join(home, '.local', 'bin', 'claude');
  if (existsSync(fallback)) {
    try {
      accessSync(fallback, fsConstants.X_OK);
      return fallback;
    } catch {
      // exists but not executable -- treat as absent
    }
  }
  return null;
}

class EngineError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'EngineError';
    this.kind = kind;
  }
}

// Same hardened arguments the orchestrator's brief specifies, matching
// FrontierRunner.swift's ClaudeFrontierJob in spirit: an empty tool set, no
// permission prompts, an empty MCP config, no persisted session, no browser.
// The system prompt travels as a flag (it is the versioned person_page.md
// file, never secret and never per-person); the USER prompt -- the part that
// carries the person's own words -- travels on stdin, never argv, so it never
// appears in a process listing or a shell history.
function claudeArgs({ system, model }) {
  return [
    '-p',
    '--output-format', 'json',
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--settings', '{}',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--no-chrome',
    '--prompt-suggestions', 'false',
    '--system-prompt', system,
    '--model', model,
  ];
}

function createClaudeCliEngine(config = {}) {
  const model = config?.relationshipMemory?.engineModel ?? 'sonnet';
  const binaryOverride = config?.relationshipMemory?.claudeBinary;
  // Test seam: a route/engine test injects a fake spawn so it never launches
  // a real `claude` process. Same shape as node:child_process.spawn, so a
  // caller can pass a stub that returns a fake ChildProcess-like emitter.
  const spawnImpl = config?.relationshipMemory?.spawnImpl ?? spawn;
  const counters = { calls: 0, totalCostUsd: 0, totalDurationMs: 0, errors: 0 };

  async function complete({ system, user }) {
    const binary = binaryOverride ?? resolveClaudeBinary();
    if (!binary) {
      throw new EngineError('claude CLI not found on PATH or ~/.local/bin/claude', 'missing');
    }
    counters.calls += 1;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawnImpl(binary, claudeArgs({ system, model }), {
        // Empty environment but PATH/HOME: the child must not inherit any
        // other credential this process holds, exactly as FrontierRunner's
        // isolated working directory and environment are built for the same
        // reason -- the installed client owns its own subscription login and
        // must see nothing else.
        // USER/LOGNAME are not decoration: without them the CLI's keychain
        // credential lookup fails and it answers "Not logged in" (measured
        // 2026-09-07 under hermes' launchd environment). TMPDIR for its own
        // scratch. Nothing else is inherited.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? homedir(),
          USER: process.env.USER ?? userInfo().username,
          LOGNAME: process.env.LOGNAME ?? process.env.USER ?? userInfo().username,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = Buffer.alloc(0);
      let stderr = '';
      const timer = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch {}
        settle(() => reject(new EngineError('claude CLI timed out', 'timeout')));
      }, CLAUDE_TIMEOUT_MS);

      function settle(fn) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      }

      child.stdout.on('data', (chunk) => {
        if (stdout.length < CLAUDE_OUTPUT_LIMIT) {
          stdout = Buffer.concat([stdout, chunk].map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b))));
        }
      });
      // Diagnostics only: never included in a thrown message body beyond a
      // coarse kind, so a stderr line that happens to echo prompt content
      // (a misbehaving client) cannot ride into a log via an error message.
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });

      child.on('error', (err) => {
        settle(() => reject(new EngineError(`claude CLI spawn failed: ${err?.code ?? err?.message ?? 'unknown'}`, 'spawn')));
      });

      child.on('close', (code) => {
        settle(() => {
          let envelope;
          try {
            envelope = JSON.parse(stdout.toString('utf8'));
          } catch {
            counters.errors += 1;
            reject(new EngineError('claude CLI returned non-JSON output', 'parse'));
            return;
          }
          if (typeof envelope?.total_cost_usd === 'number') counters.totalCostUsd += envelope.total_cost_usd;
          if (typeof envelope?.duration_ms === 'number') counters.totalDurationMs += envelope.duration_ms;
          if (code !== 0 || envelope?.is_error) {
            counters.errors += 1;
            reject(new EngineError(`claude CLI exited ${code}${envelope?.is_error ? ' (is_error)' : ''}`, 'exit'));
            return;
          }
          if (typeof envelope?.result !== 'string') {
            counters.errors += 1;
            reject(new EngineError('claude CLI JSON envelope has no "result" string', 'shape'));
            return;
          }
          resolve(envelope.result);
        });
      });

      try {
        child.stdin.write(user, 'utf8');
        child.stdin.end();
      } catch (err) {
        settle(() => reject(new EngineError(`failed writing prompt to stdin: ${err?.message ?? err}`, 'stdin')));
      }
    });
  }

  return { name: 'claude-cli', model, counters, complete };
}

// The loopback llama-server call shape hermes' own distiller scripts use,
// with the HTTP call injectable so tests need no network (`llamaCall`).
function createLlamaEngine(config = {}) {
  const baseUrl = config?.relationshipMemory?.llamaBaseUrl ?? config?.llama?.baseUrl;
  const apiKey = config?.relationshipMemory?.llamaApiKey ?? config?.llama?.apiKey;
  const model = config?.relationshipMemory?.engineModel ?? config?.llama?.model ?? null;
  const counters = { calls: 0, totalCostUsd: 0, totalDurationMs: 0, errors: 0 };
  const llamaCall = config?.relationshipMemory?.llamaCall ?? defaultLlamaCall;

  async function defaultLlamaCall({ system, user, maxTokens, baseUrl: url, apiKey: key, model: m }) {
    const key_ = typeof key === 'function' ? key() : key;
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key_}` },
      body: JSON.stringify({
        model: m,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: maxTokens ?? 1024,
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
      redirect: 'error',
    });
    if (!res.ok) throw new EngineError(`llama-server returned ${res.status}`, 'http');
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new EngineError('llama-server returned no message content', 'shape');
    return text;
  }

  async function complete({ system, user, maxTokens }) {
    if (!baseUrl) throw new EngineError('llama engine has no baseUrl configured', 'config');
    counters.calls += 1;
    const start = Date.now();
    try {
      const text = await llamaCall({ system, user, maxTokens, baseUrl, apiKey, model });
      counters.totalDurationMs += Date.now() - start;
      return text;
    } catch (err) {
      counters.errors += 1;
      throw err instanceof EngineError ? err : new EngineError(String(err?.message ?? err), 'http');
    }
  }

  return { name: 'llama', model, counters, complete };
}

// Engine selection: config.relationshipMemory.engine in
// {'claude-cli','llama'}, DEFAULTING TO 'llama' -- the loopback model, which
// keeps every excerpt on this machine. 'claude-cli' is chosen only when the
// config asks for it by name; see the opt-in note in this file's header for
// why an absent key must not resolve to the off-box client just because its
// binary is installed. A caller that already knows which engine it wants
// (tests; a route reading the owner's config) still goes through this so
// selection logic lives in one place.
export function createEngine(config = {}) {
  const requested = config?.relationshipMemory?.engine;
  return requested === 'claude-cli' ? createClaudeCliEngine(config) : createLlamaEngine(config);
}

// Public lookup (L5 step 6): the installed `claude` binary driven headless a
// SECOND, differently-shaped way. Verified against a real run of the
// installed CLI (2026-09-07; the captured transcript is
// ui/test/fixtures/lookup-stream.txt, used by parseLookupStream's tests) --
// the flags below are that exact invocation, not a guess at one:
//
//   claude -p --output-format stream-json --verbose \
//     --tools WebSearch --allowedTools WebSearch \
//     --disallowedTools WebFetch,Bash,Read,Write,Edit,Glob,Grep,Agent \
//     --permission-mode dontAsk --strict-mcp-config \
//     --mcp-config '{"mcpServers":{}}' --settings '{}' --setting-sources '' \
//     --disable-slash-commands --no-session-persistence --no-chrome \
//     --model <model>
//
// EVERY isolation flag createClaudeCliEngine above already uses is kept
// (empty MCP config, empty settings sources, no slash commands, no session
// persistence, no browser, dontAsk permission mode) -- only `--tools ''`
// (an empty tool set) is widened, to `--tools WebSearch`: exactly one tool,
// expressed with the same KIND of flag as the empty set it replaces.
//
// `--tools` IS THE EXCLUSIVE SET; `--allowedTools` IS NOT -- and this engine
// shipped with only the latter. From the installed CLI's own `--help`
// (checked 2026-09-08): "--tools <tools...>  Specify the list of available
// tools from the built-in set. Use \"\" to disable all tools, \"default\" to
// use all tools, or specify tool names". --allowedTools is the AUTO-APPROVE
// list: it says which of the AVAILABLE tools need no permission prompt, not
// which tools exist. So under `--permission-mode dontAsk`, every built-in
// tool absent from --disallowedTools was both available and auto-approved --
// NotebookRead, LS, TodoWrite, SlashCommand, KillShell, BashOutput among
// them. A model that can read local files AND web-search in one turn is an
// exfiltration path, and ops/EGRESS.json's decision for this invocation
// rests on the words "exactly one enabled tool"; --tools is what makes that
// sentence true. --allowedTools and --disallowedTools stay as belt: the
// first keeps the one available tool from prompting, the second names the
// dangerous ones closed even if a future CLI reads --tools differently.
// ui/test/relationship-lookup.test.mjs pins this argv.
// `--output-format stream-json --verbose` replaces `--output-format json`
// because a single JSON envelope has no per-tool-call structure to read the
// search's own URLs and result count off of -- see parseLookupStream
// (lookup.mjs) for what those extra lines are read for.
const LOOKUP_TIMEOUT_MS = 300_000;

// THE TURN BOUND, and it is a real flag after all.
//
// lookupPerson's own comment said "the installed CLI has no --max-turns flag
// to cap turns with (checked 2026-09-08 against `claude --help`)", and that
// was half right: --max-turns is ABSENT FROM --help and PRESENT IN THE CLI.
// Verified against the installed client (2.1.265, 2026-09-09): `claude
// --max-turns 1 --tools WebSearch -p '...'` stops after one assistant turn
// with stop_reason 'tool_use' and web_search_requests 0 -- the search never
// ran. An unknown flag, by contrast, errors loudly (`error: unknown option`)
// rather than being ignored, so this is not a silent no-op either way.
//
// THE ARITHMETIC: one assistant turn per search, plus one turn to answer in.
// So LOOKUP_MAX_SEARCHES + 1. Not more: a model that spends a fifth search
// has nothing left to answer with, and its answer would be discarded by the
// search-count check regardless (lookup.mjs), so the extra turn would buy a
// wasted search. Not less: without the answering turn every lookup ends
// 'parse-error'.
//
// THE CODE COUNT IS STILL THE ENFORCEMENT. This flag is a belt -- it stops a
// runaway loop BEFORE it spends the searches, where the count in lookup.mjs
// can only discard the answer afterwards. The number is deliberately NOT
// imported from lookup.mjs (this file is the leaf; it imports nothing from
// relationship/), so ui/test/relationship-lookup.test.mjs pins the
// relationship LOOKUP_MAX_TURNS === LOOKUP_MAX_SEARCHES + 1 instead.
export const LOOKUP_MAX_TURNS = 5;

export function claudeLookupArgs({ system, model, maxTurns = LOOKUP_MAX_TURNS }) {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(maxTurns),
    '--tools', 'WebSearch',
    '--allowedTools', 'WebSearch',
    '--disallowedTools', 'WebFetch,Bash,Read,Write,Edit,Glob,Grep,Agent',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--settings', '{}',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--no-chrome',
    '--system-prompt', system,
    '--model', model,
  ];
}

// Same isolated-spawn shape as createClaudeCliEngine (env allowlist, stdin
// for the user prompt, EngineError on every failure path), differing only in
// argv (claudeLookupArgs above), timeout (LOOKUP_TIMEOUT_MS -- a lookup does
// up to two real web searches and can legitimately run longer than a page
// build), and what `complete` resolves to: the RAW stdout text, not a parsed
// `result` string. Parsing the stream into URLs/resultText/searches/costUsd
// is parseLookupStream's job (lookup.mjs), not this engine's -- this
// engine's only contract is "spawn, isolate, hand back exactly what the CLI
// printed". The best-effort scan below for a final `type:'result'` line
// exists only to keep `counters` and the exit/error check meaningful; it is
// never required for `complete` to resolve.
function createClaudeCliLookupEngine(config = {}) {
  const model = config?.relationshipMemory?.engineModel ?? 'sonnet';
  const binaryOverride = config?.relationshipMemory?.claudeBinary;
  const spawnImpl = config?.relationshipMemory?.spawnImpl ?? spawn;
  const counters = { calls: 0, totalCostUsd: 0, totalDurationMs: 0, errors: 0 };

  async function complete({ system, user }) {
    const binary = binaryOverride ?? resolveClaudeBinary();
    if (!binary) {
      throw new EngineError('claude CLI not found on PATH or ~/.local/bin/claude', 'missing');
    }
    counters.calls += 1;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawnImpl(binary, claudeLookupArgs({ system, model }), {
        // Same allowlist as createClaudeCliEngine and for the same reason:
        // the installed client owns its own subscription login and must see
        // nothing else this process holds.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? homedir(),
          USER: process.env.USER ?? userInfo().username,
          LOGNAME: process.env.LOGNAME ?? process.env.USER ?? userInfo().username,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = Buffer.alloc(0);
      let stderr = '';
      const timer = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch {}
        settle(() => reject(new EngineError('claude CLI timed out', 'timeout')));
      }, LOOKUP_TIMEOUT_MS);

      function settle(fn) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      }

      child.stdout.on('data', (chunk) => {
        if (stdout.length < CLAUDE_OUTPUT_LIMIT) {
          stdout = Buffer.concat([stdout, chunk].map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b))));
        }
      });
      // Diagnostics only -- never included in a thrown message body beyond a
      // coarse kind, same reasoning as createClaudeCliEngine.
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });

      child.on('error', (err) => {
        settle(() => reject(new EngineError(`claude CLI spawn failed: ${err?.code ?? err?.message ?? 'unknown'}`, 'spawn')));
      });

      child.on('close', (code) => {
        settle(() => {
          const text = stdout.toString('utf8');
          // Scan backward for the last parseable `type:'result'` line -- the
          // stream-json summary line, when one arrived at all. Best-effort:
          // a malformed or truncated stream still resolves (or rejects on a
          // non-zero exit code alone); parseLookupStream fails closed on its
          // own if the stream it is handed cannot be read for grounding.
          let resultLine = null;
          const lines = text.split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.length === 0) continue;
            try {
              const obj = JSON.parse(line);
              if (obj?.type === 'result') { resultLine = obj; }
            } catch {
              // not JSON, or not parseable -- keep scanning backward
            }
            if (resultLine) break;
          }
          if (resultLine) {
            if (typeof resultLine.total_cost_usd === 'number') counters.totalCostUsd += resultLine.total_cost_usd;
            if (typeof resultLine.duration_ms === 'number') counters.totalDurationMs += resultLine.duration_ms;
          }
          if (code !== 0 || resultLine?.is_error) {
            counters.errors += 1;
            reject(new EngineError(`claude CLI exited ${code}${resultLine?.is_error ? ' (is_error)' : ''}`, 'exit'));
            return;
          }
          resolve(text);
        });
      });

      try {
        child.stdin.write(user, 'utf8');
        child.stdin.end();
      } catch (err) {
        settle(() => reject(new EngineError(`failed writing prompt to stdin: ${err?.message ?? err}`, 'stdin')));
      }
    });
  }

  return { name: 'claude-cli-lookup', model, counters, complete };
}

// Selection for the lookup engine only: config.relationshipMemory.lookupEngine
// in {'claude-cli','none'} -- deliberately NOT {'claude-cli','llama'} like
// createEngine above. There is no llama fallback for lookup: llama has no web
// search tool, so a loopback model asked to "look this person up" can only
// fabricate an answer that looks exactly as grounded as a real one.
//
// DEFAULT 'none', which means null, which means no lookup runs -- callers
// (lookupGate) read a null engine as {ok:false, reason:'no-engine'} and log
// a skipped pass. That is the opt-in rule from this file's header applied to
// the one path that also spends real web searches: an absent config key is
// "the owner has not turned this on", not "use the client if it is
// installed". A resolvable binary is still required for an opted-in lookup
// to run, and its absence still returns null rather than falling back to a
// model that would invent search results.
export function createLookupEngine(config = {}) {
  const requested = config?.relationshipMemory?.lookupEngine;
  return requested === 'claude-cli' ? createClaudeCliLookupEngine(config) : null;
}

export { EngineError };
