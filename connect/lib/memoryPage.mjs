// The memory review page. Pure: state in, HTML out.
//
// This is the v1 product surface. Everything else in the memory pipeline exists
// so that this page can be honest, and the page is honest only if it shows the
// owner exactly what the model was looking at when it made each claim. So the
// QUOTE IS THE POINT — not a summary of the quote, not an ellipsis, not "from
// your messages". The exact span, with the claim above it and the provenance
// below it, and two buttons.
//
// The reader has to be able to get through a night's proposals in one sitting.
// That is a stated gate, not a nicety, because "unreviewed means unusable": a
// backlog the owner never clears is a memory system that never turns on. So the
// layout is one scannable column, no pagination, no filters, no bulk actions.
// Bulk accept in particular is deliberately absent — a button that accepts
// forty claims at once is a button that accepts the one wrong claim too.
//
// Same palette and the same no-external-requests posture as the connect page;
// this file borrows both from page.mjs rather than restating them.

import { escapeHtml } from './page.mjs';

const C = {
  bg: '#141412',
  fg: '#eaeaea',
  hairline: '#1c1c1c',
  muted: '#5c5c5c',
  secondary: '#8a8a8a',
  hazelnut: '#c5a56d',
  hazelnutLight: '#e5d6bb',
};

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    background: ${C.bg}; color: ${C.fg};
    font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    display: flex; justify-content: center; padding: 56px 20px;
  }
  ::selection { background: ${C.hazelnut}; color: ${C.bg}; }
  .wrap { width: 100%; max-width: 640px; }
  .brand { font-size: 11px; color: ${C.muted}; letter-spacing: 0.08em; margin: 0 0 18px; }
  h1 { font-size: 20px; font-weight: 500; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { margin: 0 0 4px; font-size: 13px; color: ${C.secondary}; line-height: 1.7; }
  .counts { font-size: 12px; color: ${C.muted}; margin: 0 0 28px; }
  .counts b { color: ${C.fg}; font-weight: 500; }
  .banner {
    border: 1px solid ${C.hazelnut}; color: ${C.hazelnutLight};
    padding: 10px 12px; font-size: 12px; margin: 0 0 20px;
  }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 26px; }
  li { border-top: 1px solid ${C.hairline}; padding-top: 18px; }
  .kind {
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
    color: ${C.hazelnut}; margin: 0 0 8px;
  }
  .claim { font-size: 15px; line-height: 1.55; margin: 0 0 14px; }
  /* The receipt. Indented and ruled so the eye can tell at a glance which
     words are the owner's and which are the model's. */
  .quote {
    border-left: 2px solid ${C.hazelnut};
    padding: 8px 0 8px 14px; margin: 0 0 12px;
    font-size: 13px; line-height: 1.6; color: ${C.secondary};
    white-space: pre-wrap; word-break: break-word;
  }
  .prov { font-size: 11px; color: ${C.muted}; margin: 0 0 14px; line-height: 1.7; }
  .actions { display: flex; gap: 10px; }
  form { margin: 0; }
  button {
    font: inherit; font-size: 12px; cursor: pointer;
    padding: 7px 16px; border-radius: 2px;
    background: transparent; color: ${C.hazelnut};
    border: 1px solid ${C.hazelnut};
  }
  button:hover { background: rgba(197,165,109,0.18); color: ${C.hazelnutLight}; }
  button.reject { color: ${C.secondary}; border-color: ${C.hairline}; }
  button.reject:hover { background: rgba(255,255,255,0.05); color: ${C.fg}; }
  .empty { font-size: 13px; color: ${C.secondary}; line-height: 1.8; }
  /* The card under the cursor. Reviewing 50 claims means never reaching for
     the mouse, so the keyboard needs somewhere visible to be. */
  li.here { border-left: 2px solid ${C.hazelnut}; padding-left: 16px; margin-left: -18px; }
  li.done { display: none; }
  .keys { font-size: 11px; color: ${C.muted}; margin: 0 0 24px; line-height: 1.9; }
  .keys kbd {
    font: inherit; font-size: 10px; border: 1px solid ${C.hairline};
    padding: 1px 5px; border-radius: 2px; color: ${C.secondary};
  }
  .progress { font-size: 11px; color: ${C.muted}; margin: 0 0 6px; }
  .undo { margin-left: 6px; color: ${C.muted}; }
  .foot { font-size: 11px; color: ${C.muted}; margin: 32px 0 0; line-height: 1.8; }
  a { color: ${C.hazelnut}; }
