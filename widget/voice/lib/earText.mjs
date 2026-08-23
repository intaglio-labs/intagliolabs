// Pure text logic for the ear: utterance accumulation over Moonshine's
// partial/commit stream. No DOM, no audio, no deps, so node:test can cover
// it (test/earText.test.mjs).
//
// Moonshine in streaming mode emits rapid speculative partials, then a
// "commit" that supersedes them when it hears a pause -- so one utterance is
// zero or more committed segments plus one live partial. The tracker keeps
// sealed segments and the live partial separately so a commit can supersede
// speculative text without losing what was already sealed.

export function tokenize(text) {
  if (text == null) return [];
  return String(text).trim().split(/\s+/).filter(Boolean);
}

export function createUtteranceTracker() {
  let sealed = []; // tokens from committed segments, in order
  let current = []; // tokens of the live partial, replaced wholesale

  const all = () => sealed.concat(current);

  return {
    // A fresh speculative transcript for the in-flight segment.
    updatePartial(text) {
      current = tokenize(text);
    },

    // The segment's committed transcript supersedes its partials. An empty
    // commit seals whatever the last partial held rather than losing it.
    sealCommit(text) {
      const tokens = tokenize(text);
      if (tokens.length) current = tokens;
      sealed = sealed.concat(current);
      current = [];
    },

    // The command text so far, live -- feeds each onWake/onPartial update.
    commandSoFar() {
      return all().join(' ');
    },

    // The endpoint transcript: the full utterance.
    finalize() {
      return all().join(' ');
    },

    reset() {
      sealed = [];
      current = [];
    },
  };
}
