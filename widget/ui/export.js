'use strict';
// THE EXPORT OFFER PANEL.
//
// One file, one question, two answers. The page names no file of its own: it
// asks native what is being offered and answers about that, so the only thing
// it can ever accept is the archive it was shown.
//
// WHY IT EXISTS AT ALL. The watcher's offer was a system notification and
// nothing else, and on the Mac this was walked on it produced nothing: three
// archives found, three offers written to defaults, no banner before or after
// the owner allowed notifications, nothing in the system log. The banner is
// still sent, for the Macs that show one. This is the half that cannot fail
// invisibly, because this app draws it.

const el = (id) => document.getElementById(id);

function fit() {
  requestAnimationFrame(() => {
    const win = document.querySelector('.win');
    hzPost('fitContent', { height: Math.ceil(win.scrollHeight) }).catch(() => {});
  });
}

// WHAT WENT WRONG, in the same words the settings row uses. A press that
// silently does nothing is the failure this whole panel was built to stop
// repeating, so every branch native can answer with has a sentence.
const RESULTS = {
  'zip-connections': 'there is no Connections.csv anywhere in that archive — tick '
    + '"connections" when you request the export and it will be in the next one.',
  zip: "i couldn't open that zip.",
  columns: "i don't recognise that file's columns — i can only read the english export.",
  newer: 'you already have a newer export — i kept the one you have.',
  duplicate: 'there are two of those — open settings and choose one.',
};

function done(line) {
  el('exFile').textContent = '';
  el('exWhere').textContent = '';
  el('exLead').textContent = line;
  el('exTake').hidden = true;
  el('exSkip').textContent = 'close';
  fit();
}

// THREE ANSWERS. `true` imports, `false` is "not this one", and `null` is the
// ✕ -- "not now", which closes the panel and takes the gear glow back while
// leaving the archive re-offerable when the owner next comes back to the app.
//
// ~~The ✕ posted `close` alone~~, so native never heard a verdict: the pending
// offer stayed set, the export errand was never taken back, and the gear glowed
// for the rest of the session over an offer nothing could re-present. A close
// box that silently strands a surface is worse than no close box.
function decide(take) {
  el('exTake').disabled = true;
  el('exSkip').disabled = true;
  hzPost('exportDecide', take === null ? {} : { take })
    .then((out) => {
      if (!take || out?.taken !== true) { hzPost('close').catch(() => {}); return; }
      if (out.result === 'ok') {
        const n = Number(out.connections || 0);
        done(n > 0 ? `${n.toLocaleString()} connections imported.` : 'imported.');
        // IT WORKED, SO IT GOES AWAY. Long enough to read the count, and no
        // longer: an offer the owner has answered is a panel in the way. Only
        // on this branch — the failure below is the one place they can read why
        // their press did nothing, and a panel that closes itself over that is
        // the bug this whole panel exists to stop repeating.
        setTimeout(() => hzPost('close').catch(() => {}), 3000);
        return;
      }
      // NOT CLOSED ON A FAILURE. The owner pressed import and something did not
      // work; closing the only surface that knows why is how a press becomes
      // "nothing happened" again.
      el('exSkip').disabled = false;
      done(RESULTS[out.reason] ?? "i couldn't read that file.");
    })
    .catch(() => {
      el('exSkip').disabled = false;
      done("i couldn't read that file.");
    });
}

function paint(out) {
  // An offer that is no longer there — answered from the notification, or the
  // export installed some other way while this panel was opening. Nothing to
  // ask about, so nothing is asked.
  if (!out || typeof out.name !== 'string' || out.name === '') {
    hzPost('close').catch(() => {});
    return;
  }
  el('exFile').textContent = out.name;
  const folder = typeof out.folder === 'string' && out.folder ? out.folder : '';
  const dated = typeof out.dated === 'string' && out.dated ? out.dated : '';
  // "in Downloads, today". Both halves are facts the owner needs to recognise
  // their own download: a year-old archive imports exactly as readily as this
  // morning's, and the connector would take that year-old graph as current.
  el('exWhere').textContent = [folder && `in ${folder}`, dated].filter(Boolean).join(', ');
  fit();
}

el('exTake').addEventListener('click', () => decide(true));
el('exSkip').addEventListener('click', () => {
  // A press on "close" after an answer is just a close; before one it is a
  // verdict, and the verdict spends the offer.
  if (el('exTake').hidden) { hzPost('close').catch(() => {}); return; }
  decide(false);
});
el('exClose').addEventListener('click', () => decide(null));

// Native pokes this when it re-shows the panel for a new offer, the way the
// reconnect card refetches on every show: a panel that survived hidden must
// never come back describing the last file.
window.__hzExportShow = () => {
  el('exLead').textContent = 'found your linkedin export';
  el('exTake').hidden = false;
  el('exTake').disabled = false;
  el('exSkip').disabled = false;
  el('exSkip').textContent = 'not this one';
  hzPost('exportOffer').then(paint).catch(() => {});
};

window.__hzExportShow();
