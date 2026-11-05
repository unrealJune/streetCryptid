// GENERATED from onboarding.md by `just copy`. Edit the Markdown, not this file.

export const ONBOARDING_COPY = {
  splash: {
    heading: 'Find your people out in the city.',
    body: 'Share your location with your friends and track where you’ve been. We promise to never save, sell, or snoop on your trail.',
    start: 'Get started',
    railStart: 'Start',
  },
  profile: {
    title: 'Set up your profile',
    intro: 'Choose how you appear to friends. You can change this later.',
  },
  privacy: {
    title: 'Where your location goes',
    lede: 'In a minute you’ll pick how your location travels. Here’s what’s carrying it.',
    letter:
      'Every fix is encrypted on your phone before it leaves — individually, for each friend you share it with. Only their phones hold the keys. We can’t read where you’ve been. Not as a promise we’re making, but as a consequence of how it’s built.\n\nMostly there’s no we in the path at all. Your phone talks to your friends’ phones directly, and the infrastructure that helps them find each other only ever handles data it can’t read. There is no streetCryptid server holding your trail — there is no streetCryptid server at all. There are no accounts either: no email, no password, nothing to spill.\n\nWe built it this way because the alternative has a known ending. Anything that holds your data long enough gets breached, or acquired, or has a quarter bad enough to make selling it sound reasonable. We would rather not ask you to trust us — we’d rather not be in a position where you have to.\n\nWhich is also why all of it is open, under a license that requires anyone running it as a service to publish their changes too. The encryption, the delivery routes, the code that decides what leaves your phone — all of it is readable, by you or by someone you trust more than us.',
    caveat:
      'What we won’t tell you is that nothing at all is visible. Delivering an encrypted fix means something in the middle can see that two anonymous IDs passed data between them — that’s true of every network, and true of this one. What that data says, and where you are, stays yours. The privacy policy says what each route can see.',
    next: 'Next screen asks how you want your location to travel, and tells you what each route costs.',
    signoff: '— the streetCryptid team.',
    back: 'Back',
    backLabel: 'Back to profile',
    continue: 'Continue',
    continueLabel: 'Continue to delivery',
    railContinue: 'Next',
  },
  delivery: {
    title: 'Delivery',
    loading: 'Loading delivery preferences…',
    loadError: 'Could not load delivery preferences. Try again.',
    retry: 'Retry loading delivery preferences',
    saveError: 'Could not finish setup. Try again.',
    back: 'Back',
    backLabel: 'Back to privacy',
    continue: 'Continue',
    saving: 'Saving…',
    continueLabel: 'Continue with selected delivery',
    railContinue: 'Next',
  },
  deliveryMutual: {
    title: 'Mutual Friends',
    segment: 'MUTUAL FRIENDS',
    heading: 'Mutual friend relay',
    body: 'Because of restrictions on background processing on {platform}, this method is not reliable for daily usage unless you’re working with a very large pool of mutual friends. Enabling this setting may cause you to have unreliable or missed location updates.',
  },
  deliveryStash: {
    title: 'Mutuals + Stash Server',
    segment: 'STASH',
    heading: 'Mutuals + Stash Server',
    body: 'If your friends are offline and can’t receive your location updates, using stash will allow friends to catch up with your location updates when they come back online. Stash entries are encrypted and can only be read by your friends, and are auto deleted after a short period of time.',
  },
} as const;
