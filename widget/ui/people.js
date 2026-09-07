// The People popup. Its actual job is identity review: initSearch finds
// candidate duplicate-person pairs across connected sources over a timeframe,
// and review mode asks "is this the same person?" one pair at a time (yes /
// no / skip via peopleReview/peopleDecide). It used to open on a ring of
// connector icons around "unify your circles" — legible to nobody as "this is
// where you review duplicate people" (owner, 2026-09-07: "wtf is this image?
// fix this"). The header now says what the page does; the connector ring is
// gone, replaced by a one-line status count built from the same /api/status
// data. Per-connector fix-it (a connector's own login flow) lived here only
// because the ring rendered the tiles — with the tiles gone, that door is the
// Connections popup, not this page. bridge.js provides hzPost, hzGlyph.
'use strict';

document.getElementById('close').addEventListener('click', () => {
  // The close tone, same as every other popup — this id is excluded from the
  // global squish (bridge.js HZ_OWN_TONE) precisely so it can play this.
  hzSfx.close();
  hzPost('close').catch(() => {});
});

const phint = document.getElementById('phint');
let onboardingAttention = false; // this open is the handoff from onboarding

// Search parameters. Timeframe in days back; 0 = max (all time). Default 1 year.
const TIME_LABEL = { 7: '1 week', 30: '1 month', 180: '6 months', 365: '1 year', 1095: '3 years', 1825: '5 years', 0: 'all time' };
const timeSelect = document.getElementById('ptime');
let searchDays = Number(timeSelect.value);
const pcaption = document.getElementById('pcaption');
function paintCaption() {
  pcaption.textContent = `looks back ${TIME_LABEL[searchDays] || searchDays + ' days'} across your sources`;
}
timeSelect.addEventListener('change', () => { searchDays = Number(timeSelect.value); paintCaption(); });
paintCaption();

