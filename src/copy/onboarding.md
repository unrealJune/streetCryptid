# Onboarding

The words on the first-launch setup screens, in the order they appear: the splash, the profile,
the privacy letter and delivery. (The permissions page that follows is `permissions.md`.) Edit them
here, then run `just copy` to regenerate `onboarding.ts`, which is what the app reads. `just check`
(the jest run) fails if this file and `onboarding.ts` disagree, so a forgotten regenerate cannot
ship.

How this file is read:

- Each `## <section>` is one screen, or one part of one. Every section and every field below has to
  be here; the order doesn't matter.
- `### <field>` starts a field. Its text runs to the next heading. Lines within a paragraph are
  joined with spaces; a blank line starts a new paragraph (the privacy `letter` is several).
- Text is used exactly as written: no Markdown formatting, so type curly quotes and apostrophes
  (’ “ ”) as you want them shown. HTML comments are ignored, so leave notes in those.
- Fields ending in `-label` are what a screen reader says for a button; `rail-…` fields are the
  short labels on the side rail beside a landscape or iPhone Duo screen.

## splash

<!-- "streetCryptid" itself is the logotype, drawn in code. -->

### heading

Find your people out in the city.

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

Where your location goes

### lede

In a minute you’ll pick how your location travels. Here’s what’s carrying it.

### letter

Every fix is encrypted on your phone before it leaves — individually, for each friend you share it
with. Only their phones hold the keys. We can’t read where you’ve been. Not as a promise we’re
making, but as a consequence of how it’s built.

Mostly there’s no we in the path at all. Your phone talks to your friends’ phones directly, and the
infrastructure that helps them find each other only ever handles data it can’t read. There is no
streetCryptid server holding your trail — there is no streetCryptid server at all. There are no
accounts either: no email, no password, nothing to spill.

We built it this way because the alternative has a known ending. Anything that holds your data long
enough gets breached, or acquired, or has a quarter bad enough to make selling it sound reasonable.
We would rather not ask you to trust us — we’d rather not be in a position where you have to.

Which is also why all of it is open, under a license that requires anyone running it as a service
to publish their changes too. The encryption, the delivery routes, the code that decides what
leaves your phone — all of it is readable, by you or by someone you trust more than us.

### caveat

<!--
Drawn in an amber-edged box with no heading: it is the one paragraph that takes something away
rather than offering it, and a heading would turn it into a section someone skips.
-->

What we won’t tell you is that nothing at all is visible. Delivering an encrypted fix means
something in the middle can see that two anonymous IDs passed data between them — that’s true of
every network, and true of this one. What that data says, and where you are, stays yours. The
privacy policy says what each route can see.

### next

Next screen asks how you want your location to travel, and tells you what each route costs.

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
