// WHAT AN AUTHORIZATION HELPER SAID, AND HOW MUCH OF IT MAY BE REPEATED.
//
// connect spawns ops/gcal-auth.mjs and, when no URL comes back, has to tell the
// owner why. The helper already knows why: every deliberate diagnostic in that
// file goes through fail(), which prints `gcal-auth: <message>` on stderr and
// exits. Discarding that stream left connect guessing, and its guess named the
// one cause the owner had already ruled out -- "check that the Google client
// credential is installed", about a credential that is installed and merely
// 0644 (round-6 finding 4).
//
// So the stream is read. What comes back is shown to a person, which makes the
// rule about WHAT MAY BE REPEATED load-bearing rather than tidy:
//
//   THE PREFIX IS THE PERMISSION. `gcal-auth: ` marks text that file wrote for
//   an owner to read, and its header is explicit that no credential value is
//   ever interpolated into one. Text without it is node's -- a stack, a
//   warning -- written for nobody, and naming paths nobody chose to publish.
//
//   THE MESSAGE ENDS AT THE FIRST UNINDENTED LINE (round-7 finding 4). Slicing
//   to the end of the buffer dropped everything BEFORE the last prefix and kept
//   everything after it, which is the opposite of the rule above: fail() calls
//   process.exit(1) and node can still flush on the way out (a lazily emitted
//   process warning, an unhandled-rejection report, the `(Use \`node
//   --trace-warnings ...\`)` tail), and all of it was glued onto the sentence
//   the onboarding screen paints. Every multi-line fail() in gcal-auth.mjs
//   indents its continuation lines by two spaces -- the registration hint, the
//   redirect_uri_mismatch note, the revoke-and-rerun note -- and node's output
//   starts at column zero. That indentation is the only thing on this stream
//   that tells the helper's own words from everything else, so it is what the
//   message ends on.
//
// The LAST prefixed line, because fail() is the last thing the helper does.
// Whitespace is collapsed: those messages are laid out for a terminal and this
// one is going into a single line on a screen. Capped, because a diagnostic
// that runs past a few hundred characters is not being read by anyone.
export const HELPER_PREFIX = 'gcal-auth: ';
const MAX_LENGTH = 400;

export function helperDiagnostic(stderr) {
  const text = typeof stderr === 'string' ? stderr : '';
  // THE PREFIX ONLY COUNTS AT THE START OF A LINE (round-8 finding 6).
  //
  // Searched across the whole buffer, any unprefixed line that merely CONTAINS
  // `gcal-auth: ` opened the quote -- and node hands out exactly that shape:
  //
  //   Error: ENOENT: no such file or directory, open gcal-auth: /Users/…json
  //       at Object.readFileSync (node:fs:…)
  //
  // The match landed inside that error's own message, and node's stack frames
  // are indented, so the continuation rule below then quoted them too: the
  // absolute path to the owner's credential plus two frames of internals, onto
  // their screen. Precisely what "the prefix is the permission" forbids.
  // console.error writes its own line, so a real diagnostic always starts at
  // column zero and nothing of the helper's is lost by insisting on it.
  const lines = text.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(HELPER_PREFIX)) { at = i; break; }
  }
  if (at === -1) return null;
  const said = [lines[at].slice(HELPER_PREFIX.length)];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s+\S/u.test(line)) break; // node starts at column zero
    said.push(line);
  }
  const message = said.join(' ').replace(/\s+/gu, ' ').trim();
  return message === '' ? null : message.slice(0, MAX_LENGTH);
}
