# Landing page — deploy

How `site/` reaches the web. Written 2026-08-21 for Firebase Hosting, moved into
this repository with the site on 2026-08-24, rewritten the same day when the
hosting changed.

## How it deploys

Push to `main`. That is the whole of it.

`.github/workflows/site.yml` publishes `site/` to GitHub Pages on any push that
touches the site or the workflow, and nowhere else — the app and the backend
share this repository and change constantly, and redeploying identical HTML on
every one of those commits only makes the deployment history harder to read. The
workflow can also be run by hand from the Actions tab, which is what to do after
a DNS change rather than pushing an empty commit.

There is no build step and the workflow deliberately does not invent one: it
uploads the directory as it stands, so what is reviewed in a diff is exactly what
is served.

**There is no secret to hold.** `deploy-pages` authenticates with the
repository's own OIDC token. Nothing has to be stored, rotated, or kept out of
the diff.

### What it refuses to publish

Two checks run before anything is uploaded, and either one fails the deploy:

1. **Internal links.** Every reference in the site is relative, which is what
   lets the pages work under a project-Pages path today and at an apex domain
   later without an edit. A root-relative `href` reintroduced by hand would 404
   under the path prefix — in production, silently. The check rejects it here.
2. **The download link.** It is an external permalink to the newest release; if
   it stops resolving, every visitor's download is broken and nothing on the page
   would show it.

~~`firebase.json` and `.firebaserc` at the repo root are the whole config.~~
Struck rather than deleted: Firebase Hosting needed a service-account secret, a
second console, and a `firebase deploy` somebody had to remember to run. The site
went stale whenever that last step was skipped, which is the failure a deploy
pipeline exists to remove. Both files are gone.

## The download button

`site/index.html` links to:

    https://github.com/intaglio-labs/privateAndPersonalizedOS/releases/latest/download/IntaglioLabs.dmg

GitHub resolves `latest` at request time, so **publishing a release is publishing
the download** — the site does not change and nobody has to remember to update a
link. The asset name is deliberately unversioned so that permalink keeps working;
the version lives in the release tag, the DMG's volume name and the app's
Info.plist.

`widget/release.sh` builds, signs, notarizes and staples. Attach the DMG to a
GitHub release as `IntaglioLabs.dmg` and the site is current.

~~`site/index.html` links `/intagliolabs.dmg` directly, and `firebase.json`
redirects `/Hazlie.dmg` to the same object with a 301.~~ Both are gone with the
hosting. The 301 is not reproduced: Pages serves static files and cannot rewrite,
and it pointed at a self-hosted object that no longer exists anywhere, so
preserving it would only turn a 404 into a redirect to a 404.

The uncertainty this file recorded on 2026-08-23 — whether the DMG was really
served from Cloud Storage behind a redirect, at a size Firebase Hosting would not
serve — is **resolved by removal**. There is no self-hosted object and no size
limit to argue with; the artifact lives on the release that produced it.

## Trina — settled 2026-08-21

The sleeping orb's z's are set in **Trina**. The licence was confirmed by the
owner, and the font is vendored: subset to the single glyph the page uses
(lowercase `z`, which in Trina draws the display capital), converted to woff2,
and served from the site's own origin at `site/fonts/trina-z.woff2` — 576 bytes,
with an `@font-face` block in `index.html`.

The mono fallback is kept in the stack on purpose, so a visitor who blocks the
font still gets readable z's rather than tofu.

## Domain — still pending, and no longer blocking

The site is live at its GitHub Pages URL as soon as Pages is enabled for this
repository (Settings → Pages → Source: GitHub Actions). Because every internal
link is relative, it works there under a path prefix with no edit — which is the
difference between "pending" and "blocked".

intaglio.io's apex is host-routed by an external HTTPS load balancer in a
**separate GCP project that this project does not own**, so pointing the apex
here still needs access granted from that account. That project also serves an
unrelated product whose `in.` and `cdn.` subdomains are frozen into third-party
HTML; **those must not move**, whatever happens to the apex.

When the apex is available: add a `CNAME` file containing the domain to `site/`,
set it under Settings → Pages, and point DNS at GitHub. The relative links mean
nothing inside the pages has to change.

*(The owning account and project name are deliberately not written here. This
repository is public, and they are a third party's infrastructure rather than
this project's — see rule 6 in `CLAUDE.md`. Whoever needs them has them.)*
