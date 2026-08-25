// The People popup. Screen 1 of the People/network feature: a short line, then
// the CONNECTIONS BAR — the same connector tiles as the settings screen (same
// .list/.row/.mark/.dot classes, same hzGlyph), but sorted DISCONNECTED/errored
// first, so the popup reads as "connect these to search your people deeper."
// Clicking a tile hands off to the settings connections popup, where the connect
// flow already lives. bridge.js provides hzPost, hzGlyph, hzAutoFit.
'use strict';

document.getElementById('close').addEventListener('click', () => {
  hzPost('close').catch(() => {});
});

const pconn = document.getElementById('pconn');
const phint = document.getElementById('phint');
let openId = null; // which connector's flow is showing, for toggle

// Search parameters. Timeframe in days back; 0 = max (all time). Default 1 year.
const TIME_LABEL = { 7: '1 week', 30: '1 month', 180: '6 months', 365: '1 year', 1095: '3 years', 1825: '5 years', 0: 'all time' };
const timeSelect = document.getElementById('ptime');
let searchDays = Number(timeSelect.value);
timeSelect.addEventListener('change', () => { searchDays = Number(timeSelect.value); });

// Clicking a tile opens THAT connector's own flow inline here — the exact flow
// settings shows (shared via hzConnectorHint), not the settings screen. Toggles:
// clicking the open one closes it; clicking another swaps.
// Close the side panel: clear it and shrink the popup back.
function closeHint() {
  openId = null;
  for (const r of pconn.querySelectorAll('.row')) r.classList.remove('open');
  phint.replaceChildren();
  hzPost('fitContent', { height: 0, extraWidth: 0 }).catch(() => {});
  fitPeople();
}

// A corner × on the side panel, like settings.
function addHintClose() {
  const x = document.createElement('button');
  x.className = 'hint-x';
  x.textContent = '×';
  x.setAttribute('aria-label', 'close');
  x.addEventListener('click', (e) => { e.stopPropagation(); closeHint(); });
  phint.appendChild(x);
}

// Open the side panel WITHOUT letting it grow the popup taller than the main
// column. A tall panel (the specs) that stretched the row would drag the whole
// popup up past the top of the screen and clip its header — so we cap the panel
// to the main column's height and let it scroll inside. The popup's total
// height then never changes when a panel opens, so it can't be pushed off-screen.
function growPanel() {
  const main = document.getElementById('pmain');
  if (main) phint.style.maxHeight = Math.round(main.getBoundingClientRect().height) + 'px';
  hzPost('fitContent', { height: 0, extraWidth: 248 }).catch(() => {});
  fitPeople();
}

function openConnector(src, row) {
  const wasOpen = openId === src.id;
  phint.replaceChildren();
  for (const r of pconn.querySelectorAll('.row')) r.classList.remove('open');
  if (wasOpen) { closeHint(); return; }
  openId = src.id;
  row.classList.add('open');
  hzConnectorHint(src, phint, { refresh: reload });
  addHintClose();
  growPanel();
  row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

// The tile is the SHARED component (connector-tile.js): same markup, status
// dot, and hover label as the settings shelf. Only the click handler is ours.
// Wrapped in .rowwrap to match the shelf's markup.
function tile(src) {
  const wrap = document.createElement('div');
  wrap.className = 'rowwrap';
  wrap.appendChild(hzConnectorTile(src, { onOpen: openConnector }));
  return wrap;
}

// Same set settings hides — non-people sources that don't belong on a people map.
const HIDDEN_CONNECTORS = new Set(['oura', 'photos', 'files', 'notion', 'notes']);
const kindOf = (id) => (id.startsWith('mail:') ? 'mail' : id);

function render(sources) {
  // Hide the non-people connectors, then disconnected/errored first (surface
  // what still needs connecting), stable within each group.
  const ordered = sources
    .filter((s) => !HIDDEN_CONNECTORS.has(kindOf(s.id)))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.connected === b.s.connected ? a.i - b.i : a.s.connected ? 1 : -1))
    .map((x) => x.s);
  pconn.replaceChildren(...ordered.map(tile));
  // The ring positions each tile by transform (people.css), reading these two
  // custom properties: --n is the same on every tile, --i is its index, so an
  // evenly-spaced angle falls out of pure CSS with no per-count stylesheet.
  // --n also lands on the ring container itself, one level up, so the ring's
  // own size (and therefore the popup's total height) can grow only as far
  // as the actual connector count needs — a handful of sources gets a small
  // ring instead of always paying for the worst case.
  const rows = pconn.querySelectorAll('.row');
  const pring = document.getElementById('pring');
  if (pring) pring.style.setProperty('--n', rows.length);
  rows.forEach((row, i) => {
    row.style.setProperty('--i', i);
    row.style.setProperty('--n', rows.length);
  });
  if (typeof fitPeople === 'function') fitPeople();
}

