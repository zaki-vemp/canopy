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
  createPodProposal,
  deleteMessage,
  fetchDmMessages,
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
  dmCallNoticeAtom,
  dmConvoKey,
  peerLastReadByPodPeerAtom,
  typingByConvoAtom,
  unreadDmByPodPeerAtom,
  unreadGroupByPodAtom,
  wsConnectedAtom,
} from '../state/atoms';
import {
  PALETTE,
  PIECES,
  PIECE_HEX,
  PIECE_NAMES,
  TOUCH_MIN,
  capacityTierBadge,
  pieceColor,
} from '../theme/palette';
import { Sheet } from '../components/Sheet';
import { Badge, Btn, Piece } from '../components/Pieces';
import { voicePeersByPodAtom } from '../state/atoms';
import { MessageCard } from '../components/MessageCard';
import { InviteShareModal } from '../components/InviteShareModal';
import { PodGovernanceModal } from '../components/PodGovernanceModal';

const QUICK_EMOJIS = ['🔥', '👍', '😂', '🎯', '❤️'];

const GROUP_SLASH_CHIPS: ReadonlyArray<{ cmd: string; label: string }> = [
  { cmd: '/poll', label: 'Poll' },
  { cmd: '/icebreaker', label: 'Icebreaker' },
  { cmd: '/invite', label: 'Invite' },
  { cmd: '/shrug', label: 'Shrug' },
  { cmd: '/rematch', label: 'New room' },
];

