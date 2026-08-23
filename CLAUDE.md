# CLAUDE.md

Rules for working in this repository. Read this before the code.

## What this is

A private personal AI that runs entirely on one Mac. It reads the owner's own
calendar, mail, messages, notes, photos, files and health data into a local
SQLite store, and answers questions about them using a model running on the same
machine. No account, no server, no telemetry.

The parts:

- `connectors/` — reads local Apple stores and approved remote APIs, ships rows
  to hermes. Never writes the context DB directly.
- `ui/server/` — **hermes**, the local HTTP service. Sole writer and sole
  deleter of the context store.
- `connect/` — the local, token-gated onboarding page for linking sources.
- `widget/` — the macOS app (Swift) and its voice pipeline.
- `bridges/` — Docker compose for optional chat bridges (Matrix + mautrix).
- `ops/` — probes, runbooks, and `EGRESS.json`.

**`connectors/AGENTS.md` and `ui/AGENTS.md` are binding and more specific than
this file.** Read the one for the directory you are editing. Where they and this
file disagree, they win.

## What is deliberately not here

Do not re-add these; their absence is a decision, not an oversight.

- **Any always-on audio capture, diarization, or microphone array work.** The
  household-rig track was dropped in 2026-08. If you find a comment describing
  it, the comment is stale — fix the comment.
- **Any lane that sends messages or data between two machines** — no tunnel, no
  courier, no outbound iMessage. The app does not text its user.
- **The website and deploy config.** They live in a separate private repo.
- **Experiment code, results, and planning docs.**

## Rules that bind everything

1. **Never fabricate.** No mocked metrics, no illustrative numbers, no example
   output that could be read as a measurement. If it doesn't run, say so. If you
   didn't measure it, don't state it.

2. **Documentation describes the code, not our intentions for it.** When a
   comment, README, or policy contradicts what the code does, **fix the text.**
   Changing shipped behaviour to rescue a sentence means the sentence was never
   describing the product. Correct stale comments in place with the history kept
   — a stale comment that reads as authority does more damage than a missing one.

3. **Nothing leaves the box, and the list is enforced.** Every host this software
   may contact is enumerated in `ops/EGRESS.json`, and
   `connectors/test/egress.test.mjs` fails the suite on any undeclared host found
   in tracked source. That is a tripwire, not a document. If you add a network
   call, declare it there with a real justification, or the build stops.

4. **Logs never carry row content.** The logger refuses fields named like message
   content. Counts, timings, IDs and error types only. This holds for probes too.

5. **Ask before touching a connected account.** Reading the owner's own store is
   the job; mutating a remote account is not, and no source may send, post, mark
   read, or act as the owner.

6. **This repository is public. Owner data must never land in it.** Not in code,
   not in tests, not in docs, not in a commit message. Real phone numbers and
   per-contact message counts were scrubbed out of `ops/PROBES.md` and a test
   fixture once already — they read as technical detail and no credential scanner
   would have caught them. When a probe or a finding needs a number, describe the
   shape, not the value.

7. **Verify before reporting.** Grepping an entry point for a check implemented in
   its helper module is not evidence the check is missing — run it. "Nothing
   references this" is the condition under which broken code hides, not proof that
   a file is safe to delete.

## Wire contracts

Some strings are load-bearing across a process boundary and cannot be
"improved":

- **`GET /health` returns exactly `{"ok":true}`.** The shipped, notarized app
  string-compares this body. Adding a field breaks installed copies. There is a
  comment saying so at the handler; believe it.
- **The canonical hermes port is `51789`** (connect `51788`, llama `51780`).
  It was 8789, moved 2026-08-23, and the reasoning is the same one that moved it
  off 8787 taken one step further: 8787 was chosen against, because an unrelated
  dev server commonly answers 200 there and once caused a row to be POSTed at a
  stranger — but 8788/8789 sit in the same neighbourhood, and llama was on
  **8080**, which is the single most squatted port on a developer's machine.
  The three now sit in the IANA dynamic range (49152–65535) where nothing is
  registered, keeping their last two digits so a log line still reads as the
  service you expect. Liveness is still not identity: `verifyHermesIdentity`
  checks the exact `/health` body before any row is sent, and that is what
  actually protects against a stranger — the port choice only makes the
  collision rare instead of likely.

## Consent, stated precisely

The owner's instruction for the reference install was to proceed over everything
the system is pointed at, including Apple's face and person clusters — that is
**an owner instruction and an acceptance of risk, not a record that consent was
obtained** from the third parties in that data. Nobody can grant consent on
behalf of the people in someone's photo library.

That decision was made for one machine in one household. **It does not transfer
to anyone who downloads this.** Each install is its own decision by its own
owner, and the third parties in their corpus never made it either. Treat that as
a live design constraint rather than a settled question, and keep the biometric
exposure in view: persistent cross-session speaker identity is a voiceprint, and
voiceprints are biometric identifiers under statutes with a private right of
action.

What no consent decision reaches: rules 1 and 2 above. Those govern the integrity
of what gets recorded, not permission to read it.

## Running things

    node --test "connectors/test/*.test.mjs" "ui/test/*.test.mjs" \
                "connect/test/*.test.mjs" "widget/test/*.test.mjs"
    node connectors/doctor.mjs          # preflight; --json for machine output
    npm install                          # in connectors/ — imapflow et al.

`widget/test/` was missing from that line until 2026-08-23, and README.md had it
all along — so the suite that checks the app's contract with hermes, and the two
that check its bridge compartments and its CSP, ran only for whoever read the
other file. A test nobody runs is a test that does not exist. It is hermetic and
needs no Swift toolchain: every file there is a source scan or starts its own
hermes on port 0.

Two things that will waste your time otherwise:

- **`npm install` is per-directory.** Without it in `connectors/`, two tests fail
  on a missing `imapflow` and look like code bugs. They aren't.
- **Full Disk Access is granted per resolved binary, and macOS attributes it to
  the responsible process.** `fda-*` checks failing from a dev shell is the
  expected result and proves nothing about production; only a launchd-spawned run
  does. Each failing row prints the `launchctl submit` line that gives the real
  answer.

## Deployment hazard worth knowing

The launchd plists name a **path**, never a commit. Whatever is on disk at
restart is what a privileged daemon executes — under Full Disk Access, against
the owner's real data — with no integrity check and no log line saying the code
changed underneath it.

So: **never point a plist at a working tree that anyone might `git checkout`.**
Run production from a tree reserved for it, or better, from an immutable
artifact. This is currently unsolved rather than solved; a startup assertion that
`git rev-parse HEAD` matches a pinned value would at least make drift loud, and
`connectors/lib/checks.mjs` already has the startup-gate machinery to hang it on.

## Conventions

- Node builtins over dependencies. A new dependency needs a reason that survives
  being written down.
- `node --test`. Tests are hermetic: port 0, `mkdtemp`, no shared state.
- Secrets are `0600` inside a `0700` `~/.hazlie/`. Never in the repo, never in a
  log, never in an error message.
- **Comments say why, not what.** The valuable ones record a measurement, a
  decision and who made it, or a trap someone already fell into. When a decision
  is reversed, keep the old reasoning struck through rather than deleting it —
  several comments in this tree exist because a reader re-derived a wrong
  conclusion that had already been disproven once.
- Commit messages carry the discovery, not just the change.
