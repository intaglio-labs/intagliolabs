// `el.hidden = true` IS NOT A HIDING RULE, IT IS A REQUEST FOR ONE.
//
// The user-agent stylesheet's `[hidden] { display: none }` is user-agent
// origin, and the cascade puts EVERY author declaration above it — specificity
// never enters into it. So any rule in reconnect.css that sets `display` on an
// element reconnect.js hides silently defeats the hiding: the property
// changes, the element stays on screen, and the symptom looks like broken
// logic rather than a missing line of CSS.
//
// That is exactly what shipped. `.rc-facts div { display: flex }` meant
// `rcRoleRow.hidden = true` (any card carrying a `who` string, which blanks
// the role) and `rcLeftRow.hidden = true` (any card with no `left`) rendered
// the bare labels "who they are" and "how you left it" above empty values.
// `#rcCard` and `.rc-modes` had the same defect one step up.
//
// palette.css records this lesson in prose at "[hidden] LOSES TO A CLASS THAT
// SETS display" and answers it with per-selector companions; the knowledge
// just never travelled to this file. This test is the part that travels: it
// reads the ids reconnect.js hides out of the JS, finds them in the HTML, and
// fails if any author rule sets `display` on one of them without a `[hidden]`
// companion that outranks it.
//
// Source scan, like the other widget tests — no toolchain, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = join(ROOT, 'widget', 'ui');
const html = readFileSync(join(UI, 'reconnect.html'), 'utf8');
const js = readFileSync(join(UI, 'reconnect.js'), 'utf8');

// EVERY SHEET THE PAGE LOADS, not the one named after it.
//
// The cascade does not care which file a rule is written in, and reconnect.html
// loads palette.css above reconnect.css. A `display` rule on a toggled id in
// palette.css defeats `el(id).hidden = true` exactly as one in reconnect.css
// does, and reading only the small file meant the guard passed on the larger
// half of its own subject.
const sheetNames = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu)]
  .map((m) => m[1]);
const sheets = sheetNames.map((name) => ({
  name,
  text: readFileSync(join(UI, name), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, ''),
}));
const css = sheets.map((s) => s.text).join('\n');

// ---------------------------------------------------------------- the page

/// Every element the page hides or shows by the `hidden` property.
///
/// TWO SPELLINGS, because there are two. `el('rcCard').hidden = …` is the one
/// reconnect.js uses today; a cached reference — `const row = el('rcRoleRow')`
/// and then `row.hidden = …`, the style onboarding.js uses for loadDormant —
/// is the same act and was invisible to this guard. The names are resolved
/// back to ids through their declarations, and a toggle whose id cannot be
/// resolved FAILS rather than being skipped: a guard that quietly ignores what
/// it cannot parse is how this page lost its hiding rules the first time.
const directIds = [...js.matchAll(/el\('([A-Za-z0-9_]+)'\)\.hidden\s*=/gu)].map((m) => m[1]);