// Re-fetch status and repaint the bar. Passed to hzConnectorHint as its refresh,
// so a successful link flips the dot green here too.
function reload() {
  hzPost('status')
    .then((d) => { if (d && d.state === 'ok' && Array.isArray(d.sources)) render(d.sources); })
    .catch(() => {});
}

// ---------------- deep search controls ----------------
// "what it does": opens the details as the side panel (same mechanism as a
// connector's flow), listing the actual actions + caps.
function openSearchDetails() {
  openId = null;
  for (const r of pconn.querySelectorAll('.row')) r.classList.remove('open');
  phint.replaceChildren();
  const tip = document.createElement('div');
  tip.className = 'hint hold';
  const head = document.createElement('b');
  head.textContent = 'what deep search does';
  tip.appendChild(head);
  const ul = document.createElement('ul');
  ul.className = 'p-what';
  for (const line of [
    'maps every person you have talked to, across all connected sources',
    `within your timeframe — ${TIME_LABEL[searchDays] || searchDays + ' days'}`,
    'the map is built on this mac; no cloud model sees it',
    'builds your private people-map; searching it for specifics comes next',
  ]) {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  }
  tip.appendChild(ul);
  const stay = document.createElement('span');
  stay.className = 'stay';
  stay.textContent = 'data stored locally';
  tip.appendChild(stay);
  phint.appendChild(tip);
  addHintClose();
  growPanel();
}
document.getElementById('pspecs').addEventListener('click', (e) => {
  e.preventDefault();
  openSearchDetails();
});
// ---------------- review mode: ask, don't guess ----------------
// After "initialize search", the code has built the people-map and handed back
// the pairs it could not confidently merge. We show them ONE at a time — same /
// different / skip — and record each so it is never asked again. This is the UI
// half of the resolution layer in ui/server/people; the decision is the owner's,
// never the code's.
const pmain = document.getElementById('pmain');
const preview = document.getElementById('preview');

let rQueue = [];               // the current batch of pairs to review
let rIdx = 0;                  // cursor into rQueue
let rDays = 0;                 // timeframe the run used (for fetching more)
let rPeople = 0;              // how many people the map holds
let rDecided = 0;              // merges/splits the owner has confirmed this run
const rSkipped = new Set();    // pairIds skipped this session — don't re-show

// A person's one-line profile inside a card: name, then channels and count.
function personLine(p) {
  const el = document.createElement('div');
  el.className = 'rv-p';
  const name = document.createElement('div');
  name.className = 'rv-name';
  name.textContent = p.name || p.key;
  const meta = document.createElement('div');
  meta.className = 'rv-meta';
  const chans = (p.channels || []).join(' · ') || 'no channel';
  const msgs = p.messages ? `${p.messages} msg${p.messages === 1 ? '' : 's'}` : '';
  meta.textContent = [chans, msgs].filter(Boolean).join('  ·  ');
  el.append(name, meta);
  return el;
}

function showSetup() {
  preview.hidden = true;
  preview.replaceChildren();
  pmain.hidden = false;
  closeHint();
  fitPeople();
}

function enterReview() {
  closeHint();            // no connector side-panel in review mode
  pmain.hidden = true;
  preview.hidden = false;
}

