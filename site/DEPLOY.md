# Landing page — deploy

How `site/` reaches the web. Written 2026-08-21 for Firebase Hosting, moved into
this repository with the site on 2026-08-24, rewritten the same day when the
hosting changed.

## How it deploys

Push to `main`. `.github/workflows/site.yml` runs `firebase deploy --only
hosting` for any push that touches `site/`, the hosting config, or the
workflow — and nowhere else, because the app and the backend share this
repository and change constantly, and redeploying identical HTML on each of those
commits only makes the deployment history unreadable. It can also be run by hand
from the Actions tab, which is what to do after a DNS change rather than pushing
an empty commit.

The hosting is unchanged: `firebase.json` and `.firebaserc` at the repo root are
still the whole config, `cleanUrls` is still on so `/privacy` resolves to
`site/privacy/index.html`, and `DEPLOY.md` is still in the ignore list so this
file is never published alongside the pages it describes. What changed is that
nobody has to remember to run the deploy — the site went stale exactly whenever
that step was skipped, which is the failure a pipeline exists to remove.

Still works by hand, unchanged, when that is what you want:

    firebase deploy --only hosting

### The one thing to set up

A repository secret named **`FIREBASE_SERVICE_ACCOUNT`**, containing the whole
JSON key of a service account on `hazlie-prod` with the **Firebase Hosting Admin**
role:

    gcloud iam service-accounts create gh-deploy-site \
        --project hazlie-prod --display-name "GitHub Actions — site deploy"

    gcloud projects add-iam-policy-binding hazlie-prod \
        --member "serviceAccount:gh-deploy-site@hazlie-prod.iam.gserviceaccount.com" \
        --role roles/firebasehosting.admin

    gcloud iam service-accounts keys create key.json \
        --iam-account gh-deploy-site@hazlie-prod.iam.gserviceaccount.com

Then paste the contents of `key.json` into Settings → Secrets and variables →
Actions → New repository secret, and **delete `key.json`**. The workflow writes it
to a file the runner discards and passes it by path; it is never echoed and never
committed. Hosting Admin is the narrowest role that can deploy — not Editor, and
not Owner.

Until that secret exists the workflow fails on its own first line and says so,
rather than half-deploying.

### What it refuses to publish

Two checks run before the deploy, and either one fails the run:

1. **Internal links.** Every reference is resolved the way Hosting serves it
   (`cleanUrls` on), against the files that actually exist. A typo in a footer
   link would otherwise ship and 404 for every visitor.
2. **The download link.** It is an external permalink to the newest release; if
   it stops resolving, every visitor's download is broken and nothing on the page
   would show it.

## The download button

`site/index.html` links to:

    https://github.com/intaglio-labs/privateAndPersonalizedOS/releases/latest/download/IntaglioLabs.dmg

GitHub resolves `latest` at request time, so **publishing a release is publishing
the download** — the site does not change and nobody has to remember to update a
link. The asset name is deliberately unversioned so the permalink keeps working
across versions; the version lives in the release tag, the DMG's volume name and
the app's Info.plist.

Both legacy paths follow it. `firebase.json` 301s `/Hazlie.dmg` **and**
`/intagliolabs.dmg` to that permalink, because both are loose in other people's
bookmarks and messages, and both used to point at a self-hosted object.

~~`site/index.html` links `/intagliolabs.dmg` directly.~~ Struck rather than
deleted, because the uncertainty this file recorded on 2026-08-23 — whether the
DMG was really served from Cloud Storage behind a redirect, at a size Firebase
Hosting will not serve — is now **resolved by removal** rather than answered.
Hosting serves no binary at all; the artifact lives on the release that produced
it, and nothing here has a size limit to argue with. The self-hosted object can
be deleted from the bucket.

New releases: `widget/release.sh`, then attach the DMG to a GitHub release as
`IntaglioLabs.dmg`. The site needs no redeploy for a new version.

## Trina — settled 2026-08-21

The sleeping orb's z's are set in **Trina**. The licence was confirmed by the
owner, and the font is vendored: subset to the single glyph the page uses
(lowercase `z`, which in Trina draws the display capital), converted to woff2,
and served from the site's own origin at `site/fonts/trina-z.woff2` — 576 bytes,
with an `@font-face` block in `index.html`.

The mono fallback is kept in the stack on purpose, so a visitor who blocks the
font still gets readable z's rather than tofu.

## Domain — connected, and mid-move

**intaglio.io is live on Firebase Hosting.** It is `Connected` as a custom domain
and serving, verified 2026-08-24 (`HTTP/2 200`, HSTS, Firebase cache headers).

~~intaglio.io's apex is host-routed by an external HTTPS load balancer in a
separate GCP project that this project does not own... the planned swap needs
access granted from that account.~~ Struck rather than deleted, because this file
asserted it for three days and the next reader deserves to see which way it
resolved. Whatever was true on 2026-08-21, the apex reaches Hosting now.

### Where it points, and where it is going

The domain is attached to the **`intaglio-landing`** site. This repository now
deploys the project's **default** site, `hazlie-prod` — so until the domain moves,
`intaglio.io` still serves the older release that was pushed by hand on 2026-08-23,
and this repository's deploys land on `hazlie-prod.web.app`.

Moving it is a console operation. The CLI has no custom-domain commands
(`hosting:sites:*` creates, deletes and lists sites and nothing else), so it is
not automatable from here:

1. Hosting → `intaglio-landing` → Domains → remove **intaglio.io**.
2. Hosting → `hazlie-prod` → Add custom domain → **intaglio.io**.
3. Wait for the certificate. Firebase re-provisions on the new site; the DNS
   records do not change, but there is a window where the apex serves a
   certificate warning or the old content. **Do this when a short gap is
   acceptable.**
4. Only then delete `intaglio-landing` (`firebase hosting:sites:delete
   intaglio-landing --project hazlie-prod`). **Deleting it while the domain is
   still attached takes intaglio.io down.**

### The .web.app URLs

Firebase Hosting has **no host-based redirect** — `redirects` in `firebase.json`
match on path only, so `hazlie-prod.web.app` cannot be 301'd to `intaglio.io`
from config. The options, none of them free:

- Leave it. Both hosts serve the same pages; search engines get a `canonical`
  hint if one is added to the pages.
- A few lines of JavaScript in `index.html` that redirect when `location.host` is
  not the canonical one. It is client-side, so it does not help a crawler that
  does not run scripts, and it puts logic in a page that currently has none.

Not chosen here, because it is a preference rather than a defect.

*(The owning account and project name are deliberately not written here. This
repository is public, and they are a third party's infrastructure rather than
this project's — see rule 6 in `CLAUDE.md`. Whoever needs them has them.)*