const cachedNames = [...js.matchAll(/(?<![.'"\w])([A-Za-z_$][\w$]*)\.hidden\s*=[^=]/gu)]
  .map((m) => m[1]);

/// `const name = el('id')` / `= document.getElementById('id')`.
function idForName(name) {
  const re = new RegExp(
    `(?:const|let|var)\\s+${name}\\s*=\\s*(?:el|document\\.getElementById)\\(\\s*['"]([A-Za-z0-9_]+)['"]`,
    'u'
  );
  return re.exec(js)?.[1] ?? null;
}

const unresolved = [];
const cachedIds = [];
for (const name of new Set(cachedNames)) {
  const id = idForName(name);
  if (id) cachedIds.push(id);
  else unresolved.push(name);
}

const toggledIds = [...new Set([...directIds, ...cachedIds])].sort();

/// Tag, own classes and ancestor classes for one id, from the markup. A
/// deliberately small parser: reconnect.html is a static fragment of plain
/// tags, and the alternative is a DOM dependency for three facts.
function elementFor(id) {
  const open = /<([a-z]+)([^>]*)>/giu;
  const stack = [];
  let found = null;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const [whole, tag, attrs] = m;
    const classes = (/class="([^"]*)"/u.exec(attrs)?.[1] ?? '').split(/\s+/u).filter(Boolean);
    // Close every element that ended before this one opened.
    const closes = [...html.slice(0, m.index).matchAll(/<\/([a-z]+)>/giu)];
    stack.length = 0;
    // Re-walk from the top: cheap enough for a file this size and immune to
    // the self-closing/void-element cases a running tally gets wrong.
    const before = html.slice(0, m.index);
    const opens = [...before.matchAll(/<([a-z]+)([^>]*?)(\/?)>/giu)];
    const depth = [];
    let closeAt = 0;
    for (const o of opens) {
      while (closeAt < closes.length && closes[closeAt].index < o.index) {
        depth.pop();
        closeAt += 1;
      }
      if (o[3] === '/' || ['br', 'img', 'input', 'hr', 'meta', 'link'].includes(o[1].toLowerCase())) continue;
      depth.push((/class="([^"]*)"/u.exec(o[2])?.[1] ?? '').split(/\s+/u).filter(Boolean));
    }
    while (closeAt < closes.length && closes[closeAt].index < m.index) {
      depth.pop();
      closeAt += 1;
    }
    if (new RegExp(`id="${id}"`, 'u').test(whole)) {
      found = { id, tag: tag.toLowerCase(), classes, ancestors: depth.flat() };
      break;
    }
  }
  return found;
}

// -------------------------------------------------------------- the cascade

/// (ids, classes+attributes, types) — the ordinary three-number specificity.
function specificity(selector) {
  const ids = (selector.match(/#[A-Za-z0-9_-]+/gu) ?? []).length;
  const classes = (selector.match(/\.[A-Za-z0-9_-]+/gu) ?? []).length
    + (selector.match(/\[[^\]]+\]/gu) ?? []).length;
  const types = (selector.replace(/#[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+|\[[^\]]+\]/gu, '')
    .match(/\b[a-z]+\b/gu) ?? []).length;
  return [ids, classes, types];
}

const higherOrEqual = (a, b) => a[0] !== b[0] ? a[0] > b[0]
  : a[1] !== b[1] ? a[1] > b[1]
  : a[2] >= b[2];

/// Does this selector match the element? Supports exactly the shapes this
/// stylesheet uses: `#id`, `.class`, `tag`, `[hidden]`, and a descendant
/// chain of those.
function matches(selector, el, { requireHidden }) {
  const parts = selector.trim().split(/\s+/u);
  const last = parts[parts.length - 1];
  const hasHidden = /\[hidden\]/u.test(last);
  if (requireHidden !== hasHidden) return false;
  const simple = last.replace(/\[hidden\]/gu, '');
  const id = /#([A-Za-z0-9_-]+)/u.exec(simple)?.[1];
  if (id && id !== el.id) return false;
  for (const cls of (simple.match(/\.([A-Za-z0-9_-]+)/gu) ?? []).map((c) => c.slice(1))) {
    if (!el.classes.includes(cls)) return false;
  }
  const tag = simple.replace(/#[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+/gu, '').trim();
  if (tag && tag !== el.tag) return false;
  // Ancestors, loosely: every earlier part has to name a class the element
  // actually sits inside.
  for (const part of parts.slice(0, -1)) {
    for (const cls of (part.match(/\.([A-Za-z0-9_-]+)/gu) ?? []).map((c) => c.slice(1))) {
      if (!el.ancestors.includes(cls) && !el.classes.includes(cls)) return false;
    }
  }
  return true;
}

/// Every rule in every sheet, comments stripped, split on selector groups.
const rules = [];
for (const sheet of sheets) {
  for (const m of sheet.text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const body = m[2];
    const display = /(^|;)\s*display\s*:\s*([^;]+)/u.exec(body)?.[2]?.trim();
    if (!display) continue;
    for (const selector of m[1].split(',')) {
      if (!selector.trim() || selector.includes('@')) continue;
      rules.push({ selector: selector.trim(), display, sheet: sheet.name });
    }
  }
}

test('every stylesheet the page loads is the subject, not just its own', () => {
  assert.ok(sheetNames.length >= 2, 'reconnect.html loads more than one sheet; read them all');
  assert.ok(sheetNames.includes('palette.css'),
    'palette.css is loaded first and its display rules win the same way');
  assert.ok(sheetNames.includes('reconnect.css'));
  for (const sheet of sheets) {
    assert.ok(rules.some((r) => r.sheet === sheet.name),
      `no display rules parsed out of ${sheet.name} — the parser has stopped seeing it`);
  }
});

test('a toggle this guard cannot resolve to an id fails it', () => {
  // A cached reference the declaration scan cannot follow is not "no toggle",
  // it is a toggle with no guard on it. Say so rather than passing.
  assert.deepEqual(unresolved, [],
    `hidden is set on ${unresolved.join(', ')}, and this guard cannot tell which element that is`);
});

test('reconnect.js hides things, and the sheets it loads let it', () => {
  assert.ok(toggledIds.length >= 8, 'the .hidden toggles in reconnect.js were not found');
  assert.ok(rules.length > 0, 'no display rules parsed out of the page\'s stylesheets');

  const defeated = [];
  for (const id of toggledIds) {
    const el = elementFor(id);
    if (!el) continue; // built in JS, or lives in another page
    for (const rule of rules) {
      if (rule.display === 'none') continue;
      if (!matches(rule.selector, el, { requireHidden: false })) continue;
      // An author rule sets display on an element the page hides. There has to
      // be a [hidden] companion that outranks it.
      const answered = rules.some((other) => other.display === 'none'
        && matches(other.selector, el, { requireHidden: true })
        && higherOrEqual(specificity(other.selector), specificity(rule.selector)));
      if (!answered) {
        defeated.push(`#${id} stays visible: "${rule.selector}" sets display (${rule.sheet})`);
      }
    }
  }
  assert.deepEqual(defeated, [], defeated.join('\n'));
});

test('the three companions are the three this file needs', () => {
  // Named as well as derived, because the derivation above would also pass if
  // somebody deleted the rules that set display — and the layout, not the
  // hiding, is what those rules are for.
  const stripped = sheets.find((s) => s.name === 'reconnect.css').text;
  assert.match(stripped, /\.rc-facts div \{[^}]*display:\s*flex/u, 'the fact rows are still flex rows');
  assert.match(stripped, /\.rc-facts div\[hidden\]\s*\{\s*display:\s*none/u,
    'rcRoleRow/rcLeftRow: the live symptom in review finding 1');
  assert.match(stripped, /#rcCard\[hidden\]\s*\{\s*display:\s*none/u,
    'rcCard: the empty state left the stale card underneath it');
  assert.match(stripped, /\.rc-modes\[hidden\]\s*\{\s*display:\s*none/u,
    'rcModes: the picker never hid either');
});
