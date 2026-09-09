// A claim review desk. DEVELOPMENT ONLY — this never ships.
//
// WHY IT IS A SEPARATE SERVER AND NOT A ROUTE IN HERMES.
//
// widget/build.sh copies ui/server and ui/scripts into the app bundle wholesale
// (build.sh:107-108). Anything added under ui/server SHIPS, including a route
// that only means to be a dev convenience, and a flag guarding it is one
// refactor away from being wrong. ui/devtools is in neither copy list, so this
// cannot reach a user's machine by accident — the gate is the absence of the
// file, not the correctness of a condition.
//
// It therefore adds NO product code. Everything it does goes through hermes's
// existing, already-shipped API: /admin/memory/pending to read and
// /admin/memory/decide to write. If this file is deleted the product is
// unchanged.
//
//   node ui/devtools/review/serve.mjs        # then open http://127.0.0.1:7311
//
// WHAT IT IS FOR. claim_decision has had no human writer outside an eval script,
// so 3,948 claims have sat undecided while memory/retrieve.mjs served every one
// of them. Deciding them is the only thing that turns the corpus from "whatever
// the model said" into something with a human behind it — and it is the only
// source of ground truth CLAUDE.md permits, since model output may never become
// a label.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lives beside serve.mjs, not under ui/server: that directory ships in the
// app bundle, and this scoring function exists for the dev desk only.
import { supportOf, supportBand } from './support.mjs';
import { createDeskGuard, CSRF_HEADER } from './guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HZ_REVIEW_PORT ?? 7311);
const HERMES = process.env.HZ_HERMES ?? 'http://127.0.0.1:51789';

function token() {
  try {
    return readFileSync(join(homedir(), '.hazlie', 'secrets', 'hermes-token.txt'), 'utf8').trim();
  } catch {
    console.error('no ~/.hazlie/secrets/hermes-token.txt — is hermes set up?');
    process.exit(1);
  }
}
const TOKEN = token();

// The desk's request guard: Host, Origin and a per-process CSRF token. See
// guard.mjs, which carries the reasoning and is separated out so it can be
// tested without importing this file's import-time side effects.
const { csrfToken: CSRF_TOKEN, refuse } = createDeskGuard(PORT);

// READ-ONLY, and only ever for the source text the review page has to show.
// hermes is the sole writer of this database; opening it read-write from a
// second process is the rule ui/AGENTS.md exists to prevent.
const corpus = new DatabaseSync(
  join(homedir(), '.hazlie', 'context', 'context.db'), { readOnly: true }
);

