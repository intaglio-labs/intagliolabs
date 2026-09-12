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

// ~~"finishing onboarding closes the scrim and opens People"~~. The flow ends
// on the reconnect card now, which is the thing it spent six screens getting
// ready to show: the last screen watches the first load and hands over the
// moment a real card is waiting. Landing on People instead would put a
// directory in front of somebody who was promised one person a day.
test('finishing onboarding closes the scrim and opens the card', () => {
  assert.match(main, /if Bridge\.needsOnboarding \{[\s\S]*openOnboarding\(resume: true\)/u,
    'a first launch enters onboarding automatically');
  const finish = /function finish\(\) \{([\s\S]*?)\n\}/u.exec(onboarding)?.[1] ?? '';
  // onboardingDone BEFORE close: if the window goes first the page can be torn
  // down mid-message and the whole flow reappears on the next launch.
  assert.match(finish, /hzPost\('onboardingDone'\)/u);
  assert.match(finish, /hzPost\('close'\)[\s\S]*hzPost\('openReconnect'\)/u);
  assert.doesNotMatch(onboarding, /hzPost\('openPeople'\)/u,
    'and the People popup is no longer the destination');
});
