# streetcrypt.id

The website at `https://streetcrypt.id`: Caddy serving `site/`, built into an image and deployed
to Buttercup by a Helm chart. It moved here from Buttercup's `apps/streetcrypt-id` on 2026-11-15,
so the pages change in the same pull request as the app and the repeaters they describe.

```
website/
├─ site/                  everything served, at the path it is served at
│  ├─ .well-known/        apple-app-site-association, assetlinks.json
│  ├─ pair/               invite fallback
│  └─ repeater/           claim fallback + setup guide, install.ps1
├─ Caddyfile              headers, rewrites, error page
├─ Dockerfile             caddy + Caddyfile + site/, validated at build
├─ charts/streetcrypt-id/ Deployment, Service, PodDisruptionBudget
└─ test/                  site.test.ts (static), smoke.sh (a running image)
```

`just website::serve` runs the image on <http://localhost:8080>; `just website::check` is CI's
website lane short of the image build.

## Deploying

There is no release to cut. Every push to `main` that touches `website/` runs
`.github/workflows/release-website.yml`, which:

1. builds the image, starts it, and runs `test/smoke.sh` against it;
2. pushes `ghcr.io/unrealjune/streetcrypt-id:0.1.<run>` (plus `sha-<short>` and `latest`);
3. packages the chart as `0.1.<run>`, appVersion the same, to `oci://ghcr.io/unrealjune/charts`.

Buttercup's HelmRelease (`apps/streetcrypt-id/helmrelease.yaml`) follows the chart with a semver
range, so Flux rolls it out within its interval — nothing to bump on that side. The version is the
workflow's run number on purpose: it only ever grows, which a `0.0.0-<sha>` prerelease does not
(those sort lexically, which is why the trail-stash HelmRelease pins by hand). The image tag
equals the chart's appVersion, so the chart version alone names what is deployed. To roll back,
pin `version:` in the HelmRelease to an earlier chart.

Buttercup keeps what is about the cluster rather than the site: the namespace, the Traefik
IngressRoute (deliberately no forward-auth, see the comment there) and the NetworkPolicy. TLS
terminates at the Caddy jumpbox (`terraform/jumpbox/Caddyfile` in Buttercup), so the pod listens
on plain HTTP 8080.

Both GHCR packages (`streetcrypt-id` and `charts/streetcrypt-id`) must be **public**: Buttercup
pulls them anonymously, like trail-stash's.

## Why it exists

Its first job is two files:

- `/.well-known/assetlinks.json` — Android App Links
- `/.well-known/apple-app-site-association` — iOS Universal Links

Those are what make a streetCryptid pairing invite **clickable**. Messaging apps
linkify only a fixed set of schemes (`http`, `https`, `mailto`, `tel`…), so the
app's original `streetcryptid:///social?token=…` invite arrived as inert text —
the intent filter was fine, nothing could ever tap it. The app now mints
`https://streetcrypt.id/pair#token=…` instead, and these files are how the OS is
told that this app may claim that URL.

The pages are the fallback for when that doesn't fire (app not installed,
verification not yet landed, older build). `/pair` reads the token from the URL
fragment client-side and offers a `streetcryptid:///social?token=…` hand-off
plus the raw `scpair2:` token to copy.

`/repeater#t=…&s=…` is the same idea for a repeater's claim QR code (every repeater shows it
while unclaimed): claimed by the same two files, it opens the app on Settings > Repeaters with the
link filled in. The fallback offers a `streetcryptid:///repeater?t=…&s=…` hand-off and the
`streetcryptid-repeater:` link to paste.

Repeaters print `/repeater/claim#…`, and only that path is in the association files (and the
app's Android intent filter): **bare `/repeater` is the setup guide**, and a claimed path never
opens in a browser on a phone with the app. Repeaters built before 2026-11-15 print
`/repeater#…`; that now lands on this page in the browser, which hands it to the app with one tap.

**Without a claim in the fragment, `/repeater` is the setup guide** — what the app's "SET UP"
button on the claim screen opens (`REPEATER_SETUP_URL`). One page does both because the app and
every printed QR code already point at that path. `repeater/guide.js` decides which to show; with
the script blocked the guide renders with every panel open. It picks the visitor's OS tab from
`navigator.userAgentData` (or the user agent), and on Chromium asks for the architecture to put
the matching Windows installer first. Nothing leaves the page.

`/repeater/install.ps1` is the one-line Windows install (`irm … | iex`). It downloads the
installer for the machine's NATIVE architecture (from the registry, not
`$env:PROCESSOR_ARCHITECTURE`, which an emulated x64 shell on ARM64 rewrites) from the
`repeater-preview` release the app updates from, then **writes the Mark of the Web on it before
starting it**. The installers are unsigned previews, and a file fetched by a script carries no
mark, so without that step Windows would run it with no SmartScreen prompt at all —
`repeater/windows/README.md` forbids bypassing that warning, and the script refuses to start a
file it could not mark. Caddy serves it as `text/plain`, because `Invoke-RestMethod` hands `iex`
bytes for anything else. Keep it ASCII: Windows PowerShell 5.1 reads a BOM-less file in the ANSI
code page.

