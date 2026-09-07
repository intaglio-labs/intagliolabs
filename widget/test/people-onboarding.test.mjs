// The People popup is the first real surface after onboarding: completing the
// welcome must not leave someone hunting for the screen it just introduced.
//
// The ring-position and Messages-nudge tests that used to live here were
// retired 2026-09-07 with the ring landing itself (owner: "wtf is this image?
// fix this") — the popup no longer renders per-connector tiles at all, so
// PEOPLE_ANCHORS/anchorRank and the p-imessage-nudge hop no longer exist to
// pin. See widget/ui/people.js and people.html for the header + status-line
// replacement.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const onboarding = readFileSync(join(WIDGET, 'ui', 'onboarding.js'), 'utf8');
const main = readFileSync(join(WIDGET, 'src', 'main.swift'), 'utf8');

test('finishing onboarding closes the scrim and opens People', () => {
  assert.match(main, /if Bridge\.needsOnboarding \{[\s\S]*openOnboarding\(resume: true\)/u,
    'a first launch enters onboarding automatically');
  const finish = /function finish\(\) \{([\s\S]*?)\n\}/u.exec(onboarding)?.[1] ?? '';
  assert.match(finish, /hzPost\('onboardingDone'\)/u);
  assert.match(finish, /hzPost\('close'\)[\s\S]*hzPost\('openPeople'\)/u);
});
