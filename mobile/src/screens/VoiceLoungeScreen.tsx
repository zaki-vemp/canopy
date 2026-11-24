import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../theme/ui';
import { Audio } from 'expo-av';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { fetchPods } from '../api/client';
import {
  activePodIdAtom,
  activeTabAtom,
  activeVoiceSessionAtom,
  lastWebRtcSignalAtom,
  voicePeersByPodAtom,
  wsConnectedAtom,
} from '../state/atoms';
import type {
  PodDetailDto,
  VoicePeerDto,
  WsOutboundFrame,
} from '../types/canopy';
import {
  PIECES,
  PIECE_HEX,
  TOUCH_MIN,
  capacityTierBadge,
  pieceColor,
} from '../theme/palette';
import { Btn, Chip, Piece } from '../components/Pieces';
import { createPodProposal } from '../api/client';
import {
  activeDmCallAtom,
  activeDmPeerByPodAtom,
  dmCallNoticeAtom,
} from '../state/atoms';

const MONO_FONT = 'DMMono_500Medium';

export function VoiceLoungeScreen({
  sendFrame,
}: {
  sendFrame: (frame: WsOutboundFrame) => boolean;
}) {
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const [voiceSession, setVoiceSession] = useAtom(activeVoiceSessionAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const wsConnected = useAtomValue(wsConnectedAtom);
  const lastSignal = useAtomValue(lastWebRtcSignalAtom);
  const queryClient = useQueryClient();
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);
  const [activeDmCall, setActiveDmCall] = useAtom(activeDmCallAtom);
  const setDmCallNotice = useSetAtom(dmCallNoticeAtom);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [memberNotice, setMemberNotice] = useState<string | null>(null);

  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const webStreamRef = useRef<{ getTracks: () => Array<{ stop: () => void }> } | null>(
    null
  );

  const podsQuery = useQuery({
    queryKey: ['pods'],
    queryFn: fetchPods,
  });

  const pods = podsQuery.data?.pods ?? [];
  const activePod: PodDetailDto | null = useMemo(() => {
    if (pods.length === 0) return null;
    return pods.find((p) => p.podId === activePodId) ?? pods[0];
  }, [pods, activePodId]);

  useEffect(() => {
    if (activePod && activePod.podId !== activePodId) {
      setActivePodId(activePod.podId);
    }
  }, [activePod, activePodId, setActivePodId]);

  useEffect(() => {
    return () => {
      if (webStreamRef.current) {
        webStreamRef.current.getTracks().forEach((t) => t.stop());
        webStreamRef.current = null;
      }
    };
  }, []);

  const stopLocalCapture = () => {
    if (webStreamRef.current) {
      webStreamRef.current.getTracks().forEach((t) => t.stop());
      webStreamRef.current = null;
    }
  };

  const acquireMicWithFallback = async (): Promise<'live' | 'listen-synth'> => {
    try {
      if (Platform.OS === 'web') {
        const nav = globalThis.navigator as
          | {
              mediaDevices?: {
                getUserMedia?: (c: { audio: boolean }) => Promise<{
                  getTracks: () => Array<{ stop: () => void }>;
                }>;
              };
            }
          | undefined;
        if (nav?.mediaDevices?.getUserMedia) {
          const stream = await nav.mediaDevices.getUserMedia({ audio: true });
          webStreamRef.current = stream;
          return 'live';
        }
        return 'listen-synth';
      }

      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        return 'listen-synth';
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      return 'live';
    } catch {
      return 'listen-synth';
    }
  };

  const handleJoinCall = async () => {
    if (!activePod) return;
    setStatusNotice(null);
    stopLocalCapture();

    const micMode = await acquireMicWithFallback();
    const sent = sendFrame({
      type: 'voice_join',
      muted: micMode !== 'live',
      deafened: false,
    });

    setVoiceSession({
      podId: activePod.podId,
      muted: micMode !== 'live',
      deafened: false,
      speaking: false,
      micMode,
    });

    if (!sent) {
      setStatusNotice(
        'Joining the call. Reconnecting first.'
      );
    } else if (micMode === 'listen-synth') {
      setStatusNotice(
        'You are in, listening. No microphone found, so use Speak to test your ring.'
      );
    } else {
      setStatusNotice('You are in the call with your microphone on.');
    }
  };

  const handleLeaveCall = () => {
    stopLocalCapture();
    sendFrame({ type: 'voice_leave' });
    setVoiceSession(null);
    setStatusNotice('You left the call.');
  };

  const handleToggleMute = () => {
    if (!voiceSession) return;
    const nextMuted = !voiceSession.muted;
    const nextSpeaking = nextMuted ? false : voiceSession.speaking;
    const nextDeafened = !nextMuted ? false : voiceSession.deafened;
    setVoiceSession({
      ...voiceSession,
      muted: nextMuted,
      deafened: nextDeafened,
      speaking: nextSpeaking,
    });
    sendFrame({
      type: 'voice_state',
      muted: nextMuted,
      deafened: nextDeafened,
      speaking: nextSpeaking,
    });
  };

  const handleToggleDeafen = () => {
    if (!voiceSession) return;
    const nextDeafened = !voiceSession.deafened;
    const nextMuted = nextDeafened ? true : voiceSession.muted;
    const nextSpeaking = nextDeafened ? false : voiceSession.speaking;
    setVoiceSession({
      ...voiceSession,
      muted: nextMuted,
      deafened: nextDeafened,
      speaking: nextSpeaking,
    });
    sendFrame({
      type: 'voice_state',
      muted: nextMuted,
      deafened: nextDeafened,
      speaking: nextSpeaking,
    });
  };

  const handleToggleSpeakingPulse = () => {
    if (!voiceSession) return;
    const nextSpeaking = !voiceSession.speaking;
    const nextMuted = nextSpeaking ? false : voiceSession.muted;
    const nextDeafened = nextSpeaking ? false : voiceSession.deafened;
    setVoiceSession({
      ...voiceSession,
      muted: nextMuted,
      deafened: nextDeafened,
      speaking: nextSpeaking,
    });
    sendFrame({
      type: 'voice_state',
      muted: nextMuted,
      deafened: nextDeafened,
      speaking: nextSpeaking,
    });
  };

  if (!activePod) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyTitle}>No room yet</Text>
        <Text style={styles.emptySub}>
          Join a room first. Its people and its call show up here.
        </Text>
        <Btn label="Go to Rooms" kind="blue" big onPress={() => setActiveTab('pods')} />
      </View>
    );
  }

  const activeSessionInThisPod =
    voiceSession && voiceSession.podId === activePod.podId
      ? voiceSession
      : null;

  const connectedPeers: VoicePeerDto[] = (() => {
    const wsPeers = voicePeersByPod[activePod.podId];
    const base: VoicePeerDto[] =
      wsPeers && wsPeers.length > 0
        ? [...wsPeers]
        : activePod.members
            .filter((m) => m.inVoice)
            .map((m) => ({
              peerId: m.peerId,
              alias: m.alias,
              color: m.color,
              muted: false,
              deafened: false,
              speaking: false,
            }));

    if (
      activeSessionInThisPod &&
      !base.some((p) => p.peerId === activePod.myPeerId)
    ) {
      base.push({
        peerId: activePod.myPeerId,
        alias: activePod.myAlias,
        color: activePod.myColor,
        muted: activeSessionInThisPod.muted,
        deafened: activeSessionInThisPod.deafened,
        speaking: activeSessionInThisPod.speaking,
      });
    }
    return base;
  })();

  const roomName = activePod.title?.trim() || activePod.interestLabel;
  const members = activePod.members;
  const freeSeats = Math.max(0, activePod.maxMembers - members.length);
  const selected =
    members.find((m) => m.peerId === selectedPeerId) ?? null;

  const openWrite = (peerId: string) => {
    setActiveDmPeerMap((prev) => ({ ...prev, [activePod.podId]: peerId }));
    setActiveTab('chat');
  };

  const startPrivateCall = async (peerId: string, alias: string, online: boolean) => {
    if (voiceSession) {
      sendFrame({ type: 'voice_leave' });
      stopLocalCapture();
      setVoiceSession(null);
    }
    if (activeDmCall && activeDmCall.peerId !== peerId) {
      sendFrame({ type: 'dm_call_end', peerId: activeDmCall.peerId });
    }
    try {
      if (Platform.OS !== 'web') {
        await Audio.requestPermissionsAsync();
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });
      }
    } catch {
      // listen-only fallback
    }
    setDmCallNotice(null);
    setActiveDmCall({
      podId: activePod.podId,
      peerId,
      peerAlias: alias,
      peerColor: pieceColor(alias),
      peerOnline: online,
      phase: 'ringing',
      muted: false,
      speaking: false,
      peerMuted: false,
      peerSpeaking: false,
    });
    sendFrame({ type: 'dm_call_ring', targetPeerId: peerId });
    openWrite(peerId);
  };

  const voteToRemove = async (peerId: string, alias: string) => {
    try {
      await createPodProposal(activePod.podId, {
        kind: 'KICK_MEMBER',
        targetPeerId: peerId,
      });
      setMemberNotice(`A vote to remove ${alias} is open. Find it in Votes.`);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      queryClient.invalidateQueries({ queryKey: ['proposals', activePod.podId] });
    } catch (err) {
      setMemberNotice(err instanceof Error ? err.message : 'Could not open that vote.');
    }
  };

  const namesInCall = connectedPeers.map((p) => p.alias);
  const callTitle =
    namesInCall.length === 0
      ? 'Nobody is in the call'
      : namesInCall.length === 1
      ? `${namesInCall[0]} is in the call`
      : namesInCall.length === 2
      ? `${namesInCall[0]} and ${namesInCall[1]} are in the call`
      : `${namesInCall.length} are in the call`;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Which room's people */}
      <View style={styles.headRow}>
        <View style={styles.flex1}>
          <Text style={styles.roomName} numberOfLines={1}>
            {roomName}
          </Text>
          <Text style={styles.roomMeta}>
            You are {activePod.myAlias} ·{' '}
            {capacityTierBadge(activePod.memberCount, activePod.maxMembers)}
          </Text>
        </View>
        <View
          style={[
            styles.wsDot,
            { backgroundColor: wsConnected ? PIECE_HEX.jade : PIECES.off },
          ]}
          accessibilityLabel={wsConnected ? 'Live' : 'Reconnecting'}
        />
      </View>

      {pods.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsRow}
        >
          {pods.map((p) => (
            <Chip
              key={p.podId}
              label={p.title?.trim() || p.interestLabel}
              active={p.podId === activePod.podId}
              onPress={() => {
                if (
                  voiceSession &&
                  voiceSession.podId === activePod.podId &&
                  p.podId !== activePod.podId
                ) {
                  handleLeaveCall();
                }
                setSelectedPeerId(null);
                setActivePodId(p.podId);
              }}
            />
          ))}
        </ScrollView>
      ) : null}

      {/* The room call: one ink card */}
      <View style={styles.callCard}>
        <Text style={styles.callTitle}>{callTitle}</Text>
        {connectedPeers.length > 0 ? (
          <View style={styles.callPeers}>
            {connectedPeers.map((peer) => {
              const isSelf = peer.peerId === activePod.myPeerId;
              const speaking =
                isSelf && activeSessionInThisPod
                  ? activeSessionInThisPod.speaking
                  : peer.speaking;
              const muted =
                isSelf && activeSessionInThisPod
                  ? activeSessionInThisPod.muted
                  : peer.muted;
              return (
                <View
                  key={peer.peerId}
                  accessible
                  accessibilityLabel={`${peer.alias}${isSelf ? ', you' : ''}, ${
                    speaking ? 'speaking' : muted ? 'muted' : 'listening'
                  }`}
                  style={styles.callPeer}
                >
                  <Piece alias={peer.alias} size={44} speaking={speaking} />
                  <Text style={styles.callPeerState}>
                    {speaking ? 'Speaking' : muted ? 'Muted' : 'Listening'}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : (
          <Text style={styles.callSub}>
            Drop in whenever you like. Others see only your alias.
          </Text>
        )}

        {statusNotice ? <Text style={styles.callSub}>{statusNotice}</Text> : null}

        {!activeSessionInThisPod ? (
          <Btn
            label="Join the call"
            kind="blue"
            big
            wide
            onPress={handleJoinCall}
            a11yLabel={`Join the call in ${roomName}`}
          />
        ) : (
          <View style={styles.controls}>
            <Btn
              label={activeSessionInThisPod.muted ? 'Unmute' : 'Mute'}
              kind="white"
              icon={activeSessionInThisPod.muted ? 'mic-off' : 'mic'}
              onPress={handleToggleMute}
              a11yLabel={
                activeSessionInThisPod.muted ? 'Unmute microphone' : 'Mute microphone'
              }
            />
            <Btn
              label={activeSessionInThisPod.deafened ? 'Hear' : 'Deafen'}
              kind="white"
              icon={activeSessionInThisPod.deafened ? 'volume-mute' : 'volume-high'}
              onPress={handleToggleDeafen}
              a11yLabel={
                activeSessionInThisPod.deafened ? 'Undeafen audio' : 'Deafen audio'
              }
            />
            <Btn
              label={activeSessionInThisPod.speaking ? 'Speaking' : 'Speak'}
              kind={activeSessionInThisPod.speaking ? 'blue' : 'white'}
              icon="pulse"
              onPress={handleToggleSpeakingPulse}
              a11yLabel="Speak, push to talk"
            />
            <Btn label="Leave" kind="off" onPress={handleLeaveCall} a11yLabel="Leave the call" />
          </View>
        )}
        {activeSessionInThisPod && lastSignal ? (
          <Text style={styles.callSub}>Signal from {lastSignal.fromAlias}</Text>
        ) : null}
      </View>

      {/* Everyone in the room: one piece each, free seats as empty rings */}
      <View style={styles.sheetCard}>
        <Text style={styles.h3}>
          {members.length} of {activePod.maxMembers} seats
        </Text>
        <View style={styles.grid}>
          {members.map((m) => {
            const on = m.peerId === selectedPeerId;
            return (
              <Pressable
                key={m.peerId}
                accessibilityRole="button"
                accessibilityLabel={`${m.alias}${m.isSelf ? ', you' : ''}${
                  m.online ? '' : ', away'
                }${m.inVoice ? ', in the call' : ''}`}
                accessibilityState={{ selected: on }}
                onPress={() => {
                  setSelectedPeerId(on ? null : m.peerId);
                  setMemberNotice(null);
                }}
                style={styles.gridCell}
              >
                <Piece alias={m.alias} size={52} away={!m.online} speaking={on} />
              </Pressable>
            );
          })}
          {Array.from({ length: freeSeats }, (_, i) => (
            <View key={`free-${i}`} style={styles.gridCell} accessibilityElementsHidden>
              <View style={styles.freeSeat} />
            </View>
          ))}
        </View>
      </View>

      {selected ? (
        <View style={[styles.memberCard, { backgroundColor: pieceColor(selected.alias) }]}>
          <Text style={styles.memberName}>
            {selected.alias}
            {selected.isSelf ? ' (you)' : ''}
          </Text>
          <Text style={styles.memberSub}>
            {selected.online ? 'Online' : 'Away'}
            {selected.inVoice ? ' · in the call' : ''}
          </Text>
          {selected.customStatus ? (
            <Text style={styles.memberSub}>{selected.customStatus}</Text>
          ) : null}
          {selected.isSelf || selected.peerId === activePod.myPeerId ? (
            <Text style={styles.memberSub}>
              This is you. Change your status from Rooms.
            </Text>
          ) : (
            <View style={styles.controls}>
              <Btn
                label="Write"
                kind="ink"
                onPress={() => openWrite(selected.peerId)}
                a11yLabel={`Write to ${selected.alias} privately`}
              />
              <Btn
                label="Call"
                kind="white"
                icon="call-outline"
                onPress={() => startPrivateCall(selected.peerId, selected.alias, selected.online)}
                a11yLabel={`Call ${selected.alias} privately`}
              />
              <Btn
                label="Vote to remove"
                kind="white"
                onPress={() => voteToRemove(selected.peerId, selected.alias)}
                a11yLabel={`Start a vote to remove ${selected.alias}`}
              />
            </View>
          )}
          {memberNotice ? <Text style={styles.memberSub}>{memberNotice}</Text> : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PIECES.bg },
  content: { padding: 12, gap: 12, paddingBottom: 24 },
  flex1: { flex: 1 },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: PIECES.bg,
  },
  emptyTitle: { fontSize: 24, fontWeight: '600', color: PIECES.ink },
  emptySub: { fontSize: 16, color: PIECES.muted, textAlign: 'center', lineHeight: 23 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6, paddingTop: 4 },
  roomName: { fontSize: 26, color: PIECES.ink, fontWeight: '600' },
  roomMeta: { fontSize: 14, color: PIECES.muted, fontFamily: MONO_FONT },
  wsDot: { width: 10, height: 10, borderRadius: 5 },
  chipsRow: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  callCard: { backgroundColor: PIECES.ink, borderRadius: 28, padding: 18, gap: 14 },
  callTitle: { fontSize: 22, lineHeight: 26, color: PIECES.sheet, fontWeight: '600' },
  callSub: { fontSize: 14, lineHeight: 20, color: '#d0d0d0' },
  callPeers: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  callPeer: { alignItems: 'center', gap: 4, minWidth: 64, paddingVertical: 6 },
  callPeerState: { fontSize: 12, color: '#d0d0d0', fontFamily: MONO_FONT },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sheetCard: { backgroundColor: PIECES.sheet, borderRadius: 28, padding: 16, gap: 12 },
  h3: { fontSize: 18, color: PIECES.ink, fontWeight: '600', paddingHorizontal: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  gridCell: {
    width: 60,
    minHeight: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  freeSeat: {
    width: 52,
    height: 52,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: PIECES.hair,
  },
  memberCard: { borderRadius: 28, padding: 18, gap: 8 },
  memberName: { fontSize: 26, color: PIECES.ink, fontWeight: '600' },
  memberSub: { fontSize: 15, color: PIECES.ink },
});
