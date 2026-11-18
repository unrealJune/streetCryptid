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

Share your location with friends and see where you’ve been. We’ll never sell it or snoop on it.

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

Your location goes straight from your phone to your friends’ phones whenever it can. When their
phones are asleep, a repeater can hold it for them, sealed so only they can open it. You’ll pick one
next.

More on how it all works on our [website](https://streetcrypt.id).

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

Couldn’t load your delivery settings. Try again.

### retry

Retry loading delivery settings

### save-error

Couldn’t finish setup. Try again.

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

Friends only

### segment

<!-- The uppercase label on the switch between the two routes. -->

FRIENDS ONLY

### heading

<!-- The heading over the explanation, under the switch. -->

Friends pass your location along

### body

On {platform}, apps can only do so much in the background, so your friends’ phones often aren’t
listening when you share. Without a repeater, expect late or missed updates.

## delivery-stash

### title

Official hosted repeater

### segment

REPEATER

### heading

A repeater covers for sleeping phones

### body

When your friends’ phones can’t hear you, our repeater holds your latest location for a little
while. Only your friends hold the key, so we can’t see where you are.
