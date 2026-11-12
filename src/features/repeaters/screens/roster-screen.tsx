import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { type Href, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing, type CryptidChrome } from '@/constants/theme';

import {
  FactList,
  IslandPanel,
  PanelActions,
  PanelButton,
  PanelRow,
  ScreenHeader,
  ToggleRow,
  useRepeaterChrome,
} from '../components/repeater-chrome';
import {
  enrollFacts,
  rosterLine,
  vouchLine,
  type RosterSections,
  type RosterView,
} from '../core/repeaters';
import { layoutRosterGraph, YOU, type GraphNode, type RosterGraph } from '../core/roster-graph';
import { useRepeaters, type UseRepeaters } from '../hooks/use-repeaters';

/**
 * Settings → Repeaters → Your roster: every machine this phone knows, around you. Your own
 * machines sit below the divide, each tied to you; rosters that carry you sit above it, tied to
 * you through their first machine; rosters friends offer float above, unconnected and dashed,
 * until you enroll. Tap a machine for what you can do about it, in the island along the bottom.
 *
 * What each tap can do is exactly what the roster rules allow this phone (REPEATERS.md §3.2):
 * on your own machine, the roster's policy and whether it carries you, and removing the machine;
 * on someone else's, stopping it carrying you (leaving is cooperative, §2.2, so the copy says
 * "stop carrying", never "can no longer see"); on an offered one, enrolling — or, for an
 * invite-only roster nobody invited you to, why not. There is no "deny": nothing in the protocol
 * refuses an offer, so the panel just closes. People (members, inviters, invites) are a list, on
 * their own page, because a map of a hundred phones is not readable.
 */
