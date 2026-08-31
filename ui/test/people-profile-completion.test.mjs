import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { start } from '../server/hermes.mjs';

const TOKEN = 'a'.repeat(64);
const LLAMA_KEY = 'b'.repeat(64);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('People year completion builds profiles without generating summaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'people-profile-completion-'));
  const dbPath = join(dir, 'context.db');
  const legacySummaryFiles = [
    `${dbPath}.people-summaries`,
    `${dbPath}.people-summaries-wal`,
    `${dbPath}.people-summaries-shm`,
  ];
  for (const path of legacySummaryFiles) writeFileSync(path, 'retired derived data');
  const running = await start({
    port: 0,
    dbPath,
    bearerToken: TOKEN,
    llamaApiKey: LLAMA_KEY,
  });
  try {
    for (const path of legacySummaryFiles) assert.equal(existsSync(path), false);
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    };
    const year = new Date().getFullYear();
    const completion = await fetch(
      `http://127.0.0.1:${running.port}/admin/people/complete-year`,
      { method: 'POST', headers, body: JSON.stringify({ year }) }
    );
    assert.equal(completion.status, 200);
    assert.deepEqual(await completion.json(), {
      year,
      profiles: 0,
      complete: true,
      state: 'complete',
    });

    const removed = await fetch(`http://127.0.0.1:${running.port}/people/summary`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'person', year }),
    });
    assert.equal(removed.status, 404);
  } finally {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the People page has no summary request capability', () => {
  const page = readFileSync(join(REPO, 'widget', 'ui', 'people-months.js'), 'utf8');
  const bridge = readFileSync(join(REPO, 'widget', 'src', 'Bridge.swift'), 'utf8');
  assert.doesNotMatch(page, /peopleSummary|requestSummary|summaryProgress/u);
  assert.doesNotMatch(bridge, /peopleSummary|people\/summary/u);
});
