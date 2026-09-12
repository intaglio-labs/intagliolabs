// The reconnect card page. Pulls the current card, renders it with
// textContent only, posts exactly one verdict, then shows the next card or
// the empty state. The verdict IS the eval: every button lands as an
// rm_card_event joined to the snapshot the engine offered, stamped with the
// rules version that produced it -- the loop that used to run through
// hand-graded HTML exports, now running through use.

const el = (id) => document.getElementById(id);
let card = null;

// The mode picker: 'any' · 'founder' · 'investor'.
//
// THE SERVER OWNS THIS, localStorage only remembers it (review finding 7).
// The picker used to render from localStorage alone and never reconcile:
// after a hermes restart rel.mode is null and the eligibility config's
// default serves, so the popup could show 'investor' lit while 'any' cards
// were being served -- and tapping 'investor' was a NO-OP, because
// selectMode early-returned on a match with its own stale idea of the mode.
// Every card response now carries the server's `mode` (and `servedMode`,
// the mode the card in hand was produced under); adoptServerMode below
// reconciles on every pull, and selectMode always posts.
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
// The stored value is a first-paint guess only: it is overwritten by the
// server's answer as soon as one arrives.
let currentMode = readMode();

// Reconcile with the server's own idea of the mode. `servedMode` (the mode
// the card in hand was produced under) wins over the holder's `mode` when
// both are present -- what the owner is looking at is the truthful thing to
// light up. A response that names neither (an Owe card, or an older hermes)
// leaves the picker exactly as it is.
function adoptServerMode(out) {
  // A ONE-OFF LOOK IS NOT A CHOICE. `?mode=` serves a card under a mode the
  // owner did not pick and deliberately never persists it, so on that reply
  // `servedMode` is the one-off and `mode` is still the standing choice.
  // Preferring servedMode here would move the picker to 'any' because somebody
  // pressed "show me anyone, just this once" on the onboarding screen -- the
  // durable write that button was rewritten to stop making, arriving through the
  // picker instead.
  const fromServer = out?.oneOff === true
    ? (MODES.includes(out?.mode) ? out.mode : null)
    : MODES.includes(out?.servedMode) ? out.servedMode
      : MODES.includes(out?.mode) ? out.mode : null;
  if (fromServer === null || fromServer === currentMode) return;
  currentMode = fromServer;
  writeMode(fromServer);
  renderModes();
}

function renderModes() {
  el('rcModeAny').classList.toggle('rc-mode-active', currentMode === 'any');
  el('rcModeFounder').classList.toggle('rc-mode-active', currentMode === 'founder');
  el('rcModeInvestor').classList.toggle('rc-mode-active', currentMode === 'investor');
}

function fit() {
  requestAnimationFrame(() => {
    // rc-body (reconnect.css) is the one element allowed to clip its own
    // overflow, so its rendered box can already be shorter than its content.
    // document.body.scrollHeight alone would just echo that clipped number
    // straight back -- a page that has already scrolled its content out of
    // sight could never ask native for more room to show it. An element's
    // own `scrollHeight` always reports the FULL content height regardless
    // of clipping, so swap that in for the win's total before posting; the
    // rest of the layout (head, modes, footer) is fixed chrome either way.
    const win = document.querySelector('.win');
    let height = win.scrollHeight;
    if (!el('rcCard').hidden) {
      const body = el('rcBody');
      height += body.scrollHeight - body.getBoundingClientRect().height;
    }
    hzPost('fitContent', { height: Math.ceil(height) }).catch(() => {});
  });
}

// WHY THERE IS NOTHING, in the owner's words (review finding 15). "nothing
// to review" was shown for a spent frequency cap, for a queue whose people
// are all muted, and for a genuinely empty pool alike -- three different
// facts, one of which ("come back tomorrow") the owner can do nothing about
// and the others of which they can. The route now names a reason; this maps
// it. An unrecognized reason falls back to the original line rather than
// rendering a raw token.
const EMPTY_REASONS = {
  cap: "that's all for today — one nudge a day, on purpose.",
  muted: 'everyone queued up right now is muted. they will come back when the mute expires.',
  suppressed: 'everyone queued up right now is hidden.',
  'quote-gone': 'the messages behind the queued cards are gone, so the cards went with them.',
  'claim-gone': 'the commitment behind the queued card is gone, so the card went with it.',
  'claim-rejected': 'the commitment behind the queued card was rejected, so the card went with it.',
  'no-cap-configured': 'no frequency cap is set, so nothing will show. set one first.',
};
const EMPTY_DEFAULT = 'nothing to review — the orb will light up when there is.';

