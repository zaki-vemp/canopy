import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  ApiError,
  createPodProposal,
  deleteMessage,
  fetchDmMessages,
  fetchPodDms,
  fetchPodMessages,
  fetchPods,
  leavePod,
  postDmMessage,
  postPodMessage,
  toggleBookmark,
  togglePin,
  toggleReaction,
  uploadVoiceNoteAttachment,
  votePoll,
  voteProposal,
} from '../api/client';
import type {
  DmSummaryDto,
  PodDetailDto,
  RichMessageDto,
  WsOutboundFrame,
} from '../types/canopy';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  activeTabAtom,
  dmConvoKey,
  typingByConvoAtom,
  unreadDmByPodPeerAtom,
  wsConnectedAtom,
} from '../state/atoms';
import {
  PALETTE,
  TOUCH_MIN,
  aliasInitials,
  capacityTierBadge,
  safePeerColor,
} from '../theme/palette';
import { MessageCard } from '../components/MessageCard';
import { InviteShareModal } from '../components/InviteShareModal';
import { PodGovernanceModal } from '../components/PodGovernanceModal';

const QUICK_EMOJIS = ['🔥', '👍', '😂', '🎯', '❤️'];

const GROUP_SLASH_CHIPS: ReadonlyArray<{ cmd: string; label: string }> = [
  { cmd: '/invite', label: '/invite' },
  { cmd: '/poll', label: '/poll' },
  { cmd: '/icebreaker', label: '/icebreaker' },
  { cmd: '/shrug', label: '/shrug' },
  { cmd: '/rematch', label: '/rematch' },
];

const DM_SLASH_CHIPS: ReadonlyArray<{ cmd: string; label: string }> = [
  { cmd: '/shrug', label: '/shrug' },
  { cmd: '/status', label: '/status' },
  { cmd: '/invite', label: '/invite' },
];

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

interface PeerChatItem {
  peerId: string;
  alias: string;
  color: string;
  online: boolean;
  inVoice: boolean;
  customStatus: string;
  dm: DmSummaryDto | null;
}

