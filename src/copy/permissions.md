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
- Text is used exactly as written: no Markdown formatting, so type curly quotes and apostrophes
  (’ “ ”) as you want them shown. HTML comments are ignored, so leave notes in those.

<!--
The open `location` row IS the background-location disclosure Google Play requires before the OS
prompt, and the store declaration's video records it (docs/play-store/record-location-disclosure-video.md).
Changing its title, its two cards or its action means re-recording that video and re-checking the
declaration. The web drivers (store-shots, map-bench, island-preview) also find the button by the
text "Turn on location".
-->

## page

### title

A few permissions

### title-single

One permission

### subtitle

Each one says what it’s for before your phone asks. Every one is optional, and you can change any
of them later in your phone’s settings.

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

streetCryptid uses your location — including while the app is closed or in the background — for
two things. Here’s exactly what and why.

### summary

Location — to reveal the streets you walk and share your position with friends.

### card: TERRITORY EXPLORATION (amber)

As you walk through your city, streetCryptid reveals the streets and hex-shaped sectors you’ve
actually covered — building your personal explored map. This only works if the app can sample your
location occasionally in the background, since most of your walking happens while the app is closed.

### card: FRIEND LOCATION SHARING (green)

If you pair with friends, your live location syncs directly to their devices — end-to-end
encrypted — so they can see you on the map, including while the app is in the background. Only
friends you’ve explicitly paired with can see this.

### note-ios

Next, your iPhone will ask to allow location access. The step after this one asks for background
access.

### note

Next, your device will ask you to allow location access, and the step after this one asks for
“Allow all the time.” Choosing “Not now” keeps streetCryptid working, minus background exploration
and friend sharing — you can turn it on later from Settings.

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

Location all the time — so it keeps working while the app is closed.

### card: WHILE THE APP IS CLOSED (green)

With “all the time,” your explored map keeps filling in and friends keep seeing where you are while
your phone is in your pocket. With “only while using the app,” both stop the moment you leave it,
and friends see a dot that stopped where you were.

### note-ios

Next, your iPhone will ask whether to change to “Always Allow.”

### note-android

Android opens Settings for this one: choose “Allow all the time,” then come back.

### action

Allow all the time

## bluetooth

### name

Bluetooth

### title

Bluetooth, for Bump

### lede

Bump pairs two phones held together, with no link to send and no account to look up.

### summary

Bluetooth — to find a friend’s phone when you Bump.

### card: PAIRING IN PERSON (green)

When you both tap Bump, each phone finds the other over Bluetooth and starts an encrypted pairing
on the spot — it works with no signal at all. Without Bluetooth you can still pair by sending a
link.

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

When a friend is on the same Wi-Fi, your phones can talk to each other directly.

### summary

Local network — to reach friends on the same Wi-Fi directly.

### card: THE SHORT WAY ROUND (green)

Directly is faster than going through a relay, and it keeps working when the internet doesn’t.
Without it nothing breaks — your location still reaches friends, just the long way.

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

Notifications — so you can always see that sharing is on.

### card: ALWAYS VISIBLE (amber)

It’s how you can tell at a glance that sharing is on, and if Android ever stops it, it’s how we let
you know. Sharing works either way; without this you just can’t see it.

### action

Allow notifications

## battery

### name

Battery

### title

Keep sharing when the app is closed

### lede

Android sometimes stops apps in the background to save memory. When it stops streetCryptid, it
won’t let sharing start again until you open the app — so your friends see a dot that stopped hours
ago.

### summary

Unrestricted battery use — so Android can’t switch sharing off for good.

### card: SET BATTERY USE TO UNRESTRICTED (green)

This lets streetCryptid restart sharing by itself. It doesn’t make the app check your location any
more often — it only stops Android from switching sharing off for good.

### note

You can change this any time in Settings → Apps → streetCryptid → Battery. If you skip it, we’ll
send a notification whenever sharing stops so you can turn it back on.

### action

Allow
