import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { RosterView } from '../../core/repeaters';
import MyRepeatersScreen from '../my-repeaters-screen';

jest.mock('@/global.css', () => ({}));
jest.mock('@/features/social/components/pressable-action', () => ({
  PressableAction: jest.requireActual('react-native').Pressable,
}));
jest.mock('@/features/settings/components/settings-page', () => {
  const { View, Text } = jest.requireActual('react-native');
  return {
    SettingsPage: ({ title, children }: { title: string; children: ReactNode }) => (
      <View>
        <Text>{title}</Text>
        {children}
      </View>
    ),
    SettingsSection: ({ label, children }: { label: string; children: ReactNode }) => (
      <View>
        <Text>{label}</Text>
        {children}
      </View>
    ),
  };
});
const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const ME = '11'.repeat(32);
const SAM = '22'.repeat(32);
const MINE: RosterView = {
  rosterId: 'mine',
  owner: ME,
  ownerLabel: 'Your repeaters',
  mine: true,
  open: false,
  carriesMe: true,
  machines: [
    { id: 'aa'.repeat(32), short: 'aaaaaa', name: 'Living room PC', label: 'Living room PC' },
    { id: 'bb'.repeat(32), short: 'bbbbbb', name: null, label: 'bbbbbb' },
  ],
  carried: 2,
  members: [
    { id: ME, label: 'You', isMe: true },
    { id: SAM, label: '@sam', isMe: false },
  ],
  vouchers: [],
  canEnroll: false,
  canInvite: true,
  inviters: [],
  invited: [],
};

const ok = () => jest.fn(async (..._args: unknown[]): Promise<string | null> => null);
const mockRepeaters = {
  status: 'ready',
  sections: { mine: MINE as RosterView | null, carryingMe: [], throughFriends: [], others: [] },
  friends: [] as { endpointId: string; handle: string }[],
  error: null,
  busyRoster: null,
  ownerControls: true,
  inviteControls: true,
  autoInvite: false as boolean | null,
  setCarried: ok(),
  setPolicy: ok(),
  removeMachine: ok(),
  removeMember: ok(),
  setInviter: ok(),
  invite: ok(),
  setAutoInvite: ok(),
};
jest.mock('../../hooks/use-repeaters', () => ({ useRepeaters: () => mockRepeaters }));

describe('MyRepeatersScreen', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
    mockRepeaters.sections.mine = MINE;
    mockRepeaters.ownerControls = true;
  });

  function render() {
    act(() => {
      renderer = create(<MyRepeatersScreen />);
    });
  }
  const byLabel = (label: string) => renderer.root.findAllByProps({ accessibilityLabel: label });
  const toggle = (label: string) =>
    renderer.root.findAll(
      (n) => n.props.accessibilityLabel === label && typeof n.props.onValueChange === 'function'
    )[0];
  const text = () => JSON.stringify(renderer.toJSON());

  it('shows machines, policy and people on one page', () => {
    render();
    for (const label of ['MACHINES · 2', 'WHO CAN JOIN', 'PEOPLE · 2 CARRIED', 'INVITE']) {
      expect(text()).toContain(label);
    }
    expect(text()).toContain('Living room PC');
    // A named machine keeps its short id beside the name; an unnamed one is its short id.
    expect(text()).toContain('aaaaaa');
    expect(text()).toContain('@sam');
  });

  it('removes a machine only on the second tap', async () => {
    render();
    act(() => byLabel('Remove machine Living room PC')[0].props.onPress());
    expect(mockRepeaters.removeMachine).not.toHaveBeenCalled();
    await act(async () => byLabel('Confirm: Remove machine Living room PC')[0].props.onPress());
    expect(mockRepeaters.removeMachine).toHaveBeenCalledWith('mine', 'aa'.repeat(32));
  });

  it('switches carrying and the policy on the roster', async () => {
    render();
    await act(async () => toggle('Carry my location on your repeaters').props.onValueChange(false));
    expect(mockRepeaters.setCarried).toHaveBeenCalledWith('mine', false);
    await act(async () => byLabel('Anyone')[0].props.onPress());
    expect(mockRepeaters.setPolicy).toHaveBeenCalledWith('mine', true);
  });

  it('removes a person from their row, only on the second tap', async () => {
    render();
    expect(byLabel('Remove @sam')).toHaveLength(0);
    act(() => byLabel('Options for @sam')[0].props.onPress());
    act(() => byLabel('Remove @sam')[0].props.onPress());
    expect(mockRepeaters.removeMember).not.toHaveBeenCalled();
    await act(async () => byLabel('Confirm: Remove @sam')[0].props.onPress());
    expect(mockRepeaters.removeMember).toHaveBeenCalledWith('mine', SAM);
  });

  it('lets a removal be cancelled', () => {
    render();
    act(() => byLabel('Remove machine Living room PC')[0].props.onPress());
    act(() => byLabel('CANCEL')[0].props.onPress());
    expect(byLabel('Confirm: Remove machine Living room PC')).toHaveLength(0);
    expect(mockRepeaters.removeMachine).not.toHaveBeenCalled();
  });

  it('offers auto-invite while the roster is invite only', () => {
    render();
    expect(byLabel('Invite new friends to my repeaters')).not.toHaveLength(0);
    act(() => renderer.unmount());
    mockRepeaters.sections.mine = { ...MINE, open: true };
    render();
    expect(byLabel('Invite new friends to my repeaters')).toHaveLength(0);
  });

  it('leaves out what an older binary cannot do', () => {
    mockRepeaters.ownerControls = false;
    render();
    expect(byLabel('Remove machine Living room PC')).toHaveLength(0);
    expect(byLabel('Options for @sam')).toHaveLength(0);
    expect(text()).not.toContain('WHO CAN JOIN');
  });

  it('adds a repeater through the claim screen', () => {
    render();
    act(() => byLabel('Add a machine')[0].props.onPress());
    expect(mockRouter.push).toHaveBeenCalledWith('/settings/repeaters/claim');
  });

  it('says so when there is no roster yet', () => {
    mockRepeaters.sections.mine = null;
    render();
    expect(text()).toContain('No repeaters yet');
  });
});
