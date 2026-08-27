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

Done on 2026-08-24, moved to the `intagliolabs` project on 2026-08-27. Recorded
because the next person will want to know what exists, not how to create it
again.

- Service account **`gh-deploy-site@intagliolabs.iam.gserviceaccount.com`**,
  holding exactly one role: `roles/firebasehosting.admin`. That is the narrowest
  role that can deploy — not Editor, not Owner — and it was verified by deploying
  as the service account rather than assumed from the docs.

  ~~`gh-deploy-site@hazlie-prod.iam.gserviceaccount.com`.~~ The site moved
  projects; see "Which project serves the site" below.
- ~~One user-managed key, stored as the repository secret
  `FIREBASE_SERVICE_ACCOUNT`.~~ **There is no key and no secret any more.** The
  `intaglio.io` organization enforces
  `constraints/iam.disableServiceAccountKeyCreation`, so `keys create` fails with
  FAILED_PRECONDITION and a downloadable key cannot be minted at all. Deploys use
  **Workload Identity Federation** instead: GitHub mints a short-lived OIDC token
  for the workflow run, Google exchanges it for an access token that expires in an
  hour, and nothing long-lived exists to leak. A better position than the key it
  replaced, arrived at by being refused the key.

  The pieces, all in the `intagliolabs` project: workload identity pool `github`,
  OIDC provider `github` trusting `https://token.actions.githubusercontent.com`
  under the attribute condition
  `assertion.repository=='intaglio-labs/intagliolabs'`, and a
  `roles/iam.workloadIdentityUser` binding on the service account restricted to
  that same repository's principalSet. A fork cannot use it; another repository in
  the org cannot use it.

  The file the workflow writes is **not** a credential — it is the public recipe
  for the exchange. The one sensitive value is the per-run bearer GitHub puts in
  `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, scoped to that job and dead with it.

  Two spellings of the provider appear in that file and they are not
  interchangeable: the credential's `audience` uses `//iam.googleapis.com/…`
  (matching what `gcloud iam workload-identity-pools create-cred-config` emits),
  while the audience GitHub is asked to mint the token for uses
  `https://iam.googleapis.com/…`, which is what the provider validates. Getting
  the second wrong fails at token exchange, not at deploy, so the error does not
  name the cause.

`firebase init hosting:github` does all of this in one command and is the usual
way. It was not used here for two reasons: it needs an interactive GitHub OAuth
in a browser, and it writes its own pair of workflow files, which would sit
alongside `site.yml` deploying the same site on overlapping triggers. The
equivalent, non-interactively:

    gcloud iam service-accounts create gh-deploy-site \
        --project intagliolabs --display-name "GitHub Actions — site deploy"

    gcloud projects add-iam-policy-binding intagliolabs \
        --member "serviceAccount:gh-deploy-site@intagliolabs.iam.gserviceaccount.com" \
        --role roles/firebasehosting.admin --condition=None

    gcloud iam workload-identity-pools create github \
        --project intagliolabs --location global --display-name "GitHub Actions"

    gcloud iam workload-identity-pools providers create-oidc github \
        --project intagliolabs --location global --workload-identity-pool github \
        --issuer-uri "https://token.actions.githubusercontent.com" \
        --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
        --attribute-condition "assertion.repository=='intaglio-labs/intagliolabs'"

    gcloud iam service-accounts add-iam-policy-binding \
        gh-deploy-site@intagliolabs.iam.gserviceaccount.com \
        --project intagliolabs --role roles/iam.workloadIdentityUser \
        --member "principalSet://iam.googleapis.com/projects/132328050370/locations/global/workloadIdentityPools/github/attribute.repository/intaglio-labs/intagliolabs"

**The attribute condition is the fence.** Without it the provider would trust an
assertion from any repository on GitHub, and the principalSet binding would be all
that stood between a stranger's workflow and this service account. Set both, not
one.

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

    https://github.com/intaglio-labs/intagliolabs/releases/latest/download/IntaglioLabs.dmg

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

## Which project serves the site — moved 2026-08-27

The site is served by the **`intagliolabs`** Firebase project, in the
`intaglio.io` organization, under **austin@intaglio.io**. The hosting site id is
also `intagliolabs` (`https://intagliolabs.web.app`).

~~`hazlie-prod`, under ay@austinyoshino.com.~~ Moved so that everything lives in
one organization under the company account instead of a personal one. Note the
two ids that had to move together: `.firebaserc` names the **project**,
`firebase.json` names the hosting **site**. They happen to share a name in both
the old and the new setup, which makes it easy to change one and miss the other
— and missing one fails the deploy with a site-not-found rather than anything
that names the real cause.

