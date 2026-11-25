import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../theme/ui';
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
  closePoll,
  createPodProposal,
  deleteMessage,
  editMessage,
  fetchDmMessages,
  fetchPins,
  fetchPodDms,
  fetchPodMessages,
  fetchPods,
  leavePod,
  markPodConversationRead,
  postDmMessage,
  postPodMessage,
  toggleBookmark,
  togglePin,
  toggleReaction,
  updatePodMute,
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
  activeDmCallAtom,
  activeDmPeerByPodAtom,
  activePodIdAtom,
  activeTabAtom,
  activeVoiceSessionAtom,
  callNoticeAtom,
  dmConvoKey,
  peerLastReadByPodPeerAtom,
  typingByConvoAtom,
  unreadDmByPodPeerAtom,
  unreadGroupByPodAtom,
  wsConnectedAtom,
} from '../state/atoms';
import {
  GUTTER,
  INSET,
  PIECES,
  PIECE_HEX,
  TOUCH_MIN,
  capacityTierBadge,
  pieceColor,
} from '../theme/palette';
import { Sheet } from '../components/Sheet';
import { Badge, Btn, Piece, fieldStyles } from '../components/Pieces';
import { voicePeersByPodAtom } from '../state/atoms';
import { CallBar } from '../components/CallBar';
import { MessageCard, continuesRun } from '../components/MessageCard';
import { InviteShareModal } from '../components/InviteShareModal';
import { PodGovernanceModal } from '../components/PodGovernanceModal';
import { RichTextBody } from '../components/RichTextBody';
import type { Calls } from '../voice/useCalls';

const QUICK_EMOJIS = ['🔥', '👍', '😂', '🎯', '❤️'];

const GROUP_SLASH_CHIPS: ReadonlyArray<{ cmd: string; label: string }> = [
  { cmd: '/poll', label: 'Poll' },
  { cmd: '/icebreaker', label: 'Icebreaker' },
  { cmd: '/coin', label: 'Flip coin' },
  { cmd: '/roll', label: 'Roll 2d6' },
  { cmd: '/invite', label: 'Invite' },
  { cmd: '/shrug', label: 'Shrug' },
  { cmd: '/rematch', label: 'New room' },
];

const DM_SLASH_CHIPS: ReadonlyArray<{ cmd: string; label: string }> = [
  { cmd: '/coin', label: 'Flip coin' },
  { cmd: '/roll', label: 'Roll 2d6' },
  { cmd: '/status', label: 'Status' },
  { cmd: '/shrug', label: 'Shrug' },
  { cmd: '/invite', label: 'Invite' },
];

const CHIP_COLORS = [
  PIECE_HEX.cobalt,
  PIECE_HEX.jade,
  PIECE_HEX.coral,
  PIECE_HEX.ochre,
  PIECE_HEX.quartz,
];

