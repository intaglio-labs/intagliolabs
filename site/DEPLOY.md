# Landing page — deploy

How `site/` reaches the web. Written 2026-08-21 for Firebase Hosting, moved into
this repository with the site on 2026-08-24, rewritten the same day when the
hosting changed.

## How it deploys

Push to `main`. `.github/workflows/site.yml` runs `firebase deploy --only
hosting:intaglio` for any push that touches `site/`, the hosting config, or the
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

    firebase deploy --only hosting:intaglio

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

## Domain — still pending

The site is live on its Firebase Hosting URL for the `intaglio-landing` site as
soon as the workflow runs. Links inside the pages are root-relative, which is
correct for a domain root and is what `cleanUrls` expects.

intaglio.io's apex is host-routed by an external HTTPS load balancer living in a
**separate GCP project that this project does not own**. Two consequences:

1. The planned swap needs access granted from that account. It cannot be done
   from the hosting project alone.
2. That project also serves an unrelated product whose `in.` and `cdn.`
   subdomains are frozen into third-party HTML. **Those must not move**, whatever
   happens to the apex.

When the apex is available it is a Hosting custom-domain add on
`intaglio-landing` plus the DNS records the console prints. Nothing inside the
pages changes: they already assume a domain root.

A ready-to-deploy nginx bundle (Dockerfile, an 8080 conf, index.html) was staged
for Cloud Run as an alternative. If it is used, note it was built before
`privacy/`, `terms/` and `notices/` existed: the conf has to serve those
directory pages too, so copy the whole `site/` tree, not just `index.html`.

*(The owning account and project name are deliberately not written here. This
repository is public, and they are a third party's infrastructure rather than
this project's — see rule 6 in `CLAUDE.md`. Whoever needs them has them.)*
