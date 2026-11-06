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

We need your approval to use the following device features. You can change your mind later in Settings. streetCryptid works best with all of them, but you can skip any you want.

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

Before we turn on location

### lede

streetCryptid uses your location while the app is closed or in the background.

### summary

### card: TERRITORY EXPLORATION (amber)

As you walk through your city, streetCryptid reveals the streets and hex-shaped sectors you’ve covered.
This only works if the app can sample your location occasionally in the background, since most of your moving around happens while the app is closed.

### card: FRIEND LOCATION SHARING (green)

If you pair with friends and enable location sharing, your live location is sent
so they can see you on the map, including while the app is in the background. Only
friends you’ve explicitly paired with can see this.

### note-ios

Next, your iPhone will ask to allow location access. After that, it will ask for background
access.

### note

Next, your device will ask you to allow location access.

### action

Turn on location

## background-location

### name

Location all the time

### title

Allow all the time

### lede

Most of your walking happens with the app closed. Background access is what lets streetCryptid
keep up then.

### summary

Location all the time.

### card: WHILE THE APP IS CLOSED (green)

With “all the time,” your explored map keeps filling in and friends keep seeing where you are while
your phone is in your pocket. With “only while using the app,” both stop the moment you leave it,
and friends see a dot that stopped where you were.

### note-ios

Next, your iPhone will ask whether to change to “Always Allow.”

### note-android

We will open the app's settings: choose “Allow all the time,” then come back.

### action

Allow all the time

## bluetooth

### name

Bluetooth

### title

Bluetooth, for Bump

### lede

Bump pairs two phones held together, when you're next to a friend.

### summary

Pair with your friends!

### card: PAIRING IN PERSON (green)

When you both tap Bump, each phone finds the other over Bluetooth and starts an encrypted pairing
on the spot.

### note-android

Android calls this “Nearby devices.”

### note-ios

Next, your iPhone will ask to allow Bluetooth.

### action

Allow Bluetooth

## local-network

### name

Local network

### title

Phones on your Wi-Fi

### lede

When a friend is on the same Wi-Fi, your phones can talk to each other directly, minimizing network exposure and missed updates.

### summary

Reach friends on the same Wi-Fi directly.

### card: THE SHORT WAY ROUND (green)

### note-ios

Next, your iPhone will ask to find and connect to devices on your local network.

### action

Allow local network

## notifications

### name

Notifications

### title

A notification while sharing

### lede

Android shows a notification for as long as streetCryptid shares your location in the background.

### summary

### card: ALWAYS VISIBLE (amber)

We are required to show a notification while sharing your location in the background.

### action

Allow notifications

## battery

### name

Battery

### title

Keep sharing when the app is closed

### lede

Android sometimes stops apps in the background to save memory. When it stops streetCryptid, it
won’t let sharing start again until you open the app.

### summary

Unrestricted battery use

### card: SET BATTERY USE TO UNRESTRICTED (green)

This lets streetCryptid restart sharing by itself.

### note

You can change this any time in Settings → Apps → streetCryptid → Battery. If you skip it, we’ll
send a notification whenever sharing stops so you can turn it back on.

### action

Allow
