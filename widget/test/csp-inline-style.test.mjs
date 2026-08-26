// No page may render a style ATTRIBUTE its own CSP will throw away.
//
// WHY THIS EXISTS. people-sky.js rendered each person's warmth as
// `style="background:…"` on the dot, and people-sky.html ships
// `style-src 'self'` with no 'unsafe-inline' — which blocks style attributes.
// .pl-dot carries no background in the stylesheet, so the inline value was the
// dot's only source of colour and it never applied. Every warmth dot computed to
// rgba(0,0,0,0). Verified in a real engine: the styled dot and an unstyled one
// had identical computed backgrounds while the attribute sat in the DOM.
//
// THAT INSTANCE IS GONE. people-sky.js and its warmth dot were yeeted
// 2026-08-24 when the timeline (people-months) absorbed the list's job; rows
// carry a message count and source glyphs now, and nothing renders .pl-dot.
// A second test used to pin that dot specifically and was left reading the
// deleted file, so it failed with ENOENT on a clean checkout — red for
// everyone, for a feature that no longer exists. Deleted rather than
// repointed: no current page paints a dot, so any file it was aimed at would
// have passed by accident and pinned nothing. The class check below is the
// part that was always the point, and it still scans every page. Its .pl-dot
// rule and six other orphaned selectors went from people-sky.css with it.
//
// The failure is invisible by construction. CSP writes one line to a console,
// inside a native app, with no devtools — so nothing surfaces, nothing throws,
// and the feature is just quietly absent. That is the class this test closes,
// not the single instance: the fix (assign through element.style, which CSP does
// not gate) is easy, and remembering to reach for it two years from now is not.
//
// DELIBERATELY BLUNT, like the egress tripwire: it matches any generated
// `style="` in page JavaScript, including in a comment. If you need to write the
// pattern in prose, reword the prose — the cost of a false positive is one
// sentence, and the cost of a false negative is a feature nobody can see.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

// Which pages permit inline styles, read from the page's own CSP.
function pagesAllowingInlineStyle() {
  const allowed = new Set();
  const pages = new Map();
  for (const name of readdirSync(UI)) {
    if (!name.endsWith('.html')) continue;
    const html = readFileSync(join(UI, name), 'utf8');
    const csp = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/u.exec(html);
    const page = name.replace(/\.html$/u, '');
    const policy = csp?.[1] ?? '';
    pages.set(page, {
      scripts: [...html.matchAll(/src="([^"]+\.js)"/gu)].map((m) => m[1]),
      // No CSP at all would mean no restriction; there is none such today, and
      // the assertion below makes sure of it.
      hasCsp: csp !== null,
      inlineOk: /style-src[^;]*'unsafe-inline'/u.test(policy),
    });
    if (/style-src[^;]*'unsafe-inline'/u.test(policy)) allowed.add(page);
  }
  return { pages, allowed };
}

const { pages } = pagesAllowingInlineStyle();

test('every page carries a CSP', () => {
  const bare = [...pages].filter(([, p]) => !p.hasCsp).map(([n]) => n);
  assert.deepEqual(bare, [], `pages with no Content-Security-Policy: ${bare.join(', ')}`);
});

test('no page generates a style attribute its CSP would block', () => {
  const offences = [];
  for (const [page, { scripts, inlineOk }] of pages) {
    if (inlineOk) continue; // this page opted in, deliberately
    for (const script of scripts) {
      let text;
      try {
        text = readFileSync(join(UI, script), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        // A generated attribute: style=" with an interpolation inside it.
        if (/style="[^"]*\$\{/u.test(line)) {
          offences.push(`${page} → ${script}: ${line.trim().slice(0, 76)}`);
        }
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    `a style attribute is generated on a page whose CSP blocks inline styles, so ` +
      `it will be silently dropped. Assign through element.style after insertion ` +
      `instead — CSP gates the parsed attribute, not the CSSOM:\n  ${offences.join('\n  ')}`
  );
});