const DM_SLASH_CHIPS: ReadonlyArray<{ cmd: string; label: string }> = [
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
}: {
  sendFrame: (frame: WsOutboundFrame) => boolean;
}) {
  const queryClient = useQueryClient();
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const [activeDmPeerMap, setActiveDmPeerMap] = useAtom(activeDmPeerByPodAtom);
  const [unreadGroupMap, setUnreadGroupMap] = useAtom(unreadGroupByPodAtom);
  const [unreadDmMap, setUnreadDmMap] = useAtom(unreadDmByPodPeerAtom);
  const [peerLastReadMap, setPeerLastReadMap] = useAtom(
    peerLastReadByPodPeerAtom
  );
  const [voiceSession, setVoiceSession] = useAtom(activeVoiceSessionAtom);
  const [activeDmCall, setActiveDmCall] = useAtom(activeDmCallAtom);
  const [dmCallNotice, setDmCallNotice] = useAtom(dmCallNoticeAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const typingByConvo = useAtomValue(typingByConvoAtom);
  const wsConnected = useAtomValue(wsConnectedAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);

  const lastMarkedReadRef = useRef<Record<string, number>>({});

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

  const handleStartPrivateCall = async (
    targetPeerId: string,
    targetAlias: string,
    targetColor: string,
    targetOnline: boolean
  ) => {
    if (!podId || !targetPeerId) return;
    if (voiceSession) {
      sendFrame({ type: 'voice_leave' });
      setVoiceSession(null);
    }
    if (activeDmCall && activeDmCall.peerId !== targetPeerId) {
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
      // fallback to synth/listen mode cleanly
    }

    setDmCallNotice(null);
    setActiveDmCall({
      podId,
      peerId: targetPeerId,
      peerAlias: targetAlias,
      peerColor: targetColor,
      peerOnline: targetOnline,
      phase: 'ringing',
      muted: false,
      speaking: false,
      peerMuted: false,
      peerSpeaking: false,
    });
    sendFrame({ type: 'dm_call_ring', targetPeerId });
  };

  const handleToggleDmCallMute = () => {
    if (!activeDmCall || activeDmCall.phase !== 'connected') return;
    const nextMuted = !activeDmCall.muted;
    const nextSpeaking = nextMuted ? false : activeDmCall.speaking;
    setActiveDmCall({
      ...activeDmCall,
      muted: nextMuted,
      speaking: nextSpeaking,
    });
    sendFrame({
      type: 'dm_call_state',
      peerId: activeDmCall.peerId,
      muted: nextMuted,
      speaking: nextSpeaking,
    });
  };

  const handleToggleDmCallSpeak = () => {
    if (!activeDmCall || activeDmCall.phase !== 'connected') return;
    const nextSpeaking = !activeDmCall.speaking;
    const nextMuted = nextSpeaking ? false : activeDmCall.muted;
    setActiveDmCall({
      ...activeDmCall,
      muted: nextMuted,
      speaking: nextSpeaking,
    });
    sendFrame({
      type: 'dm_call_state',
      peerId: activeDmCall.peerId,
      muted: nextMuted,
      speaking: nextSpeaking,
    });
  };

  const handleEndDmCall = () => {
    if (!activeDmCall) return;
    sendFrame({ type: 'dm_call_end', peerId: activeDmCall.peerId });
    setActiveDmCall(null);
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
      setDraft('/poll "What should our room do next?" "Option A" "Option B"');
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
  const activePeerColor = pieceColor(activePeerAlias);
  const activePeerOnline =
    activePeerInfo?.online ??
    activePod.members.find((m) => m.peerId === activePeerId)?.online ??
    false;

  const groupUnreadCount =
    unreadGroupMap[podId] ?? activePod.unreadGroupCount ?? 0;

  const activePeerLastReadMessageId = activePeerId
    ? Math.max(
        peerLastReadMap[dmConvoKey(podId, activePeerId)] ?? 0,
        activePeerInfo?.dm?.peerLastReadMessageId ?? 0
      )
    : 0;

  const podDmCall =
    activeDmCall &&
    activeDmCall.podId === podId &&
    (activeDmCall.phase === 'ringing' || activeDmCall.phase === 'connected')
      ? activeDmCall
      : null;

  const slashChips = activePeerId ? DM_SLASH_CHIPS : GROUP_SLASH_CHIPS;
  const roomName = activePod.title?.trim() || activePod.interestLabel;
  const callCount = (voicePeersByPod[podId] ?? []).length;
  const inGroupCall = voiceSession?.podId === podId;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header sheet: room name, the room's own pages, then who you are talking to */}
      <View style={styles.topHeader}>
        <View style={styles.podBarRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${roomName}. Switch room`}
            onPress={() => setPodSwitcherOpen(true)}
            style={styles.roomNameBtn}
          >
            <Text style={styles.roomName} numberOfLines={1}>
              {roomName}
            </Text>
            <Ionicons name="chevron-down" size={18} color={PIECES.ink} />
          </Pressable>

          <View
            style={[
              styles.wsDot,
              { backgroundColor: wsConnected ? PIECE_HEX.jade : PIECES.off },
            ]}
            accessibilityLabel={wsConnected ? 'Live' : 'Reconnecting'}
          />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              activePod.openProposalsCount > 0
                ? `${
                    activePod.governanceMode === 'ADMIN' ? 'Manage' : 'Votes'
                  }, ${activePod.openProposalsCount} open`
                : activePod.governanceMode === 'ADMIN'
                ? 'Manage the room'
                : 'Votes'
            }
            onPress={() => setGovernanceModalOpen(true)}
            style={styles.headerLink}
          >
            <Text style={styles.headerLinkText}>
              {activePod.governanceMode === 'ADMIN' ? 'Manage' : 'Votes'}
            </Text>
            {activePod.openProposalsCount > 0 ? (
              <Badge n={activePod.openProposalsCount} />
            ) : null}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Invite people"
            onPress={() => setInviteModalOpen(true)}
            style={styles.headerLink}
          >
            <Text style={styles.headerLinkText}>Invite</Text>
          </Pressable>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chatSwitcherStrip}
        >
          <Pressable
            accessibilityRole="tab"
            accessibilityLabel={`Group chat, ${activePod.memberCount} people`}
            accessibilityState={{ selected: activePeerId === null }}
            onPress={() => switchConversation(null)}
            style={[styles.chatPill, activePeerId === null && styles.chatPillActive]}
          >
            <Text
              style={[
                styles.chatPillText,
                activePeerId === null && styles.chatPillTextActive,
              ]}
            >
              Everyone · {activePod.memberCount}
            </Text>
            {activePeerId !== null && groupUnreadCount > 0 ? (
              <Badge n={groupUnreadCount} />
            ) : null}
          </Pressable>

          {orderedPeers.map((peer) => {
            const selected = activePeerId === peer.peerId;
            const unread =
              unreadDmMap[dmConvoKey(podId, peer.peerId)] ??
              peer.dm?.unreadCount ??
              0;
            return (
              <Pressable
                key={peer.peerId}
                accessibilityRole="tab"
                accessibilityLabel={`Private chat with ${peer.alias}${
                  unread > 0 ? `, ${unread} unread` : ''
                }${peer.online ? '' : ', away'}`}
                accessibilityState={{ selected }}
                onPress={() => switchConversation(peer.peerId)}
                style={[
                  styles.peerChip,
                  selected && { backgroundColor: pieceColor(peer.alias) },
                ]}
              >
                <Piece alias={peer.alias} size={34} away={!peer.online} />
                {selected ? (
                  <Text style={styles.chatPillText} numberOfLines={1}>
                    {peer.alias}
                  </Text>
                ) : null}
                {unread > 0 ? (
                  <View style={styles.peerUnread}>
                    <Badge n={unread} />
                  </View>
                ) : null}
              </Pressable>
            );
          })}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Everyone in the room, and private chats"
            onPress={() => setDmDirectoryOpen(true)}
            style={styles.chatPill}
          >
            <Text style={styles.chatPillText}>All {orderedPeers.length + 1}</Text>
          </Pressable>
        </ScrollView>
      </View>

      {/* Group call strip */}
      {activePeerId === null && callCount > 0 ? (
        <View style={styles.groupCallBar}>
          <Text style={styles.groupCallText}>
            {callCount} in the call
          </Text>
          <Btn
            label={inGroupCall ? 'Open' : 'Join'}
            kind="blue"
            onPress={() => setActiveTab('voice')}
            a11yLabel={inGroupCall ? 'Open the room call' : 'Join the room call'}
          />
        </View>
      ) : null}

      {/* A private chat: a block in the other person's colour */}
      {activePeerId !== null ? (
        <View style={[styles.privateDmBanner, { backgroundColor: activePeerColor }]}>
          <View style={styles.privateDmTextCol}>
            <Text style={styles.privateDmTitle} numberOfLines={1}>
              {activePeerAlias}
            </Text>
            <Text style={styles.privateDmSub} numberOfLines={1}>
              {activePeerOnline ? 'Online' : 'Away'}
              {activePeerInfo?.customStatus
                ? ` · ${activePeerInfo.customStatus}`
                : ''}
            </Text>
          </View>
          <View style={styles.privateDmBannerActions}>
            <Btn
              label="Call"
              kind="ink"
              icon="call-outline"
              disabled={podDmCall?.peerId === activePeerId}
              onPress={() =>
                handleStartPrivateCall(
                  activePeerId,
                  activePeerAlias,
                  activePeerColor,
                  activePeerOnline
                )
              }
              a11yLabel={`Call ${activePeerAlias} privately`}
            />
            <Btn
              label="Back"
              kind="white"
              onPress={() => switchConversation(null)}
              a11yLabel="Back to the group chat"
            />
          </View>
        </View>
      ) : null}

      {/* Private call bar */}
      {podDmCall ? (
        <View style={styles.dmCallBar}>
          <View style={styles.dmCallTopRow}>
            <View style={styles.dmCallTextCol}>
              <Text style={styles.dmCallTitle} numberOfLines={1}>
                {podDmCall.phase === 'ringing'
                  ? `Calling ${podDmCall.peerAlias}`
                  : `On a private call with ${podDmCall.peerAlias}`}
              </Text>
              <Text style={styles.dmCallSub} numberOfLines={1}>
                {podDmCall.phase === 'ringing'
                  ? podDmCall.peerOnline
                    ? 'Ringing. Nobody else sees it.'
                    : 'Away. It rings when they are back.'
                  : podDmCall.peerSpeaking
                  ? `${podDmCall.peerAlias} is speaking`
                  : podDmCall.peerMuted
                  ? `${podDmCall.peerAlias} is muted`
                  : 'Connected'}
              </Text>
            </View>
            {podDmCall.phase === 'ringing' ? (
              <Btn
                label="End"
                kind="off"
                onPress={handleEndDmCall}
                a11yLabel="End the private call"
              />
            ) : null}
          </View>

          {podDmCall.phase === 'connected' ? (
            <View style={styles.dmCallControlsRow}>
              <Btn
                label={podDmCall.muted ? 'Unmute' : 'Mute'}
                kind="white"
                icon={podDmCall.muted ? 'mic-off' : 'mic'}
                onPress={handleToggleDmCallMute}
                a11yLabel={
                  podDmCall.muted ? 'Unmute the private call' : 'Mute the private call'
                }
              />
              <Btn
                label={podDmCall.speaking ? 'Speaking' : 'Speak'}
                kind={podDmCall.speaking ? 'blue' : 'white'}
                icon="pulse"
                onPress={handleToggleDmCallSpeak}
                a11yLabel="Pulse speak in the private call"
              />
              <Btn
                label="End"
                kind="off"
                onPress={handleEndDmCall}
                a11yLabel="End the private call"
              />
            </View>
          ) : null}
        </View>
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
          onContentSizeChange={() => {
            if (stickToEndRef.current) {
              listRef.current?.scrollToEnd({ animated: false });
            }
          }}
          onScrollBeginDrag={() => {
            stickToEndRef.current = false;
          }}
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
          renderItem={({ item }) => (
            <MessageCard
              message={item}
              myPeerId={activePod.myPeerId}
              isDmView={activePeerId !== null}
              peerLastReadMessageId={activePeerLastReadMessageId}
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
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            <Text style={styles.emptyRoomText}>
              {activePeerId !== null
                ? `Say hi to ${activePeerAlias}. Only the two of you see it.`
                : 'Quiet so far. Try an icebreaker below.'}
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

      {composerNotice || dmCallNotice ? (
        <View style={styles.noticeBar} accessibilityRole="alert">
          <Text style={styles.noticeText} numberOfLines={2}>
            {composerNotice || dmCallNotice}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            onPress={() => {
              setComposerNotice(null);
              setDmCallNotice(null);
            }}
            style={styles.smallCloseBtn}
          >
            <Ionicons name="close" size={18} color={PIECES.ink} />
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

      {/* Composer sheet: coloured command pills, then the field and Send */}
      <View style={styles.composerWrap}>
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
              accessibilityLabel="Record a voice note"
              disabled={uploadingVoice}
              onPress={startVoiceRecording}
              style={styles.micBtn}
            >
              {uploadingVoice ? (
                <ActivityIndicator size="small" color={PIECES.ink} />
              ) : (
                <Ionicons name="mic-outline" size={22} color={PIECES.ink} />
              )}
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
              style={styles.composerInput}
            />

            <Btn
              label="Send"
              kind="blue"
              disabled={!draft.trim() || postMutation.isPending}
              onPress={handleSendText}
              style={{ minHeight: 48, borderRadius: 24 }}
              a11yLabel="Send message"
            />
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
            const unread =
              unreadDmMap[dmConvoKey(podId, peer.peerId)] ??
              peer.dm?.unreadCount ??
              0;
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
    backgroundColor: PIECES.sheet,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 4,
  },
  podBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 6,
  },
  roomNameBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  roomName: { flexShrink: 1, fontSize: 24, color: PIECES.ink, fontWeight: '600' },
  wsDot: { width: 10, height: 10, borderRadius: 5 },
  headerLink: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerLinkText: { fontSize: 15, color: PIECES.ink, fontWeight: '600' },
  chatSwitcherStrip: {
    paddingHorizontal: 12,
    gap: 8,
    alignItems: 'center',
  },
  chatPill: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 22,
    backgroundColor: PIECES.bg,
  },
  chatPillActive: { backgroundColor: PIECES.ink },
  chatPillText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  chatPillTextActive: { color: PIECES.sheet },
  peerChip: {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    paddingHorizontal: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 22,
    backgroundColor: PIECES.bg,
    paddingRight: 5,
  },
  peerUnread: { position: 'absolute', top: -6, right: -6 },
  groupCallBar: {
    marginHorizontal: 12,
    marginTop: 8,
    minHeight: 56,
    paddingLeft: 20,
    paddingRight: 6,
    borderRadius: 28,
    backgroundColor: PIECES.ink,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  groupCallText: { fontSize: 16, fontWeight: '600', color: PIECES.sheet },
  privateDmBanner: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 16,
    borderRadius: 24,
    gap: 10,
  },
  privateDmTextCol: { gap: 2 },
  privateDmTitle: { fontSize: 24, color: PIECES.ink, fontWeight: '600' },
  privateDmSub: { fontSize: 14, color: PIECES.ink2 },
  privateDmBannerActions: { flexDirection: 'row', gap: 8 },
  dmCallBar: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 16,
    borderRadius: 24,
    backgroundColor: PIECES.ink,
    gap: 12,
  },
  dmCallTopRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dmCallTextCol: { flex: 1, gap: 2 },
  dmCallTitle: { fontSize: 18, color: PIECES.sheet, fontWeight: '600' },
  dmCallSub: { fontSize: 14, color: '#d0d0d0' },
  dmCallControlsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1, minHeight: 0 },
  messagesList: { padding: 12, paddingBottom: 8, flexGrow: 1 },
  sep: { height: 10 },
  loadEarlierWrap: { alignItems: 'center', paddingBottom: 12 },
  roomIntroCard: {
    backgroundColor: PIECES.sheet,
    borderRadius: 24,
    padding: 16,
    gap: 4,
    marginBottom: 12,
  },
  roomIntroTitle: { fontSize: 20, color: PIECES.ink, fontWeight: '600' },
  roomIntroSub: { fontSize: 14, lineHeight: 20, color: PIECES.muted },
  emptyRoomText: { fontSize: 15, lineHeight: 21, color: PIECES.muted, textAlign: 'center', padding: 16 },
  typingStrip: { paddingHorizontal: 20, paddingVertical: 4 },
  typingText: { fontSize: 14, color: PIECES.muted },
  noticeBar: {
    marginHorizontal: 12,
    marginBottom: 6,
    paddingLeft: 18,
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
    marginHorizontal: 12,
    marginBottom: 6,
    paddingLeft: 18,
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
    marginHorizontal: 8,
    marginBottom: 6,
    padding: 10,
    gap: 8,
    borderRadius: 28,
    backgroundColor: PIECES.sheet,
  },
  slashStrip: { gap: 8, paddingHorizontal: 2 },
  slashChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 18,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slashChipText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  composerInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  micBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: PIECES.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerInput: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: PIECES.bg,
    fontSize: 16,
    color: PIECES.ink,
  },
  recordingBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  recordLiveInfo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  podSwitchSub: { fontSize: 14, color: PIECES.ink2, marginTop: 1 },
});
