// The two source rosters must agree across the package boundary.
//
// A source has to be in three places to work: CONNECTOR_HERMES_SOURCE (what the
// daemon maps a connector's rows onto), RETENTION_SOURCES (what a retention
// sweep may delete), and hermes' KNOWN_SOURCES (what /ingest will accept at
// all). The first two are checked against each other in daemonConfig.test.mjs,
// and ui/test/select.test.mjs checks that every KNOWN_SOURCES entry has a
// read-policy decision. Nothing checked ACROSS.
//
// So a platform added to the daemon and not to hermes passes both suites and
// then 400s at ingest — at runtime, on the owner's machine, with the rows
// already read. This branch added six at once (messenger, instagram, twitter,
// telegram, discord, slack), which is exactly the change that makes a hand-kept
// pair drift.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTOR_HERMES_SOURCE, RETENTION_SOURCES } from '../daemon.mjs';
import { KNOWN_SOURCES } from '../../ui/server/hermes.mjs';

// A connector maps to one source, several (matrix writes one per bridge), or
// none (contacts writes no corpus at all — the null sentinel).
const mapped = new Set(
  Object.values(CONNECTOR_HERMES_SOURCE)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => typeof v === 'string' && v.length > 0)
);

test('every source the daemon can write is one hermes will accept', () => {
  const known = new Set(KNOWN_SOURCES);
  const rejected = [...mapped].filter((s) => !known.has(s));
  assert.deepEqual(
    rejected,
    [],
    `the daemon maps rows onto ${rejected.join(', ')}, which /ingest would refuse with a 400`
  );
});

test('every source retention may sweep is one hermes knows', () => {
  const known = new Set(KNOWN_SOURCES);
  const unknown = RETENTION_SOURCES.filter((s) => !known.has(s));
  assert.deepEqual(
    unknown,
    [],
    `retention is configured for ${unknown.join(', ')}, which hermes does not recognise`
  );
});

// The other direction is informational rather than an error: hermes legitimately
// knows sources no connector writes (a hand import, a bridge landing rows
// directly). Asserted as a floor so the rosters cannot silently diverge to
// nothing.
test('the rosters actually overlap', () => {
  const known = new Set(KNOWN_SOURCES);
  const shared = [...mapped].filter((s) => known.has(s));
  assert.ok(shared.length >= 5, `expected the rosters to share several sources, got ${shared.join(', ')}`);
});
