// GENERATED from onboarding.md by `just copy`. Edit the Markdown, not this file.

export const ONBOARDING_COPY: {
  readonly splash: {
    readonly start: string;
    readonly railStart: string;
    readonly heading?: string;
    readonly body?: string;
  };
  readonly profile: { readonly title: string; readonly intro?: string };
  readonly privacy: {
    readonly title: string;
    readonly back: string;
    readonly backLabel: string;
    readonly continue: string;
    readonly continueLabel: string;
    readonly railContinue: string;
    readonly lede?: string;
    readonly letter?: string;
    readonly caveat?: string;
    readonly next?: string;
    readonly signoff?: string;
  };
  readonly delivery: {
    readonly title: string;
    readonly loading: string;
    readonly loadError: string;
    readonly retry: string;
    readonly saveError: string;
    readonly back: string;
    readonly backLabel: string;
    readonly continue: string;
    readonly saving: string;
    readonly continueLabel: string;
    readonly railContinue: string;
  };
  readonly deliveryMutual: {
    readonly title: string;
    readonly segment: string;
    readonly heading?: string;
    readonly body?: string;
  };
  readonly deliveryStash: {
    readonly title: string;
    readonly segment: string;
    readonly heading?: string;
    readonly body?: string;
  };
} = {
  splash: {
    start: 'Get started',
    railStart: 'Start',
    heading: 'Find your cryptids in the world.',
    body: 'Share your location with friends and see where you’ve been. We’ll never save, sell, or snoop on your trail.',
  },
  profile: {
    title: 'Set up your profile',
    intro: 'Choose how friends see you. You can change this later.',
  },
  privacy: {
    title: 'A quick note from us',
    back: 'Back',
    backLabel: 'Back to profile',
    continue: 'Continue',
    continueLabel: 'Continue to delivery',
    railContinue: 'Next',
    lede: 'What makes streetCryptid different?',
    letter:
      'We built streetCryptid around privacy from the start. We don’t collect logs, telemetry, or any other data.\n\nSharing your location is private too. Wherever we can, it travels straight from your phone to your friends’ phones, so it never sits on a server for anyone else to read. The catch is that a friend’s phone has to be listening when you send it, and phones in pockets often aren’t.\n\nSo there’s also a more reliable option: the stash. It’s a server that holds your latest location until your friends come back online, encrypted so only they can read it. Like the app, it’s open source and built to know nothing about you. It’s for folks who don’t need the extra privacy and want friends to always see where they are. If you don’t trust us, you can run your own.\n\nRead more about how we protect your privacy on our [website](https://streetcrypt.id).',
    signoff: 'The streetCryptid team',
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
    heading: 'Friends pass your location along',
    body: 'Background limits on {platform} mean your friends’ phones often aren’t listening when you share. Unless you have a lot of mutual friends, expect late or missed location updates.',
  },
  deliveryStash: {
    title: 'Mutual Friends + Stash',
    segment: 'STASH',
    heading: 'The stash covers for offline friends',
    body: 'When friends are offline, the stash holds your latest location until they’re back. It’s encrypted so only your friends can read it, and it’s deleted after a short time.',
  },
};
