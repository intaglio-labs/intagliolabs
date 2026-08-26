# Signing, and the two certificates that are not interchangeable

`widget/build.sh` produces something you can run. `widget/release.sh` produces
something you can *give to somebody else*. They need different certificates, and
conflating them wastes a day.

| | build.sh | release.sh |
|---|---|---|
| certificate | Apple Development | Developer ID Application |
| provisioning profile | required, per-machine | none |
| runs on | Macs listed in the profile | any Mac |
| Gatekeeper (`spctl -a`) | rejected — expected | accepted |
| notarized | no | yes, and stapled |

## Why a development build needs a profile

A development-signed Mac app with no `Contents/embedded.provisionprofile` is not
validly signed **for any machine**. It runs for whoever built it and little else.

The profile names the team, the bundle id, and the Macs allowed to run the build.
It asserts three keys — `application-identifier`, `team-identifier` and
`keychain-access-groups` — and `build.sh` copies the first two out of it into the
signing entitlements, because those two are only valid alongside the profile that
asserts them.

The hardened-runtime resource entitlements in `Hazlie.entitlements`
(`personal-information.*`, `device.audio-input`) are NOT profile-restricted and do
not appear in the profile at all. Signing with them is fine in either mode.

> An earlier version of this file said the missing profile was why privacy prompts
> never appeared. **That was wrong.** The app that would not prompt had a valid
> profile. The cause was the missing hardened-runtime entitlements above: with the
> hardened runtime on, `tccd` refuses to *display* the consent dialog for a service
> whose entitlement is absent, logging `Policy disallows prompt`. `Hazlie.entitlements`
> carries the full mechanism. A profile lets you hand the app to someone else; it is
> not what earns a TCC prompt.

### Setting one up (no Xcode required)

```sh
# the Mac's provisioning UDID, not its hardware UUID
system_profiler SPHardwareDataType | grep "Provisioning UDID"

asc devices register --name "<machine>" --udid "<UDID>" --platform MAC_OS
asc bundle-ids create --identifier io.intaglio.widget --name "Intaglio Labs Widget" --platform MAC_OS
asc certificates list          # note the DEVELOPMENT certificate's id
asc profiles create --name "Intaglio Labs Mac Dev" --profile-type MAC_APP_DEVELOPMENT \
  --bundle "<BUNDLE_ID>" --certificate "<CERT_ID>" --device "<DEVICE_ID>"
asc profiles download --id "<PROFILE_ID>" --output widget/signing/mac-dev.provisionprofile
```

`build.sh` embeds `widget/signing/mac-dev.provisionprofile` when it is there and
says so when it is not. Adding a second Mac means re-creating the profile with
both device ids and downloading it again — a profile is a snapshot, not a rule.

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
