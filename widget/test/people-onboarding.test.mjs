// The People popup is the first real surface after onboarding. Its spatial
// order and handoff are product behavior: a status sort must not rotate the
// three primary local sources away, and completing the welcome must not leave
// someone hunting for the screen it just introduced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const people = readFileSync(join(WIDGET, 'ui', 'people.js'), 'utf8');
const onboarding = readFileSync(join(WIDGET, 'ui', 'onboarding.js'), 'utf8');
const main = readFileSync(join(WIDGET, 'src', 'main.swift'), 'utf8');

test('Messages, Contacts, and Calendar own the top-clockwise ring positions', () => {
  assert.match(people, /const PEOPLE_ANCHORS = \['imessage', 'contacts', 'calendar'\]/u);
  assert.match(people, /anchorRank\(a\.s\) - anchorRank\(b\.s\)/u);
});

test('Messages is emphasized for onboarding or an empty connector set', () => {
  assert.match(people, /onboardingAttention \|\| !visible\.some\(\(s\) => s\.connected\)/u);
  assert.match(people, /classList\.add\('p-imessage-nudge'\)/u);
});

test('finishing onboarding closes the scrim and opens People', () => {
  assert.match(main, /if Bridge\.needsOnboarding \{[\s\S]*openOnboarding\(resume: true\)/u,
    'a first launch enters onboarding automatically');
  const finish = /function finish\(\) \{([\s\S]*?)\n\}/u.exec(onboarding)?.[1] ?? '';
  assert.match(finish, /hzPost\('onboardingDone'\)/u);
  assert.match(finish, /hzPost\('close'\)[\s\S]*hzPost\('openPeople'\)/u);
});
