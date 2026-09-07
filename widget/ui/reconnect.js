// The reconnect card page. Pulls the current card, renders it with
// textContent only, posts exactly one verdict, then shows the next card or
// the empty state. The verdict IS the eval: every button lands as an
// rm_card_event joined to the snapshot the engine offered, stamped with the
// rules version that produced it -- the loop that used to run through
// hand-graded HTML exports, now running through use.

const el = (id) => document.getElementById(id);
let card = null;

// The mode picker: 'any' · 'founder' · 'investor', persisted per-viewer in
// localStorage (this is a display preference, not a fact worth losing on
// reload, and it never needs to reach hermes -- only the CHOICE, made when
// the owner taps refresh, does). Failure to read/write storage falls back
// to 'any' silently; a popup that cannot remember a button press is not a
// popup that should break.
const MODES = ['any', 'founder', 'investor'];
function readMode() {
  try {
    const stored = localStorage.getItem('rcMode');
    return MODES.includes(stored) ? stored : 'any';
  } catch { return 'any'; }
}
function writeMode(mode) {
  try { localStorage.setItem('rcMode', mode); } catch {}
}
let currentMode = readMode();

function renderModes() {
  el('rcModeAny').classList.toggle('rc-mode-active', currentMode === 'any');
  el('rcModeFounder').classList.toggle('rc-mode-active', currentMode === 'founder');
  el('rcModeInvestor').classList.toggle('rc-mode-active', currentMode === 'investor');
}

function fit() {
  requestAnimationFrame(() => {
    hzPost('fitContent', { height: Math.ceil(document.body.scrollHeight) }).catch(() => {});
  });
}

function renderEmpty() {
  card = null;
  el('rcCard').hidden = true;
  el('rcEmpty').hidden = false;
  fit();
}

function triggerLine(c) {
  const ev = c.evidence ?? {};
  const nums = [];
  if (ev.dormancyDays) nums.push(`quiet ${ev.dormancyDays}d`);
  if (ev.meetings) nums.push(`met ${ev.meetings}×`);
  if (ev.messages) nums.push(`${ev.messages} msgs`);
  const parts = [];
  if (c.focus) parts.push(`NEED · focus: ${c.focus}`);
  if (nums.length) parts.push(nums.join(' · '));
  return parts.join(' · ');
}

function render(c) {
  card = c;
  el('rcCard').hidden = false;
  el('rcEmpty').hidden = true;
  const trigger = triggerLine(c);
  el('rcTrigger').textContent = trigger;
  el('rcTrigger').hidden = !trigger;
  el('rcName').textContent = c.name ?? c.personKey;

  // Five-slot order stays trigger / who / tie / last contact / actions.
  // Person-subject pages add two things to that: `who` (a plain string,
  // shown right under the name, replacing the role fact below) and, when a
  // page exists, a short "asked you for" list drawn from its asks section.
  // `sentence` (the tie) already carries the page's how_left text when a
  // page is behind the card -- the server decides that, this only styles it.
  const hasPage = Boolean(c.page);
  el('rcWho').textContent = c.who ?? '';
  el('rcWho').hidden = !c.who;

  el('rcWhy').textContent = c.sentence ?? '';
  el('rcWhy').classList.toggle('rc-why-emphasis', hasPage);

  el('rcQuote').textContent = c.quote ? `“${c.quote}”` : '';
  el('rcQuote').hidden = !c.quote;

  const asks = (c.page?.sections?.asks ?? []).slice(0, 2).map((a) => a.text).filter(Boolean);
  el('rcAsksList').replaceChildren(...asks.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  el('rcAsksRow').hidden = asks.length === 0;

  // `who` replaces the role fact when present -- the two say the same kind
  // of thing (who this person is), and showing both duplicates it.
  const role = c.who ? '' : [c.role, c.label ? `labeled ${c.label}` : null].filter(Boolean).join(' · ');
  el('rcRole').textContent = role;
  el('rcRoleRow').hidden = !role;

  el('rcLeft').textContent = c.left ?? '';
  el('rcLeftRow').hidden = !c.left;
  el('rcLeft').classList.toggle('rc-warn', c.leftTone === 'bad');
  const ev = c.evidence ?? {};
  const bits = [];
  if (ev.messages) bits.push(`${ev.messages} messages`);
  if (ev.dormancyDays) bits.push(`quiet ${ev.dormancyDays}d`);
  if (ev.meetings) bits.push(`met ${ev.meetings}×`);
  el('rcHistory').textContent = bits.join(' · ');
  el('rcFeedback').value = '';
  fit();
}

async function pull() {
  try {
    const out = await hzPost('relCard');
    if (out?.card) { render(out.card); hzPost('relEvent', { snapshot_id: out.card.snapshot_id, person_key: out.card.personKey, event: 'opened' }).catch(() => {}); }
    else renderEmpty();
  } catch { renderEmpty(); }
}

function verdict(event, extra = {}) {
  if (!card) return;
  const note = el('rcFeedback').value.trim();
  hzPost('relEvent', {
    snapshot_id: card.snapshot_id, person_key: card.personKey, event,
    ...(note ? { note } : {}),
    ...(event === 'dismissed' ? { reason: extra.reason ?? 'not-useful' } : {}),
    ...(extra.mute_days ? { mute_days: extra.mute_days } : {}),
  }).catch(() => {});
  pull(); // next card, or the empty state
}

el('rcYes').addEventListener('click', () => verdict('accepted'));
el('rcNo').addEventListener('click', () => verdict('dismissed', { reason: 'not-useful' }));
el('rcMute').addEventListener('click', () => verdict('muted', { mute_days: 30 }));
el('rcNever').addEventListener('click', () => verdict('dismissed', { reason: 'never-this-person' }));
el('rcClose').addEventListener('click', () => hzPost('close').catch(() => {}));
// The empty state ("nothing to review") left the panel with nothing useful to
// do -- the mode picker above still works, but there was no way to ask for a
// fresh batch under the picked mode without leaving and reopening the panel.
el('rcRefresh').addEventListener('click', () => {
  const btn = el('rcRefresh');
  btn.disabled = true;
  hzPost('relRefresh', { mode: currentMode })
    .then(pull, () => {})
    .finally(() => { btn.disabled = false; });
});

function selectMode(mode) {
  if (!MODES.includes(mode) || mode === currentMode) return;
  currentMode = mode;
  writeMode(mode);
  renderModes();
  hzPost('relRefresh', { mode }).then(pull, () => {});
}
el('rcModeAny').addEventListener('click', () => selectMode('any'));
el('rcModeFounder').addEventListener('click', () => selectMode('founder'));
el('rcModeInvestor').addEventListener('click', () => selectMode('investor'));
renderModes();

// A hidden panel that comes back must refetch: a card acted on elsewhere
// must not linger. Native pokes this on every re-show.
window.__hzReconnectShow = pull;
pull();
