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

### The deploy credential — already set up

Done on 2026-08-24. Recorded because the next person will want to know what
exists, not how to create it again.

- Service account **`gh-deploy-site@hazlie-prod.iam.gserviceaccount.com`**,
  holding exactly one role: `roles/firebasehosting.admin`. That is the narrowest
  role that can deploy — not Editor, not Owner — and it was verified by deploying
  as the service account rather than assumed from the docs.
- One user-managed key, stored as the repository secret
  **`FIREBASE_SERVICE_ACCOUNT`**. GitHub will not read a secret back out, so if it
  is ever lost the fix is a new key and a `gcloud ... keys delete` on the old one,
  not a recovery.

`firebase init hosting:github` does all of this in one command and is the usual
way. It was not used here for two reasons: it needs an interactive GitHub OAuth
in a browser, and it writes its own pair of workflow files, which would sit
alongside `site.yml` deploying the same site on overlapping triggers. The
equivalent, non-interactively:

    gcloud iam service-accounts create gh-deploy-site \
        --project hazlie-prod --display-name "GitHub Actions — site deploy"

    gcloud projects add-iam-policy-binding hazlie-prod \
        --member "serviceAccount:gh-deploy-site@hazlie-prod.iam.gserviceaccount.com" \
        --role roles/firebasehosting.admin --condition=None

    KEY=$(mktemp -d)/key.json
    gcloud iam service-accounts keys create "$KEY" \
        --iam-account gh-deploy-site@hazlie-prod.iam.gserviceaccount.com
    gh secret set FIREBASE_SERVICE_ACCOUNT \
        --repo intaglio-labs/privateAndPersonalizedOS < "$KEY"
    rm -f "$KEY"

**Delete the key file, and check `keys list` afterwards.** Removing the local copy
does not remove the key from the service account — a key whose material nobody
holds is still a credential that can be issued against. Verifying a permission by
minting a second key leaves exactly that behind, which is why the check above ends
with a delete.

### What it refuses to publish

Two checks run before the deploy, and either one fails the run:

1. **Internal links.** Every reference is resolved the way Hosting serves it
   (`cleanUrls` on), against the files that actually exist. A typo in a footer
   link would otherwise ship and 404 for every visitor.
2. **The download link.** It is an external permalink to the newest release; if
   it stops resolving, every visitor's download is broken and nothing on the page
   would show it.

## The download button

One link, to one place:

    https://github.com/intaglio-labs/privateAndPersonalizedOS/releases/latest/download/IntaglioLabs.dmg

GitHub resolves `latest` at request time, so publishing a release is publishing
the download. The site does not change between versions and there is nothing to
remember. The asset name is unversioned so that permalink keeps working; the
version lives in the release tag, the DMG volume name and Info.plist.

**There are no redirects.** An earlier pass added three — `/download`,
`/Hazlie.dmg` and `/intagliolabs.dmg`, all pointing at that same URL — and they
were removed on 2026-08-24 after checking which had ever been real:

- `/intagliolabs.dmg` never was. It came from a `firebase.json` in this repository
  that did not match what was deployed.
- `/Hazlie.dmg` was already a legacy alias, redirecting to `/download`.
- `/download` was the live button target for about a day, on a site with no
  users yet.

Three config entries preserving one day-old URL on a pre-launch page is not
caution, it is clutter — and it made a four-page static site look like it had a
routing layer. If a real link turns up in the wild, one entry brings it back.

New releases: `widget/release.sh`, then attach the DMG to a GitHub release as
`IntaglioLabs.dmg`. No site deploy is needed for a new version.

## Trina — settled 2026-08-21

The sleeping orb's z's are set in **Trina**. The licence was confirmed by the
owner, and the font is vendored: subset to the single glyph the page uses
(lowercase `z`, which in Trina draws the display capital), converted to woff2,
and served from the site's own origin at `site/fonts/trina-z.woff2` — 576 bytes,
with an `@font-face` block in `index.html`.

The mono fallback is kept in the stack on purpose, so a visitor who blocks the
font still gets readable z's rather than tofu.

## Domain — done

**intaglio.io is live on the default site.** Moved 2026-08-24 and verified from
outside: `HTTP/2 200`, serving this repository's page, with the download button
pointing at the GitHub release.

The move: the domain was attached to a second site, `intaglio-landing`, which this
repository did not deploy — so the apex served a release pushed by hand while
deploys landed somewhere else. The domain now sits on `hazlie-prod`, the project's
default site and the one `firebase.json` names, and `intaglio-landing` is deleted.
One site, one deploy target, one URL.

~~intaglio.io's apex is host-routed by an external HTTPS load balancer in a
separate GCP project that this project does not own... the planned swap needs
access granted from that account.~~ Struck rather than deleted: this file asserted
it for three days while the apex was in fact already connected to Firebase
Hosting, and the next reader should be able to see which way it resolved.

Custom domains are **console-only**. The CLI has no command for them —
`hosting:sites:*` creates, deletes and lists sites and nothing else — so if the
domain ever has to move again it is four manual steps, and two of them bite:
the certificate is re-provisioned on the receiving site, so the apex serves a
warning or stale content until it lands; and deleting a site while a domain is
still attached takes that domain down.

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
