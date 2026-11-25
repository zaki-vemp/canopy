import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from './src/theme/ui';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
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
import { GUTTER, PIECES, TOUCH_MIN } from './src/theme/palette';
import { FONT_MAP } from './src/theme/fonts';
import { Badge, Logo, Piece } from './src/components/Pieces';
import { CallBar } from './src/components/CallBar';
import { useCalls } from './src/voice/useCalls';
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

// Within a room on a phone, Chat and People are the two room tabs.
const ROOM_TABS: ReadonlyArray<{ key: 'chat' | 'voice'; label: string }> = [
  { key: 'chat', label: 'Chat' },
  { key: 'voice', label: 'People' },
];

// A phone with the keyboard up has no room to spare for tabs.
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setOpen(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setOpen(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return open;
}

function AuthenticatedWorkspace() {
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);
  const voiceSession = useAtomValue(activeVoiceSessionAtom);
  const activeDmCall = useAtomValue(activeDmCallAtom);
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
  const calls = useCalls(sendFrame);

  const handleAcceptIncomingDmCall = () => {
    if (!activeDmCall) return;
    setActiveDmPeerMap((prev) => ({ ...prev, [activeDmCall.podId]: activeDmCall.peerId }));
    setActiveTab('chat');
    calls.answerPrivateCall();
  };

  const { width, height } = useWindowDimensions();
  // Tablets, iPads and phones turned sideways get three panes at once.
  const wide = width >= WIDE_MIN;
  const short = height < 520;
  const keyboardOpen = useKeyboardOpen();
  const sideWidth = Math.max(260, Math.min(360, Math.round(width * 0.28)));
  const podsList = podsQuery.data?.pods ?? [];
  const activePod = podsList.find((p) => p.podId === activePodId) ?? podsList[0] ?? null;
  const inRoom = (activeTab === 'chat' || activeTab === 'voice') && podsList.length > 0;
  // Inside a room on a phone, the room's own bar replaces the wordmark.
  const showBrandBar = wide || !inRoom;

  const unreadForPod = (p: (typeof podsList)[number]) => {
    if (p.myMuted) return 0;
    const g = unreadGroupMap[p.podId] ?? p.unreadGroupCount ?? 0;
    const d = (p.dmConversations ?? []).reduce(
      (sum, dm) => sum + (unreadDmMap[dmConvoKey(p.podId, dm.peerId)] ?? dm.unreadCount ?? 0),
      0
    );
    return g + d;
  };
  const activeRoomUnread = activePod ? unreadForPod(activePod) : 0;
  const otherRoomsUnread = podsList.reduce(
    (sum, p) => (p.podId === activePod?.podId ? sum : sum + unreadForPod(p)),
    0
  );

  const accountScreen = <AccountScreen onLeaveVoiceOnLogout={calls.hangUp} />;

  return (
    <SafeAreaView style={styles.topSafe} edges={['top', 'left', 'right']}>
    <SafeAreaView style={styles.workspaceSafe} edges={['bottom']}>
      <StatusBar style="dark" backgroundColor={PIECES.sheet} />

      {/* White sheet top bar: the six-piece wordmark, Saved and Account */}
      {showBrandBar ? (
      <View style={[styles.brandBar, short && styles.brandBarShort]}>
        <View style={styles.brandLeftRow}>
          {!wide && (activeTab === 'search' || activeTab === 'account') ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to Rooms"
              onPress={() => setActiveTab('pods')}
              style={styles.roundBtn}
            >
              <Ionicons name="chevron-back" size={22} color={PIECES.ink} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Canopy, your rooms"
            onPress={() => setActiveTab('pods')}
          >
            <Logo size={26} />
          </Pressable>
        </View>

        <View style={styles.topRightRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search and saved"
            accessibilityState={{ selected: activeTab === 'search' }}
            onPress={() => setActiveTab(activeTab === 'search' ? 'pods' : 'search')}
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
      ) : null}

      {/* On a phone, Chat and People place the call under their own room bar. */}
      {wide || !inRoom ? <CallBar calls={calls} /> : null}

      {/* Active screen sits on the grey table */}
      {wide ? (
        <View style={styles.panes}>
          <View style={[styles.paneRooms, { width: sideWidth }]}>
            <PodsHubScreen />
          </View>
          <View style={[styles.paneChat, short && styles.paneChatShort]}>
            {activeTab === 'search' ? (
              <SearchSavedScreen />
            ) : activeTab === 'account' ? (
              accountScreen
            ) : (
              <PodChatScreen sendFrame={sendFrame} calls={calls} phone={false} />
            )}
          </View>
          <View style={[styles.panePeople, { width: sideWidth }]}>
            <VoiceLoungeScreen calls={calls} phone={false} />
          </View>
        </View>
      ) : (
      <View style={styles.column}>
      <View style={styles.screenArea}>
        {activeTab === 'pods' ? <PodsHubScreen /> : null}
        {activeTab === 'chat' ? (
          <PodChatScreen
            sendFrame={sendFrame}
            calls={calls}
            phone
            otherRoomsUnread={otherRoomsUnread}
          />
        ) : null}
        {activeTab === 'voice' ? (
          <VoiceLoungeScreen
            calls={calls}
            phone
            otherRoomsUnread={otherRoomsUnread}
          />
        ) : null}
        {activeTab === 'search' ? <SearchSavedScreen /> : null}
        {activeTab === 'account' ? accountScreen : null}
      </View>

      {/* Within a room: two pills — Chat and People */}
      {inRoom && !keyboardOpen ? (
      <View style={styles.tabBar}>
        {ROOM_TABS.map((tab) => {
          const selected = activeTab === tab.key;
          const unread = tab.key === 'chat' && !selected ? activeRoomUnread : 0;
          const inCall =
            tab.key === 'voice' &&
            Boolean(voiceSession && activePod && voiceSession.podId === activePod.podId);
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={`${tab.label}${unread > 0 ? `, ${unread} unread` : ''}${
                inCall ? ', in the call' : ''
              }`}
              accessibilityState={{ selected }}
              onPress={() => setActiveTab(tab.key)}
              style={[styles.tabBtn, selected && styles.tabBtnActive]}
            >
              <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>
                {tab.label}
              </Text>
              {unread > 0 ? <Badge n={unread} onBlue={selected} /> : null}
              {inCall ? (
                <View style={[styles.tabLiveDot, selected && { backgroundColor: PIECES.sheet }]} />
              ) : null}
            </Pressable>
          );
        })}
      </View>
      ) : null}
      </View>
      )}

      {/* Incoming private call: a coral piece card on the grey table */}
      <Modal
        visible={activeDmCall?.phase === 'incoming'}
        transparent
        animationType="fade"
        onRequestClose={calls.declinePrivateCall}
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
                onPress={calls.declinePrivateCall}
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
  // The strip behind the clock matches the white bar under it.
  topSafe: { flex: 1, backgroundColor: PIECES.sheet },
  workspaceSafe: {
    flex: 1,
    backgroundColor: PIECES.bg,
  },
  brandBar: {
    backgroundColor: PIECES.sheet,
    paddingHorizontal: GUTTER,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: PIECES.hair,
  },
  brandBarShort: { paddingVertical: 2 },
  brandLeftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
  screenArea: {
    flex: 1,
    backgroundColor: PIECES.bg,
  },
  column: { flex: 1, width: '100%', maxWidth: 680, alignSelf: 'center' },
  // Each pane's own GUTTER lines its cards up with the bar above.
  panes: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: PIECES.bg,
  },
  paneRooms: { overflow: 'hidden' },
  paneChat: {
    flex: 1,
    minWidth: 0,
    marginTop: GUTTER,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
  },
  paneChatShort: { marginTop: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  panePeople: { overflow: 'hidden' },
  tabBar: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: PIECES.bg,
    paddingTop: 2,
    paddingBottom: 6,
    paddingHorizontal: GUTTER,
  },
  tabBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: TOUCH_MIN / 2,
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
