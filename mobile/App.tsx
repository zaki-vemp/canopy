import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
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
  activePodIdAtom,
  activeTabAtom,
  activeVoiceSessionAtom,
  apiBaseUrlAtom,
  authTokenAtom,
  authUserAtom,
  unreadDmByPodPeerAtom,
} from './src/state/atoms';
import type { MobileTabKey } from './src/types/canopy';
import { PALETTE, TOUCH_MIN } from './src/theme/palette';
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
  const voiceSession = useAtomValue(activeVoiceSessionAtom);
  const unreadDmMap = useAtomValue(unreadDmByPodPeerAtom);
  const hasUnreadDm = Object.values(unreadDmMap).some((c) => c > 0);

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

  const { sendFrame } = usePodSocket(activePodId);

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

        {voiceSession ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Return to active pod audio call"
            onPress={() => setActiveTab('voice')}
            style={styles.liveVoiceChip}
          >
            <Ionicons name="volume-high" size={13} color={PALETTE.charcoal} />
            <Text style={styles.liveVoiceChipText}>In Call</Text>
          </Pressable>
        ) : null}
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
            (tab.key === 'chat' && hasUnreadDm);

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
  },
  brandLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: PALETTE.mint,
    paddingHorizontal: 10,
    borderRadius: 999,
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
});
