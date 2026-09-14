// The "do not hammer the one local model" pause between people, shared by the
// two loops that need it: hermes.mjs's runPageBuilds and sweep.mjs's
// runSweepPass. One helper rather than a copy in each file, because there WAS
// a copy in each file, both carried the same bug, and only one of them got
// found.
//
// NOT unref'd, and that is the entire point of this module existing rather
// than an inline setTimeout at each call site.
//
// An unref'd timer does not keep the event loop alive. Both callers are a
// sequence of awaits with this pause between people, so an unref'd pause
// makes the rest of the loop conditional on some UNRELATED handle happening
// to hold the loop open -- the HTTP server, in the one environment anybody
// looked at. Take that handle away and the loop drains at the first pause,
// the timer never fires, and the caller's promise stays pending forever.
// Neither caller degrades gracefully from that:
//
//   * runSweepPass never sweeps its remaining candidates, never writes the
//     terminal UPDATE that marks the run 'complete', never answers
//     sweep-once.mjs, and never runs the `finally` that clears
//     rel.sweepActive -- so every later pass skips itself with reason
//     'busy-model' against a pass that is not running.
//   * runPageBuilds never builds the rest of the batch and never resolves,
//     so startPageBuilds' own `.then` never runs: rel.pagesBuildingActive
//     stays true and every later refill queues into rel.pagesPending behind a
//     builder that has stopped.
//
// That is not hypothetical: `node --test` is exactly such an environment.
// Under Node 22 the runner holds nothing ref'd once a test's stack is parked
// on this promise, so relationship-sweep.test.mjs drained the loop at its
// first two-candidate pass and every test from that one on was cancelled with
// "Promise resolution is still pending but the event loop has already
// resolved" -- the v0.5.0 release failure. Node 24's runner does hold a ref'd
// handle, which is the only reason the identical code passed there. The bug
// was always ours; 24 was hiding it.
//
// A ref'd timer holds the process open for at most the pause, and only while
// a loop is genuinely mid-flight with committed work behind it and a person
// in front of it. Waiting one second for that is correct.
export function modelPause(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
