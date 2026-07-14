# iOS Release workflow — one-time setup

`ios-release.yml` builds the iOS app on a GitHub-hosted `macos-15` runner via
`eas build --local` and submits it to App Store Connect on every push to `main`.
The compile happens on the runner (not Expo's cloud build queue); EAS still manages
signing credentials. Complete the steps below once before the workflow can run green.

## 1. Expo robot token → GitHub secret `EXPO_TOKEN`

- Expo dashboard → Account → **Settings → Access tokens** → create a **robot** token
  with access to the `unrealjune/streetCryptid` project.
- GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
  → name `EXPO_TOKEN`, value = the token.

This is the **only** GitHub secret required. It authenticates both the credential
fetch during `eas build --local` and the `eas submit` upload.

## 2. iOS signing credentials on EAS (done once, from a Mac)

The runner pulls the distribution certificate + provisioning profile from EAS at build
time. Generate/store them once:

```sh
eas credentials --platform ios   # choose the production build profile
# let EAS create & store the Distribution Certificate + Provisioning Profile
```

(Or just run one interactive `eas build --platform ios --profile production` from a Mac
and let it generate them — after that they live on EAS servers.)

## 3. App Store Connect API key on EAS

So `eas submit` can upload non-interactively without a `.p8` in GitHub secrets:

```sh
eas credentials --platform ios   # → App Store Connect API Key → set up
```

Provide the ASC API key id, issuer id, and `.p8` when prompted. EAS stores it and
reuses it for `eas submit --profile production`.

## 4. Seed tag (one time)

`paulhatch/semantic-version` computes the next version from commits since the latest
`v*` tag. Without a tag it would start **below** the current `app.json` version
(`1.0.0`). Seed it so the first automated build bumps from 1.0.0:

```sh
git tag v1.0.0
git push origin v1.0.0
```

## How versioning works

- **buildNumber (CFBundleVersion):** auto-incremented by EAS (`appVersionSource: remote`
  + `production.autoIncrement` in `eas.json`). This is the value TestFlight requires to
  be unique — no manual work.
- **Marketing version (`app.json` `version`):** derived from Conventional Commits —
  `feat:` → minor, `fix:`/`chore:`/etc. → patch, `type!:` or `BREAKING CHANGE` → major.
  The workflow writes it into `app.json`, builds, submits, then commits the bump back to
  `main` with a `vX.Y.Z` tag. The push uses `GITHUB_TOKEN`, which does not retrigger the
  workflow (the `[skip ci]` marker is belt-and-suspenders).

## Notes / trade-offs

- `macos-15` minutes bill at a **10× multiplier**; a full native RN + Rust build is
  ~15–30 min cold, roughly halved once caches (cargo/target, bun, pods) are warm.
- Every push to `main` submits to App Store Connect. `paths-ignore` skips docs-only
  pushes. The default target is TestFlight (upload only) — promoting a build to a public
  App Store release stays a manual step in App Store Connect.
- Dev telemetry (`EXPO_PUBLIC_OTEL_ENDPOINT`) is intentionally still enabled in the
  `production` profile for now; strip it from `eas.json` before a public store release.
