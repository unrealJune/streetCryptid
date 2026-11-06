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
    body: 'Share your location with your friends and track where you’ve been. We promise to never save, sell, or snoop on your trail.',
  },
  profile: {
    title: 'Set up your profile',
    intro: 'Choose how you appear to friends. You can change this later.',
  },
  privacy: {
    title: 'Quick message from us',
    back: 'Back',
    backLabel: 'Back to profile',
    continue: 'Continue',
    continueLabel: 'Continue to delivery',
    railContinue: 'Next',
    lede: 'What makes streetCryptid different?',
    letter:
      'streetCryptid was designed to be privacy focused from the ground up. We don’t collect logs, telemetry, or other data.\n\nWe’ve also taken steps to ensure that the way we share your location is also private. To facilitate this, we try to rely on peer-to-peer connections between friends. This means that your location can travel directly between your friend network without us ever needing to store it on a server for others to read. This also means that all of your friends need their phone to be listening when you send out your location. This is pretty hard.\n\nWe also offer a more resilient option, that uses a server to store your location updates for your friends to read when they come back online. This is called the “stash” option, and it is encrypted so that only your friends can read it. Like this app, the server is open source and designed to hold no information about you. We make it an option for folks that may not need the extra privacy, but want to make sure their friends can always see their location updates. You can always host your own server if you don’t trust us.\n\nRead more about our privacy preserving decisions on our [website](https://streetcrypt.id).',
    signoff: '— the streetCryptid team.',
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
};
