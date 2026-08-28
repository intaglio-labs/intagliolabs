import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONNECTORS = join(dirname(fileURLToPath(import.meta.url)), '..');
const setup = readFileSync(join(CONNECTORS, '..', 'ops', 'setup-connectors.sh'), 'utf8');

test('connector setup sends Gmail to OAuth and never asks for an app password', () => {
  assert.doesNotMatch(setup, /gmail-app-password|GMAIL_APP_PASSWORD|apppasswords/u);
  assert.match(setup, /Connections shelf/u);
  assert.match(setup, /ops\/gcal-auth\.mjs/u);
});
