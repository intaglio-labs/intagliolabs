import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, helpTopicFor, renderConnectPage, renderHelpPage } from '../lib/page.mjs';

const items = [
  { id: 'calendar', label: 'Calendar', connected: true, detail: 'reading', action: null },
  {
    id: 'mail:ay@austinyoshino.com',
    label: 'ay@austinyoshino.com',
    connected: false,
    detail: 'needs a password',
    action: 'gmail',
  },
  { id: 'granola', label: 'Granola', connected: true, detail: 'key stored', action: null },
  { id: 'oura', label: 'Health', connected: false, detail: 'not yet', action: 'oura' },
];

test('every interpolation is escaped', () => {
  assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
  const html = renderConnectPage([
    { id: 'x', label: '<img onerror=alert(1)>', connected: true, detail: '"><b>', action: null },
  ]);
  assert.ok(!html.includes('<img onerror'), 'label must not render as markup');
  assert.ok(html.includes('&lt;img onerror'));
});

test('connected rows read as connected and offer no button', () => {
  const html = renderConnectPage(items);
  const calendar = html.slice(html.indexOf('Calendar'), html.indexOf('ay@'));
  assert.ok(calendar.includes('connected'));
  assert.ok(!calendar.includes('class="cta"'), 'a done row must not ask again');
});

test('the gmail row posts same-origin and never echoes the secret back', () => {
  const html = renderConnectPage(items, { token: 'TOK' });
  assert.ok(html.includes('type="password"'));
  assert.ok(html.includes('autocomplete="off"'));
});

// REGRESSION. The page is served at /c/<token> with no trailing slash, so a
// relative action="gmail" resolves against the directory /c/ and posts to
// /c/gmail — token dropped, 404. Hitting the route directly with curl passes
// while the real form is broken, which is exactly how this shipped once.
test('the form action carries the token and is an absolute path', () => {
  const html = renderConnectPage(items, { token: 'TOK' });
  assert.ok(
    html.includes('action="/c/TOK/gmail"'),
    'the action must be /c/<token>/gmail, not a relative "gmail"'
  );
  assert.ok(!/action="gmail"/u.test(html), 'a bare relative action loses the token');
});

test('the account rides in a hidden field, never in the URL', () => {
  const html = renderConnectPage(items, { token: 'TOK' });
  assert.ok(html.includes(String.raw`value="ay@austinyoshino.com"`));
  // An app password in a path would persist in history and referer headers.
  assert.ok(!/action="[^"]*appPassword/u.test(html));
});

test('the footer counts what is actually left', () => {
  assert.ok(renderConnectPage(items).includes('2 left'));
  const allDone = items.map((i) => ({ ...i, connected: true, action: null }));
  assert.ok(renderConnectPage(allDone).includes('all set'));
});

test('a "soon" row is inert — no button, no count', () => {
  const withSoon = [...items, { id: 'z', label: 'Later', detail: 'not yet', soon: true }];
  const html = renderConnectPage(withSoon);
  assert.ok(html.includes('soon'));
  assert.ok(html.includes('2 left'), 'soon rows must not inflate the remaining count');
});

// The page handles a credential; a CDN font or a tracker would be a real leak.
test('the page loads nothing from the network', () => {
  const html = renderConnectPage(items);
  assert.doesNotMatch(html, /https?:\/\/(?!localhost|127\.0\.0\.1)/u, 'no external URLs');
  assert.doesNotMatch(html, /<script/u, 'no script at all');
});

test('a banner renders when one is supplied, escaped', () => {
  const html = renderConnectPage(items, { banner: 'Gmail <connected>' });
  assert.ok(html.includes('Gmail &lt;connected&gt;'));
  assert.ok(!renderConnectPage(items).includes('class="banner"'));
});

// The help pages were dead until 2026-08-20: the server's route matched
// `help/<id>` and fell through to re-rendering the connect page, so the button
// appeared to do nothing. A `full` install has three FDA rows, so three.
test('every actionable row has a help topic behind it', () => {
  for (const id of ['imessage', 'photos', 'notes', 'files', 'calendar', 'granola', 'oura', 'notion']) {
    assert.ok(renderHelpPage(id, { token: 'TOK' }), `no help page for ${id}`);
  }
});