`;

function stamp(ms) {
  if (ms === null || ms === undefined) return 'no date';
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? 'no date' : d.toISOString().slice(0, 10);
}

// The label a source gets on the page. Plain words, because the owner is
// reading this at speed and "imessage" is a table value, not a place.
const SOURCE_LABEL = Object.freeze({
  imessage: 'a message you sent',
  notes: 'a note you wrote',
});

function claimItem(claim, base, index) {
  // A claim whose source row has vanished, or whose snapshot no longer matches
  // the row. Neither should be reachable — the upsert and deletion paths remove
  // derived claims in the same transaction — so if one appears, say so on the
  // page rather than rendering a receipt that is not true any more.
  const drifted =
    claim.current_hash === null ||
    claim.current_hash === undefined ||
    claim.current_hash !== claim.snapshot_hash;
  return `<li data-id="${escapeHtml(String(claim.id))}" data-i="${index}">
    <p class="kind">${escapeHtml(claim.kind)}</p>
    <p class="claim">${escapeHtml(claim.text)}</p>
    <blockquote class="quote">${escapeHtml(claim.quote)}</blockquote>
    <p class="prov">from ${escapeHtml(SOURCE_LABEL[claim.source] ?? claim.source)} on ${escapeHtml(
      stamp(claim.source_ts ?? claim.observed_at)
    )} &middot; ${escapeHtml(claim.model)} &middot; ${escapeHtml(
      String(claim.prompt_path)
    )} @ ${escapeHtml(String(claim.prompt_sha).slice(0, 12))}${
      drifted
        ? ' <br>&#9888; the row this quotes has changed since it was read; reject it and let it be read again'
        : ''
    }</p>
    <div class="actions">
      <form method="post" action="${escapeHtml(base)}/memory">
        <input type="hidden" name="claim_id" value="${escapeHtml(String(claim.id))}">
        <input type="hidden" name="action" value="accept">
        <button type="submit">Accept</button>
      </form>
      <form method="post" action="${escapeHtml(base)}/memory">
        <input type="hidden" name="claim_id" value="${escapeHtml(String(claim.id))}">
        <input type="hidden" name="action" value="reject">
        <button class="reject" type="submit">Reject</button>
      </form>
    </div>
  </li>`;
}

// The keyboard layer. Progressive enhancement on purpose: every card already
// has two real <form> posts that work with scripting off, and this only makes
// them faster. If the nonce is refused or the script is blocked, the page still
// reviews -- one full reload per decision, which is slow but never wrong.
//
// There is still no bulk accept. `a` accepts ONE claim, the one under the
// cursor, and the cursor only moves when you decide. A key that accepted the
// rest of the queue would be the same mistake as a button that did.
function keyboardScript(base) {
  return `