export function PodChatScreen({
  sendFrame,
}: {
  sendFrame: (frame: WsOutboundFrame) => boolean;
}) {
  const queryClient = useQueryClient();
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const [activeDmPeerMap, setActiveDmPeerMap] = useAtom(activeDmPeerByPodAtom);
  const [unreadDmMap, setUnreadDmMap] = useAtom(unreadDmByPodPeerAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const typingByConvo = useAtomValue(typingByConvoAtom);
  const wsConnected = useAtomValue(wsConnectedAtom);

  const [podSwitcherOpen, setPodSwitcherOpen] = useState(false);
  const [dmDirectoryOpen, setDmDirectoryOpen] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [governanceModalOpen, setGovernanceModalOpen] = useState(false);

  const [actionTarget, setActionTarget] = useState<RichMessageDto | null>(null);
  const [quoteTarget, setQuoteTarget] = useState<RichMessageDto | null>(null);
  const [draft, setDraft] = useState('');
  const [composerNotice, setComposerNotice] = useState<string | null>(null);

  // Voice Note recording state
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordElapsedSec, setRecordElapsedSec] = useState(0);
  const [uploadingVoice, setUploadingVoice] = useState(false);

  // Typing debounce ref
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const podId = activePod?.podId ?? '';
  const activePeerId: string | null = podId
    ? activeDmPeerMap[podId] ?? null
    : null;

  const dmsQuery = useQuery({
    queryKey: ['dms', podId],
    queryFn: () => fetchPodDms(podId),
    enabled: !!podId,
  });

  const dmConversations: DmSummaryDto[] = useMemo(
    () =>
      dmsQuery.data?.conversations ?? activePod?.dmConversations ?? [],
    [dmsQuery.data, activePod?.dmConversations]
  );

  // Ordered 1:1 peers: recent DM conversations first, then online peers, then offline peers
  const orderedPeers: PeerChatItem[] = useMemo(() => {
    if (!activePod) return [];
    const dmMap = new Map<string, DmSummaryDto>();
    for (const dm of dmConversations) {
      if (dm.peerId !== activePod.myPeerId) {
        dmMap.set(dm.peerId, dm);
      }
    }

    const memberMap = new Map(
      activePod.members
        .filter((m) => m.peerId !== activePod.myPeerId)
        .map((m) => [m.peerId, m])
    );

    const result: PeerChatItem[] = [];
    const seen = new Set<string>();

    for (const dm of dmConversations) {
      if (dm.peerId === activePod.myPeerId || seen.has(dm.peerId)) continue;
      const m = memberMap.get(dm.peerId);
      seen.add(dm.peerId);
      result.push({
        peerId: dm.peerId,
        alias: m?.alias ?? dm.peerAlias,
        color: m?.color ?? dm.peerColor,
        online: m?.online ?? dm.online,
        inVoice: m?.inVoice ?? false,
        customStatus: m?.customStatus ?? '',
        dm,
      });
    }

    const remainingMembers = Array.from(memberMap.values())
      .filter((m) => !seen.has(m.peerId))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.alias.localeCompare(b.alias);
      });

    for (const m of remainingMembers) {
      result.push({
        peerId: m.peerId,
        alias: m.alias,
        color: m.color,
        online: m.online,
        inVoice: m.inVoice,
        customStatus: m.customStatus,
        dm: dmMap.get(m.peerId) ?? null,
      });
    }

    return result;
  }, [activePod, dmConversations]);

  const activePeerInfo = useMemo(() => {
    if (!activePeerId) return null;
    return orderedPeers.find((p) => p.peerId === activePeerId) ?? null;
  }, [activePeerId, orderedPeers]);

  // Clear unread badge when viewing a 1:1 DM
  useEffect(() => {
    if (!podId || !activePeerId) return;
    const key = dmConvoKey(podId, activePeerId);
    if ((unreadDmMap[key] ?? 0) > 0) {
      setUnreadDmMap((prev) => ({ ...prev, [key]: 0 }));
    }
  }, [podId, activePeerId, unreadDmMap, setUnreadDmMap]);

  // Clear cross-conversation quote target on conversation switch
  useEffect(() => {
    setQuoteTarget(null);
    setComposerNotice(null);
  }, [podId, activePeerId]);

  const convoQueryKey = useMemo(
    () =>
      activePeerId
        ? (['messages', podId, 'dm', activePeerId] as const)
        : (['messages', podId, 'group'] as const),
    [podId, activePeerId]
  );

  const messagesQuery = useInfiniteQuery({
    queryKey: convoQueryKey,
    queryFn: ({ pageParam }) =>
      activePeerId
        ? fetchDmMessages(podId, activePeerId, pageParam, 40)
        : fetchPodMessages(podId, pageParam, 40),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.nextBeforeId && lastPage.nextBeforeId > 0
        ? lastPage.nextBeforeId
        : undefined,
    enabled: !!podId,
  });

  const chronologicalMessages = useMemo(() => {
    const pages = messagesQuery.data?.pages ?? [];
    if (pages.length === 0) return [];
    const seen = new Set<number>();
    const combined: RichMessageDto[] = [];
    for (let i = pages.length - 1; i >= 0; i--) {
      for (const msg of pages[i].messages) {
        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          combined.push(msg);
        }
      }
    }
    return combined;
  }, [messagesQuery.data]);

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, []);

  const switchConversation = (nextPeerId: string | null) => {
    if (!podId) return;
    if (draft.trim().length > 0) {
      sendFrame({
        type: 'typing',
        targetPeerId: activePeerId,
        isTyping: false,
      });
    }
    setActiveDmPeerMap((prev) => ({
      ...prev,
      [podId]: nextPeerId,
    }));
  };

  const openPrivateChat = (peerId: string) => {
    if (!podId || peerId === activePod?.myPeerId) return;
    setDmDirectoryOpen(false);
    setActionTarget(null);
    switchConversation(peerId);
  };

  const postMutation = useMutation({
    mutationFn: (payload: {
      body: string;
      quoteMessageId?: number;
      attachmentIds?: number[];
    }) =>
      activePeerId
        ? postDmMessage(podId, activePeerId, payload)
        : postPodMessage(podId, payload),
    onSuccess: (res) => {
      setDraft('');
      setQuoteTarget(null);
      setComposerNotice(
        res.commandHandled ? `Updated ${res.commandHandled}` : null
      );
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
      if (activePeerId) {
        queryClient.invalidateQueries({ queryKey: ['dms', podId] });
      }
      if (res.commandHandled === 'status') {
        queryClient.invalidateQueries({ queryKey: ['pods'] });
      }
    },
    onError: (err) => {
      setComposerNotice(
        err instanceof Error ? err.message : 'Could not send message.'
      );
    },
  });

  const reactMutation = useMutation({
    mutationFn: ({
      messageId,
      emoji,
    }: {
      messageId: number;
      emoji: string;
    }) => toggleReaction(messageId, emoji),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
    },
  });

  const pinMutation = useMutation({
    mutationFn: async (messageId: number) => {
      try {
        await togglePin(messageId);
        return 'toggled' as const;
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.status === 403 &&
          !activePeerId &&
          activePod?.governanceMode !== 'ADMIN'
        ) {
          await createPodProposal(podId, {
            kind: 'PIN_MESSAGE',
            messageId,
          });
          return 'proposed' as const;
        }
        throw err;
      }
    },
    onSuccess: (mode) => {
      if (mode === 'proposed') {
        setComposerNotice('Opened democratic pod vote to pin message.');
        queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
        queryClient.invalidateQueries({ queryKey: ['pods'] });
      }
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
      queryClient.invalidateQueries({ queryKey: ['pins', podId] });
    },
    onError: (err) => {
      setComposerNotice(
        err instanceof Error ? err.message : 'Could not update pin.'
      );
    },
  });

  const bookmarkMutation = useMutation({
    mutationFn: (messageId: number) => toggleBookmark(messageId),
    onSuccess: (res) => {
      setComposerNotice(
        res.bookmarked ? 'Saved to bookmarks.' : 'Removed from saved.'
      );
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (messageId: number) => deleteMessage(messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
      if (activePeerId) {
        queryClient.invalidateQueries({ queryKey: ['dms', podId] });
      }
    },
  });

  const voteMutation = useMutation({
    mutationFn: ({
      pollId,
      optionIndex,
    }: {
      pollId: number;
      optionIndex: number;
    }) => votePoll(pollId, optionIndex),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
    },
  });

  const voteProposalMutation = useMutation({
    mutationFn: ({
      proposalId,
      vote,
    }: {
      proposalId: number;
      vote: boolean;
    }) => voteProposal(proposalId, vote),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', podId, 'group'] });
      queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (err) => {
      setComposerNotice(err instanceof Error ? err.message : 'Vote failed.');
    },
  });

  const rematchMutation = useMutation({
    mutationFn: () => leavePod(podId, { rematch: true }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      if (res.newPod) {
        setActivePodId(res.newPod.podId);
        setComposerNotice(
          `Rematched into #${res.newPod.code} as ${res.newPod.myAlias}`
        );
      } else {
        setComposerNotice('Left pod; pick a new pod in Pods tab.');
      }
    },
  });

  const handleDraftChange = (text: string) => {
    setDraft(text);
    if (!podId) return;
    if (text.trim().length > 0) {
      sendFrame({
        type: 'typing',
        targetPeerId: activePeerId,
        isTyping: true,
      });
      if (typingStopTimerRef.current) {
        clearTimeout(typingStopTimerRef.current);
      }
      typingStopTimerRef.current = setTimeout(() => {
        sendFrame({
          type: 'typing',
          targetPeerId: activePeerId,
          isTyping: false,
        });
      }, 2400);
    } else {
      sendFrame({
        type: 'typing',
        targetPeerId: activePeerId,
        isTyping: false,
      });
    }
  };

  const handleSendText = () => {
    const trimmed = draft.trim();
    if (!trimmed || !podId || postMutation.isPending) return;
    if (trimmed === '/invite') {
      setDraft('');
      setInviteModalOpen(true);
      return;
    }
    if (trimmed === '/rematch') {
      setDraft('');
      rematchMutation.mutate();
      return;
    }
    sendFrame({
      type: 'typing',
      targetPeerId: activePeerId,
      isTyping: false,
    });
    postMutation.mutate({
      body: trimmed,
      quoteMessageId: quoteTarget?.id ?? 0,
    });
  };

  const handleSlashChip = (cmd: string) => {
    if (cmd === '/invite') {
      setInviteModalOpen(true);
    } else if (cmd === '/poll') {
      setDraft('/poll "What should our pod do next?" "Option A" "Option B"');
    } else if (cmd === '/icebreaker') {
      if (podId && !activePeerId) {
        postMutation.mutate({ body: '/icebreaker' });
      }
    } else if (cmd === '/shrug') {
      setDraft((prev) => (prev ? `/shrug ${prev}` : '/shrug all good'));
    } else if (cmd === '/status') {
      setDraft('/status Down to chat tonight');
    } else if (cmd === '/rematch') {
      rematchMutation.mutate();
    }
  };

  const startVoiceRecording = async () => {
    setComposerNotice(null);
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setComposerNotice(
          'Microphone permission denied. Enable mic access in settings for Voice Notes.'
        );
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setRecordElapsedSec(0);
      setIsRecording(true);
      recordTimerRef.current = setInterval(() => {
        setRecordElapsedSec((s) => s + 1);
      }, 1000);
    } catch {
      setComposerNotice(
        'Voice recorder unavailable on this simulator/browser — try on a physical device or enable mic input.'
      );
    }
  };

  const cancelVoiceRecording = async () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recordingRef.current) {
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch {
        // ignore stop errors
      }
      recordingRef.current = null;
    }
    setIsRecording(false);
    setRecordElapsedSec(0);
  };

  const finishAndSendVoiceNote = async () => {
    if (!recordingRef.current || !podId) return;
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    const rec = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    setUploadingVoice(true);

    try {
      const status = await rec.getStatusAsync();
      const durationMs =
        ('durationMillis' in status && status.durationMillis) ||
        recordElapsedSec * 1000 ||
        1500;
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      if (!uri) {
        throw new Error('No audio URI recorded');
      }
      const attachment = await uploadVoiceNoteAttachment(
        podId,
        uri,
        durationMs
      );
      const payload = {
        body: draft.trim() || 'Voice note',
        quoteMessageId: quoteTarget?.id ?? 0,
        attachmentIds: [attachment.id],
      };
      if (activePeerId) {
        await postDmMessage(podId, activePeerId, payload);
        queryClient.invalidateQueries({ queryKey: ['dms', podId] });
      } else {
        await postPodMessage(podId, payload);
      }
      setDraft('');
      setQuoteTarget(null);
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
    } catch (err) {
      setComposerNotice(
        err instanceof Error ? err.message : 'Failed to upload voice note.'
      );
    } finally {
      setUploadingVoice(false);
      setRecordElapsedSec(0);
    }
  };

  if (!activePod) {
    return (
      <View style={styles.emptyPodState}>
        <Ionicons
          name="chatbubble-ellipses-outline"
          size={34}
          color={PALETTE.forest}
        />
        <Text style={styles.emptyPodTitle}>Join a Pod to Start Chatting</Text>
        <Text style={styles.emptyPodBody}>
          Head to the Pods tab to match into an anonymous 25-member Compact,
          Standard, or Club pod.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setActiveTab('pods')}
          style={styles.goPodsBtn}
        >
          <Text style={styles.goPodsBtnText}>Browse Pods &amp; Match</Text>
        </Pressable>
      </View>
    );
  }

  const activeTypingKey = dmConvoKey(podId, activePeerId);
  const typingAliases = (typingByConvo[activeTypingKey] ?? []).filter(
    (a) => a !== activePod.myAlias
  );
  const activePeerAlias =
    activePeerInfo?.alias ??
    activePod.members.find((m) => m.peerId === activePeerId)?.alias ??
    'Peer';

  const totalUnreadDmsInPod = orderedPeers.reduce((sum, p) => {
    return sum + (unreadDmMap[dmConvoKey(podId, p.peerId)] ?? 0);
  }, 0);

  const slashChips = activePeerId ? DM_SLASH_CHIPS : GROUP_SLASH_CHIPS;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Top Pod Header + Native Chat Switcher Strip */}
      <View style={styles.topHeader}>
        <View style={styles.podBarRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch active pod"
            onPress={() => setPodSwitcherOpen(true)}
            style={styles.podSwitcherPill}
          >
            <Text style={styles.podSwitcherText} numberOfLines={1}>
              {activePod.title?.trim()
                ? activePod.title
                : `#${activePod.code}`}{' '}
              ▾
            </Text>
          </Pressable>

          <View style={styles.podMetaRight}>
            <View
              style={[
                styles.wsDot,
                { backgroundColor: wsConnected ? PALETTE.mint : PALETTE.amber },
              ]}
            />
            <Text style={styles.myAliasHeaderText} numberOfLines={1}>
              {activePod.myAlias}
            </Text>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Votes / Manage pod governance"
              onPress={() => setGovernanceModalOpen(true)}
              style={styles.headerGovBtn}
            >
              <Ionicons
                name={
                  activePod.governanceMode === 'ADMIN'
                    ? 'settings-outline'
                    : 'hammer-outline'
                }
                size={15}
                color={PALETTE.mint}
              />
              <Text style={styles.headerGovBtnText}>
                {activePod.governanceMode === 'ADMIN' ? 'Manage' : 'Votes'}
              </Text>
              {activePod.openProposalsCount > 0 ? (
                <View style={styles.openVoteBadge}>
                  <Text style={styles.openVoteBadgeText}>
                    {activePod.openProposalsCount}
                  </Text>
                </View>
              ) : null}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share / Invite"
              onPress={() => setInviteModalOpen(true)}
              style={styles.headerInviteBtn}
            >
              <Ionicons
                name="share-social-outline"
                size={18}
                color={PALETTE.mint}
              />
            </Pressable>
          </View>
        </View>

        {/* Sleek Chat Switcher Strip: Group Chat + 1:1 Member DM Pills + Members/+DM Sheet */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chatSwitcherStrip}
        >
          {/* Pill 1: Pod Group Chat */}
          <Pressable
            accessibilityRole="tab"
            accessibilityLabel={`Group Chat, ${activePod.memberCount} members`}
            accessibilityState={{ selected: activePeerId === null }}
            onPress={() => switchConversation(null)}
            style={[
              styles.chatPill,
              activePeerId === null && styles.chatPillActive,
            ]}
          >
            <Ionicons
              name="people"
              size={15}
              color={
                activePeerId === null ? PALETTE.charcoal : PALETTE.mint
              }
            />
            <Text
              style={[
                styles.chatPillText,
                activePeerId === null && styles.chatPillTextActive,
              ]}
            >
              Group Chat ({activePod.memberCount})
            </Text>
          </Pressable>

          {/* 1:1 Member DM Pills */}
          {orderedPeers.map((peer) => {
            const selected = activePeerId === peer.peerId;
            const unread = unreadDmMap[dmConvoKey(podId, peer.peerId)] ?? 0;
            return (
              <Pressable
                key={peer.peerId}
                accessibilityRole="tab"
                accessibilityLabel={`Private chat with ${peer.alias}`}
                accessibilityState={{ selected }}
                onPress={() => switchConversation(peer.peerId)}
                style={[styles.chatPill, selected && styles.chatPillActive]}
              >
                <View
                  style={[
                    styles.peerOnlineDot,
                    peer.online
                      ? selected
                        ? styles.peerOnlineDotOnMint
                        : styles.peerOnlineDotLive
                      : styles.peerOnlineDotOffline,
                  ]}
                />
                <Text
                  style={[
                    styles.chatPillText,
                    selected && styles.chatPillTextActive,
                  ]}
                  numberOfLines={1}
                >
                  {peer.alias}
                </Text>
                {unread > 0 ? (
                  <View
                    style={[
                      styles.unreadBadge,
                      selected && styles.unreadBadgeOnMint,
                    ]}
                  >
                    <Text
                      style={[
                        styles.unreadBadgeText,
                        selected && styles.unreadBadgeTextOnMint,
                      ]}
                    >
                      {unread}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}

          {/* + DM / Members Directory Trigger */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open members and private messages list"
            onPress={() => setDmDirectoryOpen(true)}
            style={styles.membersDmBtn}
          >
            <Ionicons
              name="chatbubble-ellipses-outline"
              size={15}
              color={PALETTE.mint}
            />
            <Text style={styles.membersDmBtnText}>
              + DM · Members ({orderedPeers.length})
            </Text>
            {totalUnreadDmsInPod > 0 ? (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>
                  {totalUnreadDmsInPod}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </ScrollView>
      </View>

      {/* Crisp 1:1 Private Chat Banner + Quick Return to Group */}
      {activePeerId !== null ? (
        <View style={styles.privateDmBanner}>
          <View style={styles.privateDmBannerLeft}>
            <Ionicons name="lock-closed" size={15} color={PALETTE.forest} />
            <View style={styles.privateDmTextCol}>
              <Text style={styles.privateDmTitle} numberOfLines={1}>
                Private 1:1 with {activePeerAlias} · Hidden from rest of pod
              </Text>
              <Text style={styles.privateDmSub} numberOfLines={1}>
                {activePeerInfo?.online ? '● Online now' : '○ Offline'}
                {activePeerInfo?.customStatus
                  ? ` · ${activePeerInfo.customStatus}`
                  : ''}
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to Pod Group Chat"
            onPress={() => switchConversation(null)}
            style={styles.backGroupChip}
          >
            <Text style={styles.backGroupChipText}>← Group</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Messages FlatList */}
      {messagesQuery.isLoading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator color={PALETTE.forest} />
        </View>
      ) : (
        <FlatList
          data={chronologicalMessages}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.messagesList}
          ListHeaderComponent={
            messagesQuery.hasNextPage ? (
              <Pressable
                accessibilityRole="button"
                disabled={messagesQuery.isFetchingNextPage}
                onPress={() => messagesQuery.fetchNextPage()}
                style={styles.loadEarlierBtn}
              >
                {messagesQuery.isFetchingNextPage ? (
                  <ActivityIndicator size="small" color={PALETTE.forest} />
                ) : (
                  <Text style={styles.loadEarlierText}>
                    ↑ Load earlier messages
                  </Text>
                )}
              </Pressable>
            ) : activePeerId !== null ? (
              <View style={styles.roomIntroCard}>
                <Text style={styles.roomIntroTitle}>
                  🔒 Private 1:1 Chat with {activePeerAlias}
                </Text>
                <Text style={styles.roomIntroSub}>
                  Only you ({activePod.myAlias}) and {activePeerAlias} can read
                  or search these messages inside #{activePod.code}. Zero real
                  identities exposed.
                </Text>
              </View>
            ) : (
              <View style={styles.roomIntroCard}>
                <Text style={styles.roomIntroTitle}>
                  Pod Group Chat · {activePod.memberCount} peers
                </Text>
                <Text style={styles.roomIntroSub}>
                  {activePod.description ||
                    'Shared peer-blind group chat — tap any member to message privately 1:1, or drop a /poll or Voice Note.'}
                </Text>
              </View>
            )
          }
          renderItem={({ item }) => (
            <MessageCard
              message={item}
              myPeerId={activePod.myPeerId}
              isDmView={activePeerId !== null}
              onOpenActions={(msg) => setActionTarget(msg)}
              onMessagePrivately={(peerId) => openPrivateChat(peerId)}
              onReplyQuote={(msg) => setQuoteTarget(msg)}
              onToggleReaction={(messageId, emoji) =>
                reactMutation.mutate({ messageId, emoji })
              }
              onVotePoll={(pollId, optionIndex) =>
                voteMutation.mutate({ pollId, optionIndex })
              }
              onVoteProposal={(proposalId, vote) =>
                voteProposalMutation.mutate({ proposalId, vote })
              }
            />
          )}
          ListEmptyComponent={
            <Text style={styles.emptyRoomText}>
              {activePeerId !== null
                ? `Say hi to ${activePeerAlias} privately — only the two of you will see it.`
                : 'No messages yet. Tap /icebreaker below to spark the pod!'}
            </Text>
          }
        />
      )}

      {/* Typing Indicator + Notice + Quote Banner */}
      {typingAliases.length > 0 ? (
        <View style={styles.typingStrip}>
          <Text style={styles.typingText}>
            {typingAliases.join(', ')}{' '}
            {typingAliases.length === 1 ? 'is' : 'are'} typing...
          </Text>
        </View>
      ) : null}

      {composerNotice ? (
        <View style={styles.noticeBar}>
          <Text style={styles.noticeText} numberOfLines={2}>
            {composerNotice}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setComposerNotice(null)}
            style={styles.smallCloseBtn}
          >
            <Ionicons name="close" size={16} color={PALETTE.ink} />
          </Pressable>
        </View>
      ) : null}

      {quoteTarget ? (
        <View style={styles.quoteComposerBanner}>
          <View style={styles.quoteComposerTextCol}>
            <Text style={styles.quoteComposerAuthor}>
              Replying to {quoteTarget.senderAlias}
            </Text>
            <Text style={styles.quoteComposerSnippet} numberOfLines={1}>
              {quoteTarget.body || 'Voice note / attachment'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel quote reply"
            onPress={() => setQuoteTarget(null)}
            style={styles.smallCloseBtn}
          >
            <Ionicons name="close" size={18} color={PALETTE.muted} />
          </Pressable>
        </View>
      ) : null}

      {/* Rich Composer Footer */}
      <View style={styles.composerWrap}>
        {/* Quick Slash Command Strip */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.slashStrip}
          keyboardShouldPersistTaps="handled"
        >
          {slashChips.map((chip) => (
            <Pressable
              key={chip.cmd}
              accessibilityRole="button"
              accessibilityLabel={`Slash command ${chip.label}`}
              onPress={() => handleSlashChip(chip.cmd)}
              style={styles.slashChip}
            >
              <Text style={styles.slashChipText}>{chip.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {isRecording ? (
          <View style={styles.recordingBar}>
            <View style={styles.recordLiveInfo}>
              <View style={styles.recordRedDot} />
              <Text style={styles.recordingTimerText}>
                Recording Voice Note · 0:
                {recordElapsedSec.toString().padStart(2, '0')}
              </Text>
            </View>
            <View style={styles.recordActions}>
              <Pressable
                accessibilityRole="button"
                onPress={cancelVoiceRecording}
                style={styles.cancelRecBtn}
              >
                <Text style={styles.cancelRecText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={finishAndSendVoiceNote}
                style={styles.sendRecBtn}
              >
                <Text style={styles.sendRecText}>Send Voice</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.composerInputRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Record voice note"
              disabled={uploadingVoice}
              onPress={startVoiceRecording}
              style={styles.micBtn}
            >
              {uploadingVoice ? (
                <ActivityIndicator size="small" color={PALETTE.forest} />
              ) : (
                <Ionicons name="mic-outline" size={20} color={PALETTE.ink} />
              )}
            </Pressable>

            <TextInput
              value={draft}
              onChangeText={handleDraftChange}
              placeholder={
                activePeerId
                  ? `Message ${activePeerAlias} privately...`
                  : `Message Group Chat...`
              }
              placeholderTextColor={PALETTE.muted}
              multiline
              style={styles.composerInput}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={!draft.trim() || postMutation.isPending}
              onPress={handleSendText}
              style={[
                styles.sendBtn,
                (!draft.trim() || postMutation.isPending) &&
                  styles.sendBtnDisabled,
              ]}
            >
              <Ionicons name="send" size={18} color={PALETTE.charcoal} />
            </Pressable>
          </View>
        )}
      </View>

      {/* Pod Share / Invite Modal */}
      <InviteShareModal
        visible={inviteModalOpen}
        pod={activePod}
        onClose={() => setInviteModalOpen(false)}
      />

      {/* Pod Governance / Admin Management Modal */}
      <PodGovernanceModal
        visible={governanceModalOpen}
        pod={activePod}
        onClose={() => setGovernanceModalOpen(false)}
        onOpenMemberDm={(peerId) => {
          setGovernanceModalOpen(false);
          openPrivateChat(peerId);
        }}
      />

      {/* Members & Private 1:1 DMs Bottom Sheet */}
      <Modal
        visible={dmDirectoryOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDmDirectoryOpen(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setDmDirectoryOpen(false)}
        >
          <Pressable style={styles.dmSheetCard} onPress={() => {}}>
            <View style={styles.dmSheetHeader}>
              <View style={styles.dmSheetHeaderCol}>
                <Text style={styles.sheetTitle}>
                  Pod Members &amp; Private DMs
                </Text>
                <Text style={styles.dmSheetSub}>
                  You are {activePod.myAlias} · Tap any peer to chat 1-on-1
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close members list"
                onPress={() => setDmDirectoryOpen(false)}
                style={styles.smallCloseBtn}
              >
                <Ionicons name="close" size={20} color={PALETTE.ink} />
              </Pressable>
            </View>

            <ScrollView
              style={styles.dmMembersScroll}
              contentContainerStyle={styles.dmMembersContent}
            >
              {/* Quick return to Group Chat row */}
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setDmDirectoryOpen(false);
                  switchConversation(null);
                }}
                style={[
                  styles.memberDmRow,
                  activePeerId === null && styles.memberDmRowActive,
                ]}
              >
                <View
                  style={[
                    styles.memberSheetAvatar,
                    { backgroundColor: PALETTE.forest },
                  ]}
                >
                  <Ionicons name="people" size={18} color={PALETTE.mint} />
                </View>
                <View style={styles.memberDmInfoCol}>
                  <Text style={styles.memberDmAlias}>
                    Pod Group Chat ({activePod.memberCount})
                  </Text>
                  <Text style={styles.memberDmSnippet} numberOfLines={1}>
                    Shared room with all pod members
                  </Text>
                </View>
                <View style={styles.openDmBtnSecondary}>
                  <Text style={styles.openDmBtnSecondaryText}>Open Group</Text>
                </View>
              </Pressable>

              {orderedPeers.length === 0 ? (
                <Text style={styles.emptyRoomText}>
                  No other members in this pod yet — tap Share / Invite to bring
                  peers in!
                </Text>
              ) : (
                orderedPeers.map((peer) => {
                  const avatarCol = safePeerColor(peer.color, peer.alias);
                  const unread =
                    unreadDmMap[dmConvoKey(podId, peer.peerId)] ?? 0;
                  const lastSnippet = peer.dm
                    ? `${
                        peer.dm.lastSenderPeerId === activePod.myPeerId
                          ? 'You'
                          : peer.alias
                      }: ${peer.dm.lastBody || 'Voice note'}`
                    : peer.customStatus || 'Tap to start a private 1:1 chat';

                  return (
                    <View
                      key={peer.peerId}
                      style={[
                        styles.memberDmRow,
                        activePeerId === peer.peerId && styles.memberDmRowActive,
                      ]}
                    >
                      <View style={styles.avatarWithDot}>
                        <View
                          style={[
                            styles.memberSheetAvatar,
                            { backgroundColor: avatarCol },
                          ]}
                        >
                          <Text style={styles.memberSheetInitials}>
                            {aliasInitials(peer.alias)}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.avatarStatusDot,
                            peer.online
                              ? styles.avatarStatusOnline
                              : styles.avatarStatusOffline,
                          ]}
                        />
                      </View>

                      <View style={styles.memberDmInfoCol}>
                        <View style={styles.memberDmAliasRow}>
                          <Text style={styles.memberDmAlias} numberOfLines={1}>
                            {peer.alias}
                          </Text>
                          {peer.inVoice ? (
                            <Text style={styles.inVoiceMiniTag}>🔊 Call</Text>
                          ) : null}
                          {unread > 0 ? (
                            <View style={styles.unreadBadge}>
                              <Text style={styles.unreadBadgeText}>
                                {unread}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={styles.memberDmSnippet} numberOfLines={1}>
                          {lastSnippet}
                        </Text>
                      </View>

                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Message ${peer.alias} privately`}
                        onPress={() => openPrivateChat(peer.peerId)}
                        style={styles.messagePrivatelyBtn}
                      >
                        <Text style={styles.messagePrivatelyText}>
                          Message Privately
                        </Text>
                      </Pressable>
                    </View>
                  );
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Message Action Sheet Modal */}
      <Modal
        visible={!!actionTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setActionTarget(null)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setActionTarget(null)}
        >
          <Pressable style={styles.sheetCard} onPress={() => {}}>
            <Text style={styles.sheetTitle}>
              Message from {actionTarget?.senderAlias}
            </Text>

            {/* Quick Emoji React Row */}
            <View style={styles.emojiBar}>
              {QUICK_EMOJIS.map((emoji) => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={`React with ${emoji}`}
                  onPress={() => {
                    if (actionTarget) {
                      reactMutation.mutate({
                        messageId: actionTarget.id,
                        emoji,
                      });
                    }
                    setActionTarget(null);
                  }}
                  style={styles.sheetEmojiBtn}
                >
                  <Text style={styles.sheetEmojiText}>{emoji}</Text>
                </Pressable>
              ))}
            </View>

            {/* 1:1 Private DM Action when tapping a peer's message in Group Chat */}
            {actionTarget?.senderPeerId &&
            actionTarget.senderPeerId !== activePod.myPeerId &&
            activePeerId !== actionTarget.senderPeerId ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  const targetPeerId = actionTarget.senderPeerId;
                  setActionTarget(null);
                  openPrivateChat(targetPeerId);
                }}
                style={[styles.sheetActionRow, styles.sheetActionMint]}
              >
                <Ionicons
                  name="lock-closed-outline"
                  size={18}
                  color={PALETTE.forest}
                />
                <Text
                  style={[styles.sheetActionText, { color: PALETTE.forest }]}
                >
                  Message {actionTarget.senderAlias} privately
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const target = actionTarget;
                setActionTarget(null);
                if (target) setQuoteTarget(target);
              }}
              style={styles.sheetActionRow}
            >
              <Ionicons
                name="return-down-forward-outline"
                size={18}
                color={PALETTE.ink}
              />
              <Text style={styles.sheetActionText}>Reply</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (actionTarget) bookmarkMutation.mutate(actionTarget.id);
                setActionTarget(null);
              }}
              style={styles.sheetActionRow}
            >
              <Ionicons name="bookmark-outline" size={18} color={PALETTE.ink} />
              <Text style={styles.sheetActionText}>
                {actionTarget?.isBookmarked
                  ? 'Remove Saved Bookmark'
                  : 'Bookmark Message'}
              </Text>
            </Pressable>

            {activePeerId === null ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (actionTarget) pinMutation.mutate(actionTarget.id);
                  setActionTarget(null);
                }}
                style={styles.sheetActionRow}
              >
                <Ionicons name="pin-outline" size={18} color={PALETTE.ink} />
                <Text style={styles.sheetActionText}>
                  {actionTarget?.isPinned ? 'Unpin from Pod' : 'Pin to Pod'}
                </Text>
              </Pressable>
            ) : null}

            {actionTarget?.senderPeerId === activePod.myPeerId ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (actionTarget) deleteMutation.mutate(actionTarget.id);
                  setActionTarget(null);
                }}
                style={styles.sheetActionRow}
              >
                <Ionicons
                  name="trash-outline"
                  size={18}
                  color={PALETTE.danger}
                />
                <Text
                  style={[styles.sheetActionText, { color: PALETTE.danger }]}
                >
                  Delete My Message
                </Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Pod Switcher Sheet */}
      <Modal
        visible={podSwitcherOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPodSwitcherOpen(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setPodSwitcherOpen(false)}
        >
          <Pressable style={styles.sheetCard} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Switch Active Pod</Text>
            {pods.map((p) => {
              const selected = p.podId === activePod.podId;
              return (
                <Pressable
                  key={p.podId}
                  accessibilityRole="button"
                  onPress={() => {
                    setActivePodId(p.podId);
                    setPodSwitcherOpen(false);
                  }}
                  style={[
                    styles.podSwitchRow,
                    selected && styles.podSwitchRowActive,
                  ]}
                >
                  <View style={styles.podSwitchCol}>
                    <Text style={styles.podSwitchCode}>
                      {p.title?.trim() ? p.title : `#${p.code}`}
                    </Text>
                    <Text style={styles.podSwitchSub}>
                      {p.governanceMode === 'ADMIN'
                        ? '👑 Admin'
                        : '⚖️ Democratic'}{' '}
                      · {p.interestLabel} · You: {p.myAlias}
                    </Text>
                  </View>
                  <Text style={styles.podSwitchTier}>
                    {capacityTierBadge(p.memberCount, p.maxMembers)}
                  </Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  emptyPodState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
    backgroundColor: PALETTE.surface,
  },
  emptyPodTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  emptyPodBody: {
    fontSize: 14,
    lineHeight: 20,
    color: PALETTE.muted,
    textAlign: 'center',
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
    marginTop: 6,
  },
  goPodsBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  topHeader: {
    backgroundColor: PALETTE.charcoal,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
  },
  podBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    gap: 8,
  },
  podSwitcherPill: {
    flexShrink: 1,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#2a2d2a',
    borderWidth: 1,
    borderColor: '#3a3f3a',
    justifyContent: 'center',
  },
  podSwitcherText: {
    color: PALETTE.mint,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO_FONT,
  },
  podMetaRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  wsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  myAliasHeaderText: {
    maxWidth: 88,
    color: PALETTE.card,
    fontSize: 11,
    fontWeight: '600',
  },
  headerGovBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#2a2d2a',
    borderWidth: 1,
    borderColor: '#3a3f3a',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  headerGovBtnText: {
    color: PALETTE.mint,
    fontSize: 12,
    fontWeight: '700',
  },
  openVoteBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: PALETTE.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openVoteBadgeText: {
    color: PALETTE.charcoal,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: MONO_FONT,
  },
  headerInviteBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: '#2a2d2a',
    borderWidth: 1,
    borderColor: '#3a3f3a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatSwitcherStrip: {
    paddingHorizontal: 12,
    gap: 8,
  },
  chatPill: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 13,
    borderRadius: 999,
    backgroundColor: '#262926',
    borderWidth: 1,
    borderColor: '#363b36',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  chatPillActive: {
    backgroundColor: PALETTE.mint,
    borderColor: PALETTE.mint,
  },
  chatPillText: {
    color: '#e2e6e2',
    fontSize: 13,
    fontWeight: '600',
    maxWidth: 130,
  },
  chatPillTextActive: {
    color: PALETTE.charcoal,
    fontWeight: '700',
  },
  peerOnlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  peerOnlineDotLive: {
    backgroundColor: PALETTE.mint,
  },
  peerOnlineDotOnMint: {
    backgroundColor: PALETTE.forest,
  },
  peerOnlineDotOffline: {
    backgroundColor: '#666c66',
  },
  unreadBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: PALETTE.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeOnMint: {
    backgroundColor: PALETTE.charcoal,
  },
  unreadBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: PALETTE.charcoal,
    fontFamily: MONO_FONT,
  },
  unreadBadgeTextOnMint: {
    color: PALETTE.mint,
  },
  membersDmBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 13,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#4a524a',
    backgroundColor: '#222522',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  membersDmBtnText: {
    color: PALETTE.mint,
    fontSize: 12,
    fontWeight: '700',
  },
  privateDmBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 6,
    backgroundColor: PALETTE.mintSoft,
    borderBottomWidth: 1,
    borderBottomColor: PALETTE.mintBorder,
  },
  privateDmBannerLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  privateDmTextCol: {
    flex: 1,
    gap: 1,
  },
  privateDmTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  privateDmSub: {
    fontSize: 11,
    color: PALETTE.ink,
    fontFamily: MONO_FONT,
  },
  backGroupChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.card,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGroupChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messagesList: {
    padding: 12,
    gap: 10,
  },
  loadEarlierBtn: {
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.card,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  loadEarlierText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  roomIntroCard: {
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    borderRadius: 14,
    padding: 12,
    marginBottom: 6,
    gap: 3,
  },
  roomIntroTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  roomIntroSub: {
    fontSize: 12,
    lineHeight: 17,
    color: PALETTE.ink,
  },
  emptyRoomText: {
    textAlign: 'center',
    color: PALETTE.muted,
    fontSize: 13,
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  typingStrip: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    backgroundColor: PALETTE.surfaceMuted,
  },
  typingText: {
    fontSize: 12,
    color: PALETTE.forest,
    fontWeight: '600',
  },
  noticeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: PALETTE.mintSoft,
    borderTopWidth: 1,
    borderTopColor: PALETTE.mintBorder,
  },
  noticeText: {
    flex: 1,
    fontSize: 12,
    color: PALETTE.forest,
    fontWeight: '600',
  },
  smallCloseBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quoteComposerBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 6,
    backgroundColor: PALETTE.surfaceMuted,
    borderTopWidth: 1,
    borderTopColor: PALETTE.border,
  },
  quoteComposerTextCol: {
    flex: 1,
    paddingVertical: 6,
  },
  quoteComposerAuthor: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  quoteComposerSnippet: {
    fontSize: 12,
    color: PALETTE.muted,
  },
  composerWrap: {
    backgroundColor: PALETTE.card,
    borderTopWidth: 1,
    borderTopColor: PALETTE.border,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 6,
  },
  slashStrip: {
    paddingHorizontal: 10,
    gap: 6,
  },
  slashChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slashChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  composerInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    gap: 8,
  },
  micBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    maxHeight: 110,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: PALETTE.ink,
  },
  sendBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.45,
  },
  recordingBar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 8,
  },
  recordLiveInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  recordRedDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: PALETTE.danger,
  },
  recordingTimerText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.danger,
    fontFamily: MONO_FONT,
  },
  recordActions: {
    flexDirection: 'row',
    gap: 8,
  },
  cancelRecBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelRecText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  sendRecBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendRecText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(25, 27, 25, 0.5)',
    justifyContent: 'flex-end',
    padding: 12,
  },
  sheetCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 18,
    padding: 16,
    gap: 8,
  },
  dmSheetCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 18,
    padding: 16,
    maxHeight: '80%',
    gap: 10,
  },
  dmSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  dmSheetHeaderCol: {
    flex: 1,
    gap: 2,
  },
  dmSheetSub: {
    fontSize: 12,
    color: PALETTE.muted,
  },
  dmMembersScroll: {
    flexGrow: 0,
  },
  dmMembersContent: {
    gap: 8,
    paddingBottom: 6,
  },
  memberDmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 14,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  memberDmRowActive: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.forest,
  },
  avatarWithDot: {
    position: 'relative',
  },
  memberSheetAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberSheetInitials: {
    color: PALETTE.card,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO_FONT,
  },
  avatarStatusDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: PALETTE.card,
  },
  avatarStatusOnline: {
    backgroundColor: PALETTE.forest,
  },
  avatarStatusOffline: {
    backgroundColor: PALETTE.muted,
  },
  memberDmInfoCol: {
    flex: 1,
    gap: 2,
  },
  memberDmAliasRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  memberDmAlias: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  inVoiceMiniTag: {
    fontSize: 10,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  memberDmSnippet: {
    fontSize: 12,
    color: PALETTE.muted,
  },
  messagePrivatelyBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messagePrivatelyText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  openDmBtnSecondary: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.card,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openDmBtnSecondaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  sheetTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  emojiBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  sheetEmojiBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetEmojiText: {
    fontSize: 20,
  },
  sheetActionRow: {
    minHeight: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
  },
  sheetActionMint: {
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
  },
  sheetActionText: {
    fontSize: 14,
    fontWeight: '600',
    color: PALETTE.ink,
  },
  podSwitchRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  podSwitchRowActive: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.forest,
  },
  podSwitchCol: {
    gap: 2,
    flex: 1,
  },
  podSwitchCode: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
    fontFamily: MONO_FONT,
  },
  podSwitchSub: {
    fontSize: 12,
    color: PALETTE.muted,
  },
  podSwitchTier: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
});
