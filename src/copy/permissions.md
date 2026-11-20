# Permissions page

The words on the first-launch permissions page (`PermissionJourneyScreen`). Edit them here, then
run `just copy` to regenerate `permissions.ts`, which is what the app reads. `just check` (the
jest run) fails if this file and `permissions.ts` disagree, so a forgotten regenerate cannot ship.

How this file is read:

- `## page` is the page itself; every other `## <id>` is one permission, by its step id. The
  sections can be in any order, but every step needs one.
- `### <field>` starts a field. Its text runs to the next heading. Lines within a paragraph are
  joined with spaces; a blank line starts a new paragraph.
- `### card: <LABEL> (amber|green)` adds a card under the open row, in the order written. The
  colour is the label's.
- `### note` is the line under the cards. `### note-ios`, `### note-android` and `### note-web`
  replace it on that platform; a platform with neither shows no note.
- **Leave a field empty, or delete it, and the app leaves that text out.** A card with no text is
  dropped. Only `name` and `action` on a step, and everything in `page` but the `subtitle`, have to
  have text; `just copy` names any of those you emptied.
- Text is used exactly as written, so type curly quotes and apostrophes (’ “ ”) as you want them
  shown. The one piece of Markdown that works is a link, `[words](https://…)`, in the paragraphs.
  HTML comments are ignored, so leave notes in those.

<!--
The open `location` row IS the background-location disclosure Google Play requires before the OS
prompt, and the store declaration's video records it (docs/play-store/record-location-disclosure-video.md).
Changing its title, its two cards or its action means re-recording that video and re-checking the
declaration. The web drivers (store-shots, map-bench, island-preview) also find the button by the
text "Turn on location".
-->

## page

### title

Permissions

### title-single

One permission

### subtitle

Here’s what streetCryptid needs, and why. It works best with everything on, but you can say no to
any of it and change your mind later in Settings.

### continue

<!-- The button on iOS, where no step can be declined; elsewhere each step's own `action`. -->

Continue

### not-now

Not now

### rail-ok

<!-- The short label on the side rail in landscape. -->

OK

### allowed

ALLOWED

### refused

NOT ALLOWED

### asked

<!-- iOS doesn't tell the app what was chosen for Bluetooth and local network, only that it asked. -->

ASKED

### declined

NOT NOW

### skipped

SKIPPED

## location

### name

Location

### title

Location

### lede

streetCryptid uses your location while the app is closed or in the background.

### summary

Share with friends and fill in your map.

### card: FRIEND LOCATION SHARING (green)

Only friends you’ve paired with can see your location, even while the app is in the background.

### card: TERRITORY EXPLORATION (amber)

To show where you’ve explored, the app needs your location in the background.

### note-ios

Next, your phone will ask to allow location access, then ask again for background access.

### note

Next, your phone will ask to allow location access.

### action

Turn on location

## background-location

### name

Location all the time

### title

Allow all the time

### lede

Most of your walking happens while the app is closed. Background access lets it keep up.

### summary

Keep working while the app is closed.

### note-ios

Next, your phone will ask whether to change to “Always Allow.”

### note-android

We’ll open your phone settings. Choose “Allow all the time,” then come back.

### action

Allow all the time

## bluetooth

### name

Bluetooth

### title

Bluetooth for pairing

### lede

Pair your phones by shaking them next to each other. It all happens over Bluetooth.

### summary

Pair with a friend in person.

### note-android

Android calls this “Nearby devices.”

### note-ios

Next, your phone will ask to allow Bluetooth.

### action

Allow Bluetooth

## local-network

### name

Local network

### title

Phones on your Wi-Fi

### lede

When a friend is on the same Wi-Fi, your phones can talk directly, so fewer updates go missing and
less goes over the internet.

### summary

Reach friends on the same Wi-Fi directly.

### card: THE SHORT WAY ROUND (green)

### note-ios

Next, your phone will ask to find and connect to devices on your local network.

### action

Allow local network

## notifications

### name

Notifications

### title

A notification while sharing

### lede

Android requires a notification while streetCryptid uses your location in the background.

### summary

Show when sharing is on.

### card: ALWAYS VISIBLE (amber)

It stays up for as long as sharing is on, so you can always tell.

### action

Allow notifications

## battery

### name

Battery

### title

Keep sharing when the app is closed

### lede

To keep sharing when the app is closed, set battery use to Unrestricted.

### summary

Keep sharing on in the background.

### note

You can change this anytime in Settings → Apps → streetCryptid → Battery. If you skip it, we’ll
notify you whenever sharing stops so you can turn it back on.

### action

Allow unrestricted battery
