// Distillation is off; the episode index is not.
//
// A source scan, like bridge-capabilities.test.mjs. It exists because the two
// halves of runOnce() are easy to conflate: distillation is inference nobody can
// see the output of, and the episode rebuild is arithmetic the people panel's
// topic chips are counted from. Turning the pass off is correct. Taking the
// rebuild with it would quietly stale the one part of this pipeline the owner
// does see, and nothing would report it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(WIDGET, 'src/Distiller.swift'), 'utf8');

// The body of runOnce, where the ordering lives.
function runOnce() {
  const start = src.indexOf('private func runOnce()');
  assert.ok(start > 0, 'could not find runOnce in Distiller.swift');
  const end = src.indexOf('private func rebuildIndex', start);
  assert.ok(end > start, 'could not find the end of runOnce');
  return src.slice(start, end);
}

test('a pass is gated on an explicit opt-in, not merely on config', () => {
  assert.match(src, /distillationEnabled/u, 'the gate must exist');
  assert.match(
    src,
    /distillationEnabled:\s*Bool\s*\{\s*fm\.fileExists/u,
    'and be answered by a file on disk, so it can be turned on without a rebuild'
  );
  assert.match(runOnce(), /guard\s+self\.distillationEnabled\s+else/u, 'runOnce must check it');
});

// THE ORDERING IS THE POINT. The rebuild has to happen before the gate returns,
// or the chips go stale the moment distillation is switched off.
test('the episode index is rebuilt whether or not a pass runs', () => {
  const body = runOnce();
  const rebuildAt = body.indexOf('rebuildIndex {');
  const gateAt = body.indexOf('distillationEnabled');
  assert.ok(rebuildAt > 0, 'runOnce must still ask for a rebuild');
  assert.ok(gateAt > rebuildAt,
    'the gate must sit INSIDE the rebuild completion, not before it — otherwise ' +
    'switching distillation off also stops the index the topic chips are counted from');
});

test('being off still schedules another look, so it resumes when re-enabled', () => {
  const body = runOnce();
  const gate = body.slice(body.indexOf('guard self.distillationEnabled'));
  assert.match(gate.slice(0, 400), /schedule\(after:/u,
    'the disabled arm must reschedule, or re-enabling needs an app restart');
});

test('the reason and the way back are recorded where somebody will find them', () => {
  assert.match(src, /distill\.enabled/u, 'the marker path must be named in the source');
  assert.match(src, /Create .*enableMarker.*to re-enable/u, 'and printed in the log line');
  // The "why", not just the "what": a switch with no reason gets flipped back.
  assert.match(src, /v_claim_accepted/u, 'the comment must say why nothing can answer yet');
});
