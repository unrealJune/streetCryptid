import type { NativeRepeaterRoster } from 'iroh-location';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { usePairingRepeaterOffer, type PairingRepeaterOffer } from '../pairing-repeater-offer';

jest.mock('@/global.css', () => ({}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../repeater-chrome', () => ({
  FactList: () => null,
  IslandPanel: () => null,
  PanelActions: () => null,
  PanelButton: () => null,
  ToggleRow: () => null,
}));

const MOCK_ME = '11'.repeat(32);
const ME = MOCK_ME;
const SAM = '22'.repeat(32);

function roster(over: Partial<NativeRepeaterRoster>): NativeRepeaterRoster {
  return {
    rosterId: 'r',
    owner: ME,
    mine: false,
    open: false,
    carriesMe: false,
    repeaters: [],
    carried: 0,
    ...over,
  };
}

let mockRosters: NativeRepeaterRoster[] = [];
const mockClient = {
  rosters: jest.fn(async () => mockRosters),
  invites: { invite: jest.fn(async () => true) },
  pairing: {
    setOffer: jest.fn(async (_ids: readonly string[]) => {}),
    want: jest.fn(async () => false),
  },
};
jest.mock('../../net/repeater-client', () => ({ getRepeaterClient: () => mockClient }));
jest.mock('@/features/social/hooks/use-location-sharing', () => ({
  useLocationSharing: () => ({ snapshot: { self: { endpointId: MOCK_ME } } }),
}));

describe('usePairingRepeaterOffer', () => {
  let renderer: ReactTestRenderer;
  let offer: PairingRepeaterOffer;

  function Probe({ friend }: { friend: { endpointId: string; handle: string } | null }) {
    offer = usePairingRepeaterOffer(friend);
    return null;
  }

  async function render(friend: { endpointId: string; handle: string } | null) {
    await act(async () => {
      renderer = create(<Probe friend={friend} />);
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockRosters = [
      roster({ rosterId: 'mine-open', mine: true, open: true, canInvite: true }),
      roster({ rosterId: 'kits', owner: '33'.repeat(32), carriesMe: true, canInvite: true }),
      roster({ rosterId: 'sams', owner: SAM, offeredBy: [SAM] }),
      roster({ rosterId: 'not-offered', owner: SAM, vouchers: [SAM], canEnroll: true }),
    ];
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('offers every roster I may invite to before there is anyone to offer it to', async () => {
    await render(null);
    expect(offer.offers.mine.map((r) => r.rosterId)).toEqual(['mine-open', 'kits']);
    expect([...offer.offering]).toEqual(['mine-open', 'kits']);
    // The core is told, so the record is written the moment a pair completes.
    expect(mockClient.pairing.setOffer).toHaveBeenLastCalledWith(['kits', 'mine-open']);

    act(() => offer.setOffering('mine-open', false));
    expect(mockClient.pairing.setOffer).toHaveBeenLastCalledWith(['kits']);
  });

  it('answers only what the friend offered, all yes until switched off, and applies both', async () => {
    await render({ endpointId: SAM, handle: '@sam' });
    expect(offer.offers.theirs.map((r) => r.rosterId)).toEqual(['sams']);
    expect([...offer.accepting]).toEqual(['sams']);
    act(() => offer.setOffering('mine-open', false));

    act(() => offer.apply());
    expect(mockClient.invites.invite).toHaveBeenCalledTimes(1);
    expect(mockClient.invites.invite).toHaveBeenCalledWith('kits', SAM);
    expect(mockClient.pairing.want).toHaveBeenCalledWith('sams', true);
  });

  it('picks up an offer that arrives while the reveal is up, switched on', async () => {
    const offered = mockRosters.splice(2, 1);
    await render({ endpointId: SAM, handle: '@sam' });
    expect(offer.offers.theirs).toEqual([]);
    mockRosters.push(...offered);
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect([...offer.accepting]).toEqual(['sams']);
  });

  it('says yes to nothing it was told no to', async () => {
    await render({ endpointId: SAM, handle: '@sam' });
    act(() => offer.setAccepting('sams', false));
    act(() => offer.apply());
    expect(mockClient.pairing.want).not.toHaveBeenCalled();
  });
});
