'use strict';
// The chat window has no input of its own: the widget's always-present
// message bar is the single way in. Messages arrive via __hzIncoming
// (direct when this window exists, chatReady handshake on first open).
const log = document.getElementById('log');

// Fixed strings for every non-answer state. The widget renders what the
// vault said or a named failure — never a fabricated answer.
// Fixed strings for every non-answer state. The widget renders what the vault
// said or a named failure -- never a fabricated answer.
//
// WRITTEN FOR THE PERSON READING THEM, not for whoever wrote the service. These
// used to name a secrets path, a port number and the service's internal name;
// none of those is actionable by someone who installed an app, and a file path
// in an error is an invitation to go editing it. What IS actionable is whether
// to wait, reopen, or reinstall, so each line says which.
const FAILURES = {
  notready: "memory isn't ready yet — give it a moment and try again",
  auth: 'intaglio labs could not unlock its own memory. Quitting and reopening usually fixes it.',
  identity: 'something else is using the port this app needs',
  down: "memory isn't running — quit and reopen to restart it",
  error: 'something went wrong on this app’s side',
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

// `echo` is false when the question is being asked AGAIN on the owner's behalf —
// after confirming a claim that would have answered it. The question is already
// on screen; repeating the bubble would make it look like they asked twice.
async function send(utterance, { echo = true } = {}) {
  utterance = String(utterance ?? '').trim().slice(0, 2000);
  if (!utterance || busy) return;
  clearNote();
  if (echo) bubble('user', utterance);
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
  pending.addEventListener('click', () => { if (busy) hzPost('cancel'); });
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
    // AN EMPTY ANSWER WHILE STILL READING IS A DIFFERENT ANSWER.
    //
    // Answers come from claims the local model has distilled out of the rows,
    // and that takes a while after connecting. Left alone, the reply is "nothing
    // in what i've got covers that" over a database that is 99% unread — which
    // reads as broken rather than busy, and is the single most confusing thing
    // this app can say. Native attaches the reading state to a sourceless
    // answer; this is where it becomes a sentence.
    // ASK AT THE POINT OF USE.
    //
    // Something already read WOULD have answered this, if anyone had confirmed
    // it. That is worth one question here, with the thing that needed it still on
    // screen — and it is the alternative to a queue of a hundred confirmations
    // nobody works through. One claim, its own words, and the quote it came from.
    //
    // Nothing is accepted by showing it. The press is the decision, and a reject
    // is remembered so the same claim is never raised again.
    const confirm = data.confirm;
    if (confirm && typeof confirm.text === 'string' && Number.isInteger(confirm.id)) {
      pending.appendChild(confirmCard(confirm, utterance));
      log.scrollTop = log.scrollHeight;
      return;
    }
    const mem = data.memory;
    if (mem && mem.state === 'reading' && mem.total > 0) {
      const note = document.createElement('span');
      note.className = 'srcs';
      note.textContent =
        `still reading — ${mem.done.toLocaleString()} of ${mem.total.toLocaleString()} so far`;
      pending.appendChild(note);
    }
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
// A NOTE REPLACES THE LAST NOTE. It does not stack.
//
// This used to call bubble() straight through, so every press of WAKE on a
// machine without voice appended another identical line: three presses, three
// copies of the same sentence filling the window. A note is a statement about
// the CURRENT state of the app, not an event in the conversation -- there is
// only ever one true answer to "why did nothing happen", so there should only
// ever be one line saying it.
//
// Kept distinct from real messages: an assistant ANSWER is part of the log and
// must never be silently replaced, so notes carry their own class and only
// ever overwrite each other.
let noteEl = null;
window.__hzVoiceNote = (message) => {
  const m = String(message ?? '').trim();
  if (!m) return;
  if (noteEl && noteEl.isConnected) {
    if (noteEl.textContent === m) return; // identical: nothing changed, say nothing
    noteEl.textContent = m;
    if (document.body.classList.contains('folded')) setFolded(false);
    log.scrollTop = log.scrollHeight;
    placeFold();
    return;
  }
  noteEl = bubble('assistant note', m);
};

// A real message clears the note: it was about why nothing happened, and
// something just did.
function clearNote() {
  if (noteEl && noteEl.isConnected) noteEl.remove();
  noteEl = null;
}
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

// The point-of-use confirmation card. Deliberately small: a claim, the words it
// came from, and two buttons. No confidence number and no source chip — this is a
// yes/no about one sentence, and everything else is decoration on a decision.
function confirmCard(claim, utterance) {
  const box = document.createElement('span');
  box.className = 'confirm';

  const lead = document.createElement('span');
  lead.className = 'confirm-lead';
  lead.textContent = 'i think i read this — is it right?';

  const text = document.createElement('span');
  text.className = 'confirm-text';
  text.textContent = claim.text;

  box.append(lead, text);

  // THE QUOTE IS THE POINT, same as the review page. A claim without the words it
  // came from cannot be judged, only guessed at.
  if (typeof claim.quote === 'string' && claim.quote.trim()) {
    const q = document.createElement('span');
    q.className = 'confirm-quote';
    q.textContent = `“${claim.quote.trim()}”`;
    box.appendChild(q);
  }

  const row = document.createElement('span');
  row.className = 'confirm-row';
  const decide = (action, label) => {
    const b = document.createElement('button');
    b.className = action === 'accept' ? 'confirm-yes' : 'confirm-no';
    b.textContent = label;
    b.addEventListener('click', async () => {
      for (const el of row.querySelectorAll('button')) el.disabled = true;
      const res = await hzPost('decideClaim', { id: claim.id, action }).catch(() => null);
      if (!res || res.state !== 'ok') {
        lead.textContent = "couldn't save that — try again";
        for (const el of row.querySelectorAll('button')) el.disabled = false;
        return;
      }
      box.classList.add('done');
      row.remove();
      lead.textContent = action === 'accept' ? 'got it — i will remember that' : 'ok, forgotten';
      // Accepted means the question that raised it can now be answered, so answer
      // it. Rejecting leaves the abstention standing, which was already true.
      if (action === 'accept' && typeof utterance === 'string' && utterance) {
        send(utterance, { echo: false });
      }
    });
    return b;
  };
  row.append(decide('accept', 'yes'), decide('reject', 'no'));
  box.appendChild(row);
  return box;
}
