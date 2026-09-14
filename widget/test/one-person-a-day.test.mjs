// ONE PERSON A DAY, AND A WAY TO SAY "NOT THAT ONE".
//
// Owner, 2026-09-13: "the any/founder/investor thing isn't necessary --
// reconnect should be one person. user can dismiss and ask for another one if
// they like." Two changes, and they are the same change: the group picker goes
// away, and the thing it was standing in for -- some control over who turns up
// -- becomes a button you press after seeing a card you did not want.
//
// What this file holds down:
//
//   1. the picker is GATED, not deleted. `timeline` off (the shipping default)
//      means no chips, no mode sentences, and no page on this side posting the
//      mode. Every mechanism behind it is still in the source and comes back
//      together under that one flag, which is why every assertion here is
//      about a gate and not about an absence.
//   2. the pull state machine RUNS here. It is the part with the branches, and
//      the branch that matters -- three pulls spent, on a real day -- is the
//      one nobody can produce on demand, so it is exercised as code rather
//      than matched as text.
//
// The two pure functions are lifted out of reconnect.js and evaluated on their
// own, the same trick reconnect-card-facts.test.mjs uses: the page is a plain
// script that touches the DOM at load, and standing up a webview to exercise
// two decisions would be the wrong trade.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIDGET = join(ROOT, 'widget');
const reconnectJs = readFileSync(join(WIDGET, 'ui', 'reconnect.js'), 'utf8');
const reconnectHtml = readFileSync(join(WIDGET, 'ui', 'reconnect.html'), 'utf8');
const onboardingJs = readFileSync(join(WIDGET, 'ui', 'onboarding.js'), 'utf8');
const onboardingHtml = readFileSync(join(WIDGET, 'ui', 'onboarding.html'), 'utf8');
const connectionsJs = readFileSync(join(WIDGET, 'ui', 'connections.js'), 'utf8');
const bridgeSwift = readFileSync(join(WIDGET, 'src', 'Bridge.swift'), 'utf8');

// Comments out, so a pin never passes on prose that happens to quote the code
// it is looking for. Strings survive, which is the point of several of these.
const code = (s) => s.replace(/^\s*\/\/.*$/gmu, '');

function bodyOf(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > -1, `reconnect.js has no function ${name}`);
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, `could not find the end of ${name}`);
  return src.slice(at, end + 2);
}

// ------------------------------------------------- the state machine, run

// new Function over THIS REPO'S OWN SOURCE, read from disk in a test. Nothing
// crosses a trust boundary; the alternative is a webview for two functions.
function lift() {
  const parts = [];
  for (const decl of [
    /const EMPTY_REASONS = \{[\s\S]*?\n\};/u,
    /const reachedHermes = [^\n]*;/u,
    /const REJECTIONS = new Set\([^\n]*\);/u,
    /const PULLS_DONE = [^\n]*;/u,
    /const CAP_WITH_PULLS = [^\n]*;/u,
  ]) {
    const found = decl.exec(reconnectJs)?.[0];
    assert.ok(found, `a declaration the lifted functions read was not found: ${decl}`);
    parts.push(found);
  }
  for (const name of ['verdictNext', 'pullPanel', 'pullsLeftFrom', 'afterRejection', 'emptyPanel']) {
    parts.push(bodyOf(reconnectJs, name));
  }
  // eslint-disable-next-line no-new-func
  return new Function(
    `${parts.join('\n')}\nreturn { verdictNext, pullPanel, pullsLeftFrom, afterRejection, emptyPanel,`
    + ` EMPTY_REASONS, PULLS_DONE, CAP_WITH_PULLS };`
  )();
}

// Lifted on first use rather than at import: a missing function is then ONE
// failing test with its own name, not a file that would not load and four
// assertions that never ran.
let lifted = null;
const fns = () => (lifted ??= lift());

const CARD = { state: 'ok', card: { snapshot_id: 's1', personKey: 'p1' } };