Two things learned doing it, both of which cost time:

- **`projects:addFirebase` cannot be done from the CLI for the first project in
  an organization.** It returns a bare `PERMISSION_DENIED` with no detail even
  when the caller holds `roles/owner` and `testIamPermissions` confirms
  `firebase.projects.update`. The cause is the org-level terms of service, which
  only the console can present. Enabling `firebase`, `firebasehosting`,
  `cloudresourcemanager` and `serviceusage` first is necessary but not
  sufficient.
- **`gcloud auth print-access-token` does not carry the Firebase scope.** Its
  default scope set includes `cloud-platform`, which sounds sufficient and is
  not; the Firebase Management API wants
  `https://www.googleapis.com/auth/firebase`. Use the Firebase CLI, which asks
  for the right scopes, rather than curl with a gcloud token.

## Trina — settled 2026-08-21

The orb's z's are set in **Trina**. The licence was confirmed by the
owner, and the font is vendored: subset to the single glyph the page uses
(lowercase `z`, which in Trina draws the display capital), converted to woff2,
and served from the site's own origin at `site/fonts/trina-z.woff2` — 576 bytes,
with an `@font-face` block in `index.html`.

~~The z's are the orb's idle state: it is asleep.~~ Not since the 2026-08-27
landing redesign — that orb is awake, and the z's are invisible until the
jackpot easter egg borrows them as coins off the top of the machine. The font
still ships, and is still the only thing the woff2 is there for.

The mono fallback is kept in the stack on purpose, so a visitor who blocks the
font still gets readable z's rather than tofu.

## Download counter — added 2026-08-27

The number under the try-now button is GitHub's own `download_count` for the
DMG assets, read straight from `api.github.com` by the visitor's browser. There
is no counter of ours behind it and nothing is written anywhere.

~~A counter of button clicks.~~ Considered and not built: it needs a server
this project does not have, it would be a number about visitors rather than a
measurement, and anyone with `curl` could inflate it. What the button click
does do is roll the odometer immediately, because the real count lands at
GitHub later and the digit would otherwise sit still at the one moment it
should move; the next page load re-reads the true number, so the optimistic
roll cannot drift.

Two consequences worth knowing:

- **GitHub sees every visitor.** This is a fetch on page load, not a link, so
  GitHub receives each visitor's IP and user agent whether or not they ever
  click download. `site/privacy/index.html` §3 discloses it alongside the same
  exposure to Google Fonts, and `ops/EGRESS.json` carries the entry.
- **Unauthenticated GitHub allows 60 requests an hour per IP.** One visit
  spends one. If a visitor somehow exhausts it, or GitHub is down, the readout
  stays hidden rather than showing a wrong or invented number — which is also
  what happens on localhost, where the counter is switched off entirely.

## Domain — done

**intaglio.io is live on the default site.** Moved 2026-08-24 and verified from
outside: `HTTP/2 200`, serving this repository's page, with the download button
pointing at the GitHub release.

The move: the domain was attached to a second site, `intaglio-landing`, which this
repository did not deploy — so the apex served a release pushed by hand while
deploys landed somewhere else. The domain now sits on `hazlie-prod`, the project's
default site and the one `firebase.json` names, and `intaglio-landing` is deleted.
One site, one deploy target, one URL.

**That last sentence is temporarily false, and knowingly so.** As of 2026-08-27
deploys go to `intagliolabs` while the apex is still attached to `hazlie-prod`,
so a push to `main` updates `intagliolabs.web.app` and leaves intaglio.io on the
last build the old project received. Moving a custom domain is console-only and
re-provisions a certificate on the receiving site, so it is done last and by
hand rather than folded into the commit that repoints the config. Until it is
done, **intaglio.io is stale** and `intagliolabs.web.app` is current.

The cutover, in the order that keeps the apex up: add `intaglio.io` to the
`intagliolabs` site, add the `hosting-site=intagliolabs` TXT record *alongside*
the existing `hosting-site=hazlie-prod` one, wait for the new site to report
Connected, and only then remove the domain from `hazlie-prod` and drop the stale
TXT. Both TXT records may coexist; that overlap is what avoids a gap. DNS is
Google Cloud DNS (`ns-cloud-c1..c4.googledomains.com`) and the apex A record is
`199.36.158.100`. Do not touch the `google-site-verification`, SPF or
`anthropic-domain-verification` TXT records that share the apex.

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
