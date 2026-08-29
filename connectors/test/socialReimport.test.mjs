import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPendingSocialReimport,
  CONNECTOR_HERMES_SOURCE,
} from '../daemon.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'intaglio-social-reimport-'));
  const connectors = join(home, '.hazlie', 'connectors');
  const cacheDir = join(home, '.hazlie', 'cache');
  mkdirSync(connectors, { recursive: true, mode: 0o700 });
  mkdirSync(join(cacheDir, 'matrix'), { recursive: true, mode: 0o700 });
  const pendingPath = join(connectors, 'social-reimport-v1.pending');
  const completedPath = join(connectors, 'social-reimport-v1.completed');
  writeFileSync(pendingPath, '', { mode: 0o600 });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { cacheDir, pendingPath, completedPath };
}

test('a pending social reimport purges every platform before wiping Matrix cursors', async (t) => {
  const paths = fixture(t);
  const calls = [];
  const state = {
    deleteCursors(name) {
      assert.equal(name, 'matrix');
      calls.push('local:matrix');
      return 4;
    },
  };

  const result = await applyPendingSocialReimport({
    ...paths,
    state,
    purge: async ({ source }) => {
      calls.push(source);
      return { deleted: 2 };
    },
  });

  assert.deepEqual(calls, [...CONNECTOR_HERMES_SOURCE.matrix, 'local:matrix']);
  assert.deepEqual(result, {
    applied: true,
    deleted: CONNECTOR_HERMES_SOURCE.matrix.length * 2,
    cursorsDeleted: 4,
  });
  assert.equal(existsSync(paths.pendingPath), false);
  assert.equal(existsSync(paths.completedPath), true);
  assert.equal(existsSync(join(paths.cacheDir, 'matrix')), false);
});

test('an interrupted social purge keeps the pending marker and Matrix cursors for retry', async (t) => {
  const paths = fixture(t);
  let cursorWipes = 0;
  const state = {
    deleteCursors() {
      cursorWipes += 1;
      return 1;
    },
  };

  await assert.rejects(
    applyPendingSocialReimport({
      ...paths,
      state,
      purge: async ({ source }) => {
        if (source === 'twitter') throw new Error('temporary Hermes failure');
        return { deleted: 1 };
      },
    }),
    /temporary Hermes failure/u,
  );

  assert.equal(cursorWipes, 0);
  assert.equal(existsSync(paths.pendingPath), true);
  assert.equal(existsSync(paths.completedPath), false);
  assert.equal(existsSync(join(paths.cacheDir, 'matrix')), true);
});

test('no social reimport marker is a strict no-op', async (t) => {
  const paths = fixture(t);
  rmSync(paths.pendingPath);
  const result = await applyPendingSocialReimport({
    ...paths,
    state: { deleteCursors: () => assert.fail('must not wipe cursors') },
    purge: () => assert.fail('must not purge'),
  });
  assert.deepEqual(result, { applied: false });
});