async function hermes(path, init = {}) {
  const res = await fetch(`${HERMES}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, text };
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, {
    'Content-Type': type,
    // LOOPBACK ONLY, and no caching: this page shows message content, and a
    // cached copy in a browser profile outlives the review session.
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    const refused = refuse(req);
    if (refused !== null) return send(res, refused.status, JSON.stringify({ error: refused.error }));

    // The page fetches this once and sends it back on every write. Readable
    // only same-origin: a cross-site script can issue the GET but cannot see
    // the response body, so it never obtains the token.
    if (req.method === 'GET' && url.pathname === '/api/csrf') {
      return send(res, 200, JSON.stringify({ token: CSRF_TOKEN, header: CSRF_HEADER }));
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, readFileSync(join(HERE, 'index.html')), 'text/html; charset=utf-8');
    }

    // Hermes serves the claims; the source text is added HERE, from a read-only
    // handle of our own.
    //
    // A claim cannot be reviewed without seeing the message it came from, but
    // putting message bodies into /admin/memory/pending would leak them into a
    // shipped API that every other caller gets whether it wants them or not --
    // and relationship/inbox.mjs is one of those callers. Reading them in the dev
    // tool keeps the product surface exactly as it was.
    if (req.method === 'GET' && url.pathname === '/api/pending') {
      const limit = url.searchParams.get('limit') ?? '200';
      const out = await hermes(`/admin/memory/pending?limit=${encodeURIComponent(limit)}`);
      if (out.status !== 200) return send(res, out.status, out.text);
      const data = JSON.parse(out.text);
      const row = corpus.prepare('SELECT text FROM context WHERE id = ?');
      // Whether a pending claim is a discovery-sweep sub_role proposal, and
      // which tag it carries -- NOT present on hermes's /admin/memory/pending
      // response (that route's own `kind` column is the claim's kind, e.g.
      // 'fact', not person_sweep_proposal's kind). Read read-only, same
      // handle and same reasoning as source_text above: this is display
      // context for the desk, not a second writer.
      const sweepProposal = corpus.prepare('SELECT kind, value FROM person_sweep_proposal WHERE claim_id = ?');
      data.claims = (data.claims ?? []).map((c) => {
        const source = c.context_id == null ? null : (row.get(c.context_id)?.text ?? null);
        // SCORE IT HERE IF HERMES DID NOT. The running hermes is whatever version
        // the installed app shipped, and it may predate support scoring entirely
        // -- as it did the first time this ran. A dev tool that only works
        // against an unreleased build is a dev tool nobody uses.
        const support = c.support ?? supportOf(c.text, source ?? '', c.quote ?? '');
        const sweep = sweepProposal.get(c.id);
        return {
          ...c,
          source_text: source,
          support,
          support_band: c.support_band ?? supportBand(support),
          sweep_kind: sweep?.kind ?? null,
          sweep_value: sweep?.value ?? null,
        };
      });
      return send(res, 200, JSON.stringify(data));
    }

    if (req.method === 'POST' && url.pathname === '/api/decide') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const out = await hermes('/admin/memory/decide', { method: 'POST', body: raw });
      return send(res, out.status, out.text);
    }

    // CARDS VIEW. Read-only against the corpus for everything the desk shows;
    // every WRITE (a verdict) still goes through hermes's shipped
    // /admin/relationship/event, same as /api/decide goes through
    // /admin/memory/decide. This endpoint adds no new write path.
    //
    // EVERY batch, not just the latest: rm_candidate_batch is append-only, so
    // the same person can have a snapshot in several passes, and each of
    // those is its own immutable row worth its own verdict. Newest batch
    // first, since that is the one most likely still undecided.
    if (req.method === 'GET' && url.pathname === '/api/cards') {
      const batches = corpus.prepare(
        'SELECT id, created_at, candidate_count, gate FROM rm_candidate_batch ORDER BY id DESC'
      ).all();
      const snapStmt = corpus.prepare(
        'SELECT id, person_key, summary, evidence, producer_version FROM rm_candidate_snapshot WHERE batch_id = ? ORDER BY id'
      );
      const nameStmt = corpus.prepare('SELECT display_name FROM people WHERE person_key = ?');
      const quoteStmt = corpus.prepare('SELECT text FROM context WHERE id = ?');
      const eventStmt = corpus.prepare(
        'SELECT event, reason, created_at FROM rm_card_event WHERE snapshot_id = ? ORDER BY created_at'
      );
      // Public lookup's `changed` signal (L5 step 6), read-only, same
      // reasoning and same handle as sweepProposal in /api/pending above:
      // this is display context for the desk, not a second writer. Mirrors
      // newestWebChange (relationship/lookup.mjs) exactly, but wrapped in a
      // try/catch around the PREPARE itself -- a corpus file this desk opens
      // before hermes has ever run SCHEMA_VERSION 13's migration has no
      // person_lookup_change table yet, and that must not take the whole
      // Cards tab down.
      let changedFor = () => null;
      try {
        const changedClaimStmt = corpus.prepare(
          `SELECT plc.claim_id AS claimId, plc.kind AS kind, plc.url AS url, plc.change_date AS date,
                  ll.at AS at, c.text AS text,
                  (SELECT d.action FROM claim_decision d WHERE d.claim_id = plc.claim_id ORDER BY d.id DESC LIMIT 1) AS decision
           FROM person_lookup_change plc
           JOIN claim c ON c.id = plc.claim_id
           JOIN lookup_log ll ON ll.id = plc.log_id
           WHERE c.subject = 'person' AND c.subject_person_key = ?
             AND COALESCE(
               (SELECT d.action FROM claim_decision d WHERE d.claim_id = plc.claim_id ORDER BY d.id DESC LIMIT 1),
               'pending'
             ) NOT IN ('reject', 'retract')
           ORDER BY plc.claim_id DESC LIMIT 1`
        );
        const changedSourceStmt = corpus.prepare(
          `SELECT context_id AS contextId, quote FROM claim_source WHERE claim_id = ? AND source = 'web' LIMIT 1`
        );
        const changedCtxStmt = corpus.prepare('SELECT id FROM context WHERE id = ?');
        changedFor = (personKey) => {
          try {
            const row = changedClaimStmt.get(personKey);
            if (!row) return null;
            const source = changedSourceStmt.get(row.claimId);
            if (!source) return null;
            const ctx = changedCtxStmt.get(source.contextId);
            if (!ctx) return null; // the receipt is gone, so the change is gone
            return { text: row.text, url: row.url, kind: row.kind, quote: source.quote,
              date: row.date ?? null, at: row.at, decision: row.decision ?? null };
          } catch {
            return null;
          }
        };
      } catch {
        // pre-migration schema: no person_lookup_change table yet
      }

      // First pass: which batches does each person_key appear in, so a card
      // can point at its OTHER appearances ("also in batch N") without a
      // second query per card.
      const batchesByPerson = new Map();
      const rowsByBatch = new Map();
      for (const batch of batches) {
        const rows = snapStmt.all(batch.id);
        rowsByBatch.set(batch.id, rows);
        for (const row of rows) {
          if (!batchesByPerson.has(row.person_key)) batchesByPerson.set(row.person_key, []);
          batchesByPerson.get(row.person_key).push(batch.id);
        }
      }

      let totalCards = 0;
      const out = batches.map((batch) => {
        const rows = rowsByBatch.get(batch.id) ?? [];
        const cards = rows.map((row) => {
          let evidence = {};
          try { evidence = JSON.parse(row.evidence); } catch { evidence = {}; }
          const quoteRow = evidence.quote_context_id == null ? undefined : quoteStmt.get(evidence.quote_context_id);
          const quote = quoteRow === undefined ? '(quote row missing)' : String(quoteRow.text).slice(0, 300);
          const person = nameStmt.get(row.person_key);
          const name = person?.display_name ?? row.person_key;
          // Deduped by (event, reason): a snapshot judged twice (a slow
          // retry, the desk's triple-click) still writes one row per attempt
          // in the append-only table upstream of hermes's own guard, and
          // showing each of those as a separate badge is what made three
          // "accepted" tags look like three verdicts instead of one retried
          // click. One badge per distinct (event, reason) pair, earliest wins.
          const seen = new Set();
          const events = [];
          for (const e of eventStmt.all(row.id)) {
            const k = `${e.event}|${e.reason ?? ''}`;
            if (seen.has(k)) continue;
            seen.add(k);
            events.push(e);
          }
          const judged = events.some((e) => e.event === 'accepted' || e.event === 'dismissed');
          const alsoIn = (batchesByPerson.get(row.person_key) ?? []).filter((id) => id !== batch.id);
          return {
            id: row.id,
            person_key: row.person_key,
            name,
            summary: row.summary,
            evidence,
            quote,
            producer_version: row.producer_version,
            events,
            judged,
            also_in_batches: alsoIn,
            changed: changedFor(row.person_key),
          };
        });
        totalCards += cards.length;
        return { id: batch.id, created_at: batch.created_at, candidate_count: batch.candidate_count,
          gate: batch.gate, cards };
      });
      return send(res, 200, JSON.stringify({ batches: out, total_cards: totalCards }));
    }

    // The one write path this view uses -- forwarded verbatim to hermes's
    // existing bearer-authenticated route, same as every other write here.
    if (req.method === 'POST' && url.pathname === '/api/cards/event') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const out = await hermes('/admin/relationship/event', { method: 'POST', body: raw });
      return send(res, out.status, out.text);
    }

    // Header of the Cards view wants hermes's health, including the
    // peopleProjection field when it exists. Proxied rather than fetched
    // directly from the browser: this page already knows hermes's address.
    // The ranked eligible pool per mode, straight from hermes's producer.
    // Read-only; mode is validated by hermes, not here.
    if (req.method === 'GET' && url.pathname === '/api/pool') {
      const mode = url.searchParams.get('mode') ?? 'any';
      let path = '/admin/relationship/pool?mode=' + encodeURIComponent(mode);
      // Optional and passed through only when the page asks for it: the pool
      // route is only just gaining this param, and the page itself falls back
      // to omitting it if the running hermes 400s on an unrecognized one.
      const includeOffered = url.searchParams.get('includeOffered');
      if (includeOffered) path += '&includeOffered=' + encodeURIComponent(includeOffered);
      const out = await hermes(path);
      return send(res, out.status, out.text);
    }

    // Pool-row overrides. Both forward the request body VERBATIM to hermes's
    // own route, same as every other write in this file -- this page never
    // decides what a tag or a suppression means, only that the click happened.
    if (req.method === 'POST' && url.pathname === '/api/pool/subroles') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const out = await hermes('/people/sub-roles', { method: 'POST', body: raw });
      return send(res, out.status, out.text);
    }

    if (req.method === 'POST' && url.pathname === '/api/pool/never') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const out = await hermes('/admin/relationship/event', { method: 'POST', body: raw });
      return send(res, out.status, out.text);
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const out = await hermes('/stats'); // peopleProjection lives on /stats; /health is a frozen wire contract
      return send(res, out.status, out.text);
    }

    // PAGES VIEW. Forwarded verbatim to hermes's own routes, same shape as
    // every other proxy here. These two routes are being built in parallel
    // by another worker and may not exist on the running hermes yet -- the
    // page's own fetch guards a 404 into an honest "no page yet" rather than
    // treating it as an error.
    if (req.method === 'GET' && url.pathname === '/api/page') {
      const personKey = url.searchParams.get('personKey') ?? '';
      const out = await hermes('/admin/relationship/page?personKey=' + encodeURIComponent(personKey));
      // hermes answers { page: {...} }; the tab reads the page itself.
      let text = out.text;
      try { const parsed = JSON.parse(out.text); if (parsed && parsed.page !== undefined) text = JSON.stringify(parsed.page ?? { sections: {} }); } catch {}
      return send(res, out.status, text);
    }

    if (req.method === 'POST' && url.pathname === '/api/pages/build') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const out = await hermes('/admin/relationship/pages/build', { method: 'POST', body: raw });
      return send(res, out.status, out.text);
    }

    // PUBLIC LOOKUP (L5 step 6). Forwarded verbatim to hermes's own routes,
    // same shape as every proxy above: the desk's "look up now" button is a
    // write (spends the owner's model subscription and real search quota,
    // and writes pending claims about a real person) and goes through hermes,
    // never touching the corpus directly; the log listing is read-only and
    // is hermes's own receipt, not reconstructed here.
    if (req.method === 'POST' && url.pathname === '/api/lookup/person') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const out = await hermes('/admin/relationship/lookup/person', { method: 'POST', body: raw });
      return send(res, out.status, out.text);
    }

    if (req.method === 'GET' && url.pathname === '/api/lookups') {
      const personKey = url.searchParams.get('personKey') ?? '';
      const out = await hermes('/admin/relationship/lookups?personKey=' + encodeURIComponent(personKey));
      if (out.status !== 200) return send(res, out.status, out.text);
      let data;
      try { data = JSON.parse(out.text); } catch { return send(res, out.status, out.text); }
      // The desk's "changed since (public)" section needs person_lookup_change
      // rows for this person; hermes's /admin/relationship/lookups doesn't
      // carry them, so they're read here off the same read-only corpus
      // handle /api/cards' changedFor uses above, same join and same
      // try/catch reasoning: a corpus without SCHEMA_VERSION 13's
      // person_lookup_change table must not take this route down, just omit
      // `changes`. Unlike changedFor (newest, undecided-only, for a card
      // badge), this returns EVERY change row for the person, decided or not,
      // so the person view can render an Accept/Reject pair or a decided
      // badge per row, the same as page items do.
      data.changes = [];
      try {
        const rows = corpus.prepare(
          `SELECT plc.claim_id AS claimId, plc.kind AS kind, plc.url AS url, plc.change_date AS date,
                  c.text AS text,
                  (SELECT d.action FROM claim_decision d WHERE d.claim_id = plc.claim_id ORDER BY d.id DESC LIMIT 1) AS decision
           FROM person_lookup_change plc
           JOIN claim c ON c.id = plc.claim_id
           WHERE c.subject = 'person' AND c.subject_person_key = ?
           ORDER BY plc.claim_id DESC`
        ).all(personKey);
        const sourceStmt = corpus.prepare(
          `SELECT context_id AS contextId, quote FROM claim_source WHERE claim_id = ? AND source = 'web' LIMIT 1`
        );
        const ctxStmt = corpus.prepare('SELECT id FROM context WHERE id = ?');
        data.changes = rows.map((row) => {
          let quote = null;
          try {
            const source = sourceStmt.get(row.claimId);
            if (source) {
              const ctx = ctxStmt.get(source.contextId);
              if (ctx) quote = source.quote; // the receipt is gone, so the quote is gone
            }
          } catch { /* leave quote null */ }
          return { claimId: row.claimId, kind: row.kind, url: row.url, date: row.date ?? null,
            text: row.text, decision: row.decision ?? null, quote };
        });
      } catch {
        // pre-migration schema: no person_lookup_change table yet
      }
      return send(res, 200, JSON.stringify(data));
    }

    // LINT (step 5½). /api/lint and /api/lint/resolve are verbatim hermes
    // proxies, same shape as every write above -- this page never decides
    // what a check means or what a resolution does, only that the click
    // happened. /api/lint/findings is the one read this view enriches:
    // hermes's own finding rows carry only ids (person_key, claim_id) by
    // design (detail is canonical JSON -- ids, counts, public title/company,
    // never a quote or context line), so display_name and, for an
    // expired_claim finding specifically, the claim's own text are added
    // HERE, off the same read-only corpus handle /api/pending already uses
    // above -- wrapped in try/catch, same reasoning as sweepProposal there:
    // a stale/partial local schema must not take the Lint tab down.
    if (req.method === 'GET' && url.pathname === '/api/lint/findings') {
      const qs = new URLSearchParams();
      for (const key of ['check', 'open', 'limit']) {
        const v = url.searchParams.get(key);
        if (v !== null) qs.set(key, v);
      }
      const out = await hermes('/admin/relationship/lint/findings' + (qs.toString() ? '?' + qs.toString() : ''));
      if (out.status !== 200) return send(res, out.status, out.text);
      const data = JSON.parse(out.text);
      const nameStmt = corpus.prepare('SELECT display_name FROM people WHERE person_key = ?');
      const claimTextStmt = corpus.prepare('SELECT text FROM claim WHERE id = ?');
      data.findings = (data.findings ?? []).map((f) => {
        let displayName = null;
        let claimText = null;
        try {
          if (f.personKey) displayName = nameStmt.get(f.personKey)?.display_name ?? null;
          if (f.checkName === 'expired_claim' && f.claimId != null) {
            claimText = claimTextStmt.get(f.claimId)?.text ?? null;
          }
        } catch {
          // pre-migration or partial schema -- display context only, never
          // required for the tab to render.
        }
        return { ...f, displayName, claimText };
      });
      return send(res, 200, JSON.stringify(data));
    }

    if (req.method === 'POST' && url.pathname === '/api/lint') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const out = await hermes('/admin/relationship/lint', { method: 'POST', body: raw });
      return send(res, out.status, out.text);
    }

    if (req.method === 'POST' && url.pathname === '/api/lint/resolve') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const out = await hermes('/admin/relationship/lint/resolve', { method: 'POST', body: raw });
      return send(res, out.status, out.text);
    }

    send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (err) {
    send(res, 500, JSON.stringify({ error: String(err?.message ?? err) }));
  }
});

// 127.0.0.1 explicitly, never a bare listen: this serves private message content
// and has no auth of its own beyond being unreachable off the machine.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`claim review  →  http://127.0.0.1:${PORT}`);
  console.log(`hermes        →  ${HERMES}`);
  console.log('development only; ui/devtools is never copied into the app bundle');
});
