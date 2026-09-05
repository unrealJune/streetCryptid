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

const WITH_STASH: DeliveryAvailability = { stashConfigured: true };
const NO_STASH: DeliveryAvailability = { stashConfigured: false };

describe('parseDeliveryMode', () => {
  it('accepts every mode it ships', () => {
    for (const mode of DELIVERY_MODES) expect(parseDeliveryMode(mode)).toBe(mode);
  });

  it('reads anything else as the default rather than throwing', () => {
    // A row written by a newer build the user has since rolled back from.
    expect(parseDeliveryMode('carrier-pigeon')).toBe('mutual');
    expect(parseDeliveryMode(null)).toBe('mutual');
    expect(parseDeliveryMode(undefined)).toBe('mutual');
    expect(parseDeliveryMode('')).toBe('mutual');
  });

  it('reads the short-lived `direct` value as mutual', () => {
    // An unreleased build of this picker briefly offered it. Anyone who has it stored was
    // already relaying through their pool the whole time.
    expect(parseDeliveryMode('direct')).toBe('mutual');
  });
});

describe('effectiveDeliveryMode', () => {
  it('honours a choice this build can actually make', () => {
    expect(effectiveDeliveryMode('stash', WITH_STASH)).toBe('stash');
    expect(effectiveDeliveryMode('mutual', WITH_STASH)).toBe('mutual');
  });

  it('falls back to mutual when the stash is not deployed', () => {
    // The safe direction: mutual is what the app does anyway, so the fallback can never
    // understate where a location goes.
    expect(effectiveDeliveryMode('stash', NO_STASH)).toBe('mutual');
  });

  it('never makes mutual unavailable — it is the floor, not a feature', () => {
    expect(effectiveDeliveryMode('mutual', NO_STASH)).toBe('mutual');
  });
});

describe('isDeliveryModeDowngraded', () => {
  it('is how the screen knows to say the choice is not being honoured', () => {
    expect(isDeliveryModeDowngraded('stash', NO_STASH)).toBe(true);
    expect(isDeliveryModeDowngraded('stash', WITH_STASH)).toBe(false);
    expect(isDeliveryModeDowngraded('mutual', NO_STASH)).toBe(false);
  });
});

describe('deliveryModeOptions', () => {
  it('lists every mode even when it cannot be offered, with the reason attached', () => {
    const options = deliveryModeOptions(NO_STASH);

    expect(options.map((option) => option.id)).toEqual(['mutual', 'stash']);
    expect(options.map((option) => option.available)).toEqual([true, false]);
    expect(options.find((option) => option.id === 'stash')?.unavailableReason).toBe(
      'no-stash-deployed'
    );
  });

  it('attaches no reason to a mode that is available', () => {
    for (const option of deliveryModeOptions(WITH_STASH)) {
      expect(option.available).toBe(true);
      expect(option.unavailableReason).toBeNull();
    }
  });
});

describe('deliveryModeFromLegacyStashOptIn', () => {
  it('keeps an install on whatever it was already doing', () => {
    expect(deliveryModeFromLegacyStashOptIn(true)).toBe('stash');
    // The pre-picker default pushed to the whole pool, which is `mutual` — never `direct`.
    expect(deliveryModeFromLegacyStashOptIn(false)).toBe('mutual');
  });
});

describe('copy', () => {
  it('covers every mode', () => {
    for (const mode of DELIVERY_MODES) expect(DELIVERY_MODE_COPY[mode].id).toBe(mode);
  });

  it('states the metadata cost of mutual relay rather than leaving it implied', () => {
    expect(DELIVERY_MODE_COPY.mutual.note).toMatch(/can tell that you are all friends/i);
  });

  it('offers no route that would understate where a location goes', () => {
    // There is no "direct only": pool members relay for each other by construction, so a
    // route promising otherwise would be a claim the architecture cannot keep.
    expect(DELIVERY_MODES).not.toContain('direct');
  });

  it('never claims a carrier can read what it carries', () => {
    // The one promise the whole screen rests on. If a rewrite ever softens this, the test is
    // the place that should complain.
    expect(DELIVERY_MODE_COPY.mutual.body).toMatch(/cannot read/i);
    expect(DELIVERY_MODE_COPY.stash.body).toMatch(/never can|only the friend/i);
  });
});
