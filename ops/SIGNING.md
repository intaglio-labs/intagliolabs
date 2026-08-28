# Signing, and the two certificates that are not interchangeable

`widget/build.sh` produces something you can run on the machine that built it.
`widget/release.sh` produces something you can *give to somebody else*. They need
different certificates, and conflating them wastes a day.

| | build.sh | release.sh |
|---|---|---|
| certificate | Apple Development | Developer ID Application |
| provisioning profile | none | none |
| runs on | the machine that built it | any Mac |
| Gatekeeper (`spctl -a`) | rejected — expected | accepted |
| notarized | no | yes, and stapled |

## There is no shareable development build, on purpose

~~A development-signed app can be handed to other Macs by embedding a
`MAC_APP_DEVELOPMENT` provisioning profile, which requires registering an App ID
and each machine's UDID.~~ **Removed 2026-08-27 (owner decision: "remove it
if its useless").** The reasoning is kept because the setup instructions were
here for a while and somebody will wonder where they went.

It bought nothing this project needs:

- **Not distribution.** `release.sh` already produces a notarized, stapled build
  that runs on any Mac with no App ID, no registered devices and no profile. That
  is the artifact to hand anyone — and it is the one users actually get, so it is
  the one worth testing.
- **Not debugging.** `Hazlie.entitlements` carries no `get-task-allow`, so a
  development-signed build cannot be attached to by a debugger either way.
- Its only remaining use was running an *un-notarized* build on a second Mac you
  own, to skip a ~5 minute notarization round trip — against the recurring cost of
  re-creating the profile every time a machine is added, because a profile is a
  snapshot, not a rule.

So `build.sh` signs with Apple Development and embeds nothing. The build is valid
for the machine that made it, `spctl -a` rejects it, and that is the expected and
sufficient state. To put the app on another Mac, cut a release and install the
DMG.

Nothing needs registering with Apple for any of this. Developer ID signs whatever
bundle identifier the app declares; notarization checks the signature and the
hardened runtime, not an App ID record. (Should the profile path ever be wanted
back, it is in the history of this file and of `widget/build.sh`.)

## The entitlements, and what a profile never had to do with them

The hardened-runtime resource entitlements in `Hazlie.entitlements`
(`personal-information.*`, `device.audio-input`) are NOT profile-restricted and
never were. Signing with them is fine in either mode.

> An earlier version of this file said a missing profile was why privacy prompts
> never appeared. **That was wrong**, and it is kept here because it sent the
> search in the wrong direction for days. The app that would not prompt HAD a
> valid profile. The cause was the missing hardened-runtime entitlements above:
> with the hardened runtime on, `tccd` refuses to *display* the consent dialog for
> a service whose entitlement is absent, logging `Policy disallows prompt`.
> `Hazlie.entitlements` carries the full mechanism. A profile let you hand the app
> to someone else; it was never what earned a TCC prompt.

## Developer ID: the one you cannot script

**`asc` cannot create it.** The API refuses:

> This operation can only be performed by the Account Holder.

That is Apple's restriction, not the tool's, and it holds for the API generally.
Developer ID certificates are created in a browser, signed in as the Account
Holder. There is also a hard limit (historically five per account) and they last
about five years, so this is an account artifact rather than something to
regenerate casually.

A CSR is already prepared at `widget/signing/devid.csr`, with its private key
beside it. To finish:

1. developer.apple.com/account → Certificates, IDs & Profiles → Certificates → **+**
2. Software → **Developer ID Application** → Continue
3. Upload `widget/signing/devid.csr`
4. Download the `.cer`, then:

```sh
security import <downloaded>.cer -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
security import widget/signing/devid.key -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
security find-identity -v -p codesigning | grep "Developer ID"
```

Then notarization credentials, once per machine, from an **App Store Connect API
key** — App Store Connect → Users and Access → Integrations → App Store Connect
API, under team `5K43Q6FF67`. The `.p8` is offered for download exactly once.

```sh
xcrun notarytool store-credentials hazlie-notary \
  --key AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-UUID>
```

`--issuer` is required for a **Team** key and refused for an **Individual** one.

This used to say to use an Apple ID and an app-specific password. Both work, and
notarytool's own prompt recommends the key: *"We recommend using App Store
Connect API keys for authentication."* The reason is not convenience. An
app-specific password is a credential for the Apple ID itself under a narrower
name — it authenticates the human, and revoking it means going into that
person's account. The API key is scoped to the API, revocable on its own without
touching anything anyone signs in with, belongs to the team rather than to a
person, and is not behind that person's 2FA. The same key is what CI uses
(`ASC_KEY_P8` / `ASC_KEY_ID` / `ASC_ISSUER_ID` — see
`.github/workflows/release.yml`), so there is one credential to reason about
rather than two.

Check the key's role is sufficient before relying on it — this answers it in one
command instead of at the end of a release:

```sh
xcrun notarytool history --key AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-UUID>
```

A history listing means the role is enough; 401 or 403 means raise it.

`release.sh` then signs, notarizes, staples, and builds the DMG. Verified
end to end 2026-08-23: app and DMG both Accepted, stapled, and
`spctl -a` reports `accepted / source=Notarized Developer ID`.

## Back up the identity, because it cannot be re-issued

The certificate is public; the PRIVATE KEY is not, and Apple never had it. Lose
the key and the certificate is dead weight — it cannot be re-downloaded into a
working identity, only revoked and replaced, against a limit of about five.

Export both together, once:

```sh
security export -k ~/Library/Keychains/login.keychain-db \
  -t identities -f pkcs12 -o ~/Desktop/DeveloperID-backup.p12
```

Keep that .p12 somewhere durable and out of this repository. The downloaded
`.cer` is not a backup — it is the half Apple can give you again.

## widget/signing/ never goes to git

The directory ignores itself wholesale. A leaked signing key is worse than a
leaked secret: it is not a credential to something, it is the identity itself,
and the only remedy is revoking the certificate and invalidating every build ever
signed with it. This repository is public.