test('a rejection stops the panel; only "will text them" ends the day', () => {
  // The four rejection buttons are three dismiss reasons and a 30-day mute.
  // Every one of them is the owner saying "not that one", which is a question
  // about the next card rather than an answer about the day.
  assert.equal(fns().verdictNext('dismissed', false), 'another');
  assert.equal(fns().verdictNext('muted', false), 'another');
  // ...and the one that closes it. The owner did the thing the card asked for;
  // the day has had its interruption.
  assert.equal(fns().verdictNext('accepted', false), 'pull');
});

test('with the groups on, every verdict walks the queue exactly as it did', () => {
  // `timeline` is the old product, pulls and all. The flag has to decide this
  // too, or the two behaviours are two code paths that drift.
  assert.equal(fns().verdictNext('dismissed', true), 'pull');
  assert.equal(fns().verdictNext('muted', true), 'pull');
  assert.equal(fns().verdictNext('accepted', true), 'pull');
});

test('a spent pull allowance is its own panel, not the empty state', () => {
  // THE FIXTURE THAT DISCRIMINATES. Routing `pulls-exhausted` through
  // renderEmpty would pass any test that only asked "does the panel say
  // something" -- and it would say "that's all for today — one nudge a day, on
  // purpose", which is a sentence about the DAILY CAP, next to a refresh button
  // that cannot produce a card. The owner spent three pulls; they did not hit
  // the cap, and they must not be told they did.
  const spent = fns().pullPanel({ state: 'ok', card: null, reason: 'pulls-exhausted', retryAfterMs: 3600000 });
  assert.equal(spent.panel, 'another');
  assert.equal(spent.button, false, 'a button that cannot work until tomorrow is worse than none');
  assert.equal(spent.msg, "that's enough for today — more tomorrow");
  assert.notEqual(spent.msg, fns().EMPTY_REASONS.cap, 'the cap and the pull allowance are different facts');

  // ...and the daily cap still IS the empty state, with its own sentence.
  assert.equal(fns().pullPanel({ state: 'ok', card: null, reason: 'cap' }).panel, 'empty');
});

test('a pull that reaches nobody keeps the button', () => {
  // relHermes RESOLVES with {state:'down'} while hermes restarts and
  // {state:'auth'} before there is a bearer; neither carries a card, and
  // neither is an answer about the owner's day. Telling them it is over
  // because the reader was starting up would be a verdict nobody reached.
  for (const out of [{ state: 'down' }, { state: 'auth' }, null, undefined, {}]) {
    const next = fns().pullPanel(out);
    assert.equal(next.panel, 'another', `${JSON.stringify(out)} is not an empty queue`);
    assert.equal(next.button, true, 'a reader that was restarting is a reason to try again');
    assert.equal(next.msg, fns().EMPTY_REASONS.unreachable);
  }
});

test('a card that arrives is rendered, whatever asked for it', () => {
  assert.equal(fns().pullPanel(CARD).panel, 'card');
});

test('the budget is read from whichever reply knows it', () => {
  // hermes puts `pullsLeft` on the card replies and on the verdict reply. The
  // verdict was posted after the serve, so it has seen the rejection and wins;
  // the card reply is the fallback for a reader that answers without it.
  assert.equal(fns().pullsLeftFrom({ pullsLeft: 1 }, { pullsLeft: 3 }), 1);
  assert.equal(fns().pullsLeftFrom({ ok: true }, { pullsLeft: 3 }), 3);
  assert.equal(fns().pullsLeftFrom({ pullsLeft: 0 }, { pullsLeft: 3 }), 0,
    'zero is an answer, and it must not be skipped over as falsy');

  // NULL IS NOT ZERO. `Number(x)` of a missing field is NaN and `x ?? 0` is
  // zero, and either spelling tells every install running an older hermes that
  // their day is over, permanently, while removing the button that would have
  // proved otherwise.
  for (const absent of [{}, null, undefined, { pullsLeft: null }, { pullsLeft: '2' },
    { pullsLeft: 1.5 }, { pullsLeft: -1 }, { pullsLeft: NaN }]) {
    assert.equal(fns().pullsLeftFrom(absent, {}), null, JSON.stringify(absent));
  }
});