// Close the side panel: clear it and shrink the popup back.
function closeHint() {
  phint.replaceChildren();
  // No fitContent here any more: the pop-over floats, so opening and closing
  // it never changed the window's size to restore.
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

// ~~growPanel: cap the side panel to the main column and widen the window by
// 248 to reveal it.~~ The flow is a POP-OVER now (owner, 2026-08-25): anchored
// to whatever was pressed, clamped to the viewport by the shared placer, and
// the window never resizes for it.
function growPanel(anchor) {
  hzPlacePop(phint, anchor);
}

// Same set settings hides — non-people sources that don't belong on a people map.
const HIDDEN_CONNECTORS = new Set(['oura', 'photos', 'files', 'notion', 'notes']);
const kindOf = (id) => (id.startsWith('mail:') ? 'mail' : id);

const pstatus = document.getElementById('pstatus');

// The status line under the header: same "visible" filter the old ring used
// (real people-sources only, one row per linked Google account), so the count
// means what the ring's tiles used to show at a glance -- just as text.
//
// "manage sources" would open the Connections popup, but this page's bridge
// compartment (Bridge.swift Bridge.pageCapabilities["people"]) does not grant
// openConnections -- only the widget bar has that door today. Rather than
// widen the grant for a copy change, this stays a read-only count; flagging
// that rather than routing around it.
function paintStatus(sources) {
  const hasGoogleAccount = sources.some(
    (s) => s.connected && typeof s.id === 'string' && s.id.startsWith('mail:')
  );
  const visible = sources.filter((s) =>
    !HIDDEN_CONNECTORS.has(kindOf(s.id)) && !(hasGoogleAccount && s.id === 'mail')
  );
  const connected = visible.filter((s) => s.connected).length;
  const rows = [];
  const line = document.createElement('div');
  line.className = 'p-status-line';
  line.textContent = `${connected} of ${visible.length} sources connected`;
  rows.push(line);
  // A pending batch left over from earlier this session (the popup survives
  // hidden rather than reloading — see main.swift openPeople) is a cheap,
  // real number to show; a fresh session has none, and none is what shows.
  const pending = rQueue.length - rIdx;
  if (pending > 0) {
    const waiting = document.createElement('div');
    waiting.className = 'p-status-waiting';
    waiting.textContent = `${pending} pair${pending === 1 ? '' : 's'} waiting`;
    rows.push(waiting);
  }
  pstatus.replaceChildren(...rows);
  fitPeople();
}

// Re-fetch status and repaint the summary line.
function reload() {
  hzPost('status')
    .then((d) => { if (d && d.state === 'ok' && Array.isArray(d.sources)) paintStatus(d.sources); })
    .catch(() => {});
}

// A fresh People page pulls the handoff flag itself; a reused page receives
// the same fact from native through __hzPeopleIntro. In both cases, record the
// intro only after this page is actually alive to show it.
function enterFromOnboarding(on) {
  onboardingAttention = on === true;
  reload();
  if (onboardingAttention) hzPost('connectorsIntroSeen').catch(() => {});
}
window.__hzPeopleIntro = enterFromOnboarding;

function firstLoad() {
  Promise.all([
    hzPost('status').catch(() => null),
    hzPost('prefs').catch(() => null),
  ]).then(([d, p]) => {
    onboardingAttention = !!(p && p.onboarded === true && p.connectorsIntroDone === false);
    if (d && d.state === 'ok' && Array.isArray(d.sources)) paintStatus(d.sources);
    if (onboardingAttention) hzPost('connectorsIntroSeen').catch(() => {});
  });
}

// ---------------- deep search controls ----------------
// "what it does": opens the details as the side panel, listing the actual
// actions + caps.
function openSearchDetails() {
  phint.replaceChildren();
  const tip = document.createElement('div');
  tip.className = 'hint hold';
  const head = document.createElement('b');
  head.textContent = 'what deep search does';
  tip.appendChild(head);
  // Under the header, same as every connector card (owner, 2026-08-25).
  const stay = document.createElement('span');
  stay.className = 'stay';
  stay.textContent = 'data stored locally';
  tip.appendChild(stay);
  const ul = document.createElement('ul');
  ul.className = 'p-what';
  for (const line of [
    'maps every person you have talked to, across all connected sources',
    `within your timeframe — ${TIME_LABEL[searchDays] || searchDays + ' days'}`,
    // ~~'no cloud model sees it'~~ (stale 2026-08-31: the owner-reviewed
    // frontier handoff can send reviewed text to a cloud model — the map and
    // its rows still never leave).
    'the map is built and kept on this mac',
    'builds your private people-map; searching it for specifics comes next',
  ]) {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  }
  tip.appendChild(ul);
  phint.appendChild(tip);
  addHintClose();
  growPanel(document.getElementById('pspecs'));
}
document.getElementById('pspecs').addEventListener('click', (e) => {
  e.preventDefault();
  openSearchDetails();
});
// The only other door to the reconnect card besides tapping the notify orb.
// A demoted text link now (owner, 2026-09-07) rather than a button, so it
// needs the same preventDefault as the "read specs" link above.
document.getElementById('preconnect').addEventListener('click', (e) => {
  e.preventDefault();
  hzPost('openReconnect').catch(() => {});
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
      setTimeout(() => { b.textContent = 'find pairs'; }, 1800);
    })
    .finally(() => {
      // Re-enable for next time; it is hidden while review mode is up anyway.
      b.disabled = false;
      if (!preview.hidden) b.textContent = 'find pairs';
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
    hzPost('fitContent', { height: Math.ceil(win.getBoundingClientRect().height) + 4 }).catch(() => {});
  });
}
// ~~capRing: when native granted less height than the ring wanted, shrink the
// ring's --ring-cap to fit rather than scroll.~~ Retired with the ring
// (owner, 2026-09-07): the header + status-line layout is short enough that
// popupCeiling's clamp should never engage, and if it ever does, body.people's
// overflow-y: auto (people.css) is the honest fallback — a scroll, never a
// silent clip. A missing #pring can no longer break this fitter because
// nothing here reads #pring any more.

firstLoad();
// No hzAutoFit here — see fitPeople's header for why the two cannot both run.
requestAnimationFrame(fitPeople);
// rAF does not fire in a window that is ordered out, and this page loads while
// hidden; the timer is what makes the first measurement happen at all. (This
// backstop is the one genuinely useful thing hzAutoFit was providing.)
setTimeout(fitPeople, 250);
window.addEventListener('focus', () => { reload(); fitPeople(); });