test('the three Apple stores share the one Full Disk Access topic', () => {
  assert.equal(helpTopicFor('imessage'), 'fda');
  assert.equal(helpTopicFor('photos'), 'fda');
  assert.equal(helpTopicFor('notes'), 'fda');
  assert.equal(helpTopicFor('calendar'), 'calendar');
});

test('an unknown topic returns null so the server can 404 rather than fall through', () => {
  assert.equal(renderHelpPage('nope', { token: 'TOK' }), null);
});

// The gmail form once used a relative action, which resolved against /c/ and
// dropped the token — every browser 404'd while a direct curl passed. The help
// links were written the same way. Both must be absolute.
test('help links carry the token, rather than resolving away from it', () => {
  const html = renderConnectPage(
    [{ id: 'imessage', label: 'Messages', connected: false, detail: 'x', action: 'fda' }],
    { token: 'TOK' }
  );
  assert.match(html, /href="\/c\/TOK\/help\/imessage"/u);
  assert.doesNotMatch(html, /href="help\//u);
});

test('the help page links back to the tokened page, not to bare /', () => {
  assert.match(renderHelpPage('imessage', { token: 'TOK' }), /href="\/c\/TOK"/u);
});

// The instructions name a path the owner pastes into System Settings. If this
// drifts from ops/setup-connectors.sh, the grant lands on the wrong binary.
test('the FDA page names the APP, not the binary underneath it', () => {
  // This asserted ~/.hazlie/bin/node, and that was right while the reader was a
  // launchd agent responsible for itself. It is a child of the app now, so macOS
  // attributes the grant to intaglio labs — naming node would send someone to
  // switch on a permission that does nothing.
  const page = renderHelpPage('imessage', { token: 'TOK' });
  assert.match(page, /intaglio labs/u);
  assert.doesNotMatch(page, /~\/\.hazlie\/bin\/node/u,
    'a path into a hidden directory is not an instruction anyone can follow');
});

// Help prose is authored with inline markup in `body` and `after` alike —
// This page used to escape `after`, so the reader saw a literal "<em>…</em>"
// there while the same markup rendered fine one paragraph up.
//
// The fixture was linkedin.after ("<em>Connected On</em>") until that topic
// went away with the CSV export (2026-08-25). Repointed at files rather than
// dropped: the escaping bug is still possible, and a guard deleted because
// its example moved is how a fixed bug comes back.
test('after paragraphs render their markup instead of showing it', () => {
  const html = renderHelpPage('files', { token: 'TOK' });
  assert.ok(html.includes('<em>skipped entirely</em>'), 'after markup must render as markup');
  assert.ok(!html.includes('&lt;em&gt;'), 'no escaped tag may reach the reader as text');
});

// --- the prototype-chain route that killed the server ----------------------

test('help topics resolve by own-property only — /help/constructor cannot crash the server', () => {
  // `HELP[id]` walked the prototype chain, so `constructor` returned
  // Object.prototype.constructor — truthy, past the `!topic` guard, then
  // `topic.body.map(...)` threw on undefined. Thrown inside connect's async
  // handler with no uncaughtException handler, that KILLED THE PROCESS; under
  // KeepAlive it restarted and minted a fresh 24h token into the log, so one
  // authenticated GET was a loop that both took the service down and produced
  // a new live credential each time round.
  for (const probe of [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    'isPrototypeOf',
    'propertyIsEnumerable',
  ]) {
    let out;
    assert.doesNotThrow(() => {
      out = renderHelpPage(probe, { token: 'tok' });
    }, `/help/${probe} must not throw`);
    assert.equal(out, null, `/help/${probe} must be a 404, not a page`);
  }
});

test('a real help topic still renders', () => {
  // The other half: the guard must not have made every topic unreachable.
  const page = renderHelpPage('fda', { token: 'tok' });
  assert.ok(typeof page === 'string' && page.includes('<!doctype html>'));
});
