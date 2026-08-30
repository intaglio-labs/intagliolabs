// The reconnect card page. Pulls the current card, renders it with
// textContent only, posts exactly one verdict, then shows the next card or
// the empty state. The verdict IS the eval: every button lands as an
// rm_card_event joined to the snapshot the engine offered, stamped with the
// rules version that produced it -- the loop that used to run through
// hand-graded HTML exports, now running through use.

const el = (id) => document.getElementById(id);
let card = null;

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

function render(c) {
  card = c;
  el('rcCard').hidden = false;
  el('rcEmpty').hidden = true;
  el('rcName').textContent = c.name ?? c.personKey;
  el('rcWhy').textContent = c.sentence ?? '';
  el('rcQuote').textContent = c.quote ? `“${c.quote}”` : '';
  el('rcQuote').hidden = !c.quote;
  const role = [c.role, c.label ? `labeled ${c.label}` : null].filter(Boolean).join(' · ');
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

// A hidden panel that comes back must refetch: a card acted on elsewhere
// must not linger. Native pokes this on every re-show.
window.__hzReconnectShow = pull;
pull();
