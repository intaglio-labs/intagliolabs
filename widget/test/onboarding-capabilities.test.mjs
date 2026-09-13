// THE ONBOARDING COMPARTMENT, BOTH WAYS.
//
// bridge-capabilities.test.mjs already checks that no page calls an action its
// compartment forbids. This file checks the other direction for the one page
// whose list has drifted before: no verb may be GRANTED to onboarding that
// onboarding does not call.
//
// That direction matters because a stale grant is silent. When the model tier
// picker was retired, its screen left the DOM and its code was left behind a
// dead `if`, and the verbs it used stayed in the compartment for weeks — a
// widened surface on the one page that runs before the owner has agreed to
// anything, defended by nobody, visible in no test. Onboarding is also the
// page that can write the privacy switch, open System Settings, and start the
// reader, so an extra entry here is not a tidiness question.
//
// One exception is allowed and it has to be named here, with a reason.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = join(dirname(fileURLToPath(import.meta.url)), '..');
const swift = readFileSync(join(WIDGET, 'src', 'Bridge.swift'), 'utf8');
const js = readFileSync(join(WIDGET, 'ui', 'onboarding.js'), 'utf8');
const html = readFileSync(join(WIDGET, 'ui', 'onboarding.html'), 'utf8');

// Actions every page may call without a grant; they are not this page's.
const sharedBlock = /static let sharedActions: Set<String> = \[([\s\S]*?)\]/u.exec(swift);
const shared = new Set([...sharedBlock[1].matchAll(/"([A-Za-z-]+)"/gu)].map((m) => m[1]));

const caps = /"onboarding": \[([\s\S]*?)\],\n/u.exec(swift);
const declared = new Set([...caps[1].matchAll(/"([A-Za-z]+)"/gu)].map((m) => m[1]));

const called = new Set([...js.matchAll(/hzPost\('([A-Za-z]+)'/gu)].map((m) => m[1]));

// GRANTED BUT NOT CALLED, deliberately.
//
// moveToApplications is offered by native, not by this page: the app copies
// ITSELF out of ~/Downloads or a read-only DMG and relaunches, and the message
// is sent by main.swift when it notices where it is running from. The grant
// belongs to this surface because that is the surface it happens on. If a
// second name ever wants to join this set, it needs a sentence like this one.
const GRANTED_UNCALLED = new Map([
  ['moveToApplications', 'sent by native when the app is running from Downloads or a DMG'],
]);

test('onboarding calls everything its compartment grants', () => {
  const unused = [...declared].filter((v) => !called.has(v) && !GRANTED_UNCALLED.has(v));
  assert.deepEqual(
    unused,
    [],
    `these verbs are granted to onboarding and never called from it:\n  ${unused.join('\n  ')}\n` +
      'A stale grant re-widens the surface it was added to narrow. Either the page ' +
      'lost a feature and the grant should go, or the grant belongs in GRANTED_UNCALLED ' +
      'with the reason written down.'
  );
});

test('onboarding is granted everything it calls', () => {
  const denied = [...called].filter((v) => !declared.has(v) && !shared.has(v));
  assert.deepEqual(denied, [], `these calls would be refused:\n  ${denied.join('\n  ')}`);
});

test('the named exception is still true', () => {
  for (const verb of GRANTED_UNCALLED.keys()) {
    assert.ok(declared.has(verb), `${verb} is in the exception list but not granted`);
    assert.ok(!called.has(verb), `${verb} IS called now — take it out of the exception list`);
  }
});

// The reads: none of these change anything on disk or on the server.
// relCardPeek is in this list ON PURPOSE and it is the subtle one — GET
// /admin/relationship/card records `shown`, spends a global-cap slot, starts a
// seven-day cooldown and flips the producers' turn. ?peek=1 does none of it,
// which is why the welcome screen may use it to read the current mode and the
// first-load screen may poll it without spending the owner's daily card.
// linkedInState is a read in the strict sense the list means: it reports
// whether an export is already on disk, when it landed and how many records it
// holds. Counts and a date -- no names, no companies, no row content.
// openLinkedInExport is here for the same reason openFullDiskAccess is: it opens
// something the owner asked to be sent to — LinkedIn's data-download page, in
// their own browser — and writes nothing. It is also the narrowest door of the
// three: it takes NO url from the page at all, so unlike openExternal it cannot
// be talked into being a door to somewhere else.
const READS = ['permissionState', 'setupState', 'engineProbe', 'googleProbe',
               'onboardingProgress', 'relCardPeek', 'widgetSpot', 'openFullDiskAccess',
               'openLinkedInExport', 'openReconnect', 'close', 'linkedInState'];

test('the page can only reach the six checks it is supposed to', () => {
  // The verbs that write something, named one by one, so adding a write to
  // this page is a decision somebody makes here rather than a line of JS.
  //
  // `watchForExport` is a write in the sense this list means. It starts a
  // background watcher and, the first time, makes macOS ask the owner for their
  // Downloads and Desktop folders — which is the whole reason it is a verb at
  // all rather than something the app does at launch. Arming it belongs to the
  // one screen that has just explained what file is coming; doing it from
  // applicationDidFinishLaunching put both system dialogs over screens 1 to 3.
  const WRITES = ['relMode', 'setEngine', 'startSources', 'requestPermission',
                  'importLinkedIn', 'watchForExport', 'googleAuth',
                  'modelDownload', 'modelCancel',
                  'onboardingStep', 'onboardingDone', 'spotlightWidget', 'moveToApplications'];
  const extra = [...declared].filter((v) => !WRITES.includes(v) && !READS.includes(v));
  assert.deepEqual(extra, [], `unclassified onboarding verbs: ${extra.join(', ')}`);
});

test('the card is only ever peeked at from this page, never served', () => {
  assert.ok(!declared.has('relCard'), 'the serving GET must not be reachable from onboarding');
  assert.ok(declared.has('relCardPeek'));
  assert.match(js, /hzPost\('relCardPeek'\)/u);
});

test('every verb the page calls is reachable from its own scripts', () => {
  // The compartment is per PAGE, and the page's scripts are its script tags.
  // Reading the file's comments instead is how this map got a page wrong once.
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/gu)].map((m) => m[1]);
  assert.deepEqual(scripts, ['bridge.js', 'onboarding.js']);
});
