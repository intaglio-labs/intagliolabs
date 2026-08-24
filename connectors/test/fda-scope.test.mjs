import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionChecks, loadSources } from '../daemon.mjs';

const fail = (name) => ({ name, status: 'FAIL', detail: 'd', fix: 'f' });
const pass = (name) => ({ name, status: 'PASS' });
const warn = (name) => ({ name, status: 'WARN' });

// THE BUG THIS PINS. Three unchecked Full Disk Access boxes used to abort the
// whole daemon, so `granola`, `mail`, `notion`, `oura`, `linkedin`, `files` and
// `whatsapp` — none of which touch anything TCC protects — ingested nothing
// because of a permission they do not use.
test('a missing FDA grant never stops the daemon', () => {
  const { fatal, fdaBlocked } = partitionChecks([
    fail('fda-imessage'), fail('fda-calendar'), fail('fda-contacts'), pass('hermes-health'),
  ]);
  assert.deepEqual(fatal, [], 'no FDA failure is fatal on its own');
  // fdaBlocked names the sources whose grant is missing so the log can list
  // them. It is advisory: these sources still run and still probe for
  // themselves — see the preflight note in daemon.mjs.
  assert.deepEqual([...fdaBlocked].sort(), ['calendar', 'contacts', 'imessage']);
});

// The other half: a broken foundation still stops it dead. WARN is "not
// provisioned yet" in the checks module's own semantics and is not a failure.
test('a broken foundation is still fatal, and WARN is not a failure', () => {
  const { fatal, fdaBlocked } = partitionChecks([
    fail('hermes-health'), fail('fda-imessage'), warn('secret-granola'),
  ]);
  assert.deepEqual(fatal.map((r) => r.name), ['hermes-health']);
  assert.deepEqual([...fdaBlocked], ['imessage'], 'the advisory list is still reported alongside');
});

test('an all-clear blocks nothing', () => {
  const { fatal, fdaBlocked } = partitionChecks([pass('fda-imessage'), pass('hermes-health')]);
  assert.deepEqual(fatal, []);
  assert.equal(fdaBlocked.size, 0);
});

test('junk in the result list does not take the daemon down', () => {
  assert.deepEqual(partitionChecks(null).fatal, []);
  const { fatal } = partitionChecks([null, { status: 'FAIL' }, fail('hermes-health')]);
  assert.deepEqual(fatal.map((r) => r.name), [undefined, 'hermes-health'],
    'a nameless failure is foundational, because it cannot be proven to be a source gate');
});

// The mapping is a naming convention, so it is only true while the names line
// up. If a source is renamed and its check is not, the gate silently stops
// matching and that source runs without its grant.
test('every fda- check names a real source', async () => {
  const names = new Set((await loadSources()).map((s) => s.name));
  for (const check of ['fda-imessage', 'fda-calendar', 'fda-contacts']) {
    const { fdaBlocked } = partitionChecks([fail(check)]);
    const [source] = [...fdaBlocked];
    assert.ok(names.has(source), `${check} maps to "${source}", which is not a loaded source`);
  }
});