// Render the pair at the cursor, or advance/fetch/finish when the batch is spent.
function renderReview() {
  if (rIdx >= rQueue.length) {
    // Batch spent. Ask the server for the next page (decided pairs are already
    // excluded there); drop any we skipped this session so they don't loop.
    hzPost('peopleReview', { days: rDays, limit: 40 })
      .then((res) => {
        const next = (res && Array.isArray(res.pairs) ? res.pairs : []).filter((p) => !rSkipped.has(p.pairId));
        if (next.length === 0) { renderDone(); return; }
        rQueue = next;
        rIdx = 0;
        rPeople = Number(res.people) || rPeople;
        paintCard();
      })
      .catch(() => renderDone());
    return;
  }
  paintCard();
}

function paintCard() {
  const pair = rQueue[rIdx];
  const remaining = (rQueue.length - rIdx);

  const head = document.createElement('div');
  head.className = 'rv-head';
  const mapped = document.createElement('span');
  mapped.className = 'rv-mapped';
  mapped.textContent = `${rPeople} people mapped`;
  const prog = document.createElement('span');
  prog.className = 'rv-prog';
  prog.textContent = remaining === 1 ? 'last to review' : `${remaining} to review`;
  head.append(mapped, prog);

  const card = document.createElement('div');
  card.className = 'rv-card';
  const q = document.createElement('div');
  q.className = 'rv-q';
  q.textContent = 'same person?';
  const pair2 = document.createElement('div');
  pair2.className = 'rv-pair';
  const vs = document.createElement('div');
  vs.className = 'rv-vs';
  vs.textContent = '↕';
  pair2.append(personLine(pair.a), vs, personLine(pair.b));
  const why = document.createElement('div');
  why.className = 'rv-why';
  why.textContent = pair.reason || 'possible match';
  card.append(q, pair2, why);

  const actions = document.createElement('div');
  actions.className = 'rv-actions';
  const mk = (label, verdict, cls) => {
    const btn = document.createElement('button');
    btn.className = 'rv-btn ' + cls;
    btn.textContent = label;
    btn.addEventListener('click', () => decide(pair, verdict));
    return btn;
  };
  actions.append(
    mk('same person', 'same', 'rv-yes'),
    mk('different', 'different', 'rv-no'),
    mk('skip', 'skip', 'rv-skip'),
  );

  preview.replaceChildren(head, card, actions);
  fitPeople();
}

// Record the owner's call, then advance. A wrong click is recoverable — the
// decision store upserts, so re-deciding a pair later overwrites it.
function decide(pair, verdict) {
  for (const b of preview.querySelectorAll('.rv-btn')) b.disabled = true;
  if (verdict === 'skip') {
    rSkipped.add(pair.pairId);
    rIdx += 1;
    renderReview();
    return;
  }
  hzPost('peopleDecide', { a: pair.a.key, b: pair.b.key, verdict })
    .then(() => { rDecided += 1; })
    .catch(() => {})            // a failed write just means the pair returns next run
    .finally(() => { rIdx += 1; renderReview(); });
}

function renderDone() {
  const done = document.createElement('div');
  done.className = 'rv-done';
  const h = document.createElement('b');
  h.textContent = 'your people-map is ready';
  const l1 = document.createElement('p');
  l1.textContent = `${rPeople} people, mapped across your connectors.`;
  const l2 = document.createElement('p');
  l2.textContent = rDecided > 0
    ? `${rDecided} merge${rDecided === 1 ? '' : 's'} you confirmed.`
    : 'nothing needed merging.';
  const l3 = document.createElement('p');
  l3.className = 'rv-next';
  l3.textContent = 'searching it for specifics comes next.';
  const btn = document.createElement('button');
  btn.className = 'p-init';
  btn.textContent = 'done';
  btn.addEventListener('click', showSetup);
  done.append(h, l1, l2, l3, btn);
  preview.replaceChildren(done);
  fitPeople();
}

