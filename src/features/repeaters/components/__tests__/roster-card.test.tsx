import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Switch } from 'react-native';

import type { RosterView } from '../../core/repeaters';
import { RosterCard } from '../roster-card';

jest.mock('@/global.css', () => ({}));

const ROSTER: RosterView = {
  rosterId: 'r1',
  owner: '11'.repeat(32),
  ownerLabel: 'Your repeaters',
  mine: true,
  open: true,
  carriesMe: true,
  machines: [{ id: 'aa'.repeat(32), short: 'aaaaaa' }],
  carried: 2,
  members: [
    { id: '11'.repeat(32), label: 'You', isMe: true },
    { id: '22'.repeat(32), label: '@sam', isMe: false },
  ],
  vouchers: [],
  canEnrol: false,
  canInvite: true,
  inviters: [],
  invited: [],
};

describe('RosterCard', () => {
  let renderer: ReactTestRenderer;
  const owner = {
    onPolicyChange: jest.fn(),
    onRemoveMember: jest.fn(),
    onRemoveMachine: jest.fn(),
  };

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
  });

  function render(props: Partial<Parameters<typeof RosterCard>[0]> = {}) {
    act(() => {
      renderer = create(
        <RosterCard
          roster={ROSTER}
          accent="#0f0"
          warning="#fa0"
          busy={false}
          onCarryChange={jest.fn()}
          {...props}
        />
      );
    });
  }

  const pressable = (label: string) => renderer.root.findByProps({ accessibilityLabel: label });

  it('removes a member only on the second tap, and never offers to remove me', () => {
    render({ owner });
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Remove You' })).toHaveLength(0);

    act(() => pressable('Remove @sam').props.onPress());
    expect(owner.onRemoveMember).not.toHaveBeenCalled();
    act(() => pressable('Confirm: Remove @sam').props.onPress());
    expect(owner.onRemoveMember).toHaveBeenCalledWith('22'.repeat(32));
  });

  it('lets a confirmation be cancelled', () => {
    render({ owner });
    act(() => pressable('Remove machine aaaaaa').props.onPress());
    act(() => pressable('Cancel').props.onPress());
    act(() => pressable('Remove machine aaaaaa').props.onPress());
    expect(owner.onRemoveMachine).not.toHaveBeenCalled();
  });

  it('shows someone else’s roster with only the carry switch', () => {
    render({ roster: { ...ROSTER, mine: false, ownerLabel: '@sam’s repeaters' } });
    expect(renderer.root.findAllByType(Switch).map((s) => s.props.accessibilityLabel)).toEqual([
      'Carry my trail on @sam’s repeaters',
    ]);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Remove @sam' })).toHaveLength(0);
  });

  it('offers no switch for an invite-only roster nobody invited me to, and names who vouched', () => {
    render({
      roster: {
        ...ROSTER,
        mine: false,
        carriesMe: false,
        canEnrol: false,
        open: false,
        ownerLabel: '@sam’s repeaters',
        vouchers: [{ id: '22'.repeat(32), label: '@sam', isMe: false }],
      },
    });
    expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Vouched for by @sam');
    expect(text).toContain('nobody has invited you yet');
  });

  it('invites a friend in one tap, and lets the owner make a member an inviter', () => {
    const onInvite = jest.fn();
    const onSetInviter = jest.fn();
    render({
      roster: {
        ...ROSTER,
        open: false,
        invited: [{ id: '44'.repeat(32), label: '@kit', isMe: false }],
      },
      owner: { ...owner, onSetInviter },
      invite: { candidates: [{ id: '33'.repeat(32), label: '@ash', isMe: false }], onInvite },
    });
    act(() => pressable('Invite @ash').props.onPress());
    expect(onInvite).toHaveBeenCalledWith('33'.repeat(32));
    expect(JSON.stringify(renderer.toJSON())).toContain('@kit · invited');
    act(() => pressable('Let @sam invite people').props.onPress());
    expect(onSetInviter).toHaveBeenCalledWith('22'.repeat(32), true);
  });

  it('shows no invite list where this phone may not invite', () => {
    render({
      roster: { ...ROSTER, canInvite: false },
      invite: {
        candidates: [{ id: '33'.repeat(32), label: '@ash', isMe: false }],
        onInvite: jest.fn(),
      },
    });
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Invite @ash' })).toHaveLength(0);
  });
});
