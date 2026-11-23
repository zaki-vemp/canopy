import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useAtom, useSetAtom } from 'jotai';
import { Ionicons } from '@expo/vector-icons';
import {
  ApiError,
  clearStoredToken,
  fetchMe,
  fetchPods,
  hydrateClientStorage,
} from './src/api/client';
import { usePodSocket } from './src/api/ws';
import {
  activeDmCallAtom,
  activeDmPeerByPodAtom,
  activePodIdAtom,
  activeTabAtom,
  activeVoiceSessionAtom,
  apiBaseUrlAtom,
  authTokenAtom,
  authUserAtom,
  dmConvoKey,
  peerLastReadByPodPeerAtom,
  unreadDmByPodPeerAtom,
  unreadGroupByPodAtom,
} from './src/state/atoms';
import type { MobileTabKey } from './src/types/canopy';
import {
  PALETTE,
  TOUCH_MIN,
  aliasInitials,
  safePeerColor,
} from './src/theme/palette';
import { AuthScreen } from './src/screens/AuthScreen';
import { PodsHubScreen } from './src/screens/PodsHubScreen';
import { PodChatScreen } from './src/screens/PodChatScreen';
import { VoiceLoungeScreen } from './src/screens/VoiceLoungeScreen';
import { SearchSavedScreen } from './src/screens/SearchSavedScreen';
import { AccountScreen } from './src/screens/AccountScreen';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 8_000,
    },
  },
});

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

const TABS: ReadonlyArray<{
  key: MobileTabKey;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
}> = [
  {
    key: 'pods',
    label: 'Pods',
    icon: 'grid-outline',
    iconActive: 'grid',
  },
  {
    key: 'chat',
    label: 'Chat',
    icon: 'chatbubbles-outline',
    iconActive: 'chatbubbles',
  },
  {
    key: 'voice',
    label: 'Voice',
    icon: 'mic-outline',
    iconActive: 'mic',
  },
  {
    key: 'search',
    label: 'Search',
    icon: 'search-outline',
    iconActive: 'search',
  },
  {
    key: 'account',
    label: 'Account',
    icon: 'person-circle-outline',
    iconActive: 'person-circle',
  },
];