function renderEmpty(out) {
  card = null;
  el('rcCard').hidden = true;
  el('rcEmpty').hidden = false;
  el('rcEmptyMsg').textContent = out?.refreshing
    ? 'still looking…'
    : (EMPTY_REASONS[out?.reason] ?? EMPTY_DEFAULT);
  // Reset to the reconnect defaults between cards: the empty state is where
  // the mode picker (reconnect's own) lives while nothing is showing, so it
  // must not stay hidden from a previous Owe card.
  el('rcTitle').textContent = 'reconnect?';
  el('rcYes').textContent = 'will text them';
  el('rcModes').hidden = false;
  el('rcActionsError').hidden = true;
  el('rcActionsError').textContent = '';
  setVerdictButtonsDisabled(false);
  fit();
}

// Owe cards (kind==='owe') get their own trigger line, built from
// evidence.owe_kind/overdueDays rather than the reconnect dormancy/meetings/
// messages counts -- those facts don't exist on an Owe card, and "quiet Xd"
// would say the wrong thing about a card whose whole point is a specific
// outstanding ask or commitment, not general silence.
function oweTriggerLine(c) {
  const ev = c.evidence ?? {};
  const days = Number.isFinite(ev.overdueDays) ? ev.overdueDays : null;
  if (ev.owe_kind === 'owe:expired-commitment') {
    return `OWE · you said you would${days !== null ? ` · ${days}d past` : ''}`;
  }
  return `OWE · you never answered${days !== null ? ` · ${days}d` : ''}`;
}

function triggerLine(c) {
  if (c.kind === 'owe') return oweTriggerLine(c);
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

  // Owe cards are a different ask ("will you reply to this specific thing")
  // than reconnect's ("will you reach out at all"), and carry no mode of
  // their own.
  //
  // ~~`el('rcModes').hidden = isOwe`~~ (review finding 8). Hiding the picker
  // on an Owe card left the owner with NO WAY BACK: the two producers
  // alternate, so tapping a mode can be answered with an Owe card, and the
  // picker that would let them try again was gone with it. The buttons are
  // not decoration on an Owe card either -- they set which mode reconnect
  // serves on its next turn, which is exactly what an owner reaching for
  // them wants. So it stays visible, always.
  const isOwe = c.kind === 'owe';
  el('rcTitle').textContent = isOwe ? 'owe?' : 'reconnect?';
  el('rcYes').textContent = isOwe ? 'will reply' : 'will text them';
  el('rcModes').hidden = false;

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
  const who = (c.who ?? '').trim();
  el('rcWho').textContent = who;
  el('rcWho').hidden = !who;

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
  const role = (who ? '' : [c.role, c.label ? `labeled ${c.label}` : null].filter(Boolean).join(' · ')).trim();
  el('rcRole').textContent = role;
  el('rcRoleRow').hidden = !role;

  const left = (c.left ?? '').trim();
  el('rcLeft').textContent = left;
  el('rcLeftRow').hidden = !left;
  el('rcLeft').classList.toggle('rc-warn', c.leftTone === 'bad');
  const ev = c.evidence ?? {};
  const bits = [];
  if (ev.messages) bits.push(`${ev.messages} messages`);
  if (ev.dormancyDays) bits.push(`quiet ${ev.dormancyDays}d`);
  if (ev.meetings) bits.push(`met ${ev.meetings}×`);
  el('rcHistory').textContent = bits.join(' · ');
  el('rcFeedback').value = '';
  el('rcActionsError').hidden = true;
  el('rcActionsError').textContent = '';
  setVerdictButtonsDisabled(false);
  renderDrafts(Array.isArray(c.drafts) ? c.drafts : []);
  fit();
}

// Drafts (footer, above the actions): a suggested text the owner can copy
// and send by hand. The card may already arrive with drafts (fast path --
// the button becomes "redraft"); otherwise the owner asks for them on
// demand, one draft round trip per click.
function renderDraftRows(drafts) {
  el('rcDraftsList').replaceChildren(...drafts.map((d) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'rc-draft-text';
    text.textContent = d.text ?? '';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'rc-draft-copy';
    copyBtn.type = 'button';
    copyBtn.textContent = 'copy';
    copyBtn.addEventListener('click', () => copyDraftText(d.text ?? '', text, copyBtn));
    li.append(text, copyBtn);
    return li;
  }));
  el('rcDraftsCaption').hidden = drafts.length === 0;
}

function renderDrafts(drafts) {
  renderDraftRows(drafts);
  el('rcDraft').textContent = drafts.length ? 'redraft' : 'draft a text';
  el('rcDraftsError').hidden = true;
  el('rcDraftsError').textContent = '';
}

// WKWebView (the widget's actual host) does not reliably expose
// navigator.clipboard.writeText from a page loaded over file:// with this
// CSP -- tested here: the Clipboard API path silently no-ops in that host,
// while select() + document.execCommand('copy') on the draft's own text
// node works, so that's the fallback this uses, not just a decoration.
async function copyDraftText(text, node) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error('no clipboard API');
  } catch {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // CHECK THE BOOLEAN (review finding 14). execCommand reports failure
      // by RETURNING FALSE, not by throwing, so the catch below never ran
      // and "couldn't copy" was unreachable -- a failed copy looked exactly
      // like a successful one, and the owner pasted whatever was already on
      // the clipboard.
      const copied = document.execCommand('copy');
      sel.removeAllRanges();
      if (!copied) throw new Error('execCommand copy refused');
    } catch {
      el('rcDraftsError').textContent = "couldn't copy that — select it and copy by hand";
      el('rcDraftsError').hidden = false;
    }
  }
}