(() => {
  const q = document.getElementById('q');
  if (!q) return;
  const cards = [...q.children];
  const total = cards.length;
  let at = 0, done = 0, last = null;
  const progress = document.getElementById('progress');

  // The counts line is rendered server-side at page load, so without this it
  // sits there saying "50 waiting, 0 accepted" while you decide all fifty --
  // which reads as "nothing is being saved". It was: the decisions were
  // landing fine and only the header lied. A stale number next to a live one
  // is worse than no number.
  const counts = document.getElementById('counts');
  const base = counts
    ? {
        waiting: Number(counts.dataset.waiting || 0),
        accepted: Number(counts.dataset.accepted || 0),
        rejected: Number(counts.dataset.rejected || 0),
      }
    : null;
  let acc = 0, rej = 0;
  const paintCounts = () => {
    if (!counts || !base) return;
    counts.innerHTML =
      '<b>' + Math.max(base.waiting - acc - rej, 0) + '</b> waiting \u00b7 ' +
      '<b>' + (base.accepted + acc) + '</b> accepted \u00b7 ' +
      '<b>' + (base.rejected + rej) + '</b> rejected';
  };

  const show = () => {
    cards.forEach((c, i) => c.classList.toggle('here', i === at));
    const card = cards[at];
    if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (progress) {
      progress.textContent = done + ' of ' + total + ' decided' +
        (last ? ' \u00b7 press u to undo ' + last.action : '');
    }
  };

  const next = () => {
    const from = at;
    for (let i = at; i < cards.length; i += 1) {
      if (!cards[i].classList.contains('done')) { at = i; show(); return; }
    }
    for (let i = 0; i < from; i += 1) {
      if (!cards[i].classList.contains('done')) { at = i; show(); return; }
    }
    at = -1;
    if (progress) progress.textContent = 'all ' + total + ' decided. reload for more.';
  };

  const post = async (id, action) => {
    const res = await fetch('${base}/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim_id: Number(id), action }),
    });
    if (!res.ok) throw new Error(await res.text());
  };

  const decide = async (action) => {
    const card = cards[at];
    if (!card || card.classList.contains('done')) return;
    const id = card.dataset.id;
    card.classList.add('done');
    done += 1;
    if (action === 'accept') acc += 1; else rej += 1;
    last = { id, action, card };
    paintCounts();
    next();
    try { await post(id, action); }
    catch (e) {
      // Put it back rather than pretending. A card that vanished without the
      // decision landing is the one failure the owner cannot see.
      card.classList.remove('done');
      done -= 1;
      if (action === 'accept') acc -= 1; else rej -= 1;
      last = null;
      paintCounts();
      // As text nodes, never innerHTML: e.message is the server's response
      // body — on a 502 that is hermes' error string passed through verbatim,
      // and JSON.stringify does not encode '<'. Nothing dynamic on this page
      // may parse as markup.
      card.querySelector('.prov').append(
        document.createElement('br'),
        '\u26a0 not recorded \u2014 ' + String(e.message).slice(0, 80)
      );
      show();
    }
  };

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'a') { e.preventDefault(); decide('accept'); }
    else if (k === 'r' || k === 'x') { e.preventDefault(); decide('reject'); }
    else if (k === 'j' || k === 'arrowdown') { e.preventDefault(); at = Math.min(at + 1, cards.length - 1); show(); }
    else if (k === 'k' || k === 'arrowup') { e.preventDefault(); at = Math.max(at - 1, 0); show(); }
    else if (k === 'u' && last) {
      e.preventDefault();
      const { id, action, card } = last;
      const opposite = action === 'accept' ? 'reject' : 'accept';
      // Append the opposite decision. Nothing is rewritten -- claim_decision
      // is append-only and the latest one wins, so undo is another decision
      // rather than an erasure.
      post(id, opposite).then(() => {
        card.classList.remove('done');
        done -= 1;
        if (action === 'accept') acc -= 1; else rej -= 1;
        last = null;
        paintCounts();
        show();
      });
    }
  });

  q.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const li = b.closest('li');
    at = cards.indexOf(li);
    decide(b.classList.contains('reject') ? 'reject' : 'accept');
  }));

  paintCounts();
  show();
})();
`;
}

export function renderMemoryPage(
  { claims = [], more = false, counts = {} } = {},
  { token = null, banner = null, error = null, nonce = null } = {}
) {
  const base = token === null ? '' : `/c/${token}`;
  const body = error
    ? `<p class="empty">Hazlie could not reach its own store: ${escapeHtml(error)}</p>`
    : claims.length === 0
      ? `<p class="empty">Nothing to review.<br>An empty queue is the normal state — most messages say nothing durable, and the distiller is meant to return nothing for them.</p>`
      : `<ul id="q">${claims.map((c, i) => claimItem(c, base, i)).join('')}</ul>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Memory · Hazlie</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="${C.bg}">
<style>${STYLE}</style></head>
<body><div class="wrap">
  <p class="brand">HAZLIE / MEMORY</p>
  ${banner ? `<div class="banner">${escapeHtml(banner)}</div>` : ''}
  <h1>What Hazlie thinks it learned</h1>
  <p class="sub">Nothing here is in use yet. A claim does nothing until you accept it.</p>
  <p class="counts" id="counts"
     data-waiting="${escapeHtml(String(counts.proposed ?? 0))}"
     data-accepted="${escapeHtml(String(counts.accepted ?? 0))}"
     data-rejected="${escapeHtml(String(counts.rejected ?? 0))}">
    <b>${escapeHtml(String(counts.proposed ?? 0))}</b> waiting &middot;
    <b>${escapeHtml(String(counts.accepted ?? 0))}</b> accepted &middot;
    <b>${escapeHtml(String(counts.rejected ?? 0))}</b> rejected${
      counts.stale ? ` &middot; <b>${escapeHtml(String(counts.stale))}</b> stale` : ''
    }
  </p>
  ${
    claims.length > 0 && !error
      ? `<p class="keys"><kbd>a</kbd> accept &middot; <kbd>r</kbd> reject &middot; <kbd>j</kbd>/<kbd>k</kbd> move &middot; <kbd>u</kbd> undo the last one</p>
  <p class="progress" id="progress">0 of ${claims.length} decided</p>`
      : ''
  }
  ${body}
  <p class="foot">
    ${more ? 'More are waiting than fit on this page — decide these and reload.<br>' : ''}
    Rejecting is free and is the expected answer for most of these.<br>
    Nothing on this page has left your Mac, and none of these quotes ever go through Messages.
  </p>
</div>${
    claims.length > 0 && !error && nonce !== null
      ? `<script nonce="${escapeHtml(nonce)}">${keyboardScript(base)}</script>`
      : ''
  }</body></html>`;
}
