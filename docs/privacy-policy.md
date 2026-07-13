# streetCryptid Privacy Policy

**Effective date:** 2026-07-13
**Contact:** mail.junephilip@gmail.com

## The short version

streetCryptid lets you share your live location with friends you have
personally paired with. Your location is **end-to-end encrypted**: it is sealed
on your device and can only be opened by the friends you share it with.

- **We cannot see your location.** streetCryptid does not run any central
  service that can read your data. The servers that help deliver it are ones
  **you choose and configure**, and they only ever handle encrypted data they
  cannot read.
- **No accounts.** There is no sign-up, no email, no username. Friends are added
  by tapping phones together or exchanging a pairing code.
- **No advertising, no tracking, no data brokers, no analytics SDKs.** We do not
  sell or share your data, and we do not build a profile of you.

The app *does* collect and transmit your location — that is its core function.
This policy explains exactly how.

## What data the app handles

### Location
When you enable sharing, the app reads your device location (including in the
background, if you allow it) and shares it with the friends you have paired with.

- Location is **end-to-end encrypted** before it leaves your device.
- It is stored **locally on your device** (in an on-device database) so you can
  see recent activity and "trails."
- To reach a friend, encrypted location updates travel peer-to-peer directly
  between devices when possible. When a direct connection isn't available, they
  may pass through a **relay server** as encrypted transit only. The relay
  server is one **you configure when you set up the app** — it may be run by
  you, by a community you belong to, or by a provider you choose. Whoever runs
  it, it cannot read your location; it only forwards sealed data.
- If you opt in to offline delivery, encrypted updates may also be held by a
  **"stash" server** so friends can receive them even when you are both never
  online at the same time. Like the relay, the stash is a server **you
  configure**, and it is *ciphertext-blind*: it stores and forwards only
  already-encrypted data and can never decrypt it. Using a stash is optional and
  off unless you turn it on.

### Push notification token
If you allow notifications, the app registers your device's push token
(Apple APNs or Google FCM) with the stash server so it can send a silent
"wake" signal when a friend has an update waiting. This token identifies a
device destination for notifications; it is not linked to your name or an
account, and you can revoke it by disabling notifications or unsubscribing.

### Cryptographic identifiers
Pairing and encryption use cryptographic node identifiers generated on your
device. These are used to route encrypted data to the right peers. They are not
tied to your real-world identity.

### What we do NOT collect
We do not collect your name, email address, phone number, contacts, photos,
advertising identifiers, or any analytics/usage telemetry.

## Third parties

streetCryptid does not use third-party analytics, advertising, or tracking SDKs.
Data reaches the following parties only as described above:

- **Your paired friends** — the only parties who can decrypt your location.
- **The relay and stash servers you configure** — handle only encrypted data and
  routing metadata (such as network addresses and node identifiers); they cannot
  read your location. Because you choose these servers, their operators are
  responsible for any metadata they observe, under their own policies. If you run
  your own, no third party is involved at all.
- **Apple (APNs) and Google (FCM)** — deliver the silent wake notifications, per
  their own privacy policies.

## Data retention and deletion

- Location and trails stored on your device remain until you delete them or
  uninstall the app.
- Unpairing a friend stops sharing with them.
- Disabling notifications or unsubscribing removes your device's wake
  subscription from the stash.
- Uninstalling the app removes all locally stored data from your device.

## Children

streetCryptid is not directed to children under 13 (or the equivalent minimum
age in your jurisdiction) and we do not knowingly collect data from them.

## Your choices

You control location and notification permissions through your device settings,
and you choose who to pair with. You can revoke any permission at any time; the
relevant features simply stop working.

## Changes to this policy

We may update this policy. Material changes will be reflected here with a new
effective date.

## Contact

Questions? Email **mail.junephilip@gmail.com**.
