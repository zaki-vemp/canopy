import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from './src/theme/ui';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useAtom, useSetAtom } from 'jotai';
import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
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
import { PIECES, TOUCH_MIN } from './src/theme/palette';
import { FONT_MAP } from './src/theme/fonts';
import { Logo, Piece } from './src/components/Pieces';
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

const MONO_FONT = 'DMMono_500Medium';

const WIDE_MIN = 900;

const TABS: ReadonlyArray<{ key: MobileTabKey; label: string }> = [
  { key: 'pods', label: 'Rooms' },
  { key: 'chat', label: 'Chat' },
  { key: 'voice', label: 'People' },
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

  const { width } = useWindowDimensions();
  // Tablets, iPads and phones turned sideways get three panes at once.
  const wide = width >= WIDE_MIN;
  const sideWidth = Math.max(260, Math.min(360, Math.round(width * 0.28)));
  const podsList = podsQuery.data?.pods ?? [];
  const activePodForPeople =
    podsList.find((p) => p.podId === activePodId) ?? podsList[0] ?? null;
  const unreadRooms =
    Object.values(unreadGroupMap).reduce((a, b) => a + b, 0) +
    Object.values(unreadDmMap).reduce((a, b) => a + b, 0);

  const accountScreen = (
    <AccountScreen
      onLeaveVoiceOnLogout={() => {
        if (voiceSession) {
          sendFrame({ type: 'voice_leave' });
        }
        if (activeDmCall) {
          sendFrame({ type: 'dm_call_end', peerId: activeDmCall.peerId });
        }
      }}
    />
  );

  return (
    <SafeAreaView style={styles.workspaceSafe} edges={['top', 'bottom']}>
      <StatusBar style="dark" backgroundColor={PIECES.sheet} />

      {/* White sheet top bar: the six-piece wordmark, a live-call chip, Saved and Account */}
      <View style={styles.brandBar}>
        <Logo size={26} />

        <View style={styles.topRightRow}>
          {activeDmCall && activeDmCall.phase !== 'incoming' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Return to private call with ${activeDmCall.peerAlias}`}
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
              <Ionicons name="lock-closed" size={12} color={PIECES.sheet} />
              <Text style={styles.liveVoiceChipText} numberOfLines={1}>
                {activeDmCall.peerAlias}
              </Text>
            </Pressable>
          ) : voiceSession ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Return to the room call"
              onPress={() => setActiveTab('voice')}
              style={styles.liveVoiceChip}
            >
              <Ionicons name="volume-high" size={13} color={PIECES.sheet} />
              <Text style={styles.liveVoiceChipText}>In the call</Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search and saved"
            accessibilityState={{ selected: activeTab === 'search' }}
            onPress={() => setActiveTab(activeTab === 'search' ? 'chat' : 'search')}
            style={[styles.roundBtn, activeTab === 'search' && styles.roundBtnOn]}
          >
            <Ionicons
              name="search"
              size={20}
              color={activeTab === 'search' ? PIECES.sheet : PIECES.ink}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Account"
            accessibilityState={{ selected: activeTab === 'account' }}
            onPress={() => setActiveTab(activeTab === 'account' ? 'pods' : 'account')}
            style={[styles.roundBtn, activeTab === 'account' && styles.roundBtnOn]}
          >
            <Ionicons
              name="person"
              size={20}
              color={activeTab === 'account' ? PIECES.sheet : PIECES.ink}
            />
          </Pressable>
        </View>
      </View>

      {/* Active screen sits on the grey table */}
      {wide ? (
        <View style={styles.panes}>
          <View style={[styles.paneRooms, { width: sideWidth }]}>
            <PodsHubScreen />
          </View>
          <View style={styles.paneChat}>
            {activeTab === 'search' ? (
              <SearchSavedScreen />
            ) : activeTab === 'account' ? (
              accountScreen
            ) : (
              <PodChatScreen sendFrame={sendFrame} />
            )}
          </View>
          <View style={[styles.panePeople, { width: sideWidth }]}>
            <VoiceLoungeScreen sendFrame={sendFrame} />
          </View>
        </View>
      ) : (
      <View style={styles.column}>
      <View style={styles.screenArea}>
        {activeTab === 'pods' ? <PodsHubScreen /> : null}
        {activeTab === 'chat' ? <PodChatScreen sendFrame={sendFrame} /> : null}
        {activeTab === 'voice' ? (
          <VoiceLoungeScreen sendFrame={sendFrame} />
        ) : null}
        {activeTab === 'search' ? <SearchSavedScreen /> : null}
        {activeTab === 'account' ? accountScreen : null}
      </View>

      {/* Three pills: Rooms, Chat, People */}
      {wide ? null : (
      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const selected = activeTab === tab.key;
          const count =
            tab.key === 'pods'
              ? podsList.length
              : tab.key === 'voice'
              ? activePodForPeople?.memberCount ?? 0
              : 0;
          const showDot =
            (tab.key === 'voice' && !!voiceSession) ||
            (tab.key === 'chat' && (hasUnreadChat || !!activeDmCall));
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={
                count > 0 ? `${tab.label}, ${count}` : tab.label
              }
              accessibilityState={{ selected }}
              onPress={() => setActiveTab(tab.key)}
              style={[styles.tabBtn, selected && styles.tabBtnActive]}
            >
              <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>
                {tab.label}
              </Text>
              {count > 0 ? (
                <View style={[styles.tabBadge, selected && styles.tabBadgeOn]}>
                  <Text
                    style={[styles.tabBadgeText, selected && styles.tabBadgeTextOn]}
                  >
                    {tab.key === 'chat' ? unreadRooms : count}
                  </Text>
                </View>
              ) : null}
              {tab.key === 'chat' && showDot && unreadRooms === 0 ? (
                <View style={[styles.tabLiveDot, selected && { backgroundColor: PIECES.sheet }]} />
              ) : null}
              {tab.key === 'voice' && showDot ? (
                <View style={[styles.tabLiveDot, selected && { backgroundColor: PIECES.sheet }]} />
              ) : null}
            </Pressable>
          );
        })}
      </View>
      )}
      </View>
      )}

      {/* Incoming private call: a coral piece card on the grey table */}
      <Modal
        visible={activeDmCall?.phase === 'incoming'}
        transparent
        animationType="fade"
        onRequestClose={handleDeclineIncomingDmCall}
      >
        <View style={styles.incomingBackdrop}>
          <View style={styles.incomingCard}>
            <Text style={styles.incomingBadgeText}>Private call</Text>
            <Piece alias={activeDmCall?.peerAlias ?? 'Slate Owl'} size={72} />
            <Text style={styles.incomingTitle}>
              {activeDmCall?.peerAlias ?? 'Someone in the room'} is calling
            </Text>
            <Text style={styles.incomingSub}>
              Only the two of you hear this. Nobody else in the room sees it.
            </Text>

            <View style={styles.incomingBtnRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Decline the private call"
                onPress={handleDeclineIncomingDmCall}
                style={styles.declineCallBtn}
              >
                <Ionicons name="close" size={18} color={PIECES.ink} />
                <Text style={styles.declineCallText}>Decline</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Accept the private call"
                onPress={handleAcceptIncomingDmCall}
                style={styles.acceptCallBtn}
              >
                <Ionicons name="call" size={18} color={PIECES.sheet} />
                <Text style={styles.acceptCallText}>Answer</Text>
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
        <Logo size={30} />
        <ActivityIndicator size="small" color={PIECES.ink} />
        <Text style={styles.bootText}>Finding your rooms...</Text>
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
  const [fontsLoaded] = useFonts(FONT_MAP);
  if (!fontsLoaded) return null;
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
    backgroundColor: PIECES.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  bootText: {
    fontSize: 15,
    color: PIECES.muted,
  },
  workspaceSafe: {
    flex: 1,
    backgroundColor: PIECES.bg,
  },
  brandBar: {
    backgroundColor: PIECES.sheet,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: PIECES.hair,
  },
  topRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  roundBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: TOUCH_MIN / 2,
    backgroundColor: PIECES.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundBtnOn: {
    backgroundColor: PIECES.ink,
  },
  liveVoiceChip: {
    minHeight: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: PIECES.blue,
    paddingHorizontal: 16,
    borderRadius: 22,
    maxWidth: 160,
  },
  liveVoiceChipText: {
    color: PIECES.sheet,
    fontSize: 14,
    fontWeight: '600',
  },
  screenArea: {
    flex: 1,
    backgroundColor: PIECES.bg,
  },
  column: { flex: 1, width: '100%', maxWidth: 680, alignSelf: 'center' },
  panes: {
    flex: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    backgroundColor: PIECES.bg,
  },
  paneRooms: { borderRadius: 28, overflow: 'hidden' },
  paneChat: { flex: 1, minWidth: 0, borderRadius: 28, overflow: 'hidden' },
  panePeople: { borderRadius: 28, overflow: 'hidden' },
  tabBar: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: PIECES.bg,
    paddingTop: 6,
    paddingBottom: 8,
    paddingHorizontal: 12,
  },
  tabBtn: {
    flex: 1,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 26,
    backgroundColor: PIECES.sheet,
  },
  tabBtnActive: {
    backgroundColor: PIECES.blue,
  },
  tabLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: PIECES.ink,
  },
  tabLabelActive: {
    color: PIECES.sheet,
  },
  tabBadge: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: 6,
    borderRadius: 12,
    backgroundColor: PIECES.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBadgeOn: {
    backgroundColor: PIECES.sheet,
  },
  tabBadgeText: {
    fontSize: 13,
    fontWeight: '700',
    color: PIECES.sheet,
  },
  tabBadgeTextOn: {
    color: PIECES.blue,
  },
  tabLiveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: PIECES.blue,
  },
  incomingBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(17, 17, 17, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  incomingCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: PIECES.sheet,
    borderRadius: 28,
    padding: 24,
    alignItems: 'center',
    gap: 12,
  },
  incomingBadgeText: {
    fontSize: 13,
    color: PIECES.muted,
    fontFamily: MONO_FONT,
  },
  incomingTitle: {
    fontSize: 22,
    color: PIECES.ink,
    textAlign: 'center',
  },
  incomingSub: {
    fontSize: 15,
    lineHeight: 21,
    color: PIECES.muted,
    textAlign: 'center',
  },
  incomingBtnRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    marginTop: 8,
  },
  declineCallBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: PIECES.bg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  declineCallText: {
    fontSize: 16,
    fontWeight: '600',
    color: PIECES.ink,
  },
  acceptCallBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: PIECES.blue,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  acceptCallText: {
    fontSize: 16,
    fontWeight: '600',
    color: PIECES.sheet,
  },
});