export default function RosterScreen() {
  const { chrome } = useRepeaterChrome();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const repeaters = useRepeaters({ refreshNames: true });
  const { sections } = repeaters;
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const graph = useMemo(() => layoutRosterGraph(sections), [sections]);
  const node = graph.nodes.find((n) => n.id === selected) ?? null;
  const roster = node ? findRoster(sections, node.rosterId) : null;

  function pick(id: string | null) {
    setSelected((was) => (was === id ? null : id));
    setConfirming(false);
    setError(null);
  }

  async function run(outcome: Promise<string | null>, after?: () => void) {
    setError(null);
    const failure = await outcome;
    if (failure) setError(failure);
    else after?.();
  }

  const back = () =>
    router.canGoBack() ? router.back() : router.replace('/settings/repeaters' as Href);

  return (
    <View
      style={[
        styles.screen,
        { backgroundColor: chrome.bg, paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      <ScreenHeader
        chrome={chrome}
        mode="REPEATERS"
        onBack={back}
        onAdd={
          repeaters.status === 'unsupported'
            ? undefined
            : () => router.push('/settings/repeaters/claim' as Href)
        }
        paddingTop={Math.max(insets.top, Spacing.three)}
      />

      <View
        style={styles.graph}
        onLayout={({ nativeEvent: { layout } }) =>
          setSize((was) =>
            was && was.width === layout.width && was.height === layout.height
              ? was
              : { width: layout.width, height: layout.height }
          )
        }
      >
        {size ? (
          <GraphView
            chrome={chrome}
            graph={graph}
            sections={sections}
            size={size}
            selected={selected}
            onPick={pick}
          />
        ) : null}
        {graph.nodes.length === 0 && repeaters.status === 'ready' ? (
          <View pointerEvents="none" style={styles.empty}>
            <Text style={[styles.emptyText, { color: chrome.steel }]}>
              NO REPEATERS YET · TAP + TO ADD ONE
            </Text>
          </View>
        ) : null}
      </View>

      {node && roster ? (
        <SelectionPanel
          chrome={chrome}
          node={node}
          roster={roster}
          repeaters={repeaters}
          confirming={confirming}
          error={error}
          marginBottom={Math.max(insets.bottom, Spacing.two)}
          onClose={() => pick(null)}
          onConfirm={setConfirming}
          run={run}
          onPeople={() =>
            router.push(
              `/settings/repeaters/people?roster=${encodeURIComponent(roster.rosterId)}` as Href
            )
          }
        />
      ) : error ? (
        <IslandPanel
          chrome={chrome}
          status="SOMETHING WENT WRONG"
          statusColor={chrome.amber}
          detail={error}
          onClose={() => setError(null)}
          marginBottom={Math.max(insets.bottom, Spacing.two)}
        />
      ) : (
        <View style={{ height: Math.max(insets.bottom, Spacing.two) }} />
      )}
    </View>
  );
}

function findRoster(sections: RosterSections, rosterId: string): RosterView | null {
  return (
    [sections.mine, ...sections.carryingMe, ...sections.throughFriends].find(
      (r) => r?.rosterId === rosterId
    ) ?? null
  );
}

function SelectionPanel({
  chrome,
  node,
  roster,
  repeaters,
  confirming,
  error,
  marginBottom,
  onClose,
  onConfirm,
  run,
  onPeople,
}: {
  readonly chrome: CryptidChrome;
  readonly node: GraphNode;
  readonly roster: RosterView;
  readonly repeaters: UseRepeaters;
  readonly confirming: boolean;
  readonly error: string | null;
  readonly marginBottom: number;
  readonly onClose: () => void;
  readonly onConfirm: (on: boolean) => void;
  readonly run: (outcome: Promise<string | null>, after?: () => void) => Promise<void>;
  readonly onPeople: () => void;
}) {
  const busy = repeaters.busyRoster === roster.rosterId;
  const name = roster.ownerLabel.toUpperCase();
  const warn = (copy: string) => (error ? error : confirming ? copy : null);

  if (node.side === 'mine') {
    return (
      <IslandPanel
        chrome={chrome}
        status={`${node.label.toUpperCase()} · YOUR REPEATER`}
        statusColor={error ? chrome.amber : undefined}
        detail={
          warn(
            'Take it out of your roster? Once it hears, it stops carrying anyone and shows a new claim code. Getting it back means claiming it again.'
          ) ??
          (node.label === node.short ? rosterLine(roster) : `${node.short} · ${rosterLine(roster)}`)
        }
        onClose={onClose}
        marginBottom={marginBottom}
      >
        {confirming ? null : (
          <PanelRow>
            {repeaters.ownerControls ? (
              <ToggleRow
                chrome={chrome}
                title="Open to anyone"
                text={
                  roster.open
                    ? 'Anyone who learns of it may ask it to carry them.'
                    : 'Only people you invite. Nobody already carried is dropped.'
                }
                value={roster.open}
                disabled={busy}
                onChange={(open) => void run(repeaters.setPolicy(roster.rosterId, open))}
              />
            ) : null}
            <ToggleRow
              chrome={chrome}
              title="Carry my location"
              accessibilityLabel="Carry my location on your repeaters"
              value={roster.carriesMe}
              disabled={busy}
              onChange={(carry) => void run(repeaters.setCarried(roster.rosterId, carry))}
            />
          </PanelRow>
        )}
        <PanelActions>
          {confirming ? (
            <>
              <PanelButton
                chrome={chrome}
                kind="outline"
                label="CANCEL"
                onPress={() => onConfirm(false)}
              />
              <PanelButton
                chrome={chrome}
                kind="warn"
                label="CONFIRM REMOVE"
                accessibilityLabel={`Confirm: remove machine ${node.label}`}
                disabled={busy}
                onPress={() => void run(repeaters.removeMachine(roster.rosterId, node.id), onClose)}
              />
            </>
          ) : (
            <>
              {repeaters.ownerControls ? (
                <PanelButton
                  chrome={chrome}
                  kind="warn"
                  label="REMOVE"
                  accessibilityLabel={`Remove machine ${node.label}`}
                  disabled={busy}
                  onPress={() => onConfirm(true)}
                />
              ) : null}
              <PanelButton chrome={chrome} kind="outline" label="PEOPLE" onPress={onPeople} />
            </>
          )}
        </PanelActions>
      </IslandPanel>
    );
  }

  if (node.side === 'joined') {
    return (
      <IslandPanel
        chrome={chrome}
        status={name}
        statusColor={error ? chrome.amber : undefined}
        detail={
          warn('These repeaters will stop carrying your location once they hear.') ??
          `${rosterLine(roster)} · ${roster.machines.map((m) => m.label).join(', ')}`
        }
        onClose={onClose}
        marginBottom={marginBottom}
      >
        <PanelActions>
          {confirming ? (
            <>
              <PanelButton
                chrome={chrome}
                kind="outline"
                label="CANCEL"
                onPress={() => onConfirm(false)}
              />
              <PanelButton
                chrome={chrome}
                kind="warn"
                label="STOP CARRYING"
                accessibilityLabel={`Confirm: stop carrying my location on ${roster.ownerLabel}`}
                disabled={busy}
                onPress={() => void run(repeaters.setCarried(roster.rosterId, false), onClose)}
              />
            </>
          ) : (
            <>
              <PanelButton
                chrome={chrome}
                kind="warn"
                label="STOP CARRYING"
                accessibilityLabel={`Stop carrying my location on ${roster.ownerLabel}`}
                disabled={busy}
                onPress={() => onConfirm(true)}
              />
              {roster.canInvite && repeaters.inviteControls ? (
                <PanelButton chrome={chrome} kind="outline" label="INVITE" onPress={onPeople} />
              ) : null}
            </>
          )}
        </PanelActions>
      </IslandPanel>
    );
  }

  // Offered through friends.
  const vouched = vouchLine(roster);
  return (
    <IslandPanel
      chrome={chrome}
      status={name}
      statusColor={error ? chrome.amber : undefined}
      detail={error ?? [rosterLine(roster), vouched].filter(Boolean).join(' · ')}
      onClose={onClose}
      marginBottom={marginBottom}
    >
      {roster.canEnroll ? (
        <>
          <PanelRow>
            <FactList chrome={chrome} facts={enrollFacts(roster)} />
          </PanelRow>
          <PanelActions>
            <PanelButton chrome={chrome} kind="outline" label="NOT NOW" onPress={onClose} />
            <PanelButton
              chrome={chrome}
              label="ENROLL"
              accessibilityLabel={`Carry my location on ${roster.ownerLabel}`}
              disabled={busy}
              onPress={() => void run(repeaters.setCarried(roster.rosterId, true), onClose)}
            />
          </PanelActions>
        </>
      ) : (
        <PanelRow>
          <Text style={[styles.note, { color: chrome.steel }]}>
            Invite only, and nobody has invited you yet.
          </Text>
        </PanelRow>
      )}
    </IslandPanel>
  );
}

const DOT_STEP = 22;
/** A node's label is a chip under a 16 pt square; past this it would cover its neighbours. */
const NODE_LABEL_MAX = 14;
/** Wide enough for a {@link NODE_LABEL_MAX}-character chip in 9 pt mono. */
const NODE_WIDTH = 96;

function nodeLabel(label: string): string {
  return label.length > NODE_LABEL_MAX ? `${label.slice(0, NODE_LABEL_MAX - 1)}…` : label;
}

function GraphView({
  chrome,
  graph,
  sections,
  size,
  selected,
  onPick,
}: {
  readonly chrome: CryptidChrome;
  readonly graph: RosterGraph;
  readonly sections: RosterSections;
  readonly size: { width: number; height: number };
  readonly selected: string | null;
  readonly onPick: (id: string) => void;
}) {
  const { width: W, height: H } = size;
  const paths = useMemo(() => {
    const grid = Skia.PathBuilder.Make();
    for (let y = DOT_STEP / 2; y < H; y += DOT_STEP) {
      for (let x = DOT_STEP / 2; x < W; x += DOT_STEP) grid.addCircle(x, y, 1);
    }
    const divide = Skia.PathBuilder.Make();
    for (let x = 4; x < W; x += 7) divide.addCircle(x, H / 2, 0.8);
    const tied = Skia.PathBuilder.Make();
    const tiedHot = Skia.PathBuilder.Make();
    const floating = Skia.PathBuilder.Make();
    const at = (id: string): [number, number] => {
      if (id === YOU) return [W / 2, H / 2];
      const n = graph.nodes.find((m) => m.id === id)!;
      return [n.fx * W, n.fy * H];
    };
    const selectedRoster = graph.nodes.find((n) => n.id === selected)?.rosterId ?? null;
    const rosterOf = (id: string) => graph.nodes.find((n) => n.id === id)?.rosterId ?? null;
    for (const link of graph.links) {
      const [x1, y1] = at(link.a);
      const [x2, y2] = at(link.b);
      const avail = link.kind === 'avail';
      const gap = avail ? 7 : 4.5;
      const steps = Math.max(1, Math.floor(Math.hypot(x2 - x1, y2 - y1) / gap));
      const hot =
        selectedRoster !== null &&
        (rosterOf(link.a) === selectedRoster || rosterOf(link.b) === selectedRoster);
      const into = avail ? floating : hot ? tiedHot : tied;
      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        into.addCircle(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, avail ? 1 : 1.3);
      }
    }
    return {
      grid: grid.detach(),
      divide: divide.detach(),
      tied: tied.detach(),
      tiedHot: tiedHot.detach(),
      floating: floating.detach(),
    };
  }, [W, H, graph, selected]);

  const rosterLabel = (id: string) =>
    [sections.mine, ...sections.carryingMe, ...sections.throughFriends].find(
      (r) => r?.rosterId === id
    )?.ownerLabel ?? '';

  return (
    <>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Canvas style={StyleSheet.absoluteFill}>
          <Path path={paths.grid} color={chrome.dot} opacity={0.08} />
          <Path path={paths.divide} color={chrome.steel} opacity={0.35} />
          <Path path={paths.floating} color={chrome.steel} opacity={0.4} />
          <Path path={paths.tied} color={chrome.green} opacity={selected ? 0.3 : 0.6} />
          <Path path={paths.tiedHot} color={chrome.green} opacity={0.9} />
        </Canvas>
      </View>

      <Text style={[styles.sideLabel, styles.sideTop, { color: chrome.steel }]}>JOINED</Text>
      <Text style={[styles.sideLabel, styles.sideBottom, { color: chrome.steel }]}>YOURS</Text>

      {graph.clusters.map((c) => (
        <Text
          key={c.rosterId}
          pointerEvents="none"
          numberOfLines={1}
          style={[
            styles.cluster,
            {
              color: c.side === 'available' ? chrome.steel : chrome.ink,
              left: c.fx * W - 60,
              top: c.fy * H - 30,
            },
          ]}
        >
          {c.label.toUpperCase()}
        </Text>
      ))}

      <View pointerEvents="none" style={[styles.you, { left: W / 2 - 30, top: H / 2 - 10 }]}>
        <View style={[styles.youDot, { backgroundColor: chrome.ink }]} />
        <Text style={[styles.youLabel, { color: chrome.ink, backgroundColor: chrome.bg }]}>
          YOU
        </Text>
      </View>

      {graph.nodes.map((n) => {
        const on = n.id === selected;
        const avail = n.side === 'available';
        const tint = avail ? chrome.steel : chrome.green;
        const owner = rosterLabel(n.rosterId);
        return (
          <Pressable
            key={n.id}
            accessibilityRole="button"
            accessibilityLabel={
              n.side === 'mine'
                ? `Your repeater ${n.label}`
                : `${owner.replace(/s$/, '')} ${n.label}${avail ? ', offered to you' : ''}`
            }
            accessibilityState={{ selected: on }}
            hitSlop={6}
            onPress={() => onPick(n.id)}
            style={[styles.node, { left: n.fx * W - NODE_WIDTH / 2, top: n.fy * H - 14 }]}
          >
            <View
              style={[
                styles.nodeDot,
                {
                  borderColor: tint,
                  borderStyle: avail ? 'dashed' : 'solid',
                  backgroundColor: on ? tint : chrome.bg,
                },
              ]}
            />
            <Text
              style={[
                styles.nodeLabel,
                {
                  color: on ? chrome.ink : chrome.steel,
                  backgroundColor: chrome.island,
                  borderColor: on ? tint : 'transparent',
                },
              ]}
            >
              {nodeLabel(n.label)}
            </Text>
          </Pressable>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  graph: { flex: 1, marginBottom: Spacing.two, marginHorizontal: 12, minHeight: 0 },
  empty: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: '18%',
  },
  emptyText: { fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 9, letterSpacing: 1.6 },
  sideLabel: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.6,
    left: 4,
    position: 'absolute',
  },
  sideTop: { top: 2 },
  sideBottom: { bottom: 2 },
  cluster: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.2,
    position: 'absolute',
    textAlign: 'center',
    width: 120,
  },
  you: { alignItems: 'center', gap: 3, position: 'absolute', width: 60 },
  youDot: { borderRadius: 7, height: 14, width: 14 },
  youLabel: {
    borderRadius: 3,
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 13,
    letterSpacing: 1.4,
    paddingHorizontal: 4,
  },
  node: { alignItems: 'center', gap: 3, minHeight: 44, position: 'absolute', width: NODE_WIDTH },
  nodeDot: { borderRadius: 3, borderWidth: 2, height: 16, width: 16 },
  nodeLabel: {
    borderRadius: 4,
    borderWidth: 1,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1,
    overflow: 'hidden',
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  note: { fontFamily: 'IBMPlexMono_400Regular', fontSize: 11, lineHeight: 15 },
});