test('a spent budget hands the question to the route, and never calls the day over', () => {
  // THE INPUT THE OLD VERSION GOT WRONG: `capPerDay: 50`, accept card 1 in the
  // morning, dismiss card 2 in the afternoon. The accept alone zeroes
  // `pullsLeft`, while the frequency cap -- a separate gate, consulted first --
  // is wide open at 2 of 50. Saying "that's enough for today" there was a
  // sentence the very next poll contradicted by serving card 3.
  //
  // The page cannot see the cap, so it stops claiming to. Zero falls through to
  // an ordinary pull() and whatever hermes answers is the truth: `cap` if the
  // day really is done, a card if it is not. A refused serve spends nothing, so
  // asking costs nothing either.
  assert.deepEqual(fns().afterRejection({ pullsLeft: 0 }, { pullsLeft: 3 }), { panel: 'pull' });
  assert.deepEqual(fns().afterRejection({ ok: true }, { pullsLeft: 0 }), { panel: 'pull' },
    'the served reply answers when the verdict reply cannot');

  // FAIL OPEN IN THE OTHER DIRECTION. One left, three left, or nobody said: the
  // button is offered, because the press is settled by hermes, which is the
  // authority, and the worst case is the honest sentence one press later.
  for (const pair of [[{ pullsLeft: 1 }, {}], [{ pullsLeft: 3 }, {}], [{}, {}], [null, null]]) {
    const next = fns().afterRejection(...pair);
    assert.equal(next.panel, 'another', JSON.stringify(pair));
    assert.equal(next.button, true, JSON.stringify(pair));
    assert.equal(next.msg, 'noted.');
  }
});

test('a spent cap with pulls still owed is a pause, not a verdict', () => {
  // THE INPUT: capPerDay 1, the day's card served and dismissed, then the page
  // reaches pull() with no pause on screen -- a reload, a webview teardown, or
  // simply a second visit. hermes answers {reason:'cap', pullsLeft:3} and the
  // page drew "that's all for today" with no button, putting the three cards
  // the owner was owed out of reach until tomorrow: the only door to ?pull=1
  // was the in-session pause drawn straight after a rejection.
  const owed = fns().emptyPanel({ reason: 'cap', pullsLeft: 3 });
  assert.equal(owed.panel, 'another');
  assert.equal(owed.button, true);
  assert.equal(owed.msg, fns().CAP_WITH_PULLS);
  assert.notEqual(owed.msg, fns().EMPTY_REASONS.cap, 'the day is not over and must not read as over');

  // ...and a cap with nothing owed is the empty state it always was.
  assert.equal(fns().emptyPanel({ reason: 'cap', pullsLeft: 0 }).panel, 'empty');
  assert.equal(fns().emptyPanel({ reason: 'cap' }).panel, 'empty',
    'a reader that does not send the field has not said the owner is owed anything');
});

test('the pause is offered only where the queue would actually serve', () => {
  // A BUTTON THAT CANNOT CHANGE THE SCREEN IT IS ON IS WORSE THAN NO BUTTON --
  // screen 6 already carries that lesson. A pull goes through the same queue, so
  // for every reason but `cap` the answer to pressing it is the sentence that is
  // already up: nobody qualifies yet, or the owner's own controls are refusing
  // what is there.
  for (const reason of ['queue-empty', 'pool-exhausted', 'muted', 'suppressed',
    'quote-gone', 'claim-gone', 'claim-rejected', 'no-cap-configured', 'unreachable']) {
    assert.equal(fns().emptyPanel({ reason, pullsLeft: 3 }).panel, 'empty', reason);
  }
});

