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
    body: 'Share your location with friends and see where you’ve been. We’ll never sell it or snoop on it.',
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
      'We built streetCryptid around privacy from the start. We don’t collect logs, telemetry, or any other data.\n\nYour location goes straight from your phone to your friends’ phones whenever it can. When their phones are asleep, a repeater can hold it for them, sealed so only they can open it. You’ll pick one next.\n\nMore on how it all works on our [website](https://streetcrypt.id).',
    signoff: 'The streetCryptid team',
  },
  delivery: {
    title: 'Delivery',
    loading: 'Loading delivery preferences…',
    loadError: 'Couldn’t load your delivery settings. Try again.',
    retry: 'Retry loading delivery settings',
    saveError: 'Couldn’t finish setup. Try again.',
    back: 'Back',
    backLabel: 'Back to privacy',
    continue: 'Continue',
    saving: 'Saving…',
    continueLabel: 'Continue with selected delivery',
    railContinue: 'Next',
  },
  deliveryMutual: {
    title: 'Friends only',
    segment: 'FRIENDS ONLY',
    heading: 'Friends pass your location along',
    body: 'On {platform}, apps can only do so much in the background, so your friends’ phones often aren’t listening when you share. Without a repeater, expect late or missed updates.',
  },
  deliveryStash: {
    title: 'Official hosted repeater',
    segment: 'REPEATER',
    heading: 'A repeater covers for sleeping phones',
    body: 'When your friends’ phones can’t hear you, our repeater holds your latest location for a little while. Only your friends hold the key, so we can’t see where you are.',
  },
};
