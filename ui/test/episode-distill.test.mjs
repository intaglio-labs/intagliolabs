// Episode mode, and specifically the boundary that replaces "one row per call".
// Every fixture is synthetic; the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderEpisode,
  validateEpisodeClaims,
  maxClaimsForEpisode,
  episodeClaimSchema,
  MAX_CONTEXT_LINE_CHARS,
  MAX_CONTEXT_LINES,
} from '../server/memory/distill.mjs';

const EP = { source: 'imessage', started_at: Date.UTC(2026, 2, 4), ended_at: Date.UTC(2026, 2, 4) };

const line = (n, quotable, text, speaker = 'Sam') => ({
  line_no: n,
  quotable,
  text,
  speaker,
  context_id: 100 + n,
  content_hash: `h${n}`,
});

const THREAD = [
  line(1, 0, 'want chick-fil-a tonight?'),
  line(2, 1, 'cant, im vegetarian now'),
];

test('the episode renders both voices, and marks whose is whose', () => {
  const out = renderEpisode(EP, THREAD, { context: true });
  assert.match(out, /BEGIN THREAD/);
  assert.match(out, /END THREAD/);
  assert.match(out, /2 > you: cant, im vegetarian now/);
  assert.match(out, /1 {3}Sam: want chick-fil-a tonight\?/);
  assert.match(out, /1 of 2 messages are yours/);
});

// The whole reason context exists: the received line is what makes the owner's
// reply legible. With context off the model sees a bare "cant, im vegetarian
// now" and has to guess what it answers.
test('context off renders owner lines only, and keeps their numbers', () => {
  const out = renderEpisode(EP, THREAD, { context: false });
  assert.doesNotMatch(out, /chick-fil-a/, 'no received text at all');
  assert.match(out, /^2 > you:/m, 'line numbers are the episode’s, not a re-count');
});

// ── the boundary ────────────────────────────────────────────────────────────

test('a claim citing a received line is dropped, however true it looks', () => {
  const { kept, dropped } = validateEpisodeClaims(THREAD, [
    { kind: 'fact', text: 'The owner was offered chick-fil-a.', line: 1, quote: 'want chick-fil-a', p: 0.9 },
  ]);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /line the owner did not write/);
});

test('the fabrication this design exists to prevent cannot be expressed', () => {
  // The historical bug: a friend ASKING about Chick-fil-A became "the owner
  // plans to order Chick-fil-A". In episode mode that claim has nowhere to
  // stand — the only line supporting it is one the owner did not write.
  const { kept } = validateEpisodeClaims(THREAD, [
    { kind: 'plan', text: 'The owner plans to order chick-fil-a.', line: 1, quote: 'chick-fil-a', p: 0.95 },
  ]);
  assert.deepEqual(kept, []);
});

test('a claim on the owner line is kept, and carries the line it rests on', () => {
  const { kept } = validateEpisodeClaims(THREAD, [
    { kind: 'fact', text: 'The owner is vegetarian.', line: 2, quote: 'im vegetarian now', p: 0.9 },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].line, 2);
  assert.equal(kept[0].context_id, 102, 'resolved from the cited line, not from the model');
  assert.equal(kept[0].content_hash, 'h2');
});

test('a quote must be an exact span of the cited line, not of the window', () => {
  const { kept, dropped } = validateEpisodeClaims(THREAD, [
    // The span exists in the episode — on the OTHER line.
    { kind: 'fact', text: 'The owner likes chicken.', line: 2, quote: 'chick-fil-a', p: 0.9 },
  ]);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /exact span of the cited line/);
});

test('a quote that swallows the rendered label fails, as it should', () => {
  const { kept } = validateEpisodeClaims(THREAD, [
    { kind: 'fact', text: 'The owner is vegetarian.', line: 2, quote: '2 > you: cant', p: 0.9 },
  ]);
  assert.deepEqual(kept, [], 'the label is ours, not the owner’s words');
});

test('a line number outside the episode is dropped', () => {
  const { dropped } = validateEpisodeClaims(THREAD, [
    { kind: 'fact', text: 'The owner is vegetarian.', line: 99, quote: 'im vegetarian now', p: 0.9 },
  ]);
  assert.match(dropped[0].reason, /not in this episode/);
});

test('the owner-subject check survives into episode mode', () => {
  const { dropped } = validateEpisodeClaims(THREAD, [
    { kind: 'fact', text: 'Sam is vegetarian.', line: 2, quote: 'im vegetarian now', p: 0.9 },
  ]);
  assert.match(dropped[0].reason, /name the owner/);
});

// ── the bounds on the context window ────────────────────────────────────────

test('received lines are truncated and capped in number', () => {
  const long = 'x'.repeat(MAX_CONTEXT_LINE_CHARS + 200);
  const many = [line(1, 1, 'ok')];
  for (let i = 2; i < 2 + MAX_CONTEXT_LINES + 5; i += 1) many.push(line(i, 0, long));
  const out = renderEpisode(EP, many, { context: true });
  const shown = out.split('\n').filter((l) => /^\d+ {3}/.test(l));
  assert.ok(shown.length <= MAX_CONTEXT_LINES, `at most ${MAX_CONTEXT_LINES} received lines`);
  assert.ok(out.includes('…'), 'and each one truncated');
  assert.ok(!out.includes(long), 'never a full long line');
});

test('the claim cap scales with the episode but stays bounded', () => {
  assert.equal(maxClaimsForEpisode([line(1, 1, 'a')]), 3, 'floor');
  const big = Array.from({ length: 40 }, (_, i) => line(i + 1, 1, 'a'));
  assert.equal(maxClaimsForEpisode(big), 8, 'cap');
  assert.equal(episodeClaimSchema(big).schema.properties.claims.maxItems, 8);
});

test('the grammar requires the line, so a compliant model cannot omit it', () => {
  const req = episodeClaimSchema(THREAD).schema.properties.claims.items.required;
  assert.ok(req.includes('line'));
  assert.ok(req.includes('quote'));
});

test('a flood is refused wholesale rather than trimmed', () => {
  const claims = Array.from({ length: 20 }, () => ({
    kind: 'fact',
    text: 'The owner is vegetarian.',
    line: 2,
    quote: 'im vegetarian now',
    p: 0.9,
  }));
  const { kept, flooded } = validateEpisodeClaims(THREAD, claims);
  assert.equal(flooded, true);
  assert.deepEqual(kept, []);
});