When the Linux repeater ships (#208), its tab in `repeater/index.html` gets the same treatment.

**The copy-paste route offers the token, not a 16-character pairing code.** Those
are two unrelated handoffs in the app and only one of them is in this link.
`encodePairLink` mints `#token=…` and nothing else; a short code comes from
`createPairCode`, which seals the invite into a mailbox and hands back a code
shared out of band. The code is the mailbox _secret_ -- it derives both the
lookup id and the AES key -- so it must never travel in the same URL as the
thing it opens, and this page must never render one it cannot have. A bare
`scpair2:` token is accepted by `pairFromInput` on every build that has ever
shipped, which is exactly what the older-build route needs.

**The token is in the fragment, not the query string, on purpose.** A fragment is
never sent to a server, so an invite that lands here because the recipient has no
app does not put a live pairing token in this pod's logs or anything in front of
it.

## The pages

`index.html`, `pair/index.html`, `repeater/index.html` and `404.html` share `style.css` and `field.js`.
`field.js` draws the flip-dot map field behind all three: a lattice of dots that
repaints scene to scene with a diagonal flip sweep, in the daybreak/deepsea
canvas palettes transcribed from the app's `cryptid-theme.ts`. It is decoration
and is loaded last -- `/pair` hands over the invite with the script blocked.

**The lattice is drawn by a fragment shader.** Every dot used to be pathed in
JavaScript on every frame -- tens of thousands of `Path2D.ellipse` calls at
60fps, and about 85% of those frames repainted a picture that had not changed,
because a scene rests for 4.6s between 1.0s sweeps. Now a frame sets five
uniforms and draws one quad: cell geometry, the diagonal sweep offset and the
squash are all per fragment. That is what paid for the density -- the dot
pitch went from a flat 8px to 3-5.5px, and per-frame cost stopped depending on
how many dots there are. Over one scene the field issues a handful of draw calls
and none at all while that scene is resting.

The scenes themselves stay in JavaScript: they are the art, and porting them to
GLSL would drift. They only run when the scene changes, and
`stepBuild` spreads that across the hold a few milliseconds per frame, so the
sweep starts with the next board already staged and there is no hitch to see.
Cells are stored twice -- one byte of palette key plus a fade ramp, and the RGB
the shader samples -- so a system theme change re-maps the boards already in
hand rather than re-evaluating a scene function over every cell.

**Twelve scenes**, each a pure function from a normalised point to a palette key
plus a few labels, ordered so no two in a row lean on the same geometry: Tokyo
(orthogonal grid), Big Sur (coast and ridge), Barcelona (chamfered blocks cut by
one diagonal), Chicago (lake edge and the elevated loop), Lofoten (fjord),
Istanbul (a strait with two bridges), Zürich (a fanning throat of rail),
New Orleans (a meander, with the grid sheared to follow it), Amsterdam
(concentric canals), Sierra Nevada (contour lines and tarns), Venice (a
branching capillary canal network), Manhattan (a park cut out of avenues). The
expensive one is Venice at ~33ms for a full board, which `stepBuild` spends
three milliseconds at a time across a 4.6s hold.

**The board is full-bleed.** It used to clear a disc and leave the corners under
fog, which on a page read as a circle pasted on rather than as a map the page
stands on -- and on a phone it was a disc wider than the screen, so the whole
viewport was one zoomed-in block of city. The scene is now evaluated over the
entire viewport and the fog is gone.

Two things pay for that. Every cell colour is mixed `QUIET` of the way from the
page ground toward its own value (0.8 in daybreak, whose terrain is pale to
start with; 0.6 in deepsea, whose terrain is not) -- the field is background,
and a background that wins a contrast fight against its own copy is a bug. Map
labels stay at full strength, because they are the one thing on the board meant
to be read. Then `#scrim` lays the page's own ground wherever that page keeps
its copy: a band at each edge for the masthead and colophon, a column under the
hero on wide screens, a rise from the bottom on narrow ones, and an even veil on
the two card pages, whose cards carry their own ground. Between them, body copy
clears 4.5:1 in both themes with the map still drawn edge to edge behind it.

Sizing is derived, not fixed: hold `BLOCK_SPAN` city blocks across the narrow
axis of the viewport at every size and draw a block with `DOTS_PER_BLOCK` dots.
The dot pitch (3-5.5px) and the geometric unit both fall out of that and their
ratio stays put, so the lattice looks the same on a 390px phone and on a 27-inch
display and only the amount of map changes. That is what a phone was missing:
before, a block was the same number of pixels everywhere, so a narrow screen got
seven blocks blown up to fill it.

Without WebGL the field falls back to Canvas2D at 1.6x the dot pitch with
instant scene changes, which is the degradation `prefers-reduced-motion` already
gets. Map labels sit on a second canvas over the field, inserted where they used
to be painted, so `#scrim` covers them exactly as it covers the dots.

Rajdhani is self-hosted under `site/fonts/` (latin subset, four weights, ~60 KB)
rather than linked from `fonts.googleapis.com`. A webfont request from `/pair`
would tell a third party that someone opened a pairing invite, which is the one
thing this origin is supposed not to leak (`test/site.test.ts` fails if any
page starts loading something from another origin). The fonts are SIL OFL 1.1 and `OFL.txt` is served next to
them so the license travels with the files.

The store buttons on the landing page are a state ("TestFlight", "Closed
testing"), not links, because there is nothing public to link to yet. There is a
comment at the markup where they turn back into links.

## Before this works

Filled in already:

- **Apple Team ID `X37464B5A7`** — read from Apple's own API
  (`GET /v1/bundleIds?filter[identifier]=com.unrealjune.streetcryptid` →
  `attributes.seedId`), not from a config file, so it is the team the bundle
  identifier is actually registered under.
- **Signing key `EF:D1:CF:63:…:06:97`** — `keytool -list -v` on
  `credentials/streetcryptid.keystore` in the app repo. Verified identical to the
  keystore EAS holds as default for this app (build credentials `newlkeys`, alias
  `streetcryptid`), so local, EAS, CI and Play builds all present this certificate.

**One fingerprint is the whole list, and that is deliberate.** Play App Signing
was enrolled with this same key rather than letting Google generate one, so the
app signing certificate and the upload certificate are identical — a Play install
presents exactly what a sideload does. That is also why reinstalling over a
sideloaded build does not fail with a signature mismatch.

If the app signing key is ever rotated in Play Console, or a second key is ever
introduced, its SHA-256 has to be appended here (Play Console → Release → Setup
→ App signing) or every install from Play silently stops verifying.

Do not park a placeholder string in that array. The entries are parsed as hex
fingerprints, and one malformed value risks the whole statement file being
rejected — taking the valid entry down with it.

Also required, outside this repository (both in Buttercup, both done):

1. An **A record for `streetcrypt.id`** pointing at the Caddy jumpbox (same
   address as `junephilip.com`). Apex only — see the note in
   `terraform/jumpbox/Caddyfile` about not adding `www`.
2. The `streetcrypt.id` block in `terraform/jumpbox/Caddyfile`, which
   tofu-controller deploys to the jumpbox (see `terraform/jumpbox/README.md`).

## Verifying

Content type is the whole reason this is not on GitHub Pages — Pages cannot set
response headers, and the association file has no extension, so it would go out
as `application/octet-stream`:

```sh
bash website/test/smoke.sh https://streetcrypt.id
```

Neither may redirect (`curl -sI` should be `200`, not `301`).

Then the two verifiers:

```sh
# Google — what Play services will conclude
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list\
?source.web.site=https://streetcrypt.id\
&relation=delegate_permission/common.handle_all_urls" | jq .

# Apple — what its CDN actually cached (this is what devices read, not your origin)
curl -s https://app-site-association.cdn-apple.com/a/v1/streetcrypt.id | jq .
```

On device:

```sh
adb shell pm get-app-links com.unrealjune.streetcryptid   # want: verified
```

Android 12+ is all-or-nothing: if verification fails the link opens in the
browser with no chooser and no error. Apple's CDN caches, so an AASA fix can take
hours to reach devices; reinstalling the app forces a re-fetch.

## Pods

Runs `restricted` PSS as uid 1000 with a read-only root filesystem. Caddy needs `/data` and
`/config` writable: the chart mounts emptyDirs there with `fsGroup: 1000`, and the image chowns
them so a plain `docker run` works too. The admin API is off: a new site is a new image, never a
reload.

Two things bite here, and both look identical from the outside (an immediate `CrashLoopBackOff`):

1. `exec /usr/bin/caddy: operation not permitted`. The image ships the binary with
   `cap_net_bind_service` as a **file** capability. Under `allowPrivilegeEscalation: false`
   (no_new_privs), `execve` of a binary carrying file caps the process does not already hold
   returns EPERM. The fix is `capabilities.add: [NET_BIND_SERVICE]` — not because anything binds a
   privileged port (it listens on 8080), but so the exec grants nothing new. `restricted` permits
   adding back exactly this one capability.
2. A permission error on `/data` or `/config`, which means `fsGroup` is missing.

The log line says which; read it rather than inferring from the restart count.

The Caddy base image is pinned by tag and digest in the `Dockerfile`. Nothing bumps it
automatically any more (Buttercup's `caddy` ImagePolicy did while it ran the stock image), so bump
it by hand.
