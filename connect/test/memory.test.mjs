// Tests for the memory review page.
//
// The page is the v1 product surface, so the assertions here are about whether
// the owner can trust what they are looking at: the quote must be the exact
// span the model saw, "nothing to review" must never be shown when the truth is
// "the store is unreachable", and claim text — which is MODEL OUTPUT derived
// from arbitrary message content — must never reach the browser as markup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderMemoryPage, substituteOwner } from '../lib/memoryPage.mjs';
import { readToken, hermesBase } from '../lib/memory.mjs';

const CLAIM = Object.freeze({
  id: 12,
  kind: 'preference',
  text: 'The owner would rather do mornings than evenings.',
  quote: "i'd rather do mornings",
  snapshot_hash: 'abc',
  current_hash: 'abc',
  source: 'imessage',
  source_ts: 1_700_000_000_000,
  observed_at: 1_700_000_000_000,
  model: '/models/model.gguf',
  prompt_path: 'prompts/distill_claims.md',
  prompt_sha: '1a212fb97ffdbbb72269394b',
});

const page = (over = {}, opts = {}) =>
  renderMemoryPage({ claims: [CLAIM], more: false, counts: { proposed: 1 }, ...over }, { token: 'tok', ownerName: null, ...opts });

test('the claim is shown with its exact quote and its provenance', () => {
  const html = page();
  assert.ok(html.includes('The owner would rather do mornings than evenings.'));
  assert.ok(html.includes('i&#39;d rather do mornings'), 'the quote is present, escaped');
  assert.ok(html.includes('a message you sent'), 'the source is named in plain words');
  assert.ok(html.includes('2023-11-14'), 'and dated');
  assert.ok(html.includes('model.gguf') && html.includes('distill_claims.md'));
  assert.ok(html.includes('1a212fb97ffd'), 'the prompt sha is shown so a run is identifiable');
});

test('claim text and quotes are escaped, because both are derived from arbitrary messages', () => {
  // The quote is a literal span of something somebody typed, and the claim text
  // is a model's restatement of it. Neither is trustworthy markup.
  const html = page({
    claims: [
      {
        ...CLAIM,
        text: '<img src=x onerror="alert(1)">',
        quote: '</blockquote><script>alert(2)</script>',
      },
    ],
  });
  assert.ok(!html.includes('<img src=x'), 'claim text must not become markup');
  assert.ok(!html.includes('<script>alert(2)'), 'a quote must not close its own element');
  assert.ok(html.includes('&lt;img src=x'));
  assert.ok(html.includes('&lt;/blockquote&gt;'));
});

test('an empty queue reads as normal, not as a failure', () => {
  const html = renderMemoryPage({ claims: [], counts: { proposed: 0 } }, { token: 'tok' });
  assert.ok(html.includes('Nothing to review'));
  assert.ok(/most messages say nothing durable/u.test(html), 'and says why that is expected');
  assert.ok(!html.includes('could not reach'));
});

test('an unreachable store never renders as an empty queue', () => {
  // These are opposite facts that look identical if the page is careless, and
  // the expensive direction is obvious: an owner who is told "nothing to
  // review" stops checking.
  const html = renderMemoryPage({}, { token: 'tok', error: 'hermes returned 401' });
  assert.ok(html.includes('could not reach its own store'));
  assert.ok(html.includes('hermes returned 401'));
  assert.ok(!html.includes('Nothing to review'));
});

test('a claim whose row has drifted says so instead of showing a false receipt', () => {
  const html = page({ claims: [{ ...CLAIM, current_hash: 'changed' }] });
  assert.ok(/has changed since it was read/u.test(html));
  // A deleted source row is the same story.
  const gone = page({ claims: [{ ...CLAIM, current_hash: null }] });
  assert.ok(/has changed since it was read/u.test(gone));
});

test('every claim gets its own accept and reject, and there is no bulk action', () => {
  // DIFFERENT claims, which is the invariant this test is actually about. It used
  // two identical ones, which now fold into a single card by design — see the
  // grouping test below — and that would have made this pass or fail for the
  // wrong reason.
  const html = page({
    claims: [CLAIM, { ...CLAIM, id: 13, text: 'The owner takes the train to work.' }],
  });
  assert.equal((html.match(/name="claim_id"/gu) ?? []).length, 4, 'two forms per claim');
  assert.equal((html.match(/value="accept"/gu) ?? []).length, 2);
  assert.equal((html.match(/value="reject"/gu) ?? []).length, 2);
  // A button that accepts forty claims accepts the one wrong claim too.
  assert.ok(!/accept[- ]all/iu.test(html), 'no bulk accept');
});

// GROUPING IS NOT A BULK ACTION, and the difference is the whole justification.
//
// A bulk accept decides claims the owner never read. A group is ONE claim, read
// once, that happened to be distilled from several rows saying the same thing —
// four messages about one evening produce four identical sentences, and asking
// four times gets one decision's worth of information at four times the cost.
// The card still shows the text and its quote; what it does not do is show them
// again, three more times.
test('repeats fold into one card that decides for all of them', () => {
  const html = page({
    claims: [CLAIM, { ...CLAIM, id: 13 }, { ...CLAIM, id: 14 }],
  });
  assert.equal((html.match(/<li /gu) ?? []).length, 1, 'three identical claims, one card');
  assert.ok(html.includes('said 3 times'), 'and it says how many it stands for');
  assert.ok(
    html.includes('name="claim_ids" value="12,13,14"'),
    'the press carries every id, so each decision is still recorded individually'
  );
  assert.ok(!/accept[- ]all/iu.test(html), 'still no bulk accept');
});

