import React from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useAtomValue, useSetAtom } from 'jotai';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '../theme/ui';
import { GUTTER, INSET, PIECES, TOUCH_MIN } from '../theme/palette';
import {
  activeDmCallAtom,
  activeDmPeerByPodAtom,
  activePodIdAtom,
  activeTabAtom,
  activeVoiceSessionAtom,
  callLinksAtom,
  speakerOnAtom,
  voicePeersByPodAtom,
} from '../state/atoms';
import type { Calls } from '../voice/useCalls';

function CallBtn({
  icon,
  label,
  on = false,
  off = false,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  on?: boolean;
  off?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.btn, on && styles.btnOn, off && styles.btnOff]}
    >
      <Ionicons
        name={icon}
        size={20}
        color={on || off ? PIECES.ink : PIECES.sheet}
        style={off ? styles.hungUp : undefined}
      />
    </Pressable>
  );
}

/** The call you are in, on every screen: what it is doing, mute, speaker, leave. */
export function CallBar({ calls }: { calls: Calls }) {
  const session = useAtomValue(activeVoiceSessionAtom);
  const dmCall = useAtomValue(activeDmCallAtom);
  const links = useAtomValue(callLinksAtom);
  const speakerOn = useAtomValue(speakerOnAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);

  const dm = dmCall && dmCall.phase !== 'incoming' ? dmCall : null;
  if (!session && !dm) return null;

  const peers = session ? voicePeersByPod[session.podId] ?? [] : [];
  const states = Object.entries(links);
  const unreachable = states.filter(([, s]) => s === 'failed').map(([id]) => id);
  const connecting = states.some(([, s]) => s === 'connecting');
  const unreachableName =
    dm?.peerAlias ?? peers.find((p) => p.peerId === unreachable[0])?.alias ?? 'someone';

  let title: string;
  let sub: string;
  if (dm) {
    title = dm.phase === 'ringing' ? `Calling ${dm.peerAlias}` : dm.peerAlias;
    sub =
      dm.phase === 'ringing'
        ? dm.peerOnline
          ? 'Ringing'
          : 'Away. It rings when they are back.'
        : dm.phase === 'answering'
        ? 'Connecting'
        : unreachable.length > 0
        ? 'No sound yet. Trying another route.'
        : connecting || states.length === 0
        ? 'Connecting'
        : dm.peerSpeaking
        ? 'Speaking'
        : dm.peerMuted
        ? 'Muted'
        : 'Private call';
  } else {
    title = 'Room call';
    const others = Math.max(0, peers.length - 1);
    sub =
      session?.status === 'connecting'
        ? 'Connecting'
        : unreachable.length > 0
        ? `No sound from ${unreachableName} yet. Trying another route.`
        : connecting
        ? 'Connecting'
        : session?.micMode === 'listen'
        ? 'Listening only'
        : others === 0
        ? 'Nobody else yet'
        : `You and ${others} ${others === 1 ? 'other' : 'others'}`;
  }

  const muted = session ? session.muted : !!dm?.muted;
  const canMute = session ? session.status === 'connected' : dm?.phase === 'connected';

  const open = () => {
    if (dm) {
      setActivePodId(dm.podId);
      setActiveDmPeerMap((prev) => ({ ...prev, [dm.podId]: dm.peerId }));
      setActiveTab('chat');
    } else {
      setActiveTab('voice');
    }
  };

  return (
    <View style={styles.bar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${sub}. Open the call`}
        onPress={open}
        style={styles.text}
      >
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {sub}
        </Text>
      </Pressable>
      {canMute ? (
        <CallBtn
          icon={muted ? 'mic-off' : 'mic'}
          label={muted ? 'Unmute microphone' : 'Mute microphone'}
          on={muted}
          onPress={calls.toggleMute}
        />
      ) : null}
      {Platform.OS !== 'web' ? (
        <CallBtn
          icon={speakerOn ? 'volume-high' : 'ear'}
          label={speakerOn ? 'Switch to the earpiece' : 'Switch to the loudspeaker'}
          onPress={calls.toggleSpeaker}
        />
      ) : null}
      <CallBtn icon="call" label="Leave the call" off onPress={calls.hangUp} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 52,
    marginHorizontal: GUTTER,
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: INSET,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: 26,
    backgroundColor: PIECES.ink,
  },
  text: { flex: 1, minWidth: 0, minHeight: TOUCH_MIN, justifyContent: 'center' },
  title: { fontSize: 15, lineHeight: 19, fontWeight: '600', color: PIECES.sheet },
  sub: { fontSize: 13, lineHeight: 17, color: '#d0d0d0' },
  btn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: TOUCH_MIN / 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnOn: { backgroundColor: PIECES.sheet },
  btnOff: { backgroundColor: PIECES.off },
  // The handset put down.
  hungUp: { transform: [{ rotate: '135deg' }] },
});
