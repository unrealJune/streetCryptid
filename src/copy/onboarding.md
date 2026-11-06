# Onboarding

The words on the first-launch setup screens, in the order they appear: the splash, the profile,
the privacy letter and delivery. (The permissions page that follows is `permissions.md`.) Edit them
here, then run `just copy` to regenerate `onboarding.ts`, which is what the app reads. `just check`
(the jest run) fails if this file and `onboarding.ts` disagree, so a forgotten regenerate cannot
ship.

How this file is read:

- Each `## <section>` is one screen, or one part of one. The order doesn't matter.
- `### <field>` starts a field. Its text runs to the next heading. Lines within a paragraph are
  joined with spaces; a blank line starts a new paragraph (the privacy `letter` is several).
- **Leave a field empty, or delete it, and the app leaves that text out.** The exceptions are what
  a screen can't work without — titles, buttons, labels and error messages — and `just copy` names
  any of those you emptied.
- Text is used exactly as written, so type curly quotes and apostrophes (’ “ ”) as you want them
  shown. The one piece of Markdown that works is a link, `[words](https://…)`, in the paragraphs.
  HTML comments are ignored, so leave notes in those.
- Fields ending in `-label` are what a screen reader says for a button; `rail-…` fields are the
  short labels on the side rail beside a landscape or iPhone Duo screen.

## splash

<!-- "streetCryptid" itself is the logotype, drawn in code. -->

### heading

Find your cryptids in the world.

### body

Share your location with your friends and track where you’ve been. We promise to never save, sell,
or snoop on your trail.

### start

Get started

### rail-start

Start

## profile

### title

Set up your profile

### intro

Choose how you appear to friends. You can change this later.

## privacy

<!--
The letter is product copy: keep it whole, and keep it honest about the middle of the network
seeing that two anonymous IDs exchanged bytes. Its last line is a promise about the delivery screen
that follows, which is why it sits right before it.
-->

### title

Quick message from us

### lede

What makes streetCryptid different?

### letter

streetCryptid was designed to be privacy focused from the ground up. We don’t collect logs,
telemetry, or other data.

We’ve also taken steps to ensure that the way we share your location is also private. To facilitate
this, we try to rely on peer-to-peer connections between friends. This means that your location can
travel directly between your friend network without us ever needing to store it on a server for
others to read. This also means that all of your friends need their phone to be listening when you
send out your location. This is pretty hard.

We also offer a more resilient option, that uses a server to store your location updates
for your friends to read when they come back online. This is called the “stash” option, and it is
encrypted so that only your friends can read it. Like this app, the server is open source and
designed to hold no information about you. We make it an option for folks that may not need the
extra privacy, but want to make sure their friends can always see their location updates. You can
always host your own server if you don’t trust us.

Read more about our privacy preserving decisions on our [website](https://streetcrypt.id).

### caveat

<!--
Drawn in an amber-edged box with no heading: it is the one paragraph that takes something away
rather than offering it, and a heading would turn it into a section someone skips.
-->

### next

### signoff

— the streetCryptid team.

### back

Back

### back-label

Back to profile

### continue

Continue

### continue-label

Continue to delivery

### rail-continue

Next

## delivery

### title

Delivery

### loading

Loading delivery preferences…

### load-error

Could not load delivery preferences. Try again.

### retry

Retry loading delivery preferences

### save-error

Could not finish setup. Try again.

### back

Back

### back-label

Back to privacy

### continue

Continue

### saving

Saving…

### continue-label

Continue with selected delivery

### rail-continue

Next

## delivery-mutual

<!--
The two delivery routes. Settings → Delivery shows the same words, so a change here shows there
too. `{platform}` becomes iOS, Android, the web or "your device".
-->

### title

<!-- The name in Settings' Delivery row. -->

Mutual Friends

### segment

<!-- The uppercase label on the switch between the two routes. -->

MUTUAL FRIENDS

### heading

<!-- The heading over the explanation, under the switch. -->

Mutual friend relay

### body

Because of restrictions on background processing on {platform}, this method is not reliable for
daily usage unless you’re working with a very large pool of mutual friends. Enabling this setting
may cause you to have unreliable or missed location updates.

## delivery-stash

### title

Mutuals + Stash Server

### segment

STASH

### heading

Mutuals + Stash Server

### body

If your friends are offline and can’t receive your location updates, using stash will allow
friends to catch up with your location updates when they come back online. Stash entries are
encrypted and can only be read by your friends, and are auto deleted after a short period of time.