test('no sentence on either surface asserts a cadence it has not read', () => {
  // ~~"one nudge a day, on purpose"~~ and ~~"one person a day, whoever has gone
  // quiet"~~. `relationshipMemory.capPerDay` is the owner's, and this row had
  // the identical defect corrected once already -- a spelled-out "one" beside a
  // config that says 50. The digit is the row's own job.
  assert.doesNotMatch(fns().EMPTY_REASONS.cap, /one nudge a day/u);
  assert.doesNotMatch(fns().EMPTY_REASONS.cap, /\bone\b/u);
  const help = /const CARD_HELP = '([^']*)'/u.exec(connectionsJs)?.[1] ?? '';
  assert.ok(help, 'CARD_HELP not found');
  assert.doesNotMatch(help, /\bone\b|\ba day\b/u, 'the hover must not name a cadence');
  // The number itself still comes from the config, on the row.
  assert.match(code(connectionsJs), /bits\.push\(`\$\{cfg\.capPerDay\} a day`\)/u);
});

test('the budget and the card chrome belong to the served card, and die with it', () => {
  const src = code(reconnectJs);
  assert.match(code(bodyOf(reconnectJs, 'renderServed')), /servedPullsLeft = pullsLeftFrom\(out\);/u,
    'remembered from the reply that carried this card, and only that one');
  // Cleared by both panels that replace a card, so a budget can never be read
  // against a serve it did not describe.
  assert.match(code(bodyOf(reconnectJs, 'showAnother')), /servedPullsLeft = null;/u);
  // ...and so is the card's chrome. verdict() disables the five buttons before
  // it posts and the pause branch returns without re-enabling them, and the
  // "why?" the owner typed about one person stayed in the box. Invisible only
  // because #rcCard is hidden -- one `hidden = false` from dead buttons and a
  // note about somebody else.
  const pause = code(bodyOf(reconnectJs, 'showAnother'));
  assert.match(pause, /setVerdictButtonsDisabled\(false\);/u);
  assert.match(pause, /el\('rcFeedback'\)\.value = '';/u);
  assert.match(pause, /el\('rcActionsError'\)\.hidden = true;/u);
  assert.match(code(bodyOf(reconnectJs, 'renderEmpty')), /servedPullsLeft = null;/u);
  assert.match(src, /let servedPullsLeft = null;/u);
});