function AuthenticatedWorkspace() {
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);
  const [voiceSession, setVoiceSession] = useAtom(activeVoiceSessionAtom);
  const [activeDmCall, setActiveDmCall] = useAtom(activeDmCallAtom);
  const [unreadGroupMap, setUnreadGroupMap] = useAtom(unreadGroupByPodAtom);
  const [unreadDmMap, setUnreadDmMap] = useAtom(unreadDmByPodPeerAtom);
  const setPeerLastReadMap = useSetAtom(peerLastReadByPodPeerAtom);

  const podsQuery = useQuery({
    queryKey: ['pods'],
    queryFn: fetchPods,
  });

  useEffect(() => {
    const pods = podsQuery.data?.pods ?? [];
    if (pods.length > 0 && !pods.some((p) => p.podId === activePodId)) {
      setActivePodId(pods[0].podId);
    }
  }, [podsQuery.data, activePodId, setActivePodId]);

  // Seed server-backed unreadGroupCount, dm.unreadCount & dm.peerLastReadMessageId
  useEffect(() => {
    const pods = podsQuery.data?.pods ?? [];
    if (pods.length === 0) return;

    setUnreadGroupMap((prev) => {
      const next = { ...prev };
      for (const p of pods) {
        if (typeof p.unreadGroupCount === 'number') {
          next[p.podId] = p.unreadGroupCount;
        }
      }
      return next;
    });

    setUnreadDmMap((prev) => {
      const next = { ...prev };
      for (const p of pods) {
        for (const dm of p.dmConversations ?? []) {
          if (typeof dm.unreadCount === 'number') {
            next[dmConvoKey(p.podId, dm.peerId)] = dm.unreadCount;
          }
        }
      }
      return next;
    });

    setPeerLastReadMap((prev) => {
      const next = { ...prev };
      for (const p of pods) {
        for (const dm of p.dmConversations ?? []) {
          const key = dmConvoKey(p.podId, dm.peerId);
          next[key] = Math.max(next[key] ?? 0, dm.peerLastReadMessageId ?? 0);
        }
      }
      return next;
    });
  }, [
    podsQuery.data,
    setUnreadGroupMap,
    setUnreadDmMap,
    setPeerLastReadMap,
  ]);

  const { sendFrame } = usePodSocket(activePodId);

  const hasUnreadChat =
    Object.values(unreadGroupMap).some((c) => c > 0) ||
    Object.values(unreadDmMap).some((c) => c > 0);

  const handleAcceptIncomingDmCall = async () => {
    if (!activeDmCall || activeDmCall.phase !== 'incoming') return;
    if (voiceSession) {
      sendFrame({ type: 'voice_leave' });
      setVoiceSession(null);
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
      // fallback to listen/synth mode cleanly
    }

    sendFrame({ type: 'dm_call_accept', callerPeerId: activeDmCall.peerId });
    const targetPod = activeDmCall.podId;
    const callerPeerId = activeDmCall.peerId;
    setActiveDmCall({
      ...activeDmCall,
      phase: 'connected',
    });
    setActivePodId(targetPod);
    setActiveDmPeerMap((prev) => ({ ...prev, [targetPod]: callerPeerId }));
    setActiveTab('chat');
  };

  const handleDeclineIncomingDmCall = () => {
    if (!activeDmCall) return;
    sendFrame({ type: 'dm_call_decline', callerPeerId: activeDmCall.peerId });
    setActiveDmCall(null);
  };

  return (
    <SafeAreaView style={styles.workspaceSafe} edges={['top', 'bottom']}>
      <StatusBar style="light" backgroundColor={PALETTE.charcoal} />

      {/* Charcoal Brand Top Bar */}
      <View style={styles.brandBar}>
        <View style={styles.brandLeft}>
          <View style={styles.mintSquare} />
          <Text style={styles.brandWordmark}>Canopy</Text>
          <View style={styles.blindChip}>
            <Text style={styles.blindChipText}>BLIND PODS</Text>
          </View>
        </View>

        <View style={styles.topRightRow}>
          {activeDmCall && activeDmCall.phase !== 'incoming' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Return to private 1:1 call with ${activeDmCall.peerAlias}`}
              onPress={() => {
                setActivePodId(activeDmCall.podId);
                setActiveDmPeerMap((prev) => ({
                  ...prev,
                  [activeDmCall.podId]: activeDmCall.peerId,
                }));
                setActiveTab('chat');
              }}
              style={styles.liveVoiceChip}
            >
              <Ionicons
                name="lock-closed"
                size={12}
                color={PALETTE.charcoal}
              />
              <Text style={styles.liveVoiceChipText} numberOfLines={1}>
                1:1 · {activeDmCall.peerAlias}
              </Text>
            </Pressable>
          ) : voiceSession ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Return to active pod audio call"
              onPress={() => setActiveTab('voice')}
              style={styles.liveVoiceChip}
            >
              <Ionicons
                name="volume-high"
                size={13}
                color={PALETTE.charcoal}
              />
              <Text style={styles.liveVoiceChipText}>In Call</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Active Screen Viewport */}
      <View style={styles.screenArea}>
        {activeTab === 'pods' ? <PodsHubScreen /> : null}
        {activeTab === 'chat' ? <PodChatScreen sendFrame={sendFrame} /> : null}
        {activeTab === 'voice' ? (
          <VoiceLoungeScreen sendFrame={sendFrame} />
        ) : null}
        {activeTab === 'search' ? <SearchSavedScreen /> : null}
        {activeTab === 'account' ? (
          <AccountScreen
            onLeaveVoiceOnLogout={() => {
              if (voiceSession) {
                sendFrame({ type: 'voice_leave' });
              }
              if (activeDmCall) {
                sendFrame({
                  type: 'dm_call_end',
                  peerId: activeDmCall.peerId,
                });
              }
            }}
          />
        ) : null}
      </View>

      {/* 5-Tab Tactile Bottom Navigation Bar */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const selected = activeTab === tab.key;
          const showLiveDot =
            (tab.key === 'voice' && !!voiceSession) ||
            (tab.key === 'chat' && (hasUnreadChat || !!activeDmCall));

          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected }}
              onPress={() => setActiveTab(tab.key)}
              style={styles.tabBtn}
            >
              <View
                style={[
                  styles.tabIconPill,
                  selected && styles.tabIconPillActive,
                ]}
              >
                <Ionicons
                  name={selected ? tab.iconActive : tab.icon}
                  size={20}
                  color={selected ? PALETTE.charcoal : PALETTE.muted}
                />
                {showLiveDot ? <View style={styles.tabLiveDot} /> : null}
              </View>
              <Text
                style={[
                  styles.tabLabel,
                  selected && styles.tabLabelActive,
                ]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Incoming Private 1:1 Member Call Modal (anywhere in active pod) */}
      <Modal
        visible={activeDmCall?.phase === 'incoming'}
        transparent
        animationType="fade"
        onRequestClose={handleDeclineIncomingDmCall}
      >
        <View style={styles.incomingBackdrop}>
          <View style={styles.incomingCard}>
            <View style={styles.incomingBadge}>
              <Ionicons name="lock-closed" size={12} color={PALETTE.forest} />
              <Text style={styles.incomingBadgeText}>
                PRIVATE 1:1 MEMBER CALL
              </Text>
            </View>

            <View
              style={[
                styles.incomingAvatar,
                {
                  backgroundColor: safePeerColor(
                    activeDmCall?.peerColor,
                    activeDmCall?.peerAlias ?? ''
                  ),
                },
              ]}
            >
              <Text style={styles.incomingInitials}>
                {aliasInitials(activeDmCall?.peerAlias ?? 'Peer')}
              </Text>
            </View>

            <Text style={styles.incomingTitle}>
              {activeDmCall?.peerAlias ?? 'Pod Peer'} is calling you
            </Text>
            <Text style={styles.incomingSub}>
              Hidden from all other pod members · Peer-blind 1-on-1 audio
            </Text>

            <View style={styles.incomingBtnRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Decline incoming private call"
                onPress={handleDeclineIncomingDmCall}
                style={styles.declineCallBtn}
              >
                <Ionicons name="close" size={18} color={PALETTE.card} />
                <Text style={styles.declineCallText}>Decline</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Accept incoming private call"
                onPress={handleAcceptIncomingDmCall}
                style={styles.acceptCallBtn}
              >
                <Ionicons name="call" size={18} color={PALETTE.charcoal} />
                <Text style={styles.acceptCallText}>Accept</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function RootBootGate() {
  const [booting, setBooting] = useState(true);
  const [authUser, setAuthUser] = useAtom(authUserAtom);
  const setAuthToken = useSetAtom(authTokenAtom);
  const setApiBaseUrl = useSetAtom(apiBaseUrlAtom);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { token, apiBaseUrl } = await hydrateClientStorage();
      if (!mounted) return;
      setApiBaseUrl(apiBaseUrl);
      if (!token) {
        setBooting(false);
        return;
      }
      setAuthToken(token);
      try {
        const res = await fetchMe();
        if (mounted) {
          setAuthUser(res.user);
        }
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          await clearStoredToken();
          if (mounted) {
            setAuthToken(null);
            setAuthUser(null);
          }
        }
      } finally {
        if (mounted) {
          setBooting(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [setApiBaseUrl, setAuthToken, setAuthUser]);

  if (booting) {
    return (
      <SafeAreaView style={styles.bootCenter}>
        <StatusBar style="dark" />
        <ActivityIndicator size="large" color={PALETTE.forest} />
        <Text style={styles.bootText}>Restoring Canopy session...</Text>
      </SafeAreaView>
    );
  }

  if (!authUser) {
    return (
      <>
        <StatusBar style="dark" />
        <AuthScreen />
      </>
    );
  }

  return <AuthenticatedWorkspace />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <RootBootGate />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  bootCenter: {
    flex: 1,
    backgroundColor: PALETTE.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  bootText: {
    fontSize: 14,
    color: PALETTE.muted,
    fontWeight: '600',
  },
  workspaceSafe: {
    flex: 1,
    backgroundColor: PALETTE.charcoal,
  },
  brandBar: {
    backgroundColor: PALETTE.charcoal,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2e2a',
    gap: 8,
  },
  brandLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  topRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  mintSquare: {
    width: 12,
    height: 12,
    borderRadius: 3,
    backgroundColor: PALETTE.mint,
  },
  brandWordmark: {
    color: PALETTE.card,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  blindChip: {
    backgroundColor: '#292d29',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#3a403a',
  },
  blindChipText: {
    color: PALETTE.mint,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO_FONT,
  },
  liveVoiceChip: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: PALETTE.mint,
    paddingHorizontal: 10,
    borderRadius: 999,
    maxWidth: 160,
  },
  liveVoiceChipText: {
    color: PALETTE.charcoal,
    fontSize: 12,
    fontWeight: '700',
  },
  screenArea: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: PALETTE.card,
    borderTopWidth: 1,
    borderTopColor: PALETTE.border,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  tabBtn: {
    flex: 1,
    minHeight: TOUCH_MIN + 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tabIconPill: {
    width: 46,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  tabIconPillActive: {
    backgroundColor: PALETTE.mint,
  },
  tabLiveDot: {
    position: 'absolute',
    top: 4,
    right: 8,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: PALETTE.forest,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: PALETTE.muted,
  },
  tabLabelActive: {
    color: PALETTE.charcoal,
    fontWeight: '700',
  },
  incomingBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(25, 27, 25, 0.68)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  incomingCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: PALETTE.card,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1.5,
    borderColor: PALETTE.mintBorder,
    alignItems: 'center',
    gap: 10,
  },
  incomingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  incomingBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
    letterSpacing: 0.5,
  },
  incomingAvatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  incomingInitials: {
    fontSize: 20,
    fontWeight: '700',
    color: PALETTE.card,
    fontFamily: MONO_FONT,
  },
  incomingTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PALETTE.charcoal,
    textAlign: 'center',
  },
  incomingSub: {
    fontSize: 13,
    lineHeight: 18,
    color: PALETTE.muted,
    textAlign: 'center',
  },
  incomingBtnRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    marginTop: 6,
  },
  declineCallBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: PALETTE.danger,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  declineCallText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.card,
  },
  acceptCallBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  acceptCallText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
});
