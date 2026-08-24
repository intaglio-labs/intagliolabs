# Landing page — deploy

How `site/` reaches intaglio.io, and what is still unsettled. Written
2026-08-21, moved into this repository with the site on 2026-08-24.

## How it deploys

`firebase.json` and `.firebaserc` at the repo root are the whole config.
Hosting serves the `site/` directory as-is: `cleanUrls` on, so
`/privacy` resolves to `site/privacy/index.html`, and `DEPLOY.md` is in
the ignore list so this file is never published alongside the pages it
describes.

    firebase deploy --only hosting:intaglio

## Trina — settled 2026-08-21

The sleeping orb's z's are set in **Trina**. The licence was confirmed by
the owner, and the font is now vendored: subset to the single glyph the
page uses (lowercase `z`, which in Trina draws the display capital),
converted to woff2, and served from the site's own origin at
`site/fonts/trina-z.woff2` — 576 bytes, with an `@font-face` block in
`index.html`.

The mono fallback is kept in the stack on purpose, so a visitor who
blocks the font still gets readable z's rather than tofu.

~~Trina is a user-installed font on the owner's Mac and is not vendored;
the licence is unknown, so deployed as-is every visitor gets mono z's.~~
Struck rather than deleted because this file asserted it for three days
after `index.html` recorded the opposite, and the next reader deserves to
see which way it was resolved.

## The download button

`site/index.html` links `/intagliolabs.dmg` directly, and `firebase.json`
redirects `/Hazlie.dmg` to the same object with a 301, so an older link
still lands.

**Confirm this before the next release.** On 2026-08-23 a separate
session rebuilt the DMG from public `main` and reported serving it from
Cloud Storage behind a redirect, at a size (~5.4 GB) that Firebase
Hosting will not serve. If that is the live path, then the direct link in
`index.html` and the redirect in `firebase.json` are both describing the
older arrangement and need updating together. Not corrected here, because
the arrangement cannot be verified from inside this repository and
guessing at it would put a third wrong answer in a third file.

New releases: `widget/release.sh`, then publish the DMG wherever the
answer above turns out to be, and redeploy.

## Domain — still pending

intaglio.io's apex is currently host-routed by an external HTTPS load
balancer living in a **separate GCP project that this project does not
own**. Two consequences:

1. The planned swap needs access granted from that account. It cannot be
   done from the hosting project alone.
2. That project also serves an unrelated product whose `in.` and `cdn.`
   subdomains are frozen into third-party HTML. **Those must not move**,
   whatever happens to the apex.

A ready-to-deploy nginx bundle (Dockerfile, an 8080 conf, index.html) was
staged for Cloud Run as an alternative. If it is used, note it was built
before `privacy/`, `terms/` and `notices/` existed: the conf has to serve
those directory pages too, so copy the whole `site/` tree, not just
`index.html`.

*(The owning account and project name are deliberately not written here.
This repository is public, and they are a third party's infrastructure
rather than this project's — see rule 6 in `CLAUDE.md`. Whoever needs
them has them.)*
