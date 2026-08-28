// The widget's native channel for pasting a connector's API key — the
// walkthrough lives in the widget's own panel now (owner, 2026-08-25), so the
// paste must land here over JSON instead of on the connect page's forms. Same
// rules as /api/status and /api/bridge (statusApi.mjs carries the reasoning):
// any request with an Origin header is refused — browsers always send one, the
// widget's URLSession never does — and auth is the hermes bearer token.
//
// Route (wired in server.mjs):
//   POST /api/secret {p, value} → { p, connected: true }
//
// SINKS is the allowlist, and it is the security boundary that matters most
// here: the request names which secret it is setting, and accepting an
// arbitrary name would let a JSON body choose the filename a secret is written
// under — the same path-traversal-dressed-as-a-feature the gmail form's
// known-account check exists to refuse. An id earns its entry here when its
// walkthrough ships in the widget; granola is the first.
import { homedir } from 'node:os';
import { bearerAuthorized } from './statusApi.mjs';

const SINKS = {
  granola: {
    file: 'granola-api-key.txt',
    // Shape only — one line of printable ASCII, bounded. Granola does not
    // document its key format as stable, so the real validator is the
    // connector's next run: it reads this file, calls the API, and the status
    // row says how that went. Rejecting here is only for pastes that cannot
    // possibly be a key (empty, multiline, control characters, a whole cURL).
    valid: (v) => /^[\x21-\x7e]{8,512}$/u.test(v),
    reject: 'that does not look like a Granola API key',
  },
  // Telegram is the one bridge whose credential is per-OWNER rather than
  // per-account: api_id/api_hash come from my.telegram.org/apps, and mautrix
  // refuses to start on the example pair its config ships with. Owner's call
  // (2026-08-25): each install registers its own rather than shipping one,
  // because Telegram bans app ids that many unrelated accounts share.
  //
  // Both halves arrive as "<api_id>:<api_hash>" — one paste, one round trip,
  // and the pair is worthless split anyway.
  telegram: {
    file: null, // not a secrets file: these belong in the bridge's own config
    valid: (v) => /^[0-9]{1,12}:[a-f0-9]{32}$/iu.test(v),
    reject: 'expected <api_id>:<api_hash> from my.telegram.org/apps',
    config: 'telegram',
  },
};

// Pure decision, like statusResponse: request facts in, { status, body } out,
// with the write injected so a test never needs a port or a real secrets dir.
export function secretResponse({
  method,
  origin,
  authorization,
  body,
  home = homedir(),
  write,
  writeConfig,
} = {}) {
  if (origin !== undefined) return { status: 403, body: { error: 'browser channel refused' } };
  if (!bearerAuthorized(authorization, home)) {
    // One response for missing, malformed and wrong — a probe learns nothing.
    return { status: 401, body: { error: 'unauthorized' } };
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
  const sink = SINKS[body?.p];
  if (!sink) return { status: 404, body: { error: 'unknown sink' } };
  const value = typeof body?.value === 'string' ? body.value.trim() : '';
  if (!sink.valid(value)) return { status: 400, body: { error: sink.reject } };
  if (sink.config) {
    // Into the bridge's own config.yaml, by targeted line replacement rather
    // than a YAML round trip: rewriting that file wholesale would reformat a
    // 700-line generated config and lose its comments, and these two keys are
    // unique in it. writeConfig is injected for the same reason write is.
    const [apiId, apiHash] = value.split(':');
    writeConfig(sink.config, { apiId, apiHash });
    return { status: 200, body: { p: body.p, connected: true } };
  }
  write(sink.file, value);
  // The value is never echoed back; the widget refreshes /api/status for the
  // green dot, so "it landed" is all this reply needs to carry.
  return { status: 200, body: { p: body.p, connected: true } };
}