test('the keyboard layer is enhancement, and the forms survive without it', () => {
  // Progressive enhancement is the point: if the nonce is refused or the
  // script is blocked, every card still has two real form posts. Slow, but
  // never wrong -- and a review surface that stops working under a strict CSP
  // is a review surface that silently stops being used.
  const withScript = page({}, { nonce: 'NONCE123' });
  assert.ok(withScript.includes('<script nonce="NONCE123">'));
  assert.ok(withScript.includes('value="accept"'), 'the form is still there alongside it');

  const withoutScript = page();
  assert.ok(!withoutScript.includes('<script'), 'no nonce means no script at all');
  assert.ok(withoutScript.includes('value="accept"'), 'and the page still reviews');
});

test('the script is inline under its own nonce and fetches only same-origin', () => {
  const html = page({}, { nonce: 'N' });
  const script = html.slice(html.indexOf('<script'), html.indexOf('</script>'));
  assert.ok(!/https?:\/\//u.test(script), 'no external endpoint');
  assert.ok(script.includes("fetch('/c/tok/memory'"), 'posts back to its own token path');
  assert.ok(!/accept[- ]?all|selectAll/iu.test(script), 'still no bulk accept, even by key');
});

test('an error or empty page carries no script', () => {
  assert.ok(!renderMemoryPage({ claims: [] }, { token: 't', nonce: 'N' }).includes('<script'));
  assert.ok(!renderMemoryPage({}, { token: 't', nonce: 'N', error: 'x' }).includes('<script'));
});

test('the page posts back to its own token path and loads nothing external', () => {
  const html = page();
  assert.ok(html.includes('action="/c/tok/memory"'));
  assert.ok(!/https?:\/\//u.test(html.replace(/xmlns="[^"]*"/gu, '')), 'no external URLs');
  assert.ok(!html.includes('<script'), 'without a nonce there is no script at all');
});

test('counts are rendered, and stale only when there is one', () => {
  assert.ok(!page({ counts: { proposed: 1, accepted: 2, rejected: 3, stale: 0 } }).includes('stale'));
  assert.ok(page({ counts: { proposed: 1, stale: 2 } }).includes('stale'));
});

test('the bearer token must be a regular owner-only file', () => {
  const home = mkdtempSync(join(tmpdir(), 'connect-memory-'));
  const dir = join(home, '.hazlie', 'secrets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'hermes-token.txt');

  writeFileSync(path, 'a'.repeat(64), { mode: 0o644 });
  chmodSync(path, 0o644);
  assert.throws(() => readToken({ home }), /owner-only/u, 'a world-readable token is not a token');

  chmodSync(path, 0o600);
  assert.equal(readToken({ home }), 'a'.repeat(64));

  writeFileSync(path, '   \n', { mode: 0o600 });
  assert.throws(() => readToken({ home }), /empty/u);
  rmSync(home, { recursive: true, force: true });
});

test('the hermes base follows the same env var everything else reads', () => {
  assert.equal(hermesBase({}), 'http://127.0.0.1:51789');
  assert.equal(hermesBase({ HAZLIE_HERMES_URL: 'http://127.0.0.1:9999/' }), 'http://127.0.0.1:9999');
});

test('the hermes base refuses anything that is not an HTTP loopback origin', () => {
  // The bearer this module attaches authorizes hermes' /admin/* routes. A
  // stale or mis-set HAZLIE_HERMES_URL (the plist has carried one before —
  // the retired 8790 tunnel port) must throw here, not deliver the admin
  // credential to whatever host it names. Same refusal as
  // connectors/lib/ingestClient.mjs and bridge.mjs's assertLoopbackBase.
  for (const bad of [
    'https://127.0.0.1:8789', // wrong scheme
    'http://hazlie.example:8789', // off-box host
    'http://192.168.1.20:8789', // LAN is off-box too
    'http://127.0.0.1:8789/admin', // a path smuggled into the base
    'http://user:pw@127.0.0.1:8789', // credentials
    'not a url',
  ]) {
    assert.throws(() => hermesBase({ HAZLIE_HERMES_URL: bad }), /loopback/u, bad);
  }
  assert.equal(hermesBase({ HAZLIE_HERMES_URL: 'http://localhost:8789' }), 'http://localhost:8789');
  assert.equal(hermesBase({ HAZLIE_HERMES_URL: 'http://[::1]:8789' }), 'http://[::1]:8789');
});

test('the script renders server error text as a text node, never as markup', () => {
  // The failure notice carries e.message — connect's 502 body, which passes
  // hermes' error string through verbatim, and JSON.stringify does not encode
  // '<'. The page's whole posture is that every interpolation is escaped, so
  // the one dynamic insertion in the keyboard layer must not go through
  // innerHTML. (The counts line still assigns innerHTML, but only from
  // Number() results and its own static tags.)
  const html = page({}, { nonce: 'N' });
  const script = html.slice(html.indexOf('<script'), html.indexOf('</script>'));
  assert.ok(!script.includes('innerHTML +='), 'the error path must not append via innerHTML');
});

test('the page renders claims with the owner named, substituted in code', () => {
  assert.equal(
    substituteOwner('The owner is allergic to penicillin.', 'Riley'),
    'Riley is allergic to penicillin.'
  );
  assert.equal(
    substituteOwner("the owner's brother lives nearby.", 'Riley'),
    "Riley's brother lives nearby."
  );
  // No configured name: claims render exactly as stored.
  assert.equal(substituteOwner('The owner cannot drive.', null), 'The owner cannot drive.');
});

test('a configured name substitutes end-to-end in the rendered page', () => {
  const html = page({}, { ownerName: 'Riley' });
  assert.ok(html.includes('Riley would rather do mornings than evenings.'));
  assert.ok(!html.includes('The owner would rather'));
});