test('nothing reads the flag before the registry has answered', () => {
  // The first pull used to be fired synchronously beside the feature read, so
  // the two raced: a card reply that won found `modesOn` still false,
  // adoptServerMode returned early, and the first card's server mode was never
  // taken up. Flag-ON-only, which is the condition under which it is hardest to
  // find -- nothing is visible until `timeline` comes back.
  const src = code(reconnectJs);
  assert.match(src, /const modesReady = hzFeatures\(\)/u);
  assert.doesNotMatch(src, /^pull\(\);$/mu, 'the first pull must not be fired beside the read');
  assert.match(src, /modesReady\.then\(pull\);/u);
  // ...and the re-show hook goes through the same gate, because the first
  // re-show may arrive before the answer too.
  const hook = /window\.__hzReconnectShow = \(\) => \{([\s\S]*?)\n\};/u.exec(reconnectJs)?.[1] ?? '';
  assert.match(code(hook), /modesReady\.then\(pull\)/u);

  // Same shape on the setup flow, where screen 1 is the first thing drawn.
  const ob = code(onboardingJs);
  assert.match(ob, /const modesReady = hzFeatures\(\)/u);
  assert.match(code(bodyOf(onboardingJs, 'enterWelcome')), /modesReady\.then\(\(\) => \{/u);
});

test('the setup flow declares what its feature callback closes over, above it', () => {
  // The callback is a microtask and ran after module evaluation, which is the
  // ONLY reason reading a `const` declared below it worked. A prefs path that
  // ever resolved synchronously turns it into a TDZ ReferenceError that takes
  // the `chat` flow selection on the same line down with it.
  const ob = code(onboardingJs);
  const callAt = ob.indexOf('const modesReady = hzFeatures()');
  assert.ok(callAt > -1);
  for (const decl of ['const modeBlock =', 'let modesOn = false;']) {
    const at = ob.indexOf(decl);
    assert.ok(at > -1 && at < callAt, `${decl} must be declared above the callback that reads it`);
  }
});

// --------------------------------------------- the page asks for the pull

test('"show me another" is the only thing that sends the pull flag', () => {
  // The day's card is served without being asked for and counts as the day's
  // one interruption. A pull is the owner pressing the button, and the flag is
  // the whole difference between the two on the wire.
  const another = code(bodyOf(reconnectJs, 'pullAnother'));
  assert.match(another, /hzPost\('relCard', \{ pull: true \}\)/u);
  // The first fetch of the day carries nothing, or it would spend a pull to
  // deliver the card the owner never asked for.
  assert.match(code(bodyOf(reconnectJs, 'pull')), /hzPost\('relCard'\)/u);

  // And native turns the one boolean into the one query flag.
  assert.match(code(bridgeSwift), /payload\["pull"\] as\? Bool == true \{ cardQuery\.append\("pull=1"\) \}/u);
  // The one-off mode still rides the same request, so the two must compose
  // rather than overwrite each other -- which is why the path is a list now.
  assert.match(code(bridgeSwift), /cardQuery\.joined\(separator: "&"\)/u);
});

test('the verdict no longer fetches the next card by itself', () => {
  const verdict = code(bodyOf(reconnectJs, 'verdict'));
  assert.match(verdict, /verdictNext\(event, modesOn\) === 'another'/u);
  // ~~`showAnother('noted.', true)`~~ — the pause asks the budget first, from
  // the verdict reply it has just read and then from the serve that delivered
  // the card. The sentence and the button are afterRejection's to choose.
  assert.match(verdict, /afterRejection\(out, \{ pullsLeft: servedPullsLeft \}\)/u,
    'the verdict reply is the fresher answer and must be asked first');
  assert.match(verdict, /if \(next\.panel === 'another'\) \{ showAnother\(next\.msg, next\.button\); return; \}/u,
    'the pause offers the one thing the owner might still want');
  // ...and anything else falls through to the ordinary pull below it, which is
  // how a spent budget stops being a claim about the day.
  const branchAt = verdict.indexOf("next.panel === 'another'");
  const pullAt = verdict.indexOf('await pull();');
  assert.ok(branchAt > -1 && pullAt > branchAt, 'the fall-through has to reach pull()');
  // The button and its panel exist on the page at all.
  assert.match(reconnectHtml, /id="rcAnother"/u);
  assert.match(reconnectHtml, /id="rcAnotherBtn">show me another</u);
});

test('the pause survives the panel being hidden and shown again', () => {
  // Native pokes __hzReconnectShow on every re-show. Refetching while the owner
  // is looking at "show me another" spends a serve they did not ask for -- and
  // with the day's interruption already delivered the answer is "that's all for
  // today", so the button they were looking at is gone.
  const hook = /window\.__hzReconnectShow = \(\) => \{([\s\S]*?)\n\};/u.exec(reconnectJs)?.[1];
  assert.ok(hook, '__hzReconnectShow is not a wrapper any more');
  assert.match(code(hook), /if \(awaitingPull\) \{[^}]*return; \}/u);
  assert.match(code(hook), /modesReady\.then\(pull\)/u, 'every other state still refetches');
  // Set only where the button is actually offered, and cleared by both of the
  // panels that replace it.
  assert.match(code(bodyOf(reconnectJs, 'showAnother')), /awaitingPull = button;/u);
  assert.match(code(bodyOf(reconnectJs, 'renderEmpty')), /awaitingPull = false;/u);
  assert.match(code(bodyOf(reconnectJs, 'render')), /awaitingPull = false;/u);
});

// ------------------------------------------------------- the groups are off

test('the chip row ships hidden and is revealed only by the registry', () => {
  const modes = /<div class="rc-modes" id="rcModes"[^>]*>/u.exec(reconnectHtml)?.[0] ?? '';
  assert.ok(modes, '#rcModes is gone from the markup entirely — it is meant to be kept');
  assert.match(modes, /\shidden\b/u, 'it must ship hidden, so no page flashes three chips');
  assert.match(code(reconnectJs), /modesOn = hzFeatureOn\(set, 'timeline'\)/u);
  assert.match(code(reconnectJs), /let modesOn = false;/u, 'and it fails closed');
  // Every place that used to reveal the row unconditionally now asks. The one
  // assignment that still says `false` outright is the reveal itself, and it is
  // downstream of the registry's answer.
  const src = code(reconnectJs);
  const flagAt = src.indexOf("modesOn = hzFeatureOn(set, 'timeline')");
  for (const m of src.matchAll(/el\('rcModes'\)\.hidden = ([^\n;]+)/gu)) {
    if (/!modesOn/u.test(m[1])) continue;
    assert.equal(m[1], 'false', `an rcModes assignment that is neither gated nor the reveal: ${m[1]}`);
    assert.ok(m.index > flagAt, 'the reveal must come after the registry has answered');
  }
});

test('with the groups off the card page posts no mode, by any route', () => {
  // GATED IN THE FUNCTION, not in the markup. The chips are hidden rather than
  // removed, so their listeners are still attached to buttons nobody can reach.
  const select = code(bodyOf(reconnectJs, 'selectMode'));
  const guardAt = select.indexOf('if (!modesOn) return;');
  const postAt = select.indexOf("hzPost('relMode'");
  assert.ok(guardAt > -1 && postAt > guardAt, 'selectMode must refuse before it posts');
  // relRefresh is the other verb that carried a mode. hermes reads an absent
  // one as its own default, which is the mode this product now has.
  assert.match(code(reconnectJs), /hzPost\('relRefresh', modesOn \? \{ mode: currentMode \} : \{\}\)/u);
  // The two sentences about a lit chip both go quiet, in the functions that
  // write them rather than at their call sites -- the call sites are the paths
  // that must keep clearing a line left over from another card.
  for (const name of ['showModeFallback', 'showOneOff', 'adoptServerMode']) {
    assert.match(code(bodyOf(reconnectJs, name)), /if \(!modesOn\)/u, `${name} is not gated`);
  }
  // ...and the one empty-state line that told the owner to press a chip.
  const line = code(bodyOf(reconnectJs, 'emptyLine'));
  assert.match(line, /!modesOn && reason === 'pool-exhausted-mode'/u);
  assert.match(line, /EMPTY_REASONS\['pool-exhausted'\]/u,
    'a remedy that is not on the screen is worse than the plain sentence');
});

test('onboarding screen 1 keeps the promise and drops the group row', () => {
  // The title is the half that survives: one person a day is still what this
  // app does. Who that person might be is no longer a question it asks.
  assert.match(onboardingHtml, /one person a day, worth getting back to/u);
  const block = /<div class="ob-mode-block" id="modeBlock"[^>]*>/u.exec(onboardingHtml)?.[0] ?? '';
  assert.ok(block, 'the row and its two notes must hide as one block');
  assert.match(block, /\shidden\b/u);
  // The note about the write goes with the row that makes it: a sentence about
  // keeping a choice, under no choice, is the worse half of leaving it behind.
  const blockAt = onboardingHtml.indexOf('id="modeBlock"');
  const noteAt = onboardingHtml.indexOf('kept on this Mac');
  const ctaAt = onboardingHtml.indexOf('id="cta"');
  assert.ok(blockAt > -1 && noteAt > blockAt && noteAt < ctaAt, 'the note must sit inside the block');
  assert.match(code(onboardingJs), /modesOn = hzFeatureOn\(set, 'timeline'\)/u);
  assert.match(code(onboardingJs), /if \(modesOn\) modeBlock\.hidden = false;/u);
  // Nothing the owner can READ on the first screen mentions who the card is for
  // any more. Markup comments are stripped: the decision that removed the row is
  // written down beside it, in the words it removed.
  const visible = onboardingHtml
    .slice(onboardingHtml.indexOf('id="screen"'), blockAt)
    .replace(/<!--[\s\S]*?-->/gu, '');
  assert.doesNotMatch(visible, /founder|investor/iu);
});

test('onboarding writes no mode and screen 6 offers no widening', () => {
  // Both are guards inside the one function that does the thing, so a later
  // caller cannot reach past them.
  const click = code(/modesEl\.addEventListener\('click', \(e\) => \{\n([\s\S]*?)\n\}\);/u.exec(onboardingJs)?.[1] ?? '');
  const clickGuardAt = click.indexOf('if (!modesOn) return;');
  const writeAt = click.indexOf('writeMode(');
  assert.ok(clickGuardAt > -1 && writeAt > clickGuardAt,
    'the hidden row is still wired up, so the guard is what stops the write');
  const enter = code(bodyOf(onboardingJs, 'enterWelcome'));
  const guardAt = enter.indexOf('if (!modesOn) return;');
  const peekAt = enter.indexOf("hzPost('relCardPeek')");
  assert.ok(guardAt > -1 && peekAt > guardAt, 'a peek that only lights a hidden chip is a request not to make');
  const paint = code(bodyOf(onboardingJs, 'paintModeShortfall'));
  const paintGuardAt = paint.indexOf('if (!modesOn) { hideModeShortfall(); return; }');
  const holdAt = paint.indexOf('hzModeHoldLine');
  assert.ok(paintGuardAt > -1 && holdAt > paintGuardAt,
    'the shortfall line and the widen button go together, behind the gate');
  // The verbs stay in the allowlist -- gated, not deleted, so the flag is the
  // only thing between here and the old behaviour.
  const allowed = /"onboarding": \[([\s\S]*?)\],\n/u.exec(bridgeSwift)?.[1] ?? '';
  assert.match(allowed, /"relMode"/u);
  assert.match(allowed, /"relCardPeek"/u);
  const rc = /"reconnect": \[([\s\S]*?)\],\n/u.exec(bridgeSwift)?.[1] ?? '';
  assert.match(rc, /"relMode"/u);
});

test('the settings row reads the cadence, and names a group only where there is one', () => {
  const row = code(bodyOf(connectionsJs, 'cardConfigRow'));
  assert.match(row, /hzFeatureOn\(set, 'timeline'\)/u);
  assert.match(row, /if \(modesOn && typeof cfg\?\.mode === 'string' && cfg\.mode\) bits\.push\(cfg\.mode\)/u,
    'hermes answers `mode` whatever the flag says; the row must not print it');
  assert.match(row, /bits\.push\(`\$\{cfg\.capPerDay\} a day`\)/u, 'the cadence is the part that survives');
  // The hover pointed at three chips that are no longer on the card.
  assert.doesNotMatch(code(connectionsJs), /const CARD_HELP = '[^']*three chips/u);
  assert.match(code(connectionsJs), /const CARD_HELP_MODES = '[^']*three chips/u,
    'the sentence about them is kept for the flag, not deleted');
});

// THE ONE TEST HERE THAT WAS ALREADY TRUE. Every other assertion in this file
// fails against the commit before it; this one is a guard, not a pin on a
// change -- the group was never written by this path, and the tidy-up that
// removed the row is exactly the kind of edit that would add it "for symmetry".
test('the card defaults onboarding writes down carry no mode', () => {
  // Screen 1 says "one person a day" above the button the owner pressed, and
  // this is onboarding writing down what they were shown. It was never the
  // place the group was decided, and with the row gone there is nothing here
  // that could decide one.
  const post = /func postCardDefaults\(attempt: Int\) \{([\s\S]*?)\n  \}/u.exec(bridgeSwift)?.[1] ?? '';
  assert.ok(post, 'postCardDefaults() not found');
  assert.match(code(post), /json: \["capPerDay": 1, "producer": "eligibility"\]/u);
  assert.doesNotMatch(code(post), /"mode"/u);
});