const MONO_FONT = 'DMMono_500Medium';

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
  calls,
  phone,
  otherRoomsUnread = 0,
}: {
  sendFrame: (frame: WsOutboundFrame) => boolean;
  calls: Calls;
  /** One screen at a time: the room bar also carries back-to-rooms, search and account. */
  phone: boolean;
  otherRoomsUnread?: number;
}) {
  const queryClient = useQueryClient();
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const [activeDmPeerMap, setActiveDmPeerMap] = useAtom(activeDmPeerByPodAtom);
  const [unreadGroupMap, setUnreadGroupMap] = useAtom(unreadGroupByPodAtom);
  const [unreadDmMap, setUnreadDmMap] = useAtom(unreadDmByPodPeerAtom);
  const [peerLastReadMap, setPeerLastReadMap] = useAtom(
    peerLastReadByPodPeerAtom
  );
  const voiceSession = useAtomValue(activeVoiceSessionAtom);
  const activeDmCall = useAtomValue(activeDmCallAtom);
  const [callNotice, setCallNotice] = useAtom(callNoticeAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const typingByConvo = useAtomValue(typingByConvoAtom);
  const wsConnected = useAtomValue(wsConnectedAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);

  const lastMarkedReadRef = useRef<Record<string, number>>({});

  const [podSwitcherOpen, setPodSwitcherOpen] = useState(false);
  const [dmDirectoryOpen, setDmDirectoryOpen] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [governanceModalOpen, setGovernanceModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pollSheetOpen, setPollSheetOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);

  const [actionTarget, setActionTarget] = useState<RichMessageDto | null>(null);
  const [quoteTarget, setQuoteTarget] = useState<RichMessageDto | null>(null);
  const [editingTarget, setEditingTarget] = useState<RichMessageDto | null>(null);
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

  const pinsQuery = useQuery({
    queryKey: ['pins', podId],
    queryFn: () => fetchPins(podId),
    enabled: !!podId && activePeerId === null,
    staleTime: 15_000,
  });
  const pinnedMessages = pinsQuery.data?.messages ?? [];

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

  // Seed peerLastRead & unreadDm atoms from fetched DM summaries
  useEffect(() => {
    if (!podId || dmConversations.length === 0) return;
    setPeerLastReadMap((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const dm of dmConversations) {
        const key = dmConvoKey(podId, dm.peerId);
        const incoming = dm.peerLastReadMessageId ?? 0;
        if (incoming > (next[key] ?? 0)) {
          next[key] = incoming;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setUnreadDmMap((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const dm of dmConversations) {
        const key = dmConvoKey(podId, dm.peerId);
        if (next[key] === undefined && (dm.unreadCount ?? 0) > 0) {
          next[key] = dm.unreadCount ?? 0;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [podId, dmConversations, setPeerLastReadMap, setUnreadDmMap]);

  // Clear cross-conversation quote/edit targets on conversation switch
  useEffect(() => {
    setQuoteTarget(null);
    setEditingTarget(null);
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

  const latestMessageId =
    chronologicalMessages.length > 0
      ? chronologicalMessages[chronologicalMessages.length - 1].id
      : 0;

  // Open at the newest message, and follow it until you scroll yourself.
  const listRef = useRef<FlatList<RichMessageDto>>(null);
  const stickToEndRef = useRef(true);
  useEffect(() => {
    stickToEndRef.current = true;
  }, [latestMessageId, convoQueryKey]);
  const followEnd = () => {
    if (!stickToEndRef.current) return;
    // The list's own scrollToEnd guesses the height of rows it has not measured
    // and stops short; the scroll view under it knows the real end.
    const scroller = listRef.current?.getScrollResponder() as unknown as ScrollView | null;
    scroller?.scrollToEnd({ animated: false });
  };

  // iOS measures the keyboard from the top of the screen, not from this view.
  const rootRef = useRef<View>(null);
  const [topOffset, setTopOffset] = useState(0);

  const notice = composerNotice || callNotice;
  useEffect(() => {
    if (!composerNotice) return;
    const timer = setTimeout(() => setComposerNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [composerNotice]);

  // Auto-advance server read cursor (deduplicated by lastReadMessageId per conversation)
  useEffect(() => {
    if (!podId || latestMessageId <= 0) return;
    const key = dmConvoKey(podId, activePeerId);
    if (latestMessageId <= (lastMarkedReadRef.current[key] ?? 0)) {
      return;
    }
    lastMarkedReadRef.current[key] = latestMessageId;

    if (activePeerId === null) {
      setUnreadGroupMap((prev) =>
        (prev[podId] ?? 0) === 0 ? prev : { ...prev, [podId]: 0 }
      );
      queryClient.setQueryData(
        ['pods'],
        (old: { pods: PodDetailDto[] } | undefined) =>
          old
            ? {
                pods: old.pods.map((p) =>
                  p.podId === podId ? { ...p, unreadGroupCount: 0 } : p
                ),
              }
            : old
      );
    } else {
      setUnreadDmMap((prev) =>
        (prev[key] ?? 0) === 0 ? prev : { ...prev, [key]: 0 }
      );
      queryClient.setQueryData(
        ['dms', podId],
        (old: { conversations: DmSummaryDto[] } | undefined) =>
          old
            ? {
                conversations: old.conversations.map((c) =>
                  c.peerId === activePeerId ? { ...c, unreadCount: 0 } : c
                ),
              }
            : old
      );
      queryClient.setQueryData(
        ['pods'],
        (old: { pods: PodDetailDto[] } | undefined) =>
          old
            ? {
                pods: old.pods.map((p) =>
                  p.podId === podId
                    ? {
                        ...p,
                        dmConversations: (p.dmConversations ?? []).map((c) =>
                          c.peerId === activePeerId
                            ? { ...c, unreadCount: 0 }
                            : c
                        ),
                      }
                    : p
                ),
              }
            : old
      );
    }

    markPodConversationRead(podId, activePeerId, latestMessageId).catch(
      () => {}
    );
  }, [
    podId,
    activePeerId,
    latestMessageId,
    queryClient,
    setUnreadGroupMap,
    setUnreadDmMap,
  ]);

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
        err instanceof Error ? err.message : 'Could not send that.'
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
        setComposerNotice('Opened a room vote to pin that message.');
        queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
        queryClient.invalidateQueries({ queryKey: ['pods'] });
      }
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
      queryClient.invalidateQueries({ queryKey: ['pins', podId] });
    },
    onError: (err) => {
      setComposerNotice(
        err instanceof Error ? err.message : 'Could not change the pin.'
      );
    },
  });

  const bookmarkMutation = useMutation({
    mutationFn: (messageId: number) => toggleBookmark(messageId),
    onSuccess: (res) => {
      setComposerNotice(
        res.bookmarked ? 'Saved.' : 'Removed from saved.'
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

  const closePollMutation = useMutation({
    mutationFn: (pollId: number) => closePoll(pollId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
    },
    onError: (err) => {
      setComposerNotice(
        err instanceof Error ? err.message : 'Could not close the poll.'
      );
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ messageId, body }: { messageId: number; body: string }) =>
      editMessage(messageId, body),
    onSuccess: () => {
      setEditingTarget(null);
      setDraft('');
      queryClient.invalidateQueries({ queryKey: convoQueryKey });
      if (activePeerId) {
        queryClient.invalidateQueries({ queryKey: ['dms', podId] });
      }
    },
    onError: (err) => {
      setComposerNotice(
        err instanceof Error ? err.message : 'Could not save the edit.'
      );
    },
  });

  const muteMutation = useMutation({
    mutationFn: (muted: boolean) => updatePodMute(podId, muted),
    onSuccess: (res) => {
      queryClient.setQueryData(
        ['pods'],
        (old: { pods: PodDetailDto[] } | undefined) =>
          old
            ? {
                pods: old.pods.map((p) =>
                  p.podId === podId ? { ...p, myMuted: res.muted } : p
                ),
              }
            : old
      );
      setComposerNotice(res.muted ? 'Room muted.' : 'Room unmuted.');
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
          `New room. You are ${res.newPod.myAlias} here.`
        );
      } else {
        setComposerNotice('You left. Pick a new room in Rooms.');
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
    if (!trimmed || !podId || postMutation.isPending || editMutation.isPending) return;
    if (editingTarget) {
      editMutation.mutate({ messageId: editingTarget.id, body: trimmed });
      return;
    }
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
    setExtrasOpen(false);
    if (cmd === '/invite') {
      setInviteModalOpen(true);
    } else if (cmd === '/poll') {
      setPollQuestion('');
      setPollOptions(['', '']);
      setPollSheetOpen(true);
    } else if (cmd === '/icebreaker') {
      if (podId && !activePeerId) {
        postMutation.mutate({ body: '/icebreaker' });
      }
    } else if (cmd === '/coin') {
      if (podId) postMutation.mutate({ body: '/coin' });
    } else if (cmd === '/roll') {
      if (podId) postMutation.mutate({ body: '/roll 2d6' });
    } else if (cmd === '/shrug') {
      setDraft((prev) => (prev ? `/shrug ${prev}` : '/shrug all good'));
    } else if (cmd === '/status') {
      setDraft('/status Down to chat tonight');
    } else if (cmd === '/rematch') {
      rematchMutation.mutate();
    }
  };

  const handleSubmitPoll = () => {
    const q = pollQuestion.trim();
    const opts = pollOptions.map((o) => o.trim()).filter(Boolean);
    if (!q || opts.length < 2 || !podId) return;
    const escaped = [q, ...opts].map((x) => `"${x.replace(/"/g, "'")}"`).join(' ');
    setPollSheetOpen(false);
    postMutation.mutate({ body: `/poll ${escaped}` });
  };

  const startVoiceRecording = async () => {
    setComposerNotice(null);
    if (voiceSession || activeDmCall) {
      // The recorder would take the microphone from the call.
      setComposerNotice('Leave the call to record a voice note.');
      return;
    }
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setComposerNotice(
          'The microphone is off. Turn it on in settings to send voice notes.'
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
        'Recording is not available here. Try a phone, or turn on the microphone.'
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
        err instanceof Error ? err.message : 'Could not send the voice note.'
      );
    } finally {
      setUploadingVoice(false);
      setRecordElapsedSec(0);
    }
  };

  if (!activePod) {
    return (
      <View style={styles.emptyPodState}>
        <Text style={styles.emptyPodTitle}>No room to talk in yet</Text>
        <Text style={styles.emptyPodBody}>
          Pick a hobby in Rooms and you get a seat, and an alias to sit under.
        </Text>
        <Btn
          label="Go to Rooms"
          kind="blue"
          big
          onPress={() => setActiveTab('pods')}
        />
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
  const activePeerOnline =
    activePeerInfo?.online ??
    activePod.members.find((m) => m.peerId === activePeerId)?.online ??
    false;

  const unreadFrom = (peer: PeerChatItem) =>
    unreadDmMap[dmConvoKey(podId, peer.peerId)] ?? peer.dm?.unreadCount ?? 0;
  const groupUnreadCount =
    unreadGroupMap[podId] ?? activePod.unreadGroupCount ?? 0;
  const privateUnreadCount = orderedPeers.reduce((n, p) => n + unreadFrom(p), 0);

  const activePeerLastReadMessageId = activePeerId
    ? Math.max(
        peerLastReadMap[dmConvoKey(podId, activePeerId)] ?? 0,
        activePeerInfo?.dm?.peerLastReadMessageId ?? 0
      )
    : 0;

  const slashChips = activePeerId ? DM_SLASH_CHIPS : GROUP_SLASH_CHIPS;
  const roomName = activePod.title?.trim() || activePod.interestLabel;
  const callCount = (voicePeersByPod[podId] ?? []).length;
  const votesLabel = activePod.governanceMode === 'ADMIN' ? 'Manage the room' : 'Votes';
  const openVotes = activePod.openProposalsCount;
  const onCallWithPeer = activeDmCall?.peerId === activePeerId;

  return (
    <View
      ref={rootRef}
      style={styles.container}
      onLayout={() => rootRef.current?.measureInWindow((_x, y) => setTopOffset(y))}
    >
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={topOffset}
    >
      {/* One bar: who you are talking to on the left, what you can do on the right */}
      <View style={styles.topHeader}>
        {activePeerId === null ? (
          <>
            {phone ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Back to Rooms${
                  otherRoomsUnread > 0 ? `, ${otherRoomsUnread} unread in other rooms` : ''
                }`}
                onPress={() => setActiveTab('pods')}
                style={styles.roundBtn}
              >
                <Ionicons name="chevron-back" size={22} color={PIECES.ink} />
                {otherRoomsUnread > 0 ? (
                  <View style={styles.cornerBadge}>
                    <Badge n={otherRoomsUnread} />
                  </View>
                ) : null}
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${roomName}. You are ${activePod.myAlias}. Switch room`}
              onPress={() => setPodSwitcherOpen(true)}
              style={styles.titleBtn}
            >
              <View style={styles.titleRow}>
                <Text style={styles.roomName} numberOfLines={1}>
                  {roomName}
                </Text>
                <Ionicons name="chevron-down" size={16} color={PIECES.ink} />
              </View>
              <View style={styles.titleRow}>
                <View
                  style={[
                    styles.wsDot,
                    { backgroundColor: wsConnected ? PIECE_HEX.jade : PIECES.off },
                  ]}
                />
                <Text style={styles.titleSub} numberOfLines={1}>
                  {wsConnected ? `You are ${activePod.myAlias}` : 'Reconnecting'}
                </Text>
              </View>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Back to the group chat${
                groupUnreadCount > 0 ? `, ${groupUnreadCount} unread` : ''
              }`}
              onPress={() => switchConversation(null)}
              style={styles.roundBtn}
            >
              <Ionicons name="chevron-back" size={22} color={PIECES.ink} />
              {groupUnreadCount > 0 ? (
                <View style={styles.cornerBadge}>
                  <Badge n={groupUnreadCount} />
                </View>
              ) : null}
            </Pressable>
            {/* A private chat: a block in the other person's colour */}
            <View
              style={[styles.peerBlock, { backgroundColor: pieceColor(activePeerAlias) }]}
            >
              <Text style={styles.peerName} numberOfLines={1}>
                {activePeerAlias}
              </Text>
              <Text style={styles.peerSub} numberOfLines={1}>
                {activePeerOnline ? 'Online' : 'Away'}
                {activePeerInfo?.customStatus ? ` · ${activePeerInfo.customStatus}` : ''}
              </Text>
            </View>
          </>
        )}

        {activePeerId === null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Everyone here, ${activePod.memberCount} people${
              privateUnreadCount > 0 ? `, ${privateUnreadCount} unread private messages` : ''
            }`}
            onPress={() => setDmDirectoryOpen(true)}
            style={styles.countBtn}
          >
            <Ionicons name="people" size={18} color={PIECES.ink} />
            <Text style={styles.countText}>{activePod.memberCount}</Text>
            {privateUnreadCount > 0 ? (
              <View style={styles.cornerBadge}>
                <Badge n={privateUnreadCount} />
              </View>
            ) : null}
          </Pressable>
        ) : null}

        {activePeerId !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Call ${activePeerAlias} privately`}
            accessibilityState={{ disabled: onCallWithPeer }}
            disabled={onCallWithPeer}
            onPress={() =>
              calls.startPrivateCall(activePod, {
                peerId: activePeerId,
                alias: activePeerAlias,
                color: pieceColor(activePeerAlias),
                online: activePeerOnline,
              })
            }
            style={[styles.roundBtn, onCallWithPeer && styles.roundBtnOn]}
          >
            <Ionicons
              name="call"
              size={19}
              color={onCallWithPeer ? PIECES.sheet : PIECES.ink}
            />
          </Pressable>
        ) : phone ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              callCount > 0 ? `Room call, ${callCount} in it` : 'Room call, nobody in it'
            }
            onPress={() => setActiveTab('voice')}
            style={callCount > 0 ? [styles.countBtn, styles.countBtnOn] : styles.roundBtn}
          >
            <Ionicons
              name="call"
              size={18}
              color={callCount > 0 ? PIECES.sheet : PIECES.ink}
            />
            {callCount > 0 ? (
              <Text style={[styles.countText, styles.countTextOn]}>{callCount}</Text>
            ) : null}
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More for ${roomName}${
            openVotes > 0 ? `, ${openVotes} open ${openVotes === 1 ? 'vote' : 'votes'}` : ''
          }`}
          onPress={() => setMenuOpen(true)}
          style={styles.roundBtn}
        >
          <Ionicons name="ellipsis-horizontal" size={20} color={PIECES.ink} />
          {openVotes > 0 ? (
            <View style={styles.cornerBadge}>
              <Badge n={openVotes} />
            </View>
          ) : null}
        </Pressable>
      </View>

      {phone ? <CallBar calls={calls} /> : null}

      {activePeerId === null && pinnedMessages.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Pinned by ${pinnedMessages[0].senderAlias}: ${
            pinnedMessages[0].body || 'Attachment'
          }. View all ${pinnedMessages.length} pinned messages`}
          onPress={() => setPinsOpen(true)}
          style={styles.pinBar}
        >
          <Ionicons name="pin" size={15} color={PIECES.muted} />
          <Text style={styles.pinBarText} numberOfLines={1}>
            <Text style={styles.pinBarAuthor}>{pinnedMessages[0].senderAlias} </Text>
            {pinnedMessages[0].body || 'Pinned attachment'}
          </Text>
          {pinnedMessages.length > 1 ? (
            <Text style={styles.pinBarCount}>{pinnedMessages.length}</Text>
          ) : null}
        </Pressable>
      ) : null}

      {/* Messages */}
      {messagesQuery.isLoading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator color={PIECES.ink} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={styles.list}
          onContentSizeChange={followEnd}
          // The keyboard makes the list shorter; keep the newest message in view.
          onLayout={followEnd}
          onScrollBeginDrag={() => {
            stickToEndRef.current = false;
          }}
          onScroll={({ nativeEvent: e }) => {
            const left = e.contentSize.height - e.contentOffset.y - e.layoutMeasurement.height;
            if (left < 24) stickToEndRef.current = true;
          }}
          scrollEventThrottle={64}
          initialNumToRender={40}
          data={chronologicalMessages}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.messagesList}
          ListHeaderComponent={
            messagesQuery.hasNextPage ? (
              <View style={styles.loadEarlierWrap}>
                <Btn
                  label="Earlier messages"
                  kind="white"
                  loading={messagesQuery.isFetchingNextPage}
                  onPress={() => messagesQuery.fetchNextPage()}
                />
              </View>
            ) : (
              <View style={styles.roomIntroCard}>
                <Text style={styles.roomIntroTitle}>
                  {activePeerId !== null
                    ? `Private with ${activePeerAlias}`
                    : `${roomName}, ${activePod.memberCount} people`}
                </Text>
                <Text style={styles.roomIntroSub}>
                  {activePeerId !== null
                    ? `Only you (${activePod.myAlias}) and ${activePeerAlias} can read or search this.`
                    : activePod.description ||
                      'Everyone here is an alias. Tap a message to write to that person privately.'}
                </Text>
              </View>
            )
          }
          renderItem={({ item, index }) => (
            <MessageCard
              message={item}
              continues={continuesRun(chronologicalMessages[index - 1], item)}
              myPeerId={activePod.myPeerId}
              isDmView={activePeerId !== null}
              peerLastReadMessageId={activePeerLastReadMessageId}
              onOpenActions={(msg) => setActionTarget(msg)}
              onToggleReaction={(messageId, emoji) =>
                reactMutation.mutate({ messageId, emoji })
              }
              onVotePoll={(pollId, optionIndex) =>
                voteMutation.mutate({ pollId, optionIndex })
              }
              canClosePoll={
                item.senderPeerId === activePod.myPeerId ||
                (activePod.governanceMode === 'ADMIN' && activePod.myRole !== 'MEMBER')
              }
              onClosePoll={(pollId) => closePollMutation.mutate(pollId)}
              onVoteProposal={(proposalId, vote) =>
                voteProposalMutation.mutate({ proposalId, vote })
              }
            />
          )}
          ListEmptyComponent={
            <Text style={styles.emptyRoomText}>
              {activePeerId !== null
                ? `Say hi to ${activePeerAlias}. Only the two of you see it.`
                : 'Quiet so far. Press + for an icebreaker.'}
            </Text>
          }
        />
      )}

      {typingAliases.length > 0 ? (
        <View style={styles.typingStrip}>
          <Text style={styles.typingText}>
            {typingAliases.join(', ')}{' '}
            {typingAliases.length === 1 ? 'is' : 'are'} typing
          </Text>
        </View>
      ) : null}

      {notice ? (
        <View style={styles.noticeBar} accessibilityRole="alert">
          <Text style={styles.noticeText} numberOfLines={2}>
            {notice}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            onPress={() => {
              setComposerNotice(null);
              setCallNotice(null);
            }}
            style={styles.smallCloseBtn}
          >
            <Ionicons name="close" size={18} color={PIECES.ink} />
          </Pressable>
        </View>
      ) : null}

      {editingTarget ? (
        <View style={styles.quoteComposerBanner}>
          <View style={styles.quoteComposerTextCol}>
            <Text style={styles.quoteComposerAuthor}>Editing your message</Text>
            <Text style={styles.quoteComposerSnippet} numberOfLines={1}>
              {editingTarget.body}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel edit"
            onPress={() => {
              setEditingTarget(null);
              setDraft('');
            }}
            style={styles.smallCloseBtn}
          >
            <Ionicons name="close" size={18} color={PIECES.ink} />
          </Pressable>
        </View>
      ) : quoteTarget ? (
        <View style={styles.quoteComposerBanner}>
          <View style={styles.quoteComposerTextCol}>
            <Text style={styles.quoteComposerAuthor}>
              Replying to {quoteTarget.senderAlias}
            </Text>
            <Text style={styles.quoteComposerSnippet} numberOfLines={1}>
              {quoteTarget.body || 'Voice note or file'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel the reply"
            onPress={() => setQuoteTarget(null)}
            style={styles.smallCloseBtn}
          >
            <Ionicons name="close" size={18} color={PIECES.ink} />
          </Pressable>
        </View>
      ) : null}

      {/* Composer: one row. The plus opens the commands. */}
      <View style={styles.composerWrap}>
        {extrasOpen && !isRecording ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.slashStrip}
            keyboardShouldPersistTaps="handled"
          >
            {slashChips.map((chip, idx) => (
              <Pressable
                key={chip.cmd}
                accessibilityRole="button"
                accessibilityLabel={`${chip.label}, command ${chip.cmd}`}
                onPress={() => handleSlashChip(chip.cmd)}
                style={[
                  styles.slashChip,
                  { backgroundColor: CHIP_COLORS[idx % CHIP_COLORS.length] },
                ]}
              >
                <Text style={styles.slashChipText}>{chip.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {isRecording ? (
          <View style={styles.recordingBar}>
            <View style={styles.recordLiveInfo}>
              <View style={styles.recordRedDot} />
              <Text style={styles.recordingTimerText}>
                Recording 0:{recordElapsedSec.toString().padStart(2, '0')}
              </Text>
            </View>
            <View style={styles.recordActions}>
              <Btn label="Cancel" onPress={cancelVoiceRecording} />
              <Btn label="Send" kind="blue" onPress={finishAndSendVoiceNote} />
            </View>
          </View>
        ) : (
          <View style={styles.composerInputRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={extrasOpen ? 'Hide commands' : 'Polls, icebreakers and more'}
              accessibilityState={{ expanded: extrasOpen }}
              onPress={() => setExtrasOpen((v) => !v)}
              style={styles.composerBtn}
            >
              <Ionicons name={extrasOpen ? 'close' : 'add'} size={24} color={PIECES.ink} />
            </Pressable>

            <TextInput
              value={draft}
              onChangeText={handleDraftChange}
              placeholder={
                activePeerId
                  ? `Write to ${activePeerAlias} alone`
                  : `Write to ${roomName}`
              }
              placeholderTextColor={PIECES.muted}
              accessibilityLabel="Message"
              multiline
              // A browser textarea starts at two rows; a phone's field starts at one.
              {...(Platform.OS === 'web' ? { rows: 1 } : null)}
              style={styles.composerInput}
            />

            {draft.trim() ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send message"
                accessibilityState={{ disabled: postMutation.isPending }}
                disabled={postMutation.isPending}
                onPress={handleSendText}
                style={({ pressed }) => [
                  styles.composerBtn,
                  { backgroundColor: pressed ? PIECES.blueDown : PIECES.blue },
                ]}
              >
                {postMutation.isPending ? (
                  <ActivityIndicator size="small" color={PIECES.sheet} />
                ) : (
                  <Ionicons name="arrow-up" size={22} color={PIECES.sheet} />
                )}
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Record a voice note"
                disabled={uploadingVoice}
                onPress={startVoiceRecording}
                style={styles.composerBtn}
              >
                {uploadingVoice ? (
                  <ActivityIndicator size="small" color={PIECES.ink} />
                ) : (
                  <Ionicons name="mic-outline" size={22} color={PIECES.ink} />
                )}
              </Pressable>
            )}
          </View>
        )}
      </View>

      <InviteShareModal
        visible={inviteModalOpen}
        pod={activePod}
        onClose={() => setInviteModalOpen(false)}
      />

      <PodGovernanceModal
        visible={governanceModalOpen}
        pod={activePod}
        onClose={() => setGovernanceModalOpen(false)}
        onOpenMemberDm={(peerId) => {
          setGovernanceModalOpen(false);
          openPrivateChat(peerId);
        }}
      />

      {/* The room's own pages */}
      <Sheet visible={menuOpen} title={roomName} onClose={() => setMenuOpen(false)}>
        <Btn
          label={openVotes > 0 ? `${votesLabel}, ${openVotes} open` : votesLabel}
          icon="checkmark-done"
          style={styles.menuBtn}
          big
          wide
          onPress={() => {
            setMenuOpen(false);
            setGovernanceModalOpen(true);
          }}
        />
        <Btn
          label="Invite people"
          icon="person-add"
          style={styles.menuBtn}
          big
          wide
          onPress={() => {
            setMenuOpen(false);
            setInviteModalOpen(true);
          }}
        />
        <Btn
          label={activePod.myMuted ? 'Unmute this room' : 'Mute this room'}
          icon={activePod.myMuted ? 'notifications-outline' : 'notifications-off-outline'}
          style={styles.menuBtn}
          big
          wide
          onPress={() => {
            setMenuOpen(false);
            muteMutation.mutate(!activePod.myMuted);
          }}
        />
        {pinnedMessages.length > 0 ? (
          <Btn
            label={`Pinned (${pinnedMessages.length})`}
            icon="pin"
            style={styles.menuBtn}
            big
            wide
            onPress={() => {
              setMenuOpen(false);
              setPinsOpen(true);
            }}
          />
        ) : null}
        {phone ? (
          <>
            <Btn
              label="Search and saved"
              icon="search"
              style={styles.menuBtn}
              big
              wide
              onPress={() => {
                setMenuOpen(false);
                setActiveTab('search');
              }}
            />
            <Btn
              label="Account"
              icon="person"
              style={styles.menuBtn}
              big
              wide
              onPress={() => {
                setMenuOpen(false);
                setActiveTab('account');
              }}
            />
          </>
        ) : null}
      </Sheet>

      {/* Everyone in the room */}
      <Sheet
        visible={dmDirectoryOpen}
        title="Everyone here"
        lead={`You are ${activePod.myAlias}. Tap anyone to write to them alone.`}
        onClose={() => setDmDirectoryOpen(false)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Group chat"
          onPress={() => {
            setDmDirectoryOpen(false);
            switchConversation(null);
          }}
          style={[styles.memberDmRow, activePeerId === null && styles.memberDmRowActive]}
        >
          <View style={styles.groupTile}>
            <Ionicons name="people" size={22} color={PIECES.sheet} />
          </View>
          <View style={styles.memberDmInfoCol}>
            <Text style={styles.memberDmAlias}>Group chat</Text>
            <Text style={styles.memberDmSnippet} numberOfLines={1}>
              {activePod.memberCount} people
            </Text>
          </View>
        </Pressable>

        {orderedPeers.length === 0 ? (
          <Text style={styles.emptyRoomText}>
            Nobody else is here yet. Invite people to fill the room.
          </Text>
        ) : (
          orderedPeers.map((peer) => {
            const unread = unreadFrom(peer);
            const lastSnippet = peer.dm
              ? `${
                  peer.dm.lastSenderPeerId === activePod.myPeerId ? 'You: ' : ''
                }${peer.dm.lastBody || 'Voice note'}`
              : peer.customStatus ||
                (peer.online ? 'Here now' : 'Away');
            return (
              <Pressable
                key={peer.peerId}
                accessibilityRole="button"
                accessibilityLabel={`Write to ${peer.alias} privately${
                  unread > 0 ? `, ${unread} unread` : ''
                }`}
                onPress={() => openPrivateChat(peer.peerId)}
                style={[
                  styles.memberDmRow,
                  activePeerId === peer.peerId && styles.memberDmRowActive,
                ]}
              >
                <Piece alias={peer.alias} size={48} away={!peer.online} />
                <View style={styles.memberDmInfoCol}>
                  <Text style={styles.memberDmAlias} numberOfLines={1}>
                    {peer.alias}
                    {peer.inVoice ? '  · in the call' : ''}
                  </Text>
                  <Text style={styles.memberDmSnippet} numberOfLines={1}>
                    {lastSnippet}
                  </Text>
                </View>
                {unread > 0 ? <Badge n={unread} /> : null}
              </Pressable>
            );
          })
        )}
      </Sheet>

      {/* What you can do with a message */}
      <Sheet
        visible={!!actionTarget}
        title={`From ${actionTarget?.senderAlias ?? ''}`}
        onClose={() => setActionTarget(null)}
      >
        {actionTarget?.body && !actionTarget.poll && !actionTarget.proposal ? (
          <View style={styles.actionBody}>
            <RichTextBody body={actionTarget.body} selectable />
          </View>
        ) : null}
        <View style={styles.emojiBar}>
          {QUICK_EMOJIS.map((emoji) => (
            <Pressable
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={`React with ${emoji}`}
              onPress={() => {
                if (actionTarget) {
                  reactMutation.mutate({ messageId: actionTarget.id, emoji });
                }
                setActionTarget(null);
              }}
              style={styles.sheetEmojiBtn}
            >
              <Text style={styles.sheetEmojiText}>{emoji}</Text>
            </Pressable>
          ))}
        </View>

        {actionTarget?.senderPeerId &&
        actionTarget.senderPeerId !== activePod.myPeerId &&
        activePeerId !== actionTarget.senderPeerId ? (
          <Btn
            label={`Write to ${actionTarget.senderAlias} privately`}
            kind="blue"
            wide
            onPress={() => {
              const targetPeerId = actionTarget.senderPeerId;
              setActionTarget(null);
              openPrivateChat(targetPeerId);
            }}
          />
        ) : null}

        <Btn
          label="Reply"
          wide
          onPress={() => {
            const target = actionTarget;
            setActionTarget(null);
            if (target) setQuoteTarget(target);
          }}
        />
        <Btn
          label={actionTarget?.isBookmarked ? 'Remove from saved' : 'Save it'}
          wide
          onPress={() => {
            if (actionTarget) bookmarkMutation.mutate(actionTarget.id);
            setActionTarget(null);
          }}
        />
        {activePeerId === null ? (
          <Btn
            label={actionTarget?.isPinned ? 'Unpin' : 'Pin to the room'}
            wide
            onPress={() => {
              if (actionTarget) pinMutation.mutate(actionTarget.id);
              setActionTarget(null);
            }}
          />
        ) : null}
        {actionTarget?.senderPeerId === activePod.myPeerId &&
        actionTarget.msgType === 'TEXT' ? (
          <Btn
            label="Edit"
            wide
            onPress={() => {
              const target = actionTarget;
              setActionTarget(null);
              if (target) {
                setQuoteTarget(null);
                setEditingTarget(target);
                setDraft(target.body);
              }
            }}
          />
        ) : null}
        {actionTarget?.senderPeerId === activePod.myPeerId ? (
          <Btn
            label="Delete mine"
            kind="off"
            wide
            onPress={() => {
              if (actionTarget) deleteMutation.mutate(actionTarget.id);
              setActionTarget(null);
            }}
          />
        ) : null}
      </Sheet>

      {/* Pinned messages sheet */}
      <Sheet
        visible={pinsOpen}
        title={`Pinned in ${roomName}`}
        onClose={() => setPinsOpen(false)}
      >
        {pinnedMessages.length === 0 ? (
          <Text style={styles.emptyRoomText}>Nothing is pinned in this room yet.</Text>
        ) : (
          pinnedMessages.map((msg) => (
            <MessageCard
              key={msg.id}
              message={msg}
              myPeerId={activePod.myPeerId}
              onToggleReaction={(messageId, emoji) =>
                reactMutation.mutate({ messageId, emoji })
              }
              onVotePoll={(pollId, optionIndex) =>
                voteMutation.mutate({ pollId, optionIndex })
              }
              canClosePoll={
                msg.senderPeerId === activePod.myPeerId ||
                (activePod.governanceMode === 'ADMIN' && activePod.myRole !== 'MEMBER')
              }
              onClosePoll={(pollId) => closePollMutation.mutate(pollId)}
              onVoteProposal={(proposalId, vote) =>
                voteProposalMutation.mutate({ proposalId, vote })
              }
            />
          ))
        )}
      </Sheet>

      {/* Guided poll creator */}
      <Sheet
        visible={pollSheetOpen}
        title="New poll"
        lead="Ask the room a question with up to five answers."
        onClose={() => setPollSheetOpen(false)}
      >
        <TextInput
          value={pollQuestion}
          onChangeText={setPollQuestion}
          placeholder="What should we play tonight?"
          placeholderTextColor={PIECES.muted}
          maxLength={240}
          accessibilityLabel="Poll question"
          style={fieldStyles.input}
        />
        {pollOptions.map((opt, i) => (
          <TextInput
            key={i}
            value={opt}
            onChangeText={(val) =>
              setPollOptions((prev) => prev.map((x, idx) => (idx === i ? val : x)))
            }
            placeholder={`Answer ${i + 1}`}
            placeholderTextColor={PIECES.muted}
            maxLength={120}
            accessibilityLabel={`Answer ${i + 1}`}
            style={fieldStyles.input}
          />
        ))}
        <View style={styles.recordActions}>
          {pollOptions.length < 5 ? (
            <Btn
              label="Add answer"
              onPress={() => setPollOptions((prev) => [...prev, ''])}
            />
          ) : null}
          <Btn
            label="Post poll"
            kind="blue"
            disabled={
              !pollQuestion.trim() ||
              pollOptions.filter((o) => o.trim().length > 0).length < 2
            }
            onPress={handleSubmitPoll}
          />
        </View>
      </Sheet>

      {/* Switch room */}
      <Sheet
        visible={podSwitcherOpen}
        title="Your rooms"
        onClose={() => setPodSwitcherOpen(false)}
      >
        {pods.map((p) => {
          const selected = p.podId === activePod.podId;
          return (
            <Pressable
              key={p.podId}
              accessibilityRole="button"
              accessibilityLabel={`${p.title?.trim() || p.interestLabel}, you are ${p.myAlias}`}
              accessibilityState={{ selected }}
              onPress={() => {
                setActivePodId(p.podId);
                setPodSwitcherOpen(false);
              }}
              style={[
                styles.podSwitchRow,
                selected && { backgroundColor: pieceColor(p.myAlias) },
              ]}
            >
              <View style={styles.podSwitchCol}>
                <Text style={styles.podSwitchCode}>
                  {p.title?.trim() || p.interestLabel}
                </Text>
                <Text style={styles.podSwitchSub}>
                  as {p.myAlias} · {capacityTierBadge(p.memberCount, p.maxMembers)}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </Sheet>
    </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PIECES.bg },
  emptyPodState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: PIECES.bg,
  },
  emptyPodTitle: { fontSize: 24, color: PIECES.ink, fontWeight: '600', textAlign: 'center' },
  emptyPodBody: { fontSize: 16, lineHeight: 23, color: PIECES.muted, textAlign: 'center' },
  topHeader: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: GUTTER,
    paddingVertical: 6,
    backgroundColor: PIECES.sheet,
    borderBottomWidth: 1,
    borderBottomColor: PIECES.hair,
  },
  titleBtn: { flex: 1, minWidth: 0, minHeight: TOUCH_MIN, justifyContent: 'center', paddingLeft: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  roomName: { flexShrink: 1, fontSize: 20, lineHeight: 24, color: PIECES.ink, fontWeight: '600' },
  titleSub: { flexShrink: 1, fontSize: 13, lineHeight: 17, color: PIECES.muted },
  wsDot: { width: 8, height: 8, borderRadius: 4 },
  peerBlock: {
    flex: 1,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 22,
  },
  peerName: { fontSize: 17, lineHeight: 21, color: PIECES.ink, fontWeight: '600' },
  peerSub: { fontSize: 13, lineHeight: 17, color: PIECES.ink },
  roundBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: TOUCH_MIN / 2,
    backgroundColor: PIECES.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundBtnOn: { backgroundColor: PIECES.blue },
  countBtn: {
    height: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: TOUCH_MIN / 2,
    backgroundColor: PIECES.bg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  countBtnOn: { backgroundColor: PIECES.blue },
  countText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  countTextOn: { color: PIECES.sheet },
  cornerBadge: { position: 'absolute', top: -6, right: -6 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1, minHeight: 0 },
  // A short chat sits by the field, not at the top of an empty screen.
  messagesList: { padding: GUTTER, paddingBottom: 8, flexGrow: 1, justifyContent: 'flex-end' },
  loadEarlierWrap: { alignItems: 'center', paddingBottom: 12 },
  roomIntroCard: {
    backgroundColor: PIECES.sheet,
    borderRadius: 24,
    padding: INSET,
    gap: 4,
  },
  roomIntroTitle: { fontSize: 20, color: PIECES.ink, fontWeight: '600' },
  roomIntroSub: { fontSize: 14, lineHeight: 20, color: PIECES.muted },
  emptyRoomText: { fontSize: 15, lineHeight: 21, color: PIECES.muted, textAlign: 'center', padding: 16 },
  typingStrip: { paddingHorizontal: GUTTER + INSET, paddingVertical: 4 },
  typingText: { fontSize: 14, color: PIECES.muted },
  noticeBar: {
    marginHorizontal: GUTTER,
    marginBottom: 6,
    paddingLeft: INSET,
    minHeight: 48,
    borderRadius: 24,
    backgroundColor: PIECE_HEX.mint,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  noticeText: { flex: 1, fontSize: 14, fontWeight: '600', color: PIECES.ink },
  smallCloseBtn: { width: TOUCH_MIN, height: TOUCH_MIN, alignItems: 'center', justifyContent: 'center' },
  quoteComposerBanner: {
    marginHorizontal: GUTTER,
    marginBottom: 6,
    paddingLeft: INSET,
    minHeight: 52,
    borderRadius: 24,
    backgroundColor: PIECES.sheet,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  quoteComposerTextCol: { flex: 1 },
  quoteComposerAuthor: { fontSize: 13, fontWeight: '700', color: PIECES.ink },
  quoteComposerSnippet: { fontSize: 14, color: PIECES.muted },
  composerWrap: {
    marginHorizontal: GUTTER,
    marginBottom: 6,
    padding: 6,
    gap: 6,
    borderRadius: 28,
    backgroundColor: PIECES.sheet,
  },
  slashStrip: { gap: 6 },
  slashChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 18,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slashChipText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  // Buttons stay on the last line while the field grows upward.
  composerInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  composerBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: TOUCH_MIN / 2,
    backgroundColor: PIECES.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    maxHeight: 120,
    paddingHorizontal: 18,
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: 22,
    backgroundColor: PIECES.bg,
    fontSize: 16,
    lineHeight: 22,
    color: PIECES.ink,
    textAlignVertical: 'center',
  },
  recordingBar: { minHeight: TOUCH_MIN, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  recordLiveInfo: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: INSET - 6 },
  recordRedDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: PIECES.alarm },
  recordingTimerText: { fontSize: 15, fontFamily: MONO_FONT, color: PIECES.ink },
  recordActions: { flexDirection: 'row', gap: 8 },
  memberDmRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    borderRadius: 26,
  },
  memberDmRowActive: { backgroundColor: PIECES.bg },
  groupTile: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: PIECES.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberDmInfoCol: { flex: 1, minWidth: 0 },
  memberDmAlias: { fontSize: 17, fontWeight: '600', color: PIECES.ink },
  memberDmSnippet: { fontSize: 14, color: PIECES.muted },
  menuBtn: { justifyContent: 'flex-start', paddingHorizontal: 20 },
  actionBody: { backgroundColor: PIECES.bg, borderRadius: 20, padding: 14 },
  emojiBar: { flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  sheetEmojiBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: PIECES.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetEmojiText: { fontSize: 24 },
  podSwitchRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 24,
    backgroundColor: PIECES.bg,
  },
  podSwitchCol: { flex: 1 },
  podSwitchCode: { fontSize: 19, color: PIECES.ink, fontFamily: 'Gabarito_500Medium' },
  pinBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: GUTTER,
    marginTop: 6,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: PIECES.sheet,
  },
  pinBarText: { flex: 1, fontSize: 14, color: PIECES.ink },
  pinBarAuthor: { fontWeight: '700', color: PIECES.ink },
  pinBarCount: { fontSize: 13, fontFamily: MONO_FONT, color: PIECES.muted },
  podSwitchSub: { fontSize: 14, color: PIECES.ink2, marginTop: 1 },
});
