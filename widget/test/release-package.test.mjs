import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = readFileSync(join(WIDGET, 'release.sh'), 'utf8');

test('packaging renders the Finder background outside the tracked source tree', () => {
  assert.match(release, /BG="\$DIST\/dmg-bg\.png"/u);
  assert.match(release, /make-dmg-bg\.swift "\$BG"/u);
  assert.doesNotMatch(
    release,
    /make-dmg-bg\.swift\s+icon\/dmg-bg\.png/u,
    'a release must not dirty its checkout after the provenance guard runs',
  );
});
