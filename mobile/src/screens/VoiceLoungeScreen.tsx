import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useQuery } from '@tanstack/react-query';
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
  PALETTE,
  TOUCH_MIN,
  aliasInitials,
  capacityTierBadge,
  safePeerColor,
} from '../theme/palette';

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

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
        'Joining Pod Audio Call (reconnecting live WebSocket to server)...'
      );
    } else if (micMode === 'listen-synth') {
      setStatusNotice(
        'Connected in Listen / Synth mode (no hardware mic detected — use Push-to-Talk Pulse to test speaking ring).'
      );
    } else {
      setStatusNotice('Connected to Pod Audio Call with live mic.');
    }
  };

  const handleLeaveCall = () => {
    stopLocalCapture();
    sendFrame({ type: 'voice_leave' });
    setVoiceSession(null);
    setStatusNotice('Left Pod Audio Call.');
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
        <Ionicons name="mic-circle-outline" size={38} color={PALETTE.forest} />
        <Text style={styles.emptyTitle}>No Active Pod Selected</Text>
        <Text style={styles.emptySub}>
          Join a pod first to hop into its shared peer-blind Audio Call.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setActiveTab('pods')}
          style={styles.goPodsBtn}
        >
          <Text style={styles.goPodsText}>Go to Pods Hub</Text>
        </Pressable>
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

  const displayPodTitle = activePod.title?.trim()
    ? activePod.title
    : `#${activePod.code}`;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      {/* Top Pod Audio Call Header */}
      <View style={styles.headerCard}>
        <View style={styles.headerTopRow}>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerLabel}>POD AUDIO CALL</Text>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {displayPodTitle}
            </Text>
            <Text style={styles.headerTier}>
              #{activePod.code} ·{' '}
              {capacityTierBadge(activePod.memberCount, activePod.maxMembers)}
            </Text>
          </View>
          <View style={styles.wsBadge}>
            <View
              style={[
                styles.wsDot,
                { backgroundColor: wsConnected ? PALETTE.mint : PALETTE.amber },
              ]}
            />
            <Text style={styles.wsBadgeText}>
              {wsConnected ? 'WS Live' : 'Reconnecting'}
            </Text>
          </View>
        </View>

        <Text style={styles.headerSub}>
          One shared drop-in audio call for this pod. You appear strictly as{' '}
          <Text style={styles.boldMint}>{activePod.myAlias}</Text> — active
          voices glow with a signal-mint ring.
        </Text>

        {pods.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.podChipsRow}
          >
            {pods.map((p) => {
              const selected = p.podId === activePod.podId;
              return (
                <Pressable
                  key={p.podId}
                  accessibilityRole="button"
                  onPress={() => {
                    if (
                      voiceSession &&
                      voiceSession.podId === activePod.podId &&
                      p.podId !== activePod.podId
                    ) {
                      handleLeaveCall();
                    }
                    setActivePodId(p.podId);
                  }}
                  style={[
                    styles.podSwitchChip,
                    selected && styles.podSwitchChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.podSwitchChipText,
                      selected && styles.podSwitchChipTextActive,
                    ]}
                  >
                    {p.title?.trim() ? p.title : `#${p.code}`}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
      </View>

      {statusNotice ? (
        <View style={styles.noticeCard}>
          <Ionicons name="radio-outline" size={16} color={PALETTE.forest} />
          <Text style={styles.noticeText}>{statusNotice}</Text>
        </View>
      ) : null}

      {/* Single Shared Pod Audio Call Card */}
      <View
        style={[
          styles.callRoomCard,
          !!activeSessionInThisPod && styles.callRoomCardConnected,
        ]}
      >
        <View style={styles.roomHeaderRow}>
          <View style={styles.roomTitleCol}>
            <Text style={styles.roomTitle}>🔊 Pod Audio Call</Text>
            <Text style={styles.roomTopic}>
              Drop-in anonymous group audio for {displayPodTitle}
            </Text>
          </View>
          <View style={styles.peerCountPill}>
            <Text style={styles.peerCountText}>
              {connectedPeers.length} in call
            </Text>
          </View>
        </View>

        {/* Connected Anonymous Peers with #a1ffcb Mint Speaking Rings */}
        {connectedPeers.length === 0 ? (
          <View style={styles.quietBox}>
            <Text style={styles.quietText}>
              Call is quiet right now — tap Join Audio Call below to hop in.
            </Text>
          </View>
        ) : (
          <View style={styles.peersGrid}>
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
              const deafened =
                isSelf && activeSessionInThisPod
                  ? activeSessionInThisPod.deafened
                  : peer.deafened;
              const avatarBg = safePeerColor(peer.color, peer.alias);

              return (
                <View
                  key={peer.peerId}
                  style={[
                    styles.peerTile,
                    speaking && styles.peerTileSpeaking,
                  ]}
                >
                  <View
                    style={[
                      styles.speakingRing,
                      speaking && styles.speakingRingActive,
                    ]}
                  >
                    <View
                      style={[
                        styles.peerAvatar,
                        { backgroundColor: avatarBg },
                      ]}
                    >
                      <Text style={styles.peerInitials}>
                        {aliasInitials(peer.alias)}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.peerAliasText} numberOfLines={1}>
                    {peer.alias}
                    {isSelf ? ' (You)' : ''}
                  </Text>

                  <View style={styles.peerStateRow}>
                    {speaking ? (
                      <Text style={styles.speakingTag}>SPEAKING</Text>
                    ) : deafened ? (
                      <Text style={styles.mutedTag}>DEAFENED</Text>
                    ) : muted ? (
                      <Text style={styles.mutedTag}>MUTED</Text>
                    ) : (
                      <Text style={styles.listeningTag}>LISTENING</Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {!activeSessionInThisPod ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Join Pod Audio Call for ${displayPodTitle}`}
            onPress={handleJoinCall}
            style={styles.joinCallBtn}
          >
            <Ionicons
              name="call-outline"
              size={18}
              color={PALETTE.charcoal}
            />
            <Text style={styles.joinCallBtnText}>Join Audio Call</Text>
          </Pressable>
        ) : (
          <View style={styles.connectedTagBar}>
            <Ionicons
              name="checkmark-circle"
              size={16}
              color={PALETTE.forest}
            />
            <Text style={styles.connectedTagText}>
              In Audio Call ·{' '}
              {activeSessionInThisPod.micMode === 'live'
                ? 'Live Mic'
                : 'Synth / Listen Mode'}
            </Text>
          </View>
        )}
      </View>

      {/* Tactile Mobile Call Controls Deck */}
      {activeSessionInThisPod ? (
        <View style={styles.callDeck}>
          <View style={styles.callDeckHeader}>
            <Text style={styles.callDeckTitle}>
              Active Call · {displayPodTitle}
            </Text>
            {lastSignal ? (
              <Text style={styles.signalMeta}>
                Signal: {lastSignal.fromAlias}
              </Text>
            ) : null}
          </View>

          <View style={styles.callControlsRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                activeSessionInThisPod.muted
                  ? 'Unmute microphone'
                  : 'Mute microphone'
              }
              onPress={handleToggleMute}
              style={[
                styles.callControlBtn,
                activeSessionInThisPod.muted && styles.callControlBtnActiveWarn,
              ]}
            >
              <Ionicons
                name={activeSessionInThisPod.muted ? 'mic-off' : 'mic'}
                size={20}
                color={
                  activeSessionInThisPod.muted ? PALETTE.amber : PALETTE.card
                }
              />
              <Text
                style={[
                  styles.callControlLabel,
                  activeSessionInThisPod.muted &&
                    styles.callControlLabelActiveWarn,
                ]}
              >
                {activeSessionInThisPod.muted ? 'Unmute' : 'Mute'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                activeSessionInThisPod.deafened
                  ? 'Undeafen audio'
                  : 'Deafen audio'
              }
              onPress={handleToggleDeafen}
              style={[
                styles.callControlBtn,
                activeSessionInThisPod.deafened &&
                  styles.callControlBtnActiveWarn,
              ]}
            >
              <Ionicons
                name={
                  activeSessionInThisPod.deafened
                    ? 'volume-mute'
                    : 'volume-high'
                }
                size={20}
                color={
                  activeSessionInThisPod.deafened ? PALETTE.amber : PALETTE.card
                }
              />
              <Text
                style={[
                  styles.callControlLabel,
                  activeSessionInThisPod.deafened &&
                    styles.callControlLabelActiveWarn,
                ]}
              >
                {activeSessionInThisPod.deafened ? 'Undeafen' : 'Deafen'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.callControlsRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Toggle Speaking or Push-to-Talk Pulse"
              onPress={handleToggleSpeakingPulse}
              style={[
                styles.pttBtn,
                activeSessionInThisPod.speaking && styles.pttBtnSpeaking,
              ]}
            >
              <Ionicons
                name="pulse"
                size={20}
                color={
                  activeSessionInThisPod.speaking
                    ? PALETTE.charcoal
                    : PALETTE.mint
                }
              />
              <Text
                style={[
                  styles.pttBtnText,
                  activeSessionInThisPod.speaking && styles.pttBtnTextSpeaking,
                ]}
              >
                {activeSessionInThisPod.speaking
                  ? 'Speaking Live (Tap to Rest)'
                  : 'Push-to-Talk Pulse'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Leave Call"
              onPress={handleLeaveCall}
              style={styles.leaveCallBtn}
            >
              <Ionicons name="call" size={18} color={PALETTE.card} />
              <Text style={styles.leaveCallText}>Leave Call</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  content: {
    padding: 14,
    gap: 14,
    paddingBottom: 32,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
    backgroundColor: PALETTE.surface,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  emptySub: {
    fontSize: 14,
    color: PALETTE.muted,
    textAlign: 'center',
    lineHeight: 20,
  },
  goPodsBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goPodsText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  headerCard: {
    backgroundColor: PALETTE.charcoal,
    borderRadius: 18,
    padding: 16,
    gap: 8,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  headerTitleWrap: {
    flex: 1,
    gap: 2,
  },
  headerLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.mint,
    letterSpacing: 0.7,
    fontFamily: MONO_FONT,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: PALETTE.card,
  },
  headerTier: {
    fontSize: 12,
    color: '#b7beb7',
    fontFamily: MONO_FONT,
  },
  wsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#292d29',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  wsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  wsBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.card,
    fontFamily: MONO_FONT,
  },
  headerSub: {
    fontSize: 13,
    lineHeight: 19,
    color: '#d0d5d0',
  },
  boldMint: {
    color: PALETTE.mint,
    fontWeight: '700',
  },
  podChipsRow: {
    gap: 8,
    paddingTop: 4,
  },
  podSwitchChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: '#282b28',
    alignItems: 'center',
    justifyContent: 'center',
  },
  podSwitchChipActive: {
    backgroundColor: PALETTE.mint,
  },
  podSwitchChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#d4d8d4',
    fontFamily: MONO_FONT,
  },
  podSwitchChipTextActive: {
    color: PALETTE.charcoal,
  },
  noticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    borderRadius: 12,
    padding: 12,
  },
  noticeText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: PALETTE.forest,
    fontWeight: '600',
  },
  callRoomCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 12,
  },
  callRoomCardConnected: {
    borderColor: PALETTE.forest,
    borderWidth: 1.5,
  },
  roomHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  roomTitleCol: {
    flex: 1,
    gap: 2,
  },
  roomTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  roomTopic: {
    fontSize: 12,
    color: PALETTE.muted,
  },
  peerCountPill: {
    backgroundColor: PALETTE.surfaceMuted,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  peerCountText: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  quietBox: {
    backgroundColor: PALETTE.surface,
    borderRadius: 12,
    padding: 12,
  },
  quietText: {
    fontSize: 13,
    color: PALETTE.muted,
  },
  peersGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  peerTile: {
    width: '47%',
    backgroundColor: PALETTE.surface,
    borderRadius: 14,
    padding: 12,
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  peerTileSpeaking: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.forest,
  },
  speakingRing: {
    padding: 4,
    borderRadius: 999,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  speakingRingActive: {
    borderColor: PALETTE.mint,
    backgroundColor: PALETTE.charcoal,
  },
  peerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  peerInitials: {
    color: PALETTE.card,
    fontWeight: '700',
    fontSize: 15,
    fontFamily: MONO_FONT,
  },
  peerAliasText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  peerStateRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  speakingTag: {
    fontSize: 10,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  mutedTag: {
    fontSize: 10,
    fontWeight: '700',
    color: PALETTE.amber,
    fontFamily: MONO_FONT,
  },
  listeningTag: {
    fontSize: 10,
    fontWeight: '600',
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
  joinCallBtn: {
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  joinCallBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  connectedTagBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    backgroundColor: PALETTE.mintSoft,
    borderRadius: 10,
  },
  connectedTagText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  callDeck: {
    backgroundColor: PALETTE.charcoal,
    borderRadius: 18,
    padding: 16,
    gap: 10,
  },
  callDeckHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  callDeckTitle: {
    color: PALETTE.mint,
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  signalMeta: {
    color: '#b8bfb8',
    fontSize: 11,
    fontFamily: MONO_FONT,
  },
  callControlsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  callControlBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#2b2f2b',
    borderWidth: 1,
    borderColor: '#3d433d',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  callControlBtnActiveWarn: {
    backgroundColor: PALETTE.amberSoft,
    borderColor: PALETTE.amber,
  },
  callControlLabel: {
    color: PALETTE.card,
    fontSize: 13,
    fontWeight: '700',
  },
  callControlLabelActiveWarn: {
    color: PALETTE.amber,
  },
  pttBtn: {
    flex: 1.3,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#25352b',
    borderWidth: 1.5,
    borderColor: PALETTE.mint,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  pttBtnSpeaking: {
    backgroundColor: PALETTE.mint,
  },
  pttBtnText: {
    color: PALETTE.mint,
    fontSize: 13,
    fontWeight: '700',
  },
  pttBtnTextSpeaking: {
    color: PALETTE.charcoal,
  },
  leaveCallBtn: {
    flex: 0.9,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: PALETTE.danger,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  leaveCallText: {
    color: PALETTE.card,
    fontSize: 13,
    fontWeight: '700',
  },
});