document.getElementById('pinit').addEventListener('click', () => {
  const b = document.getElementById('pinit');
  b.disabled = true;
  b.textContent = 'searching…';
  rDays = searchDays;
  rDecided = 0;
  rSkipped.clear();
  hzPost('initSearch', { days: searchDays })
    .then((res) => {
      if (!res || typeof res.people !== 'number') throw new Error('bad response');
      rPeople = res.people;
      rQueue = Array.isArray(res.pairs) ? res.pairs : [];
      rIdx = 0;
      enterReview();
      if (rQueue.length === 0) renderDone(); else renderReview();
    })
    .catch(() => {
      b.textContent = 'couldn’t start — try again';
      setTimeout(() => { b.textContent = 'search'; }, 1800);
    })
    .finally(() => {
      // Re-enable for next time; it is hidden while review mode is up anyway.
      b.disabled = false;
      if (!preview.hidden) b.textContent = 'search';
    });
});

// Push the exact card height to native, so a bottom row like "read specs" can
// never sit below the panel's bottom edge.
//
// THIS IS THE ONLY FITTER ON THIS PAGE, and the page must not also run
// hzAutoFit. That one reports `window.innerHeight + (scrollHeight -
// clientHeight)` — the height the window ALREADY has, plus whatever overflows
// it. Two consequences, both of which this page hit:
//   - it can only ever grow the window, never shrink it back;
//   - under `overflow: hidden` there is no measurable overflow, so it reports
//     the current height forever and the window never grows either.
// Running both meant hzAutoFit's "keep it exactly as it is" answer landed
// after this one's correct measurement and pinned the panel to whatever the
// native base size happened to be — content cut off when the base was small,
// and a band of empty card below "read specs" when the base was raised to
// compensate. Measuring the card itself grows AND shrinks, which is the whole
// job.
function fitPeople() {
  // Measure AFTER layout settles (rAF), by the rendered rect, so the popup
  // sizes exactly to the card — no dead space below "read specs", and it
  // shrinks back when a side panel closes.
  requestAnimationFrame(() => {
    const win = document.querySelector('.win');
    if (!win) return;
    // Measure what the content WANTS, not what the last squeeze left it: with
    // the cap still applied, the measurement would ratify the shrunken ring
    // and the window could never grow back when the widget is moved and the
    // ceiling rises. Cleared and re-applied inside one rAF, so no intermediate
    // layout is ever painted.
    const pring = document.getElementById('pring');
    if (pring) pring.style.removeProperty('--ring-cap');
    hzPost('fitContent', { height: Math.ceil(win.getBoundingClientRect().height) + 4 }).catch(() => {});
    capRing();
  });
}

// The other half of the bargain fitContent strikes: the page asks for the
// height its content wants, and native answers with the room it actually has
// (popupCeiling clamps every popup to the space above the widget). When the
// answer is short, shrink the RING to fit it rather than scrolling — a ring
// with its bottom arc cut off reads as broken, and the overlay scrollbar that
// would say otherwise is invisible until touched. Solving the box arithmetic
// backwards (box = 2r + 44, so r = room/2 − 22) makes the shrunken ring land
// exactly inside the granted height in one step, no creep and no oscillation:
// re-running with an unchanged grant computes the same cap. CSS floors the
// result at 64px — below that the tiles would overlap, so scrolling returns
// as the honest last resort.
function capRing() {
  const pring = document.getElementById('pring');
  const win = document.querySelector('.win');
  if (!pring || !win) return;
  const ringH = pring.getBoundingClientRect().height;
  if (ringH < 1) return; // review mode: no ring on screen, nothing to size
  const chrome = win.getBoundingClientRect().height - ringH;
  pring.style.setProperty('--ring-cap', `${Math.floor((window.innerHeight - chrome) / 2) - 22}px`);
}
// Native's resize lands after the fitContent round trip, as a window resize
// here — that is the moment the granted height is knowable.
window.addEventListener('resize', capRing);

reload();
// No hzAutoFit here — see fitPeople's header for why the two cannot both run.
requestAnimationFrame(fitPeople);
// rAF does not fire in a window that is ordered out, and this page loads while
// hidden; the timer is what makes the first measurement happen at all. (This
// backstop is the one genuinely useful thing hzAutoFit was providing.)
setTimeout(fitPeople, 250);
window.addEventListener('focus', () => { reload(); fitPeople(); });
