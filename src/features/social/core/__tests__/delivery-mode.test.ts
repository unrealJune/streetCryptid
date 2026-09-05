import {
  DELIVERY_MODES,
  DELIVERY_MODE_COPY,
  deliveryModeFromLegacyStashOptIn,
  deliveryModeOptions,
  effectiveDeliveryMode,
  isDeliveryModeDowngraded,
  parseDeliveryMode,
  type DeliveryAvailability,
} from '../delivery-mode';

const ALL: DeliveryAvailability = { stashConfigured: true, mutualSupported: true };
const NONE: DeliveryAvailability = { stashConfigured: false, mutualSupported: false };

describe('parseDeliveryMode', () => {
  it('accepts every mode it ships', () => {
    for (const mode of DELIVERY_MODES) expect(parseDeliveryMode(mode)).toBe(mode);
  });

  it('reads anything else as the default rather than throwing', () => {
    // A row written by a newer build the user has since rolled back from.
    expect(parseDeliveryMode('carrier-pigeon')).toBe('direct');
    expect(parseDeliveryMode(null)).toBe('direct');
    expect(parseDeliveryMode(undefined)).toBe('direct');
    expect(parseDeliveryMode('')).toBe('direct');
  });
});

describe('effectiveDeliveryMode', () => {
  it('honours a choice this build can actually make', () => {
    expect(effectiveDeliveryMode('stash', ALL)).toBe('stash');
    expect(effectiveDeliveryMode('mutual', ALL)).toBe('mutual');
  });

  it('falls back to direct when the stash is not deployed', () => {
    expect(effectiveDeliveryMode('stash', { ...ALL, stashConfigured: false })).toBe('direct');
  });

  it('falls back to direct when the native binary cannot carry for a mutual', () => {
    expect(effectiveDeliveryMode('mutual', { ...ALL, mutualSupported: false })).toBe('direct');
  });

  it('never makes direct unavailable — there has to be a floor', () => {
    expect(effectiveDeliveryMode('direct', NONE)).toBe('direct');
  });
});

describe('isDeliveryModeDowngraded', () => {
  it('is how the screen knows to say the choice is not being honoured', () => {
    expect(isDeliveryModeDowngraded('stash', { ...ALL, stashConfigured: false })).toBe(true);
    expect(isDeliveryModeDowngraded('stash', ALL)).toBe(false);
    expect(isDeliveryModeDowngraded('direct', NONE)).toBe(false);
  });
});

describe('deliveryModeOptions', () => {
  it('lists every mode even when it cannot be offered, with the reason attached', () => {
    const options = deliveryModeOptions(NONE);

    expect(options.map((option) => option.id)).toEqual(['direct', 'mutual', 'stash']);
    expect(options.map((option) => option.available)).toEqual([true, false, false]);
    expect(options.find((option) => option.id === 'stash')?.unavailableReason).toBe(
      'no-stash-deployed'
    );
    expect(options.find((option) => option.id === 'mutual')?.unavailableReason).toBe(
      'mutual-unsupported'
    );
  });

  it('attaches no reason to a mode that is available', () => {
    for (const option of deliveryModeOptions(ALL)) {
      expect(option.available).toBe(true);
      expect(option.unavailableReason).toBeNull();
    }
  });
});

describe('deliveryModeFromLegacyStashOptIn', () => {
  it('keeps an install that had offline delivery on', () => {
    expect(deliveryModeFromLegacyStashOptIn(true)).toBe('stash');
    expect(deliveryModeFromLegacyStashOptIn(false)).toBe('direct');
  });
});

describe('copy', () => {
  it('covers every mode', () => {
    for (const mode of DELIVERY_MODES) expect(DELIVERY_MODE_COPY[mode].id).toBe(mode);
  });

  it('states the metadata cost of mutual relay rather than leaving it implied', () => {
    expect(DELIVERY_MODE_COPY.mutual.note).toMatch(/mutual friends can tell/i);
  });

  it('never claims a carrier can read what it carries', () => {
    // The one promise the whole screen rests on. If a rewrite ever softens this, the test is
    // the place that should complain.
    expect(DELIVERY_MODE_COPY.mutual.body).toMatch(/cannot read/i);
    expect(DELIVERY_MODE_COPY.stash.body).toMatch(/never can|only the friend/i);
  });
});
