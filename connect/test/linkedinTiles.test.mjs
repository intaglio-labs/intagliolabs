// THE CONNECT PAGE DRAWS THE SAME SHELF THE WIDGET DOES.
//
// renderConnectPage was handed readStatus() raw: no feature filtering at all,
// while the one-tile-per-flow guarantee lived only in widget/ui/connections.js.
// The page therefore drew every bridge row on a build that installs no bridge,
// two rows both called "LinkedIn" on one that does, and a "Connect" button
// pointing at a help topic that did not exist (404, "No help for that.").
//
// It also counted the export row — a standing invitation waiting on an archive
// LinkedIn takes hours to produce — as outstanding work, so the footer on a Mac
// that never drops Connections.csv could never say "all set".
//
// The rule lives in connect/lib/status.mjs and is asserted here. Its mirror in
// the widget is asserted by widget/test/connector-visibility.test.mjs, which
// evaluates the page's own functions; the two cannot import each other (the
// shelf is a classic <script> in a WKWebView), so they are pinned separately
// against the same table of cases.
//
// Every fixture synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LINKEDIN_EXPORT_ID, readStatus, visibleStatusRows } from '../lib/status.mjs';
import { helpTopicFor, renderConnectPage, renderHelpPage } from '../lib/page.mjs';

const registry = (connectors = {}, features = {}) => ({
  bridges: false,
  ...features,
  connectors: {
    imessage: true, mail: true, calendar: true, contacts: true, linkedin: true,
    whatsapp: 'optional', granola: 'optional',
    notes: false, files: false, photos: false, notion: false, oura: false, health: false,
    ...connectors,
  },
});

const row = (id, extra = {}) => ({ id, label: id, connected: false, ...extra });
const bridgeRow = row('linkedin', { label: 'LinkedIn', action: 'bridge' });
const exportRow = row(LINKEDIN_EXPORT_ID, { label: 'LinkedIn', action: 'linkedin' });
const ids = (rows) => rows.map((r) => r.id);

test('the page hides what this build does not run, by the same two rules', () => {
  const shown = visibleStatusRows(
    [row('imessage'), row('notes'), row('signal'), row('messenger', { action: 'bridge' })],
    registry()
  );
  assert.deepEqual(ids(shown), ['imessage', 'signal'],
    'dormant is hidden, a bridge is hidden while bridges is off, and a connector '
      + 'the registry never mentions is left alone — the daemon schedules that one');
});

test('with bridges off the page shows the export tile, and no bridge tiles', () => {
  const shown = visibleStatusRows([bridgeRow, exportRow], registry());
  assert.deepEqual(ids(shown), [LINKEDIN_EXPORT_ID]);
  assert.equal(shown[0].label, 'LinkedIn', 'one tile needs nothing to tell it apart from');
});

test('with bridges on both LinkedIn flows are drawn, and named apart', () => {
  const shown = visibleStatusRows([bridgeRow, exportRow], registry({}, { bridges: true }));
  assert.deepEqual(ids(shown), ['linkedin', LINKEDIN_EXPORT_ID],
    'the export connector is still scheduled with bridges on, so it still needs a surface');
  assert.deepEqual(shown.map((r) => r.label), ['LinkedIn (bridge)', 'LinkedIn (export)']);
});

test('switching the linkedin connector off takes the export tile with it', () => {
  assert.deepEqual(
    ids(visibleStatusRows([bridgeRow, exportRow], registry({ linkedin: false }, { bridges: true }))),
    ['linkedin']
  );
});

test('a mail account row follows the mail connector, not its own id', () => {
  assert.deepEqual(
    ids(visibleStatusRows([row('mail:someone@example.test')], registry({ mail: false }))),
    []
  );
});

// THE FOOTER HAS TO BE REACHABLE. An archive the owner requests from LinkedIn
// and waits hours for is a standing invitation, like "add another Google
// account" — not an outstanding task, and counting it means the page never
// finishes.
test('the export row never blocks "all set"', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hz-linkedin-tiles-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const real = readStatus({ home }).find((r) => r.id === LINKEDIN_EXPORT_ID);
  assert.equal(real.connected, false, 'no archive in this fixture home');
  assert.equal(real.optional, true, 'the row itself has to carry it');
  const items = [
    { id: 'imessage', label: 'iMessage', connected: true, detail: 'reading' },
    real,
  ];
  const html = renderConnectPage(items);
  assert.ok(html.includes('all set'), 'an optional row is not work left to do');
  assert.ok(!html.includes('class="cta"'),
    'and it must not take the page\'s single filled accent either');
});

// THE BUTTON HAS TO GO SOMEWHERE. Every non-bridge unconnected row links to
// /help/<id>, and an unknown topic is a 404 page reading "No help for that."
test('the export row has a help topic, and it names the folder to drop the file in', () => {
  assert.equal(helpTopicFor(LINKEDIN_EXPORT_ID), LINKEDIN_EXPORT_ID);
  const html = renderHelpPage(LINKEDIN_EXPORT_ID);
  assert.ok(html !== null, 'the Connect button on this row 404s without it');
  assert.match(html, /Connections\.csv/u);
  assert.match(html, /~\/\.hazlie\/imports\/linkedin/u, 'the path IS the instruction');
  assert.match(html, /Get a copy of your data/u, 'the export is four clicks inside LinkedIn');
});
