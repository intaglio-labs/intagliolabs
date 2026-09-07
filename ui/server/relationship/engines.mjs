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

// Engine selection: config.relationshipMemory.engine in {'claude-cli','llama'},
// default 'claude-cli' when the binary is resolvable, else 'llama'. A caller
// that already knows which engine it wants (tests; a route reading the
// owner's config) still goes through this so selection logic lives in one
// place.
export function createEngine(config = {}) {
  const requested = config?.relationshipMemory?.engine;
  const engine = requested === 'claude-cli' || requested === 'llama'
    ? requested
    : (resolveClaudeBinary({ env: process.env }) ? 'claude-cli' : 'llama');
  return engine === 'llama' ? createLlamaEngine(config) : createClaudeCliEngine(config);
}

export { EngineError };
