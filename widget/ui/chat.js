'use strict';
// The chat window has no input of its own: the widget's always-present
// message bar is the single way in. Messages arrive via __hzIncoming
// (direct when this window exists, chatReady handshake on first open).
const log = document.getElementById('log');

// Fixed strings for every non-answer state. The widget renders what the
// vault said or a named failure — never a fabricated answer.
const FAILURES = {
  notready: "vault isn't ready on this machine yet",
  auth: 'token mismatch — re-check ~/.hazlie/secrets/hermes-token.txt',
  identity: "8789 isn't answering as hermes",
  down: 'hermes unreachable',
  error: 'something went wrong on the vault side',
};

let busy = false;

function bubble(cls, text) {
  if (document.body.classList.contains('folded')) setFolded(false);
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  placeFold();
  return el;
}

async function send(utterance) {
  utterance = String(utterance ?? '').trim().slice(0, 2000);
  if (!utterance || busy) return;
  bubble('user', utterance);
  const pending = bubble('assistant pending', '');
  // Three dots rather than a CSS pseudo-element, because the answer arrives by
  // assigning textContent — which wipes children, so the indicator removes
  // itself exactly when the reply lands, with no second cleanup to forget.
  const typing = document.createElement('span');
  typing.className = 'typing';
  // Not decoration: with an empty bubble there is nothing for a screen reader
  // to announce, and "Cancel" on the bubble is the only other cue.
  typing.setAttribute('role', 'status');
  typing.setAttribute('aria-label', 'intaglio labs is thinking');
  for (let i = 0; i < 3; i += 1) typing.appendChild(document.createElement('i'));
  pending.appendChild(typing);
  pending.title = 'Cancel';
  // Gated on THIS bubble still being pending, not just on busy: the listener
  // outlives the ask, so a click on a settled bubble during a later ask must
  // not cancel that unrelated ask.
  pending.addEventListener('click', () => {
    if (busy && pending.classList.contains('pending')) hzPost('cancel');
  });
  busy = true;
  let data;
  try {
    data = await hzPost('ask', { utterance });
  } catch {
    data = { state: 'error' };
  }
  busy = false;
  pending.classList.remove('pending');
  pending.title = '';
  if (data.state === 'ok') {
    hzSfx.receive();
    pending.textContent = data.text;
    if (Array.isArray(data.sources) && data.sources.length > 0) {
      const srcs = document.createElement('span');
      srcs.className = 'srcs';
      srcs.textContent = data.sources.join(' · ');
      // The one-sentence "why is imessage written under my answer" hint.
      // Click-toggled: native tooltips don't show over this nonactivating
      // panel, so hover-only would answer nobody.
      const WHY = 'These name the stores on this Mac the answer drew on — ' +
        'imessage means your own Messages history.';
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = '?';
      why.title = WHY;
      const tip = document.createElement('span');
      tip.className = 'src-hint';
      tip.hidden = true;
      tip.textContent = WHY;
      why.addEventListener('click', () => {
        tip.hidden = !tip.hidden;
        placeFold(); // the bubble just grew or shrank
      });
      srcs.appendChild(why);
      pending.appendChild(srcs);
      pending.appendChild(tip);
    }
  } else if (data.state === 'cancelled') {
    pending.remove();
  } else {
    pending.textContent = FAILURES[data.state] || FAILURES.error;
  }
  log.scrollTop = log.scrollHeight;
  placeFold(); // the bubble just changed size — keep the × on its corner
}

window.__hzIncoming = send;
// Voice failures arrive as fixed strings from the ear page — rendered, never
// invented here.
window.__hzVoiceNote = (message) => {
  const m = String(message ?? '').trim();
  if (m) bubble('assistant', m);
};
hzPost('chatReady').then((d) => {
  if (typeof d.pending === 'string' && d.pending.length > 0) send(d.pending);
  if (typeof d.note === 'string' && d.note.length > 0) window.__hzVoiceNote(d.note);
});

// The × beside the newest message folds the log away without closing the
// window, and hides itself with it — the × exists or nothing does. A fresh
// message unfolds everything: an answer arriving into a hidden log would
// look like silence.
function setFolded(v) {
  document.body.classList.toggle('folded', v);
  if (!v) { log.scrollTop = log.scrollHeight; placeFold(); }
}
const fold = document.getElementById('fold');
fold.addEventListener('click', () => { hzSfx.close(); setFolded(true); });

// The × keeps to the log's right edge — flush with the widget below —
// and only tracks the newest bubble vertically, riding its bottom line.
function placeFold() {
  const last = log.lastElementChild;
  if (!last) return;
  fold.style.top = `${Math.round(last.getBoundingClientRect().bottom - 22)}px`;
}
log.addEventListener('scroll', placeFold);
window.addEventListener('resize', placeFold);

// No header bar and no window close button — Escape is the way out.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hzSfx.close(); hzPost('close'); }
});

// The conversation is unbounded, so the window cannot be a fixed guess: one
// long answer used to fill the popup end to end with the question scrolled
// away above it and nothing to say so. Native clamps to the screen, and the
// log keeps its own scrollbar for whatever is past that.
hzAutoFit(document.getElementById('log'));

hzApplyPrefs();
