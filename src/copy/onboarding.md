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

Share your location with friends and see where you’ve been. We’ll never save, sell, or snoop on
your trail.

### start

Get started

### rail-start

Start

## profile

### title

Set up your profile

### intro

Choose how friends see you. You can change this later.

## privacy

<!--
The letter is product copy: keep it whole, and keep it honest about the middle of the network
seeing that two anonymous IDs exchanged bytes. Its last line is a promise about the delivery screen
that follows, which is why it sits right before it.
-->

### title

A quick note from us

### lede

What makes streetCryptid different?

### letter

We built streetCryptid around privacy from the start. We don’t collect logs, telemetry, or any
other data.

Sharing your location is private too. Wherever we can, it travels straight from your phone to your
friends’ phones, so it never sits on a server for anyone else to read. The catch is that a friend’s
phone has to be listening when you send it, and phones in pockets often aren’t.

So there’s also a more reliable option: the stash. It’s a server that holds your latest location
until your friends come back online, encrypted so only they can read it. Like the app, it’s open
source and built to know nothing about you. It’s for folks who don’t need the extra privacy and want
friends to always see where they are. If you don’t trust us, you can run your own.

Read more about how we protect your privacy on our [website](https://streetcrypt.id).

### caveat

<!--
Drawn in an amber-edged box with no heading: it is the one paragraph that takes something away
rather than offering it, and a heading would turn it into a section someone skips.
-->

### next

### signoff

The streetCryptid team

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

Friends pass your location along

### body

Background limits on {platform} mean your friends’ phones often aren’t listening when you share.
Unless you have a lot of mutual friends, expect late or missed location updates.

## delivery-stash

### title

Mutual Friends + Stash

### segment

STASH

### heading

The stash covers for offline friends

### body

When friends are offline, the stash holds your latest location until they’re back. It’s
encrypted so only your friends can read it, and it’s deleted after a short time.