el('rcDraft').addEventListener('click', async () => {
  if (!card) return;
  const btn = el('rcDraft');
  btn.disabled = true;
  el('rcDraftsError').hidden = true;
  el('rcDraftsError').textContent = '';
  try {
    const out = await hzPost('relDraft', { snapshot_id: card.snapshot_id });
    // A 200 carrying no drafts IS a failure (review finding 9): the route
    // answers {ok:false, reason} on an engine error, unparseable output or
    // nothing usable, and this used to treat all three as success and render
    // an empty list -- silence, with the reason sitting unread on the wire.
    if (!out || out.ok === false || !Array.isArray(out.drafts) || out.drafts.length === 0) {
      throw new Error(out?.reason ? String(out.reason) : 'draft failed');
    }
    renderDrafts(out.drafts);
  } catch (err) {
    const why = String(err?.message ?? '').slice(0, 120);
    el('rcDraftsError').textContent = why && why !== 'draft failed'
      ? `couldn't draft that — ${why}`
      : "couldn't draft that — try again";
    el('rcDraftsError').hidden = false;
  } finally {
    btn.disabled = false;
    fit();
  }
});

async function pull() {
  try {
    const out = await hzPost('relCard');
    adoptServerMode(out);
    if (out?.card) {
      render(out.card);
      // 'opened' is deduped per snapshot SERVER-side (a re-show of the same
      // pending card used to post another, and openRate = opened/shown
      // climbed past 1), so this can stay unconditional.
      hzPost('relEvent', { snapshot_id: out.card.snapshot_id, person_key: out.card.personKey, event: 'opened' }).catch(() => {});
    } else renderEmpty(out);
  } catch { renderEmpty(); }
}

const VERDICT_BUTTON_IDS = ['rcYes', 'rcNo', 'rcMute', 'rcNever', 'rcNotThisKind'];

function setVerdictButtonsDisabled(disabled) {
  for (const id of VERDICT_BUTTON_IDS) el(id).disabled = disabled;
}

async function verdict(event, extra = {}) {
  if (!card) { console.log('verdict: no card, ignoring click'); return; }
  const note = el('rcFeedback').value.trim();
  setVerdictButtonsDisabled(true);
  try {
    const out = await hzPost('relEvent', {
      snapshot_id: card.snapshot_id, person_key: card.personKey, event,
      ...(note ? { note } : {}),
      ...(event === 'dismissed' ? { reason: extra.reason ?? 'not-useful' } : {}),
      ...(extra.mute_days ? { mute_days: extra.mute_days } : {}),
    });
    if (!out || out.ok === false) throw new Error('relEvent rejected');
    await pull(); // next card, or the empty state -- clears the error on success
  } catch {
    setVerdictButtonsDisabled(false);
    el('rcActionsError').textContent = "couldn't save that — try again";
    el('rcActionsError').hidden = false;
  }
}

el('rcYes').addEventListener('click', () => verdict('accepted'));
el('rcNo').addEventListener('click', () => verdict('dismissed', { reason: 'not-useful' }));
el('rcMute').addEventListener('click', () => verdict('muted', { mute_days: 30 }));
el('rcNever').addEventListener('click', () => verdict('dismissed', { reason: 'never-this-person' }));
// The person-scoped analogue for a KIND: "not this kind of thing, for me,
// for a while" -- mutes this person for this card's own kind (owe or
// reconnect) server-side, never every kind for them (that is rcNever).
el('rcNotThisKind').addEventListener('click', () => verdict('dismissed', { reason: 'not-this-kind' }));
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

// ALWAYS POSTS (review finding 7). The early return on `mode ===
// currentMode` meant a tap that agreed with the picker's own stale state did
// nothing at all -- which is exactly the state after a restart, when the
// picker says 'investor' and the server's rel.mode is null. The server is
// the one that has to be told; a tap is the telling.
function selectMode(mode) {
  if (!MODES.includes(mode)) return;
  currentMode = mode;
  writeMode(mode);
  renderModes();
  hzPost('relMode', { mode }).then(pull, () => {});
}
el('rcModeAny').addEventListener('click', () => selectMode('any'));
el('rcModeFounder').addEventListener('click', () => selectMode('founder'));
el('rcModeInvestor').addEventListener('click', () => selectMode('investor'));
renderModes();

// A hidden panel that comes back must refetch: a card acted on elsewhere
// must not linger. Native pokes this on every re-show.
window.__hzReconnectShow = pull;
pull();
